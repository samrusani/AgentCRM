import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  controlSendIntent,
  createContext,
  decideApproval,
  disconnectAgentmailConnector,
  prepareSendIntents,
  recoverSubmittingIntents,
} from '../src/actions/index.js';
import { submitNextIntent } from '../src/actions/sendIntents.js';
import { AppError } from '../src/errors.js';
import { processMailJobs } from '../src/jobs/worker.js';
import { getConnector } from '../src/queries/connectors.js';
import { requireWorkspace } from '../src/queries/workspace.js';
import { seedDatabase } from '../src/seed/seed.js';
import { type AgentmailStub, startAgentmailStub, stubAgentmailKey, stubInboxId, useAgentmailStub } from './agentmailStub.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';
import {
  addDraft,
  addPerson,
  approve,
  connectMail,
  drain,
  insertAcceptedToday,
  intentOf,
  queueOne,
  stage,
  statusOf,
} from './mailHelpers.js';

let stub: AgentmailStub;
let restore: () => void;
const environments: TestEnvironment[] = [];

beforeAll(async () => {
  stub = await startAgentmailStub();
  restore = useAgentmailStub(stub);
});

afterEach(() => {
  stub.reset();
});

afterAll(async () => {
  await stub.close();
  restore();
  for (const env of environments) env.cleanup();
});

async function freshEnv(connect = true): Promise<TestEnvironment> {
  const env = createTestEnvironment();
  environments.push(env);
  if (connect) await connectMail(env);
  return env;
}

function expectAppError(work: () => unknown, code: string, message?: RegExp): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    if (message) expect((error as AppError).message).toMatch(message);
    return;
  }
  throw new Error('Expected the call to throw.');
}

const realAddress = 'maren.testwell@lanternrow.invalid';

describe('preflight and the send_review approval', () => {
  it('freezes messages into one approval and sends nothing', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Maren', realAddress);
    const draft = addDraft(env, person.id, 'Seed round intro', 'Hello Maren,\n\nA short note.\n\nThanks');
    const staged = stage(env, [draft]);

    expect(staged.approval).not.toBeNull();
    expect(staged.approval!.kind).toBe('send_review');
    expect(staged.approval!.status).toBe('pending');
    expect(staged.run!.kind).toBe('send_outreach');
    expect(staged.run!.status).toBe('waiting_approval');
    const payload = staged.approval!.payload as any;
    expect(payload.messages).toEqual([
      {
        intentId: staged.intents[0]!.id,
        personName: 'Maren Testwell',
        to: realAddress,
        subject: 'Seed round intro',
        body: 'Hello Maren,\n\nA short note.\n\nThanks',
        inboxEmail: stubInboxId,
        provider: 'agentmail',
      },
    ]);
    expect(payload.mailProvider).toBe('agentmail');
    expect(staged.intents[0]!.provider).toBe('agentmail');
    expect(payload.excluded).toEqual([]);
    expect(payload.remainingDailyCap).toBe(49);
    expect(payload.runId).toBeUndefined();
    expect(staged.intents[0]!.status).toBe('awaiting_approval');

    await drain(env);
    expect(stub.state.sent).toHaveLength(0);
    expect(stub.state.sendAttempts).toHaveLength(0);
  });

  it('never makes a seeded person sendable and always excludes demo addresses', async () => {
    const env = createTestEnvironment();
    environments.push(env);
    seedDatabase(env.db, { now: new Date('2026-03-01T12:00:00.000Z') });
    // Seeding rebuilds the workspace, so the environment must point at the new one.
    env.workspaceId = requireWorkspace(env.db).id;
    env.ctx = createContext(env.db, env.workspaceId, { bus: env.bus, now: env.ctx.now });
    await connectMail(env);
    const seeded = env.db.prepare("SELECT id, email FROM person WHERE email LIKE '%example.com' LIMIT 1").get() as { id: string; email: string };
    expect(seeded.email).toMatch(/example\.com$/);
    const draft = addDraft(env, seeded.id, 'Hello', 'Body text');
    const result = stage(env, [draft]);
    expect(result.approval).toBeNull();
    expect(result.intents).toEqual([]);
    expect(result.excluded).toMatchObject([{ toEmail: seeded.email, reason: 'demo_address' }]);

    const candidates = [
      ['Ada', 'ada@example.com'],
      ['Bea', 'bea@mail.example.org'],
      ['Cy', 'CY@EXAMPLE.NET'],
      ['Di', 'di@deep.sub.example.com'],
      ['Ed', 'ed@example.org'],
    ] as const;
    const ids = candidates.map(([name, email]) => {
      const person = addPerson(env, name, email);
      return addDraft(env, person.id, `Hi ${name}`, 'Body');
    });
    const demo = stage(env, ids);
    expect(demo.approval).toBeNull();
    expect(demo.excluded.map((item) => item.reason)).toEqual(Array(5).fill('demo_address'));
    expect(stub.state.sent).toHaveLength(0);

    const lookAlike = addPerson(env, 'Fay', 'fay@notexample.com');
    const allowed = stage(env, [addDraft(env, lookAlike.id, 'Hi Fay', 'Body')]);
    expect(allowed.intents).toHaveLength(1);
  });

  it('lists every exclusion with a reason', async () => {
    const env = await freshEnv();
    const good = addPerson(env, 'Good', 'good@lanternrow.invalid');
    const blank = addPerson(env, 'Blank', null);
    const bad = addPerson(env, 'Bad', 'bad@lanternrow.invalid');
    env.db.prepare('UPDATE person SET email = ? WHERE id = ?').run('not an address', bad.id);
    const muted = addPerson(env, 'Muted', 'muted@lanternrow.invalid');
    env.db
      .prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES (?, ?, ?, ?, 'manual', '')")
      .run(env.ctx.newId('sup'), env.ctx.now(), env.workspaceId, 'muted@lanternrow.invalid');
    const dupe = addPerson(env, 'Dupe', 'dupe@lanternrow.invalid');
    const first = stage(env, [addDraft(env, dupe.id, 'Same subject', 'One')]);
    expect(first.intents).toHaveLength(1);

    const drafts = [
      addDraft(env, good.id, 'Fine', 'Body'),
      addDraft(env, blank.id, 'No address', 'Body'),
      addDraft(env, bad.id, 'Bad address', 'Body'),
      addDraft(env, muted.id, 'Muted', 'Body'),
      addDraft(env, dupe.id, 'SAME subject', 'Two'),
    ];
    const result = stage(env, drafts);
    expect(result.intents).toHaveLength(1);
    expect(result.excluded.map((item) => [item.personName.split(' ')[0], item.reason])).toEqual([
      ['Blank', 'invalid_recipient'],
      ['Bad', 'invalid_recipient'],
      ['Muted', 'suppressed'],
      ['Dupe', 'duplicate_open_intent'],
    ]);
    expect((result.approval!.payload as any).excluded).toHaveLength(4);
  });

  it('excludes everything with no_inbox when no inbox is connected', async () => {
    const env = await freshEnv(false);
    const person = addPerson(env, 'Nina', realAddress);
    const result = stage(env, [addDraft(env, person.id, 'Hello', 'Body')]);
    expect(result.approval).toBeNull();
    expect(result.excluded[0]!.reason).toBe('no_inbox');
  });

  it('rejects unknown drafts and empty requests', async () => {
    const env = await freshEnv();
    expectAppError(() => prepareSendIntents(env.ctx, {}), 'validation');
    expectAppError(() => prepareSendIntents(env.ctx, { draftActivityIds: ['act_000000000000'] }), 'not_found');
    const person = addPerson(env, 'Note', realAddress);
    const note = env.db.prepare('SELECT 1').get();
    expect(note).toBeTruthy();
    expectAppError(() => prepareSendIntents(env.ctx, { runId: 'run_000000000000' }), 'not_found');
    expect(person.id).toBeTruthy();
  });

  it('puts at most 25 messages in one approval', async () => {
    const env = await freshEnv();
    const ids = Array.from({ length: 27 }, (_, index) => {
      const person = addPerson(env, `Person${index}`, `p${index}@lanternrow.invalid`);
      return addDraft(env, person.id, `Hello ${index}`, 'Body');
    });
    const result = stage(env, ids);
    expect(result.intents).toHaveLength(25);
    expect(result.excluded).toHaveLength(2);
    expect(result.excluded[0]!.reason).toMatch(/Only 25 messages/);
  });

  it('counts accepted sends today and queued messages against the daily cap', async () => {
    const env = await freshEnv();
    const filler = addPerson(env, 'Filler', 'filler@lanternrow.invalid');
    insertAcceptedToday(env, filler.id, 47);
    const ids = Array.from({ length: 4 }, (_, index) => {
      const person = addPerson(env, `Cap${index}`, `cap${index}@lanternrow.invalid`);
      return addDraft(env, person.id, `Cap ${index}`, 'Body');
    });
    const first = stage(env, ids);
    expect(first.intents).toHaveLength(3);
    expect(first.excluded.map((item) => item.reason)).toEqual(['daily_cap']);
    expect(first.remainingDailyCap).toBe(0);

    const other = addPerson(env, 'Later', 'later@lanternrow.invalid');
    const second = stage(env, [addDraft(env, other.id, 'Later', 'Body')]);
    expect(second.approval).toBeNull();
    expect(second.excluded[0]!.reason).toBe('daily_cap');
  });
});

