import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncMail } from '../src/actions/index.js';
import { imapInboxResetNote } from '../src/providers/imapSmtp.js';
import { getConnector } from '../src/queries/connectors.js';
import { getMailSummary } from '../src/queries/sendIntents.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';
import { addDraft, addPerson, approve, connectImap, drain, queueOne, stage, statusOf } from './mailHelpers.js';
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

async function freshEnv(): Promise<TestEnvironment> {
  const env = createTestEnvironment();
  environments.push(env);
  await connectImap(env);
  return env;
}

function count(env: TestEnvironment, table: string, where = '1 = 1'): number {
  return (env.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

function settingsOf(env: TestEnvironment): Record<string, unknown> {
  return JSON.parse((env.db.prepare("SELECT settings FROM connector WHERE kind = 'imap'").get() as { settings: string }).settings);
}

function cursorOf(env: TestEnvironment): string | null {
  return (settingsOf(env).inboxCursor as string | undefined) ?? null;
}

describe('imap inbound sync', () => {
  it('starts from the Inbox position saved at connect, so earlier mail is not replayed', async () => {
    const env = createTestEnvironment();
    environments.push(env);
    stub.addInbound({ from: 'old@lanternrow.invalid', subject: 'Before', text: 'old' });
    await connectImap(env);
    expect(cursorOf(env)).toBe(`${stub.uidValidity}:1`);
    const result = await syncMail(env.ctx);
    expect(result).toMatchObject({ skipped: false, messagesStored: 0, error: null });
    expect(stub.listCalls).toEqual([{ uidValidity: stub.uidValidity, lastSeenUid: 1 }]);
    expect(count(env, 'email_message')).toBe(0);
  });

  it('stores messages once, links people, normalizes headers and text, and advances the cursor after storing', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Ada', 'ada@lanternrow.invalid');
    stub.addInbound({
      from: 'Ada Testwell <ADA@lanternrow.invalid>',
      to: `${stubImapAddress}, Other <other@lanternrow.invalid>`,
      subject: '=?UTF-8?B?UmU6IENhZsOp?=',
      text: 'Happy to talk next week.',
      messageId: '<reply-1@lanternrow.invalid>',
      date: '2026-03-01T10:00:00.000Z',
    });
    const first = await syncMail(env.ctx);
    expect(first).toMatchObject({ messagesStored: 1, error: null });
    const row = env.db.prepare('SELECT * FROM email_message').get() as Record<string, string>;
    expect(row).toMatchObject({
      provider_message_id: `imap:${stub.uidValidity}:1`,
      provider_thread_id: null,
      direction: 'in',
      person_id: person.id,
      from_email: 'ada@lanternrow.invalid',
      from_name: 'Ada Testwell',
      subject: 'Re: Café',
      body_text: 'Happy to talk next week.\n'.replace(/\n$/, '\r\n'),
      provider_timestamp: '2026-03-01T10:00:00.000Z',
    });
    expect(JSON.parse(row.to!)).toEqual([stubImapAddress, 'other@lanternrow.invalid']);
    expect(cursorOf(env)).toBe(`${stub.uidValidity}:1`);
    expect(count(env, 'activity', "kind = 'email_in'")).toBe(1);
    // The same message is never stored twice.
    stub.listCalls.length = 0;
    const again = await syncMail(env.ctx);
    expect(again.messagesStored).toBe(0);
    expect(count(env, 'email_message')).toBe(1);
    expect(getConnector(env.db, env.workspaceId, 'imap')!.settings.lastSyncAt).not.toBeNull();
  });

  it('reads the stripped html when a message has no plain text part', async () => {
    const env = await freshEnv();
    stub.addInbound({ from: 'h@lanternrow.invalid', subject: 'Html only', html: '<p>Hello <b>there</b></p><p>Second&nbsp;line &amp; more</p>' });
    await syncMail(env.ctx);
    const row = env.db.prepare('SELECT body_text FROM email_message').get() as { body_text: string };
    expect(row.body_text).toBe('Hello there\nSecond line & more');
  });

  it('marks the intent replied when the person answers our Message-ID, creates a task, and blocks queued messages to that person', async () => {
    const env = await freshEnv();
    const sentId = queueOne(env, 'Ivo', 'ivo@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, sentId)).toBe('accepted');
    const header = (env.db.prepare('SELECT message_id_header FROM send_intent WHERE id = ?').get(sentId) as { message_id_header: string }).message_id_header;
    // A second message to the same person waits in the queue.
    const person = env.db.prepare('SELECT person_id FROM send_intent WHERE id = ?').get(sentId) as { person_id: string };
    const staged = stage(env, [addDraft(env, person.person_id, 'Follow up', 'Second note')]);
    approve(env, staged.approval!.id);

    stub.addInbound({ from: 'Ivo <ivo@lanternrow.invalid>', subject: 'Re: Hello Ivo', text: 'Sounds good.', inReplyTo: header, references: [header] });
    await syncMail(env.ctx);
    expect(statusOf(env, sentId)).toBe('replied');
    expect(count(env, 'task', "title LIKE 'Reply received%'")).toBeGreaterThanOrEqual(1);
    expect(statusOf(env, staged.intents[0]!.id)).toBe('blocked');
    expect(count(env, 'email_message', `provider_thread_id = '${header}'`)).toBe(1);
    expect(getMailSummary(env.db, env.workspaceId, env.ctx.now()).provider).toBe('imap');
  });

  it('links a reply from another address through the thread and suppresses an opt out on it', async () => {
    const env = await freshEnv();
    const sentId = queueOne(env, 'Jun', 'jun@lanternrow.invalid');
    await drain(env);
    const header = (env.db.prepare('SELECT message_id_header FROM send_intent WHERE id = ?').get(sentId) as { message_id_header: string }).message_id_header;
    stub.addInbound({ from: 'assistant@lanternrow.invalid', subject: 'Re: Hello Jun', text: 'Please unsubscribe me from this.', inReplyTo: header, references: [header] });
    await syncMail(env.ctx);
    expect(statusOf(env, sentId)).toBe('replied');
    expect(count(env, 'suppression', "email = 'jun@lanternrow.invalid'")).toBe(1);
  });

  it('pages through more messages than one page holds in one sync and moves the cursor past every page', async () => {
    const env = await freshEnv();
    for (let index = 0; index < 60; index += 1) stub.addInbound({ from: `person${index}@lanternrow.invalid`, subject: `Message ${index}`, text: 'hi' });
    const result = await syncMail(env.ctx);
    expect(result.messagesStored).toBe(60);
    expect(stub.listCalls.length).toBe(3);
    expect(cursorOf(env)).toBe(`${stub.uidValidity}:${stub.uidNext - 1}`);
    expect((await syncMail(env.ctx)).messagesStored).toBe(0);
  });

  it('keeps the cursor and reports a plain error when the poll fails, then recovers', async () => {
    const env = await freshEnv();
    const start = cursorOf(env);
    stub.addInbound({ from: 'a@lanternrow.invalid', subject: 'First', text: 'x' });
    stub.knobs.listFailure = 'The IMAP server did not answer in time.';
    stub.knobs.listFailureKind = 'timeout';
    const failed = await syncMail(env.ctx);
    expect(failed.error).toBe('The mail server did not answer in time. The next poll will try again.');
    expect(cursorOf(env)).toBe(start);
    expect(getConnector(env.db, env.workspaceId, 'imap')!.settings.lastSyncError).toBe(failed.error);
    stub.knobs.listFailure = 'Connection reset.';
    stub.knobs.listFailureKind = 'network';
    const other = await syncMail(env.ctx);
    expect(other.error).toContain('could not read the Inbox from the mail server (Connection reset)');
    stub.knobs.listFailure = null;
    const ok = await syncMail(env.ctx);
    expect(ok).toMatchObject({ messagesStored: 1, error: null });
    expect(getConnector(env.db, env.workspaceId, 'imap')!.settings.lastSyncError).toBeNull();
  });

  it('marks the connector as needing the password when the server rejects the login during a poll', async () => {
    const env = await freshEnv();
    stub.knobs.listFailure = 'Authentication failed.';
    stub.knobs.listFailureKind = 'auth';
    const result = await syncMail(env.ctx);
    expect(result.error).toContain('no longer accepts the saved app password');
    const connector = getConnector(env.db, env.workspaceId, 'imap')!;
    expect(connector.status).toBe('error');
    expect(connector.statusMessage).toContain('app password');
    stub.knobs.listFailure = null;
    expect(await syncMail(env.ctx)).toMatchObject({ skipped: true });
  });

  it('does nothing without a ready account', async () => {
    const env = createTestEnvironment();
    environments.push(env);
    expect(await syncMail(env.ctx)).toMatchObject({ skipped: true });
    expect(stub.listCalls).toHaveLength(0);
  });
});

describe('a changed uidValidity', () => {
  it('discards the cursor, starts at the current uidNext, and writes the honest gap note', async () => {
    const env = await freshEnv();
    stub.addInbound({ from: 'a@lanternrow.invalid', subject: 'Before', text: 'x' });
    await syncMail(env.ctx);
    const before = cursorOf(env);
    expect(before).toBe(`${stub.uidValidity}:1`);

    // The server rebuilt the mailbox. Three messages arrive in it; none of them is read.
    stub.changeUidValidity();
    for (let index = 0; index < 3; index += 1) stub.addInbound({ from: `gap${index}@lanternrow.invalid`, subject: `Gap ${index}`, text: 'x' });
    const result = await syncMail(env.ctx);
    expect(result).toMatchObject({ messagesStored: 0, error: null });
    expect(cursorOf(env)).toBe(`${stub.uidValidity}:3`);
    expect(count(env, 'email_message')).toBe(1);
    const connector = getConnector(env.db, env.workspaceId, 'imap')!;
    expect(connector.status).toBe('connected');
    expect(connector.statusMessage).toBe(imapInboxResetNote);
    expect(imapInboxResetNote).toContain('Replies that arrived in between may not be shown here');

    // Mail that arrives after the reset is read normally.
    stub.addInbound({ from: 'later@lanternrow.invalid', subject: 'After', text: 'x' });
    expect((await syncMail(env.ctx)).messagesStored).toBe(1);
    expect(cursorOf(env)).toBe(`${stub.uidValidity}:4`);
  });

  it('treats a saved position it cannot read like a rebuilt mailbox', async () => {
    const env = await freshEnv();
    const settings = settingsOf(env);
    env.db.prepare("UPDATE connector SET settings = ? WHERE kind = 'imap'").run(JSON.stringify({ ...settings, inboxCursor: 'garbage' }));
    await syncMail(env.ctx);
    expect(cursorOf(env)).toBe(`${stub.uidValidity}:${stub.uidNext - 1}`);
    expect(getConnector(env.db, env.workspaceId, 'imap')!.statusMessage).toBe(imapInboxResetNote);
  });
});

describe('imap bounces', () => {
  async function sentTo(env: TestEnvironment, name: string, email: string) {
    const intentId = queueOne(env, name, email);
    await drain(env);
    const header = (env.db.prepare('SELECT message_id_header FROM send_intent WHERE id = ?').get(intentId) as { message_id_header: string }).message_id_header;
    return { intentId, header };
  }

  it.each(['rfc822', 'headers'] as const)('marks the intent bounced, suppresses the address, and creates a task when the returned %s carry our Message-ID', async (returned) => {
    const env = await freshEnv();
    const email = `ivo-${returned}@lanternrow.invalid`;
    const { intentId, header } = await sentTo(env, `Ivo${returned}`, email);
    stub.addBounce({ originalMessageId: header, to: email, returned });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    expect(env.db.prepare('SELECT email, reason FROM suppression').get()).toMatchObject({ email, reason: 'bounce' });
    expect(count(env, 'task', `title = 'Email to Ivo${returned} Testwell bounced'`)).toBe(1);
    // A bounce is not a reply.
    expect(count(env, 'task', "title LIKE 'Reply received%'")).toBe(0);
    expect(count(env, 'activity', "kind = 'email_in'")).toBe(0);
    await syncMail(env.ctx);
    expect(count(env, 'task', "title LIKE 'Email to%'")).toBe(1);
  });

  it('keeps a delay notice that returns our headers as an ordinary inbound message, and the later failure bounces', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Pip', 'pip@lanternrow.invalid');
    stub.addBounce({ originalMessageId: header, to: 'pip@lanternrow.invalid', kind: 'delay' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'suppression')).toBe(0);
    expect(count(env, 'task')).toBe(0);
    expect(count(env, 'email_message')).toBe(1);
    stub.addBounce({ originalMessageId: header, to: 'pip@lanternrow.invalid', kind: 'failure' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    expect(count(env, 'suppression')).toBe(1);
  });

  it.each(['delivered', 'relayed'] as const)('does not bounce on a %s notice', async (kind) => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, `Q${kind}`, `q-${kind}@lanternrow.invalid`);
    stub.addBounce({ originalMessageId: header, to: `q-${kind}@lanternrow.invalid`, kind });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'suppression')).toBe(0);
  });

  it('needs our Message-ID in the returned headers: a failure report without them, or with another id, is ordinary mail', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Rae', 'rae@lanternrow.invalid');
    stub.addBounce({ originalMessageId: header, to: 'rae@lanternrow.invalid', returned: 'none' });
    stub.addBounce({ originalMessageId: '<someone-elses@elsewhere.invalid>', to: 'rae@lanternrow.invalid' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'suppression')).toBe(0);
    expect(count(env, 'task')).toBe(0);
    expect(count(env, 'email_message')).toBe(2);
  });

  it('leaves a plain mailer daemon message without our Message-ID as ordinary inbound mail', async () => {
    const env = await freshEnv();
    const { intentId } = await sentTo(env, 'Sol', 'sol@lanternrow.invalid');
    stub.addBounce({ originalMessageId: '<x@y.invalid>', to: 'sol@lanternrow.invalid', plain: true });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'suppression')).toBe(0);
  });

  it('does not treat a person who quotes our Message-ID, or a display name that says mailer daemon, as a bounce', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Tia', 'tia@lanternrow.invalid');
    stub.addInbound({ from: 'tia@lanternrow.invalid', subject: 'Delivery failed?', text: `Your message ${header} could not be delivered to someone else.` });
    stub.addInbound({ from: 'MAILER-DAEMON <tia2@lanternrow.invalid>', subject: 'Undelivered mail', text: `could not be delivered ${header}` });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).not.toBe('bounced');
    expect(count(env, 'suppression')).toBe(0);
  });

  it('does not read a report of another type as a delivery status report', async () => {
    const env = await freshEnv();
    const { intentId, header } = await sentTo(env, 'Una', 'una@lanternrow.invalid');
    stub.addBounce({ originalMessageId: header, to: 'una@lanternrow.invalid', reportType: 'disposition-notification' });
    await syncMail(env.ctx);
    const row = env.db.prepare('SELECT subject FROM email_message').get() as { subject: string };
    expect(row.subject).toBe('Delivery Status Notification (Failure)');
    expect(statusOf(env, intentId)).toBe('accepted');
    expect(count(env, 'suppression')).toBe(0);
  });

  it('resolves an intent that was still unknown when the report proves the email went out', async () => {
    const env = await freshEnv();
    stub.sendScript.push({ type: 'ambiguous', accepted: true });
    const intentId = queueOne(env, 'Nia', 'nia@lanternrow.invalid');
    await drain(env);
    expect(statusOf(env, intentId)).toBe('unknown');
    const header = (env.db.prepare('SELECT message_id_header FROM send_intent WHERE id = ?').get(intentId) as { message_id_header: string }).message_id_header;
    stub.addBounce({ originalMessageId: header, to: 'nia@lanternrow.invalid' });
    await syncMail(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    env.advance(1500);
    const { processMailJobs } = await import('../src/jobs/worker.js');
    await processMailJobs(env.ctx);
    expect(statusOf(env, intentId)).toBe('bounced');
    expect(stub.sendCalls).toHaveLength(1);
  });
});
