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
