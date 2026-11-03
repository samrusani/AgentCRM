import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { disconnectImapConnector, markImapError, reconcileIntent, recoverSubmittingIntents } from '../src/actions/index.js';
import { createMailAdapter } from '../src/actions/mailProviders.js';
import { staleSubmittingMilliseconds } from '../src/actions/sendIntents.js';
import { mailReconcileDelays } from '../src/config.js';
import { imapCheckWindowEndedSentence } from '../src/mail/rules.js';
import { generateMessageIdHeader } from '../src/providers/gmail.js';
import { headerValue, parseMime, decodePartText } from '../src/providers/mime.js';
import { getConnector } from '../src/queries/connectors.js';
import { processMailJobs } from '../src/jobs/worker.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';
import { addDraft, addPerson, approve, connectImap, drain, intentOf, queueOne, stage, statusOf } from './mailHelpers.js';
import { type FakeMailTransport, stubImapAddress, useMailTransportStub } from './mailTransportStub.js';

let stub: FakeMailTransport;
let restore: () => void;
const environments: TestEnvironment[] = [];

beforeAll(() => {
  ({ stub, restore } = useMailTransportStub());
});

afterEach(() => {
  stub.reset();
});

afterAll(() => {
  restore();
  for (const env of environments) env.cleanup();
});

async function freshEnv(connectInput: Record<string, unknown> = {}): Promise<TestEnvironment> {
  const env = createTestEnvironment();
  environments.push(env);
  await connectImap(env, connectInput);
  return env;
}

function headerOf(env: TestEnvironment, intentId: string): string | null {
  return (env.db.prepare('SELECT message_id_header FROM send_intent WHERE id = ?').get(intentId) as { message_id_header: string | null }).message_id_header;
}

function auditActions(env: TestEnvironment, intentId: string): string[] {
  return (env.db.prepare("SELECT action FROM audit_event WHERE entity_type = 'send_intent' AND entity_id = ? ORDER BY rowid").all(intentId) as { action: string }[]).map((row) => row.action);
}

function taskCount(env: TestEnvironment, name: string): number {
  return (env.db.prepare('SELECT COUNT(*) AS n FROM task WHERE title = ? AND status = ?').get(`Check whether the email to ${name} Testwell was sent`, 'open') as { n: number }).n;
}

const hour = 3_600_000;
const realAddress = 'maren.testwell@lanternrow.invalid';

