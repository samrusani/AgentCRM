import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import SMTPConnection, { type SMTPConnectionOptions } from 'nodemailer/lib/smtp-connection';
import { imapStepTimeoutMilliseconds } from '../config.js';
import {
  type FailureKind,
  type InboxBatch,
  type InboxCursor,
  type ListInboxOptions,
  type MailboxInfo,
  type MailServerSettings,
  type MailTransport,
  type OutgoingMessage,
  planInboxFetch,
  sameMessageId,
  type SendAcceptance,
  TransportError,
  type TransportErrorKind,
  type TransportFailure,
  TransportSendError,
  type VerifyResult,
} from './mailTransport.js';
import { headerValue, normalizeImapMessage, parseMime } from './mime.js';

// The real transport: nodemailer's SMTP connection for sending and imapflow for IMAP. One connection per operation, and
// the connection is closed before the operation returns. This is verified here by unit tests of the option mapping and
// the SMTP outcome rules against a local SMTP socket, and not against live iCloud or Fastmail servers.

const defaultInboxBatch = 25;
// A message larger than this is read only as far as this many bytes. The text and headers are at the start.
const maxMessageBytes = 2_000_000;
const smtpEhloName = '[127.0.0.1]';

type Json = Record<string, unknown>;

function scrub(message: string, secrets: readonly string[]): string {
  let result = message;
  for (const secret of secrets) if (secret.length > 0) result = result.replaceAll(secret, '[removed]');
  return result;
}

function errorFields(error: unknown): { code: string; message: string; responseText: string; responseCode: number | null; authenticationFailed: boolean } {
  const record: Json = typeof error === 'object' && error !== null ? (error as Json) : {};
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const responseCode = typeof record.responseCode === 'number' ? record.responseCode : null;
  return {
    code: text(record.code),
    message: error instanceof Error ? error.message : text(error),
    responseText: text(record.responseText) || text(record.response),
    responseCode,
    authenticationFailed: record.authenticationFailed === true,
  };
}

