import {
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
  TransportSendError,
  type VerifyResult,
} from './mailTransport.js';
import { headerValue, normalizeImapMessage, parseMime } from './mime.js';

// A deterministic in process mail server behind the transport seam. The test suite uses it as its stub, and the server
// uses it when AGENTCRM_IMAP_FAKE=1, so the whole browser flow can run without a real account. It speaks no protocol:
// it keeps an Inbox, a Sent mailbox, and a list of what its SMTP side accepted, and every outcome the real servers can
// produce is a knob.

export type SendStep =
  // The SMTP side accepts the message.
  | { type: 'accept' }
  // The server refuses the message with a permanent reply.
  | { type: 'reject'; code: number; text: string }
  // Nothing was sent: the connection, login, or envelope failed. `kind` and `code` refine how it is classed.
  | { type: 'not_sent'; text: string; kind?: 'network' | 'auth' | 'timeout'; code?: number }
  // The connection died before the final reply. `accepted` says whether the server really kept the message.
  | { type: 'ambiguous'; accepted: boolean; text?: string };

export interface StoredMessage {
  uid: number;
  raw: Buffer;
  internalDate: string;
}

export interface FakeSent {
  messageId: string;
  envelopeFrom: string;
  envelopeTo: string[];
  raw: Buffer;
  settingsSeen: MailServerSettings;
}

export interface FakeKnobs {
  // Whether the SMTP service saves its own copy of what it accepts into the Sent mailbox.
  sentAutoSave: boolean;
  // What verify reports about it: true, false, or null for unknown (a real server never says).
  reportsStoredCopy: boolean | null;
  // IMAP APPEND to Sent fails with this sentence.
  appendFailure: string | null;
  // The Sent search fails with this sentence.
  searchFailure: string | null;
  // The Inbox poll fails with this sentence. `listFailureKind` is how the failure is classed ('auth' marks the
  // connector as needing the password again).
  listFailure: string | null;
  listFailureKind: 'network' | 'auth' | 'timeout';
  // verify() fails these steps. Set by hand, or by the password rule below.
  imapLoginFailure: string | null;
  smtpFailure: string | null;
  // No mailbox carries the \Sent flag.
  noSentMailbox: boolean;
  mailboxes: MailboxInfo[];
  capabilities: { imap: string[]; smtp: string[] };
}

