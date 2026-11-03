import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { syncMail, syncMailIfDue } from '../src/actions/index.js';
import { processMailJobs } from '../src/jobs/worker.js';
import { maxDeltaPages } from '../src/providers/microsoft.js';
import { getConnector, getMicrosoftInternals } from '../src/queries/connectors.js';
import { getMailSummary } from '../src/queries/sendIntents.js';
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
  vi.restoreAllMocks();
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

function count(env: TestEnvironment, table: string, where = '1 = 1'): number {
  return (env.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

function cursorOf(env: TestEnvironment): string | null {
  return (getMicrosoftInternals(env.db, env.workspaceId)!.settings.deltaLink as string | null) ?? null;
}

const deltaRequests = () => ms.state.requests.filter((request) => request.path === '/v1.0/me/mailFolders/inbox/messages/delta');
const before = '2026-02-01T00:00:00.000Z';

describe('microsoft inbound sync', () => {
  it('starts from the moment of sign in: mail that arrived before it is not replayed', async () => {
    const env = await freshEnv();
    expect(cursorOf(env)).toMatch(/^start:2026-03-01T/);
    ms.addInbound({ from: 'old@nowhere.invalid', receivedDateTime: before });
    const result = await syncMail(env.ctx);
    expect(result).toMatchObject({ skipped: false, messagesStored: 0, error: null });
    expect(cursorOf(env)).toMatch(/^delta:http/);
    expect(count(env, 'email_message')).toBe(0);
    const first = deltaRequests()[0]!;
    expect(first.query.$filter).toMatch(/^receivedDateTime ge 2026-03-01T/);
  });

  it('stores messages once, links people, normalizes the fields, and stores the delta link', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Ada', 'ada@lanternrow.invalid');
    const message = ms.addInbound({
      from: 'ADA@lanternrow.invalid',
      fromName: 'Ada Testwell',
      to: stubMicrosoftAddress,
      subject: 'Re: Café',
      text: 'Happy to talk next week.',
      internetMessageId: '<reply-1@lanternrow.invalid>',
      conversationId: 'conv-abc',
    });
    const first = await syncMail(env.ctx);
    expect(first).toMatchObject({ skipped: false, messagesStored: 1, error: null });
    const row = env.db.prepare('SELECT * FROM email_message').get() as Record<string, string>;
    expect(row).toMatchObject({
      provider_message_id: message.id,
      provider_thread_id: 'conv-abc',
      direction: 'in',
      person_id: person.id,
      from_email: 'ada@lanternrow.invalid',
      subject: 'Re: Café',
      body_text: 'Happy to talk next week.',
    });
    expect(JSON.parse(row.to!)).toEqual([stubMicrosoftAddress]);
    const activity = env.db.prepare("SELECT body FROM activity WHERE kind = 'email_in'").get() as { body: string };
    expect(activity.body.split('\n')[0]).toBe('Reply received');
    expect(activity.body).toContain('Happy to talk next week.');
    expect(cursorOf(env)).toMatch(/^delta:/);
    expect(cursorOf(env)).toContain('deltatoken');
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.settings.lastSyncAt).not.toBeNull();

    const request = deltaRequests()[0]!;
    expect(request.query.$select).toBe('id,from,toRecipients,ccRecipients,subject,body,bodyPreview,internetMessageId,conversationId,receivedDateTime,isDraft');
    expect(String(request.headers.prefer)).toBe('IdType="ImmutableId", odata.maxpagesize=25');

    const second = await syncMail(env.ctx);
    expect(second.messagesStored).toBe(0);
    expect(count(env, 'email_message')).toBe(1);
    // The second poll continued from the stored delta link.
    expect(deltaRequests().at(-1)!.query.$deltatoken).toBeDefined();
    expect(deltaRequests().at(-1)!.query.$filter).toBeUndefined();
  });

  it('reads the stripped html when the body is html', async () => {
    const env = await freshEnv();
    addPerson(env, 'Bo', 'bo@lanternrow.invalid');
    ms.addInbound({
      from: 'bo@lanternrow.invalid',
      html: '<html><head><style>p{}</style></head><body><p>Hello &amp; welcome</p><div>Call me<br>tomorrow</div><script>x()</script></body></html>',
    });
    await syncMail(env.ctx);
    const row = env.db.prepare('SELECT body_text FROM email_message').get() as { body_text: string };
    expect(row.body_text).toBe('Hello & welcome\nCall me\ntomorrow');
  });

  it('marks the intent on the same conversation replied, creates a task, and blocks queued messages to that person', async () => {
    const env = await freshEnv();
    const first = queueOne(env, 'Bea', 'bea@lanternrow.invalid', 'First note');
    await drain(env);
    expect(statusOf(env, first)).toBe('accepted');
    const person = intentOf(env, first).personId;
    const staged = stage(env, [addDraft(env, person, 'Second note', 'Another message.')]);
    approve(env, staged.approval!.id);
    expect(statusOf(env, staged.intents[0]!.id)).toBe('queued');

    ms.addInbound({ from: 'bea@lanternrow.invalid', conversationId: intentOf(env, first).providerThreadId!, text: 'Interested, call me.' });
    await syncMail(env.ctx);

    expect(statusOf(env, first)).toBe('replied');
    expect(intentOf(env, staged.intents[0]!.id)).toMatchObject({ status: 'blocked', error: 'reply_received' });
    expect(env.db.prepare("SELECT title, entity_id, status FROM task WHERE title LIKE 'Reply received%'").get()).toEqual({
      title: 'Reply received from Bea Testwell',
      entity_id: person,
      status: 'open',
    });
    await drain(env);
    expect(ms.state.sent).toHaveLength(1);

    const summary = getMailSummary(env.db, env.workspaceId, env.ctx.now());
    expect(summary.provider).toBe('microsoft');
    expect(summary.repliesNeedingAttention.items[0]).toMatchObject({ personName: 'Bea Testwell', fromEmail: 'bea@lanternrow.invalid', snippet: 'Interested, call me.' });
    expect(summary.inbox).toMatchObject({ connected: true, inboxEmail: stubMicrosoftAddress, inboxId: stubMicrosoftAddress });
  });

  it('suppresses a sender who writes an opt out, and links a reply from another address by conversation', async () => {
    const env = await freshEnv();
    const first = queueOne(env, 'Cy', 'cy@lanternrow.invalid');
    await drain(env);
    ms.addInbound({ from: 'Assistant <assistant@elsewhere.invalid>', conversationId: intentOf(env, first).providerThreadId!, text: 'Please unsubscribe Cy.' });
    await syncMail(env.ctx);
    expect(statusOf(env, first)).toBe('replied');
    expect((env.db.prepare('SELECT email FROM suppression ORDER BY email').all() as { email: string }[]).map((row) => row.email)).toEqual([
      'assistant@elsewhere.invalid',
      'cy@lanternrow.invalid',
    ]);
  });

  it('follows every next link in one sync and stores the delta link after the last page', async () => {
    const env = await freshEnv();
    await syncMail(env.ctx);
    ms.state.deltaPageSize = 2;
    for (let index = 0; index < 5; index += 1) ms.addInbound({ from: `bulk${index}@nowhere.invalid` });
    const countBefore = deltaRequests().length;
    const result = await syncMail(env.ctx);
    expect(result.messagesStored).toBe(5);
    expect(count(env, 'email_message')).toBe(5);
    const made = deltaRequests().slice(countBefore);
    expect(made).toHaveLength(3);
    expect(made[0]!.query.$deltatoken).toBeDefined();
    expect(made[1]!.query.$skiptoken).toBeDefined();
    expect(cursorOf(env)).toMatch(/^delta:.*deltatoken/);
    expect((await syncMail(env.ctx)).messagesStored).toBe(0);
  });

  it('follows at most twenty pages in one call and carries on from the next link', async () => {
    const env = await freshEnv();
    await syncMail(env.ctx);
    ms.state.deltaPageSize = 1;
    const total = maxDeltaPages * 4 + 10;
    for (let index = 0; index < total; index += 1) ms.addInbound({ from: `bulk${index}@nowhere.invalid` });
    const first = await syncMail(env.ctx);
    // Four calls of twenty pages each, then the poll ends with the rest still waiting behind a next link.
    expect(first.messagesStored).toBe(maxDeltaPages * 4);
    expect(cursorOf(env)).toMatch(/^next:/);
    const second = await syncMail(env.ctx);
    expect(second.messagesStored).toBe(10);
    expect(cursorOf(env)).toMatch(/^delta:/);
    expect(count(env, 'email_message')).toBe(total);
  });

  it('ignores a message that was deleted or moved out of the inbox', async () => {
    const env = await freshEnv();
    await syncMail(env.ctx);
    const gone = ms.addInbound({ from: 'gone@nowhere.invalid' });
    ms.addInbound({ from: 'kept@nowhere.invalid' });
    ms.removeInbound(gone.id);
    const result = await syncMail(env.ctx);
    expect(result.error).toBeNull();
    expect(result.messagesStored).toBe(1);
    ms.removeInbound(Object.values(ms.state.messages).find((message) => message.from.address === 'kept@nowhere.invalid')!.id);
    expect((await syncMail(env.ctx)).messagesStored).toBe(0);
  });

  it('restarts the folder sync from now on a 410 SyncStateNotFound, and says so without disconnecting', async () => {
    const env = await freshEnv();
    await syncMail(env.ctx);
    const first = cursorOf(env);
    ms.addInbound({ from: 'missed@nowhere.invalid', receivedDateTime: before });
    ms.state.deltaGone = true;
    const result = await syncMail(env.ctx);
    expect(result).toMatchObject({ skipped: false, error: null, messagesStored: 0 });
    expect(cursorOf(env)).toMatch(/^delta:/);
    expect(cursorOf(env)).not.toBe(first);
    const connector = getConnector(env.db, env.workspaceId, 'microsoft')!;
    expect(connector.status).toBe('connected');
    expect(connector.statusMessage).toMatch(/started again from now/);
    expect(connector.statusMessage).toMatch(/may not be shown/);
    // The restart used the start request, not the saved link.
    expect(deltaRequests().at(-1)!.query.$filter).toMatch(/^receivedDateTime ge /);

    ms.addInbound({ from: 'after@nowhere.invalid' });
    expect((await syncMail(env.ctx)).messagesStored).toBe(1);
  });

  it('also restarts on a SyncStateNotFound code that comes with another status', async () => {
    const env = await freshEnv();
    await syncMail(env.ctx);
    ms.state.deltaScript.push({ status: 400, body: { error: { code: 'SyncStateNotFound', message: 'gone' } } });
    const result = await syncMail(env.ctx);
    expect(result.error).toBeNull();
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.statusMessage).toMatch(/started again from now/);
  });

  it('honors Retry-After on a 429: the next poll waits that long instead of the usual interval', async () => {
    const env = await freshEnv();
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(start);
    ms.state.deltaScript.push({ status: 429, headers: { 'retry-after': '300' } });
    const throttled = await syncMailIfDue(env.ctx);
    expect(throttled!.error).toMatch(/rate limiting/);
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.settings.lastSyncError).toMatch(/rate limiting/);
    const requests = deltaRequests().length;
    // Past the usual 60 second interval, inside the 300 seconds Microsoft asked for.
    clock.mockReturnValue(start + 120_000);
    expect(await syncMailIfDue(env.ctx)).toBeNull();
    expect(deltaRequests().length).toBe(requests);
    clock.mockReturnValue(start + 301_000);
    const retried = await syncMailIfDue(env.ctx);
    expect(retried).toMatchObject({ skipped: false, error: null });
    expect(deltaRequests().length).toBe(requests + 1);
  });

  it('never polls sooner than five seconds after a 429, even when Retry-After says zero or one second', async () => {
    for (const value of ['0', '1']) {
      const env = await freshEnv();
      const start = Date.now() + 20_000_000;
      const clock = vi.spyOn(Date, 'now');
      clock.mockReturnValue(start);
      ms.state.deltaScript.push({ status: 429, headers: { 'retry-after': value } });
      expect((await syncMailIfDue(env.ctx))!.error).toMatch(/rate limiting/);
      const requests = deltaRequests().length;
      clock.mockReturnValue(start + 1_000);
      expect(await syncMailIfDue(env.ctx)).toBeNull();
      clock.mockReturnValue(start + 4_900);
      expect(await syncMailIfDue(env.ctx)).toBeNull();
      expect(deltaRequests().length).toBe(requests);
      clock.mockReturnValue(start + 5_100);
      expect(await syncMailIfDue(env.ctx)).toMatchObject({ skipped: false, error: null });
      expect(deltaRequests().length).toBe(requests + 1);
      clock.mockRestore();
    }
  });

  it('polls on the usual interval after a 429 that names no Retry-After', async () => {
    const env = await freshEnv();
    const start = Date.now() + 10_000_000;
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(start);
    ms.state.deltaScript.push({ status: 429 });
    expect((await syncMailIfDue(env.ctx))!.error).toMatch(/rate limiting/);
    clock.mockReturnValue(start + 61_000);
    expect(await syncMailIfDue(env.ctx)).toMatchObject({ skipped: false, error: null });
  });

  it('keeps the cursor and reports a plain error on a server problem, then recovers', async () => {
    const env = await freshEnv();
    await syncMail(env.ctx);
    const saved = cursorOf(env);
    ms.addInbound({ from: 'late@nowhere.invalid' });
    ms.state.deltaScript.push({ status: 503 });
    const failed = await syncMail(env.ctx);
    expect(failed.error).toMatch(/could not read from Microsoft/);
    expect(cursorOf(env)).toBe(saved);
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.settings.lastSyncError).toMatch(/next poll will try again/);
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.status).toBe('connected');
    const recovered = await syncMail(env.ctx);
    expect(recovered).toMatchObject({ error: null, messagesStored: 1 });
    expect(getConnector(env.db, env.workspaceId, 'microsoft')!.settings.lastSyncError).toBeNull();
  });

  it('refuses a next link or delta link that points to another host, so the token is never sent there', async () => {
    const env = await freshEnv();
    await syncMail(env.ctx);
    const saved = cursorOf(env);
    ms.state.deltaScript.push({ status: 200, body: { value: [], '@odata.nextLink': 'http://evil.invalid/steal' } });
    const failed = await syncMail(env.ctx);
    expect(failed.error).not.toBeNull();
    expect(cursorOf(env)).toBe(saved);
    ms.state.deltaScript.push({ status: 200, body: { value: [], '@odata.deltaLink': 'http://evil.invalid/steal' } });
    expect((await syncMail(env.ctx)).error).not.toBeNull();
    expect(cursorOf(env)).toBe(saved);
  });

  it('marks the connector as needing a new sign in when Microsoft stops accepting the token', async () => {
    const env = await freshEnv();
    ms.revokeAccessTokens();
    ms.state.refreshTokens.clear();
    ms.state.tokenMode = 'invalid_grant';
    ms.addInbound({ from: 'x@nowhere.invalid' });
    const result = await syncMail(env.ctx);
    expect(result.error).toMatch(/no longer accepts/);
    const connector = getConnector(env.db, env.workspaceId, 'microsoft')!;
    expect(connector.status).toBe('error');
    expect(connector.statusMessage).toContain('Sign in with Microsoft again');
    expect((await syncMail(env.ctx)).skipped).toBe(true);
  });

  it('does nothing without a signed in account', async () => {
    const env = createTestEnvironment();
    environments.push(env);
    expect((await syncMail(env.ctx)).skipped).toBe(true);
    expect(ms.state.requests).toHaveLength(0);
  });
});

