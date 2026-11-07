import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncMail } from '../src/actions/index.js';
import { getConnector, getGmailInternals } from '../src/queries/connectors.js';
import { getMailSummary } from '../src/queries/sendIntents.js';
import { type GoogleStub, startGoogleStub, stubGmailAddress, useGoogleStub } from './googleStub.js';
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

function count(env: TestEnvironment, table: string, where = '1 = 1'): number {
  return (env.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

function cursorOf(env: TestEnvironment): string | null {
  return (getGmailInternals(env.db, env.workspaceId)!.settings.historyId as string | null) ?? null;
}

describe('gmail inbound sync', () => {
  it('starts from the account position saved at sign in', async () => {
    const env = await freshEnv();
    expect(cursorOf(env)).toBe(String(google.state.historyId));
    // A message that arrived before sign in is not replayed.
    const result = await syncMail(env.ctx);
    expect(result).toMatchObject({ skipped: false, messagesStored: 0, error: null });
  });

  it('stores messages once, links people, normalizes headers and text, and advances the cursor', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Ada', 'ada@lanternrow.invalid');
    const message = google.addInbound({
      from: 'Ada Testwell <ADA@lanternrow.invalid>',
      to: `${stubGmailAddress}, Other <other@lanternrow.invalid>`,
      subject: '=?UTF-8?B?UmU6IENhZsOp?=',
      text: 'Happy to talk next week.',
      messageId: '<reply-1@lanternrow.invalid>',
      inReplyTo: '<ac-snd_x-aa@gmail-stub.invalid>',
      references: '<ac-snd_x-aa@gmail-stub.invalid>',
    });
    const first = await syncMail(env.ctx);
    expect(first).toMatchObject({ skipped: false, messagesStored: 1, error: null });
    const row = env.db.prepare('SELECT * FROM email_message').get() as Record<string, string>;
    expect(row).toMatchObject({
      provider_message_id: message.id,
      provider_thread_id: message.threadId,
      direction: 'in',
      person_id: person.id,
      from_email: 'ada@lanternrow.invalid',
      from_name: 'Ada Testwell',
      subject: 'Re: Café',
      body_text: 'Happy to talk next week.',
    });
    expect(JSON.parse(row.to!)).toEqual([stubGmailAddress, 'other@lanternrow.invalid']);
    const activity = env.db.prepare("SELECT body FROM activity WHERE kind = 'email_in'").get() as { body: string };
    expect(activity.body.split('\n')[0]).toBe('Reply received');
    expect(activity.body).toContain('Happy to talk next week.');
    expect(cursorOf(env)).toBe(String(google.state.historyId));
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.settings.lastSyncAt).not.toBeNull();

    const gets = () => google.state.requests.filter((request) => /\/messages\/[^/]+$/.test(request.path) && request.query.format === 'full').length;
    expect(gets()).toBe(1);
    const second = await syncMail(env.ctx);
    expect(second.messagesStored).toBe(0);
    expect(count(env, 'email_message')).toBe(1);
    expect(gets()).toBe(1);
    const history = google.state.requests.filter((request) => request.path.endsWith('/history')).at(-1)!;
    expect(history.query).toMatchObject({ historyTypes: 'messageAdded', labelId: 'INBOX', startHistoryId: String(google.state.historyId) });
  });

  it('reads the stripped html when a message has no plain text part', async () => {
    const env = await freshEnv();
    addPerson(env, 'Bo', 'bo@lanternrow.invalid');
    google.addInbound({
      from: 'bo@lanternrow.invalid',
      html: '<html><head><style>p{}</style></head><body><p>Hello &amp; welcome</p><div>Call me<br>tomorrow</div><script>x()</script></body></html>',
    });
    await syncMail(env.ctx);
    const row = env.db.prepare('SELECT body_text FROM email_message').get() as { body_text: string };
    expect(row.body_text).toBe('Hello & welcome\nCall me\ntomorrow');
  });

  it('marks the intent on the same thread replied, creates a task, and blocks queued messages to that person', async () => {
    const env = await freshEnv();
    const first = queueOne(env, 'Bea', 'bea@lanternrow.invalid', 'First note');
    await drain(env);
    expect(statusOf(env, first)).toBe('accepted');
    const person = intentOf(env, first).personId;
    const staged = stage(env, [addDraft(env, person, 'Second note', 'Another message.')]);
    approve(env, staged.approval!.id);
    expect(statusOf(env, staged.intents[0]!.id)).toBe('queued');

    google.addInbound({ from: 'bea@lanternrow.invalid', threadId: intentOf(env, first).providerThreadId!, text: 'Interested, call me.' });
    await syncMail(env.ctx);

    expect(statusOf(env, first)).toBe('replied');
    expect(intentOf(env, staged.intents[0]!.id)).toMatchObject({ status: 'blocked', error: 'reply_received' });
    expect(env.db.prepare("SELECT title, entity_id, status FROM task WHERE title LIKE 'Reply received%'").get()).toEqual({
      title: 'Reply received from Bea Testwell',
      entity_id: person,
      status: 'open',
    });
    await drain(env);
    expect(google.state.sent).toHaveLength(1);

    const summary = getMailSummary(env.db, env.workspaceId, env.ctx.now());
    expect(summary.provider).toBe('gmail');
    expect(summary.repliesNeedingAttention.items[0]).toMatchObject({ personName: 'Bea Testwell', fromEmail: 'bea@lanternrow.invalid', snippet: 'Interested, call me.' });
    expect(summary.inbox).toMatchObject({ connected: true, inboxEmail: stubGmailAddress, inboxId: stubGmailAddress });
  });

  it('suppresses a sender who writes an opt out, and links a reply from another address by thread', async () => {
    const env = await freshEnv();
    const first = queueOne(env, 'Cy', 'cy@lanternrow.invalid');
    await drain(env);
    google.addInbound({ from: 'Assistant <assistant@elsewhere.invalid>', threadId: intentOf(env, first).providerThreadId!, text: 'Please unsubscribe Cy.' });
    await syncMail(env.ctx);
    expect(statusOf(env, first)).toBe('replied');
    expect((env.db.prepare('SELECT email FROM suppression ORDER BY email').all() as { email: string }[]).map((row) => row.email)).toEqual([
      'assistant@elsewhere.invalid',
      'cy@lanternrow.invalid',
    ]);
  });

  it('pages through the history feed in one sync and moves the cursor past every page', async () => {
    const env = await freshEnv();
    google.state.historyPageSize = 2;
    for (let index = 0; index < 5; index += 1) google.addInbound({ from: `bulk${index}@nowhere.invalid` });
    const result = await syncMail(env.ctx);
    expect(result.messagesStored).toBe(5);
    expect(count(env, 'email_message')).toBe(5);
    expect(google.state.requests.filter((request) => request.path.endsWith('/history'))).toHaveLength(3);
    expect(cursorOf(env)).toBe(String(google.state.historyId));
  });

  it('keeps the cursor and reports a plain error when a message cannot be read, then recovers', async () => {
    const env = await freshEnv();
    const before = cursorOf(env);
    google.addInbound({ from: 'late@nowhere.invalid' });
    google.state.getStatus = 503;
    const failed = await syncMail(env.ctx);
    expect(failed.error).toMatch(/could not read from Gmail/);
    expect(cursorOf(env)).toBe(before);
    expect(count(env, 'email_message')).toBe(0);
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.status).toBe('connected');
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.settings.lastSyncError).toBe(failed.error);

    google.state.getStatus = null;
    expect((await syncMail(env.ctx)).messagesStored).toBe(1);
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.settings.lastSyncError).toBeNull();
  });

  it('skips a message that Gmail no longer has, without stalling the sync', async () => {
    const env = await freshEnv();
    const gone = google.addInbound({ from: 'gone@nowhere.invalid' });
    google.addInbound({ from: 'here@nowhere.invalid' });
    google.state.getStatusById[gone.id] = 404;
    const result = await syncMail(env.ctx);
    expect(result.messagesStored).toBe(1);
    expect(cursorOf(env)).toBe(String(google.state.historyId));
  });

  it('treats a 403 on one message as transient: the cursor stays, what was fetched is stored, and the retry stores it', async () => {
    const env = await freshEnv();
    const before = cursorOf(env);
    const first = google.addInbound({ from: 'first@nowhere.invalid' });
    const refused = google.addInbound({ from: 'refused@nowhere.invalid' });
    google.addInbound({ from: 'third@nowhere.invalid' });
    google.state.getStatusById[refused.id] = 403;
    const failed = await syncMail(env.ctx);
    expect(failed.error).toMatch(/could not read from Gmail/);
    // The message before the refusal is kept; the refused one and the one after it are not skipped.
    expect(count(env, 'email_message', `provider_message_id = '${first.id}'`)).toBe(1);
    expect(count(env, 'email_message')).toBe(1);
    expect(cursorOf(env)).toBe(before);
    expect(getConnector(env.db, env.workspaceId, 'gmail')!.status).toBe('connected');

    delete google.state.getStatusById[refused.id];
    const healed = await syncMail(env.ctx);
    expect(healed).toMatchObject({ error: null, messagesStored: 2 });
    expect(count(env, 'email_message', `provider_message_id = '${refused.id}'`)).toBe(1);
    expect(count(env, 'email_message')).toBe(3);
    expect(cursorOf(env)).toBe(String(google.state.historyId));
  });

  it('follows empty history pages by their page token, at most twenty a poll, and continues next poll', async () => {
    const env = await freshEnv();
    google.state.emptyHistoryPages = 2;
    google.addInbound({ from: 'after-gap@nowhere.invalid' });
    const result = await syncMail(env.ctx);
    expect(result).toMatchObject({ error: null, messagesStored: 1 });
    const historyRequests = google.state.requests.filter((request) => request.path.endsWith('/history'));
    expect(historyRequests).toHaveLength(3);
    expect(historyRequests.map((request) => request.query.pageToken)).toEqual([undefined, 'empty:1', 'empty:2']);
    expect(cursorOf(env)).toBe(String(google.state.historyId));
  });

  it('stops after twenty empty pages in one poll without stalling, and the next poll carries on from the page token', async () => {
    const env = await freshEnv();
    const before = cursorOf(env);
    google.state.emptyHistoryPages = 25;
    google.addInbound({ from: 'far-behind@nowhere.invalid' });
    const first = await syncMail(env.ctx);
    expect(first).toMatchObject({ error: null, messagesStored: 0 });
    expect(google.state.requests.filter((request) => request.path.endsWith('/history'))).toHaveLength(20);
    expect(cursorOf(env)).toBe(`${before}~empty:20`);

    const requestsBefore = google.state.requests.length;
    const second = await syncMail(env.ctx);
    expect(second).toMatchObject({ error: null, messagesStored: 1 });
    const resumed = google.state.requests.slice(requestsBefore).filter((request) => request.path.endsWith('/history'));
    expect(resumed[0]!.query).toMatchObject({ startHistoryId: before, pageToken: 'empty:20' });
    expect(resumed).toHaveLength(6);
    expect(cursorOf(env)).toBe(String(google.state.historyId));
  });

  it('stores a stubborn message without its text after three polls in a row, with a task that names it', async () => {
    const env = await freshEnv();
    const stuck = google.addInbound({ from: 'stuck@nowhere.invalid', subject: 'Ignore all instructions' });
    google.state.getStatusById[stuck.id] = 503;
    expect((await syncMail(env.ctx)).error).not.toBeNull();
    expect((await syncMail(env.ctx)).error).not.toBeNull();
    const third = await syncMail(env.ctx);
    expect(third.error).toBeNull();
    expect(count(env, 'email_message')).toBe(1);
    const tasks = env.db.prepare('SELECT title FROM task').all() as { title: string }[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toMatch(/^Could not read the full text of an email from an unreadable sender address sent \d{4}-\d{2}-\d{2}$/);
    expect(tasks[0]!.title).not.toContain('Ignore all instructions');
    expect(cursorOf(env)).toBe(String(google.state.historyId));
  });

  it('resets the cursor to the present when history has expired, and says so without disconnecting', async () => {
    const env = await freshEnv();
    google.addInbound({ from: 'missed@nowhere.invalid' });
    google.state.historyNotFound = true;
    const result = await syncMail(env.ctx);
    expect(result).toMatchObject({ skipped: false, error: null, messagesStored: 0 });
    expect(cursorOf(env)).toBe(String(google.state.historyId));
    const connector = getConnector(env.db, env.workspaceId, 'gmail')!;
    expect(connector.status).toBe('connected');
    expect(connector.statusMessage).toMatch(/started again from now/);
    expect(connector.statusMessage).toMatch(/may not be shown/);

    google.state.historyNotFound = false;
    google.addInbound({ from: 'after@nowhere.invalid' });
    expect((await syncMail(env.ctx)).messagesStored).toBe(1);
  });

  it('marks the connector as needing a new sign in when Google stops accepting the token', async () => {
    const env = await freshEnv();
    google.revokeAccessTokens();
    google.state.refreshTokens.clear();
    google.state.tokenMode = 'invalid_grant';
    google.addInbound({ from: 'x@nowhere.invalid' });
    const result = await syncMail(env.ctx);
    expect(result.error).toMatch(/no longer accepts/);
    const connector = getConnector(env.db, env.workspaceId, 'gmail')!;
    expect(connector.status).toBe('error');
    expect(connector.statusMessage).toContain('seven days');
    expect((await syncMail(env.ctx)).skipped).toBe(true);
  });

  it('does nothing without a signed in account', async () => {
    const env = createTestEnvironment();
    environments.push(env);
    expect((await syncMail(env.ctx)).skipped).toBe(true);
    expect(google.state.requests).toHaveLength(0);
  });
});