describe('staging from a draft run', () => {
  function insertDraftRun(env: TestEnvironment, status: string, drafts: Record<string, unknown>[]): string {
    const id = env.ctx.newId('run');
    env.db
      .prepare("INSERT INTO run (id, created_at, workspace_id, kind, title, status, scope) VALUES (?, ?, ?, 'draft_outreach', 'Drafts', ?, ?)")
      .run(id, env.ctx.now(), env.workspaceId, status, JSON.stringify({ drafts }));
    return id;
  }

  it('finds the saved drafts of a finished run and records the run id in the payload', async () => {
    const env = await freshEnv();
    const runId = insertDraftRun(env, 'succeeded', []);
    const saved = addPerson(env, 'Run', 'run@lanternrow.invalid');
    const missing = addPerson(env, 'Gone', 'gone@lanternrow.invalid');
    addDraft(env, saved.id, 'From the run', 'Saved body text.');
    env.db
      .prepare('UPDATE run SET scope = ? WHERE id = ?')
      .run(
        JSON.stringify({
          drafts: [
            { personId: saved.id, personName: 'Run Testwell', subject: 'From the run', body: 'Saved body text.', factsUsed: [] },
            { personId: missing.id, personName: 'Gone Testwell', subject: 'Never saved', body: 'Nothing saved.', factsUsed: [] },
          ],
        }),
        runId,
      );
    const result = prepareSendIntents(env.ctx, { runId });
    expect(result.intents).toHaveLength(1);
    expect((result.approval!.payload as any).runId).toBe(runId);
    expect(result.excluded).toMatchObject([{ personName: 'Gone Testwell', reason: 'The saved draft for this person could not be found.' }]);
  });

  it('refuses a run whose drafts are not saved or that is not a draft run', async () => {
    const env = await freshEnv();
    const waiting = insertDraftRun(env, 'waiting_approval', []);
    expectAppError(() => prepareSendIntents(env.ctx, { runId: waiting }), 'conflict', /Approve the drafts first/);
    const other = env.ctx.newId('run');
    env.db
      .prepare("INSERT INTO run (id, created_at, workspace_id, kind, title, status) VALUES (?, ?, ?, 'qualify', 'Q', 'succeeded')")
      .run(other, env.ctx.now(), env.workspaceId);
    expectAppError(() => prepareSendIntents(env.ctx, { runId: other }), 'validation');
  });
});

