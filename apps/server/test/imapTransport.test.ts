import net from 'node:net';
import type { SMTPConnectionOptions } from 'nodemailer/lib/smtp-connection';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRawMessage } from '../src/providers/gmail.js';
import { appPasswordHints, imapUsernameFor, localPartOf, presetServers, smtpUsernameFor } from '../src/providers/imapPresets.js';
import { createImapSmtpMailProvider } from '../src/providers/imapSmtp.js';
import {
  findSentMailbox,
  formatInboxCursor,
  type MailServerSettings,
  parseInboxCursor,
  planInboxFetch,
  sameMessageId,
  TransportSendError,
} from '../src/providers/mailTransport.js';
import { decodePartText, headerValue, normalizeImapMessage, parseMime, readDeliveryReport } from '../src/providers/mime.js';
import { buildImapOptions, buildSmtpOptions, createRealMailTransport } from '../src/providers/realMailTransport.js';

function settingsFor(port = 2525): MailServerSettings {
  return {
    address: 'sender@example.test',
    imap: { host: 'imap.example.test', port: 993, username: 'sender', password: 'secret-pass-1' },
    smtp: { host: '127.0.0.1', port, tls: 'starttls', username: 'sender@example.test', password: 'secret-pass-1' },
    sentMailbox: 'Sent',
  };
}

describe('option mapping', () => {
  it('maps SMTP TLS modes: implicit TLS on 465, required STARTTLS on 587', () => {
    const tls = buildSmtpOptions({ ...settingsFor(), smtp: { ...settingsFor().smtp, host: 'smtp.fastmail.com', port: 465, tls: 'tls' } }, 5000);
    expect(tls).toMatchObject({ host: 'smtp.fastmail.com', port: 465, secure: true, requireTLS: false, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 15000, logger: false });
    const starttls = buildSmtpOptions({ ...settingsFor(), smtp: { ...settingsFor().smtp, host: 'smtp.mail.me.com', port: 587, tls: 'starttls' } }, 5000);
    expect(starttls).toMatchObject({ host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true });
    expect(starttls.tls).toMatchObject({ servername: 'smtp.mail.me.com', minVersion: 'TLSv1.2' });
    // The machine's own host name is never announced.
    expect(starttls.name).toBe('[127.0.0.1]');
  });

  it('maps IMAP to TLS from the first byte with the login, no logging, and no idle', () => {
    const options = buildImapOptions(settingsFor(), 4000);
    expect(options).toMatchObject({ host: 'imap.example.test', port: 993, secure: true, logger: false, disableAutoIdle: true, auth: { user: 'sender', pass: 'secret-pass-1' }, connectionTimeout: 4000 });
  });

  it('never puts the password in a log option', () => {
    expect(JSON.stringify({ ...buildSmtpOptions(settingsFor()), auth: undefined })).not.toContain('secret-pass-1');
  });

  it('presets fill the documented servers and logins', () => {
    expect(presetServers.icloud).toEqual({ imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpTls: 'starttls' });
    expect(presetServers.fastmail).toEqual({ imapHost: 'imap.fastmail.com', imapPort: 993, smtpHost: 'smtp.fastmail.com', smtpPort: 465, smtpTls: 'tls' });
    expect(imapUsernameFor('icloud', 'sam@icloud.com', null)).toBe('sam');
    expect(smtpUsernameFor('icloud', 'sam@icloud.com', null)).toBe('sam@icloud.com');
    expect(imapUsernameFor('fastmail', 'sam@fastmail.com', null)).toBe('sam@fastmail.com');
    expect(imapUsernameFor('custom', 'sam@example.test', 'login')).toBe('login');
    expect(localPartOf('a.b+c@x.test')).toBe('a.b+c');
    expect(appPasswordHints.fastmail).toContain('Basic plan');
    expect(appPasswordHints.icloud).toContain('Two-factor');
  });
});