describe('microsoft bounces', () => {
  async function sentTo(env: TestEnvironment, name: string, email: string) {
    const intentId = queueOne(env, name, email);
    await drain(env);
    const saved = env.db.prepare('SELECT message_id_header, provider_draft_id FROM send_intent WHERE id = ?').get(intentId) as {
      message_id_header: string;
      provider_draft_id: string;
    };
    await syncMail(env.ctx);
    return { intentId, header: saved.message_id_header };
  }

  it.each(['file', 'item'] as const)('marks the intent bounced, suppresses the address, and creates a task when the report attaches the original (%s)', async (original) => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, `Ivo${original}`, `ivo-${original}@lanternrow.invalid`);
    const report = ms.addBounce({ originalInternetMessageId: header, to: `ivo-${original}@lanternrow.invalid`, original });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    expect(env.db.prepare('SELECT email, reason FROM suppression').get()).toMatchObject({ email: `ivo-${original}@lanternrow.invalid`, reason: 'bounce' });
    expect(count(env, 'task', `title = 'Email to Ivo${original} Testwell bounced'`)).toBe(1);
    expect(count(env, 'task', "title LIKE 'Reply received%'")).toBe(0);
    expect(count(env, 'activity', "kind = 'email_in'")).toBe(0);
    expect(env.db.prepare('SELECT person_id FROM email_message').get()).toEqual({ person_id: null });
    // The report was read through its headers and attachments, and only because its sender is automated.
    expect(ms.state.paths).toContain(`GET /v1.0/me/messages/${report.id}`);
    expect(ms.state.paths).toContain(`GET /v1.0/me/messages/${report.id}/attachments`);
    const again = await syncMail(env.ctx);
    expect(again.messagesStored).toBe(0);
    expect(count(env, 'task', "title LIKE 'Email to%'")).toBe(1);
  });

  it('matches the report by the x-agentcrm-intent header alone', async () => {
    const env = await freshEnv();
    const { intentId } = await sentTo(env, 'Hux', 'hux@lanternrow.invalid');
    ms.addBounce({ intentId, to: 'hux@lanternrow.invalid' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    expect(count(env, 'suppression')).toBe(1);
  });

  it('matches a report that names our Message-ID only in its text', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Jem', 'jem@lanternrow.invalid');
    ms.addBounce({ original: 'none', report: false, subject: 'Undeliverable: Hello', explanation: `Your message could not be delivered.\n\nOriginal Message-ID: ${header}` });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
  });

  it('ordinary mail is never fetched for attachments or headers', async () => {
    const env = await freshEnv();
    await syncMail(env.ctx);
    ms.addInbound({ from: 'person@lanternrow.invalid' });
    ms.addInbound({ from: 'Mailer <not-mailer-daemon@lanternrow.invalid>' });
    await syncMail(env.ctx);
    expect(ms.state.paths.filter((path) => path.includes('/attachments') || /GET \/v1\.0\/me\/messages\/[^/]+$/.test(path))).toHaveLength(0);
  });

  it('keeps a delay notice that carries our ids as an ordinary inbound message: no bounce, no suppression', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Pip', 'pip@lanternrow.invalid');
    ms.addBounce({ originalInternetMessageId: header, intentId, to: 'pip@lanternrow.invalid', kind: 'delay' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'suppression')).toBe(0);
    expect(count(env, 'task')).toBe(0);
    expect(count(env, 'email_message')).toBe(1);

    ms.addBounce({ originalInternetMessageId: header, to: 'pip@lanternrow.invalid', kind: 'failure' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    expect(count(env, 'suppression')).toBe(1);
    expect(count(env, 'task', "title = 'Email to Pip Testwell bounced'")).toBe(1);
  });

  it('does not bounce on a delivered notice, and a delay without a report stays a delay', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Quin', 'quin@lanternrow.invalid');
    ms.addBounce({ originalInternetMessageId: header, kind: 'delivered' });
    ms.addBounce({ originalInternetMessageId: header, kind: 'delay', report: false });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'suppression')).toBe(0);
    expect(count(env, 'email_message')).toBe(2);
  });

  it('bounces on failure wording alone when no delivery status report is attached', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Rae', 'rae@lanternrow.invalid');
    ms.addBounce({ originalInternetMessageId: header, report: false, subject: 'Undeliverable: Hello' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    expect(count(env, 'suppression')).toBe(1);
  });

  it('needs a failure signal: an automated message that names our ids with no failure marker is ordinary mail', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Sol', 'sol@lanternrow.invalid');
    ms.addBounce({ originalInternetMessageId: header, report: false, subject: 'Notice from the mail system', explanation: 'We saw your message and have nothing to add.' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'suppression')).toBe(0);
  });

  it('leaves a delivery report that does not carry our ids as an ordinary inbound message', async () => {
    const env = await freshEnv();
    const { intentId } = await sentTo(env, 'Joy', 'joy@lanternrow.invalid');
    ms.addBounce({ originalInternetMessageId: '<someone-elses@other.invalid>', intentId: 'snd_someoneelse', to: 'joy@lanternrow.invalid' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'suppression')).toBe(0);
    expect(count(env, 'task')).toBe(0);
    expect(count(env, 'email_message')).toBe(1);
  });

  it('does not treat a person who quotes our ids as a bounce', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Kit', 'kit@lanternrow.invalid');
    ms.addInbound({ from: 'kit@lanternrow.invalid', text: `Thanks, got it.\n\n> Message-ID: ${header}\n> x-agentcrm-intent: ${intentId}` });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('replied');
    expect(count(env, 'suppression')).toBe(0);
  });

  it('only reads a postmaster or mailer daemon address as automated, not a display name', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Lou', 'lou@lanternrow.invalid');
    ms.addBounce({ originalInternetMessageId: header, from: '"mailer-daemon@fake" <lou@lanternrow.invalid>' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('replied');
    const other = await sentTo(env, 'Mia', 'mia@lanternrow.invalid');
    ms.addBounce({ originalInternetMessageId: other.header, from: 'MAILER-DAEMON@lanternrow.invalid' });
    await syncMail(env.ctx);
    expect(statusOf(env, other.intentId)).toBe('bounced');
  });

  it('resolves an intent that was still unknown when the report proves the email went out', async () => {
    const env = await freshEnv();
    ms.state.sendScript.push({ type: 'process_then_respond', status: 502 });
    const intentId = queueOne(env, 'Nia', 'nia@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    const header = (env.db.prepare('SELECT message_id_header FROM send_intent WHERE id = ?').get(intentId) as { message_id_header: string }).message_id_header;
    ms.addBounce({ originalInternetMessageId: header });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    env.advance(1500);
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    expect(ms.state.sent).toHaveLength(1);
    expect(ms.state.sendAttempts).toHaveLength(1);
  });

  it('retries a report whose attachments cannot be read, and stores it without them after three polls in a row', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Nox', 'nox@lanternrow.invalid');
    const report = ms.addBounce({ originalInternetMessageId: header });
    ms.state.getStatusById[report.id] = 503;
    const first = await syncMail(env.ctx);
    expect(first.error).not.toBeNull();
    expect(count(env, 'email_message')).toBe(0);
    expect((await syncMail(env.ctx)).error).not.toBeNull();
    // The third poll gives up on the evidence. Without it the report cannot match, so it is ordinary mail.
    const third = await syncMail(env.ctx);
    expect(third.error).toBeNull();
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'email_message')).toBe(1);
  });
});