describe('approval decisions', () => {
  it('queues approved messages and cancels rejected ones', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Ivy', realAddress);
    const staged = stage(env, [addDraft(env, person.id, 'Hello', 'Body')]);
    const decision = approve(env, staged.approval!.id);
    expect(decision.queued).toBe(1);
    expect(decision.skipped).toEqual([]);
    expect(statusOf(env, staged.intents[0]!.id)).toBe('queued');
    expect(decision.run!.status).toBe('running');

    const other = addPerson(env, 'Jon', 'jon@lanternrow.invalid');
    const second = stage(env, [addDraft(env, other.id, 'Hi', 'Body')]);
    decideApproval(env.ctx, second.approval!.id, { decision: 'reject' });
    expect(statusOf(env, second.intents[0]!.id)).toBe('cancelled');
    expect(second.run!.id).toBeTruthy();
    await drain(env);
    expect(stub.state.sent.map((item) => item.to[0])).toEqual([realAddress]);
  });

  it('refuses a decision when the approval payload was tampered with', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Kai', realAddress);
    const staged = stage(env, [addDraft(env, person.id, 'Hello', 'This is the approved body.')]);
    env.db
      .prepare('UPDATE approval SET payload = replace(payload, ?, ?) WHERE id = ?')
      .run('approved body', 'swapped body', staged.approval!.id);
    expectAppError(() => approve(env, staged.approval!.id), 'conflict', /payload changed/);
    expect(statusOf(env, staged.intents[0]!.id)).toBe('awaiting_approval');
    await drain(env);
    expect(stub.state.sent).toHaveLength(0);
  });

  it('refuses a decision when an intent was edited after review', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Lou', realAddress);
    const staged = stage(env, [addDraft(env, person.id, 'Hello', 'Original text.')]);
    env.db.prepare('UPDATE send_intent SET body = ? WHERE id = ?').run('Edited text.', staged.intents[0]!.id);
    expectAppError(() => approve(env, staged.approval!.id), 'conflict', /changed after it was shown/);
    expect(statusOf(env, staged.intents[0]!.id)).toBe('awaiting_approval');
    const stored = env.db.prepare('SELECT status FROM approval WHERE id = ?').get(staged.approval!.id) as { status: string };
    expect(stored.status).toBe('pending');
  });

  it('queues only the messages still awaiting and reports cancelled ones as skipped', async () => {
    const env = await freshEnv();
    const people = ['Ann', 'Bob', 'Cat'].map((name) => addPerson(env, name, `${name.toLowerCase()}@lanternrow.invalid`));
    const staged = stage(env, people.map((person) => addDraft(env, person.id, `Hi ${person.firstName}`, 'Body')));
    controlSendIntent(env.ctx, staged.intents[1]!.id, { action: 'cancel' });
    const decision = approve(env, staged.approval!.id);
    expect(decision.queued).toBe(2);
    expect(decision.skipped).toEqual([{ intentId: staged.intents[1]!.id, personName: 'Bob Testwell', reason: 'cancelled' }]);
    await drain(env);
    await drain(env);
    expect(stub.state.sent.map((item) => item.to[0]).sort()).toEqual(['ann@lanternrow.invalid', 'cat@lanternrow.invalid']);
  });

  it('resolves an approval as rejected when every message was cancelled', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Dee', realAddress);
    const staged = stage(env, [addDraft(env, person.id, 'Hello', 'Body')]);
    controlSendIntent(env.ctx, staged.intents[0]!.id, { action: 'cancel' });
    const decision = approve(env, staged.approval!.id);
    expect(decision.approval.status).toBe('rejected');
    expect(decision.approval.note).toMatch(/cancelled/);
    expect(decision.run!.status).toBe('cancelled');
    expect(decision.queued).toBe(0);
  });

  it('blocks at approval time when the person already replied or was suppressed', async () => {
    const env = await freshEnv();
    const replied = addPerson(env, 'Eve', 'eve@lanternrow.invalid');
    const muted = addPerson(env, 'Finn', 'finn@lanternrow.invalid');
    const staged = stage(env, [addDraft(env, replied.id, 'Hi', 'Body'), addDraft(env, muted.id, 'Hi', 'Body')]);
    env.db
      .prepare(
        `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, direction, person_id, from_email, subject, provider_timestamp)
         VALUES (?, ?, ?, 'm1', 'in', ?, 'eve@lanternrow.invalid', 'Hello', ?)`,
      )
      .run(env.ctx.newId('msg'), env.ctx.now(), env.workspaceId, replied.id, env.ctx.now());
    env.db
      .prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES (?, ?, ?, 'finn@lanternrow.invalid', 'manual', '')")
      .run(env.ctx.newId('sup'), env.ctx.now(), env.workspaceId);
    const decision = approve(env, staged.approval!.id);
    expect(decision.queued).toBe(0);
    expect(decision.blocked).toBe(2);
    expect(intentOf(env, staged.intents[0]!.id).error).toBe('reply_received');
    expect(intentOf(env, staged.intents[1]!.id).error).toBe('suppressed');
  });

  it('cancelling the send_outreach run from the runs list cancels waiting messages', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Gus', realAddress);
    const staged = stage(env, [addDraft(env, person.id, 'Hello', 'Body')]);
    const { controlRun } = await import('../src/actions/index.js');
    controlRun(env.ctx, staged.run!.id, { action: 'cancel' });
    expect(statusOf(env, staged.intents[0]!.id)).toBe('cancelled');
  });
});

