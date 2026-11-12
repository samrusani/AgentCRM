import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dismissOrganizationDuplicate, mergeOrganizations, resetAllData, resetRecordData } from '../src/actions/index.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { organizationFillableColumns, scanOrganizationDuplicates } from '../src/queries/duplicates.js';
import { getOrganization } from '../src/queries/organizations.js';
import { createTestEnvironment, insertSecondWorkspace } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
const events: DomainEvent[] = [];
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  env.bus.subscribe((event) => events.push(event));
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

beforeEach(() => {
  resetRecordData(env.db);
  env.db.prepare("DELETE FROM attribute_def WHERE entity_type = 'organization'").run();
  events.length = 0;
});

async function call(method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await app.inject({ method, url, headers: { ...host, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: response.statusCode, body: response.body ? (response.json() as Record<string, any>) : {} };
}

function rejected(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('Expected the call to be refused.');
}

let counter = 0;
interface OrgSeed {
  name?: string;
  domain?: string | null;
  kind?: 'fund' | 'company';
  location?: string | null;
  linkedinUrl?: string | null;
  tags?: string[];
  createdAt?: string;
  workspaceId?: string;
}

// Raw inserts, because the action path refuses the very duplicates these tests need to hold. Without an explicit
// createdAt, each organization is a millisecond newer than the last so ordering is deterministic.
function org(seed: OrgSeed = {}): string {
  counter += 1;
  const id = `org_dup${String(counter).padStart(6, '0')}`;
  const created = seed.createdAt ?? new Date(Date.UTC(2026, 0, 1) + counter).toISOString();
  env.db
    .prepare(
      `INSERT INTO organization (id, created_at, workspace_id, version, name, domain, kind, location, linkedin_url, tags, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      created,
      seed.workspaceId ?? env.workspaceId,
      seed.name ?? `Org ${counter}`,
      seed.domain ?? null,
      seed.kind ?? 'company',
      seed.location ?? null,
      seed.linkedinUrl ?? null,
      JSON.stringify(seed.tags ?? []),
      created,
    );
  return id;
}

const scan = () => scanOrganizationDuplicates(env.db, env.workspaceId);
const versionOf = (id: string) => getOrganization(env.db, env.workspaceId, id)!.version;
const body = (survivorId: string, otherId: string, over: Record<string, unknown> = {}) => ({
  otherId,
  expectedVersion: versionOf(survivorId),
  otherExpectedVersion: versionOf(otherId),
  ...over,
});
const count = (sql: string, ...params: unknown[]) => (env.db.prepare(sql).get(...(params as never[])) as { n: number }).n;
const audits = (action: string) =>
  (env.db.prepare('SELECT entity_id, detail FROM audit_event WHERE action = ? ORDER BY created_at, id').all(action) as { entity_id: string; detail: string }[]).map(
    (row) => ({ entityId: row.entity_id, detail: JSON.parse(row.detail) as Record<string, any> }),
  );

function person(organizationId: string | null, id: string): string {
  const now = env.ctx.now();
  env.db
    .prepare("INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, organization_id, updated_at) VALUES (?, ?, ?, 1, 'P', ?, ?, ?)")
    .run(id, now, env.workspaceId, id, organizationId, now);
  return id;
}

function task(orgId: string, id: string, entityType = 'organization'): void {
  const now = env.ctx.now();
  env.db
    .prepare("INSERT INTO task (id, created_at, workspace_id, version, title, entity_type, entity_id, status, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, 'open', ?)")
    .run(id, now, env.workspaceId, id, entityType, orgId, now);
}

function activity(orgId: string, id: string, entityType = 'organization'): void {
  env.db
    .prepare("INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, ?, ?, 'note', 'n', 'user')")
    .run(id, env.ctx.now(), env.workspaceId, entityType, orgId);
}

function claim(orgId: string, id: string): void {
  env.db
    .prepare(
      "INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_type, observed_at, status) VALUES (?, ?, ?, 'organization', ?, 'domain', 'a.com', 'import', ?, 'imported')",
    )
    .run(id, env.ctx.now(), env.workspaceId, orgId, env.ctx.now());
}

function deal(orgId: string | null, id: string): void {
  const stage = env.db.prepare('SELECT s.id AS stageId, s.pipeline_id AS pipelineId FROM stage s ORDER BY s.seq LIMIT 1').get() as { stageId: string; pipelineId: string };
  const now = env.ctx.now();
  env.db
    .prepare(
      'INSERT INTO opportunity (id, created_at, workspace_id, version, name, pipeline_id, stage_id, organization_id, stage_changed_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, now, env.workspaceId, `Deal ${id}`, stage.pipelineId, stage.stageId, orgId, now, now);
}

function attributeDef(key: string, entityType: 'person' | 'organization' = 'organization'): string {
  const id = `atd_${entityType}_${key}`;
  env.db
    .prepare(
      "INSERT OR IGNORE INTO attribute_def (id, created_at, workspace_id, version, entity_type, key, label, kind, seq, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, 'text', 100, ?)",
    )
    .run(id, env.ctx.now(), env.workspaceId, entityType, key, key, env.ctx.now());
  return id;
}

function attribute(orgId: string, key: string, value: string): void {
  env.db
    .prepare("INSERT INTO attribute_value (attribute_id, entity_id, workspace_id, value, currency, updated_at) VALUES (?, ?, ?, ?, 'USD', ?)")
    .run(attributeDef(key), orgId, env.workspaceId, value, env.ctx.now());
}

function dismissedCount(): number {
  return count('SELECT COUNT(*) AS n FROM organization_duplicate_dismissal');
}

describe('organization duplicate scan', () => {
  it('finds a pair that shares a domain, ignoring case and stray spaces', () => {
    const a = org({ domain: 'acme.com' });
    const b = org({ domain: '  ACME.com ' });
    const result = scan();
    expect(result.capped).toBe(false);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ reason: 'domain', reasonText: 'Same domain.', organizationIds: [a, b] });
    expect(result.pairs[0]!.left.id).toBe(a);
    expect(result.pairs[0]!.right.id).toBe(b);
  });

  it('finds a pair that shares a LinkedIn company page across legacy spellings', () => {
    const a = org({ linkedinUrl: 'https://www.linkedin.com/company/acme' });
    const b = org({ linkedinUrl: 'https://WWW.LinkedIn.com/company/acme/' });
    const c = org({ linkedinUrl: 'http://linkedin.com/company/acme?trk=x' });
    const result = scan();
    expect(result.pairs.map((pair) => pair.reason)).toEqual(['linkedin', 'linkedin', 'linkedin']);
    expect(result.pairs.map((pair) => pair.organizationIds)).toEqual([[a, b], [a, c], [b, c]]);
    expect(result.pairs[0]!.reasonText).toBe('Same LinkedIn page.');
  });

  it('keeps different LinkedIn pages apart and falls back to the lowercased raw value when it cannot canonicalize', () => {
    org({ linkedinUrl: 'https://www.linkedin.com/company/acme' });
    org({ linkedinUrl: 'https://www.linkedin.com/company/other' });
    expect(scan().pairs).toEqual([]);
    const c = org({ linkedinUrl: 'Not A Url' });
    const d = org({ linkedinUrl: 'not a url' });
    expect(scan().pairs.map((pair) => pair.organizationIds)).toEqual([[c, d]]);
  });

  it('finds a pair that shares a folded name within the same kind', () => {
    const a = org({ name: 'Acme Capital', kind: 'fund' });
    const b = org({ name: 'ACME  capital!', kind: 'fund' });
    const result = scan();
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ reason: 'name', reasonText: 'Same name.', organizationIds: [a, b] });
  });

  it('does not list organizations of different kinds that share a name', () => {
    org({ name: 'Acme', kind: 'fund' });
    org({ name: 'Acme', kind: 'company' });
    expect(scan().pairs).toEqual([]);
  });

  it('still lists a different-kind pair when a stronger identifier matches', () => {
    const a = org({ name: 'Acme', kind: 'fund', domain: 'acme.com' });
    const b = org({ name: 'Acme', kind: 'company', domain: 'acme.com' });
    const result = scan();
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ reason: 'domain', organizationIds: [a, b] });
  });

  it('ignores empty names after folding and empty identifiers', () => {
    org({ name: '!!!', domain: '' });
    org({ name: '???', domain: '' });
    org({ name: 'Solo', domain: null, linkedinUrl: '' });
    org({ name: 'Other', domain: null, linkedinUrl: '' });
    expect(scan().pairs).toEqual([]);
  });

  it('lists a pair once under the strongest reason when several match', () => {
    org({ name: 'Acme', domain: 'acme.com', linkedinUrl: 'https://www.linkedin.com/company/acme' });
    org({ name: 'Acme', domain: 'acme.com', linkedinUrl: 'https://www.linkedin.com/company/acme' });
    const result = scan();
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]!.reason).toBe('domain');
  });

  it('lists domain and LinkedIn pairs before name pairs, oldest pair first inside each group', () => {
    const n1 = org({ name: 'Zeta', createdAt: '2026-01-01T00:00:01.000Z' });
    const n2 = org({ name: 'Zeta', createdAt: '2026-01-01T00:00:02.000Z' });
    const l1 = org({ linkedinUrl: 'https://www.linkedin.com/company/late', createdAt: '2026-01-02T00:00:01.000Z' });
    const l2 = org({ linkedinUrl: 'https://www.linkedin.com/company/late', createdAt: '2026-01-02T00:00:02.000Z' });
    const d1 = org({ domain: 'early.com', createdAt: '2026-01-01T12:00:01.000Z' });
    const d2 = org({ domain: 'early.com', createdAt: '2026-01-01T12:00:02.000Z' });
    expect(scan().pairs.map((pair) => pair.organizationIds)).toEqual([
      [d1, d2],
      [l1, l2],
      [n1, n2],
    ]);
  });

  it('puts the older record on the left whatever the id order', () => {
    const newer = org({ domain: 'a.com', createdAt: '2026-05-01T00:00:00.000Z' });
    const older = org({ domain: 'a.com', createdAt: '2026-01-01T00:00:00.000Z' });
    const pair = scan().pairs[0]!;
    expect(pair.organizationIds).toEqual([older, newer]);
    expect(pair.left.id).toBe(older);
    expect(pair.right.id).toBe(newer);
  });

  it('excludes dismissed pairs and brings the rest', () => {
    const a = org({ domain: 'a.com' });
    const b = org({ domain: 'a.com' });
    const c = org({ domain: 'a.com' });
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [b, a] });
    expect(scan().pairs.map((pair) => pair.organizationIds)).toEqual([[a, c], [b, c]]);
  });

  it('carries the summary fields and per organization counts', () => {
    const a = org({ name: 'Acme', domain: 'acme.com', kind: 'fund', linkedinUrl: 'https://www.linkedin.com/company/acme' });
    const b = org({ name: 'Acme Inc', domain: 'acme.com' });
    person(a, 'per_a1');
    person(a, 'per_a2');
    person(b, 'per_b1');
    deal(a, 'opp_a1');
    deal(b, 'opp_b1');
    deal(b, 'opp_b2');
    task(a, 'tsk_a1');
    task(b, 'tsk_b1');
    task(b, 'tsk_b2');
    task(a, 'tsk_person_kind', 'person');
    activity(a, 'act_a1');
    activity(a, 'act_a2');
    activity(a, 'act_a3');
    activity(a, 'act_not_org', 'person');
    const pair = scan().pairs[0]!;
    expect(pair.left).toEqual({
      id: a,
      name: 'Acme',
      domain: 'acme.com',
      linkedinUrl: 'https://www.linkedin.com/company/acme',
      kind: 'fund',
      createdAt: expect.any(String),
      version: 1,
      people: 2,
      deals: 1,
      tasks: 1,
      activities: 3,
    });
    expect(pair.right).toMatchObject({ id: b, kind: 'company', people: 1, deals: 2, tasks: 2, activities: 0 });
  });

  it('counts fills in each direction over the fillable columns and organization attributes', () => {
    expect(organizationFillableColumns.map(([field]) => field)).toEqual(['domain', 'location', 'linkedinUrl', 'crunchbaseUrl', 'phone', 'website']);
    const a = org({ name: 'Acme', domain: 'acme.com', location: null, linkedinUrl: null });
    const b = org({ name: 'Acme', domain: 'acme.com', location: 'London', linkedinUrl: 'https://www.linkedin.com/company/acme' });
    attribute(b, 'aum', '5');
    attribute(a, 'stage', 'seed');
    attribute(a, 'aum', '9');
    const pair = scan().pairs[0]!;
    // Keep left: location and LinkedIn fill; aum is held by both so nothing else.
    expect(pair.fillsIfKeepLeft).toBe(2);
    // Keep right: nothing on the columns, one attribute (stage).
    expect(pair.fillsIfKeepRight).toBe(1);
  });

  it('caps the answer at 200 pairs and says so', () => {
    for (let i = 0; i < 201; i += 1) {
      org({ domain: `pair${i}.com` });
      org({ domain: `pair${i}.com` });
    }
    const result = scan();
    expect(result.pairs).toHaveLength(200);
    expect(result.capped).toBe(true);
  });

  it('is not capped at exactly 200 pairs', () => {
    for (let i = 0; i < 200; i += 1) {
      org({ domain: `pair${i}.com` });
      org({ domain: `pair${i}.com` });
    }
    const result = scan();
    expect(result.pairs).toHaveLength(200);
    expect(result.capped).toBe(false);
  });

  it('never crosses workspaces', () => {
    const other = insertSecondWorkspace(env.db);
    org({ domain: 'same.com' });
    org({ domain: 'same.com', workspaceId: other });
    expect(scan().pairs).toEqual([]);
    expect(scanOrganizationDuplicates(env.db, other).pairs).toEqual([]);
  });
});

describe('dismissOrganizationDuplicate', () => {
  it('stores the pair once, ordered, with an audit row, and is idempotent', () => {
    const a = org();
    const b = org();
    const [low, high] = [a, b].sort();
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [high, low] });
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [low, high] });
    expect(env.db.prepare('SELECT organization_a_id, organization_b_id FROM organization_duplicate_dismissal').all()).toEqual([
      { organization_a_id: low, organization_b_id: high },
    ]);
    expect(audits('duplicate.dismiss')).toEqual([{ entityId: low, detail: { organizationIds: [low, high] } }]);
    expect(audits('duplicate.dismiss')).toHaveLength(1);
  });

  it('refuses the same organization twice, an unknown one, a wrong count, an unknown field, and another workspace', () => {
    const a = org();
    const other = insertSecondWorkspace(env.db);
    const foreign = org({ workspaceId: other });
    expect(rejected(() => dismissOrganizationDuplicate(env.ctx, { organizationIds: [a, a] })).code).toBe('validation');
    expect(rejected(() => dismissOrganizationDuplicate(env.ctx, { organizationIds: [a, 'org_missing'] })).code).toBe('not_found');
    expect(rejected(() => dismissOrganizationDuplicate(env.ctx, { organizationIds: [a, foreign] })).code).toBe('not_found');
    expect(rejected(() => dismissOrganizationDuplicate(env.ctx, { organizationIds: [a] })).code).toBe('validation');
    expect(rejected(() => dismissOrganizationDuplicate(env.ctx, { organizationIds: [a, 'x', 'y'] })).code).toBe('validation');
    expect(rejected(() => dismissOrganizationDuplicate(env.ctx, { organizationIds: [a, org()], extra: 1 })).code).toBe('validation');
    expect(dismissedCount()).toBe(0);
    expect(audits('duplicate.dismiss')).toEqual([]);
  });

  it('does not touch the person dismissals table', () => {
    const a = org();
    const b = org();
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [a, b] });
    expect(count('SELECT COUNT(*) AS n FROM duplicate_dismissal')).toBe(0);
  });

  it('clears the dismissal when either organization is deleted', () => {
    const a = org();
    const b = org();
    const c = org();
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [a, b] });
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [b, c] });
    env.db.prepare('DELETE FROM organization WHERE id = ?').run(a);
    expect(dismissedCount()).toBe(1);
    env.db.prepare('DELETE FROM organization WHERE id = ?').run(c);
    expect(dismissedCount()).toBe(0);
  });

  it('rejects an unordered pair at the table level', () => {
    const a = org();
    const b = org();
    const [low, high] = [a, b].sort();
    expect(() =>
      env.db
        .prepare('INSERT INTO organization_duplicate_dismissal (workspace_id, organization_a_id, organization_b_id, created_at) VALUES (?, ?, ?, ?)')
        .run(env.workspaceId, high, low, env.ctx.now()),
    ).toThrow(/CHECK/);
  });

  it('lets resetAllData wipe a database that holds a dismissal', () => {
    const wipe = createTestEnvironment();
    try {
      const insert = (id: string) =>
        wipe.db
          .prepare("INSERT INTO organization (id, created_at, workspace_id, name, kind, updated_at) VALUES (?, '2026-03-01', ?, 'O', 'company', '2026-03-01')")
          .run(id, wipe.workspaceId);
      insert('org_wipe_a');
      insert('org_wipe_b');
      dismissOrganizationDuplicate(wipe.ctx, { organizationIds: ['org_wipe_a', 'org_wipe_b'] });
      expect(wipe.db.prepare('SELECT COUNT(*) AS n FROM organization_duplicate_dismissal').get()).toEqual({ n: 1 });
      expect(() => resetAllData(wipe.db)).not.toThrow();
      for (const table of ['organization_duplicate_dismissal', 'organization', 'workspace']) {
        expect(wipe.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
    } finally {
      wipe.cleanup();
    }
  });

  it('lets resetRecordData wipe the dismissals too', () => {
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [org(), org()] });
    expect(dismissedCount()).toBe(1);
    resetRecordData(env.db);
    expect(dismissedCount()).toBe(0);
  });
});

describe('mergeOrganizations', () => {
  it('emits record_updated for the survivor and record_deleted for the deleted organization, after commit', () => {
    const survivor = org({ name: 'Acme' });
    const other = org({ name: 'Acme Inc' });
    events.length = 0;
    mergeOrganizations(env.ctx, survivor, body(survivor, other));
    expect(events).toContainEqual({ type: 'record_updated', entityType: 'organization', entityId: survivor });
    expect(events).toContainEqual({ type: 'record_deleted', entityType: 'organization', entityId: other });
    expect(events.filter((event) => event.type === 'record_deleted')).toHaveLength(1);
  });

  it('emits nothing when the merge is refused', () => {
    const survivor = org({ name: 'Acme' });
    const other = org({ name: 'Acme Inc' });
    events.length = 0;
    rejected(() => mergeOrganizations(env.ctx, survivor, body(survivor, other, { otherExpectedVersion: 99 })));
    expect(events).toEqual([]);
  });

  it('merges the happy path: fills only empty fields, re-points every table, deletes the other', () => {
    const survivor = org({ name: 'Acme', domain: 'acme.com', location: null, linkedinUrl: null, tags: ['a'] });
    const other = org({ name: 'Acme Inc', domain: 'other.com', location: 'London', linkedinUrl: 'https://www.linkedin.com/company/acme', tags: ['b'] });
    person(other, 'per_1');
    person(other, 'per_2');
    person(survivor, 'per_3');
    deal(other, 'opp_1');
    deal(other, 'opp_2');
    deal(survivor, 'opp_3');
    task(other, 'tsk_1');
    task(survivor, 'tsk_2');
    activity(other, 'act_1');
    activity(other, 'act_2');
    activity(other, 'act_3');
    claim(other, 'clm_1');
    claim(other, 'clm_2');
    // Rows of another entity type that happen to carry the same id must stay where they are.
    task(other, 'tsk_person_kind', 'person');
    activity(other, 'act_person_kind', 'person');

    const result = mergeOrganizations(env.ctx, survivor, body(survivor, other));

    expect(result).toMatchObject({ id: survivor, name: 'Acme', domain: 'acme.com', location: 'London', linkedinUrl: 'https://www.linkedin.com/company/acme', tags: ['a', 'b'], version: 2 });
    expect(getOrganization(env.db, env.workspaceId, other)).toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM organization')).toBe(1);

    expect(count('SELECT COUNT(*) AS n FROM person WHERE organization_id = ?', survivor)).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM person WHERE organization_id = ?', other)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM opportunity WHERE organization_id = ?', survivor)).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM opportunity WHERE organization_id = ?', other)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM task WHERE entity_type = 'organization' AND entity_id = ?", survivor)).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM activity WHERE entity_type = 'organization' AND entity_id = ?", survivor)).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM field_claim WHERE entity_type = 'organization' AND entity_id = ?", survivor)).toBe(2);
    for (const table of ['task', 'activity', 'field_claim']) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE entity_type = 'organization' AND entity_id = ?`, other)).toBe(0);
    }
    expect(count("SELECT COUNT(*) AS n FROM task WHERE entity_type = 'person' AND entity_id = ?", other)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM activity WHERE entity_type = 'person' AND entity_id = ?", other)).toBe(1);

    // Re-pointed rows keep their own versions.
    expect(count('SELECT COUNT(*) AS n FROM person WHERE version != 1')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM opportunity WHERE version != 1')).toBe(0);

    const audit = audits('organization.merge');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toEqual({
      entityId: survivor,
      detail: {
        survivorId: survivor,
        otherId: other,
        moved: { people: 2, opportunities: 2, claims: 2, activities: 3, tasks: 1, meetings: 0 },
        filled: { fields: ['location', 'linkedinUrl'], attributes: 0 },
        displaced: { fields: { domain: 'other.com' }, attributes: [], tags: [] },
      },
    });
  });

  it('keeps a populated survivor field and does not displace an identical value', () => {
    const survivor = org({ domain: 'acme.com', location: 'London', linkedinUrl: 'https://www.linkedin.com/company/acme' });
    const other = org({ domain: 'acme.com', location: 'Paris', linkedinUrl: 'https://www.linkedin.com/company/acme' });
    const result = mergeOrganizations(env.ctx, survivor, body(survivor, other));
    expect(result).toMatchObject({ domain: 'acme.com', location: 'London' });
    const detail = audits('organization.merge')[0]!.detail;
    expect(detail.filled.fields).toEqual([]);
    expect(detail.displaced.fields).toEqual({ location: 'Paris' });
  });

  it('treats an empty string on the survivor as empty and ignores an empty string on the other', () => {
    const survivor = org({ domain: '', location: 'London' });
    const other = org({ domain: 'acme.com', location: '' });
    const result = mergeOrganizations(env.ctx, survivor, body(survivor, other));
    expect(result).toMatchObject({ domain: 'acme.com', location: 'London' });
    expect(audits('organization.merge')[0]!.detail.displaced.fields).toEqual({});
  });

  it('never changes the survivor kind, whatever the other kind says', () => {
    const fund = org({ name: 'Acme', kind: 'fund' });
    const company = org({ name: 'Acme', kind: 'company', domain: 'acme.com' });
    expect(mergeOrganizations(env.ctx, fund, body(fund, company)).kind).toBe('fund');
    const again = org({ name: 'Beta', kind: 'company' });
    const fund2 = org({ name: 'Beta', kind: 'fund' });
    expect(mergeOrganizations(env.ctx, again, body(again, fund2)).kind).toBe('company');
    expect(audits('organization.merge').every((row) => !('kind' in row.detail.displaced.fields) && !row.detail.filled.fields.includes('kind'))).toBe(true);
  });

  it('caps the merged tags at 30, survivor first, and records the dropped ones with no protected tag', () => {
    const survivorTags = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const otherTags = ['s0', 'do-not-contact', ...Array.from({ length: 19 }, (_, i) => `o${i}`)];
    const survivor = org({ tags: survivorTags });
    const other = org({ tags: otherTags });
    const result = mergeOrganizations(env.ctx, survivor, body(survivor, other));
    expect(result!.tags).toHaveLength(30);
    expect(result!.tags.slice(0, 20)).toEqual(survivorTags);
    // The union is 20 + 20 distinct; the last ten are cut and nothing is protected from the cut.
    expect(result!.tags).toEqual([...survivorTags, 'do-not-contact', ...Array.from({ length: 9 }, (_, i) => `o${i}`)]);
    const detail = audits('organization.merge')[0]!.detail;
    expect(detail.displaced.tags).toEqual(Array.from({ length: 10 }, (_, i) => `o${i + 9}`));
  });

  it('drops a guarded-looking tag like any other when it falls past the cap', () => {
    const survivor = org({ tags: Array.from({ length: 30 }, (_, i) => `s${i}`) });
    const other = org({ tags: ['do-not-contact'] });
    const result = mergeOrganizations(env.ctx, survivor, body(survivor, other));
    expect(result!.tags).not.toContain('do-not-contact');
    expect(audits('organization.merge')[0]!.detail.displaced.tags).toEqual(['do-not-contact']);
  });

  it('fills custom attributes per attribute: survivor wins, empty ones move, the rest are captured and deleted', () => {
    const survivor = org({ domain: 'a.com' });
    const other = org({ domain: 'a.com' });
    attribute(survivor, 'aum', '9');
    attribute(other, 'aum', '5');
    attribute(other, 'stage', 'seed');
    const result = mergeOrganizations(env.ctx, survivor, body(survivor, other));
    expect(result!.id).toBe(survivor);
    const rows = env.db.prepare('SELECT attribute_id, entity_id, value FROM attribute_value ORDER BY attribute_id').all();
    expect(rows).toEqual([
      { attribute_id: 'atd_organization_aum', entity_id: survivor, value: '9' },
      { attribute_id: 'atd_organization_stage', entity_id: survivor, value: 'seed' },
    ]);
    expect(count('SELECT COUNT(*) AS n FROM attribute_value WHERE entity_id = ?', other)).toBe(0);
    const detail = audits('organization.merge')[0]!.detail;
    expect(detail.filled.attributes).toBe(1);
    expect(detail.displaced.attributes).toEqual([{ attributeId: 'atd_organization_aum', value: '5' }]);
  });

  it('bumps the survivor version exactly once and emits record_updated for the survivor and record_deleted for the other', () => {
    const survivor = org({ domain: 'a.com' });
    const other = org({ domain: 'a.com' });
    const updatedBefore = getOrganization(env.db, env.workspaceId, survivor)!.updatedAt;
    env.advance(5000);
    events.length = 0;
    const result = mergeOrganizations(env.ctx, survivor, body(survivor, other));
    expect(result!.version).toBe(2);
    expect(result!.updatedAt).not.toBe(updatedBefore);
    expect(events).toEqual([
      { type: 'record_updated', entityType: 'organization', entityId: survivor },
      { type: 'record_deleted', entityType: 'organization', entityId: other },
    ]);
  });

  it('removes dismissals that name the other organization and leaves person dismissals alone', () => {
    const survivor = org();
    const other = org();
    const third = org();
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [survivor, other] });
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [other, third] });
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [survivor, third] });
    const now = env.ctx.now();
    for (const id of ['per_x', 'per_y']) {
      env.db.prepare("INSERT INTO person (id, created_at, workspace_id, first_name, updated_at) VALUES (?, ?, ?, 'P', ?)").run(id, now, env.workspaceId, now);
    }
    env.db.prepare('INSERT INTO duplicate_dismissal (workspace_id, person_a_id, person_b_id, created_at) VALUES (?, ?, ?, ?)').run(env.workspaceId, 'per_x', 'per_y', now);
    mergeOrganizations(env.ctx, survivor, body(survivor, other));
    const [low, high] = [survivor, third].sort();
    expect(env.db.prepare('SELECT organization_a_id, organization_b_id FROM organization_duplicate_dismissal').all()).toEqual([
      { organization_a_id: low, organization_b_id: high },
    ]);
    expect(count('SELECT COUNT(*) AS n FROM duplicate_dismissal')).toBe(1);
  });

  it('removes the deleted organization from the search index', () => {
    const survivor = org({ name: 'Zorbacorp', domain: 'z.com' });
    const other = org({ name: 'Quuxholdings', domain: 'z.com' });
    const indexed = (id: string) => count('SELECT COUNT(*) AS n FROM organization_search WHERE entity_id = ?', id);
    expect(indexed(other)).toBe(1);
    mergeOrganizations(env.ctx, survivor, body(survivor, other));
    expect(indexed(other)).toBe(0);
    expect(indexed(survivor)).toBe(1);
  });

  it('leaves import_row.match_entity_id dangling on purpose', () => {
    const survivor = org();
    const other = org();
    env.db.prepare("INSERT INTO run (id, created_at, workspace_id, kind, title, status) VALUES ('run_imp', ?, ?, 'qualify', 'Run', 'succeeded')").run(env.ctx.now(), env.workspaceId);
    env.db
      .prepare("INSERT INTO import_batch (id, created_at, workspace_id, run_id, source_kind, status, updated_at) VALUES ('imp_1', ?, ?, 'run_imp', 'csv', 'staging', ?)")
      .run(env.ctx.now(), env.workspaceId, env.ctx.now());
    env.db
      .prepare("INSERT INTO import_row (id, created_at, batch_id, seq, raw, match_entity_type, match_entity_id) VALUES ('row_1', ?, 'imp_1', 1, '{}', 'organization', ?)")
      .run(env.ctx.now(), other);
    mergeOrganizations(env.ctx, survivor, body(survivor, other));
    expect(env.db.prepare("SELECT match_entity_id FROM import_row WHERE id = 'row_1'").get()).toEqual({ match_entity_id: other });
  });

  it('is not blocked by people with active sending state: there is no sending gate', () => {
    const survivor = org();
    const other = org();
    person(other, 'per_sender');
    const now = env.ctx.now();
    env.db
      .prepare(
        `INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, updated_at)
         VALUES ('snd_live', ?, ?, 'per_sender', 'inb', 'x@example.com', 's', 'b', 'h', 'queued', ?)`,
      )
      .run(now, env.workspaceId, now);
    expect(() => mergeOrganizations(env.ctx, survivor, body(survivor, other))).not.toThrow();
    expect(env.db.prepare("SELECT organization_id FROM person WHERE id = 'per_sender'").get()).toEqual({ organization_id: survivor });
  });

  it('refuses a stale survivor version with the current record', () => {
    const survivor = org();
    const other = org();
    const error = rejected(() => mergeOrganizations(env.ctx, survivor, body(survivor, other, { expectedVersion: 7 })));
    expect(error.code).toBe('version_conflict');
    expect(error.status).toBe(409);
    expect((error.current as { id: string }).id).toBe(survivor);
    expect(getOrganization(env.db, env.workspaceId, other)).not.toBeNull();
  });

  it('refuses a stale other version with the other record', () => {
    const survivor = org();
    const other = org();
    const error = rejected(() => mergeOrganizations(env.ctx, survivor, body(survivor, other, { otherExpectedVersion: 7 })));
    expect(error.code).toBe('version_conflict');
    expect((error.current as { id: string }).id).toBe(other);
    expect(getOrganization(env.db, env.workspaceId, other)).not.toBeNull();
  });

  it('refuses an organization merged into itself, an unknown id, and another workspace', () => {
    const survivor = org();
    const other = insertSecondWorkspace(env.db);
    const foreign = org({ workspaceId: other });
    const ok = { expectedVersion: 1, otherExpectedVersion: 1 };
    expect(rejected(() => mergeOrganizations(env.ctx, survivor, { otherId: survivor, ...ok })).code).toBe('validation');
    expect(rejected(() => mergeOrganizations(env.ctx, survivor, { otherId: 'org_missing', ...ok })).code).toBe('not_found');
    expect(rejected(() => mergeOrganizations(env.ctx, 'org_missing', { otherId: survivor, ...ok })).code).toBe('not_found');
    expect(rejected(() => mergeOrganizations(env.ctx, survivor, { otherId: foreign, ...ok })).code).toBe('not_found');
    expect(rejected(() => mergeOrganizations(env.ctx, foreign, { otherId: survivor, ...ok })).code).toBe('not_found');
    expect(count('SELECT COUNT(*) AS n FROM organization')).toBe(2);
    expect(audits('organization.merge')).toEqual([]);
  });

  it('refuses an unknown body field and a missing version', () => {
    const survivor = org();
    const other = org();
    expect(rejected(() => mergeOrganizations(env.ctx, survivor, body(survivor, other, { extra: true }))).code).toBe('validation');
    expect(rejected(() => mergeOrganizations(env.ctx, survivor, { otherId: other, expectedVersion: 1 })).code).toBe('validation');
  });

  it('writes nothing when it is refused', () => {
    const survivor = org({ domain: 'a.com' });
    const other = org({ location: 'Rome' });
    person(other, 'per_1');
    attribute(other, 'aum', '5');
    rejected(() => mergeOrganizations(env.ctx, survivor, body(survivor, other, { otherExpectedVersion: 9 })));
    expect(env.db.prepare("SELECT organization_id FROM person WHERE id = 'per_1'").get()).toEqual({ organization_id: other });
    expect(count('SELECT COUNT(*) AS n FROM attribute_value WHERE entity_id = ?', other)).toBe(1);
    expect(versionOf(survivor)).toBe(1);
    expect(audits('organization.merge')).toEqual([]);
  });

  it('rolls everything back if the delete fails partway', () => {
    const survivor = org();
    const other = org({ location: 'Rome' });
    person(other, 'per_1');
    // A trigger that refuses the survivor update stands in for any late failure inside the transaction.
    env.db.exec("CREATE TRIGGER fail_merge BEFORE UPDATE OF tags ON organization BEGIN SELECT RAISE(ABORT, 'boom'); END");
    try {
      expect(() => mergeOrganizations(env.ctx, survivor, body(survivor, other))).toThrow(/boom/);
    } finally {
      env.db.exec('DROP TRIGGER fail_merge');
    }
    expect(getOrganization(env.db, env.workspaceId, other)).not.toBeNull();
    expect(env.db.prepare("SELECT organization_id FROM person WHERE id = 'per_1'").get()).toEqual({ organization_id: other });
    expect(versionOf(survivor)).toBe(1);
  });
});

