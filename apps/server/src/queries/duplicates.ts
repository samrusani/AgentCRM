import type { Db } from '../db.js';
import { normalizeName } from '../actions/apifyMapping.js';
import { canonicalCompanyLinkedinUrl, normalizeProfileUrl, normalizeXProfileUrl } from '../actions/profileUrls.js';
import { type Person, type Row, toOrganization, toPerson } from '../records.js';

export const maxDuplicatePairs = 200;
// A group that shares one identifier can hold many people. Pairs beyond this many per reason are not built; the answer
// is then reported as capped, which it would be anyway at this size.
const maxPairsPerReason = 2000;

export type DuplicateReason = 'email' | 'linkedin' | 'x' | 'name_organization';

export const duplicateReasonText: Record<DuplicateReason, string> = {
  email: 'Same email address.',
  linkedin: 'Same LinkedIn profile.',
  x: 'Same X handle.',
  name_organization: 'Same name at the same organization.',
};

export interface DuplicateSummary {
  id: string;
  name: string;
  email: string | null;
  organizationName: string | null;
  linkedinUrl: string | null;
  lifecycle: 'lead' | 'relationship';
  createdAt: string;
  version: number;
  deals: number;
  tasks: number;
  activities: number;
}

export interface DuplicatePair {
  personIds: [string, string];
  reason: DuplicateReason;
  reasonText: string;
  // The older record is on the left.
  left: DuplicateSummary;
  right: DuplicateSummary;
  // How many empty fields (custom attributes included) the survivor would fill from the other record.
  fillsIfKeepLeft: number;
  fillsIfKeepRight: number;
}

export interface DuplicateScan {
  pairs: DuplicatePair[];
  capped: boolean;
}

export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

