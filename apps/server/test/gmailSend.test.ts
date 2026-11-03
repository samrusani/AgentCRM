import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  controlSendIntent,
  disconnectGmailConnector,
  markGmailError,
  reconcileIntent,
  recoverSubmittingIntents,
} from '../src/actions/index.js';
import { staleSubmittingMilliseconds } from '../src/actions/sendIntents.js';
import { mailReconcileDelays } from '../src/config.js';
import { createMailAdapter } from '../src/actions/mailProviders.js';
import { processMailJobs } from '../src/jobs/worker.js';
import { composeRawMessage, encodeSubject, generateMessageIdHeader } from '../src/providers/gmail.js';
import { getConnector, getGmailInternals } from '../src/queries/connectors.js';
import { type GoogleStub, startGoogleStub, stubGmailAddress, stubGoogleClientId, useGoogleStub } from './googleStub.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';
import { addDraft, addPerson, approve, connectGmail, drain, intentOf, queueOne, stage, statusOf } from './mailHelpers.js';

let google: GoogleStub;
let restore: () => void;
const environments: TestEnvironment[] = [];

beforeAll(async () => {
  google = await startGoogleStub();
  restore = useGoogleStub(google);
});

afterEach(() => {
  google.reset();
});

afterAll(async () => {
  await google.close();
  restore();
  for (const env of environments) env.cleanup();
});

async function freshEnv(): Promise<TestEnvironment> {
  const env = createTestEnvironment();
  environments.push(env);
  await connectGmail(env, google);
  return env;
}

function headerOf(env: TestEnvironment, intentId: string): string | null {
  return (env.db.prepare('SELECT message_id_header FROM send_intent WHERE id = ?').get(intentId) as { message_id_header: string | null }).message_id_header;
}

const hour = 3_600_000;
const realAddress = 'maren.testwell@lanternrow.invalid';

