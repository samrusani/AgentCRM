import type { FollowupPlan, FollowupRule, SendExcluded, SendReviewMessage, SendReviewPayload } from '../api/types';
import { formatDueDay } from './format';

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

const PROVIDER_NAMES: Record<string, string> = {
  agentmail: 'AgentMail',
  gmail: 'Gmail',
  microsoft: 'Microsoft 365',
  imap: 'IMAP and SMTP',
};

const IMAP_PRESET_NAMES: Record<string, string> = { icloud: 'iCloud Mail', fastmail: 'Fastmail' };

// The IMAP connector shows its preset's name when it has one: "iCloud Mail", "Fastmail", else "IMAP and SMTP".
export function mailProviderName(kind: string | null | undefined, imapPreset?: string | null): string {
  if (!kind) return 'the mail provider';
  if (kind === 'imap' && imapPreset && IMAP_PRESET_NAMES[imapPreset]) return IMAP_PRESET_NAMES[imapPreset];
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
  followup_armed: 'This person already has active follow-ups. Stop them to stage again.',
  followup_stopped: 'Follow-ups to this person were stopped after this message was staged.',
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
    mailProvider: topProvider ?? messages.find((message) => message.provider)?.provider ?? null,
    followups: parseFollowupPlan(source.followups),
  };
}

// Older payloads have no follow-up plan. A plan with no readable step is treated as absent.
function parseFollowupPlan(value: unknown): FollowupPlan | null {
  const source = record(value);
  const list = Array.isArray(source.steps) ? source.steps : [];
  const steps = list.map((entry) => {
    const row = record(entry);
    const days = Number(row.waitDays ?? row.wait_days);
    return {
      waitDays: Number.isFinite(days) ? Math.floor(days) : 0,
      body: typeof row.body === 'string' ? row.body : '',
    };
  });
  return steps.length > 0 ? { steps } : null;
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

// Follow-ups. Limits mirror the server: one to five steps, 1 to 30 days each, 10 to 2000 characters after trimming, and waits that add up to
// less than the 90 day ceiling (follow-ups stop after 90 days, so a longer plan could never finish).
export const FOLLOWUP_MAX_STEPS = 5;
export const FOLLOWUP_CEILING_DAYS = 90;
export const FOLLOWUP_DEFAULT_WAIT_DAYS = 5;
export const FOLLOWUP_MIN_WAIT_DAYS = 1;
export const FOLLOWUP_MAX_WAIT_DAYS = 30;
export const FOLLOWUP_MIN_BODY = 10;
export const FOLLOWUP_MAX_BODY = 2000;

// The sentence shown inline (and the refusal the server gives) when the waits pass the ceiling, else null.
export function followupCeilingProblem(waits: number[]): string | null {
  const total = waits.reduce((sum, days) => sum + days, 0);
  if (total < FOLLOWUP_CEILING_DAYS) return null;
  return `The waits add up to ${total} days; follow-ups stop after ${FOLLOWUP_CEILING_DAYS} days. Shorten a wait or remove a step.`;
}

// "3 steps over 12 days" for a saved sequence.
export function sequenceSummary(steps: Array<{ waitDays: number }>): string {
  const days = steps.reduce((sum, step) => sum + step.waitDays, 0);
  return `${steps.length} ${steps.length === 1 ? 'step' : 'steps'} over ${days} ${days === 1 ? 'day' : 'days'}`;
}

export const FOLLOWUP_STOP_SENTENCE =
  'Follow-ups stop on any reply, bounce, opt out, or suppression, and you can stop them at any time. The same text goes to every recipient.';

export const FOLLOWUP_STOP_CONFIRM = 'Stop follow-ups to this person? Nothing more will be sent.';

export function followupWaitPhrase(waitDays: number): string {
  return `${waitDays.toLocaleString()} ${waitDays === 1 ? 'day' : 'days'} after the last send, weekends skipped`;
}

// Gmail and IMAP continue the thread. AgentMail and Microsoft have no reply path, so they send a new "Re:" message.
export function followupThreadSentence(provider: string | null | undefined): string | null {
  if (provider === 'gmail' || provider === 'imap') return 'Follow-ups continue the same email thread.';
  if (provider === 'agentmail' || provider === 'microsoft') {
    return 'Follow-ups go out as new messages whose subject starts with Re:.';
  }
  return null;
}

export const ACTIVE_FOLLOWUP_STATUSES = ['waiting', 'armed', 'sending'];

export function isFollowupActive(rule: Pick<FollowupRule, 'status'>): boolean {
  return ACTIVE_FOLLOWUP_STATUSES.includes(rule.status);
}

// The step that goes out next, as "Follow-up 1 of 2". The step is kept inside the plan's length.
export function followupProgress(step: number, total: number): string {
  if (total <= 0) return 'Follow-up';
  return `Follow-up ${Math.min(Math.max(step, 1), total)} of ${total}`;
}

// What an active rule is doing, in plain words.
export function followupStatusLine(rule: FollowupRule): string {
  if (rule.status === 'waiting') return 'Waiting for the first send';
  const progress = followupProgress(rule.nextStep, rule.steps.length);
  if (rule.status === 'sending') return `${progress} is sending`;
  const day = formatDueDay(rule.nextDueAt);
  return day ? `${progress} due ${day}` : `${progress}, no due date yet`;
}

const FOLLOWUP_STOPPED_LABELS: Record<string, string> = {
  replied: 'Stopped, replied',
  bounced: 'Stopped, bounced',
  suppressed: 'Stopped, opted out or suppressed',
  stopped_by_user: 'Stopped, by you',
  connector_changed: 'Stopped, connector changed',
  not_sent: 'Stopped, the first message was not sent',
  step_not_sent: 'Stopped, a follow-up could not be sent',
};

// How a finished rule ended, in honest words.
export function followupOutcomeLabel(rule: FollowupRule): string {
  if (rule.status === 'done') return 'Done, all sent';
  if (rule.status === 'expired') {
    return rule.stoppedReason === 'ceiling' ? 'Expired, approved more than 90 days ago' : 'Expired, the computer was off past the send window';
  }
  return (rule.stoppedReason && FOLLOWUP_STOPPED_LABELS[rule.stoppedReason]) || 'Stopped';
}
