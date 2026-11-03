import type { NormalizedInbound } from './mailTypes.js';

// The one seam between the IMAP and SMTP provider and the network. Everything the provider does to a mail server goes
// through this interface, so the whole send, reconcile, and sync pipeline is testable against a stub, and the real
// implementation (nodemailer for SMTP, imapflow for IMAP) stays small. Every method opens its own connection and closes
// it before it returns, because Fastmail rate limits logins.

export type SmtpTlsMode = 'tls' | 'starttls';

// What a transport needs to reach one mailbox. The password is in here, so a transport never logs it.
export interface MailServerSettings {
  // The sending address and the mailbox owner.
  address: string;
  imap: { host: string; port: number; username: string; password: string };
  smtp: { host: string; port: number; tls: SmtpTlsMode; username: string; password: string };
  // The mailbox that holds sent mail. Null only while connecting, before one was found.
  sentMailbox: string | null;
}

export interface MailboxInfo {
  path: string;
  name: string;
  // The RFC 6154 special use flag, such as \Sent, or null.
  specialUse: string | null;
}

export type FailureKind = 'auth' | 'network' | 'tls' | 'timeout' | 'other';

// A step that failed, in words that are safe to show. The password has been removed from the message.
export interface TransportFailure {
  kind: FailureKind;
  message: string;
}

export interface VerifyResult {
  imapOk: boolean;
  smtpOk: boolean;
  imapFailure: TransportFailure | null;
  smtpFailure: TransportFailure | null;
  mailboxes: MailboxInfo[];
  capabilities: {
    imap: string[];
    smtp: string[];
    // True or false when the server says whether its SMTP service saves its own copy to Sent. Neither provider
    // documents it and the protocols do not report it, so a real transport answers null.
    smtpStoresSentCopy: boolean | null;
  };
  // The Inbox position at the time of the check, so the first poll starts exactly there. Null when it was not read.
  inbox: { uidValidity: string; uidNext: number } | null;
}

export interface OutgoingMessage {
  settings: MailServerSettings;
  envelopeFrom: string;
  envelopeTo: string[];
  // The Message-ID header inside `raw`, saved on the intent before the session opens.
  messageId: string;
  // The complete message. The same bytes go to SMTP and, afterwards, to the Sent mailbox.
  raw: Buffer;
}

export interface SendAcceptance {
  // The server's final reply to the end of the message, such as "250 2.0.0 Ok: queued".
  response: string;
}

export type SendFailureOutcome =
  // Nothing was sent: the connection, the login, or the envelope failed before any message data left.
  | 'not_sent'
  // The server answered the message itself with a permanent (5xx) refusal.
  | 'rejected'
  // The message may have been received: the connection died or timed out after data started, or the final reply was
  // temporary or unreadable. Never treated as a failure and never sent again.
  | 'ambiguous';

export type TransportErrorKind = 'auth' | 'network' | 'tls' | 'timeout' | 'other';

export class TransportError extends Error {
  readonly kind: TransportErrorKind;

  constructor(kind: TransportErrorKind, message: string) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
  }
}

export class TransportSendError extends TransportError {
  readonly outcome: SendFailureOutcome;
  // The SMTP reply code, when the server sent one.
  readonly replyCode: number | null;

  constructor(outcome: SendFailureOutcome, kind: TransportErrorKind, message: string, replyCode: number | null = null) {
    super(kind, message);
    this.name = 'TransportSendError';
    this.outcome = outcome;
    this.replyCode = replyCode;
  }
}

// Where the Inbox poll stands. Both numbers come from the server.
export interface InboxCursor {
  uidValidity: string;
  lastSeenUid: number;
}

export interface InboxBatch {
  messages: NormalizedInbound[];
  // The position to save once `messages` are stored.
  cursor: InboxCursor;
  // More messages wait above this cursor.
  more: boolean;
  // The server's uidValidity no longer matched, so the old position was discarded and the cursor now sits at the
  // Inbox's current uidNext. Messages that arrived in between were not read.
  reset: boolean;
}

export interface ListInboxOptions {
  // At most this many messages in one batch.
  limit?: number;
}

export interface MailTransport {
  // Logs in over IMAP, lists mailboxes, reads the Inbox position and the capabilities, then logs in over SMTP. Each step
  // reports for itself, so one failing does not hide the other.
  verify(settings: MailServerSettings): Promise<VerifyResult>;
  // One SMTP session for one message. Resolves with the server's final reply. Throws a TransportSendError.
  send(message: OutgoingMessage): Promise<SendAcceptance>;
  // Searches the Sent mailbox for the Message-ID header: a partial match search, then an exact comparison of the headers
  // it returns. Read only. Throws a TransportError when the mailbox cannot be searched.
  searchSent(settings: MailServerSettings, messageId: string): Promise<{ found: boolean }>;
  // Appends the exact bytes to the Sent mailbox. Throws a TransportError.
  appendSent(settings: MailServerSettings, raw: Buffer): Promise<void>;
  // Inbox messages with a UID above the cursor, normalized. A null cursor starts at the Inbox's current position and
  // returns nothing.
  listNewInbox(settings: MailServerSettings, cursor: InboxCursor | null, options?: ListInboxOptions): Promise<InboxBatch>;
}

// ---------------------------------------------------------------------------------------------------------------
// Rules both implementations share, so the stub is tested against the same decisions as the real server.

export type InboxPlan =
  // No saved position: start at the present.
  | { action: 'initialize'; cursor: InboxCursor }
  // The mailbox was rebuilt (a different uidValidity): discard the position and start at the present.
  | { action: 'reset'; cursor: InboxCursor }
  // Fetch every UID above the position.
  | { action: 'fetch'; fromUid: number; cursor: InboxCursor };

export function planInboxFetch(cursor: InboxCursor | null, mailbox: { uidValidity: string; uidNext: number }): InboxPlan {
  const present: InboxCursor = { uidValidity: mailbox.uidValidity, lastSeenUid: Math.max(0, mailbox.uidNext - 1) };
  if (!cursor) return { action: 'initialize', cursor: present };
  if (cursor.uidValidity !== mailbox.uidValidity) return { action: 'reset', cursor: present };
  return { action: 'fetch', fromUid: cursor.lastSeenUid + 1, cursor };
}

// The cursor is saved in connector settings as one string, "uidValidity:lastSeenUid".
export function formatInboxCursor(cursor: InboxCursor): string {
  return `${cursor.uidValidity}:${cursor.lastSeenUid}`;
}

export function parseInboxCursor(value: string | null): InboxCursor | null {
  if (!value) return null;
  // UIDs are 32 bit and uidValidity fits in 20 digits; anything longer is corruption and resets the cursor.
  const match = /^(\d{1,20}):(\d{1,10})$/.exec(value);
  if (!match) return null;
  const lastSeenUid = Number(match[2]);
  if (!Number.isSafeInteger(lastSeenUid)) return null;
  return { uidValidity: match[1]!, lastSeenUid };
}

// The Sent mailbox: the one the server marks \Sent. Null when the server marks none.
export function findSentMailbox(mailboxes: MailboxInfo[]): string | null {
  return mailboxes.find((mailbox) => mailbox.specialUse?.toLowerCase() === '\\sent')?.path ?? null;
}

// Compares a Message-ID header the way the search needs: the angle brackets and case do not matter.
export function sameMessageId(left: string, right: string): boolean {
  const clean = (value: string): string => value.trim().replace(/^<|>$/g, '').toLowerCase();
  return clean(left) === clean(right) && clean(left) !== '';
}