describe('shared transport rules', () => {
  it('plans the Inbox fetch: initialize, reset on a changed uidValidity, otherwise fetch above the cursor', () => {
    const mailbox = { uidValidity: '10', uidNext: 8 };
    expect(planInboxFetch(null, mailbox)).toEqual({ action: 'initialize', cursor: { uidValidity: '10', lastSeenUid: 7 } });
    expect(planInboxFetch({ uidValidity: '9', lastSeenUid: 3 }, mailbox)).toEqual({ action: 'reset', cursor: { uidValidity: '10', lastSeenUid: 7 } });
    expect(planInboxFetch({ uidValidity: '10', lastSeenUid: 3 }, mailbox)).toEqual({ action: 'fetch', fromUid: 4, cursor: { uidValidity: '10', lastSeenUid: 3 } });
    expect(planInboxFetch(null, { uidValidity: '1', uidNext: 1 }).cursor.lastSeenUid).toBe(0);
  });

  it('saves the cursor as one string and refuses a malformed one', () => {
    expect(formatInboxCursor({ uidValidity: '123', lastSeenUid: 45 })).toBe('123:45');
    expect(parseInboxCursor('123:45')).toEqual({ uidValidity: '123', lastSeenUid: 45 });
    for (const bad of [null, '', 'x', '1:', ':1', '1:2:3', '-1:2']) expect(parseInboxCursor(bad)).toBeNull();
  });

  it('finds the Sent mailbox by its special use only, and compares Message-IDs exactly', () => {
    expect(findSentMailbox([{ path: 'INBOX', name: 'INBOX', specialUse: null }, { path: 'Sent Messages', name: 'Sent Messages', specialUse: '\\Sent' }])).toBe('Sent Messages');
    expect(findSentMailbox([{ path: 'Sent', name: 'Sent', specialUse: null }])).toBeNull();
    expect(sameMessageId('<AB@x.test>', ' <ab@x.test> ')).toBe(true);
    expect(sameMessageId('<ab@x.test>', '<xab@x.test>')).toBe(false);
    expect(sameMessageId('', '')).toBe(false);
  });
});