describe('imap send lifecycle', () => {
  it('stages under the imap provider, sends once after approval, and appends the exact bytes to Sent', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Maren', realAddress);
    const staged = stage(env, [addDraft(env, person.id, 'Seed round intro', 'Hello Maren,\n\nA short note.\n\nThanks')]);
    const payload = staged.approval!.payload as any;
    expect(payload.mailProvider).toBe('imap');
    expect(payload.inboxEmail).toBe(stubImapAddress);
    expect(payload.messages[0]).toMatchObject({ provider: 'imap', inboxEmail: stubImapAddress, to: realAddress });
    expect(staged.intents[0]).toMatchObject({ provider: 'imap', inboxId: stubImapAddress, status: 'awaiting_approval' });
    expect(headerOf(env, staged.intents[0]!.id)).toBeNull();

    await drain(env);
    expect(stub.sendCalls).toHaveLength(0);
    approve(env, staged.approval!.id);
    await drain(env);

    expect(stub.sendCalls).toHaveLength(1);
    const call = stub.sendCalls[0]!;
    const intent = intentOf(env, staged.intents[0]!.id);
    const header = headerOf(env, intent.id)!;
    expect(header).toMatch(new RegExp(`^<ac-${intent.id}-[0-9a-f]{12}@imap-stub\\.invalid>$`));
    expect(intent).toMatchObject({ status: 'accepted', providerMessageId: header, providerThreadId: header });
    expect(call.envelopeFrom).toBe(stubImapAddress);
    expect(call.envelopeTo).toEqual([realAddress]);
    expect(call.messageId).toBe(header);

    const top = parseMime(call.raw);
    expect(headerValue(top, 'from')).toBe(stubImapAddress);
    expect(headerValue(top, 'to')).toBe(realAddress);
    expect(headerValue(top, 'subject')).toBe('Seed round intro');
    expect(headerValue(top, 'message-id')).toBe(header);
    expect(decodePartText(top)).toBe('Hello Maren,\r\n\r\nA short note.\r\n\r\nThanks');

    // The same bytes went to the Sent mailbox, and the intent says a provider side copy could duplicate it.
    expect(stub.appendCalls).toHaveLength(1);
    expect(stub.appendCalls[0]!.equals(call.raw)).toBe(true);
    expect(stub.sent).toHaveLength(1);
    const activity = env.db.prepare("SELECT body FROM activity WHERE kind = 'email_out'").get() as { body: string };
    expect(activity.body.split('\n')[0]).toBe('Sent (provider accepted). Delivery is not confirmed.');
    expect(activity.body).toContain('Sent may show this message twice');
    expect(auditActions(env, intent.id)).toEqual(['send_intent.create', 'send_intent.queue', 'send_intent.submit_start', 'send_intent.accepted']);
    expect(env.db.prepare('SELECT send_attempted_at FROM send_intent WHERE id = ?').get(intent.id)).not.toEqual({ send_attempted_at: null });
  });

  it('saves the Message-ID and stamps the attempt before the SMTP session opens', async () => {
    const env = await freshEnv();
    const seen: { status: string; saved: string | null; stamped: string | null; sent: string }[] = [];
    stub.onSend = (message) => {
      const row = env.db.prepare("SELECT status, message_id_header, send_attempted_at FROM send_intent WHERE status = 'submitting'").get() as
        | { status: string; message_id_header: string | null; send_attempted_at: string | null }
        | undefined;
      seen.push({ status: row?.status ?? 'none', saved: row?.message_id_header ?? null, stamped: row?.send_attempted_at ?? null, sent: headerValue(parseMime(message.raw), 'message-id') ?? '' });
    };
    const intentId = queueOne(env, 'Hal', realAddress);
    await drain(env);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe('submitting');
    expect(seen[0]!.saved).not.toBeNull();
    expect(seen[0]!.saved).toBe(seen[0]!.sent);
    expect(seen[0]!.stamped).not.toBeNull();
    expect(headerOf(env, intentId)).toBe(seen[0]!.saved);
  });

  it('runs the recheck between the claim and the send, and sends nothing when it fails', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Sue', realAddress);
    const staged = stage(env, [addDraft(env, person.id, 'Hello Sue', 'Body')]);
    approve(env, staged.approval!.id);
    const intentId = staged.intents[0]!.id;
    // The suppression appears after the claim's own recheck passed and before the SMTP session would open.
    const realNow = env.ctx.now;
    let armed = true;
    env.ctx.now = () => {
      if (armed) {
        const row = env.db.prepare("SELECT 1 AS yes FROM send_intent WHERE id = ? AND status = 'submitting' AND send_attempted_at IS NULL").get(intentId);
        if (row) {
          armed = false;
          env.db
            .prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES ('sup_late', ?, ?, ?, 'manual', 'test')")
            .run('2026-03-01T09:00:00.000Z', env.workspaceId, realAddress);
        }
      }
      return realNow();
    };
    try {
      await drain(env);
    } finally {
      env.ctx.now = realNow;
    }
    expect(armed).toBe(false);
    expect(stub.sendCalls).toHaveLength(0);
    expect(intentOf(env, intentId)).toMatchObject({ status: 'blocked', error: 'suppressed' });
    expect(auditActions(env, intentId)).toContain('send_intent.block');
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile'").get()).toEqual({ n: 0 });
  });

  it('never sends the same intent twice, even with repeated ticks and a forced re-queue', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Ida', realAddress);
    await Promise.all([processMailJobs(env.ctx), processMailJobs(env.ctx), processMailJobs(env.ctx)]);
    for (let round = 0; round < 3; round += 1) await processMailJobs(env.ctx);
    expect(stub.sendCalls).toHaveLength(1);
    env.db.prepare("UPDATE send_intent SET status = 'queued' WHERE id = ?").run(intentId);
    await drain(env);
    // The intent already has a provider message id, so the recheck refuses it.
    expect(stub.sendCalls).toHaveLength(1);
  });

  it('skips the Sent copy with a note when the server says it saves its own', async () => {
    const env = await freshEnv();
    // The capability is stored with the connector by the next check.
    stub.knobs.reportsStoredCopy = true;
    await connectImap(env);
    queueOne(env, 'Kit', realAddress);
    await drain(env);
    expect(stub.appendCalls).toHaveLength(0);
    const activity = env.db.prepare("SELECT body FROM activity WHERE kind = 'email_out'").get() as { body: string };
    expect(activity.body).toContain('saves its own copy of sent mail, so no copy was added');
  });

  it('adds the Sent copy without the duplicate warning when the server is known not to save one', async () => {
    const env = await freshEnv();
    stub.knobs.reportsStoredCopy = false;
    await connectImap(env);
    queueOne(env, 'Lou', realAddress);
    await drain(env);
    expect(stub.appendCalls).toHaveLength(1);
    const activity = env.db.prepare("SELECT body FROM activity WHERE kind = 'email_out'").get() as { body: string };
    expect(activity.body).not.toContain('twice');
  });

  it('stays accepted when the Sent copy cannot be saved, and says so', async () => {
    const env = await freshEnv();
    stub.knobs.appendFailure = 'Mailbox over quota.';
    const intentId = queueOne(env, 'Moe', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(stub.sendCalls).toHaveLength(1);
    const activity = env.db.prepare("SELECT body FROM activity WHERE kind = 'email_out'").get() as { body: string };
    expect(activity.body).toContain('A copy could not be added to the Sent mailbox: Mailbox over quota.');
  });

  it('sends a non-ASCII message intact', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Zoë', realAddress);
    const staged = stage(env, [addDraft(env, person.id, 'Café plans, naïve ☕', 'Hi Zoë,\n\nÜber nice to meet you ✓')]);
    approve(env, staged.approval!.id);
    await drain(env);
    const top = parseMime(stub.sendCalls[0]!.raw);
    expect(decodePartText(top)).toBe('Hi Zoë,\r\n\r\nÜber nice to meet you ✓');
  });
});

