import type { Criterion, CriterionField, QualificationConfig } from './config.js';

export type Outcome = 'matched' | 'not_matched' | 'unknown';

export interface ClaimFact {
  id: string;
  value: string;
  status: string;
  observedAt: string;
}

// Plain facts about one person, so evaluation needs no database access.
export interface PersonFacts {
  person: { name: string; title: string | null; location: string | null; email: string | null; tags: string[] };
  organization: { name: string; kind: string; domain: string | null; location: string | null; tags: string[] } | null;
  // Newest claim per field, or undefined when the field has no claim.
  personClaim: (field: string) => ClaimFact | undefined;
  organizationClaim: (field: string) => ClaimFact | undefined;
}

export type Evidence =
  | { source: 'claim'; claimId: string; status: string; observedAt: string; ageDays: number; value: string }
  | { source: 'record'; value: string }
  | null;

export interface CriterionResult {
  id: string;
  label: string;
  outcome: Outcome;
  reason: string;
  evidence: Evidence;
}

export interface QualificationPayload {
  computedAt: string;
  excluded: boolean;
  excludedReasons: string[];
  matched: number;
  total: number;
  unknown: number;
  criteria: CriterionResult[];
}

const dayMilliseconds = 86_400_000;

// Fields that can have a claim, by the claim's field name. Tags and kind exist only on the record.
const claimFieldNames: Partial<Record<CriterionField, string>> = {
  title: 'title',
  location: 'location',
  email: 'email',
  name: 'name',
  domain: 'domain',
};

const fieldLabels: Record<CriterionField, string> = {
  title: 'title',
  location: 'location',
  tags: 'tags',
  email: 'email',
  name: 'name',
  kind: 'kind',
  domain: 'domain',
};

function joinWords(values: readonly string[], conjunction: string): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} ${conjunction} ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, ${conjunction} ${values[values.length - 1]}`;
}

function ageText(days: number): string {
  if (days <= 0) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function recordValues(criterion: Criterion, facts: PersonFacts): string[] {
  const source = criterion.target === 'person' ? facts.person : facts.organization;
  if (!source) return [];
  const raw = (source as unknown as Record<string, unknown>)[criterion.field];
  if (Array.isArray(raw)) return raw.map((entry) => String(entry).trim()).filter((entry) => entry !== '');
  if (typeof raw === 'string' && raw.trim() !== '') return [raw.trim()];
  return [];
}

function matches(criterion: Criterion, values: string[]): boolean {
  if (criterion.operator === 'exists') return values.length > 0;
  const wanted = criterion.values.map((value) => value.toLowerCase());
  const lowered = values.map((value) => value.toLowerCase());
  if (criterion.operator === 'contains') {
    return lowered.some((have) => wanted.some((want) => have.includes(want)));
  }
  return lowered.some((have) => wanted.includes(have));
}

export function evaluateCriterion(criterion: Criterion, facts: PersonFacts, now: string): CriterionResult {
  const subject = criterion.target === 'organization' ? `organization ${fieldLabels[criterion.field]}` : fieldLabels[criterion.field];
  const capitalized = `${subject.charAt(0).toUpperCase()}${subject.slice(1)}`;
  const base = { id: criterion.id, label: criterion.label };

  if (criterion.target === 'organization' && !facts.organization) {
    return { ...base, outcome: 'unknown', reason: 'The person has no organization on record, so this cannot be checked.', evidence: null };
  }
  const values = recordValues(criterion, facts);
  if (values.length === 0) {
    return { ...base, outcome: 'unknown', reason: `No ${subject} on the record, so this cannot be checked.`, evidence: null };
  }

  const shown = values.map((value) => `"${value}"`).join(', ');
  const outcome: Outcome = matches(criterion, values) ? 'matched' : 'not_matched';
  const wanted = joinWords(criterion.values, 'or');
  let reason: string;
  if (criterion.operator === 'exists') reason = `${capitalized} is present: ${shown}.`;
  else if (outcome === 'matched') reason = `${capitalized} ${shown} matches ${wanted}.`;
  else reason = `${capitalized} ${shown} does not match ${wanted}.`;

  // A claim is cited only when it agrees with the record value. Otherwise the record is the evidence.
  const claimField = claimFieldNames[criterion.field];
  const claim = claimField
    ? criterion.target === 'person'
      ? facts.personClaim(claimField)
      : facts.organizationClaim(claimField)
    : undefined;
  const isArrayField = criterion.field === 'tags';
  if (claim && !isArrayField && values.some((value) => value.toLowerCase() === claim.value.trim().toLowerCase())) {
    const ageDays = Math.max(0, Math.floor((Date.parse(now) - Date.parse(claim.observedAt)) / dayMilliseconds));
    return {
      ...base,
      outcome,
      reason: `${reason} Newest ${claimField} claim is ${claim.status}, observed ${ageText(ageDays)}.`,
      evidence: { source: 'claim', claimId: claim.id, status: claim.status, observedAt: claim.observedAt, ageDays, value: claim.value },
    };
  }
  const disagreement =
    claim && !isArrayField ? ` The newest ${claimField} claim says "${claim.value}", which differs from the record.` : '';
  return {
    ...base,
    outcome,
    reason: `${reason} Record data, no claim.${disagreement}`,
    evidence: { source: 'record', value: values.join(', ') },
  };
}

// Exclusions are checked first and a match marks the person excluded. Criteria are still computed so the
// result stays transparent. Disabled rules are skipped and are not part of the total.
export function evaluatePerson(config: QualificationConfig, facts: PersonFacts, now: string): QualificationPayload {
  const excludedReasons: string[] = [];
  for (const exclusion of config.exclusions) {
    if (!exclusion.enabled) continue;
    const result = evaluateCriterion(exclusion, facts, now);
    if (result.outcome === 'matched') excludedReasons.push(`${exclusion.label}: ${result.reason}`);
  }
  const criteria = config.criteria.filter((criterion) => criterion.enabled).map((criterion) => evaluateCriterion(criterion, facts, now));
  return {
    computedAt: now,
    excluded: excludedReasons.length > 0,
    excludedReasons,
    matched: criteria.filter((result) => result.outcome === 'matched').length,
    total: criteria.length,
    unknown: criteria.filter((result) => result.outcome === 'unknown').length,
    criteria,
  };
}