// Folds a stored domain to the host it means: strips a scheme, a leading www., any path, and a trailing dot,
// then trims and lowercases. Only the scan keys on this; stored values are never rewritten.
export function foldDomainKey(value: string): string {
  let host = value.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const slash = host.indexOf('/');
  if (slash !== -1) host = host.slice(0, slash);
  if (host.startsWith('www.')) host = host.slice(4);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

const pairKey = (a: string, b: string): string => orderedPair(a, b).join('|');

// The person columns a merge can fill when the survivor has no value. Birthday and next action date included.
export const fillableColumns = [
  ['lastName', 'last_name'],
  ['email', 'email'],
  ['title', 'title'],
  ['organizationId', 'organization_id'],
  ['location', 'location'],
  ['linkedinUrl', 'linkedin_url'],
  ['xUrl', 'x_url'],
  ['birthday', 'birthday'],
  ['nextActionAt', 'next_action_at'],
] as const;

const isEmpty = (value: unknown): boolean => value === null || value === undefined || value === '';

// What the survivor would take from the other record: its empty built in fields and the attributes it has no value for.
export function planFill(
  survivor: Person,
  other: Person,
  survivorAttributes: ReadonlySet<string>,
  otherAttributes: ReadonlySet<string>,
): { columns: (typeof fillableColumns)[number][]; attributeIds: string[] } {
  const columns = fillableColumns.filter(([field]) => isEmpty(survivor[field]) && !isEmpty(other[field]));
  const attributeIds = [...otherAttributes].filter((id) => !survivorAttributes.has(id));
  return { columns, attributeIds };
}

interface Member {
  id: string;
  createdAt: string;
}

// People that share a key, oldest first. A group of n people yields n choose 2 pairs, oldest pair first.
// Shared by the person and organization scans.
function pairsOf<R extends string>(members: Member[], reason: R, dismissed: Set<string>, into: Map<string, Candidate<R>>, budget: { left: number }): void {
  const sorted = [...members].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  for (let j = 1; j < sorted.length; j += 1) {
    for (let i = 0; i < j; i += 1) {
      if (budget.left <= 0) return;
      const older = sorted[i]!;
      const newer = sorted[j]!;
      const key = pairKey(older.id, newer.id);
      if (dismissed.has(key) || into.has(key)) continue;
      into.set(key, { left: older.id, right: newer.id, reason, age: newer.createdAt });
      budget.left -= 1;
    }
  }
}

interface Candidate<R extends string = DuplicateReason> {
  left: string;
  right: string;
  reason: R;
  // When the second record of the pair appeared; the pair that has been around longest sorts first.
  age: string;
}

function groupBy<T>(rows: T[], key: (row: T) => string | null): Member[][] {
  const groups = new Map<string, Member[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null || k === '') continue;
    const member = row as unknown as Member;
    const list = groups.get(k);
    if (list) list.push(member);
    else groups.set(k, [member]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

const byAge = (a: Candidate<string>, b: Candidate<string>): number =>
  a.age < b.age ? -1 : a.age > b.age ? 1 : a.left < b.left ? -1 : a.left > b.left ? 1 : a.right < b.right ? -1 : a.right > b.right ? 1 : 0;

// Candidate person pairs, computed live. Four grouped passes over indexed columns (lower(email), linkedin_url, x_url,
// organization_id), then summaries for the at most 200 pairs that are shown.
export function scanDuplicates(db: Db, workspaceId: string): DuplicateScan {
  const dismissed = new Set(
    (db.prepare('SELECT person_a_id, person_b_id FROM duplicate_dismissal WHERE workspace_id = ?').all(workspaceId) as {
      person_a_id: string;
      person_b_id: string;
    }[]).map((row) => pairKey(row.person_a_id, row.person_b_id)),
  );

  const found = new Map<string, Candidate>();
  const reasonBuckets: Record<DuplicateReason, Map<string, Candidate>> = {
    email: new Map(),
    linkedin: new Map(),
    x: new Map(),
    name_organization: new Map(),
  };
  const gather = (reason: DuplicateReason, groups: Member[][]): void => {
    const budget = { left: maxPairsPerReason };
    for (const group of groups) pairsOf(group, reason, dismissed, reasonBuckets[reason], budget);
  };

  const emailRows = db
    .prepare(
      `SELECT id, created_at AS createdAt, lower(email) AS k FROM person
       WHERE workspace_id = ? AND email IS NOT NULL AND email != ''
         AND lower(email) IN (SELECT lower(email) FROM person WHERE workspace_id = ? AND email IS NOT NULL AND email != '' GROUP BY lower(email) HAVING COUNT(*) > 1)`,
    )
    .all(workspaceId, workspaceId) as (Member & { k: string })[];
  gather('email', groupBy(emailRows, (row) => row.k));

  const linkedinRows = db
    .prepare("SELECT id, created_at AS createdAt, linkedin_url AS url FROM person WHERE workspace_id = ? AND linkedin_url IS NOT NULL AND linkedin_url != ''")
    .all(workspaceId) as (Member & { url: string })[];
  gather('linkedin', groupBy(linkedinRows, (row) => normalizeProfileUrl(row.url)));

  // Like LinkedIn, the key is computed in code: a lower() prefilter in SQL would miss raw or legacy spellings
  // (a trailing slash, a twitter.com host) that normalize to the same handle.
  const xRows = db
    .prepare("SELECT id, created_at AS createdAt, x_url AS url FROM person WHERE workspace_id = ? AND x_url IS NOT NULL AND x_url != ''")
    .all(workspaceId) as (Member & { url: string })[];
  gather('x', groupBy(xRows, (row) => normalizeXProfileUrl(row.url)?.key ?? row.url.toLowerCase()));

  const nameRows = db
    .prepare(
      `SELECT id, created_at AS createdAt, first_name AS firstName, last_name AS lastName, organization_id AS organizationId FROM person
       WHERE workspace_id = ? AND organization_id IS NOT NULL
         AND organization_id IN (SELECT organization_id FROM person WHERE workspace_id = ? AND organization_id IS NOT NULL GROUP BY organization_id HAVING COUNT(*) > 1)`,
    )
    .all(workspaceId, workspaceId) as (Member & { firstName: string; lastName: string; organizationId: string })[];
  gather(
    'name_organization',
    groupBy(nameRows, (row) => {
      const name = normalizeName(`${row.firstName} ${row.lastName}`);
      return name === '' ? null : `${row.organizationId}|${name}`;
    }),
  );

  // A pair that matches on several reasons is listed once under the strongest.
  for (const reason of ['email', 'linkedin', 'x', 'name_organization'] as const) {
    for (const [key, candidate] of reasonBuckets[reason]) if (!found.has(key)) found.set(key, candidate);
  }

  const all = [...found.values()];
  const strong = all.filter((candidate) => candidate.reason !== 'name_organization').sort(byAge);
  const weak = all.filter((candidate) => candidate.reason === 'name_organization').sort(byAge);
  const ordered = [...strong, ...weak];
  const shown = ordered.slice(0, maxDuplicatePairs);
  const capped = ordered.length > maxDuplicatePairs;
  return { pairs: buildPairs(db, workspaceId, shown), capped };
}

function buildPairs(db: Db, workspaceId: string, candidates: Candidate[]): DuplicatePair[] {
  if (candidates.length === 0) return [];
  const ids = JSON.stringify([...new Set(candidates.flatMap((candidate) => [candidate.left, candidate.right]))]);
  const people = new Map<string, Person>();
  for (const row of db
    .prepare(
      `SELECT p.*, o.name AS organization_name FROM person p LEFT JOIN organization o ON o.id = p.organization_id
       WHERE p.workspace_id = ? AND p.id IN (SELECT value FROM json_each(?))`,
    )
    .all(workspaceId, ids) as Row[]) {
    const person = toPerson(row);
    people.set(person.id, person);
  }

  const counts = (sql: string): Map<string, number> =>
    new Map((db.prepare(sql).all(workspaceId, ids) as { id: string; n: number }[]).map((row) => [row.id, Number(row.n)]));
  const deals = counts(
    'SELECT person_id AS id, COUNT(*) AS n FROM opportunity WHERE workspace_id = ? AND person_id IN (SELECT value FROM json_each(?)) GROUP BY person_id',
  );
  const tasks = counts(
    "SELECT entity_id AS id, COUNT(*) AS n FROM task WHERE workspace_id = ? AND entity_type = 'person' AND entity_id IN (SELECT value FROM json_each(?)) GROUP BY entity_id",
  );
  const activities = counts(
    "SELECT entity_id AS id, COUNT(*) AS n FROM activity WHERE workspace_id = ? AND entity_type = 'person' AND entity_id IN (SELECT value FROM json_each(?)) GROUP BY entity_id",
  );

  const attributes = new Map<string, Set<string>>();
  for (const row of db
    .prepare('SELECT entity_id, attribute_id FROM attribute_value WHERE workspace_id = ? AND entity_id IN (SELECT value FROM json_each(?))')
    .all(workspaceId, ids) as { entity_id: string; attribute_id: string }[]) {
    const set = attributes.get(row.entity_id);
    if (set) set.add(row.attribute_id);
    else attributes.set(row.entity_id, new Set([row.attribute_id]));
  }
  const attributesOf = (id: string): ReadonlySet<string> => attributes.get(id) ?? new Set<string>();

  const summarize = (person: Person): DuplicateSummary => ({
    id: person.id,
    name: person.name,
    email: person.email,
    organizationName: person.organizationName,
    linkedinUrl: person.linkedinUrl,
    lifecycle: person.lifecycle,
    createdAt: person.createdAt,
    version: person.version,
    deals: deals.get(person.id) ?? 0,
    tasks: tasks.get(person.id) ?? 0,
    activities: activities.get(person.id) ?? 0,
  });

  const pairs: DuplicatePair[] = [];
  for (const candidate of candidates) {
    const left = people.get(candidate.left);
    const right = people.get(candidate.right);
    if (!left || !right) continue;
    const fill = (survivor: Person, other: Person): number => {
      const plan = planFill(survivor, other, attributesOf(survivor.id), attributesOf(other.id));
      return plan.columns.length + plan.attributeIds.length;
    };
    pairs.push({
      personIds: [left.id, right.id],
      reason: candidate.reason,
      reasonText: duplicateReasonText[candidate.reason],
      left: summarize(left),
      right: summarize(right),
      fillsIfKeepLeft: fill(left, right),
      fillsIfKeepRight: fill(right, left),
    });
  }
  return pairs;
}

// ---- Organizations ----

export type OrganizationDuplicateReason = 'domain' | 'linkedin' | 'name';

export const organizationDuplicateReasonText: Record<OrganizationDuplicateReason, string> = {
  domain: 'Same domain.',
  linkedin: 'Same LinkedIn page.',
  name: 'Same name.',
};

export interface OrganizationDuplicateSummary {
  id: string;
  name: string;
  domain: string | null;
  linkedinUrl: string | null;
  kind: 'fund' | 'company';
  createdAt: string;
  version: number;
  people: number;
  deals: number;
  tasks: number;
  activities: number;
}

export interface OrganizationDuplicatePair {
  organizationIds: [string, string];
  reason: OrganizationDuplicateReason;
  reasonText: string;
  // The older record is on the left.
  left: OrganizationDuplicateSummary;
  right: OrganizationDuplicateSummary;
  // How many empty fields (custom attributes included) the survivor would fill from the other record.
  fillsIfKeepLeft: number;
  fillsIfKeepRight: number;
}

export interface OrganizationDuplicateScan {
  pairs: OrganizationDuplicatePair[];
  capped: boolean;
}

type OrganizationRecord = NonNullable<ReturnType<typeof toOrganization>>;

// The organization columns a merge can fill when the survivor has no value. The kind is deliberately absent: a merge never changes it.
export const organizationFillableColumns = [
  ['domain', 'domain'],
  ['location', 'location'],
  ['linkedinUrl', 'linkedin_url'],
] as const;

// What the survivor would take from the other organization: its empty built in fields and the attributes it has no value for.
export function planOrganizationFill(
  survivor: OrganizationRecord,
  other: OrganizationRecord,
  survivorAttributes: ReadonlySet<string>,
  otherAttributes: ReadonlySet<string>,
): { columns: (typeof organizationFillableColumns)[number][]; attributeIds: string[] } {
  const columns = organizationFillableColumns.filter(([field]) => isEmpty(survivor[field]) && !isEmpty(other[field]));
  const attributeIds = [...otherAttributes].filter((id) => !survivorAttributes.has(id));
  return { columns, attributeIds };
}

// Candidate organization pairs, computed live. Every key is computed in code over the stored values, then summaries are
// built for the at most 200 pairs that are shown.
export function scanOrganizationDuplicates(db: Db, workspaceId: string): OrganizationDuplicateScan {
  const dismissed = new Set(
    (db.prepare('SELECT organization_a_id, organization_b_id FROM organization_duplicate_dismissal WHERE workspace_id = ?').all(workspaceId) as {
      organization_a_id: string;
      organization_b_id: string;
    }[]).map((row) => pairKey(row.organization_a_id, row.organization_b_id)),
  );

  const reasonBuckets: Record<OrganizationDuplicateReason, Map<string, Candidate<OrganizationDuplicateReason>>> = {
    domain: new Map(),
    linkedin: new Map(),
    name: new Map(),
  };
  const gather = (reason: OrganizationDuplicateReason, groups: Member[][]): void => {
    const budget = { left: maxPairsPerReason };
    for (const group of groups) pairsOf(group, reason, dismissed, reasonBuckets[reason], budget);
  };

  // The domain key is computed in code. The write paths guard against exact duplicates, so the rows this reason
  // exists for are legacy spellings that mean the same host: a scheme, a leading www., a path, a trailing dot.
  const domainRows = db
    .prepare("SELECT id, created_at AS createdAt, domain AS value FROM organization WHERE workspace_id = ? AND domain IS NOT NULL AND domain != ''")
    .all(workspaceId) as (Member & { value: string })[];
  gather('domain', groupBy(domainRows, (row) => foldDomainKey(row.value)));

  // Like the person LinkedIn and X passes, the key is computed in code over every non null row: a SQL prefilter would
  // miss raw or legacy spellings (a trailing slash, an uppercase host) that canonicalize to the same company page.
  const linkedinRows = db
    .prepare("SELECT id, created_at AS createdAt, linkedin_url AS value FROM organization WHERE workspace_id = ? AND linkedin_url IS NOT NULL AND linkedin_url != ''")
    .all(workspaceId) as (Member & { value: string })[];
  // LinkedIn resolves company slugs case-insensitively, so the scan key folds case; the stored value keeps its spelling.
  gather('linkedin', groupBy(linkedinRows, (row) => (canonicalCompanyLinkedinUrl(row.value) ?? row.value.trim()).toLowerCase()));

  // Two organizations of different kinds that share a name are not evidence, so the kind is part of the group key.
  const nameRows = db
    .prepare('SELECT id, created_at AS createdAt, name, kind FROM organization WHERE workspace_id = ?')
    .all(workspaceId) as (Member & { name: string; kind: string })[];
  gather(
    'name',
    groupBy(nameRows, (row) => {
      const name = normalizeName(row.name);
      return name === '' ? null : `${row.kind}|${name}`;
    }),
  );

  // A pair that matches on several reasons is listed once under the strongest.
  const found = new Map<string, Candidate<OrganizationDuplicateReason>>();
  for (const reason of ['domain', 'linkedin', 'name'] as const) {
    for (const [key, candidate] of reasonBuckets[reason]) if (!found.has(key)) found.set(key, candidate);
  }

  const all = [...found.values()];
  const strong = all.filter((candidate) => candidate.reason !== 'name').sort(byAge);
  const weak = all.filter((candidate) => candidate.reason === 'name').sort(byAge);
  const ordered = [...strong, ...weak];
  const shown = ordered.slice(0, maxDuplicatePairs);
  return { pairs: buildOrganizationPairs(db, workspaceId, shown), capped: ordered.length > maxDuplicatePairs };
}

function buildOrganizationPairs(db: Db, workspaceId: string, candidates: Candidate<OrganizationDuplicateReason>[]): OrganizationDuplicatePair[] {
  if (candidates.length === 0) return [];
  const ids = JSON.stringify([...new Set(candidates.flatMap((candidate) => [candidate.left, candidate.right]))]);
  const organizations = new Map<string, OrganizationRecord>();
  for (const row of db
    .prepare('SELECT * FROM organization WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))')
    .all(workspaceId, ids) as Row[]) {
    const organization = toOrganization(row);
    organizations.set(organization.id, organization);
  }

  const counts = (sql: string): Map<string, number> =>
    new Map((db.prepare(sql).all(workspaceId, ids) as { id: string; n: number }[]).map((row) => [row.id, Number(row.n)]));
  const people = counts(
    'SELECT organization_id AS id, COUNT(*) AS n FROM person WHERE workspace_id = ? AND organization_id IN (SELECT value FROM json_each(?)) GROUP BY organization_id',
  );
  const deals = counts(
    'SELECT organization_id AS id, COUNT(*) AS n FROM opportunity WHERE workspace_id = ? AND organization_id IN (SELECT value FROM json_each(?)) GROUP BY organization_id',
  );
  const tasks = counts(
    "SELECT entity_id AS id, COUNT(*) AS n FROM task WHERE workspace_id = ? AND entity_type = 'organization' AND entity_id IN (SELECT value FROM json_each(?)) GROUP BY entity_id",
  );
  const activities = counts(
    "SELECT entity_id AS id, COUNT(*) AS n FROM activity WHERE workspace_id = ? AND entity_type = 'organization' AND entity_id IN (SELECT value FROM json_each(?)) GROUP BY entity_id",
  );

  // Person and organization attribute ids never collide on one entity id, so keying by entity_id alone is safe.
  const attributes = new Map<string, Set<string>>();
  for (const row of db
    .prepare('SELECT entity_id, attribute_id FROM attribute_value WHERE workspace_id = ? AND entity_id IN (SELECT value FROM json_each(?))')
    .all(workspaceId, ids) as { entity_id: string; attribute_id: string }[]) {
    const set = attributes.get(row.entity_id);
    if (set) set.add(row.attribute_id);
    else attributes.set(row.entity_id, new Set([row.attribute_id]));
  }
  const attributesOf = (id: string): ReadonlySet<string> => attributes.get(id) ?? new Set<string>();

  const summarize = (organization: OrganizationRecord): OrganizationDuplicateSummary => ({
    id: organization.id,
    name: organization.name,
    domain: organization.domain,
    linkedinUrl: organization.linkedinUrl,
    kind: organization.kind,
    createdAt: organization.createdAt,
    version: organization.version,
    people: people.get(organization.id) ?? 0,
    deals: deals.get(organization.id) ?? 0,
    tasks: tasks.get(organization.id) ?? 0,
    activities: activities.get(organization.id) ?? 0,
  });

  const pairs: OrganizationDuplicatePair[] = [];
  for (const candidate of candidates) {
    const left = organizations.get(candidate.left);
    const right = organizations.get(candidate.right);
    if (!left || !right) continue;
    const fill = (survivor: OrganizationRecord, other: OrganizationRecord): number => {
      const plan = planOrganizationFill(survivor, other, attributesOf(survivor.id), attributesOf(other.id));
      return plan.columns.length + plan.attributeIds.length;
    };
    pairs.push({
      organizationIds: [left.id, right.id],
      reason: candidate.reason,
      reasonText: organizationDuplicateReasonText[candidate.reason],
      left: summarize(left),
      right: summarize(right),
      fillsIfKeepLeft: fill(left, right),
      fillsIfKeepRight: fill(right, left),
    });
  }
  return pairs;
}