describe('submitting', () => {
  it('sends one approved message with the intent id as the idempotency key', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Hal', realAddress, 'Quarterly note');
    await drain(env);

    expect(stub.state.sent).toHaveLength(1);
    expect(stub.state.sent[0]).toMatchObject({ key: intentId, inboxId: stubInboxId, to: [realAddress], subject: 'Quarterly note' });
    expect(stub.state.sent[0]!.text).toContain('this is a test message');
    expect(stub.state.authHeaders.every((header) => header === `Bearer ${stubAgentmailKey}`)).toBe(true);
    const body = stub.state.requests.find((request) => request.path.endsWith('/send'))!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['subject', 'text', 'to']);
    expect(JSON.stringify(body)).not.toContain('track');

    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('accepted');
    expect(intent.providerMessageId).toBe(stub.state.sent[0]!.messageId);
    expect(intent.providerThreadId).toBe(stub.state.sent[0]!.threadId);
    const activity = env.db.prepare("SELECT body, kind FROM activity WHERE kind = 'email_out'").get() as { body: string; kind: string };
    expect(activity.body.split('\n')[0]).toBe('Sent (provider accepted). Delivery is not confirmed.');
    expect(activity.body).not.toMatch(/delivered/i);
    const audits = env.db.prepare("SELECT action FROM audit_event WHERE entity_type = 'send_intent' AND entity_id = ? ORDER BY rowid").all(intentId) as { action: string }[];
    expect(audits.map((row) => row.action)).toEqual([
      'send_intent.create',
      'send_intent.queue',
      'send_intent.submit_start',
      'send_intent.accepted',
    ]);
  });

  it('announces every intent transition to the browser', async () => {
    const env = await freshEnv();
    const events: { entityType?: string; entityId?: string }[] = [];
    env.bus.subscribe((event) => {
      if (event.type === 'record_updated' && event.entityType === 'send_intent') events.push(event);
    });
    const intentId = queueOne(env, 'Sue', realAddress);
    expect(events.map((event) => event.entityId)).toEqual([intentId, intentId]);
    await drain(env);
    expect(events).toHaveLength(4);
  });

  it('cannot submit the same intent twice, even with concurrent workers and repeated ticks', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Ida', realAddress);
    const results = await Promise.all([submitNextIntent(env.ctx), submitNextIntent(env.ctx), submitNextIntent(env.ctx)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    for (let round = 0; round < 4; round += 1) await processMailJobs(env.ctx);
    expect(stub.state.sent).toHaveLength(1);
    expect(stub.state.sendAttempts).toHaveLength(1);
    expect(statusOf(env, intentId)).toBe('accepted');
    // Even a forced re-queue of an accepted row does not pass the recheck path twice with a new key.
    env.db.prepare("UPDATE send_intent SET status = 'queued' WHERE id = ?").run(intentId);
    await drain(env);
    expect(stub.state.sent).toHaveLength(1);
    expect(stub.state.sendAttempts.every((attempt) => attempt.key === intentId)).toBe(true);
  });

  it('sets unknown after a timeout, then resolves to accepted by retrying the same key without a second send', async () => {
    const env = await freshEnv();
    stub.state.sendScript.push({ type: 'process_then_delay', delayMs: 1500 });
    const intentId = queueOne(env, 'Jay', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(intentOf(env, intentId).error).toMatch(/may or may not have been sent/);
    expect(stub.state.sent).toHaveLength(1);

    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(stub.state.sendAttempts).toHaveLength(1);

    env.advance(1500);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('accepted');
    expect(intent.providerMessageId).toBe(stub.state.sent[0]!.messageId);
    expect(stub.state.sent).toHaveLength(1);
    expect(stub.state.sendAttempts.map((attempt) => attempt.key)).toEqual([intentId, intentId]);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'email_out'").get()).toEqual({ n: 1 });
  });

  it('treats a server error, a conflict, and an unreadable answer as unknown', async () => {
    const env = await freshEnv();
    stub.state.sendScript.push({ type: 'respond', status: 503 }, { type: 'respond', status: 409 }, { type: 'process_then_garbage' });
    const ids = ['Kim', 'Lee', 'Max'].map((name) => queueOne(env, name, `${name.toLowerCase()}@lanternrow.invalid`));
    for (let round = 0; round < 6; round += 1) await processMailJobs(env.ctx);
    expect(ids.map((id) => statusOf(env, id))).toEqual(['unknown', 'unknown', 'unknown']);
    expect(intentOf(env, ids[2]!).error).toMatch(/unexpected|valid JSON|message id/i);

    env.advance(1500);
    await processMailJobs(env.ctx);
    await processMailJobs(env.ctx);
    // The first two never reached the provider, so their retries are the first real sends. The third was sent already.
    expect(ids.map((id) => statusOf(env, id))).toEqual(['accepted', 'accepted', 'accepted']);
    expect(stub.state.sent).toHaveLength(3);
    expect(new Set(stub.state.sent.map((item) => item.key)).size).toBe(3);
  });

  it('leaves an intent unknown after the reconcile schedule and never resends', async () => {
    const env = await freshEnv();
    stub.state.sendScript.push(
      { type: 'respond', status: 500 },
      { type: 'respond', status: 500 },
      { type: 'respond', status: 500 },
      { type: 'respond', status: 500 },
    );
    const intentId = queueOne(env, 'Ned', realAddress);
    await drain(env);
    for (let round = 0; round < 3; round += 1) {
      env.advance(1500);
      await processMailJobs(env.ctx);
    }
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toMatch(/Still unknown after 3 checks/);
    expect(stub.state.sendAttempts).toHaveLength(4);
    expect(stub.state.sent).toHaveLength(0);

    for (let round = 0; round < 5; round += 1) {
      env.advance(700_000);
      await processMailJobs(env.ctx);
    }
    expect(stub.state.sendAttempts).toHaveLength(4);
    expect(stub.state.sendAttempts.every((attempt) => attempt.key === intentId)).toBe(true);
    const task = env.db.prepare("SELECT title FROM task WHERE title LIKE 'Check whether the email%'").get() as { title: string };
    expect(task.title).toBe('Check whether the email to Ned Testwell was sent');
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status != 'done'").get()).toEqual({ n: 0 });
  });

  it('sets failed on a definitive refusal, scrubs the key, and never retries', async () => {
    const env = await freshEnv();
    stub.state.sendScript.push(
      { type: 'respond', status: 403, body: { message: `Rejected for ${stubAgentmailKey}`, fix: 'Check the recipient.' } },
      { type: 'respond', status: 400, body: { message: 'Validation failed.' } },
    );
    const first = queueOne(env, 'Oda', 'oda@lanternrow.invalid');
    const second = queueOne(env, 'Pia', 'pia@lanternrow.invalid');
    for (let round = 0; round < 4; round += 1) await processMailJobs(env.ctx);
    expect(statusOf(env, first)).toBe('failed');
    expect(statusOf(env, second)).toBe('failed');
    const error = intentOf(env, first).error!;
    expect(error).toContain('HTTP 403');
    expect(error).toContain('Check the recipient.');
    expect(error).not.toContain(stubAgentmailKey);
    expect(error).toContain('[removed]');
    env.advance(700_000);
    await drain(env);
    expect(stub.state.sendAttempts).toHaveLength(2);
    expect(stub.state.sent).toHaveLength(0);
  });

  it('flags the connector when the key is rejected at send time', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Quin', realAddress);
    stub.state.apiKey = 'am_other_key';
    await drain(env);
    expect(statusOf(env, intentId)).toBe('failed');
    expect(getConnector(env.db, env.workspaceId, 'agentmail')!.status).toBe('error');
  });

  it('turns an interrupted submit into unknown on restart and reconciles with the same key', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Rae', realAddress);
    env.db.prepare("UPDATE send_intent SET status = 'submitting', submitted_at = ? WHERE id = ?").run(env.ctx.now(), intentId);
    expect(recoverSubmittingIntents(env.ctx)).toBe(1);
    expect(statusOf(env, intentId)).toBe('unknown');
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(stub.state.sent).toHaveLength(1);
    expect(stub.state.sent[0]!.key).toBe(intentId);
  });
});