describe('imap definitive failures', () => {
  it('fails the intent with the server sentence on a 5xx reply, sends once, and never retries', async () => {
    const env = await freshEnv();
    stub.sendScript.push({ type: 'reject', code: 550, text: '5.1.1 Mailbox unavailable' });
    const intentId = queueOne(env, 'Nia', realAddress);
    await drain(env);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('failed');
    expect(intent.error).toContain('The mail server refused the message: 550 5.1.1 Mailbox unavailable');
    expect(stub.sendCalls).toHaveLength(1);
    expect(stub.appendCalls).toHaveLength(0);
    env.advance(hour);
    await drain(env);
    expect(stub.sendCalls).toHaveLength(1);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile'").get()).toEqual({ n: 0 });
  });

  it('fails the intent, not unknown, when nothing left the process', async () => {
    const env = await freshEnv();
    stub.sendScript.push({ type: 'not_sent', text: 'Could not connect to smtp.fastmail.com.' });
    const intentId = queueOne(env, 'Oli', realAddress);
    await drain(env);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('failed');
    expect(intent.error).toContain('Could not connect to smtp.fastmail.com. The message was not sent.');
  });
});

describe('imap unknown outcomes and the read only check', () => {
  it('turns a lost connection into unknown, then finds the Sent copy without sending again', async () => {
    const env = await freshEnv();
    stub.knobs.sentAutoSave = true;
    stub.sendScript.push({ type: 'ambiguous', accepted: true });
    const intentId = queueOne(env, 'Jay', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(intentOf(env, intentId).error).toMatch(/may or may not have been sent/);
    // An ambiguous outcome never appends: only an accepted one does.
    expect(stub.appendCalls).toHaveLength(0);

    env.advance(1500);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    expect(intent).toMatchObject({ status: 'accepted', providerMessageId: headerOf(env, intentId) });
    expect(stub.sendCalls).toHaveLength(1);
    expect(stub.searchCalls).toEqual([headerOf(env, intentId)]);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'email_out'").get()).toEqual({ n: 1 });
  });

  it('keeps an intent unknown while the Sent mailbox shows nothing, never sends, and stops after the six check schedule with a task', async () => {
    const env = await freshEnv();
    // The server kept the message, but it does not save a Sent copy, so the search cannot tell.
    stub.sendScript.push({ type: 'ambiguous', accepted: true });
    const intentId = queueOne(env, 'Lee', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    for (let round = 0; round < 6; round += 1) {
      env.advance(1500);
      await processMailJobs(env.ctx);
      expect(statusOf(env, intentId)).toBe('unknown');
    }
    const intent = intentOf(env, intentId);
    expect(intent.error).toMatch(/Still unknown after 6 checks/);
    expect(intent.error).toMatch(/webmail/);
    expect(stub.sendCalls).toHaveLength(1);
    expect(stub.delivered).toHaveLength(1);
    expect(stub.searchCalls).toHaveLength(6);
    expect(taskCount(env, 'Lee')).toBe(1);
    for (let round = 0; round < 4; round += 1) {
      env.advance(700_000);
      await processMailJobs(env.ctx);
    }
    expect(stub.sendCalls).toHaveLength(1);
    expect(stub.searchCalls).toHaveLength(6);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status != 'done'").get()).toEqual({ n: 0 });
  });

  it('handles a lost connection where the server kept nothing the same way: unknown, never resent', async () => {
    const env = await freshEnv();
    stub.sendScript.push({ type: 'ambiguous', accepted: false, text: 'The connection timed out waiting for the server.' });
    const intentId = queueOne(env, 'Mia', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(intentOf(env, intentId).error).toContain('timed out');
    for (let round = 0; round < 3; round += 1) {
      env.advance(1500);
      await processMailJobs(env.ctx);
    }
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(stub.sendCalls).toHaveLength(1);
  });

  it('makes no call after the checking window and leaves the intent unknown with a task', async () => {
    const env = await freshEnv();
    stub.sendScript.push({ type: 'ambiguous', accepted: false });
    const intentId = queueOne(env, 'Max', realAddress);
    await drain(env);
    const before = stub.searchCalls.length;
    env.advance(25 * hour);
    await processMailJobs(env.ctx);
    await processMailJobs(env.ctx);
    expect(stub.searchCalls.length).toBe(before);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toContain(imapCheckWindowEndedSentence);
    expect(taskCount(env, 'Max')).toBe(1);
    await reconcileIntent(env.ctx, { intentId, attempt: 1, workspaceId: env.workspaceId });
    expect(taskCount(env, 'Max')).toBe(1);
    expect(stub.sendCalls).toHaveLength(1);
  });

  it('reports an unavailable check as unavailable, never as not found, and never sends', async () => {
    const env = await freshEnv();
    stub.knobs.searchFailure = 'The IMAP server did not answer in time.';
    const intentId = queueOne(env, 'Pam', realAddress);
    const header = generateMessageIdHeader(intentId, stubImapAddress);
    const adapter = createMailAdapter(env.ctx, 'imap')!;
    const result = await adapter.provider.reconcileUnknown({
      intentId,
      accountId: stubImapAddress,
      fromAddress: stubImapAddress,
      to: realAddress,
      subject: 'x',
      body: 'y',
      messageIdHeader: header,
      replyTo: null,
    });
    expect(result.outcome).toBe('unavailable');
    expect(stub.sendCalls).toHaveLength(0);
    expect(stub.appendCalls).toHaveLength(0);
  });

  it('keeps the intent unknown and retries when the check fails, without sending', async () => {
    const env = await freshEnv();
    stub.sendScript.push({ type: 'ambiguous', accepted: true });
    stub.knobs.sentAutoSave = true;
    const intentId = queueOne(env, 'Quin', realAddress);
    await drain(env);
    stub.knobs.searchFailure = 'Could not reach the IMAP server.';
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('unknown');
    stub.knobs.searchFailure = null;
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(stub.sendCalls).toHaveLength(1);
  });

  it('turns an interrupted submit into unknown on restart, and a search resolves it without sending', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Nan', realAddress);
    const header = generateMessageIdHeader(intentId, stubImapAddress);
    env.db.prepare("UPDATE send_intent SET status = 'submitting', submitted_at = ?, message_id_header = ? WHERE id = ?").run(env.ctx.now(), header, intentId);
    expect(recoverSubmittingIntents(env.ctx)).toBe(1);
    expect(statusOf(env, intentId)).toBe('unknown');
    // The process died after the server accepted the message, and the server saved a Sent copy.
    stub.sent.push({
      uid: 1,
      internalDate: env.ctx.now(),
      raw: Buffer.from(`From: ${stubImapAddress}\r\nTo: ${realAddress}\r\nSubject: Hello Nan\r\nMessage-ID: ${header}\r\n\r\nBody\r\n`),
    });
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(stub.sendCalls).toHaveLength(0);
  });

  it('a reconcile makes only read calls: no SMTP session, no append', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Ode', realAddress);
    const header = generateMessageIdHeader(intentId, stubImapAddress);
    const adapter = createMailAdapter(env.ctx, 'imap')!;
    const result = await adapter.provider.reconcileUnknown({
      intentId,
      accountId: stubImapAddress,
      fromAddress: stubImapAddress,
      to: realAddress,
      subject: 'x',
      body: 'y',
      messageIdHeader: header,
      replyTo: null,
    });
    expect(result.outcome).toBe('not_found');
    expect(stub.searchCalls).toEqual([header]);
    expect(stub.sendCalls).toHaveLength(0);
    expect(stub.appendCalls).toHaveLength(0);
  });

  it('refuses to send without a saved Message-ID or without the last check', async () => {
    const env = await freshEnv();
    const adapter = createMailAdapter(env.ctx, 'imap')!;
    const intent = {
      intentId: 'snd_x',
      accountId: stubImapAddress,
      fromAddress: stubImapAddress,
      to: realAddress,
      subject: 's',
      body: 'b',
      messageIdHeader: '<ac-x@imap-stub.invalid>',
      replyTo: null,
    };
    await expect(adapter.provider.submit({ ...intent, messageIdHeader: null }, { beforeSend: () => null })).rejects.toMatchObject({ definitive: true });
    await expect(adapter.provider.submit(intent)).rejects.toMatchObject({ definitive: true });
    await expect(adapter.provider.submit(intent, { beforeSend: () => 'suppressed' })).rejects.toMatchObject({ definitive: true });
    expect(stub.sendCalls).toHaveLength(0);
  });
});

describe('an unknown message whose check cannot run', () => {
  async function unknownThatWasSent(env: TestEnvironment, name: string, email = realAddress): Promise<string> {
    stub.knobs.sentAutoSave = true;
    stub.sendScript.push({ type: 'ambiguous', accepted: true });
    const intentId = queueOne(env, name, email);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    return intentId;
  }

  it('gets the task at once, only once, when the saved login stops working, and resumes after reconnecting', async () => {
    const env = await freshEnv();
    const intentId = await unknownThatWasSent(env, 'Una');
    markImapError(env.ctx);
    env.advance(1500);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toMatch(/Checking again stopped/);
    expect(taskCount(env, 'Una')).toBe(1);
    expect(stub.searchCalls).toHaveLength(0);

    await connectImap(env);
    expect(getConnector(env.db, env.workspaceId, 'imap')!.status).toBe('connected');
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(stub.sendCalls).toHaveLength(1);
  });

  it('does the same when the connector was removed', async () => {
    const env = await freshEnv();
    const intentId = await unknownThatWasSent(env, 'Vic');
    disconnectImapConnector(env.ctx);
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(intentOf(env, intentId).error).toContain('connector was removed');
    expect(taskCount(env, 'Vic')).toBe(1);
    expect(stub.sendCalls).toHaveLength(1);
  });

  it('resumes the read only check when the same account is connected again after a removal', async () => {
    const env = await freshEnv();
    const intentId = await unknownThatWasSent(env, 'Wen');
    disconnectImapConnector(env.ctx);
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('unknown');

    await connectImap(env);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    // Found by the search in the Sent mailbox, never by sending again.
    expect(stub.sendCalls).toHaveLength(1);
  });

  it('treats a temporary SMTP login refusal as a plain failure, not a rejected login', async () => {
    const env = await freshEnv();
    stub.sendScript.push({ type: 'not_sent', text: '454 4.7.0 Temporary authentication failure', kind: 'auth', code: 454 });
    const intentId = queueOne(env, 'Xia', 'xia@sandworks-demo.invalid');
    await drain(env);
    expect(statusOf(env, intentId)).toBe('failed');
    // One temporary server condition must not lock the whole connector.
    expect(getConnector(env.db, env.workspaceId, 'imap')!.status).toBe('connected');
  });
});

describe('the imap reconcile schedule and the stale submit limit', () => {
  it('uses the day long list', () => {
    const saved = process.env.AGENTCRM_MAIL_RECONCILE_MS;
    delete process.env.AGENTCRM_MAIL_RECONCILE_MS;
    try {
      expect(mailReconcileDelays('imap')).toEqual([30_000, 120_000, 600_000, 3_600_000, 21_600_000, 79_200_000]);
      expect(mailReconcileDelays('imap')).toEqual(mailReconcileDelays('gmail'));
    } finally {
      if (saved === undefined) delete process.env.AGENTCRM_MAIL_RECONCILE_MS;
      else process.env.AGENTCRM_MAIL_RECONCILE_MS = saved;
    }
  });

  it('lets a submit last as long as the IMAP deadlines can', () => {
    const saved = { imap: process.env.AGENTCRM_IMAP_TIMEOUT_MS, microsoft: process.env.AGENTCRM_MS_TIMEOUT_MS, gmail: process.env.AGENTCRM_GMAIL_TIMEOUT_MS };
    process.env.AGENTCRM_MS_TIMEOUT_MS = '1000';
    process.env.AGENTCRM_GMAIL_TIMEOUT_MS = '1000';
    process.env.AGENTCRM_IMAP_TIMEOUT_MS = '30000';
    try {
      // Five steps for the send and five for the Sent copy, plus the margin.
      expect(staleSubmittingMilliseconds()).toBe(30_000 * 10 + 30_000);
    } finally {
      for (const [key, value] of [['AGENTCRM_IMAP_TIMEOUT_MS', saved.imap], ['AGENTCRM_MS_TIMEOUT_MS', saved.microsoft], ['AGENTCRM_GMAIL_TIMEOUT_MS', saved.gmail]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
