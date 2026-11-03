import type { SendExcluded, SendReviewMessage, SendReviewPayload } from '../api/types';

// The app stops at this many accepted sends per inbox per day. The provider has its own limits too.
export const DAILY_SEND_CAP = 50;

function text(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const PROVIDER_NAMES: Record<string, string> = { agentmail: 'AgentMail', gmail: 'Gmail', microsoft: 'Microsoft 365' };

export function mailProviderName(kind: string | null | undefined): string {
  if (!kind) return 'the mail provider';
  return PROVIDER_NAMES[kind] ?? kind;
}

const REASON_TEXT: Record<string, string> = {
  suppressed: 'This address is suppressed and is never emailed.',
  demo_address: 'This is a demo address (example.com, example.org, or example.net), so no real mail is sent to it.',
  invalid_recipient: 'The recipient address is missing or not valid.',
  missing_recipient: 'The person has no email address.',
  invalid_email: 'The recipient address is not valid.',
  no_email: 'The person has no email address.',
  duplicate_open_intent: 'A send for this draft, or one with this subject for this person, is already open.',
  open_intent: 'A send for this draft, or one with this subject for this person, is already open.',
  already_open: 'A send for this draft, or one with this subject for this person, is already open.',
  no_inbox: 'No sending address is connected.',
  no_connector: 'No sending connector is connected.',
  daily_cap: 'The daily sending cap leaves no room for this message.',
  cap_reached: 'The daily sending cap leaves no room for this message.',
  daily_cap_reached: 'The daily sending cap leaves no room for this message.',
  reply_received: 'This person replied after the send was approved.',
  replied: 'This person replied after the send was approved.',
  connector_removed: 'The sending connector was removed or switched after the send was approved.',
  connector_missing: 'The sending connector was removed or switched after the send was approved.',
  payload_mismatch: 'The message no longer matches what was approved.',
  hash_mismatch: 'The message no longer matches what was approved.',
  opt_out: 'This address opted out.',
  bounce: 'Mail to this address bounced.',
  bounced: 'Mail to this address bounced.',
  manual: 'This address was suppressed by hand.',
};

// The server sends a stable code or a sentence. Known codes get a sentence, anything else is shown as sent.
export function reasonSentence(reason: string | null | undefined): string {
  const value = (reason ?? '').trim();
  if (!value) return 'No reason was given.';
  const key = value.toLowerCase().replace(/[\s-]+/g, '_');
  const known = REASON_TEXT[key];
  if (known) return known;
  if (/^[a-z0-9_]+$/i.test(value)) {
    const spoken = value.replace(/_/g, ' ');
    return `${spoken.charAt(0).toUpperCase()}${spoken.slice(1)}.`;
  }
  return value;
}

export function parseExcluded(value: unknown): SendExcluded[] {
  const source = typeof value === 'string' ? safeParse(value) : value;
  if (!Array.isArray(source)) return [];
  return source.map((entry) => {
    const row = record(entry);
    return {
      personName: text(row.personName ?? row.name),
      toEmail: text(row.toEmail ?? row.to ?? row.email),
      reason: text(row.reason ?? row.code) ?? '',
    };
  });
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

// The payload holds the frozen messages as `messages` or `intents`, plus the people left out and why.
export function parseSendReviewPayload(payload: unknown): SendReviewPayload {
  const source = record(payload);
  const list = Array.isArray(source.messages) ? source.messages : Array.isArray(source.intents) ? source.intents : [];
  const topInbox = text(source.inboxEmail ?? source.inbox ?? source.from);
  const topProvider = text(source.provider ?? source.mailProvider);
  const messages: SendReviewMessage[] = list.map((entry) => {
    const row = record(entry);
    return {
      intentId: text(row.intentId ?? row.id),
      personName: text(row.personName ?? row.name),
      to: text(row.to ?? row.toEmail ?? row.email),
      subject: text(row.subject),
      body: typeof row.body === 'string' && row.body.trim() !== '' ? row.body : text(row.text),
      inboxEmail: text(row.inboxEmail ?? row.inbox ?? row.from ?? row.fromEmail) ?? topInbox,
      provider: text(row.provider ?? row.mailProvider) ?? topProvider,
    };
  });
  return {
    messages,
    excluded: parseExcluded(source.excluded),
    remainingDailyCap: finiteOrNull(source.remainingDailyCap ?? source.remainingCap ?? source.dailyCapRemaining),
  };
}

// Every message must show its recipient, subject, and body in full, or the approval cannot be read in full.
export function isMessageComplete(message: SendReviewMessage): boolean {
  return Boolean(message.to && message.subject && message.body && message.inboxEmail);
}

export function messageCountLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'message' : 'messages'}`;
}

export interface OutboxGroup {
  key: string;
  label: string;
  statuses: string[];
  note?: string;
}

// Ordered with the states that need the user first.
export const OUTBOX_GROUPS: OutboxGroup[] = [
  {
    key: 'unknown',
    label: 'Unknown outcome (needs you)',
    statuses: ['unknown'],
    note: "The provider did not confirm these. They may or may not have been sent. Retries reuse the provider's duplicate protection, which lasts about a day. After that the app stops retrying, and you check the provider's sent mail.",
  },
  { key: 'blocked', label: 'Blocked', statuses: ['blocked'], note: 'Blocked messages are not retried. Each shows its reason.' },
  { key: 'awaiting', label: 'Waiting for your approval', statuses: ['awaiting_approval'] },
  { key: 'queued', label: 'Queued', statuses: ['approved', 'queued'] },
  { key: 'submitting', label: 'Submitting', statuses: ['submitting'] },
  { key: 'failed', label: 'Failed', statuses: ['failed'] },
  { key: 'bounced', label: 'Bounced', statuses: ['bounced'] },
  { key: 'replied', label: 'Replied', statuses: ['replied'] },
  { key: 'accepted', label: 'Accepted by the provider (not delivery)', statuses: ['accepted'] },
];

export const CANCELLABLE_STATUSES = ['awaiting_approval', 'approved', 'queued'];
export const ACKNOWLEDGEABLE_STATUSES = ['unknown', 'blocked'];

const SUPPRESSION_REASONS: Record<string, string> = {
  manual: 'Added by hand',
  opt_out: 'Opted out',
  bounce: 'Bounced',
};

export function suppressionReasonLabel(reason: string): string {
  return SUPPRESSION_REASONS[reason] ?? reason.replace(/_/g, ' ');
}

export function isValidEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
