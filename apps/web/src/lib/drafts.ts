import type { DraftEntry, DraftFact, DraftPersonNote, DraftReviewPayload, DraftRunIssues, DraftSample } from '../api/types';

export const MAX_PEOPLE_DEFAULT = 10;
export const MAX_PEOPLE_CAP = 25;

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

// The server appends this to a fact whose value it could not find in the record the model was given.
export const FACT_NOT_FOUND_SUFFIX = ' (not found in the record)';

export function isUnverifiedFact(fact: DraftFact): boolean {
  return fact.value.endsWith(FACT_NOT_FOUND_SUFFIX);
}

function parseFacts(value: unknown): DraftFact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = record(entry);
    const field = text(row.field);
    const factValue = text(row.value);
    return field && factValue ? [{ field, value: factValue }] : [];
  });
}

// The payload carries { count, sample: up to 3 { personName, subject }, drafts: full drafts, estimatedUsd, provider }.
// Approvals made before full drafts were included have no drafts list.
export function parseDraftReviewPayload(payload: unknown): DraftReviewPayload {
  const source = record(payload);
  const sampleSource = Array.isArray(source.sample) ? source.sample : [];
  const sample: DraftSample[] = sampleSource.slice(0, 3).map((entry) => {
    const row = record(entry);
    return { personName: text(row.personName), subject: text(row.subject) };
  });
  const draftSource = Array.isArray(source.drafts) ? source.drafts : [];
  const drafts: DraftEntry[] = draftSource.map((entry) => {
    const row = record(entry);
    return {
      personId: text(row.personId),
      personName: text(row.personName),
      subject: text(row.subject),
      body: text(row.body),
      factsUsed: parseFacts(row.factsUsed),
    };
  });
  const count = Number(source.count);
  const usd = source.estimatedUsd === null || source.estimatedUsd === undefined ? NaN : Number(source.estimatedUsd);
  return {
    count: Number.isFinite(count) && count >= 0 ? Math.floor(count) : drafts.length || sample.length,
    sample,
    drafts,
    estimatedUsd: Number.isFinite(usd) && usd >= 0 ? usd : null,
    // Approvals made before the provider setting carry none, and those runs were Anthropic runs.
    provider: text(source.provider),
  };
}

// The provider a run was pinned to when it started, or null for a run from before the provider setting.
export function runProvider(scope: unknown): string | null {
  return text(record(scope).provider);
}

export function draftCountLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'draft' : 'drafts'}`;
}

export type MaxPeopleCheck = { ok: true; value: number } | { ok: false; message: string };

export function checkMaxPeople(value: string): MaxPeopleCheck {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: `Enter a whole number from 1 to ${MAX_PEOPLE_CAP}.` };
  const parsed = Number(trimmed);
  if (parsed < 1 || parsed > MAX_PEOPLE_CAP) {
    return { ok: false, message: `Max people must be from 1 to ${MAX_PEOPLE_CAP}.` };
  }
  return { ok: true, value: parsed };
}

export type BudgetCheck = { ok: true; value: number | null } | { ok: false; message: string };

export function checkBudget(value: string): BudgetCheck {
  const trimmed = value.trim().replace(/^\$/, '');
  if (!trimmed) return { ok: true, value: null };
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) {
    return { ok: false, message: 'Enter a dollar amount such as 2 or 0.50, or leave it empty for no budget.' };
  }
  const parsed = Number(trimmed);
  if (!(parsed > 0)) return { ok: false, message: 'The budget must be more than zero, or leave it empty.' };
  return { ok: true, value: parsed };
}

function parseNotes(value: unknown): DraftPersonNote[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = record(entry);
    const reason = text(row.reason);
    return reason ? [{ personName: text(row.personName), reason }] : [];
  });
}

// Reads what a draft run says about people it skipped or could not draft for.
export function parseDraftRunIssues(scope: unknown): DraftRunIssues {
  const source = record(scope);
  const notDrafted = Number(source.notDrafted);
  const budget = Number(source.budgetUsd);
  return {
    failures: parseNotes(source.failures),
    skipped: parseNotes(source.skipped),
    stoppedEarly: text(source.stoppedEarly),
    notDrafted: Number.isFinite(notDrafted) && notDrafted > 0 ? Math.floor(notDrafted) : null,
    budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null,
    budgetDefaulted: source.budgetDefaulted === true,
  };
}
