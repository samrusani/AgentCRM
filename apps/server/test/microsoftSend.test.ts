import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  controlSendIntent,
  disconnectMicrosoftConnector,
  markMicrosoftError,
  reconcileIntent,
  recoverSubmittingIntents,
} from '../src/actions/index.js';
import { createMailAdapter } from '../src/actions/mailProviders.js';
import { createMicrosoftTokenStore } from '../src/actions/microsoftConnector.js';
import { mailReconcileDelays } from '../src/config.js';
import { processMailJobs } from '../src/jobs/worker.js';
import type { MailIntent } from '../src/providers/mailTypes.js';
import { createMicrosoftMailProvider } from '../src/providers/microsoft.js';
import { getConnector, getMicrosoftInternals } from '../src/queries/connectors.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';
import { addDraft, addPerson, approve, connectMicrosoft, drain, intentOf, queueOne, stage, statusOf } from './mailHelpers.js';
import { type MicrosoftStub, startMicrosoftStub, stubMicrosoftAddress, useMicrosoftStub } from './microsoftStub.js';

let ms: MicrosoftStub;
let restore: () => void;
const environments: TestEnvironment[] = [];

beforeAll(async () => {
  ms = await startMicrosoftStub();
  restore = useMicrosoftStub(ms);
});

afterEach(() => {
  ms.reset();
});

afterAll(async () => {
  await ms.close();
  restore();
  for (const env of environments) env.cleanup();
});

async function freshEnv(): Promise<TestEnvironment> {
  const env = createTestEnvironment();
  environments.push(env);
  await connectMicrosoft(env, ms);
  return env;
}

interface Saved {
  provider_draft_id: string | null;
  message_id_header: string | null;
}

function savedOf(env: TestEnvironment, intentId: string): Saved {
  return env.db.prepare('SELECT provider_draft_id, message_id_header FROM send_intent WHERE id = ?').get(intentId) as Saved;
}

function refreshes(): number {
  return ms.state.tokenRequests.filter((request) => request.grantType === 'refresh_token').length;
}

function taskCount(env: TestEnvironment, name: string): number {
  return (env.db.prepare('SELECT COUNT(*) AS n FROM task WHERE title LIKE ? AND status = ?').get(`Check whether the email to ${name}%`, 'open') as { n: number }).n;
}

function auditCount(env: TestEnvironment, action: string, intentId: string): number {
  return (env.db.prepare('SELECT COUNT(*) AS n FROM audit_event WHERE action = ? AND entity_id = ?').get(action, intentId) as { n: number }).n;
}

function expireAccessToken(env: TestEnvironment): void {
  const row = env.db.prepare("SELECT id, secret FROM connector WHERE kind = 'microsoft'").get() as { id: string; secret: string };
  env.db
    .prepare('UPDATE connector SET secret = ? WHERE id = ?')
    .run(JSON.stringify({ ...JSON.parse(row.secret), expiresAt: new Date(Date.parse(env.ctx.now()) - 1000).toISOString() }), row.id);
}

// A send whose answer was lost after Outlook took it: the intent is unknown and the draft is already sent.
async function unknownThatWasSent(env: TestEnvironment, name: string, email = 'unknown.person@lanternrow.invalid'): Promise<string> {
  ms.state.sendScript.push({ type: 'process_then_respond', status: 502 });
  const intentId = queueOne(env, name, email);
  await drain(env);
  expect(statusOf(env, intentId)).toBe('unknown');
  return intentId;
}

const realAddress = 'maren.testwell@lanternrow.invalid';
// A saved draft is sent again only after the last attempt is older than twice the request timeout plus 30 seconds. The
// tests run with a 400 millisecond timeout, so 30.8 seconds.
const pastTheWait = 31_000;
const sendPaths = () => ms.state.paths.filter((path) => path.startsWith('POST /v1.0') && path.endsWith('/send'));