describe('gmail send lifecycle', () => {
  it('stages with the gmail connector in use, sends after approval, and records ids and an activity', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Maren', realAddress);
    const staged = stage(env, [addDraft(env, person.id, 'Seed round intro', 'Hello Maren,\n\nA short note.\n\nThanks')]);
    expect(staged.approval!.kind).toBe('send_review');
    const payload = staged.approval!.payload as any;
    expect(payload.mailProvider).toBe('gmail');
    expect(payload.inboxEmail).toBe(stubGmailAddress);
    expect(payload.messages[0]).toMatchObject({ provider: 'gmail', inboxEmail: stubGmailAddress, to: realAddress });
    expect(staged.intents[0]).toMatchObject({ provider: 'gmail', inboxId: stubGmailAddress, status: 'awaiting_approval' });
    expect(headerOf(env, staged.intents[0]!.id)).toBeNull();

    await drain(env);
    expect(google.state.sendAttempts).toHaveLength(0);

    approve(env, staged.approval!.id);
    expect(statusOf(env, staged.intents[0]!.id)).toBe('queued');
    await drain(env);

    expect(google.state.sent).toHaveLength(1);
    const sent = google.state.sent[0]!;
    const intent = intentOf(env, staged.intents[0]!.id);
    expect(intent.status).toBe('accepted');
    expect(intent.providerMessageId).toBe(sent.id);
    expect(intent.providerThreadId).toBe(sent.threadId);
    expect(sent.from).toBe(stubGmailAddress);
    expect(sent.to).toBe(realAddress);
    expect(sent.subject).toBe('Seed round intro');
    expect(sent.text).toBe('Hello Maren,\n\nA short note.\n\nThanks'.replace(/\n/g, '\r\n'));
    expect(sent.headers['mime-version']).toBe('1.0');
    expect(sent.headers['content-type']).toBe('text/plain; charset="UTF-8"');
    expect(sent.headers['in-reply-to']).toBeUndefined();
    expect(sent.requestedThreadId).toBeNull();
    expect(sent.messageIdHeader).toBe(headerOf(env, intent.id));
    expect(sent.messageIdHeader).toMatch(new RegExp(`^<ac-${intent.id}-[0-9a-f]{12}@gmail-stub\\.invalid>$`));
    expect(Date.parse(sent.headers.date!)).not.toBeNaN();

    const activity = env.db.prepare("SELECT body FROM activity WHERE kind = 'email_out'").get() as { body: string };
    expect(activity.body.split('\n')[0]).toBe('Sent (provider accepted). Delivery is not confirmed.');
    const audits = env.db.prepare("SELECT action FROM audit_event WHERE entity_type = 'send_intent' AND entity_id = ? ORDER BY rowid").all(intent.id) as { action: string }[];
    expect(audits.map((row) => row.action)).toEqual(['send_intent.create', 'send_intent.queue', 'send_intent.submit_start', 'send_intent.accepted']);
  });

  it('saves the Message-ID before the request leaves the process', async () => {
    const env = await freshEnv();
    const seen: { status: string; saved: string | null; sent: string | undefined }[] = [];
    google.state.onSend = ({ headers }) => {
      const row = env.db.prepare("SELECT status, message_id_header FROM send_intent WHERE status = 'submitting'").get() as
        | { status: string; message_id_header: string | null }
        | undefined;
      seen.push({ status: row?.status ?? 'none', saved: row?.message_id_header ?? null, sent: headers['message-id'] });
    };
    const intentId = queueOne(env, 'Hal', realAddress);
    await drain(env);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe('submitting');
    expect(seen[0]!.saved).not.toBeNull();
    expect(seen[0]!.saved).toBe(seen[0]!.sent);
    expect(headerOf(env, intentId)).toBe(seen[0]!.saved);
  });

  it('never sends the same intent twice, even with repeated ticks and a forced re-queue', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Ida', realAddress);
    await Promise.all([processMailJobs(env.ctx), processMailJobs(env.ctx), processMailJobs(env.ctx)]);
    for (let round = 0; round < 3; round += 1) await processMailJobs(env.ctx);
    expect(google.state.sent).toHaveLength(1);
    env.db.prepare("UPDATE send_intent SET status = 'queued' WHERE id = ?").run(intentId);
    await drain(env);
    expect(google.state.sent).toHaveLength(1);
    expect(google.state.sendAttempts).toHaveLength(1);
  });

  it('turns a timeout into unknown, then finds the message by its Message-ID without sending again', async () => {
    const env = await freshEnv();
    google.state.sendScript.push({ type: 'process_then_delay', delayMs: 1500 });
    const intentId = queueOne(env, 'Jay', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    expect(intentOf(env, intentId).error).toMatch(/may or may not have been sent/);
    expect(google.state.sent).toHaveLength(1);

    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('unknown');

    env.advance(1500);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('accepted');
    expect(intent.providerMessageId).toBe(google.state.sent[0]!.id);
    expect(intent.providerThreadId).toBe(google.state.sent[0]!.threadId);
    expect(google.state.sent).toHaveLength(1);
    expect(google.state.sendAttempts).toHaveLength(1);

    const searches = google.state.requests.filter((request) => request.path.endsWith('/messages') && request.method === 'GET');
    expect(searches).toHaveLength(1);
    expect(searches[0]!.query.q).toBe(`rfc822msgid:${headerOf(env, intentId)}`);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'email_out'").get()).toEqual({ n: 1 });
  });

  it('fetches the thread id with a minimal read when the search result lacks it', async () => {
    const env = await freshEnv();
    google.state.sendScript.push({ type: 'process_then_respond', status: 502 });
    google.state.omitThreadIdInList = true;
    const intentId = queueOne(env, 'Kay', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(intentOf(env, intentId)).toMatchObject({ status: 'accepted', providerMessageId: google.state.sent[0]!.id, providerThreadId: google.state.sent[0]!.threadId });
    const minimal = google.state.requests.filter((request) => request.method === 'GET' && request.query.format === 'minimal');
    expect(minimal).toHaveLength(1);
    expect(google.state.sendAttempts).toHaveLength(1);
  });

  it('keeps an unknown intent unknown while the message is not found, never sends, and stops after the six check schedule with a task', async () => {
    const env = await freshEnv();
    // The first request fails before Gmail does anything, so the search finds nothing.
    google.state.sendScript.push({ type: 'respond', status: 503 });
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
    expect(intent.error).toMatch(/Gmail/);
    expect(google.state.sendAttempts).toHaveLength(1);
    expect(google.state.sent).toHaveLength(0);
    const task = env.db.prepare("SELECT title FROM task WHERE title LIKE 'Check whether the email%'").get() as { title: string };
    expect(task.title).toBe('Check whether the email to Lee Testwell was sent');
    for (let round = 0; round < 4; round += 1) {
      env.advance(700_000);
      await processMailJobs(env.ctx);
    }
    expect(google.state.sendAttempts).toHaveLength(1);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status != 'done'").get()).toEqual({ n: 0 });
  });

  it('makes no call after the checking window and leaves the intent unknown with a task', async () => {
    const env = await freshEnv();
    google.state.sendScript.push({ type: 'respond', status: 500 });
    const intentId = queueOne(env, 'Max', realAddress);
    await drain(env);
    const before = google.state.requests.length;
    env.advance(25 * hour);
    await processMailJobs(env.ctx);
    await processMailJobs(env.ctx);
    expect(google.state.requests.length).toBe(before);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toContain("This message was not found in Gmail within a day, so the app stopped checking. Check Gmail's sent mail.");
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM task WHERE title = 'Check whether the email to Max Testwell was sent' AND status = 'open'").get()).toEqual({ n: 1 });
    const payload = { intentId, attempt: 1, workspaceId: env.workspaceId };
    await reconcileIntent(env.ctx, payload);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM task WHERE title LIKE 'Check whether the email to Max%'").get()).toEqual({ n: 1 });
    expect(google.state.sendAttempts).toHaveLength(1);
  });

  it('turns an interrupted submit into unknown on restart, and a search resolves it without sending', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Nan', realAddress);
    const header = generateMessageIdHeader(intentId, stubGmailAddress);
    env.db.prepare("UPDATE send_intent SET status = 'submitting', submitted_at = ?, message_id_header = ? WHERE id = ?").run(env.ctx.now(), header, intentId);
    expect(recoverSubmittingIntents(env.ctx)).toBe(1);
    expect(statusOf(env, intentId)).toBe('unknown');
    // The process died after the request was accepted: the message exists in Gmail with that header.
    google.addInbound({ from: stubGmailAddress, to: realAddress, messageId: header, labelIds: ['SENT'], skipHistory: true });
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(google.state.sendAttempts).toHaveLength(0);
  });

  it('refuses to reconcile through the send endpoint: a reconcile makes only read requests', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Ode', realAddress);
    const header = generateMessageIdHeader(intentId, stubGmailAddress);
    env.db.prepare("UPDATE send_intent SET status = 'unknown', submitted_at = ?, message_id_header = ? WHERE id = ?").run(env.ctx.now(), header, intentId);
    const before = google.state.requests.length;
    const adapter = createMailAdapter(env.ctx, 'gmail')!;
    const result = await adapter.provider.reconcileUnknown({
      intentId,
      accountId: stubGmailAddress,
      fromAddress: stubGmailAddress,
      to: realAddress,
      subject: 'x',
      body: 'y',
      messageIdHeader: header,
      replyTo: null,
    });
    expect(result.outcome).toBe('not_found');
    const made = google.state.requests.slice(before);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((request) => request.method === 'GET')).toBe(true);
    expect(made.some((request) => request.path.endsWith('/messages/send'))).toBe(false);
    expect(google.state.sendAttempts).toHaveLength(0);
  });

  it('reports an unavailable check as unavailable, never as not found, and never sends', async () => {
    const env = await freshEnv();
    const intentId = queueOne(env, 'Pam', realAddress);
    const header = generateMessageIdHeader(intentId, stubGmailAddress);
    google.state.listStatus = 503;
    const adapter = createMailAdapter(env.ctx, 'gmail')!;
    const result = await adapter.provider.reconcileUnknown({
      intentId,
      accountId: stubGmailAddress,
      fromAddress: stubGmailAddress,
      to: realAddress,
      subject: 'x',
      body: 'y',
      messageIdHeader: header,
      replyTo: null,
    });
    expect(result.outcome).toBe('unavailable');
    expect(google.state.sendAttempts).toHaveLength(0);
  });
});