describe('organization duplicate routes', () => {
  it('serves GET /api/duplicates/organizations without writing anything', async () => {
    org({ domain: 'a.com' });
    org({ domain: 'a.com' });
    const tables = ['organization', 'audit_event', 'organization_duplicate_dismissal', 'activity', 'task', 'job'];
    const snapshot = () => JSON.stringify(tables.map((table) => env.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    const before = snapshot();
    const response = await call('GET', '/api/duplicates/organizations');
    expect(response.status).toBe(200);
    expect(response.body.capped).toBe(false);
    expect(response.body.pairs).toHaveLength(1);
    expect(response.body.pairs[0].reasonText).toBe('Same domain.');
    expect(snapshot()).toBe(before);
  });

  it('keeps the person and organization scans separate', async () => {
    org({ domain: 'a.com' });
    org({ domain: 'a.com' });
    expect((await call('GET', '/api/duplicates')).body.pairs).toEqual([]);
  });

  it('dismisses and merges over HTTP', async () => {
    const a = org({ domain: 'a.com' });
    const b = org({ domain: 'a.com' });
    const c = org({ domain: 'c.com' });
    const d = org({ domain: 'c.com' });
    expect((await call('POST', '/api/duplicates/organizations/dismiss', { organizationIds: [a, b] })).status).toBe(200);
    expect((await call('GET', '/api/duplicates/organizations')).body.pairs).toHaveLength(1);
    const merged = await call('POST', `/api/organizations/${c}/merge`, { otherId: d, expectedVersion: 1, otherExpectedVersion: 1 });
    expect(merged.status).toBe(200);
    expect(merged.body.id).toBe(c);
    expect((await call('GET', '/api/duplicates/organizations')).body.pairs).toHaveLength(0);
  });

  it('answers a stale version with 409 version_conflict and unknown ids with 404', async () => {
    const a = org();
    const b = org();
    const stale = await call('POST', `/api/organizations/${a}/merge`, { otherId: b, expectedVersion: 5, otherExpectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    const missing = await call('POST', `/api/organizations/${a}/merge`, { otherId: 'org_missing', expectedVersion: 1, otherExpectedVersion: 1 });
    expect(missing.status).toBe(404);
  });

  it('refuses both writes from a web page on another origin', async () => {
    const a = org();
    const b = org();
    const origin = { origin: 'https://evil.example.com' };
    const dismiss = await call('POST', '/api/duplicates/organizations/dismiss', { organizationIds: [a, b] }, origin);
    const merge = await call('POST', `/api/organizations/${a}/merge`, { otherId: b, expectedVersion: 1, otherExpectedVersion: 1 }, origin);
    expect(dismiss.status).toBe(403);
    expect(merge.status).toBe(403);
    expect(dismissedCount()).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM organization')).toBe(2);
    const local = await call('POST', '/api/duplicates/organizations/dismiss', { organizationIds: [a, b] }, { origin: 'http://localhost:5173' });
    expect(local.status).toBe(200);
  });
});