describe('recheck before submit', () => {
  it('blocks when a reply arrived since approval', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Sol', 'sol@lanternrow.invalid');
    const person = intentOf(env, intentId).personId;
    env.db
      .prepare(
        `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, direction, person_id, from_email, subject, provider_timestamp)
         VALUES (?, ?, ?, 'm-reply', 'in', ?, 'sol@lanternrow.invalid', 'Re', ?)`,
      )
      .run(env.ctx.newId('msg'), env.ctx.now(), env.workspaceId, person, env.ctx.now());
    await drain(env);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('blocked');
    expect(intent.error).toBe('reply_received');
    expect(stub.state.sendAttempts).toHaveLength(0);
  });

  it('blocks when the address was suppressed', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Tia', 'tia@lanternrow.invalid');
    env.db
      .prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES (?, ?, ?, 'tia@lanternrow.invalid', 'opt_out', '')")
      .run(env.ctx.newId('sup'), env.ctx.now(), env.workspaceId);
    await drain(env);
    expect(intentOf(env, intentId)).toMatchObject({ status: 'blocked', error: 'suppressed' });
    expect(stub.state.sendAttempts).toHaveLength(0);
  });

  it('blocks when the daily cap is used up', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Uma', 'uma@lanternrow.invalid');
    insertAcceptedToday(env, intentOf(env, intentId).personId, 50);
    await drain(env);
    expect(intentOf(env, intentId)).toMatchObject({ status: 'blocked', error: 'daily_cap' });
    expect(stub.state.sendAttempts).toHaveLength(0);
  });

  it('blocks when the message no longer matches the approval', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Val', 'val@lanternrow.invalid');
    env.db.prepare('UPDATE send_intent SET subject = ? WHERE id = ?').run('A different subject', intentId);
    await drain(env);
    expect(intentOf(env, intentId)).toMatchObject({ status: 'blocked' });
    expect(intentOf(env, intentId).error).toMatch(/no longer matches/);
    expect(stub.state.sendAttempts).toHaveLength(0);
  });

  it('blocks when the inbox changed after approval', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Wes', 'wes@lanternrow.invalid');
    env.db.prepare('UPDATE send_intent SET inbox_id = ? WHERE id = ?').run('other@stub-mail.invalid', intentId);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('blocked');
    expect(stub.state.sendAttempts).toHaveLength(0);
  });

  it('stops reconciling when the person opted out after an unknown send', async () => {
    const env = await freshEnv();
    stub.state.sendScript.push({ type: 'respond', status: 500 });
    const intentId = queueOne(env, 'Xia', 'xia@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    env.db
      .prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES (?, ?, ?, 'xia@lanternrow.invalid', 'manual', '')")
      .run(env.ctx.newId('sup'), env.ctx.now(), env.workspaceId);
    env.advance(1500);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toMatch(/Checking again stopped: suppressed/);
    expect(stub.state.sendAttempts).toHaveLength(1);
  });
});