export const defaultFakeMailboxes: MailboxInfo[] = [
  { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
  { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts' },
  { path: 'Sent', name: 'Sent', specialUse: '\\Sent' },
  { path: 'Trash', name: 'Trash', specialUse: '\\Trash' },
  { path: 'Archive', name: 'Archive', specialUse: null },
];

export interface FakeInbound {
  from: string;
  to?: string;
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  date?: string;
}

export interface FakeBounce {
  // The Message-ID of the message the report is about.
  originalMessageId: string;
  to: string;
  kind?: 'failure' | 'delay' | 'delivered' | 'relayed';
  // How the original comes back: its headers as a message/rfc822 part, a text/rfc822-headers part, or not at all.
  returned?: 'rfc822' | 'headers' | 'none';
  // A plain text message from the mailer daemon instead of a delivery status report.
  plain?: boolean;
  from?: string;
  // The report type. Default delivery-status.
  reportType?: string;
}

const fakeDomain = 'fake-mail.example';

function crlf(lines: string[]): string {
  return lines.join('\r\n');
}

export class FakeMailTransport implements MailTransport {
  readonly knobs: FakeKnobs = {
    sentAutoSave: false,
    reportsStoredCopy: null,
    appendFailure: null,
    searchFailure: null,
    listFailure: null,
    listFailureKind: 'network',
    imapLoginFailure: null,
    smtpFailure: null,
    noSentMailbox: false,
    mailboxes: defaultFakeMailboxes.map((mailbox) => ({ ...mailbox })),
    capabilities: { imap: ['IMAP4rev1', 'UIDPLUS', 'SPECIAL-USE'], smtp: ['PIPELINING', '8BITMIME', 'STARTTLS'] },
  };

  uidValidity = '1700000000';
  inbox: StoredMessage[] = [];
  sent: StoredMessage[] = [];
  // What the SMTP side kept, whatever the sender was told.
  delivered: FakeSent[] = [];
  // Every send call, including refused ones.
  sendCalls: FakeSent[] = [];
  appendCalls: Buffer[] = [];
  searchCalls: string[] = [];
  verifyCalls: MailServerSettings[] = [];
  listCalls: (InboxCursor | null)[] = [];
  // Outcomes of the next sends, in order. An empty script accepts.
  sendScript: SendStep[] = [];
  // Called when send() starts, before any outcome is decided.
  onSend: ((message: OutgoingMessage) => void) | null = null;
  // Called when a Sent search starts.
  onSearch: ((messageId: string) => void) | null = null;

  private nextUid = 1;
  private counter = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  reset(): void {
    this.inbox = [];
    this.sent = [];
    this.delivered = [];
    this.sendCalls = [];
    this.appendCalls = [];
    this.searchCalls = [];
    this.verifyCalls = [];
    this.listCalls = [];
    this.sendScript = [];
    this.onSend = null;
    this.onSearch = null;
    this.nextUid = 1;
    this.uidValidity = '1700000000';
    const fresh = new FakeMailTransport(this.now);
    Object.assign(this.knobs, fresh.knobs);
  }

  // ---- fixtures ----

  get uidNext(): number {
    return this.nextUid;
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `<${prefix}-${this.counter}@${fakeDomain}>`;
  }

  private store(target: StoredMessage[], raw: Buffer, date?: string): StoredMessage {
    const message: StoredMessage = { uid: this.nextUid, raw, internalDate: date ?? this.now().toISOString() };
    this.nextUid += 1;
    target.push(message);
    return message;
  }

  addInbound(input: FakeInbound): { uid: number; messageId: string } {
    const messageId = input.messageId ?? this.nextId('in');
    const headers = [
      `From: ${input.from}`,
      `To: ${input.to ?? 'owner@' + fakeDomain}`,
      `Subject: ${input.subject}`,
      `Message-ID: ${messageId}`,
      `Date: ${new Date(input.date ?? this.now().toISOString()).toUTCString()}`,
      'MIME-Version: 1.0',
    ];
    if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
    if (input.references && input.references.length > 0) headers.push(`References: ${input.references.join(' ')}`);
    let body: string;
    if (input.html !== undefined && input.text === undefined) {
      headers.push('Content-Type: text/html; charset=utf-8');
      body = input.html;
    } else {
      headers.push('Content-Type: text/plain; charset=utf-8');
      body = input.text ?? '';
    }
    const raw = Buffer.from(`${crlf(headers)}\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}\r\n`, 'utf8');
    const stored = this.store(this.inbox, raw, input.date);
    return { uid: stored.uid, messageId };
  }

  addBounce(input: FakeBounce): { uid: number; messageId: string } {
    const kind = input.kind ?? 'failure';
    const messageId = this.nextId('dsn');
    const from = input.from ?? `MAILER-DAEMON@${fakeDomain}`;
    const subject =
      kind === 'failure' ? 'Delivery Status Notification (Failure)' : kind === 'delay' ? 'Delivery Status Notification (Delay)' : 'Delivery Status Notification (Success)';
    const human =
      kind === 'failure'
        ? `Your message to ${input.to} could not be delivered. The address was not found.`
        : kind === 'delay'
          ? `Delivery to ${input.to} has been delayed. The server will keep trying.`
          : `Your message to ${input.to} was delivered.`;
    const action = kind === 'failure' ? 'failed' : kind === 'delay' ? 'delayed' : kind;
    const headers = [
      `From: Mail Delivery System <${from}>`,
      `To: owner@${fakeDomain}`,
      `Subject: ${subject}`,
      `Message-ID: ${messageId}`,
      `Date: ${this.now().toUTCString()}`,
      'MIME-Version: 1.0',
    ];
    let text: string;
    if (input.plain) {
      headers.push('Content-Type: text/plain; charset=utf-8');
      text = `${crlf(headers)}\r\n\r\n${human}\r\n`;
    } else {
      const boundary = `fake-boundary-${this.counter}`;
      headers.push(`Content-Type: multipart/report; report-type=${input.reportType ?? 'delivery-status'}; boundary="${boundary}"`);
      const parts = [
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        human,
        '',
        `--${boundary}`,
        'Content-Type: message/delivery-status',
        '',
        `Reporting-MTA: dns; ${fakeDomain}`,
        '',
        `Final-Recipient: rfc822; ${input.to}`,
        `Action: ${action}`,
        `Status: ${kind === 'failure' ? '5.1.1' : kind === 'delay' ? '4.4.1' : '2.0.0'}`,
        '',
      ];
      const returned = input.returned ?? 'rfc822';
      const original = [`Message-ID: ${input.originalMessageId}`, `From: owner@${fakeDomain}`, `To: ${input.to}`, 'Subject: Original subject'];
      if (returned === 'rfc822') parts.push(`--${boundary}`, 'Content-Type: message/rfc822', '', ...original, '', 'Original body.', '');
      else if (returned === 'headers') parts.push(`--${boundary}`, 'Content-Type: text/rfc822-headers', '', ...original, '');
      parts.push(`--${boundary}--`, '');
      text = `${crlf(headers)}\r\n\r\n${crlf(parts)}`;
    }
    const stored = this.store(this.inbox, Buffer.from(text, 'utf8'));
    return { uid: stored.uid, messageId };
  }

  // The mailbox was rebuilt: new validity, and UIDs start again. Messages in it are gone from the client's point of view.
  changeUidValidity(): void {
    this.uidValidity = String(Number(this.uidValidity) + 1);
    this.inbox = [];
    this.nextUid = 1;
  }

  private addDelivered(message: OutgoingMessage): void {
    const entry: FakeSent = {
      messageId: message.messageId,
      envelopeFrom: message.envelopeFrom,
      envelopeTo: [...message.envelopeTo],
      raw: Buffer.from(message.raw),
      settingsSeen: message.settings,
    };
    this.delivered.push(entry);
    if (this.knobs.sentAutoSave) this.store(this.sent, Buffer.from(message.raw));
  }

  // ---- MailTransport ----

  async verify(settings: MailServerSettings): Promise<VerifyResult> {
    this.verifyCalls.push(settings);
    const password = settings.imap.password;
    const imapFailure =
      this.knobs.imapLoginFailure ?? (password.startsWith('wrong') ? 'Authentication failed. Invalid credentials.' : null);
    const smtpFailure =
      this.knobs.smtpFailure ?? (settings.smtp.password.startsWith('smtp-wrong') ? '535 5.7.8 Authentication credentials invalid' : null);
    const mailboxes = imapFailure
      ? []
      : this.knobs.mailboxes.map((mailbox) => (this.knobs.noSentMailbox && mailbox.specialUse === '\\Sent' ? { ...mailbox, specialUse: null } : { ...mailbox }));
    return {
      imapOk: imapFailure === null,
      smtpOk: smtpFailure === null,
      imapFailure: imapFailure ? { kind: 'auth', message: imapFailure } : null,
      smtpFailure: smtpFailure ? { kind: 'auth', message: smtpFailure } : null,
      mailboxes,
      capabilities: {
        imap: imapFailure ? [] : [...this.knobs.capabilities.imap],
        smtp: smtpFailure ? [] : [...this.knobs.capabilities.smtp],
        smtpStoresSentCopy: this.knobs.reportsStoredCopy,
      },
      inbox: imapFailure ? null : { uidValidity: this.uidValidity, uidNext: this.nextUid },
    };
  }

  async send(message: OutgoingMessage): Promise<SendAcceptance> {
    this.sendCalls.push({
      messageId: message.messageId,
      envelopeFrom: message.envelopeFrom,
      envelopeTo: [...message.envelopeTo],
      raw: Buffer.from(message.raw),
      settingsSeen: message.settings,
    });
    this.onSend?.(message);
    const step = this.sendScript.shift() ?? { type: 'accept' as const };
    if (step.type === 'accept') {
      this.addDelivered(message);
      return { response: '250 2.0.0 Ok: queued as FAKE' };
    }
    if (step.type === 'reject') {
      throw new TransportSendError('rejected', 'other', `${step.code} ${step.text}`, step.code);
    }
    if (step.type === 'not_sent') {
      throw new TransportSendError('not_sent', step.kind ?? 'network', step.text, step.code ?? null);
    }
    if (step.accepted) this.addDelivered(message);
    throw new TransportSendError('ambiguous', 'network', step.text ?? 'The connection closed before the server answered the message.');
  }

  async searchSent(settings: MailServerSettings, messageId: string): Promise<{ found: boolean }> {
    this.searchCalls.push(messageId);
    this.onSearch?.(messageId);
    if (this.knobs.searchFailure) throw new TransportError('network', this.knobs.searchFailure);
    if (!settings.sentMailbox || !this.knobs.mailboxes.some((mailbox) => mailbox.path === settings.sentMailbox)) {
      throw new TransportError('other', 'The Sent mailbox was not found on the server.');
    }
    const found = this.sent.some((stored) => {
      const value = headerValue(parseMime(stored.raw), 'message-id');
      return value !== null && sameMessageId(value, messageId);
    });
    return { found };
  }

  async appendSent(settings: MailServerSettings, raw: Buffer): Promise<void> {
    this.appendCalls.push(Buffer.from(raw));
    if (this.knobs.appendFailure) throw new TransportError('other', this.knobs.appendFailure);
    if (!settings.sentMailbox || !this.knobs.mailboxes.some((mailbox) => mailbox.path === settings.sentMailbox)) {
      throw new TransportError('other', 'The Sent mailbox was not found on the server.');
    }
    this.store(this.sent, Buffer.from(raw));
  }

  async listNewInbox(_settings: MailServerSettings, cursor: InboxCursor | null, options: ListInboxOptions = {}): Promise<InboxBatch> {
    this.listCalls.push(cursor ? { ...cursor } : null);
    if (this.knobs.listFailure) throw new TransportError(this.knobs.listFailureKind, this.knobs.listFailure);
    const plan = planInboxFetch(cursor, { uidValidity: this.uidValidity, uidNext: this.nextUid });
    if (plan.action !== 'fetch') return { messages: [], cursor: plan.cursor, more: false, reset: plan.action === 'reset' };
    const limit = Math.max(1, options.limit ?? 25);
    const above = this.inbox.filter((stored) => stored.uid >= plan.fromUid).sort((a, b) => a.uid - b.uid);
    const page = above.slice(0, limit);
    const fallback = this.now().toISOString();
    const messages = page.map((stored) => normalizeImapMessage({ uid: stored.uid, uidValidity: this.uidValidity, internalDate: stored.internalDate, source: stored.raw }, fallback));
    const last = page.length > 0 ? page[page.length - 1]!.uid : plan.cursor.lastSeenUid;
    return { messages, cursor: { uidValidity: this.uidValidity, lastSeenUid: last }, more: above.length > page.length, reset: false };
  }
}

// The fake the server uses when AGENTCRM_IMAP_FAKE=1: one per process, with an Inbox that already holds a message, so
// the first poll has a position to start from.
export function createSeededFakeMailTransport(): FakeMailTransport {
  const fake = new FakeMailTransport();
  // The validity follows the process start, so restarting the server shows the honest gap note.
  fake.uidValidity = String(Math.floor(Date.now() / 1000));
  fake.addInbound({
    from: 'Fake Mail Team <welcome@' + fakeDomain + '>',
    subject: 'Welcome to the fake mailbox',
    text: 'This mailbox lives inside the server process. Nothing here is real mail.',
  });
  return fake;
}