describe('reading messages', () => {
  it('decodes multipart alternatives, quoted-printable, base64, and charsets', () => {
    const raw = [
      'From: =?UTF-8?Q?Zo=C3=AB?= <zoe@example.test>',
      'To: a@example.test,',
      '  b@example.test',
      'Cc: c@example.test',
      'Subject: Hello',
      '  world',
      'Message-ID: <m1@example.test>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      'preamble',
      '--outer',
      'Content-Type: multipart/alternative; boundary=inner',
      '',
      '--inner',
      'Content-Type: text/plain; charset=iso-8859-1',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Caf=E9 =3D good',
      '--inner',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Html</p>',
      '--inner--',
      '--outer',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename=a.pdf',
      'Content-Transfer-Encoding: base64',
      '',
      'AAAA',
      '--outer--',
      '',
    ].join('\r\n');
    const message = normalizeImapMessage({ uid: 5, uidValidity: '77', internalDate: '2026-03-01T10:00:00.000Z', source: Buffer.from(raw) }, '2026-01-01T00:00:00.000Z');
    expect(message).toMatchObject({
      providerMessageId: 'imap:77:5',
      from: 'Zoë <zoe@example.test>',
      to: ['a@example.test', 'b@example.test', 'c@example.test'],
      subject: 'Hello world',
      text: 'Café = good',
      messageIdHeader: '<m1@example.test>',
      receivedAt: '2026-03-01T10:00:00.000Z',
      deliveryAction: null,
      unreadable: false,
    });
  });

  it('reads base64 text and falls back to the Date header, then the poll time', () => {
    const body = Buffer.from('Grüße', 'utf8').toString('base64');
    const raw = `From: a@example.test\r\nDate: Mon, 02 Mar 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n`;
    const dated = normalizeImapMessage({ uid: 1, uidValidity: '1', internalDate: null, source: Buffer.from(raw) }, '2026-01-01T00:00:00.000Z');
    expect(dated.text).toBe('Grüße');
    expect(dated.receivedAt).toBe('2026-03-02T10:00:00.000Z');
    const undated = normalizeImapMessage({ uid: 2, uidValidity: '1', internalDate: null, source: Buffer.from('From: a@example.test\r\n\r\nx') }, '2026-01-01T00:00:00.000Z');
    expect(undated.receivedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('survives a message cut short, an unknown charset, and garbage without throwing', () => {
    const cut = 'Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=nonsense-9\r\n\r\nPartial text';
    expect(normalizeImapMessage({ uid: 1, uidValidity: '1', internalDate: null, source: Buffer.from(cut) }, 'x').text).toBe('Partial text');
    expect(() => normalizeImapMessage({ uid: 2, uidValidity: '1', internalDate: null, source: Buffer.from([0, 1, 2, 255, 254]) }, 'x')).not.toThrow();
    expect(() => normalizeImapMessage({ uid: 3, uidValidity: '1', internalDate: null, source: Buffer.alloc(0) }, 'x')).not.toThrow();
  });

  it('threads on the first References entry, then In-Reply-To', () => {
    const withRefs = normalizeImapMessage({ uid: 1, uidValidity: '1', internalDate: null, source: Buffer.from('From: a@x.test\r\nIn-Reply-To: <c@x.test>\r\nReferences: <a@x.test> <b@x.test>\r\n\r\nx') }, 'x');
    expect(withRefs).toMatchObject({ threadId: '<a@x.test>', inReplyTo: '<c@x.test>', references: ['<a@x.test>', '<b@x.test>'] });
    const replyOnly = normalizeImapMessage({ uid: 2, uidValidity: '1', internalDate: null, source: Buffer.from('From: a@x.test\r\nIn-Reply-To: <c@x.test>\r\n\r\nx') }, 'x');
    expect(replyOnly.threadId).toBe('<c@x.test>');
    expect(normalizeImapMessage({ uid: 3, uidValidity: '1', internalDate: null, source: Buffer.from('From: a@x.test\r\n\r\nx') }, 'x').threadId).toBeNull();
  });

  it('reads a delivery status report: actions, with failed winning, and the returned headers', () => {
    const raw = [
      'From: MAILER-DAEMON@example.test',
      'Content-Type: multipart/report; report-type=delivery-status; boundary=r',
      '',
      '--r',
      'Content-Type: text/plain',
      '',
      'Could not deliver.',
      '--r',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; example.test',
      '',
      'Final-Recipient: rfc822; a@x.test',
      'Action: delayed',
      '',
      'Final-Recipient: rfc822; b@x.test',
      'Action: failed',
      '',
      '--r',
      'Content-Type: text/rfc822-headers',
      '',
      'Message-ID: <orig@x.test>',
      '',
      '--r--',
      '',
    ].join('\r\n');
    const report = readDeliveryReport(parseMime(Buffer.from(raw)));
    expect(report).toMatchObject({ isDeliveryStatus: true, actions: ['delayed', 'failed'] });
    expect(report.evidence.join('\n')).toContain('<orig@x.test>');
    const message = normalizeImapMessage({ uid: 1, uidValidity: '1', internalDate: null, source: Buffer.from(raw) }, 'x');
    expect(message.deliveryAction).toBe('failed');
    expect(message.evidenceText).toContain('<orig@x.test>');
    expect(message.text).toBe('Could not deliver.');
  });

  it('reads headers case insensitively and decodes parts by their own charset', () => {
    const part = parseMime(Buffer.from('content-type: text/plain; charset="windows-1252"\r\nX-Thing: 1\r\n\r\ncaf\xe9', 'latin1'));
    expect(headerValue(part, 'X-THING')).toBe('1');
    expect(decodePartText(part)).toBe('café');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real SMTP path against a local socket that speaks just enough SMTP.

interface SmtpScript {
  auth?: 'ok' | 'fail';
  greeting?: 'silent';
  greetingDelayMs?: number;
  rcpt?: string;
  finalReply?: string | 'drop' | 'silent';
  dropWhileReceiving?: boolean;
}

interface Received {
  from: string;
  to: string[];
  data: Buffer;
}

function startSmtp(script: SmtpScript = {}): Promise<{ port: number; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = Buffer.alloc(0);
    let inData = false;
    let current: Received = { from: '', to: [], data: Buffer.alloc(0) };
    if (script.greeting !== 'silent') {
      if (script.greetingDelayMs) {
        const timer = setTimeout(() => {
          if (!socket.destroyed) socket.write('220 test ESMTP\r\n');
        }, script.greetingDelayMs);
        socket.on('close', () => clearTimeout(timer));
      } else {
        socket.write('220 test ESMTP\r\n');
      }
    }
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (inData) {
          if (script.dropWhileReceiving) {
            socket.destroy();
            return;
          }
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = Buffer.from(buffer.subarray(0, end + 2));
          buffer = buffer.subarray(end + 5);
          inData = false;
          received.push(current);
          if (script.finalReply === 'drop') socket.destroy();
          else if (script.finalReply !== 'silent') socket.write(`${script.finalReply ?? '250 2.0.0 Ok: queued as TEST1'}\r\n`);
          continue;
        }
        const newline = buffer.indexOf('\r\n');
        if (newline < 0) return;
        const line = buffer.subarray(0, newline).toString('latin1');
        buffer = buffer.subarray(newline + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) socket.write('250-test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        else if (upper.startsWith('AUTH')) socket.write(script.auth === 'fail' ? '535 5.7.8 Authentication credentials invalid\r\n' : '235 2.7.0 Authentication successful\r\n');
        else if (upper.startsWith('MAIL FROM')) {
          current = { from: line.slice(10).replace(/[<>]/g, '').trim().split(' ')[0]!, to: [], data: Buffer.alloc(0) };
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          const reply = script.rcpt ?? '250 2.1.5 Ok';
          if (reply.startsWith('2')) current.to.push(line.slice(8).replace(/[<>]/g, '').trim().split(' ')[0]!);
          socket.write(`${reply}\r\n`);
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else if (upper === 'RSET') socket.write('250 Ok\r\n');
        else socket.write('502 Not implemented\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        received,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const plainSmtp = (options: SMTPConnectionOptions): SMTPConnectionOptions => ({ ...options, secure: false, requireTLS: false, ignoreTLS: true, tls: undefined });
const realTransport = () => createRealMailTransport({ smtpOptions: plainSmtp });
const messageId = '<ac-snd_test-0123456789ab@example.test>';

function outgoing(port: number) {
  const raw = Buffer.from(
    composeRawMessage({ from: 'sender@example.test', to: 'rcpt@example.test', subject: 'Hello', body: 'Line one\n.dot line\nLine three', messageId, date: new Date('2026-03-01T09:00:00Z') }),
    'utf8',
  );
  return { settings: settingsFor(port), envelopeFrom: 'sender@example.test', envelopeTo: ['rcpt@example.test'], messageId, raw };
}

describe('the real SMTP send', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    delete process.env.AGENTCRM_IMAP_TIMEOUT_MS;
    for (const close of closers.splice(0)) await close();
  });
  const server = async (script?: SmtpScript) => {
    const started = await startSmtp(script);
    closers.push(started.close);
    return started;
  };

  it('delivers the exact bytes with the saved Message-ID and returns the final reply', async () => {
    const smtp = await server();
    const message = outgoing(smtp.port);
    const result = await realTransport().send(message);
    expect(result.response).toBe('250 2.0.0 Ok: queued as TEST1');
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0]).toMatchObject({ from: 'sender@example.test', to: ['rcpt@example.test'] });
    // The server sees the same bytes, with the dot stuffed line restored by the server side rule.
    expect(smtp.received[0]!.data.toString('latin1').replace(/\r\n\.\./g, '\r\n.')).toBe(message.raw.toString('latin1'));
    expect(headerValue(parseMime(smtp.received[0]!.data), 'message-id')).toBe(messageId);
  });

  it('reuses one Message-ID for the SMTP bytes and the Sent copy, byte for byte', async () => {
    const smtp = await server();
    const appended: Buffer[] = [];
    const real = realTransport();
    const transport = { ...real, appendSent: async (_settings: MailServerSettings, raw: Buffer) => void appended.push(raw) };
    const provider = createImapSmtpMailProvider({ settings: settingsFor(smtp.port), transport, smtpStoresSentCopy: false, now: () => Date.parse('2026-03-01T09:00:00Z') });
    const result = await provider.submit(
      { intentId: 'snd_test', accountId: 'sender@example.test', fromAddress: 'sender@example.test', to: 'rcpt@example.test', subject: 'Hello', body: 'Body', messageIdHeader: messageId, replyTo: null },
      { beforeSend: () => null },
    );
    expect(result).toMatchObject({ messageId, threadId: messageId });
    expect(appended).toHaveLength(1);
    expect(smtp.received[0]!.data.toString('latin1')).toBe(appended[0]!.toString('latin1'));
    expect(headerValue(parseMime(appended[0]!), 'message-id')).toBe(messageId);
    // Assembling the same intent again gives the same bytes: nothing about the Message-ID is regenerated.
    const again = composeRawMessage({ from: 'sender@example.test', to: 'rcpt@example.test', subject: 'Hello', body: 'Body', messageId, date: new Date('2026-03-01T09:00:00Z') });
    expect(Buffer.from(again).equals(appended[0]!)).toBe(true);
  });

  async function outcomeOf(script: SmtpScript, prepare?: () => void) {
    const smtp = await server(script);
    prepare?.();
    try {
      await realTransport().send(outgoing(smtp.port));
    } catch (error) {
      expect(error).toBeInstanceOf(TransportSendError);
      return { error: error as TransportSendError, smtp };
    }
    throw new Error('The send was expected to fail.');
  }

  it('treats a permanent 5xx reply to the message as a rejection with the server sentence', async () => {
    const { error } = await outcomeOf({ finalReply: '550 5.7.1 Message rejected as spam' });
    expect(error).toMatchObject({ outcome: 'rejected', replyCode: 550 });
    expect(error.message).toContain('550 5.7.1 Message rejected as spam');
  });

  it('treats a permanent refusal of the recipient as a rejection, and a temporary one as nothing sent', async () => {
    expect((await outcomeOf({ rcpt: '550 5.1.1 No such user' })).error).toMatchObject({ outcome: 'rejected', replyCode: 550 });
    const temporary = (await outcomeOf({ rcpt: '451 4.7.1 Greylisted, try later' })).error;
    expect(temporary).toMatchObject({ outcome: 'not_sent', replyCode: 451 });
  });

  it('treats a login refusal as a rejection of kind auth, with the password removed', async () => {
    const { error } = await outcomeOf({ auth: 'fail' });
    expect(error).toMatchObject({ outcome: 'rejected', kind: 'auth' });
    expect(error.message).not.toContain('secret-pass-1');
  });

  it('treats a refused connection as nothing sent', async () => {
    const closed = await startSmtp();
    const port = closed.port;
    await closed.close();
    await expect(realTransport().send(outgoing(port))).rejects.toMatchObject({ outcome: 'not_sent', kind: 'network' });
  });

  it('treats a connection that dies before the final reply as ambiguous', async () => {
    const { error, smtp } = await outcomeOf({ finalReply: 'drop' });
    expect(error.outcome).toBe('ambiguous');
    // The server really received it: this is exactly the case that must never be resent.
    expect(smtp.received).toHaveLength(1);
  });

  it('treats a connection that dies while the message is on the wire as ambiguous', async () => {
    expect((await outcomeOf({ dropWhileReceiving: true })).error.outcome).toBe('ambiguous');
  });

  it('treats a temporary reply to the end of the message as ambiguous, not as a failure', async () => {
    const { error } = await outcomeOf({ finalReply: '451 4.3.0 Try again later' });
    expect(error).toMatchObject({ outcome: 'ambiguous', replyCode: 451 });
  });

  it('treats a final reply that never comes as an ambiguous timeout', async () => {
    process.env.AGENTCRM_IMAP_TIMEOUT_MS = '250';
    const { error } = await outcomeOf({ finalReply: 'silent' });
    expect(error.outcome).toBe('ambiguous');
  });

  it('treats a server that never greets as nothing sent', async () => {
    process.env.AGENTCRM_IMAP_TIMEOUT_MS = '250';
    const { error } = await outcomeOf({ greeting: 'silent' });
    expect(error.outcome).toBe('not_sent');
  });

  it('never lets a send abandoned while connecting go out once the slow server wakes up', async () => {
    // The deadline fires while the session is still opening. The verdict is "not sent", and that verdict
    // must stay true: when the greeting finally arrives, the client closes instead of sending.
    process.env.AGENTCRM_IMAP_TIMEOUT_MS = '150';
    const smtp = await server({ greetingDelayMs: 1200 });
    const message = outgoing(smtp.port);
    await expect(realTransport().send(message)).rejects.toMatchObject({ outcome: 'not_sent', kind: 'timeout' });
    // Give the late greeting time to land and any wrongly surviving session time to transmit.
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(smtp.received).toHaveLength(0);
    await smtp.close();
  });

  it('verifies the SMTP login and reports a refusal on its own', async () => {
    const good = await server();
    const ok = await realTransport().verify({ ...settingsFor(good.port), imap: { ...settingsFor().imap, host: '127.0.0.1', port: 1 } });
    expect(ok.smtpOk).toBe(true);
    expect(ok.capabilities.smtp).toContain('8BITMIME');
    expect(ok.imapOk).toBe(false);
    expect(ok.imapFailure?.kind).toBe('network');
    const bad = await server({ auth: 'fail' });
    const refused = await realTransport().verify({ ...settingsFor(bad.port), imap: { ...settingsFor().imap, host: '127.0.0.1', port: 1 } });
    expect(refused.smtpOk).toBe(false);
    expect(refused.smtpFailure?.kind).toBe('auth');
    expect(refused.smtpFailure?.message).not.toContain('secret-pass-1');
  });
});