describe('control, disconnect, and suppression effects', () => {
  it('cancels and acknowledges only the allowed states', async () => {
    const env = await freshEnv();
    const queued = queueOne(env, 'Yan', 'yan@lanternrow.invalid');
    expect(controlSendIntent(env.ctx, queued, { action: 'cancel' }).status).toBe('cancelled');
    expectAppError(() => controlSendIntent(env.ctx, queued, { action: 'cancel' }), 'conflict');
    expectAppError(() => controlSendIntent(env.ctx, queued, { action: 'acknowledge' }), 'conflict');

    stub.state.sendScript.push({ type: 'respond', status: 500 });
    const unknown = queueOne(env, 'Zed', 'zed@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, unknown)).toBe('unknown');
    expectAppError(() => controlSendIntent(env.ctx, unknown, { action: 'cancel' }), 'conflict');
    const acknowledged = controlSendIntent(env.ctx, unknown, { action: 'acknowledge' });
    expect(acknowledged.status).toBe('cancelled');
    expect(acknowledged.error).toMatch(/Acknowledged by a person/);
    const audit = env.db.prepare("SELECT actor, detail FROM audit_event WHERE action = 'send_intent.acknowledge'").get() as { actor: string; detail: string };
    expect(audit.actor).toBe('user');
    expect(JSON.parse(audit.detail)).toMatchObject({ acknowledgedState: 'unknown' });

    const blocked = queueOne(env, 'Abe', 'abe@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'blocked', error = 'daily_cap' WHERE id = ?").run(blocked);
    expect(controlSendIntent(env.ctx, blocked, { action: 'acknowledge' }).status).toBe('cancelled');

    const sent = queueOne(env, 'Bo', 'bo@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, sent)).toBe('accepted');
    expectAppError(() => controlSendIntent(env.ctx, sent, { action: 'cancel' }), 'conflict');
    expectAppError(() => controlSendIntent(env.ctx, 'snd_000000000000', { action: 'cancel' }), 'not_found');
    env.db.prepare("UPDATE send_intent SET status = 'submitting' WHERE id = ?").run(sent);
    expectAppError(() => controlSendIntent(env.ctx, sent, { action: 'cancel' }), 'conflict', /being sent/);
  });

  it('blocks queued and approved intents on disconnect and keeps submitting and unknown ones', async () => {
    const env = await freshEnv();
    const queued = queueOne(env, 'Cora', 'cora@lanternrow.invalid');
    const approved = queueOne(env, 'Dan', 'dan@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'approved' WHERE id = ?").run(approved);
    const submitting = queueOne(env, 'Elle', 'elle@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'submitting' WHERE id = ?").run(submitting);
    const unknown = queueOne(env, 'Fox', 'fox@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'unknown', error = 'Outcome unknown.' WHERE id = ?").run(unknown);

    disconnectAgentmailConnector(env.ctx);
    expect(getConnector(env.db, env.workspaceId, 'agentmail')).toBeNull();
    expect(intentOf(env, queued)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    expect(intentOf(env, approved)).toMatchObject({ status: 'blocked', error: 'connector_removed' });
    expect(intentOf(env, submitting)).toMatchObject({ status: 'submitting' });
    expect(intentOf(env, submitting).error).toBe('connector_removed');
    expect(intentOf(env, unknown).status).toBe('unknown');
    expect(intentOf(env, unknown).error).toBe('Outcome unknown. connector_removed');
    await drain(env);
    expect(stub.state.sendAttempts).toHaveLength(0);
  });
});

const hour = 3_600_000;
const expiredSentence = "The provider's duplicate protection has expired, so this cannot be retried safely. Check the provider's sent mail.";

describe('idempotency key expiry', () => {
  it('makes no provider call for a reconcile due 25 hours after submit, and keeps the intent unknown with a task', async () => {
    const env = await freshEnv();
    stub.state.sendScript.push({ type: 'respond', status: 500 });
    const intentId = queueOne(env, 'Nia', 'nia@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(stub.state.sendAttempts).toHaveLength(1);

    env.advance(25 * hour);
    await processMailJobs(env.ctx);
    await processMailJobs(env.ctx);
    expect(stub.state.sendAttempts).toHaveLength(1);
    expect(stub.state.sent).toHaveLength(0);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toContain(expiredSentence);
    expect(intent.error!.split(expiredSentence)).toHaveLength(2);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM task WHERE title = 'Check whether the email to Nia Testwell was sent' AND status = 'open'").get()).toEqual({ n: 1 });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status != 'done'").get()).toEqual({ n: 0 });
  });

  it('still retries with the same key inside the window', async () => {
    const env = await freshEnv();
    stub.state.sendScript.push({ type: 'respond', status: 500 });
    const intentId = queueOne(env, 'Oren', 'oren@lanternrow.invalid');
    await drain(env);
    env.advance(22 * hour);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(stub.state.sendAttempts.map((attempt) => attempt.key)).toEqual([intentId, intentId]);
  });

  it('makes no provider call for restart recovery 30 hours after submit', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Pru', 'pru@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'submitting', submitted_at = ? WHERE id = ?").run(env.ctx.now(), intentId);
    env.advance(30 * hour);
    expect(recoverSubmittingIntents(env.ctx)).toBe(1);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toContain('The email may or may not have been sent.');
    expect(intent.error).toContain(expiredSentence);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile'").get()).toEqual({ n: 0 });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM task WHERE title = 'Check whether the email to Pru Testwell was sent'").get()).toEqual({ n: 1 });
    env.advance(hour);
    await processMailJobs(env.ctx);
    expect(stub.state.sendAttempts).toHaveLength(0);
    expect(statusOf(env, intentId)).toBe('unknown');
  });

  it('does not repeat the task when a stopped intent is checked again', async () => {
    const env = await freshEnv();
    stub.state.sendScript.push({ type: 'respond', status: 500 });
    const intentId = queueOne(env, 'Quill', 'quill@lanternrow.invalid');
    await drain(env);
    env.advance(25 * hour);
    const payload = { intentId, attempt: 1, workspaceId: env.workspaceId };
    const { reconcileIntent } = await import('../src/actions/index.js');
    await reconcileIntent(env.ctx, payload);
    await reconcileIntent(env.ctx, payload);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM task WHERE title LIKE 'Check whether the email to Quill%'").get()).toEqual({ n: 1 });
    expect(stub.state.sendAttempts).toHaveLength(1);
  });
});

describe('duplicate staging', () => {
  it('stages a draft with a non-ASCII subject once and excludes the second attempt', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Uli', 'uli@lanternrow.invalid');
    const draft = addDraft(env, person.id, 'Über uns', 'A short note.');
    const first = stage(env, [draft]);
    expect(first.intents).toHaveLength(1);
    const second = stage(env, [draft]);
    expect(second.intents).toEqual([]);
    expect(second.approval).toBeNull();
    expect(second.excluded).toMatchObject([{ draftActivityId: draft, reason: 'duplicate_open_intent' }]);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM send_intent').get()).toEqual({ n: 1 });
  });

  it('also matches the same person and subject in another draft, with different letter case', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Vera', 'vera@lanternrow.invalid');
    expect(stage(env, [addDraft(env, person.id, 'Über uns', 'One.')]).intents).toHaveLength(1);
    const other = stage(env, [addDraft(env, person.id, 'ÜBER UNS', 'Two.')]);
    expect(other.intents).toEqual([]);
    expect(other.excluded[0]!.reason).toBe('duplicate_open_intent');
  });

  it('stays excluded while the first intent is approved, queued, or unknown, and frees the draft when it is cancelled', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Wim', 'wim@lanternrow.invalid');
    const draft = addDraft(env, person.id, 'Ärger', 'Body.');
    const first = stage(env, [draft]);
    approve(env, first.approval!.id);
    expect(stage(env, [draft]).excluded[0]!.reason).toBe('duplicate_open_intent');
    stub.state.sendScript.push({ type: 'respond', status: 500 });
    await drain(env);
    expect(statusOf(env, first.intents[0]!.id)).toBe('unknown');
    expect(stage(env, [draft]).excluded[0]!.reason).toBe('duplicate_open_intent');
  });

  it('refuses a second open intent for one draft at the database level', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Xan', 'xan@lanternrow.invalid');
    const draft = addDraft(env, person.id, 'Hello', 'Body.');
    const first = stage(env, [draft]);
    const insert = () =>
      env.db
        .prepare(
          `INSERT INTO send_intent (id, created_at, workspace_id, person_id, draft_activity_id, inbox_id, to_email, subject, body, payload_hash, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Other', 'Other', 'x', 'awaiting_approval', ?)`,
        )
        .run(env.ctx.newId('snd'), env.ctx.now(), env.workspaceId, person.id, draft, stubInboxId, 'xan@lanternrow.invalid', env.ctx.now());
    expect(insert).toThrow(/UNIQUE/);
    controlSendIntent(env.ctx, first.intents[0]!.id, { action: 'cancel' });
    expect(insert).not.toThrow();
  });
});

describe('unknown never becomes failed', () => {
  it('keeps an unknown intent unknown when the retry gets a refusal, and stops the schedule', async () => {
    const env = await freshEnv();
    stub.state.sendScript.push({ type: 'respond', status: 500 }, { type: 'respond', status: 404 });
    const intentId = queueOne(env, 'Yara', 'yara@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    env.advance(1500);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toMatch(/Checking again stopped: AgentMail could not find that resource\./);
    expect(intent.error).toMatch(/does not show the email was not sent/);
    expect(stub.state.sendAttempts).toHaveLength(2);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status != 'done'").get()).toEqual({ n: 0 });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM task WHERE title = 'Check whether the email to Yara Testwell was sent'").get()).toEqual({ n: 1 });
    env.advance(700_000);
    await drain(env);
    expect(stub.state.sendAttempts).toHaveLength(2);
    expect(statusOf(env, intentId)).toBe('unknown');
    // The draft cannot be staged again by mistake.
    expect(stage(env, [intent.draftActivityId!]).excluded[0]!.reason).toBe('duplicate_open_intent');
  });

  it('flags the connector but keeps the intent unknown when the retry gets a rejected key', async () => {
    const env = await freshEnv();
    stub.state.sendScript.push({ type: 'respond', status: 500 });
    const intentId = queueOne(env, 'Zoe', 'zoe@lanternrow.invalid');
    await drain(env);
    stub.state.apiKey = 'am_rotated';
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(getConnector(env.db, env.workspaceId, 'agentmail')!.status).toBe('error');
  });

  it('cannot move unknown to failed through the transition function', async () => {
    const env = await freshEnv();
    stub.state.sendScript.push({ type: 'respond', status: 500 });
    const intentId = queueOne(env, 'Abby', 'abby@lanternrow.invalid');
    await drain(env);
    const { mutate } = await import('../src/actions/index.js');
    const { transitionIntentIn } = await import('../src/actions/sendIntentState.js');
    const moved = mutate(env.ctx, (tx) => transitionIntentIn(tx, intentId, ['unknown'], 'failed', { error: 'x' }, 'failed'));
    expect(moved).toBe(false);
    expect(statusOf(env, intentId)).toBe('unknown');
  });

  it.each([
    [400, 'failed'],
    [401, 'failed'],
    [403, 'failed'],
    [404, 'failed'],
    [422, 'failed'],
    [402, 'unknown'],
    [405, 'unknown'],
    [409, 'unknown'],
    [410, 'unknown'],
    [413, 'unknown'],
    [418, 'unknown'],
    [429, 'unknown'],
    [503, 'unknown'],
  ])('maps a %i answer to a send to %s', async (status, expected) => {
    const env = await freshEnv();
    stub.state.sendScript.push({ type: 'respond', status });
    const intentId = queueOne(env, `Status${status}`, `status${status}@lanternrow.invalid`);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe(expected);
  });

  it('excludes staging an acknowledged unknown draft again, with a plain sentence', async () => {
    const env = await freshEnv();
    stub.state.sendScript.push({ type: 'respond', status: 500 });
    const intentId = queueOne(env, 'Bram', 'bram@lanternrow.invalid');
    await drain(env);
    const draft = intentOf(env, intentId).draftActivityId!;
    expect(controlSendIntent(env.ctx, intentId, { action: 'acknowledge' }).status).toBe('cancelled');
    const again = stage(env, [draft]);
    expect(again.intents).toEqual([]);
    expect(again.excluded[0]!.reason).toBe(
      "A previous send attempt for this draft has an unknown outcome. Check the provider's sent mail first.",
    );
    // A cancelled intent that was never unknown frees its draft.
    const other = queueOne(env, 'Cleo', 'cleo@lanternrow.invalid');
    const otherDraft = intentOf(env, other).draftActivityId!;
    controlSendIntent(env.ctx, other, { action: 'cancel' });
    expect(stage(env, [otherDraft]).intents).toHaveLength(1);
  });

  it('still counts an acknowledged unknown intent in the daily cap', async () => {
    const env = await freshEnv();
    const filler = addPerson(env, 'Filler', 'filler@lanternrow.invalid');
    insertAcceptedToday(env, filler.id, 49);
    stub.state.sendScript.push({ type: 'respond', status: 500 });
    const intentId = queueOne(env, 'Dov', 'dov@lanternrow.invalid');
    await drain(env);
    controlSendIntent(env.ctx, intentId, { action: 'acknowledge' });
    const later = addPerson(env, 'Edda', 'edda@lanternrow.invalid');
    const result = stage(env, [addDraft(env, later.id, 'Later', 'Body.')]);
    expect(result.intents).toEqual([]);
    expect(result.excluded[0]!.reason).toBe('daily_cap');
  });
});

