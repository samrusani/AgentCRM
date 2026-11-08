import type { ImportCounts, ImportReviewPayload, ImportSampleRow } from '../api/types';

function text(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function optionalCount(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function normalizeCounts(raw: unknown): ImportCounts {
  const record = asRecord(raw);
  return {
    fetched: count(record.fetched),
    staged: count(record.staged),
    duplicates: count(record.duplicates ?? record.duplicate),
    invalid: count(record.invalid),
    accepted: optionalCount(record.accepted),
    rejected: optionalCount(record.rejected),
  };
}

export function mappedName(mapped: Record<string, unknown>): string | null {
  const direct = text(mapped.name) ?? text(mapped.fullName);
  if (direct) return direct;
  const joined = [text(mapped.firstName), text(mapped.lastName)].filter(Boolean).join(' ');
  return joined || null;
}

export function mappedEmail(mapped: Record<string, unknown>): string | null {
  return text(mapped.email);
}

export function mappedCompany(mapped: Record<string, unknown>): string | null {
  return (
    text(mapped.company) ??
    text(mapped.companyName) ??
    text(mapped.organization) ??
    text(mapped.organizationName) ??
    text(mapped.org)
  );
}

export function mappedTitle(mapped: Record<string, unknown>): string | null {
  return text(mapped.title) ?? text(mapped.position) ?? text(mapped.jobTitle);
}

export function mappedProfile(mapped: Record<string, unknown>): string | null {
  return text(mapped.linkedinUrl) ?? text(mapped.linkedin);
}

// Only lead capture stages organizations. Anything that is not clearly an organization is a person.
export function mappedKind(mapped: Record<string, unknown>): 'person' | 'organization' {
  return text(mapped.kind)?.toLowerCase() === 'organization' ? 'organization' : 'person';
}

// The profile link without the scheme, "www.", and any query, so it fits a table cell.
export function profileLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[?#]/)[0]!.replace(/\/$/, '');
}

export function parseImportReviewPayload(payload: unknown): ImportReviewPayload | null {
  const record = asRecord(payload);
  if (Object.keys(record).length === 0) return null;
  const sampleSource = Array.isArray(record.sample) ? record.sample : [];
  const sample: ImportSampleRow[] = sampleSource.slice(0, 5).map((entry) => {
    const row = asRecord(entry);
    return {
      name: mappedName(row),
      email: mappedEmail(row),
      company: mappedCompany(row),
      title: mappedTitle(row),
      linkedinUrl: mappedProfile(row),
      kind: mappedKind(row),
      inbound: optionalCount(row.inbound),
      outbound: optionalCount(row.outbound),
      lastSeenAt: text(row.lastSeenAt),
      quote: text(row.quote),
    };
  });
  return {
    batchId: text(record.batchId) ?? text(record.batch_id),
    actorId: text(record.actorId) ?? text(record.actor_id),
    postUrl: text(record.postUrl) ?? text(asRecord(record.source).postUrl),
    pasted: record.pasted === true,
    transcript: record.transcript === true,
    // Only a mailbox capture review carries the window it scanned, even when that is all mail (null).
    mailbox: 'sinceDays' in record,
    willPromote: optionalCount(record.willPromote),
    counts: normalizeCounts(record.counts),
    sample,
  };
}

export function formatCount(value: number): string {
  return value.toLocaleString();
}

const BATCH_STATUS_LABELS: Record<string, string> = {
  staging: 'Staging',
  awaiting_review: 'Awaiting review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  failed: 'Failed',
};

export function batchStatusLabel(status: string): string {
  return BATCH_STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}

const ROW_STATUS_LABELS: Record<string, string> = {
  staged: 'Staged',
  duplicate: 'Duplicate',
  invalid: 'Invalid',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

export function rowStatusLabel(status: string): string {
  return ROW_STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}

// Accepts the username~name form, the username/name form, or a bare actor id.
export function normalizeActorId(value: string): string | null {
  const candidate = value.trim().replace(/\//g, '~');
  if (!/^[A-Za-z0-9._-]+(~[A-Za-z0-9._-]+)?$/.test(candidate)) return null;
  // "." and ".." as a whole part would change the request path, so they are never valid.
  return candidate.split('~').some((part) => part === '.' || part === '..') ? null : candidate;
}

export type InputCheck =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

export function checkActorInput(textValue: string): InputCheck {
  if (!textValue.trim()) {
    return { ok: false, message: 'The input is empty. Enter a JSON object, or {} to send no input.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}.` : '';
    return { ok: false, message: `The input is not valid JSON.${detail}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'The input must be a JSON object, for example {}.' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export const MAX_ITEMS_DEFAULT = 100;
export const MAX_ITEMS_CAP = 1000;

export function checkMaxItems(textValue: string): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = textValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: `Enter a whole number from 1 to ${MAX_ITEMS_CAP}.` };
  }
  const value = Number(trimmed);
  if (value < 1 || value > MAX_ITEMS_CAP) {
    return { ok: false, message: `Max items must be from 1 to ${MAX_ITEMS_CAP}.` };
  }
  return { ok: true, value };
}