describe('bounce evidence budget per poll', () => {
  async function sentTo(env: TestEnvironment, name: string, email: string) {
    const intentId = queueOne(env, name, email);
    await drain(env);
    const saved = env.db.prepare('SELECT message_id_header FROM send_intent WHERE id = ?').get(intentId) as { message_id_header: string };
    await syncMail(env.ctx);
    return { intentId, header: saved.message_id_header };
  }

  const evidenceFetches = () =>
    ms.state.requests.filter((request) => request.method === 'GET' && /^\/v1\.0\/me\/messages\/[^/]+$/.test(request.path) && request.query.$select === 'internetMessageHeaders');

  it('fetches the evidence of at most ten reports in one poll and reads the rest on the next poll', async () => {
    const env = await freshEnv();
    addPerson(env, 'Zora', 'zora@lanternrow.invalid');
    for (let index = 0; index < 15; index += 1) ms.addBounce({ originalInternetMessageId: `<orig-${index}@mail.stub.invalid>`, to: `gone${index}@lanternrow.invalid` });
    ms.addInbound({ from: 'zora@lanternrow.invalid', text: 'Sounds good.' });

    const first = await syncMail(env.ctx);
    expect(first).toMatchObject({ skipped: false, error: null, messagesStored: 10 });
    expect(evidenceFetches()).toHaveLength(10);
    expect(count(env, 'email_message')).toBe(10);
    // The cursor did not move, so the remaining reports are read again.
    expect(cursorOf(env)).toMatch(/^start:/);

    const second = await syncMail(env.ctx);
    expect(second).toMatchObject({ skipped: false, error: null, messagesStored: 6 });
    expect(evidenceFetches()).toHaveLength(15);
    expect(count(env, 'email_message')).toBe(16);
    expect(count(env, 'email_message', "from_email = 'zora@lanternrow.invalid'")).toBe(1);
    expect(cursorOf(env)).toMatch(/^delta:/);

    // Nothing is fetched twice.
    expect(await syncMail(env.ctx)).toMatchObject({ messagesStored: 0, error: null });
    expect(evidenceFetches()).toHaveLength(15);
  });

  it('counts the budget across every page of a poll', async () => {
    const env = await freshEnv();
    ms.state.deltaPageSize = 4;
    for (let index = 0; index < 14; index += 1) ms.addBounce({ originalInternetMessageId: `<paged-${index}@mail.stub.invalid>`, to: `gone${index}@lanternrow.invalid` });
    const first = await syncMail(env.ctx);
    expect(first.error).toBeNull();
    expect(evidenceFetches()).toHaveLength(10);
    expect(first.messagesStored).toBe(10);
    const second = await syncMail(env.ctx);
    expect(second.messagesStored).toBe(4);
    expect(evidenceFetches()).toHaveLength(14);
  });

  it('still marks the intent of a report that is read on the later poll', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Late', 'late@lanternrow.invalid');
    for (let index = 0; index < 10; index += 1) ms.addBounce({ originalInternetMessageId: `<filler-${index}@mail.stub.invalid>`, to: `gone${index}@lanternrow.invalid` });
    ms.addBounce({ originalInternetMessageId: header, to: 'late@lanternrow.invalid' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
  });

  it('keeps the three strikes for a report whose attachments cannot be read, even with the budget in play', async () => {
    const env = await freshEnv();
    const report = ms.addBounce({ originalInternetMessageId: '<stubborn@mail.stub.invalid>', to: 'nobody@lanternrow.invalid' });
    ms.state.getStatusById[report.id] = 503;
    expect((await syncMail(env.ctx)).error).not.toBeNull();
    expect((await syncMail(env.ctx)).error).not.toBeNull();
    expect((await syncMail(env.ctx)).error).toBeNull();
    expect(count(env, 'email_message')).toBe(1);
  });
});

