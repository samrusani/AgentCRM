import { afterEach, expect, it, vi } from 'vitest';
import { newWorkerLeaseIdentity, prepareSendIntents, settleWorkerLease, tickFollowupRules } from '../src/actions/index.js';
import { holdRestoredMail } from '../src/actions/restoreMail.js';
import { reconcileIntent, submitNextIntent } from '../src/actions/sendIntents.js';
import { backupDatabase, restoreDatabase } from '../src/backup.js';
import { workerTickMilliseconds } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { processMailJobs, startWorker } from '../src/jobs/worker.js';
import { requireFollowupRule } from '../src/queries/followupRules.js';
import { stubInboxId } from './agentmailStub.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';
import { addDraft, addPerson, approve, connectMail, intentOf, queueOne, stage, statusOf } from './mailHelpers.js';

const realAddress = 'maren@lanternrow.invalid';
const accepted = () => Response.json({ message_id: 'message-fixture' });
const sends = vi.fn<() => Promise<Response>>();
let environment: TestEnvironment | undefined;

async function fixture(): Promise<TestEnvironment> {
  environment = createTestEnvironment();
  sends.mockReset().mockImplementation(async () => accepted());
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/messages/send')) return sends();
    if (url.pathname.endsWith('/inboxes')) return Response.json({ inboxes: [{ inbox_id: stubInboxId, email: stubInboxId }] });
    throw new Error(`Unexpected mail request: ${url.pathname}`);
  });
  await connectMail(environment);
  return environment;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  environment?.cleanup();
});

it('holds restored mail even when the provider accepted it after the snapshot', async () => {
  const env = await fixture();
  const person = addPerson(env, 'Maren', realAddress);
  const draft = addDraft(env, person.id, 'Snapshot message', 'Here is the requested update.');
  const staged = prepareSendIntents(env.ctx, {
    draftActivityIds: [draft],
    followups: { steps: [{ waitDays: 1, body: 'Following up on that update.' }] },
  });
  const id = staged.intents[0]!.id;
  approve(env, staged.approval!.id);
  const other = addPerson(env, 'Ellis', 'ellis@lanternrow.invalid');
  const pending = stage(env, [addDraft(env, other.id, 'Another pending review', 'Another message.')]);
  expect(pending.approval).not.toBeNull();
  expect(statusOf(env, id)).toBe('queued');
  const rule = env.db.prepare('SELECT id FROM followup_rule WHERE workspace_id = ? AND intent_id = ?')
    .get(env.workspaceId, id) as { id: string };
  const snapshot = await backupDatabase({ databasePath: env.databasePath });
  expect(await submitNextIntent(env.ctx)).toBe(true);
  expect(statusOf(env, id)).toBe('accepted');
  expect(sends).toHaveBeenCalledOnce();
  env.db.close();

  await restoreDatabase({ snapshot: snapshot.path, databasePath: env.databasePath });
  const db = openDatabase(env.databasePath);
  try {
    holdRestoredMail(db, env.databasePath);
    const ctx = { ...env.ctx, db };
    const restored = { ...env, db, ctx };
    expect(intentOf(restored, id)).toMatchObject({ status: 'unknown', error: expect.stringContaining('Held after a backup restore') });
    expect(requireFollowupRule(db, env.workspaceId, rule.id)).toMatchObject({ status: 'stopped', stoppedReason: 'backup_restored' });
    expect(() => approve(restored, pending.approval!.id)).toThrow(/held after a backup restore/);
    env.advance(2 * 86_400_000);
    tickFollowupRules(ctx);
    await processMailJobs(ctx);
    await reconcileIntent(ctx, { intentId: id, attempt: 0 });
    expect(sends).toHaveBeenCalledOnce();

    // Reopening and reapplying startup logic leaves newly approved work queued.
    const fresh = queueOne(restored, 'Tess', 'tess@lanternrow.invalid');
    holdRestoredMail(db, env.databasePath);
    expect(statusOf(restored, fresh)).toBe('queued');
  } finally {
    db.close();
  }
});

it('leaves a live worker’s in-flight send alone on a second startup', async () => {
  const env = await fixture();
  const intentId = queueOne(env, 'Maren', realAddress);
  settleWorkerLease(env.ctx, newWorkerLeaseIdentity('server'));
  let accept!: () => void;
  sends.mockImplementationOnce(() => new Promise((resolve) => {
    accept = () => resolve(accepted());
  }));
  const sending = submitNextIntent(env.ctx);
  expect(statusOf(env, intentId)).toBe('submitting');

  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const errors: unknown[] = [];
  const second = startWorker(env.ctx, (error) => errors.push(error));
  try {
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds);
    expect(statusOf(env, intentId)).toBe('submitting');
    accept();
    expect(await sending).toBe(true);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(sends).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
  } finally {
    await second.stop();
  }
});