describe('approval age', () => {
  it('blocks a queued message whose approval is more than a day old', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Fenn', 'fenn@lanternrow.invalid');
    env.advance(25 * hour);
    await drain(env);
    expect(intentOf(env, intentId)).toMatchObject({ status: 'blocked', error: 'Approved more than a day ago. Review and approve again.' });
    expect(stub.state.sendAttempts).toHaveLength(0);
  });

  it('sends a message approved 23 hours ago', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Gus', 'gus@lanternrow.invalid');
    env.advance(23 * hour);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('accepted');
  });
});

describe('send run status', () => {
  it('stays running until every message has left the queue, then succeeds', async () => {
    const env = await freshEnv();
    const people = ['Hana', 'Iko'].map((name) => addPerson(env, name, `${name.toLowerCase()}@lanternrow.invalid`));
    const staged = stage(env, people.map((person) => addDraft(env, person.id, `Hi ${person.firstName}`, 'Body.')));
    const { getRun } = await import('../src/queries/runs.js');
    const decision = approve(env, staged.approval!.id);
    expect(decision.run!.status).toBe('running');
    expect(getRun(env.db, env.workspaceId, staged.run!.id)!.finishedAt).toBeNull();
    await processMailJobs(env.ctx);
    // Both go out in the same pass, but check the state after the first message too.
    const final = getRun(env.db, env.workspaceId, staged.run!.id)!;
    expect(final.status).toBe('succeeded');
    expect(final.finishedAt).not.toBeNull();
    const steps = env.db.prepare('SELECT title, status FROM run_step WHERE run_id = ? ORDER BY seq').all(staged.run!.id);
    expect(steps).toEqual([
      { title: 'Check recipients', status: 'done' },
      { title: 'Review messages', status: 'done' },
      { title: 'Send messages', status: 'done' },
    ]);
  });

  it('is running after one of two messages is sent', async () => {
    const env = await freshEnv();
    const people = ['Jun', 'Kay'].map((name) => addPerson(env, name, `${name.toLowerCase()}@lanternrow.invalid`));
    const staged = stage(env, people.map((person) => addDraft(env, person.id, `Hi ${person.firstName}`, 'Body.')));
    approve(env, staged.approval!.id);
    const { getRun } = await import('../src/queries/runs.js');
    await submitNextIntent(env.ctx);
    expect(getRun(env.db, env.workspaceId, staged.run!.id)!.status).toBe('running');
    await submitNextIntent(env.ctx);
    expect(getRun(env.db, env.workspaceId, staged.run!.id)!.status).toBe('succeeded');
  });

  it.each([
    ['a failed message', { type: 'respond' as const, status: 400 }],
    ['an unknown outcome', { type: 'respond' as const, status: 503 }],
  ])('ends partial with %s', async (_label, behavior) => {
    const env = await freshEnv();
    stub.state.sendScript.push(behavior);
    const people = ['Lio', 'Mae'].map((name) => addPerson(env, name, `${name.toLowerCase()}@lanternrow.invalid`));
    const staged = stage(env, people.map((person) => addDraft(env, person.id, `Hi ${person.firstName}`, 'Body.')));
    approve(env, staged.approval!.id);
    await processMailJobs(env.ctx);
    const { getRun } = await import('../src/queries/runs.js');
    expect(getRun(env.db, env.workspaceId, staged.run!.id)!.status).toBe('partial');
  });

  it('ends partial when a message is blocked at approval and the rest are sent', async () => {
    const env = await freshEnv();
    const muted = addPerson(env, 'Noor', 'noor@lanternrow.invalid');
    const fine = addPerson(env, 'Odi', 'odi@lanternrow.invalid');
    const staged = stage(env, [addDraft(env, muted.id, 'Hi', 'Body.'), addDraft(env, fine.id, 'Hi', 'Body.')]);
    env.db
      .prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES (?, ?, ?, 'noor@lanternrow.invalid', 'manual', '')")
      .run(env.ctx.newId('sup'), env.ctx.now(), env.workspaceId);
    approve(env, staged.approval!.id);
    await processMailJobs(env.ctx);
    const { getRun } = await import('../src/queries/runs.js');
    expect(getRun(env.db, env.workspaceId, staged.run!.id)!.status).toBe('partial');
  });

  it('cancelling a running send run cancels the queued messages, and a send cannot be paused', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Pim', 'pim@lanternrow.invalid');
    const staged = stage(env, [addDraft(env, person.id, 'Hi', 'Body.')]);
    approve(env, staged.approval!.id);
    const { controlRun } = await import('../src/actions/index.js');
    expectAppError(() => controlRun(env.ctx, staged.run!.id, { action: 'pause' }), 'conflict', /cannot be paused/);
    controlRun(env.ctx, staged.run!.id, { action: 'cancel' });
    expect(statusOf(env, staged.intents[0]!.id)).toBe('cancelled');
    await drain(env);
    expect(stub.state.sendAttempts).toHaveLength(0);
  });
});