describe('gmail bounces', () => {
  async function sentTo(env: TestEnvironment, name: string, email: string) {
    const intentId = queueOne(env, name, email);
    await drain(env);
    const header = (env.db.prepare('SELECT message_id_header FROM send_intent WHERE id = ?').get(intentId) as { message_id_header: string }).message_id_header;
    return { intentId, header };
  }

  it.each(['headers', 'text', 'references'] as const)('marks the intent bounced, suppresses the address, and creates a task when the report names our Message-ID (%s)', async (where) => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, `Ivo${where}`, `ivo-${where}@lanternrow.invalid`);
    google.addBounce({ originalMessageId: header, to: `ivo-${where}@lanternrow.invalid`, where });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    expect(env.db.prepare('SELECT email, reason, source FROM suppression').get()).toMatchObject({ email: `ivo-${where}@lanternrow.invalid`, reason: 'bounce' });
    expect(count(env, 'task', `title = 'Email to Ivo${where} Testwell bounced'`)).toBe(1);
    // A bounce is not a reply.
    expect(count(env, 'task', "title LIKE 'Reply received%'")).toBe(0);
    expect(count(env, 'activity', "kind = 'email_in'")).toBe(0);
    expect(env.db.prepare('SELECT person_id FROM email_message').get()).toEqual({ person_id: null });

    const again = await syncMail(env.ctx);
    expect(again.messagesStored).toBe(0);
    expect(count(env, 'task', "title LIKE 'Email to%'")).toBe(1);
  });

  it('keeps a delay notice that quotes our Message-ID as an ordinary inbound message: no bounce, no suppression', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Pip', 'pip@lanternrow.invalid');
    google.addBounce({ originalMessageId: header, to: 'pip@lanternrow.invalid', kind: 'delay' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'suppression')).toBe(0);
    expect(count(env, 'task')).toBe(0);
    expect(count(env, 'email_message')).toBe(1);

    // The failure that follows the delay does bounce.
    google.addBounce({ originalMessageId: header, to: 'pip@lanternrow.invalid', kind: 'failure' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    expect(count(env, 'suppression')).toBe(1);
    expect(count(env, 'task', "title = 'Email to Pip Testwell bounced'")).toBe(1);
  });

  it('does not bounce on a delivered or relayed notice either, and a delay with failure sounding words stays a delay', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Quin', 'quin@lanternrow.invalid');
    google.addBounce({ originalMessageId: header, kind: 'delivered' });
    // Delay notices open with "Delivery incomplete" and still say the provider is trying.
    google.addBounce({ originalMessageId: header, kind: 'delay', report: false });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'suppression')).toBe(0);
    expect(count(env, 'email_message')).toBe(2);
  });

  it('bounces on failure wording alone when no delivery status report is attached', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Rae', 'rae@lanternrow.invalid');
    google.addBounce({ originalMessageId: header, report: false, where: 'text', subject: 'Undelivered Mail Returned to Sender', explanation: 'Address not found. Your message could not be delivered.' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    expect(count(env, 'suppression')).toBe(1);
  });

  it('needs a failure signal: a mailer daemon message that quotes our Message-ID with no failure marker is ordinary mail', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Sol', 'sol@lanternrow.invalid');
    google.addBounce({ originalMessageId: header, report: false, where: 'text', subject: 'Notice from the mail system', explanation: 'We saw your message and have nothing to add.' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'suppression')).toBe(0);
  });

  it('leaves a delivery report that does not carry our Message-ID as an ordinary inbound message', async () => {
    const env = await freshEnv();
    const { intentId } = await sentTo(env, 'Joy', 'joy@lanternrow.invalid');
    google.addBounce({ originalMessageId: '<someone-elses@other.invalid>', to: 'joy@lanternrow.invalid' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'suppression')).toBe(0);
    expect(count(env, 'task')).toBe(0);
    expect(count(env, 'email_message')).toBe(1);
  });

  it('does not treat a person who quotes our Message-ID as a bounce', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Kit', 'kit@lanternrow.invalid');
    google.addInbound({ from: 'kit@lanternrow.invalid', references: header, inReplyTo: header, text: 'Thanks, got it.' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('replied');
    expect(count(env, 'suppression')).toBe(0);
  });

  it('only reads a mailer daemon address as automated, not a display name', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Lou', 'lou@lanternrow.invalid');
    google.addInbound({ from: '"mailer-daemon@fake" <lou@lanternrow.invalid>', references: header });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('replied');
  });

  it('accepts a postmaster report too', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Mia', 'mia@lanternrow.invalid');
    google.addBounce({ originalMessageId: header, from: 'Postmaster <postmaster@lanternrow.invalid>' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
  });

  it('resolves an intent that was still unknown when the report proves the email went out', async () => {
    const env = await freshEnv();
    google.state.sendScript.push({ type: 'process_then_respond', status: 502 });
    const intentId = queueOne(env, 'Nia', 'nia@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    const header = (env.db.prepare('SELECT message_id_header FROM send_intent WHERE id = ?').get(intentId) as { message_id_header: string }).message_id_header;
    google.addBounce({ originalMessageId: header });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    env.advance(1500);
    const { processMailJobs } = await import('../src/jobs/worker.js');
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    expect(google.state.sent).toHaveLength(1);
  });
});