describe('microsoft send lifecycle', () => {
  it('stages with the microsoft connector in use, creates a draft with the intent header, sends it, and records ids', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Maren', realAddress);
    const staged = stage(env, [addDraft(env, person.id, 'Seed round intro', 'Hello Maren,\n\nA short note.\n\nThanks')]);
    const payload = staged.approval!.payload as any;
    expect(payload.mailProvider).toBe('microsoft');
    expect(payload.inboxEmail).toBe(stubMicrosoftAddress);
    expect(payload.messages[0]).toMatchObject({ provider: 'microsoft', inboxEmail: stubMicrosoftAddress, to: realAddress });
    expect(staged.intents[0]).toMatchObject({ provider: 'microsoft', inboxId: stubMicrosoftAddress, status: 'awaiting_approval' });
    expect(savedOf(env, staged.intents[0]!.id)).toEqual({ provider_draft_id: null, message_id_header: null });

    await drain(env);
    expect(ms.state.createAttempts).toHaveLength(0);

    approve(env, staged.approval!.id);
    expect(statusOf(env, staged.intents[0]!.id)).toBe('queued');
    await drain(env);

    expect(ms.state.sent).toHaveLength(1);
    const sent = ms.state.sent[0]!;
    const intent = intentOf(env, staged.intents[0]!.id);
    expect(intent.status).toBe('accepted');
    expect(intent.providerMessageId).toBe(sent.internetMessageId);
    expect(intent.providerThreadId).toBe(sent.conversationId);
    expect(savedOf(env, intent.id)).toEqual({ provider_draft_id: sent.id, message_id_header: sent.internetMessageId });
    expect(sent.to).toBe(realAddress);
    expect(sent.subject).toBe('Seed round intro');
    expect(sent.text).toBe('Hello Maren,\n\nA short note.\n\nThanks');
    expect(sent.intentHeader).toBe(intent.id);

    // The create request: the content, the intent header, immutable ids, and no from, so the account sends as itself.
    const create = ms.state.requests.find((request) => request.method === 'POST' && request.path === '/v1.0/me/messages')!;
    expect(create.body).toEqual({
      subject: 'Seed round intro',
      body: { contentType: 'text', content: 'Hello Maren,\n\nA short note.\n\nThanks' },
      toRecipients: [{ emailAddress: { address: realAddress } }],
      internetMessageHeaders: [{ name: 'x-agentcrm-intent', value: intent.id }],
    });
    expect(String(create.headers.prefer)).toBe('IdType="ImmutableId"');
    const send = ms.state.requests.find((request) => request.path.endsWith('/send'))!;
    expect(send.path).toBe(`/v1.0/me/messages/${sent.id}/send`);
    expect(String(send.headers.prefer)).toBe('IdType="ImmutableId"');
    expect(ms.state.paths.filter((path) => path.startsWith('POST /v1.0'))).toEqual(['POST /v1.0/me/messages', `POST /v1.0/me/messages/${sent.id}/send`]);

    const activity = env.db.prepare("SELECT body FROM activity WHERE kind = 'email_out'").get() as { body: string };
    expect(activity.body.split('\n')[0]).toBe('Sent (provider accepted). Delivery is not confirmed.');
    const audits = env.db.prepare("SELECT action FROM audit_event WHERE entity_type = 'send_intent' AND entity_id = ? ORDER BY rowid").all(intent.id) as { action: string }[];
    expect(audits.map((row) => row.action)).toEqual(['send_intent.create', 'send_intent.queue', 'send_intent.submit_start', 'send_intent.draft_saved', 'send_intent.accepted']);
  });

  it('saves the draft id and the internet message id before the send request leaves the process', async () => {
    const env = await freshEnv();
    const seen: { status: string; saved: Saved | null; draftExists: boolean; id: string }[] = [];
    ms.state.onSend = ({ id }) => {
      const row = env.db.prepare("SELECT status, provider_draft_id, message_id_header FROM send_intent WHERE status = 'submitting'").get() as
        | { status: string; provider_draft_id: string | null; message_id_header: string | null }
        | undefined;
      seen.push({ status: row?.status ?? 'none', saved: row ? { provider_draft_id: row.provider_draft_id, message_id_header: row.message_id_header } : null, draftExists: Boolean(ms.state.messages[id]), id });
    };
    const intentId = queueOne(env, 'Hal', realAddress);
    await drain(env);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe('submitting');
    expect(seen[0]!.saved!.provider_draft_id).toBe(seen[0]!.id);
    expect(seen[0]!.saved!.message_id_header).toBe(ms.state.messages[seen[0]!.id]!.internetMessageId);
    expect(savedOf(env, intentId)).toEqual(seen[0]!.saved);
  });

  it('never sends the same intent twice, even with repeated ticks and a forced re-queue', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Ida', realAddress);
    await Promise.all([processMailJobs(env.ctx), processMailJobs(env.ctx), processMailJobs(env.ctx)]);
    for (let round = 0; round < 3; round += 1) await processMailJobs(env.ctx);
    expect(ms.state.sent).toHaveLength(1);
    env.db.prepare("UPDATE send_intent SET status = 'queued' WHERE id = ?").run(intentId);
    await drain(env);
    // The intent already has a provider message id, so the recheck blocks it instead of submitting again.
    expect(ms.state.sent).toHaveLength(1);
    expect(ms.state.sendAttempts).toHaveLength(1);
    expect(ms.state.createAttempts).toHaveLength(1);
  });

  it('adopts the draft it finds when a create answer was lost, and makes no second draft', async () => {
    const env = await freshEnv();
    ms.state.createScript.push({ type: 'process_then_respond', status: 502 });
    const intentId = queueOne(env, 'Jay', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(ms.state.createAttempts).toHaveLength(1);
    expect(Object.values(ms.state.messages)).toHaveLength(1);
    expect(ms.state.sent).toHaveLength(1);
    const scan = ms.state.requests.find((request) => request.method === 'GET' && request.path === '/v1.0/me/mailFolders/drafts/messages')!;
    expect(scan.query).toMatchObject({
      $top: '50',
      $select: 'id,internetMessageId,conversationId,internetMessageHeaders,toRecipients,ccRecipients,bccRecipients,subject,body',
    });
    expect(String(scan.headers.prefer)).toBe('IdType="ImmutableId"');
    expect(savedOf(env, intentId).provider_draft_id).toBe(ms.state.sent[0]!.id);
  });

  it('creates one more draft when the scan finds none, and still sends exactly one email', async () => {
    const env = await freshEnv();
    // The create fails before Outlook did anything, so the drafts folder holds nothing of ours.
    ms.state.createScript.push({ type: 'respond', status: 503 });
    const intentId = queueOne(env, 'Kay', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(ms.state.createAttempts).toHaveLength(2);
    expect(ms.state.sent).toHaveLength(1);
    expect(sendPaths()).toHaveLength(1);
    expect(ms.state.paths.filter((path) => path === 'GET /v1.0/me/mailFolders/drafts/messages')).toHaveLength(1);
  });

  it('ignores a stray draft of another intent while scanning, and allows only one re-create', async () => {
    const env = await freshEnv();
    ms.addStrayDraft({ intentId: 'snd_somebodyelse' });
    ms.state.createScript.push({ type: 'respond', status: 503 }, { type: 'respond', status: 503 });
    const intentId = queueOne(env, 'Lee', realAddress);
    await drain(env);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('failed');
    expect(intent.error).toContain('The message was not sent.');
    expect(intent.error).toContain('A draft may remain in Outlook drafts.');
    expect(ms.state.createAttempts).toHaveLength(2);
    expect(ms.state.sendAttempts).toHaveLength(0);
    expect(ms.state.sent).toHaveLength(0);
    expect(savedOf(env, intentId)).toEqual({ provider_draft_id: null, message_id_header: null });
  });

  it('fails a definitive create refusal with nothing sent, after one request and no scan', async () => {
    const env = await freshEnv();
    ms.state.createScript.push({ type: 'respond', status: 400, body: { error: { code: 'ErrorInvalidRecipients', message: 'Bad recipient.' } } });
    const intentId = queueOne(env, 'Max', realAddress);
    await drain(env);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('failed');
    expect(intent.error).toContain('Bad recipient.');
    expect(ms.state.createAttempts).toHaveLength(1);
    expect(ms.state.paths.filter((path) => path.includes('/drafts/messages'))).toHaveLength(0);
    expect(ms.state.sendAttempts).toHaveLength(0);
  });

  it('does not send when the draft id cannot be saved: another process moved the intent on while the draft was being made', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Nia', realAddress);
    ms.state.onCreate = () => {
      ms.state.onCreate = null;
      env.db.prepare("UPDATE send_intent SET status = 'unknown' WHERE id = ?").run(intentId);
    };
    await drain(env);
    expect(ms.state.createAttempts).toHaveLength(1);
    expect(ms.state.sendAttempts).toHaveLength(0);
    expect(ms.state.sent).toHaveLength(0);
    expect(savedOf(env, intentId).provider_draft_id).toBeNull();
  });

  it('does not send when the adapter is told the draft id was not saved', async () => {
    const env = await freshEnv();
    const adapter = createMailAdapter(env.ctx, 'microsoft')!;
    const intent: MailIntent = { intentId: 'snd_y', accountId: stubMicrosoftAddress, fromAddress: stubMicrosoftAddress, to: realAddress, subject: 'x', body: 'y', messageIdHeader: null, providerDraftId: null, replyTo: null };
    await expect(adapter.provider.submit(intent, { saveDraft: () => false })).rejects.toMatchObject({ sentNothing: true, definitive: true });
    await expect(adapter.provider.submit(intent)).rejects.toMatchObject({ sentNothing: true });
    expect(ms.state.sendAttempts).toHaveLength(0);
    expect(ms.state.sent).toHaveLength(0);
  });

  it('turns a lost send answer into unknown, then reads the draft: it was sent, so nothing is sent again', async () => {
    const env = await freshEnv();
    ms.state.sendScript.push({ type: 'process_then_delay', delayMs: 1500 });
    const intentId = queueOne(env, 'Oli', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(intentOf(env, intentId).error).toMatch(/may or may not have been sent/);
    expect(ms.state.sent).toHaveLength(1);

    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('unknown');

    env.advance(1500);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    const sent = ms.state.sent[0]!;
    expect(intent).toMatchObject({ status: 'accepted', providerMessageId: sent.internetMessageId, providerThreadId: sent.conversationId });
    expect(ms.state.sent).toHaveLength(1);
    expect(ms.state.sendAttempts).toHaveLength(1);
    expect(ms.state.createAttempts).toHaveLength(1);
    expect(Object.values(ms.state.messages)).toHaveLength(1);
    const read = ms.state.requests.filter((request) => request.method === 'GET' && request.path === `/v1.0/me/messages/${sent.id}`);
    expect(read).toHaveLength(1);
    expect(read[0]!.query.$select).toBe('id,isDraft,parentFolderId,internetMessageId,conversationId');
    expect(String(read[0]!.headers.prefer)).toBe('IdType="ImmutableId"');
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'email_out'").get()).toEqual({ n: 1 });
  });

  it('sends the SAME draft again, exactly once, when a reconcile finds it still a draft, and creates no new draft', async () => {
    const env = await freshEnv();
    // Outlook answered 503 before it processed anything, so the draft was never sent.
    ms.state.sendScript.push({ type: 'respond', status: 503 });
    const intentId = queueOne(env, 'Pia', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(ms.state.sent).toHaveLength(0);
    const draftId = savedOf(env, intentId).provider_draft_id!;
    expect(ms.state.messages[draftId]!.isDraft).toBe(true);

    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('accepted');
    expect(ms.state.sent).toHaveLength(1);
    expect(ms.state.sent[0]!.id).toBe(draftId);
    expect(ms.state.sendAttempts.map((attempt) => attempt.id)).toEqual([draftId, draftId]);
    expect(ms.state.sendAttempts.map((attempt) => attempt.processed)).toEqual([false, true]);
    expect(ms.state.createAttempts).toHaveLength(1);
    expect(Object.values(ms.state.messages)).toHaveLength(1);
    expect(intent.providerMessageId).toBe(ms.state.sent[0]!.internetMessageId);

    // Another reconcile has nothing left to do, and nothing more is sent.
    await reconcileIntent(env.ctx, { intentId, attempt: 1, workspaceId: env.workspaceId });
    expect(ms.state.sendAttempts).toHaveLength(2);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'email_out'").get()).toEqual({ n: 1 });
  });

  it('keeps a failed re-send unknown: a 5xx is checked again, a 4xx stops the checks without saying it was not sent', async () => {
    const env = await freshEnv();
    ms.state.sendScript.push({ type: 'respond', status: 503 }, { type: 'respond', status: 503 });
    const intentId = queueOne(env, 'Quin', realAddress);
    await drain(env);
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(ms.state.sent).toHaveLength(0);
    expect(ms.state.sendAttempts).toHaveLength(2);

    ms.state.sendScript.push({ type: 'respond', status: 403, body: { error: { code: 'ErrorSendAsDenied', message: 'Not allowed to send.' } } });
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toContain('This does not show the email was not sent');
    expect(ms.state.sent).toHaveLength(0);
    expect(taskCount(env, 'Quin')).toBe(1);
  });

  it('does not send the draft again when a guard that protects a first send now fails, but still learns of a sent draft', async () => {
    const env = await freshEnv();
    ms.state.sendScript.push({ type: 'respond', status: 503 });
    const intentId = queueOne(env, 'Rae', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    // The person opted out after the approval.
    env.db
      .prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES ('sup_t1', ?, ?, ?, 'manual', 'test')")
      .run(env.ctx.now(), env.workspaceId, realAddress);
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(ms.state.sendAttempts).toHaveLength(1);
    expect(ms.state.sent).toHaveLength(0);

    // Had the draft been sent after all, the read alone still resolves the intent.
    const draftId = savedOf(env, intentId).provider_draft_id!;
    ms.state.messages[draftId]!.isDraft = false;
    ms.state.messages[draftId]!.folder = 'sentitems';
    env.advance(3_700_000);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(ms.state.sendAttempts).toHaveLength(1);
  });

  it('does not send a draft that is no longer in the drafts folder, and does not look at when it was last modified', async () => {
    const env = await freshEnv();
    ms.state.sendScript.push({ type: 'respond', status: 503 });
    const intentId = queueOne(env, 'Sol', realAddress);
    await drain(env);
    const draftId = savedOf(env, intentId).provider_draft_id!;
    const message = ms.state.messages[draftId]!;

    // Someone moved the unsent draft to Deleted Items (a deleted draft is still a draft there).
    message.folder = 'deleteditems';
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(ms.state.sendAttempts).toHaveLength(1);

    // Back in Drafts and modified a second ago, unchanged in content. Only the recorded send attempt and the content
    // decide, so it is sent, once.
    message.folder = 'drafts';
    env.advance(pastTheWait);
    message.lastModifiedDateTime = new Date(Date.parse(env.ctx.now()) - 1000).toISOString();
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(ms.state.sendAttempts).toHaveLength(2);
    expect(ms.state.sent).toHaveLength(1);
    const reads = ms.state.requests.filter((request) => request.method === 'GET' && request.path === `/v1.0/me/messages/${draftId}`);
    expect(reads.every((request) => !String(request.query.$select).includes('lastModifiedDateTime'))).toBe(true);
  });

  it('checks Sent Items by internet message id when the draft id answers 404, and resolves a sent message', async () => {
    const env = await freshEnv();
    ms.state.sendScript.push({ type: 'process_then_respond', status: 502 });
    const intentId = queueOne(env, 'Tam', realAddress);
    await drain(env);
    const draftId = savedOf(env, intentId).provider_draft_id!;
    const stored = savedOf(env, intentId).message_id_header!;
    // After a restart the sent message has another id, so the draft id no longer resolves.
    const sentCopy = { ...ms.state.messages[draftId]!, id: 'AAMk-sent-copy' };
    delete ms.state.messages[draftId];
    ms.state.messages[sentCopy.id] = sentCopy;
    env.advance(1500);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    expect(intent).toMatchObject({ status: 'accepted', providerMessageId: stored });
    const filter = ms.state.requests.find((request) => request.path === '/v1.0/me/mailFolders/sentitems/messages')!;
    expect(filter.query.$filter).toBe(`internetMessageId eq '${stored}'`);
    expect(filter.query.$top).toBe('1');
    expect(ms.state.sendAttempts).toHaveLength(1);
    expect(ms.state.createAttempts).toHaveLength(1);
  });

  it('keeps the intent unknown when the draft is gone and Sent Items has nothing, never sends, and stops after six checks with a task', async () => {
    const env = await freshEnv();
    ms.state.sendScript.push({ type: 'respond', status: 503 });
    const intentId = queueOne(env, 'Uma', realAddress);
    await drain(env);
    delete ms.state.messages[savedOf(env, intentId).provider_draft_id!];
    for (let round = 0; round < 6; round += 1) {
      env.advance(1500);
      await processMailJobs(env.ctx);
      expect(statusOf(env, intentId)).toBe('unknown');
    }
    const intent = intentOf(env, intentId);
    expect(intent.error).toMatch(/Still unknown after 6 checks/);
    expect(intent.error).toContain('Sent Items');
    expect(ms.state.sendAttempts).toHaveLength(1);
    expect(ms.state.sent).toHaveLength(0);
    expect(taskCount(env, 'Uma')).toBe(1);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status != 'done'").get()).toEqual({ n: 0 });
  });

  it('makes no call after the checking window and leaves the intent unknown with a task', async () => {
    const env = await freshEnv();
    ms.state.sendScript.push({ type: 'respond', status: 500 });
    const intentId = queueOne(env, 'Vea', realAddress);
    await drain(env);
    const before = ms.state.requests.length;
    env.advance(24 * 3_600_000);
    await processMailJobs(env.ctx);
    expect(ms.state.requests.length).toBe(before);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toContain('not confirmed in Outlook within a day');
    expect(taskCount(env, 'Vea')).toBe(1);
  });

  it('turns an interrupted submit into unknown on restart: with a saved draft the check resolves it, and without one nothing is sent', async () => {
    const env = await freshEnv();
    // Died after the draft was saved and the send went out.
    ms.state.sendScript.push({ type: 'process_then_respond', status: 502 });
    const withDraft = queueOne(env, 'Wil', realAddress);
    await drain(env);
    env.db.prepare("UPDATE send_intent SET status = 'submitting', submitted_at = ? WHERE id = ?").run(env.ctx.now(), withDraft);
    expect(recoverSubmittingIntents(env.ctx)).toBe(1);
    expect(statusOf(env, withDraft)).toBe('unknown');
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(statusOf(env, withDraft)).toBe('accepted');

    // Died after the claim and before any draft was saved: the send step was never reached.
    const without = queueOne(env, 'Xan', 'xan@lanternrow.invalid');
    env.db.prepare("UPDATE send_intent SET status = 'submitting', submitted_at = ? WHERE id = ?").run(env.ctx.now(), without);
    expect(recoverSubmittingIntents(env.ctx)).toBe(1);
    const before = ms.state.requests.length;
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(statusOf(env, without)).toBe('unknown');
    expect(ms.state.requests.length).toBe(before);
    expect(ms.state.sendAttempts).toHaveLength(1);
  });

  it('is told "not found" without any request when no draft id was saved', async () => {
    const env = await freshEnv();
    const adapter = createMailAdapter(env.ctx, 'microsoft')!;
    const before = ms.state.requests.length;
    const intent: MailIntent = { intentId: 'snd_x', accountId: stubMicrosoftAddress, fromAddress: stubMicrosoftAddress, to: realAddress, subject: 'x', body: 'y', messageIdHeader: null, providerDraftId: null, replyTo: null };
    expect(await adapter.provider.reconcileUnknown(intent, { mayResend: true })).toEqual({ outcome: 'not_found' });
    expect(ms.state.requests.length).toBe(before);
  });

  it('refuses to send in a reconcile unless it is told it may, and a read only check never touches the send endpoint', async () => {
    const env = await freshEnv();
    ms.state.sendScript.push({ type: 'respond', status: 503 });
    const intentId = queueOne(env, 'Yul', realAddress);
    await drain(env);
    const saved = savedOf(env, intentId);
    const adapter = createMailAdapter(env.ctx, 'microsoft')!;
    const intent: MailIntent = { intentId, accountId: stubMicrosoftAddress, fromAddress: stubMicrosoftAddress, to: realAddress, subject: 'x', body: 'y', messageIdHeader: saved.message_id_header, providerDraftId: saved.provider_draft_id, replyTo: null };
    const before = ms.state.requests.length;
    expect(await adapter.provider.reconcileUnknown(intent)).toEqual({ outcome: 'not_found' });
    expect(await adapter.provider.reconcileUnknown(intent, { mayResend: false })).toEqual({ outcome: 'not_found' });
    const made = ms.state.requests.slice(before);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((request) => request.method === 'GET')).toBe(true);
    expect(ms.state.sendAttempts).toHaveLength(1);
  });

  it('reports an unavailable check as unavailable, never as not found', async () => {
    const env = await freshEnv();
    ms.state.sendScript.push({ type: 'respond', status: 503 });
    const intentId = queueOne(env, 'Zia', realAddress);
    await drain(env);
    const saved = savedOf(env, intentId);
    ms.state.getStatusById[saved.provider_draft_id!] = 503;
    const adapter = createMailAdapter(env.ctx, 'microsoft')!;
    const result = await adapter.provider.reconcileUnknown(
      { intentId, accountId: stubMicrosoftAddress, fromAddress: stubMicrosoftAddress, to: realAddress, subject: 'x', body: 'y', messageIdHeader: saved.message_id_header, providerDraftId: saved.provider_draft_id, replyTo: null },
      { mayResend: true },
    );
    expect(result.outcome).toBe('unavailable');
    expect(ms.state.sendAttempts).toHaveLength(1);
  });
});

describe('microsoft definitive refusals and tokens', () => {
  it('fails the intent on a definitive send refusal, says a draft may remain, and never retries', async () => {
    const env = await freshEnv();
    ms.state.sendScript.push({ type: 'respond', status: 400, body: { error: { code: 'ErrorInvalidRecipients', message: 'No valid recipients.' } } });
    const intentId = queueOne(env, 'Abe', realAddress);
    await drain(env);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('failed');
    expect(intent.error).toContain('No valid recipients.');
    expect(intent.error).toContain('A draft may remain in Outlook drafts.');
    for (let round = 0; round < 3; round += 1) {
      env.advance(100_000);
      await processMailJobs(env.ctx);
    }
    expect(ms.state.sendAttempts).toHaveLength(1);
    expect(ms.state.sent).toHaveLength(0);
  });

  it('treats a 403 on send as a refusal, and a 404 on the draft, a 429, a 5xx as unknown', async () => {
    const env = await freshEnv();
    const run = async (name: string, behavior: Parameters<typeof ms.state.sendScript.push>[0]) => {
      ms.state.sendScript.push(behavior);
      const id = queueOne(env, name, `${name.toLowerCase()}@lanternrow.invalid`);
      await drain(env);
      return statusOf(env, id);
    };
    expect(await run('Bea', { type: 'respond', status: 403 })).toBe('failed');
    expect(await run('Cal', { type: 'respond', status: 404, body: { error: { code: 'ErrorItemNotFound', message: 'gone' } } })).toBe('unknown');
    expect(await run('Dee', { type: 'respond', status: 429, headers: { 'retry-after': '30' } })).toBe('unknown');
    expect(await run('Eli', { type: 'respond', status: 500 })).toBe('unknown');
    expect(await run('Flo', { type: 'process_then_respond', status: 504 })).toBe('unknown');
  });

  it('refreshes the token once on a 401 and then sends exactly one message', async () => {
    const env = await freshEnv();
    const before = refreshes();
    ms.state.sendScript.push({ type: 'respond', status: 401 });
    const intentId = queueOne(env, 'Gus', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(ms.state.sendAttempts).toHaveLength(2);
    expect(ms.state.sent).toHaveLength(1);
    expect(refreshes() - before).toBe(1);
    expect(ms.state.sendAttempts[0]!.accessToken).not.toBe(ms.state.sendAttempts[1]!.accessToken);
    expect(ms.state.createAttempts).toHaveLength(1);
  });

  it('fails the intent, without sending, when the second attempt is also refused with a 401', async () => {
    const env = await freshEnv();
    ms.state.sendScript.push({ type: 'respond', status: 401 }, { type: 'respond', status: 401 });
    const intentId = queueOne(env, 'Hui', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('failed');
    expect(ms.state.sent).toHaveLength(0);
    expect(ms.state.sendAttempts).toHaveLength(2);
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.status).toBe('error');
  });

  it('refreshes ahead of use when less than two minutes are left, with one request for concurrent callers', async () => {
    const env = await freshEnv();
    const row = env.db.prepare("SELECT id, secret FROM connector WHERE kind = 'microsoft'").get() as { id: string; secret: string };
    const soon = new Date(Date.parse(env.ctx.now()) + 90_000).toISOString();
    env.db.prepare('UPDATE connector SET secret = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.secret), expiresAt: soon }), row.id);
    const before = refreshes();
    const adapter = createMailAdapter(env.ctx, 'microsoft')!;
    const [first, second] = await Promise.all([adapter.provider.checkAccount(), adapter.provider.checkAccount()]);
    expect(first.address).toBe(stubMicrosoftAddress);
    expect(second.address).toBe(stubMicrosoftAddress);
    expect(refreshes() - before).toBe(1);
    await adapter.provider.checkAccount();
    expect(refreshes() - before).toBe(1);
  });

  it('stores the rotated refresh token with every refresh, and the next refresh uses it', async () => {
    const env = await freshEnv();
    const stored = () => getMicrosoftInternals(env.db, env.workspaceId)!.secret;
    const first = stored().refreshToken!;
    const adapter = createMailAdapter(env.ctx, 'microsoft')!;
    env.advance(3_500_000);
    await adapter.provider.checkAccount();
    const second = stored().refreshToken!;
    expect(second).not.toBe(first);
    // The retired token is dead at Microsoft: using it again would sign the connector out.
    expect(ms.state.refreshTokens.has(first)).toBe(false);
    expect(ms.state.refreshTokens.has(second)).toBe(true);
    env.advance(3_500_000);
    await adapter.provider.checkAccount();
    const third = stored().refreshToken!;
    expect(third).not.toBe(second);
    const requests = ms.state.tokenRequests.filter((request) => request.grantType === 'refresh_token');
    expect(requests.map((request) => request.form.refresh_token)).toEqual([first, second]);
    expect(requests.every((request) => request.form.client_secret === undefined)).toBe(true);
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.status).toBe('connected');
  });

  it('marks the connector with the sign in again sentence on invalid_grant, and sends nothing', async () => {
    const env = await freshEnv();
    expireAccessToken(env);
    ms.state.tokenMode = 'invalid_grant';
    const intentId = queueOne(env, 'Ivy', realAddress);
    await drain(env);
    const connector = getConnector(env.db, env.workspaceId, 'microsoft')!;
    expect(connector.status).toBe('error');
    expect(connector.statusMessage).toContain('Sign in with Microsoft again');
    expect(statusOf(env, intentId)).toBe('failed');
    expect(intentOf(env, intentId).error).toContain('The message was not sent.');
    expect(ms.state.createAttempts).toHaveLength(0);
    expect(ms.state.sendAttempts).toHaveLength(0);
    expect(JSON.stringify(connector)).not.toContain('eyJ');
  });

  it('fails a send, rather than guessing, when Microsoft cannot be reached for a token before the request', async () => {
    const env = await freshEnv();
    expireAccessToken(env);
    ms.state.tokenMode = 'unavailable';
    const intentId = queueOne(env, 'Jon', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('failed');
    expect(intentOf(env, intentId).error).toContain('not sent');
    expect(ms.state.createAttempts).toHaveLength(0);
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.status).toBe('connected');
  });

  it('never sends from a different account: the adapter stops when the signed in address is not the one it was built for', async () => {
    const env = await freshEnv();
    const real = createMailAdapter(env.ctx, 'microsoft')!;
    const wrongStore = { ...createMicrosoftTokenStore(env.ctx), read: () => ({ ...createMicrosoftTokenStore(env.ctx).read(), address: 'someone.else@outlook-stub.invalid' }) };
    const provider = createMicrosoftMailProvider({ address: real.account.address!, store: wrongStore, now: () => Date.parse(env.ctx.now()) });
    const before = ms.state.requests.length;
    await expect(
      provider.submit(
        { intentId: 'snd_wrong', accountId: stubMicrosoftAddress, fromAddress: stubMicrosoftAddress, to: realAddress, subject: 'x', body: 'y', messageIdHeader: null, providerDraftId: null, replyTo: null },
        { saveDraft: () => true },
      ),
    ).rejects.toMatchObject({ sentNothing: true, definitive: true });
    expect(ms.state.requests.length).toBe(before);
    await expect(provider.checkAccount()).rejects.toThrow();
    expect(ms.state.requests.length).toBe(before);
  });

  it('refuses a header with a line break, so nothing is created', async () => {
    const env = await freshEnv();
    const adapter = createMailAdapter(env.ctx, 'microsoft')!;
    await expect(
      adapter.provider.submit({ intentId: 'snd_x', accountId: stubMicrosoftAddress, fromAddress: stubMicrosoftAddress, to: realAddress, subject: 'Hi\r\nBcc: x@y.invalid', body: 'y', messageIdHeader: null, replyTo: null }, { saveDraft: () => true }),
    ).rejects.toMatchObject({ sentNothing: true });
    expect(ms.state.createAttempts).toHaveLength(0);
  });

  it('sends a non-ASCII message intact through the whole path', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Zoë', realAddress);
    const staged = stage(env, [addDraft(env, person.id, 'Café ☕ plans', 'Bonjour Zoë,\n\nÀ bientôt, 你好')]);
    approve(env, staged.approval!.id);
    await drain(env);
    expect(ms.state.sent[0]!.subject).toBe('Café ☕ plans');
    expect(ms.state.sent[0]!.text).toBe('Bonjour Zoë,\n\nÀ bientôt, 你好');
  });
});

describe('an unknown message whose Microsoft check cannot run', () => {
  it('gets the check task and an audit note at once, only once, when the sign in no longer works', async () => {
    const env = await freshEnv();
    const intentId = await unknownThatWasSent(env, 'Una');
    markMicrosoftError(env.ctx, 'invalid_grant');
    env.advance(1500);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toMatch(/Checking again stopped/);
    expect(intent.error).toContain('Sign in with Microsoft again');
    expect(taskCount(env, 'Una')).toBe(1);
    expect(auditCount(env, 'send_intent.reconcile_stopped', intentId)).toBe(1);
    const errorBefore = intent.error;
    await reconcileIntent(env.ctx, { intentId, attempt: 1, workspaceId: env.workspaceId });
    expect(intentOf(env, intentId).error).toBe(errorBefore);
    expect(taskCount(env, 'Una')).toBe(1);
    expect(ms.state.sendAttempts).toHaveLength(1);
  });

  it('does the same when the connector was removed, and when a different account is signed in', async () => {
    const removedEnv = await freshEnv();
    const removed = await unknownThatWasSent(removedEnv, 'Vic');
    disconnectMicrosoftConnector(removedEnv.ctx);
    removedEnv.advance(1500);
    await processMailJobs(removedEnv.ctx);
    expect(statusOf(removedEnv, removed)).toBe('unknown');
    expect(intentOf(removedEnv, removed).error).toContain('Microsoft connector was removed');
    expect(taskCount(removedEnv, 'Vic')).toBe(1);

    const otherEnv = await freshEnv();
    const other = await unknownThatWasSent(otherEnv, 'Wes');
    ms.state.address = 'someone.else@outlook-stub.invalid';
    await connectMicrosoft(otherEnv, ms);
    otherEnv.advance(1500);
    await processMailJobs(otherEnv.ctx);
    expect(statusOf(otherEnv, other)).toBe('unknown');
    expect(intentOf(otherEnv, other).error).toContain('sending inbox changed');
    expect(taskCount(otherEnv, 'Wes')).toBe(1);
    expect(ms.state.sendAttempts).toHaveLength(2);
  });

  it('resumes the check when the same account signs in again, and finds the message without sending', async () => {
    const env = await freshEnv();
    const intentId = await unknownThatWasSent(env, 'Xia');
    markMicrosoftError(env.ctx, 'invalid_grant');
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(taskCount(env, 'Xia')).toBe(1);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status != 'done'").get()).toEqual({ n: 0 });

    await connectMicrosoft(env, ms);
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.status).toBe('connected');
    expect(auditCount(env, 'send_intent.reconcile_resumed', intentId)).toBe(1);
    await processMailJobs(env.ctx);
    expect(intentOf(env, intentId)).toMatchObject({ status: 'accepted', providerMessageId: ms.state.sent[0]!.internetMessageId });
    expect(ms.state.sendAttempts).toHaveLength(1);
  });

  it('does not resume for a message a person acknowledged, and does not queue a second job when one is waiting', async () => {
    const env = await freshEnv();
    const acknowledged = await unknownThatWasSent(env, 'Yan');
    const waiting = await unknownThatWasSent(env, 'Zed', 'zed@lanternrow.invalid');
    controlSendIntent(env.ctx, acknowledged, { action: 'acknowledge' });
    expect(statusOf(env, acknowledged)).toBe('cancelled');
    const jobs = () => (env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status = 'queued' AND json_extract(payload, '$.intentId') = ?").get(waiting) as { n: number }).n;
    expect(jobs()).toBe(1);
    markMicrosoftError(env.ctx, 'invalid_grant');
    await connectMicrosoft(env, ms);
    expect(auditCount(env, 'send_intent.reconcile_resumed', acknowledged)).toBe(0);
    expect(auditCount(env, 'send_intent.reconcile_resumed', waiting)).toBe(0);
    expect(jobs()).toBe(1);
  });
});

describe('the reconcile schedule for Microsoft', () => {
  it('uses the day long schedule Gmail uses', () => {
    const saved = process.env.AGENTCRM_MAIL_RECONCILE_MS;
    delete process.env.AGENTCRM_MAIL_RECONCILE_MS;
    try {
      expect(mailReconcileDelays('microsoft')).toEqual([30_000, 120_000, 600_000, 3_600_000, 21_600_000, 79_200_000]);
      expect(mailReconcileDelays('agentmail')).toEqual([30_000, 120_000, 600_000]);
      process.env.AGENTCRM_MAIL_RECONCILE_MS = '1000';
      expect(mailReconcileDelays('microsoft')).toEqual([1000, 1000, 1000, 1000, 1000, 1000]);
    } finally {
      if (saved === undefined) delete process.env.AGENTCRM_MAIL_RECONCILE_MS;
      else process.env.AGENTCRM_MAIL_RECONCILE_MS = saved;
    }
  });
});

describe('token refresh is compare and set', () => {
  it('never overwrites a sign in that finished while a refresh was on the wire, and uses the new credentials', async () => {
    const env = await freshEnv();
    env.advance(3_500_000);
    const stored = () => getMicrosoftInternals(env.db, env.workspaceId)!.secret;
    const oldRefresh = stored().refreshToken;
    const newcomer = { accessToken: 'eyJ.new-account', refreshToken: 'M.C500.new-account-refresh' };
    ms.state.accessTokens.add(newcomer.accessToken);
    ms.state.refreshTokens.add(newcomer.refreshToken);
    const expiresAt = new Date(Date.parse(env.ctx.now()) + 3_000_000).toISOString();
    ms.state.onRefresh = () => {
      ms.state.onRefresh = null;
      const row = env.db.prepare("SELECT id, secret FROM connector WHERE kind = 'microsoft'").get() as { id: string; secret: string };
      env.db.prepare('UPDATE connector SET secret = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.secret), ...newcomer, expiresAt }), row.id);
    };
    const adapter = createMailAdapter(env.ctx, 'microsoft')!;
    expect((await adapter.provider.checkAccount()).address).toBe(stubMicrosoftAddress);
    expect(oldRefresh).not.toBe(newcomer.refreshToken);
    expect(stored()).toMatchObject({ accessToken: newcomer.accessToken, refreshToken: newcomer.refreshToken, expiresAt });
    expect(refreshes()).toBe(1);
    const profile = ms.state.requests.filter((request) => request.path === '/v1.0/me').at(-1)!;
    expect(profile.headers.authorization).toBe(`Bearer ${newcomer.accessToken}`);
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.status).toBe('connected');
  });

  it('retries once with the new refresh token when the new sign in has no fresh access token yet', async () => {
    const env = await freshEnv();
    env.advance(3_500_000);
    const newcomerRefresh = 'M.C500.second-account-refresh';
    ms.state.refreshTokens.add(newcomerRefresh);
    ms.state.onRefresh = () => {
      ms.state.onRefresh = null;
      const row = env.db.prepare("SELECT id, secret FROM connector WHERE kind = 'microsoft'").get() as { id: string; secret: string };
      env.db.prepare('UPDATE connector SET secret = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.secret), accessToken: null, expiresAt: null, refreshToken: newcomerRefresh }), row.id);
    };
    const adapter = createMailAdapter(env.ctx, 'microsoft')!;
    await adapter.provider.checkAccount();
    const requests = ms.state.tokenRequests.filter((request) => request.grantType === 'refresh_token');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.form.refresh_token).toBe(newcomerRefresh);
    // The retry's own rotated token replaced the newcomer's, as the compare and set allows.
    expect(getMicrosoftInternals(env.db, env.workspaceId)!.secret.refreshToken).not.toBe(newcomerRefresh);
    expect(ms.state.refreshTokens.has(getMicrosoftInternals(env.db, env.workspaceId)!.secret.refreshToken!)).toBe(true);
  });

  it('does not mark a newer sign in as broken when the refusal belongs to the old refresh token', async () => {
    const env = await freshEnv();
    env.advance(3_500_000);
    ms.state.tokenMode = 'invalid_grant';
    ms.state.onRefresh = () => {
      ms.state.onRefresh = null;
      const row = env.db.prepare("SELECT id, secret FROM connector WHERE kind = 'microsoft'").get() as { id: string; secret: string };
      env.db.prepare('UPDATE connector SET secret = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.secret), refreshToken: 'M.C500.newer' }), row.id);
    };
    const adapter = createMailAdapter(env.ctx, 'microsoft')!;
    await expect(adapter.provider.checkAccount()).rejects.toThrow();
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.status).toBe('connected');
  });

  it('writes the rotated refresh token in the same save as the access token, and only while the refresh token it started from is stored', async () => {
    const env = await freshEnv();
    const store = createMicrosoftTokenStore(env.ctx);
    const session = store.read();
    expect(store.save({ accessToken: 'a1', refreshToken: 'r2', expiresAt: '2030-01-01T00:00:00.000Z', startedFromRefreshToken: session.refreshToken })).toBe(true);
    expect(getMicrosoftInternals(env.db, env.workspaceId)!.secret).toEqual({ accessToken: 'a1', refreshToken: 'r2', expiresAt: '2030-01-01T00:00:00.000Z' });
    // A second save that started from the old token writes nothing.
    expect(store.save({ accessToken: 'a9', refreshToken: 'r9', expiresAt: '2031-01-01T00:00:00.000Z', startedFromRefreshToken: session.refreshToken })).toBe(false);
    expect(getMicrosoftInternals(env.db, env.workspaceId)!.secret.refreshToken).toBe('r2');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Review fixes: what is verified and re-checked at the moment money leaves

function suppress(env: TestEnvironment, email: string): void {
  env.db
    .prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES (?, ?, ?, ?, 'opt_out', 'test')")
    .run(env.ctx.newId('sup'), env.ctx.now(), env.workspaceId, email.toLowerCase());
}

function pendingChecks(env: TestEnvironment): number {
  return (env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status != 'done'").get() as { n: number }).n;
}

function stampOf(env: TestEnvironment, intentId: string): string | null {
  return (env.db.prepare('SELECT send_attempted_at FROM send_intent WHERE id = ?').get(intentId) as { send_attempted_at: string | null }).send_attempted_at;
}

const draftChanged = 'The draft in Outlook changed after approval, so it was not sent. Delete the draft and stage the message again.';

// An unknown message whose draft is still unsent (Outlook answered 503 before it did anything).
async function unknownWithUnsentDraft(env: TestEnvironment, name: string, email = realAddress): Promise<{ intentId: string; draftId: string }> {
  ms.state.sendScript.push({ type: 'respond', status: 503 });
  const intentId = queueOne(env, name, email);
  await drain(env);
  expect(statusOf(env, intentId)).toBe('unknown');
  return { intentId, draftId: savedOf(env, intentId).provider_draft_id! };
}

describe('a draft that changed after approval is never sent again', () => {
  const edits: [string, (id: string) => void][] = [
    ['the text', (id) => ms.editDraft(id, { text: 'Hi Cy, please send your bank details to me instead.' })],
    ['the subject', (id) => ms.editDraft(id, { subject: 'Urgent: wire transfer' })],
    ['the recipient', (id) => ms.editDraft(id, { to: ['someone.else@lanternrow.invalid'] })],
    ['an added recipient', (id) => ms.editDraft(id, { to: [realAddress, 'extra@lanternrow.invalid'] })],
    ['a copy', (id) => ms.editDraft(id, { cc: ['boss@lanternrow.invalid'] })],
    ['a blind copy', (id) => ms.editDraft(id, { bcc: ['watcher@lanternrow.invalid'] })],
    ['html with other words', (id) => ms.editDraft(id, { html: '<html><body><p>Hi Cy, a different message.</p></body></html>' })],
  ];
  for (const [what, edit] of edits) {
    it(`does not send after ${what} changed, stops the checks, and leaves a task and an audit record`, async () => {
      const env = await freshEnv();
      const { intentId, draftId } = await unknownWithUnsentDraft(env, 'Cy');
      edit(draftId);
      env.advance(pastTheWait);
      await processMailJobs(env.ctx);
      const intent = intentOf(env, intentId);
      expect(intent.status).toBe('unknown');
      expect(intent.error).toContain(draftChanged);
      expect(ms.state.sendAttempts).toHaveLength(1);
      expect(ms.state.sent).toHaveLength(0);
      expect(taskCount(env, 'Cy')).toBe(1);
      expect(pendingChecks(env)).toBe(0);
      const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'send_intent.reconcile_stopped' AND entity_id = ?").all(intentId) as { detail: string }[];
      expect(audit.map((row) => JSON.parse(row.detail).reason)).toEqual(['draft_changed']);
      // Asking again changes nothing.
      env.advance(pastTheWait);
      await reconcileIntent(env.ctx, { intentId, attempt: 1, workspaceId: env.workspaceId });
      expect(ms.state.sendAttempts).toHaveLength(1);
      expect(intentOf(env, intentId).error).toBe(intent.error);
    });
  }

  it('reads the draft just before the request, and sends it when only line endings, case of the address, or trailing space differ', async () => {
    const env = await freshEnv();
    const { intentId, draftId } = await unknownWithUnsentDraft(env, 'Di');
    ms.editDraft(draftId, { text: 'Hi Di, this is a test message.\r\n  \r\n', to: [realAddress.toUpperCase()] });
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(ms.state.sent).toHaveLength(1);
    expect(ms.state.sendAttempts).toHaveLength(2);
    const reads = ms.state.requests.filter((request) => request.method === 'GET' && request.path === `/v1.0/me/messages/${draftId}`);
    const content = reads.at(-1)!;
    expect(content.query.$select).toBe('id,isDraft,parentFolderId,toRecipients,ccRecipients,bccRecipients,subject,body');
    const secondSend = ms.state.requests.filter((request) => request.method === 'POST' && request.path === `/v1.0/me/messages/${draftId}/send`)[1]!;
    expect(ms.state.requests.indexOf(content)).toBeLessThan(ms.state.requests.indexOf(secondSend));
  });

  it('compares the text of an html body with the approved text', async () => {
    const env = await freshEnv();
    const { intentId, draftId } = await unknownWithUnsentDraft(env, 'Ed');
    ms.editDraft(draftId, { html: '<html><body><p>Hi Ed, this is a test message.</p></body></html>' });
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(ms.state.sent).toHaveLength(1);
  });

  it('adopts a found draft that still holds the approved message', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Dov', realAddress);
    const stray = ms.addStrayDraft({ intentId, to: realAddress, subject: 'Hello Dov', body: 'Hi Dov, this is a test message.' });
    ms.state.createScript.push({ type: 'respond', status: 503 });
    await drain(env);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(ms.state.createAttempts).toHaveLength(1);
    expect(ms.state.sent.map((item) => item.id)).toEqual([stray.id]);
  });

  it('does not adopt a found draft that was edited, makes the one more draft, and notes the stray draft', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Eve', realAddress);
    const stray = ms.addStrayDraft({ intentId, to: realAddress, subject: 'Hello Eve', body: 'Hi Eve, a very different message.' });
    ms.state.createScript.push({ type: 'respond', status: 503 });
    await drain(env);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(ms.state.createAttempts).toHaveLength(2);
    expect(ms.state.sent).toHaveLength(1);
    expect(ms.state.sent[0]!.id).not.toBe(stray.id);
    expect(ms.state.sent[0]!.text).toBe('Hi Eve, this is a test message.');
    expect(ms.state.messages[stray.id]!.isDraft).toBe(true);
    const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'send_intent.stray_draft' AND entity_id = ?").all(intentId) as { detail: string }[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ draftId: stray.id });
  });

  it('says the draft was edited when both creates fail and the only draft found was changed', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Fox', realAddress);
    ms.addStrayDraft({ intentId, to: 'else@lanternrow.invalid', subject: 'Hello Fox', body: 'Hi Fox, this is a test message.' });
    ms.state.createScript.push({ type: 'respond', status: 503 }, { type: 'respond', status: 503 });
    await drain(env);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('failed');
    expect(intent.error).toContain('edited after approval and was left alone');
    expect(ms.state.sendAttempts).toHaveLength(0);
  });
});

describe('a draft is sent again only on a fresh approval', () => {
  it('does not send after the approval is more than a day old: the checks stop with the task and an honest sentence', async () => {
    const env = await freshEnv();
    const { intentId } = await unknownWithUnsentDraft(env, 'Gil');
    env.db.prepare('UPDATE approval SET decided_at = ?').run(new Date(Date.parse(env.ctx.now()) - 25 * 3_600_000).toISOString());
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toContain('Approved more than a day ago, so this app will not send the saved draft again.');
    expect(ms.state.sendAttempts).toHaveLength(1);
    expect(taskCount(env, 'Gil')).toBe(1);
    expect(pendingChecks(env)).toBe(0);
    expect(auditCount(env, 'send_intent.reconcile_stopped', intentId)).toBe(1);
  });

  it('still learns that a draft was sent when the approval is more than a day old', async () => {
    const env = await freshEnv();
    const intentId = await unknownThatWasSent(env, 'Hal');
    env.db.prepare('UPDATE approval SET decided_at = ?').run(new Date(Date.parse(env.ctx.now()) - 25 * 3_600_000).toISOString());
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(ms.state.sendAttempts).toHaveLength(1);
  });

  it('sends again while the approval is a little under a day old', async () => {
    const env = await freshEnv();
    const { intentId } = await unknownWithUnsentDraft(env, 'Ivo');
    env.db.prepare('UPDATE approval SET decided_at = ?').run(new Date(Date.parse(env.ctx.now()) - 23 * 3_600_000).toISOString());
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(ms.state.sendAttempts).toHaveLength(2);
  });
});

describe('every guard is checked again immediately before the request that sends', () => {
  it('blocks a first send when an opt out lands between the draft create and the send, and sends nothing', async () => {
    const env = await freshEnv();
    ms.state.onCreate = () => {
      ms.state.onCreate = null;
      suppress(env, realAddress);
    };
    const intentId = queueOne(env, 'Jo', realAddress);
    await drain(env);
    const intent = intentOf(env, intentId);
    expect(intent).toMatchObject({ status: 'blocked', error: 'suppressed' });
    expect(ms.state.createAttempts).toHaveLength(1);
    expect(ms.state.sendAttempts).toHaveLength(0);
    expect(ms.state.sent).toHaveLength(0);
    expect(stampOf(env, intentId)).toBeNull();
    // The draft is left behind in Outlook, and the record says so.
    expect(ms.drafts()).toHaveLength(1);
    const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'send_intent.block' AND entity_id = ?").all(intentId) as { detail: string }[];
    expect(JSON.parse(audit.at(-1)!.detail)).toMatchObject({ stage: 'before_send', strayDraftId: ms.drafts()[0]!.id, reason: 'suppressed' });
    // Nothing tries again.
    env.advance(pastTheWait);
    await drain(env);
    expect(ms.state.sendAttempts).toHaveLength(0);
  });

  it('blocks a first send when the person replied between the create and the send', async () => {
    const env = await freshEnv();
    ms.state.onCreate = () => {
      ms.state.onCreate = null;
      env.db
        .prepare(
          `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, direction, from_email, subject, provider_timestamp)
           VALUES (?, ?, ?, 'in-1', 'in', ?, 'Re: hello', ?)`,
        )
        .run(env.ctx.newId('msg'), env.ctx.now(), env.workspaceId, realAddress, env.ctx.now());
    };
    const intentId = queueOne(env, 'Kit', realAddress);
    await drain(env);
    expect(intentOf(env, intentId)).toMatchObject({ status: 'blocked', error: 'reply_received' });
    expect(ms.state.sendAttempts).toHaveLength(0);
  });

  it('blocks a resend when an opt out lands between the claim and the request, and keeps the intent unknown', async () => {
    const env = await freshEnv();
    const { intentId, draftId } = await unknownWithUnsentDraft(env, 'Lou2');
    let landed = false;
    ms.state.onRequest = ({ method, path, query }) => {
      // The read of what would be sent comes right before the request.
      if (!landed && method === 'GET' && path === `/me/messages/${draftId}` && String(query.$select).includes('toRecipients')) {
        landed = true;
        suppress(env, realAddress);
      }
    };
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(landed).toBe(true);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(ms.state.sendAttempts).toHaveLength(1);
    expect(ms.state.sent).toHaveLength(0);
    // The attempt time was not moved, because nothing was about to leave.
    const stamp = stampOf(env, intentId);
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(ms.state.sendAttempts).toHaveLength(1);
    expect(stampOf(env, intentId)).toBe(stamp);
  });
});

describe('the time of the last send attempt guards every resend', () => {
  it('writes the time in its own transaction before each request that sends, first send and resend', async () => {
    const env = await freshEnv();
    const seen: (string | null)[] = [];
    ms.state.onSend = () => {
      seen.push((env.db.prepare('SELECT send_attempted_at FROM send_intent WHERE provider = ? ORDER BY created_at DESC').get('microsoft') as { send_attempted_at: string | null }).send_attempted_at);
    };
    ms.state.sendScript.push({ type: 'respond', status: 503 });
    const intentId = queueOne(env, 'Mo', realAddress);
    await drain(env);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
    expect(seen[0]).toBe(stampOf(env, intentId));
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(seen).toHaveLength(2);
    expect(Date.parse(seen[1]!)).toBeGreaterThan(Date.parse(seen[0]!) + 30_000);
    expect(statusOf(env, intentId)).toBe('accepted');
  });

  it('waits twice the request timeout plus thirty seconds after the last attempt', async () => {
    const env = await freshEnv();
    const { intentId } = await unknownWithUnsentDraft(env, 'Ned');
    env.advance(29_000);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(ms.state.sendAttempts).toHaveLength(1);
    env.advance(2_000);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(ms.state.sendAttempts).toHaveLength(2);
  });

  it('makes the retry after a lost resend answer wait just as long', async () => {
    const env = await freshEnv();
    ms.state.sendScript.push({ type: 'respond', status: 503 }, { type: 'respond', status: 503 });
    const intentId = queueOne(env, 'Opal', realAddress);
    await drain(env);
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(ms.state.sendAttempts).toHaveLength(2);
    expect(statusOf(env, intentId)).toBe('unknown');
    // The usual short wait before the next check is not enough.
    env.advance(2_000);
    await processMailJobs(env.ctx);
    expect(ms.state.sendAttempts).toHaveLength(2);
    expect(statusOf(env, intentId)).toBe('unknown');
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(ms.state.sendAttempts).toHaveLength(3);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(ms.state.sent).toHaveLength(1);
  });

  for (const [what, value] of [
    ['missing', null],
    ['not a date', 'sometime last week'],
  ] as const) {
    it(`never sends again when the recorded time is ${what}, and checks until the window ends`, async () => {
      const env = await freshEnv();
      const { intentId } = await unknownWithUnsentDraft(env, 'Pru');
      env.db.prepare('UPDATE send_intent SET send_attempted_at = ? WHERE id = ?').run(value, intentId);
      for (let round = 0; round < 6; round += 1) {
        env.advance(pastTheWait);
        await processMailJobs(env.ctx);
        expect(statusOf(env, intentId)).toBe('unknown');
      }
      expect(ms.state.sendAttempts).toHaveLength(1);
      expect(ms.state.sent).toHaveLength(0);
      expect(intentOf(env, intentId).error).toMatch(/Still unknown after 6 checks/);
      expect(taskCount(env, 'Pru')).toBe(1);
    });
  }

  it('does not look at lastModifiedDateTime at all: a draft touched a second ago is sent once the wait has passed', async () => {
    const env = await freshEnv();
    const { intentId, draftId } = await unknownWithUnsentDraft(env, 'Quentin');
    env.advance(pastTheWait);
    ms.editDraft(draftId, { text: 'Hi Quentin, this is a test message.', lastModifiedDateTime: new Date(Date.parse(env.ctx.now()) - 1000).toISOString() });
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
  });
});

describe('the account is confirmed after the token is in hand', () => {
  const newcomer = { accessToken: 'eyJ.other-account', refreshToken: 'M.C500.other-account-refresh' };
  const otherAddress = 'someone.else@outlook-stub.invalid';

  // A sign in as another account finishes while the refresh is on the wire.
  function signInDuringRefresh(env: TestEnvironment): void {
    ms.state.accessTokens.add(newcomer.accessToken);
    ms.state.refreshTokens.add(newcomer.refreshToken);
    ms.state.onRefresh = () => {
      ms.state.onRefresh = null;
      const row = env.db.prepare("SELECT id, settings, secret FROM connector WHERE kind = 'microsoft'").get() as { id: string; settings: string; secret: string };
      const expiresAt = new Date(Date.parse(env.ctx.now()) + 3_000_000).toISOString();
      env.db
        .prepare('UPDATE connector SET settings = ?, secret = ? WHERE id = ?')
        .run(JSON.stringify({ ...JSON.parse(row.settings), emailAddress: otherAddress }), JSON.stringify({ ...JSON.parse(row.secret), ...newcomer, expiresAt }), row.id);
    };
  }

  const carriedNewcomer = () => ms.state.requests.filter((request) => request.headers.authorization === `Bearer ${newcomer.accessToken}`);

  it('does not send the request when a sign in as another account finished during the refresh, and says nothing was sent', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Rhea', realAddress);
    expireAccessToken(env);
    signInDuringRefresh(env);
    await drain(env);
    expect(ms.state.createAttempts).toHaveLength(0);
    expect(ms.state.sendAttempts).toHaveLength(0);
    expect(ms.state.sent).toHaveLength(0);
    expect(carriedNewcomer()).toHaveLength(0);
    expect(ms.state.paths.filter((path) => path.startsWith('POST /v1.0'))).toEqual([]);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('failed');
    expect(intent.error).toContain('account that is signed in changed');
    expect(intent.error).toContain('The message was not sent.');
  });

  it('does the same for a read, so mail is never read as the other account', async () => {
    const env = await freshEnv();
    expireAccessToken(env);
    signInDuringRefresh(env);
    const adapter = createMailAdapter(env.ctx, 'microsoft')!;
    await expect(adapter.provider.listInbound(null, { isKnown: () => false })).rejects.toThrow(/account that is signed in changed/);
    expect(carriedNewcomer()).toHaveLength(0);
  });

  it('does the same for the account check', async () => {
    const env = await freshEnv();
    expireAccessToken(env);
    signInDuringRefresh(env);
    const adapter = createMailAdapter(env.ctx, 'microsoft')!;
    await expect(adapter.provider.checkAccount()).rejects.toThrow(/account that is signed in changed/);
    expect(carriedNewcomer()).toHaveLength(0);
  });

  it('keeps working when the refresh finishes for the same account', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Sid', realAddress);
    expireAccessToken(env);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('accepted');
  });
});

describe('a message that is no longer a draft is accepted only from Sent Items', () => {
  it('keeps the intent unknown, with a task and an honest sentence, when the message sits in Deleted Items', async () => {
    const env = await freshEnv();
    const intentId = await unknownThatWasSent(env, 'Tia');
    const draftId = savedOf(env, intentId).provider_draft_id!;
    ms.moveMessage(draftId, 'deleteditems');
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toContain('not in Sent Items');
    expect(taskCount(env, 'Tia')).toBe(1);
    expect(ms.state.sendAttempts).toHaveLength(1);
    expect(ms.state.sent).toHaveLength(1);
    // It looked in Sent Items by the saved internet message id before giving up.
    const lookup = ms.state.requests.filter((request) => request.path === '/v1.0/me/mailFolders/sentitems/messages');
    expect(lookup).toHaveLength(1);
    expect(lookup[0]!.query.$filter).toBe(`internetMessageId eq '${savedOf(env, intentId).message_id_header}'`);
    // The note and the task appear once, and the checks go on: when the message is back in Sent Items it is accepted.
    for (let round = 0; round < 2; round += 1) {
      env.advance(pastTheWait);
      await processMailJobs(env.ctx);
    }
    expect(taskCount(env, 'Tia')).toBe(1);
    expect(intentOf(env, intentId).error?.split('not in Sent Items').length).toBe(2);
    ms.moveMessage(draftId, 'sentitems');
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
  });

  it('accepts a message that left the draft folder for somewhere else when Sent Items holds it by internet message id', async () => {
    const env = await freshEnv();
    const intentId = await unknownThatWasSent(env, 'Uma2');
    const draftId = savedOf(env, intentId).provider_draft_id!;
    const header = savedOf(env, intentId).message_id_header!;
    // The original was dragged away, and Sent Items keeps a copy under another id.
    const copy = { ...ms.state.messages[draftId]!, id: 'AAMk-sent-copy', folder: 'sentitems' as const, internetMessageId: header };
    ms.state.messages[copy.id] = copy;
    ms.moveMessage(draftId, 'deleteditems');
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(intentOf(env, intentId)).toMatchObject({ status: 'accepted', providerMessageId: header });
  });

  it('accepts a message in Outbox, and resolves each folder id once per adapter', async () => {
    const env = await freshEnv();
    const intentId = await unknownThatWasSent(env, 'Vern');
    const draftId = savedOf(env, intentId).provider_draft_id!;
    const saved = savedOf(env, intentId);
    ms.moveMessage(draftId, 'outbox');
    const adapter = createMailAdapter(env.ctx, 'microsoft')!;
    const intent: MailIntent = { intentId, accountId: stubMicrosoftAddress, fromAddress: stubMicrosoftAddress, to: realAddress, subject: 'x', body: 'y', messageIdHeader: saved.message_id_header, providerDraftId: draftId, replyTo: null };
    expect((await adapter.provider.reconcileUnknown(intent)).outcome).toBe('accepted');
    ms.moveMessage(draftId, 'sentitems');
    expect((await adapter.provider.reconcileUnknown(intent)).outcome).toBe('accepted');
    const folderReads = (name: string) => ms.state.requests.filter((request) => request.path === `/v1.0/me/mailFolders/${name}`);
    expect(folderReads('sentitems')).toHaveLength(1);
    expect(folderReads('outbox')).toHaveLength(1);
  });

  it('never accepts on isDraft false alone: a message in an unknown folder is not accepted', async () => {
    const env = await freshEnv();
    const intentId = await unknownThatWasSent(env, 'Wynn');
    const draftId = savedOf(env, intentId).provider_draft_id!;
    ms.moveMessage(draftId, 'inbox');
    ms.state.messages[draftId]!.internetMessageId = '<something-else@x.invalid>';
    // Sent Items has no message with the saved id either.
    const sentCopy = ms.state.sent[0]!;
    expect(sentCopy.id).toBe(draftId);
    env.advance(pastTheWait);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('unknown');
  });
});

describe('a check already running for an intent is not started twice', () => {
  it('lets the second caller return at once, so the draft is read once', async () => {
    const env = await freshEnv();
    const intentId = await unknownThatWasSent(env, 'Xena');
    const draftId = savedOf(env, intentId).provider_draft_id!;
    env.advance(pastTheWait);
    const payload = { intentId, attempt: 0, workspaceId: env.workspaceId };
    await Promise.all([reconcileIntent(env.ctx, payload), reconcileIntent(env.ctx, payload)]);
    const reads = ms.state.requests.filter((request) => request.method === 'GET' && request.path === `/v1.0/me/messages/${draftId}`);
    expect(reads).toHaveLength(1);
    expect(statusOf(env, intentId)).toBe('accepted');
    // The intent is free again afterwards.
    await reconcileIntent(env.ctx, payload);
    expect(ms.state.sendAttempts).toHaveLength(1);
  });
});