describe('gmail definitive refusals and tokens', () => {
  it('fails an intent on a definitive refusal, scrubs tokens, and never retries', async () => {
    const env = await freshEnv();
    google.state.sendScript.push({ type: 'respond', status: 400, body: { error: { code: 400, message: 'Invalid To header', errors: [{ reason: 'invalidArgument' }] } } });
    const intentId = queueOne(env, 'Quin', realAddress);
    await drain(env);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('failed');
    expect(intent.error).toContain('HTTP 400');
    expect(intent.error).toContain('Invalid To header');
    env.advance(700_000);
    await drain(env);
    expect(google.state.sendAttempts).toHaveLength(1);
    expect(google.state.sent).toHaveLength(0);
  });

  it('treats a 403 on send as a refusal and a 429, a 5xx and an unreadable answer as unknown', async () => {
    const env = await freshEnv();
    google.state.sendScript.push(
      { type: 'respond', status: 403 },
      { type: 'respond', status: 429 },
      { type: 'respond', status: 500 },
      { type: 'process_then_garbage' },
    );
    const ids = ['Rue', 'Sal', 'Tia', 'Uma'].map((name) => queueOne(env, name, `${name.toLowerCase()}@lanternrow.invalid`));
    for (let round = 0; round < 8; round += 1) await processMailJobs(env.ctx);
    expect(ids.map((id) => statusOf(env, id))).toEqual(['failed', 'unknown', 'unknown', 'unknown']);
    expect(intentOf(env, ids[3]!).error).toMatch(/could not read|without a message id/i);
    // The garbage answer was processed, so the search resolves it. The others were not sent and stay unknown.
    env.advance(1500);
    await processMailJobs(env.ctx);
    await processMailJobs(env.ctx);
    expect(ids.map((id) => statusOf(env, id))).toEqual(['failed', 'unknown', 'unknown', 'accepted']);
    expect(google.state.sent).toHaveLength(1);
    expect(google.state.sendAttempts).toHaveLength(4);
  });

  it('refreshes the token once on a 401 and then sends exactly one message', async () => {
    const env = await freshEnv();
    const refreshesBefore = google.state.tokenRequests.filter((request) => request.grantType === 'refresh_token').length;
    google.state.sendScript.push({ type: 'respond', status: 401 });
    const intentId = queueOne(env, 'Val', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(google.state.sendAttempts).toHaveLength(2);
    expect(google.state.sent).toHaveLength(1);
    expect(google.state.tokenRequests.filter((request) => request.grantType === 'refresh_token').length - refreshesBefore).toBe(1);
    expect(google.state.sendAttempts[0]!.accessToken).not.toBe(google.state.sendAttempts[1]!.accessToken);
    expect(google.state.sendAttempts[0]!.raw).toBe(google.state.sendAttempts[1]!.raw);
  });

  it('fails the intent, without sending, when the second attempt is also refused with a 401', async () => {
    const env = await freshEnv();
    google.state.sendScript.push({ type: 'respond', status: 401 }, { type: 'respond', status: 401 });
    const intentId = queueOne(env, 'Wes', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('failed');
    expect(google.state.sent).toHaveLength(0);
    expect(google.state.sendAttempts).toHaveLength(2);
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.status).toBe('error');
  });

  it('refreshes ahead of use when less than two minutes are left, with one request for concurrent callers', async () => {
    const env = await freshEnv();
    const row = env.db.prepare("SELECT id, secret FROM connector WHERE kind = 'gmail'").get() as { id: string; secret: string };
    const soon = new Date(Date.parse(env.ctx.now()) + 90_000).toISOString();
    env.db.prepare('UPDATE connector SET secret = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.secret), expiresAt: soon }), row.id);
    const refreshes = () => google.state.tokenRequests.filter((request) => request.grantType === 'refresh_token').length;
    const before = refreshes();
    const adapter = createMailAdapter(env.ctx, 'gmail')!;
    const [first, second] = await Promise.all([adapter.provider.checkAccount(), adapter.provider.checkAccount()]);
    expect(first.address).toBe(stubGmailAddress);
    expect(second.address).toBe(stubGmailAddress);
    expect(refreshes() - before).toBe(1);
    // The new token is fresh, so the next call does not refresh again.
    await adapter.provider.checkAccount();
    expect(refreshes() - before).toBe(1);
    // A token with plenty of time left is not refreshed.
    const stored = JSON.parse((env.db.prepare("SELECT secret FROM connector WHERE kind = 'gmail'").get() as { secret: string }).secret);
    expect(Date.parse(stored.expiresAt) - Date.parse(env.ctx.now())).toBeGreaterThan(3_000_000);
  });

  it('marks the connector with the seven day sentence when Google answers invalid_grant, and sends nothing', async () => {
    const env = await freshEnv();
    const row = env.db.prepare("SELECT id, secret FROM connector WHERE kind = 'gmail'").get() as { id: string; secret: string };
    env.db
      .prepare('UPDATE connector SET secret = ? WHERE id = ?')
      .run(JSON.stringify({ ...JSON.parse(row.secret), expiresAt: new Date(Date.parse(env.ctx.now()) - 1000).toISOString() }), row.id);
    google.state.tokenMode = 'invalid_grant';
    const intentId = queueOne(env, 'Xia', realAddress);
    await drain(env);
    const connector = getConnector(env.db, env.workspaceId, 'gmail')!;
    expect(connector.status).toBe('error');
    expect(connector.statusMessage).toContain('Testing');
    expect(connector.statusMessage).toContain('seven days');
    expect(connector.statusMessage).toContain('sign in with Google again');
    expect(statusOf(env, intentId)).toBe('failed');
    expect(intentOf(env, intentId).error).toContain('The message was not sent.');
    expect(google.state.sendAttempts).toHaveLength(0);
    expect(JSON.stringify(connector)).not.toContain('ya29');
  });

  it('fails a send, rather than guessing, when Google cannot be reached for a token before the request', async () => {
    const env = await freshEnv();
    const row = env.db.prepare("SELECT id, secret FROM connector WHERE kind = 'gmail'").get() as { id: string; secret: string };
    env.db
      .prepare('UPDATE connector SET secret = ? WHERE id = ?')
      .run(JSON.stringify({ ...JSON.parse(row.secret), expiresAt: new Date(Date.parse(env.ctx.now()) - 1000).toISOString() }), row.id);
    google.state.tokenMode = 'unavailable';
    const intentId = queueOne(env, 'Yan', realAddress);
    await drain(env);
    expect(statusOf(env, intentId)).toBe('failed');
    expect(intentOf(env, intentId).error).toContain('not sent');
    expect(google.state.sendAttempts).toHaveLength(0);
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.status).toBe('connected');
  });
});

describe('composing a message', () => {
  const base = { from: 'a@gmail-stub.invalid', to: 'b@lanternrow.invalid', subject: 'Hello', body: 'Line one\nLine two', messageId: '<ac-snd_1-aa@gmail-stub.invalid>', date: new Date('2026-11-03T12:00:00Z') };

  it('writes the required headers with CRLF line ends and a base64 body', () => {
    const raw = composeRawMessage(base);
    const [head, body] = raw.split('\r\n\r\n');
    expect(head!.split('\r\n')).toEqual([
      'From: a@gmail-stub.invalid',
      'To: b@lanternrow.invalid',
      'Subject: Hello',
      'Date: Tue, 03 Nov 2026 12:00:00 GMT',
      'Message-ID: <ac-snd_1-aa@gmail-stub.invalid>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
    ]);
    expect(Buffer.from(body!.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Line one\r\nLine two');
  });

  it('adds In-Reply-To and References when replying in a known thread', () => {
    const raw = composeRawMessage({ ...base, replyTo: { inReplyTo: '<orig@x.invalid>', references: ['<first@x.invalid>'] } });
    expect(raw).toContain('In-Reply-To: <orig@x.invalid>\r\n');
    expect(raw).toContain('References: <first@x.invalid> <orig@x.invalid>\r\n');
  });

  it('encodes a non-ASCII subject as RFC 2047 words and keeps every line short', () => {
    const subject = 'Café meeting about the quarterly numbers and the very long plan for next year';
    const encoded = encodeSubject(subject);
    expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
    for (const line of encoded.split('\r\n')) expect(line.trim().length).toBeLessThanOrEqual(75);
    const decoded = encoded
      .split('\r\n')
      .map((word) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(word.trim())![1]!, 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe(subject);
    expect(encodeSubject('Plain subject')).toBe('Plain subject');
  });

  it('refuses a header with a line break, so nothing can be injected', () => {
    expect(() => composeRawMessage({ ...base, subject: 'Hi\r\nBcc: x@y.invalid' })).toThrowError(/line break/);
    expect(() => composeRawMessage({ ...base, to: 'b@x.invalid\nBcc: z@y.invalid' })).toThrowError(/line break/);
  });

  it('builds a Message-ID from the intent id and the sender domain, different every time', () => {
    const first = generateMessageIdHeader('snd_abc', 'me@example-sender.invalid');
    const second = generateMessageIdHeader('snd_abc', 'me@example-sender.invalid');
    expect(first).toMatch(/^<ac-snd_abc-[0-9a-f]{12}@example-sender\.invalid>$/);
    expect(first).not.toBe(second);
  });

  it('sends a non-ASCII message intact through the whole path', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Zoë', 'zoe@lanternrow.invalid');
    const staged = stage(env, [addDraft(env, person.id, 'Café plans', 'Grüße, 你好')]);
    approve(env, staged.approval!.id);
    await drain(env);
    expect(google.state.sent[0]!.subject).toBe('Café plans');
    expect(google.state.sent[0]!.text).toBe('Grüße, 你好');
  });
});

describe('the client id in use', () => {
  it('uses the saved client id and secret for the refresh request', async () => {
    const env = await freshEnv();
    google.state.sendScript.push({ type: 'respond', status: 401 });
    queueOne(env, 'Abe', realAddress);
    await drain(env);
    const refresh = google.state.tokenRequests.find((request) => request.grantType === 'refresh_token')!;
    expect(refresh.form.client_id).toBe(stubGoogleClientId);
  });
});

function taskCount(env: TestEnvironment, personName: string): number {
  return (env.db.prepare("SELECT COUNT(*) AS n FROM task WHERE title = ? AND status = 'open'").get(`Check whether the email to ${personName} Testwell was sent`) as { n: number }).n;
}

function auditCount(env: TestEnvironment, action: string, entityId: string): number {
  return (env.db.prepare('SELECT COUNT(*) AS n FROM audit_event WHERE action = ? AND entity_id = ?').get(action, entityId) as { n: number }).n;
}

async function unknownThatWasSent(env: TestEnvironment, name: string, email = realAddress): Promise<string> {
  // Gmail accepted the message and the answer was lost, so the search will find it once it can run.
  google.state.sendScript.push({ type: 'process_then_respond', status: 502 });
  const intentId = queueOne(env, name, email);
  await drain(env);
  expect(statusOf(env, intentId)).toBe('unknown');
  return intentId;
}

describe('an unknown message whose Gmail check cannot run', () => {
  it('gets the check task and an audit note at once, only once, when the sign in no longer works', async () => {
    const env = await freshEnv();
    const intentId = await unknownThatWasSent(env, 'Una');
    markGmailError(env.ctx, 'invalid_grant');
    env.advance(1500);
    await processMailJobs(env.ctx);
    const intent = intentOf(env, intentId);
    expect(intent.status).toBe('unknown');
    expect(intent.error).toMatch(/Checking again stopped/);
    expect(intent.error).toContain('seven days');
    expect(taskCount(env, 'Una')).toBe(1);
    expect(auditCount(env, 'send_intent.reconcile_stopped', intentId)).toBe(1);
    expect(google.state.requests.filter((request) => request.method === 'GET' && request.path.endsWith('/messages'))).toHaveLength(0);

    // Running it again says nothing new and adds no second task.
    const errorBefore = intent.error;
    await reconcileIntent(env.ctx, { intentId, attempt: 1, workspaceId: env.workspaceId });
    expect(intentOf(env, intentId).error).toBe(errorBefore);
    expect(taskCount(env, 'Una')).toBe(1);
    expect(google.state.sendAttempts).toHaveLength(1);
  });

  it('does the same when the connector was removed, and when a different account is signed in', async () => {
    const removedEnv = await freshEnv();
    const removed = await unknownThatWasSent(removedEnv, 'Vic');
    disconnectGmailConnector(removedEnv.ctx);
    removedEnv.advance(1500);
    await processMailJobs(removedEnv.ctx);
    expect(statusOf(removedEnv, removed)).toBe('unknown');
    expect(intentOf(removedEnv, removed).error).toContain('connector was removed');
    expect(taskCount(removedEnv, 'Vic')).toBe(1);

    const otherEnv = await freshEnv();
    const other = await unknownThatWasSent(otherEnv, 'Wes');
    google.state.address = 'someone.else@gmail-stub.invalid';
    await connectGmail(otherEnv, google);
    otherEnv.advance(1500);
    await processMailJobs(otherEnv.ctx);
    expect(statusOf(otherEnv, other)).toBe('unknown');
    expect(intentOf(otherEnv, other).error).toContain('sending inbox changed');
    expect(taskCount(otherEnv, 'Wes')).toBe(1);
    expect(google.state.sendAttempts).toHaveLength(2);
  });

  it('resumes the read only search when the same account signs in again, and finds the message without sending', async () => {
    const env = await freshEnv();
    const intentId = await unknownThatWasSent(env, 'Xia');
    markGmailError(env.ctx, 'invalid_grant');
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(taskCount(env, 'Xia')).toBe(1);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status != 'done'").get()).toEqual({ n: 0 });

    await connectGmail(env, google);
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.status).toBe('connected');
    expect(auditCount(env, 'send_intent.reconcile_resumed', intentId)).toBe(1);
    await processMailJobs(env.ctx);
    expect(intentOf(env, intentId)).toMatchObject({ status: 'accepted', providerMessageId: google.state.sent[0]!.id });
    expect(google.state.sendAttempts).toHaveLength(1);
    const writes = google.state.requests.filter((request) => request.method !== 'GET' && request.path.includes('/gmail/'));
    expect(writes).toHaveLength(1);
  });

  it('does not resume for a message a person acknowledged, and does not queue a second job when one is waiting', async () => {
    const env = await freshEnv();
    const acknowledged = await unknownThatWasSent(env, 'Yan');
    const waiting = await unknownThatWasSent(env, 'Zed', 'zed@lanternrow.invalid');
    // Zed still has its first job waiting. Yan's was never run.
    controlSendIntent(env.ctx, acknowledged, { action: 'acknowledge' });
    expect(statusOf(env, acknowledged)).toBe('cancelled');
    const jobsBefore = (env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status = 'queued' AND json_extract(payload, '$.intentId') = ?").get(waiting) as { n: number }).n;
    expect(jobsBefore).toBe(1);
    markGmailError(env.ctx, 'invalid_grant');
    await connectGmail(env, google);
    expect(auditCount(env, 'send_intent.reconcile_resumed', acknowledged)).toBe(0);
    expect(auditCount(env, 'send_intent.reconcile_resumed', waiting)).toBe(0);
    const jobsAfter = (env.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status = 'queued' AND json_extract(payload, '$.intentId') = ?").get(waiting) as { n: number }).n;
    expect(jobsAfter).toBe(1);
  });
});

describe('the reconcile schedule and the stale submit limit', () => {
  it('gives Gmail a schedule of about a day and leaves AgentMail on its three short waits', () => {
    const saved = process.env.AGENTCRM_MAIL_RECONCILE_MS;
    delete process.env.AGENTCRM_MAIL_RECONCILE_MS;
    try {
      expect(mailReconcileDelays('gmail')).toEqual([30_000, 120_000, 600_000, 3_600_000, 21_600_000, 79_200_000]);
      expect(mailReconcileDelays('agentmail')).toEqual([30_000, 120_000, 600_000]);
      expect(mailReconcileDelays()).toEqual([30_000, 120_000, 600_000]);
      process.env.AGENTCRM_MAIL_RECONCILE_MS = '1000';
      expect(mailReconcileDelays('gmail')).toHaveLength(6);
      expect(mailReconcileDelays('agentmail')).toEqual([1000, 1000, 1000]);
    } finally {
      if (saved === undefined) delete process.env.AGENTCRM_MAIL_RECONCILE_MS;
      else process.env.AGENTCRM_MAIL_RECONCILE_MS = saved;
    }
  });

  it('allows a submit at least 90 seconds with the default timeouts, and derives it from the request timeout', () => {
    const saved = { gmail: process.env.AGENTCRM_GMAIL_TIMEOUT_MS, agentmail: process.env.AGENTCRM_AGENTMAIL_TIMEOUT_MS };
    delete process.env.AGENTCRM_GMAIL_TIMEOUT_MS;
    delete process.env.AGENTCRM_AGENTMAIL_TIMEOUT_MS;
    try {
      expect(staleSubmittingMilliseconds()).toBeGreaterThanOrEqual(90_000);
      process.env.AGENTCRM_GMAIL_TIMEOUT_MS = '20000';
      expect(staleSubmittingMilliseconds()).toBe(20_000 * 4 + 30_000);
    } finally {
      if (saved.gmail === undefined) delete process.env.AGENTCRM_GMAIL_TIMEOUT_MS;
      else process.env.AGENTCRM_GMAIL_TIMEOUT_MS = saved.gmail;
      if (saved.agentmail === undefined) delete process.env.AGENTCRM_AGENTMAIL_TIMEOUT_MS;
      else process.env.AGENTCRM_AGENTMAIL_TIMEOUT_MS = saved.agentmail;
    }
  });
});

describe('token refresh is compare and set', () => {
  it('never overwrites a sign in that finished while a refresh was on the wire, and uses the new credentials', async () => {
    const env = await freshEnv();
    // The saved access token is about to expire, so the next call refreshes.
    env.advance(3_500_000);
    const stored = () => getGmailInternals(env.db, env.workspaceId)!.secret!;
    const oldRefresh = stored().refreshToken;
    const newcomer = { accessToken: 'ya29.new-account', refreshToken: '1//new-account-refresh' };
    google.state.accessTokens.add(newcomer.accessToken);
    google.state.refreshTokens.add(newcomer.refreshToken);
    const expiresAt = new Date(Date.parse(env.ctx.now()) + 3_000_000).toISOString();
    google.state.onRefresh = () => {
      google.state.onRefresh = null;
      // A sign in completes now: the connector holds a different account's tokens.
      const row = env.db.prepare("SELECT id, secret FROM connector WHERE kind = 'gmail'").get() as { id: string; secret: string };
      env.db.prepare('UPDATE connector SET secret = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.secret), ...newcomer, expiresAt }), row.id);
    };
    const adapter = createMailAdapter(env.ctx, 'gmail')!;
    const account = await adapter.provider.checkAccount();
    expect(account.address).toBe(stubGmailAddress);
    expect(oldRefresh).not.toBe(newcomer.refreshToken);
    expect(stored()).toMatchObject({ accessToken: newcomer.accessToken, refreshToken: newcomer.refreshToken, expiresAt });
    // One refresh was made and thrown away. The retry found the new sign in fresh and made no second one.
    expect(google.state.tokenRequests.filter((request) => request.grantType === 'refresh_token')).toHaveLength(1);
    const profile = google.state.requests.filter((request) => request.path.endsWith('/profile')).at(-1)!;
    expect(profile.headers.authorization).toBe(`Bearer ${newcomer.accessToken}`);
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.status).toBe('connected');
  });

  it('retries once with the new refresh token when the new sign in has no fresh access token yet', async () => {
    const env = await freshEnv();
    env.advance(3_500_000);
    const newcomerRefresh = '1//second-account-refresh';
    google.state.refreshTokens.add(newcomerRefresh);
    google.state.onRefresh = () => {
      google.state.onRefresh = null;
      const row = env.db.prepare("SELECT id, secret FROM connector WHERE kind = 'gmail'").get() as { id: string; secret: string };
      env.db.prepare('UPDATE connector SET secret = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.secret), accessToken: null, expiresAt: null, refreshToken: newcomerRefresh }), row.id);
    };
    const adapter = createMailAdapter(env.ctx, 'gmail')!;
    await adapter.provider.checkAccount();
    const refreshes = google.state.tokenRequests.filter((request) => request.grantType === 'refresh_token');
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]!.form.refresh_token).toBe(newcomerRefresh);
    expect(getGmailInternals(env.db, env.workspaceId)!.secret!.refreshToken).toBe(newcomerRefresh);
  });

  it('does not mark a newer sign in as broken when the refusal belongs to the old refresh token', async () => {
    const env = await freshEnv();
    env.advance(3_500_000);
    google.state.tokenMode = 'invalid_grant';
    google.state.onRefresh = () => {
      google.state.onRefresh = null;
      const row = env.db.prepare("SELECT id, secret FROM connector WHERE kind = 'gmail'").get() as { id: string; secret: string };
      env.db.prepare('UPDATE connector SET secret = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.secret), refreshToken: '1//newer' }), row.id);
    };
    const adapter = createMailAdapter(env.ctx, 'gmail')!;
    await expect(adapter.provider.checkAccount()).rejects.toThrow();
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.status).toBe('connected');
  });
});
