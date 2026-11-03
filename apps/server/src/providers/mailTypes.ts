// The mail provider interface. Sending and inbound sync run through it, so every provider obeys the same approval,
// suppression, cap, and honesty rules. The send intent state machine lives in the callers, never in an adapter.

export const mailProviderKinds = ['agentmail', 'gmail'] as const;
export type MailProviderKind = (typeof mailProviderKinds)[number];

export function isMailProviderKind(value: unknown): value is MailProviderKind {
  return typeof value === 'string' && (mailProviderKinds as readonly string[]).includes(value);
}

export const mailProviderLabels: Record<MailProviderKind, string> = { agentmail: 'AgentMail', gmail: 'Gmail' };

export type MailErrorKind =
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'rejected'
  | 'unavailable'
  | 'timeout'
  | 'network'
  | 'bad_response'
  | 'unexpected_status';

// Messages are written in the provider modules. Text that comes from a provider is scrubbed of credentials first.
export class MailProviderError extends Error {
  readonly kind: MailErrorKind;
  readonly status: number | null;
  // True when the failure happened before any request that could send mail left the process.
  readonly sentNothing: boolean;

  constructor(kind: MailErrorKind, message: string, status: number | null = null, options: { sentNothing?: boolean } = {}) {
    super(message);
    this.name = 'MailProviderError';
    this.kind = kind;
    this.status = status;
    this.sentNothing = options.sentNothing ?? false;
  }

  // The provider answered with a definitive refusal, or nothing was sent at all, so the request did not produce an
  // email. Any other failure that is not a success leaves the outcome unknown.
  get definitive(): boolean {
    return this.sentNothing || this.kind === 'unauthorized' || this.kind === 'rejected' || this.kind === 'not_found';
  }

  // The request may have been processed even though the answer was lost, late, or unreadable.
  // A send that fails this way has an unknown outcome and is never resolved by guessing.
  get outcomeUnknown(): boolean {
    return !this.definitive;
  }
}

// How a provider keeps one intent from becoming two emails.
export type DuplicateProtection =
  // The provider remembers an idempotency key for about a day. A retry with the same key returns the original result.
  | 'idempotency_key'
  // The app persists a self generated Message-ID before submitting and later searches for it. Never retried.
  | 'message_id_search';

// The persisted facts of one frozen message, as an adapter needs them.
export interface MailIntent {
  intentId: string;
  // The AgentMail inbox id, or the Gmail address.
  accountId: string;
  fromAddress: string;
  to: string;
  subject: string;
  body: string;
  // Set for providers whose duplicate protection is message_id_search. Persisted before submit.
  messageIdHeader: string | null;
  // Set when the message continues a known thread.
  replyTo: { threadId: string; inReplyTo: string; references: string[] } | null;
}

export interface MailSubmitResult {
  messageId: string;
  threadId: string | null;
}

export type ReconcileResult =
  | { outcome: 'accepted'; messageId: string; threadId: string | null }
  // The provider answered and the message is not there. This never proves that it was not sent.
  | { outcome: 'not_found' }
  // The check itself failed. error.definitive tells the caller whether trying again can help.
  | { outcome: 'unavailable'; error: MailProviderError };

export interface NormalizedInbound {
  providerMessageId: string;
  threadId: string | null;
  direction: 'in' | 'out';
  // The From header as written. It is parsed by the caller and never used as an address unless it is one.
  from: string;
  to: string[];
  subject: string;
  preview: string;
  labels: string[];
  // The full text to store, or null when none was fetched.
  text: string | null;
  // The words used for the activity snippet and opt out wording: the extracted reply when the provider has one.
  replyText: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  // Text of delivery reports and attached original headers, used only to match bounces.
  evidenceText: string;
  // The Action of an attached delivery status report, lowercased: failed, delayed, delivered, relayed, or expanded.
  // Null when the message carries no report. A bounce needs "failed"; the others are progress notices.
  deliveryAction: string | null;
  receivedAt: string;
  // True when the full text could not be fetched on several polls in a row and the message is kept without it.
  unreadable: boolean;
}

export interface InboundBatch {
  messages: NormalizedInbound[];
  // The cursor to save after the caller stored `messages`. Ignored when `failure` is set.
  nextCursor: string | null;
  more: boolean;
  // Set when fetching stopped partway. The caller stores `messages`, leaves the cursor where it was, and rethrows.
  failure?: unknown;
  // Set when the provider's cursor was no longer valid and was reset to the present.
  reset?: { note: string };
}

export interface ListInboundOptions {
  // True for a message the app already stored, so its full text is not fetched again.
  isKnown: (providerMessageId: string) => boolean;
}

export interface BounceEvidence {
  eventId: string;
  providerMessageId: string;
}

export interface MailEventBatch {
  bounces: BounceEvidence[];
  newestEventId: string | null;
}

export interface MailProvider {
  readonly kind: MailProviderKind;
  readonly label: string;
  readonly duplicateProtection: DuplicateProtection;
  // Returns provider message and thread ids, or throws a MailProviderError.
  submit(intent: MailIntent): Promise<MailSubmitResult>;
  // Called on the reconcile schedule after an unknown outcome. Gmail's version is read only.
  reconcileUnknown(intent: MailIntent): Promise<ReconcileResult>;
  // One page of new messages after the cursor. The adapter keeps paging state for the length of one poll.
  listInbound(cursor: string | null, options: ListInboundOptions): Promise<InboundBatch>;
  // The address behind the credentials. Throws a MailProviderError.
  checkAccount(): Promise<{ address: string }>;
  // Providers that report bounces as events. The seen id is the newest event the app has handled.
  pollEvents?(seenEventId: string | null): Promise<MailEventBatch>;
}

// A message whose full text cannot be fetched is tried on this many polls in a row. After that it is stored without
// its text and a task names it, so one stubborn message cannot stall the sync for good.
const maxTransientFailures = 3;
const transientFailures = new Map<string, number>();

// Returns true when the caller should stop and try the message again next poll.
export function noteFetchFailure(key: string): boolean {
  const failures = (transientFailures.get(key) ?? 0) + 1;
  if (failures < maxTransientFailures) {
    transientFailures.set(key, failures);
    return true;
  }
  transientFailures.delete(key);
  return false;
}

export function clearFetchFailure(key: string): void {
  transientFailures.delete(key);
}