const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNECTION', 'ESOCKET', 'EDNS', 'NoConnection', 'EConnectionClosed', 'ClosedAfterConnectText', 'ClosedAfterConnectTLS']);
const timeoutCodes = new Set(['ETIMEDOUT', 'ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'ETIMEDOUT']);

function kindOf(error: unknown): TransportErrorKind {
  const fields = errorFields(error);
  if (fields.authenticationFailed || fields.code === 'EAUTH' || fields.code === 'ENOAUTH') return 'auth';
  if (fields.responseCode !== null && [530, 534, 535, 538].includes(fields.responseCode)) return 'auth';
  if (timeoutCodes.has(fields.code)) return 'timeout';
  if (fields.code === 'ETLS' || fields.code === 'EREQUIRETLS' || /^ERR_(TLS|SSL)|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(fields.code)) return 'tls';
  if (networkCodes.has(fields.code)) return 'network';
  return 'other';
}

// The server's own sentence when it gave one, otherwise the library's message.
function sentenceOf(error: unknown, secrets: readonly string[]): string {
  const fields = errorFields(error);
  const text = fields.responseText || fields.message || 'The server did not say why.';
  return scrub(text, secrets).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function toFailure(error: unknown, secrets: readonly string[]): TransportFailure {
  return { kind: kindOf(error) as FailureKind, message: sentenceOf(error, secrets) };
}

function toTransportError(error: unknown, secrets: readonly string[]): TransportError {
  if (error instanceof TransportError) return error;
  return new TransportError(kindOf(error), sentenceOf(error, secrets));
}

// A server sentence could echo the password in a transformed shape; scrub the common encodings too.
function secretForms(password: string): string[] {
  const forms = [password, Buffer.from(password, 'utf8').toString('base64'), encodeURIComponent(password)];
  return [...new Set(forms.filter((form) => form.length > 0))];
}

function withDeadline<T>(milliseconds: number, work: Promise<T>, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), milliseconds);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Option mapping

export function buildSmtpOptions(settings: MailServerSettings, stepTimeoutMilliseconds = imapStepTimeoutMilliseconds()): SMTPConnectionOptions {
  const { smtp } = settings;
  return {
    host: smtp.host,
    port: smtp.port,
    // TLS from the first byte on 465. On 587 the session starts in the clear and is upgraded, and it fails rather than
    // continue in the clear when the server will not upgrade.
    secure: smtp.tls === 'tls',
    requireTLS: smtp.tls === 'starttls',
    name: smtpEhloName,
    connectionTimeout: stepTimeoutMilliseconds,
    greetingTimeout: stepTimeoutMilliseconds,
    // The server may take several steps' time to answer the end of the message (spam checks), so the idle limit is wider.
    socketTimeout: stepTimeoutMilliseconds * 3,
    logger: false,
    tls: { ...(isIP(smtp.host) ? {} : { servername: smtp.host }), minVersion: 'TLSv1.2' },
  };
}

export function buildImapOptions(settings: MailServerSettings, stepTimeoutMilliseconds = imapStepTimeoutMilliseconds()): ImapFlowOptions {
  const { imap } = settings;
  return {
    host: imap.host,
    port: imap.port,
    // IMAP always uses TLS from the first byte (port 993 for both presets).
    secure: true,
    auth: { user: imap.username, pass: imap.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: stepTimeoutMilliseconds,
    greetingTimeout: stepTimeoutMilliseconds,
    socketTimeout: stepTimeoutMilliseconds * 2,
    tls: { ...(isIP(imap.host) ? {} : { servername: imap.host }), minVersion: 'TLSv1.2' },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// SMTP

interface SmtpSession {
  connection: SMTPConnection;
  dispose: () => void;
}

export interface RealTransportHooks {
  // Tests point the SMTP side at a local plain text socket by changing its options here.
  smtpOptions?: (options: SMTPConnectionOptions) => SMTPConnectionOptions;
}

export function createRealMailTransport(hooks: RealTransportHooks = {}): MailTransport {
  const smtpOptionsFor = (settings: MailServerSettings): SMTPConnectionOptions => {
    const options = buildSmtpOptions(settings);
    return hooks.smtpOptions ? hooks.smtpOptions(options) : options;
  };

  function openSmtp(settings: MailServerSettings): Promise<SmtpSession> {
    const connection = new SMTPConnection(smtpOptionsFor(settings));
    return new Promise<SmtpSession>((resolve, reject) => {
      let open = false;
      // A failure to connect arrives as an 'error' event and not through the connect callback. Once the session is open,
      // a failure reaches the callback of the command that was waiting, so the event is only noted.
      connection.on('error', (error: unknown) => {
        if (open) return;
        connection.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      connection.connect((error) => {
        if (error) {
          connection.close();
          reject(error);
          return;
        }
        connection.login({ user: settings.smtp.username, pass: settings.smtp.password }, (loginError) => {
          if (loginError) {
            connection.close();
            reject(loginError);
            return;
          }
          open = true;
          resolve({ connection, dispose: () => connection.close() });
        });
      });
    });
  }

  async function withImap<T>(settings: MailServerSettings, work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const secrets = secretForms(settings.imap.password);
    const step = imapStepTimeoutMilliseconds();
    const client = new ImapFlow(buildImapOptions(settings, step));
    client.on('error', () => undefined);
    try {
      await withDeadline(step * 2, client.connect(), () => new TransportError('timeout', 'The IMAP server did not answer in time.'));
      return await withDeadline(step * 2, work(client), () => new TransportError('timeout', 'The IMAP server did not answer in time.'));
    } catch (error) {
      throw toTransportError(error, secrets);
    } finally {
      try {
        await withDeadline(step, client.logout(), () => new Error('logout timed out'));
      } catch {
        client.close();
      }
    }
  }

  async function verifyImap(settings: MailServerSettings): Promise<Pick<VerifyResult, 'imapOk' | 'imapFailure' | 'mailboxes'> & { imapCapabilities: string[]; inbox: VerifyResult['inbox'] }> {
    const secrets = secretForms(settings.imap.password);
    const step = imapStepTimeoutMilliseconds();
    const client = new ImapFlow(buildImapOptions(settings, step));
    client.on('error', () => undefined);
    try {
      await withDeadline(step * 2, client.connect(), () => new TransportError('timeout', 'The IMAP server did not answer in time.'));
    } catch (error) {
      client.close();
      return { imapOk: false, imapFailure: toFailure(error, secrets), mailboxes: [], imapCapabilities: [], inbox: null };
    }
    try {
      return await withDeadline(
        step * 3,
        (async () => {
          const listed = await client.list();
          const mailboxes: MailboxInfo[] = listed.map((mailbox) => ({ path: mailbox.path, name: mailbox.name, specialUse: mailbox.specialUse ?? null }));
          const imapCapabilities = [...client.capabilities.keys()];
          let inbox: VerifyResult['inbox'] = null;
          try {
            const status = await client.status('INBOX', { uidNext: true, uidValidity: true });
            if (status && status.uidValidity !== undefined && status.uidNext !== undefined) {
              inbox = { uidValidity: status.uidValidity.toString(), uidNext: status.uidNext };
            }
          } catch {
            // The position is read again by the first poll.
          }
          return { imapOk: true, imapFailure: null, mailboxes, imapCapabilities, inbox };
        })(),
        () => new TransportError('timeout', 'The IMAP server did not answer in time.'),
      );
    } catch (error) {
      return { imapOk: false, imapFailure: toFailure(error, secrets), mailboxes: [], imapCapabilities: [], inbox: null };
    } finally {
      try {
        await withDeadline(step, client.logout(), () => new Error('logout timed out'));
      } catch {
        client.close();
      }
    }
  }

  async function verifySmtp(settings: MailServerSettings): Promise<{ smtpOk: boolean; smtpFailure: TransportFailure | null; smtpCapabilities: string[] }> {
    const secrets = secretForms(settings.smtp.password);
    const step = imapStepTimeoutMilliseconds();
    // A session that finishes opening after the deadline fired must not be left running.
    let abandoned = false;
    const opening = openSmtp(settings);
    opening
      .then((session) => {
        if (!abandoned) return;
        try {
          session.connection.close();
        } catch {
          // Already closed.
        }
        session.dispose();
      })
      .catch(() => {
        // The failure is reported through the deadline path below.
      });
    try {
      const session = await withDeadline(step * 5, opening, () => new TransportError('timeout', 'The SMTP server did not answer in time.'));
      const extensions = (session.connection as unknown as { _supportedExtensions?: unknown })._supportedExtensions;
      const smtpCapabilities = Array.isArray(extensions) ? extensions.filter((item): item is string => typeof item === 'string') : [];
      session.connection.quit();
      session.dispose();
      return { smtpOk: true, smtpFailure: null, smtpCapabilities };
    } catch (error) {
      abandoned = true;
      return { smtpOk: false, smtpFailure: toFailure(error, secrets), smtpCapabilities: [] };
    }
  }

  return {
    async verify(settings): Promise<VerifyResult> {
      const imap = await verifyImap(settings);
      const smtp = await verifySmtp(settings);
      return {
        imapOk: imap.imapOk,
        smtpOk: smtp.smtpOk,
        imapFailure: imap.imapFailure,
        smtpFailure: smtp.smtpFailure,
        mailboxes: imap.mailboxes,
        capabilities: { imap: imap.imapCapabilities, smtp: smtp.smtpCapabilities, smtpStoresSentCopy: null },
        inbox: imap.inbox,
      };
    },

    // One SMTP session for one message. What the failure says about the message:
    //   before the first byte of message data leaves (connection, login, MAIL FROM, RCPT TO, DATA): nothing was sent;
    //   a permanent (5xx) reply at any step: the server refused it;
    //   anything else once data started (the connection died, a timeout, a temporary reply to the end of the message,
    //   an unreadable reply): the server may have the message, so the outcome is ambiguous.
    async send(message: OutgoingMessage): Promise<SendAcceptance> {
      const { settings } = message;
      const secrets = secretForms(settings.smtp.password);
      const step = imapStepTimeoutMilliseconds();
      let dataStarted = false;
      // When the deadline fires while the session is still opening, there is no connection to close yet.
      // The abandoned flag keeps the promise made to the caller: after a "not sent" verdict, the message
      // must never leave, even if the server finishes opening the session later.
      let abandoned = false;
      const held: { connection: SMTPConnection | null; dispose: (() => void) | null } = { connection: null, dispose: null };
      const abort = (): void => {
        abandoned = true;
        try {
          held.connection?.close();
        } catch {
          // Already closed.
        }
        try {
          held.dispose?.();
        } catch {
          // Already disposed.
        }
      };
      if (message.envelopeTo.length !== 1) {
        throw new TransportSendError('not_sent', 'other', 'Exactly one recipient is sent per message.', null);
      }
      const fail = (error: unknown): TransportSendError => {
        const fields = errorFields(error);
        const sentence = sentenceOf(error, secrets);
        const kind = kindOf(error);
        const permanent = fields.responseCode !== null && fields.responseCode >= 500 && fields.responseCode < 600;
        if (permanent) return new TransportSendError('rejected', kind, sentence, fields.responseCode);
        if (!dataStarted) return new TransportSendError('not_sent', kind, sentence, fields.responseCode);
        return new TransportSendError('ambiguous', kind, sentence, fields.responseCode);
      };
      const work = (async (): Promise<SendAcceptance> => {
        const session = await openSmtp(settings);
        held.connection = session.connection;
        held.dispose = session.dispose;
        // The deadline may have fired while the session was opening. Close it and send nothing, so the
        // "not sent" verdict the caller already recorded stays true.
        if (abandoned) {
          try {
            session.connection.close();
          } catch {
            // Already closed.
          }
          session.dispose();
          throw new TransportSendError('not_sent', 'timeout', 'The SMTP server did not answer in time.', null);
        }
        return new Promise<SendAcceptance>((resolve, reject) => {
          // The stream is read only after the server accepted DATA, so reading it marks the start of message data.
          let pushed = false;
          const body = new Readable({
            read() {
              dataStarted = true;
              if (pushed) return;
              pushed = true;
              this.push(message.raw);
              this.push(null);
            },
          });
          session.connection.send({ from: message.envelopeFrom, to: message.envelopeTo }, body, (error, info) => {
            if (error) {
              reject(error);
              return;
            }
            const report = info as { response?: unknown; rejected?: unknown } | undefined;
            const rejected = Array.isArray(report?.rejected) ? report.rejected : [];
            if (rejected.length > 0) {
              // The server took the data but refused a recipient. With one recipient this should surface as an
              // error instead; treat the surprise as an unclear outcome rather than guessing either way.
              reject(new TransportSendError('ambiguous', 'other', 'The server reported a refused recipient after taking the message.', null));
              return;
            }
            resolve({ response: String(report?.response ?? '').trim() });
          });
        });
      })();
      try {
        const accepted = await withDeadline(step * 5, work, () => new TransportSendError(dataStarted ? 'ambiguous' : 'not_sent', 'timeout', 'The SMTP server did not answer in time.'));
        try {
          held.connection?.quit();
        } catch {
          // The message is accepted; closing politely is a courtesy.
        }
        return accepted;
      } catch (error) {
        throw error instanceof TransportSendError ? error : fail(error);
      } finally {
        abort();
      }
    },

    async searchSent(settings, messageId): Promise<{ found: boolean }> {
      const sent = settings.sentMailbox;
      if (!sent) throw new TransportError('other', 'No Sent mailbox is saved for this account.');
      return withImap(settings, async (client) => {
        const lock = await client.getMailboxLock(sent, { readOnly: true });
        try {
          const core = messageId.trim().replace(/^<|>$/g, '');
          // IMAP's header search is a substring match, so each hit is compared exactly below.
          const hits = await client.search({ header: { 'message-id': core } }, { uid: true });
          if (!hits || hits.length === 0) return { found: false };
          const uids = hits.slice(-20);
          const fetched = await client.fetchAll(uids.join(','), { uid: true, headers: ['message-id'] }, { uid: true });
          for (const item of fetched) {
            if (!item.headers) continue;
            const value = headerValue(parseMime(item.headers), 'message-id');
            if (value && sameMessageId(value, messageId)) return { found: true };
          }
          return { found: false };
        } finally {
          lock.release();
        }
      });
    },

    async appendSent(settings, raw): Promise<void> {
      const sent = settings.sentMailbox;
      if (!sent) throw new TransportError('other', 'No Sent mailbox is saved for this account.');
      await withImap(settings, async (client) => {
        const result = await client.append(sent, raw, ['\\Seen']);
        if (!result) throw new TransportError('other', 'The server did not accept the copy for the Sent mailbox.');
      });
    },

    async listNewInbox(settings, cursor: InboxCursor | null, options: ListInboxOptions = {}): Promise<InboxBatch> {
      const limit = Math.max(1, options.limit ?? defaultInboxBatch);
      return withImap(settings, async (client) => {
        const lock = await client.getMailboxLock('INBOX', { readOnly: true });
        try {
          const mailbox = client.mailbox;
          if (!mailbox) throw new TransportError('other', 'The Inbox could not be opened.');
          if (mailbox.uidValidity === undefined || !Number.isSafeInteger(mailbox.uidNext)) {
            throw new TransportError('other', 'The server did not report the Inbox position.');
          }
          const plan = planInboxFetch(cursor, { uidValidity: mailbox.uidValidity.toString(), uidNext: mailbox.uidNext });
          if (plan.action !== 'fetch') return { messages: [], cursor: plan.cursor, more: false, reset: plan.action === 'reset' };
          // "n:*" always includes the newest message even when its UID is below n, so the result is filtered.
          const found = await client.search({ uid: `${plan.fromUid}:*` }, { uid: true });
          const uids = (found || []).filter((uid) => uid >= plan.fromUid).sort((a, b) => a - b);
          if (uids.length === 0) return { messages: [], cursor: plan.cursor, more: false, reset: false };
          const wanted = uids.slice(0, limit);
          const fallback = new Date().toISOString();
          const messages = [];
          const byUid = new Map<number, Awaited<ReturnType<ImapFlow['fetchAll']>>[number]>();
          for await (const item of client.fetch(wanted.join(','), { uid: true, internalDate: true, source: { maxLength: maxMessageBytes } }, { uid: true })) {
            byUid.set(item.uid, item);
          }
          for (const uid of wanted) {
            const item = byUid.get(uid);
            const source = item?.source;
            if (!item || !source) {
              messages.push({
                providerMessageId: `imap:${plan.cursor.uidValidity}:${uid}`,
                threadId: null,
                direction: 'in' as const,
                from: '',
                to: [],
                subject: '',
                preview: '',
                labels: [],
                text: null,
                replyText: '',
                messageIdHeader: null,
                inReplyTo: null,
                references: [],
                evidenceText: '',
                deliveryAction: null,
                receivedAt: fallback,
                unreadable: true,
              });
              continue;
            }
            messages.push(normalizeImapMessage({ uid, uidValidity: plan.cursor.uidValidity, internalDate: item.internalDate ?? null, source }, fallback));
          }
          const last = wanted[wanted.length - 1]!;
          return { messages, cursor: { uidValidity: plan.cursor.uidValidity, lastSeenUid: last }, more: uids.length > wanted.length, reset: false };
        } finally {
          lock.release();
        }
      });
    },
  };
}
