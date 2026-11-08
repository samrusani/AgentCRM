import type { Approval, Person, Run, RunStatus } from '../api/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'unknown';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return 'unknown';
  const diff = Math.max(0, now - time);
  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 60 * DAY) return `${Math.floor(diff / DAY)}d`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}mo`;
  return `${Math.floor(diff / (365 * DAY))}y`;
}

// Reads naturally after a verb: "Started just now", "Updated 3d ago".
export function formatAgo(iso: string | null | undefined, now = Date.now()): string {
  const age = formatAge(iso, now);
  if (age === 'now') return 'just now';
  if (age === 'unknown') return 'at an unknown time';
  return `${age} ago`;
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// A report week is keyed by its Monday (UTC) as YYYY-MM-DD and labelled "3 Nov" style, never shifted by the local zone.
export function formatWeek(weekStart: string): string {
  const time = Date.parse(`${weekStart}T00:00:00.000Z`);
  if (Number.isNaN(time)) return weekStart;
  return new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return new Date(time).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// "Mon 10 Nov": weekday, day, month, in that order whatever the locale, because the follow-up copy reads that way.
export function formatDueDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const date = new Date(time);
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  return `${weekday} ${date.getDate()} ${month}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export interface DueLabel {
  text: string;
  overdue: boolean;
}

export function describeDue(iso: string | null | undefined, now = Date.now()): DueLabel {
  if (!iso) return { text: 'No date', overdue: false };
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return { text: 'No date', overdue: false };
  const days = Math.round((startOfDay(time) - startOfDay(now)) / DAY);
  if (days < 0) return { text: `Overdue ${-days}d`, overdue: true };
  if (days === 0) return { text: 'Today', overdue: false };
  if (days === 1) return { text: 'Tomorrow', overdue: false };
  return { text: formatDate(iso), overdue: false };
}

export function formatDuration(startIso: string | null, endIso: string | null, now = Date.now()): string {
  if (!startIso) return '';
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function formatAmount(amount: number | string | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '';
  const value = Number(amount);
  if (!Number.isFinite(value)) return '';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return `${value.toLocaleString()} ${currency ?? ''}`.trim();
  }
}

export function personName(person: Pick<Person, 'firstName' | 'lastName' | 'name'>): string {
  const joined = `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim();
  return joined || person.name || 'Unnamed person';
}

export function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_approval: 'Waiting for approval',
  paused: 'Paused',
  succeeded: 'Succeeded',
  partial: 'Partial',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status as RunStatus] ?? humanize(status);
}

export function isRunActive(status: string): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting_approval' || status === 'paused';
}

export function isSimulatedRun(run: Pick<Run, 'kind'>): boolean {
  return run.kind === 'demo_research';
}

// Every approval in v1 comes from the simulated demo run. The contract has no
// explicit flag, so the run kind or the shortlist kind marks it.
export function isSimulatedApproval(approval: Approval): boolean {
  return approval.runKind === 'demo_research' || approval.kind === 'shortlist';
}

export function summarizePayload(payload: unknown): string[] {
  if (payload === null || payload === undefined) return [];
  if (typeof payload === 'string') return [payload];
  if (typeof payload !== 'object') return [String(payload)];
  const record = payload as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof record.summary === 'string') lines.push(record.summary);
  for (const [key, value] of Object.entries(record)) {
    if (key === 'summary') continue;
    if (Array.isArray(value)) {
      const names = value
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object') {
            const item = entry as Record<string, unknown>;
            const label = item.name ?? item.title ?? item.email ?? item.id;
            return typeof label === 'string' ? label : null;
          }
          return null;
        })
        .filter((entry): entry is string => Boolean(entry));
      const preview = names.slice(0, 3).join(', ');
      const rest = names.length > 3 ? ` and ${names.length - 3} more` : '';
      lines.push(`${humanize(key)}: ${value.length}${preview ? ` (${preview}${rest})` : ''}`);
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${humanize(key)}: ${String(value)}`);
    }
    if (lines.length >= 4) break;
  }
  return lines;
}

// Calendar day distance for sentences like "They last wrote 3 days ago": today, yesterday, then days, months, years.
export function formatDaysAgo(iso: string | null | undefined, now = Date.now()): string {
  const time = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) return 'at an unknown time';
  const days = Math.max(0, Math.round((startOfDay(now) - startOfDay(time)) / DAY));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

const BIRTHDAY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A stored birthday is YYYY-MM-DD or MM-DD. Read as text, never through Date, so no time zone can shift the day.
function parseBirthday(value: string): { year: number | null; month: number; day: number } | null {
  const match = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: match[1] ? Number(match[1]) : null, month, day };
}

// "12 Nov 1986" when the year is known, "12 Nov" when it is not. A value that does not parse is shown as stored.
export function formatBirthday(value: string): string {
  const parsed = parseBirthday(value);
  if (!parsed) return value;
  const text = `${parsed.day} ${BIRTHDAY_MONTHS[parsed.month - 1]}`;
  return parsed.year === null ? text : `${text} ${parsed.year}`;
}

// The muted note beside a birthday: "today" on the day, "in N days" for the seven days before it, else nothing.
// February 29 counts as February 28 in a non leap year, the same rule the server uses for Today.
export function birthdayProximity(value: string, now = Date.now()): string | null {
  const parsed = parseBirthday(value);
  if (!parsed) return null;
  const today = new Date(startOfDay(now));
  const upcoming = (year: number) => {
    const leap = new Date(year, 1, 29).getMonth() === 1;
    const day = parsed.month === 2 && parsed.day === 29 && !leap ? 28 : parsed.day;
    return new Date(year, parsed.month - 1, day);
  };
  let target = upcoming(today.getFullYear());
  if (target < today) target = upcoming(today.getFullYear() + 1);
  const days = Math.round((target.getTime() - today.getTime()) / DAY);
  if (days === 0) return 'today';
  if (days >= 1 && days <= 7) return days === 1 ? 'in 1 day' : `in ${days} days`;
  return null;
}
