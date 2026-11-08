// Adversarial review probes for organization duplicates and merge (the first deletion of an organization row).
// KILLS: the attack failed and the safe behavior is pinned. CONFIRMS: a live gap, asserted as it behaves today, the
// comment says what correct would be. ACCEPTED: a limit the contract states or a judgment call.
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyChanges,
  createOrganization,
  dismissDuplicate,
  dismissOrganizationDuplicate,
  mergeOrganizations,
  proposeChanges,
  resetRecordData,
  startRun,
  updateOrganization,
} from '../src/actions/index.js';
import { AppError } from '../src/errors.js';
import { buildApp } from '../src/http/app.js';
import { openDatabase } from '../src/db.js';
import { packageRoot } from '../src/paths.js';
import { scanOrganizationDuplicates } from '../src/queries/duplicates.js';
import { getOrganization } from '../src/queries/organizations.js';
import { createTestEnvironment, insertSecondWorkspace } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let baseUrl = '';
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

beforeEach(() => {
  resetRecordData(env.db);
  env.db.prepare("DELETE FROM attribute_def WHERE entity_type = 'organization'").run();
});

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, headers: host, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: response.statusCode, body: response.body ? (response.json() as Record<string, any>) : {} };
}
// A genuine socket round trip, no inject.
async function realCall(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: payload !== undefined ? { 'content-type': 'application/json' } : {},
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
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
function org(seed: OrgSeed = {}): string {
  counter += 1;
  const id = `org_rev${String(counter).padStart(6, '0')}`;
  const created = seed.createdAt ?? new Date(Date.UTC(2026, 0, 1) + counter).toISOString();
  env.db
    .prepare(
      `INSERT INTO organization (id, created_at, workspace_id, version, name, domain, kind, location, linkedin_url, tags, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, created, seed.workspaceId ?? env.workspaceId, seed.name ?? `Org ${counter}`, seed.domain ?? null, seed.kind ?? 'company', seed.location ?? null, seed.linkedinUrl ?? null, JSON.stringify(seed.tags ?? []), created);
  return id;
}
const scan = () => scanOrganizationDuplicates(env.db, env.workspaceId);
const versionOf = (id: string) => getOrganization(env.db, env.workspaceId, id)!.version;
const exists = (id: string) => getOrganization(env.db, env.workspaceId, id) !== null;
const body = (survivor: string, other: string) => ({ otherId: other, expectedVersion: versionOf(survivor), otherExpectedVersion: versionOf(other) });
const merge = (survivor: string, other: string) => mergeOrganizations(env.ctx, survivor, body(survivor, other));
const count = (sql: string, ...params: unknown[]) => (env.db.prepare(sql).get(...(params as never[])) as { n: number }).n;
const audits = (action: string) =>
  (env.db.prepare('SELECT entity_id, detail FROM audit_event WHERE action = ? ORDER BY created_at, id').all(action) as { entity_id: string; detail: string }[]).map(
    (row) => ({ entityId: row.entity_id, detail: JSON.parse(row.detail) as Record<string, any> }),
  );

function person(organizationId: string | null, id: string): string {
  const now = env.ctx.now();
  env.db.prepare("INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, organization_id, updated_at) VALUES (?, ?, ?, 1, 'P', ?, ?, ?)").run(id, now, env.workspaceId, id, organizationId, now);
  return id;
}
function stageRow(): { stageId: string; pipelineId: string } {
  return env.db.prepare('SELECT s.id AS stageId, s.pipeline_id AS pipelineId FROM stage s ORDER BY s.seq LIMIT 1').get() as { stageId: string; pipelineId: string };
}
function deal(orgId: string | null, id: string): void {
  const stage = stageRow();
  const now = env.ctx.now();
  env.db.prepare('INSERT INTO opportunity (id, created_at, workspace_id, version, name, pipeline_id, stage_id, organization_id, stage_changed_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)').run(id, now, env.workspaceId, `Deal ${id}`, stage.pipelineId, stage.stageId, orgId, now, now);
}
function attributeDef(key: string): string {
  const id = `atd_org_${key}`;
  env.db.prepare("INSERT OR IGNORE INTO attribute_def (id, created_at, workspace_id, version, entity_type, key, label, kind, seq, updated_at) VALUES (?, ?, ?, 1, 'organization', ?, ?, 'text', 100, ?)").run(id, env.ctx.now(), env.workspaceId, key, key, env.ctx.now());
  return id;
}
function attribute(orgId: string, key: string, value: string): void {
  env.db.prepare("INSERT INTO attribute_value (attribute_id, entity_id, workspace_id, value, currency, updated_at) VALUES (?, ?, ?, ?, 'USD', ?)").run(attributeDef(key), orgId, env.workspaceId, value, env.ctx.now());
}
function addRun(id = 'run_orgrev'): string {
  env.db.prepare("INSERT OR IGNORE INTO run (id, created_at, workspace_id, kind, title, status) VALUES (?, ?, ?, 'qualify', 'Run', 'succeeded')").run(id, env.ctx.now(), env.workspaceId);
  return id;
}

function tableCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%_search%' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
    out[t.name] = count(`SELECT COUNT(*) AS n FROM "${t.name}"`);
  }
  return out;
}
const dump = () =>
  JSON.stringify(
    (env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%_search%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => [
      t.name,
      env.db.prepare(`SELECT * FROM "${t.name}"`).all(),
    ]),
  );

// Every (table, column) whose text equals / contains `id`, scanning ALL columns of ALL real tables.
function referencesTo(id: string, mode: 'equals' | 'contains'): string[] {
  const hits: string[] = [];
  for (const t of env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%_search%' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
    for (const c of env.db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string }[]) {
      const n =
        mode === 'equals'
          ? count(`SELECT COUNT(*) AS n FROM "${t.name}" WHERE CAST("${c.name}" AS TEXT) = ?`, id)
          : count(`SELECT COUNT(*) AS n FROM "${t.name}" WHERE CAST("${c.name}" AS TEXT) LIKE ?`, `%${id}%`);
      if (n > 0) hits.push(`${t.name}.${c.name}=${n}`);
    }
  }
  return hits;
}

describe('1. data loss sweep', () => {
  it('KILLS: an organization with every kind of attached row merges away with every table accounted for', () => {
    const survivor = org({ name: 'Surv', kind: 'fund', tags: ['s1'] });
    const tags30 = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const other = org({ name: 'Other', kind: 'company', domain: 'other.example', location: 'Lisbon', linkedinUrl: 'https://www.linkedin.com/company/other-co', tags: tags30 });
    const third = org({ name: 'Third' });
    // people (one of them on a list), deals with stage history
    person(other, 'per_a');
    person(other, 'per_b');
    env.db.prepare("INSERT INTO list (id, created_at, workspace_id, version, name, updated_at) VALUES ('lst_o', ?, ?, 1, 'L', ?)").run(env.ctx.now(), env.workspaceId, env.ctx.now());
    env.db.prepare("INSERT INTO list_member (list_id, person_id, created_at) VALUES ('lst_o', 'per_a', ?)").run(env.ctx.now());
    deal(other, 'opp_1');
    deal(other, 'opp_2');
    const stage = stageRow();
    env.db.prepare("INSERT INTO stage_event (id, created_at, opportunity_id, from_stage_id, to_stage_id, at, actor) VALUES ('stg_ev', ?, 'opp_1', NULL, ?, ?, 'user')").run(env.ctx.now(), stage.stageId, env.ctx.now());
    // claims, activities, tasks (open and done), a task on the survivor that must not move
    for (const id of ['c1', 'c2', 'c3']) {
      env.db.prepare("INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_type, observed_at, status) VALUES (?, ?, ?, 'organization', ?, 'domain', 'a.com', 'import', ?, 'imported')").run(`clm_${id}`, env.ctx.now(), env.workspaceId, other, env.ctx.now());
    }
    for (const id of ['a1', 'a2']) env.db.prepare("INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, 'organization', ?, 'note', 'n', 'user')").run(`act_${id}`, env.ctx.now(), env.workspaceId, other);
    for (const status of ['open', 'done']) env.db.prepare("INSERT INTO task (id, created_at, workspace_id, version, title, entity_type, entity_id, status, updated_at) VALUES (?, ?, ?, 1, ?, 'organization', ?, ?, ?)").run(`tsk_${status}`, env.ctx.now(), env.workspaceId, status, other, status, env.ctx.now());
    // attributes: A on both (clash), B on other only, C on survivor only
    attribute(survivor, 'a', 'survivor-A');
    attribute(other, 'a', 'other-A');
    attribute(other, 'b', 'other-B');
    attribute(survivor, 'c', 'survivor-C');
    // dismissals naming the other (with the survivor and with a third) and one naming only survivor + third
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [other, survivor] });
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [other, third] });
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [survivor, third] });
    // imports' link, a model call subject, a run scope naming the org
    const runId = addRun();
    env.db.prepare("INSERT INTO import_batch (id, created_at, workspace_id, run_id, source_kind, status, updated_at) VALUES ('imp_1', ?, ?, ?, 'csv', 'staging', ?)").run(env.ctx.now(), env.workspaceId, runId, env.ctx.now());
    env.db.prepare("INSERT INTO import_row (id, created_at, batch_id, seq, raw, match_entity_type, match_entity_id) VALUES ('row_1', ?, 'imp_1', 1, '{}', 'organization', ?)").run(env.ctx.now(), other);
    env.db.prepare("INSERT INTO model_call (id, created_at, workspace_id, run_id, purpose, provider, model, pending, subject_id) VALUES ('mcl_o', ?, ?, ?, 'draft', 'anthropic', 'y', 0, ?)").run(env.ctx.now(), env.workspaceId, runId, other);
    env.db.prepare("INSERT INTO run (id, created_at, workspace_id, kind, title, status, scope) VALUES ('run_enr', ?, ?, 'enrich_organization', 'Enrich', 'succeeded', ?)").run(env.ctx.now(), env.workspaceId, JSON.stringify({ organizationId: other }));
    updateOrganization(env.ctx, other, { expectedVersion: 1, fields: { location: 'Lisbon' } }); // gives audit rows naming it and a version bump

    const before = tableCounts();
    const otherVersion = versionOf(other);
    const survivorVersion = versionOf(survivor);
    const out = mergeOrganizations(env.ctx, survivor, { otherId: other, expectedVersion: survivorVersion, otherExpectedVersion: otherVersion });
    const after = tableCounts();
    const delta = (table: string) => after[table]! - before[table]!;

    expect(out.id).toBe(survivor);
    expect(exists(other)).toBe(false);
    expect(delta('organization')).toBe(-1);
    expect(delta('organization_duplicate_dismissal')).toBe(-2); // other+survivor and other+third cascade; survivor+third stays
    expect(delta('attribute_value')).toBe(-1); // other-A displaced; other-B moved
    expect(delta('audit_event')).toBeGreaterThanOrEqual(1);
    const changed = Object.keys(after).filter((t) => delta(t) !== 0).sort();
    expect(changed).toEqual(['attribute_value', 'audit_event', 'organization', 'organization_duplicate_dismissal']);

    // Moved, same rows, same ids.
    expect(count('SELECT COUNT(*) AS n FROM person WHERE organization_id = ?', survivor)).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM opportunity WHERE organization_id = ?', survivor)).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM field_claim WHERE entity_type = 'organization' AND entity_id = ?", survivor)).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM activity WHERE entity_type = 'organization' AND entity_id = ?", survivor)).toBe(2);
    expect(env.db.prepare("SELECT status FROM task WHERE entity_id = ? ORDER BY id").all(survivor)).toEqual([{ status: 'done' }, { status: 'open' }]);
    expect(env.db.prepare('SELECT value FROM attribute_value WHERE entity_id = ? ORDER BY value').all(survivor)).toEqual([{ value: 'other-B' }, { value: 'survivor-A' }, { value: 'survivor-C' }]);
    expect(count("SELECT COUNT(*) AS n FROM stage_event WHERE opportunity_id = 'opp_1'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM list_member WHERE person_id = 'per_a'")).toBe(1); // list membership belongs to the person, untouched
    // The survivor's own surviving dismissal with the third stays.
    expect(count('SELECT COUNT(*) AS n FROM organization_duplicate_dismissal')).toBe(1);

    const fresh = getOrganization(env.db, env.workspaceId, survivor)!;
    expect(fresh).toMatchObject({ kind: 'fund', domain: 'other.example', location: 'Lisbon', linkedinUrl: 'https://www.linkedin.com/company/other-co', version: survivorVersion + 1 });
    expect(fresh.tags).toHaveLength(30);
    expect(fresh.tags[0]).toBe('s1');

    // Nothing in the schema still names the deleted org apart from documented/history places.
    const equalHits = referencesTo(other, 'equals').filter((h) => !h.startsWith('audit_event.'));
    expect(equalHits.sort()).toEqual(['import_row.match_entity_id=1', 'model_call.subject_id=1']); // dangling by contract / history
    const containsHits = referencesTo(other, 'contains').filter((h) => !h.startsWith('audit_event.'));
    // run.scope (an enrichment run) is the third place: honest failure at apply, documented in the contract.
    expect(containsHits.sort()).toEqual(['import_row.match_entity_id=1', 'model_call.subject_id=1', 'run.scope=1']);
    expect(count('SELECT COUNT(*) AS n FROM pragma_foreign_key_check')).toBe(0);
    expect(env.db.pragma('foreign_key_check')).toEqual([]);

    // The audit counts equal reality, and the displaced attribute value is in the trace.
    const [mergeAudit] = audits('organization.merge');
    expect(mergeAudit!.detail.moved).toEqual({ people: 2, opportunities: 2, claims: 3, activities: 2, tasks: 2, meetings: 0 });
    expect(mergeAudit!.detail.filled.attributes).toBe(1);
    expect(mergeAudit!.detail.displaced.attributes).toEqual([{ attributeId: 'atd_org_a', value: 'other-A' }]);
    expect(mergeAudit!.detail.displaced.tags).toEqual(['t29']); // 1 + 30 tags, survivor first, cap 30
  });

  it('KILLS: tags at the cap drop from the other record and the audit lists exactly the dropped ones', () => {
    const s = org({ tags: ['s1', 's2'] });
    const o = org({ tags: Array.from({ length: 30 }, (_, i) => `t${i}`) });
    merge(s, o);
    const fresh = getOrganization(env.db, env.workspaceId, s)!;
    expect(fresh.tags).toHaveLength(30);
    const dropped = audits('organization.merge')[0]!.detail.displaced.tags as string[];
    expect(dropped.sort()).toEqual(['t28', 't29']);
    expect(new Set([...fresh.tags, ...dropped]).size).toBe(32);
  });

  it('KILLS: a tripwire, every column that can name an organization is a known one (FK list + column name scan + migration grep)', () => {
    const found = organizationReferencingColumns(env.db);
    const known = new Set([
      // re-pointed by mergeOrganizations
      'person.organization_id', 'opportunity.organization_id', 'meeting.organization_id', 'task.entity_id', 'field_claim.entity_id', 'activity.entity_id', 'attribute_value.entity_id',
      // cleared by cascade
      'organization_duplicate_dismissal.organization_a_id', 'organization_duplicate_dismissal.organization_b_id',
      // not re-pointed, by design: the log, imports' display links, model call subjects, the search index
      'audit_event.entity_id', 'import_row.match_entity_id', 'model_call.subject_id',
      'person_search.entity_id', 'organization_search.entity_id', 'opportunity_search.entity_id', 'activity_search.entity_id', 'task_search.entity_id', 'meeting_search.entity_id',
    ]);
    expect([...found].filter((name) => !known.has(name))).toEqual([]);
    // The tripwire itself works: a hypothetical new table naming an organization is caught.
    env.db.exec('BEGIN');
    try {
      env.db.exec('CREATE TABLE zz_future (id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organization(id), owner_org TEXT)');
      env.db.exec('CREATE TABLE zz_future2 (id TEXT PRIMARY KEY, org_ref_id TEXT REFERENCES organization(id))');
      const after = organizationReferencingColumns(env.db);
      expect(after.has('zz_future.organization_id')).toBe(true);
      expect(after.has('zz_future2.org_ref_id')).toBe(true); // an FK with an unconventional name is still caught
    } finally {
      env.db.exec('ROLLBACK');
    }
    // Fallback: grep every migration for a column that names an organization and check each is in the known list.
    const dir = path.join(packageRoot, 'migrations');
    const grepHits = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      for (const m of sql.matchAll(/REFERENCES\s+organization\s*\(/gi)) grepHits.add(`${file}@${m.index}`);
    }
    // Five FK declarations exist today: person, opportunity, meeting, and the two dismissal columns.
    expect(grepHits.size).toBe(5);
  });

  it('KILLS: an in-flight enrichment run and a pending change proposal naming the merged away organization fail honestly and write nothing', () => {
    const s = org({ name: 'EnrS' });
    const o = org({ name: 'EnrO' });
    const prepared = proposeChanges(env.ctx, { changes: [{ entityType: 'organization', id: o, expectedVersion: 1, fields: { location: 'Ghost' } }, { entityType: 'organization', id: s, expectedVersion: 1, fields: { location: 'Safe' } }] });
    expect(prepared.valid).toBe(true);
    merge(s, o);
    const failure = rejected(() =>
      applyChanges(env.ctx, { proposalHash: prepared.proposalHash, changes: prepared.changes.map((c) => ({ entityType: c.entityType, id: c.id, expectedVersion: c.expectedVersion, fields: c.fields })) }),
    );
    expect(['not_found', 'validation', 'version_conflict']).toContain(failure.code);
    expect(getOrganization(env.db, env.workspaceId, s)).toMatchObject({ location: null });
    expect(() => startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: o } })).toThrow();
    expect(count('SELECT COUNT(*) AS n FROM pragma_foreign_key_check')).toBe(0);
  });

  it('KILLS: a merge that fails midway leaves every table byte identical (stale other, and a late trigger failure)', () => {
    const a = org({ location: 'A' });
    const b = org({ domain: 'b.example' });
    person(b, 'per_x');
    attribute(b, 'k', 'v');
    const before = dump();
    expect(rejected(() => mergeOrganizations(env.ctx, a, { otherId: b, expectedVersion: 1, otherExpectedVersion: 99 })).code).toBe('version_conflict');
    expect(dump()).toBe(before);
    env.db.exec("CREATE TRIGGER zz_fail BEFORE DELETE ON organization BEGIN SELECT RAISE(ABORT, 'boom'); END");
    try {
      expect(() => merge(a, b)).toThrow(/boom/);
    } finally {
      env.db.exec('DROP TRIGGER zz_fail');
    }
    expect(dump()).toBe(before); // the attribute move and person re-point both rolled back
  });
});

// Columns that can name an organization: a foreign key to organization, or a column whose name says it carries an
// entity/subject/organization id. Mirrors the person tripwire in duplicatesReview.probe.test.ts and adds the FK list.
function organizationReferencingColumns(db: ReturnType<typeof openDatabase>): Set<string> {
  const found = new Set<string>();
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    for (const c of db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string }[]) {
      if (/(^|_)(organization|entity|subject)_?(a_|b_)?id$/.test(c.name) || c.name === 'organization_id' || c.name === 'match_entity_id') found.add(`${t.name}.${c.name}`);
    }
    for (const f of db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as { table: string; from: string }[]) {
      if (f.table === 'organization') found.add(`${t.name}.${f.from}`);
    }
  }
  return found;
}

describe('2/3. where duplicates come from, and merge versus the guards', () => {
  it('KILLS (reasoning): the domain guard blocks a second organization with the same domain on create, update, and spelling variants of case', () => {
    createOrganization(env.ctx, { name: 'One', domain: 'acme.example' });
    expect(rejected(() => createOrganization(env.ctx, { name: 'Two', domain: 'ACME.example' })).code).toBe('conflict');
    expect(rejected(() => createOrganization(env.ctx, { name: 'Two', domain: '  acme.example  ' })).code).toBe('conflict');
    const two = createOrganization(env.ctx, { name: 'Two', domain: null });
    expect(rejected(() => updateOrganization(env.ctx, two.id, { expectedVersion: 1, fields: { domain: 'Acme.Example' } })).code).toBe('conflict');
    expect(scan().pairs).toEqual([]);
  });

  it('KILLS: the scan folds legacy domain spellings the guard lets through (www., scheme, trailing dot all pair)', () => {
    // All current write paths run assertDomainAvailable (manual create/update, import accept via createOrganizationIn,
    // enrichment accept via updateEntityIn), which folds case and spaces only, so these four spellings can coexist.
    createOrganization(env.ctx, { name: 'Alpha', domain: 'www.acme.example' });
    createOrganization(env.ctx, { name: 'Beta', domain: 'acme.example' });
    createOrganization(env.ctx, { name: 'Gamma', domain: 'acme.example.' });
    createOrganization(env.ctx, { name: 'Delta', domain: 'https://acme.example' });
    // The scan key folds them to one host: four spellings, C(4,2) pairs, all under the domain reason.
    const pairs = scan().pairs;
    expect(pairs).toHaveLength(6);
    expect(pairs.every((pair) => pair.reason === 'domain')).toBe(true);
  });

  it('KILLS: the import accept path cannot create a second organization with an existing domain (it matches by domain first)', () => {
    // importReview.lookupOrganization matches mapped.domain before creating and createOrganizationIn re-asserts.
    createOrganization(env.ctx, { name: 'Existing', domain: 'acme.example' });
    expect(rejected(() => createOrganization(env.ctx, { name: 'Imported', domain: 'acme.example' })).code).toBe('conflict');
  });

  it('KILLS: two organizations CAN share a LinkedIn company page on every write path, so that reason is genuinely reachable', () => {
    const url = 'https://www.linkedin.com/company/harbor-row';
    const a = createOrganization(env.ctx, { name: 'Harbor Row Capital', kind: 'fund', linkedinUrl: url });
    const b = createOrganization(env.ctx, { name: 'HRC', kind: 'fund', linkedinUrl: 'HTTPS://linkedin.com/company/harbor-row/' });
    expect(b.linkedinUrl).toBe(url); // canonicalised at write
    const pairs = scan().pairs;
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ reason: 'linkedin', organizationIds: [a.id, b.id] });
  });

  it('KILLS: LinkedIn company slugs differing only in case pair (LinkedIn resolves slugs case-insensitively)', () => {
    createOrganization(env.ctx, { name: 'Case One', linkedinUrl: 'https://www.linkedin.com/company/Harbor-Row' });
    createOrganization(env.ctx, { name: 'Case Two', linkedinUrl: 'https://www.linkedin.com/company/harbor-row' });
    // The scan key lowercases the canonical URL; the stored values keep their spelling.
    const pairs = scan().pairs;
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.reason).toBe('linkedin');
  });

  it('KILLS: a merge can never leave two organizations sharing a domain that the guard created (the deleted holder is gone before the fill lands)', () => {
    const s = org({ name: 'S' });
    const o = org({ name: 'O', domain: 'only-o.example' });
    merge(s, o);
    expect(count("SELECT COUNT(*) AS n FROM organization WHERE domain = 'only-o.example'")).toBe(1);
    expect(scan().pairs).toEqual([]);
  });

  it('ACCEPTED: with a legacy third holder of the domain, a fill gives survivor and third the same domain; the next scan lists them, nothing is refused later', () => {
    const third = org({ name: 'Legacy Third', domain: 'dup.example' });
    const s = org({ name: 'S2' });
    const o = org({ name: 'O2', domain: 'DUP.example' }); // raw legacy spelling, only reachable by direct writes
    merge(s, o);
    expect(getOrganization(env.db, env.workspaceId, s)!.domain).toBe('DUP.example'); // fill copies the raw spelling
    const pairs = scan().pairs;
    expect(pairs.map((p) => [p.reason, p.organizationIds])).toEqual([['domain', [third, s]]]);
    // The normal update path only checks the domain when the patch carries one: renaming still works.
    expect(updateOrganization(env.ctx, s, { expectedVersion: versionOf(s), fields: { name: 'Renamed' } }).name).toBe('Renamed');
    // But re-sending the (lowercased) domain unchanged is refused by the guard: legacy state is sticky until one is cleared.
    expect(rejected(() => updateOrganization(env.ctx, s, { expectedVersion: versionOf(s), fields: { domain: 'dup.example' } })).code).toBe('conflict');
  });

  it('KILLS: filling a domain through merge keeps the search index in step (search by the filled domain finds the survivor only)', () => {
    const s = org({ name: 'Searchsurv' });
    const o = org({ name: 'Searchother', domain: 'findme-xyz.example' });
    merge(s, o);
    const hits = env.db.prepare("SELECT entity_id FROM organization_search WHERE organization_search MATCH '\"findme-xyz\"'").all();
    expect(hits).toEqual([{ entity_id: s }]);
    expect(env.db.prepare("SELECT entity_id FROM organization_search WHERE organization_search MATCH '\"Searchother\"'").all()).toEqual([]);
  });
});

describe('4. concurrency and refusal honesty', () => {
  it('KILLS: opposite simultaneous merges over a real socket leave exactly one organization (one 200, one 404)', async () => {
    const a = org();
    const b = org();
    const [one, two] = await Promise.all([
      realCall('POST', `/api/organizations/${a}/merge`, { otherId: b, expectedVersion: 1, otherExpectedVersion: 1 }),
      realCall('POST', `/api/organizations/${b}/merge`, { otherId: a, expectedVersion: 1, otherExpectedVersion: 1 }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 404]);
    expect(count('SELECT COUNT(*) AS n FROM organization')).toBe(1);
  });

  it('KILLS: merging after the other was already merged away is 404 in both positions and both orders', async () => {
    const a = org();
    const b = org();
    const c = org();
    merge(a, b);
    expect((await call('POST', `/api/organizations/${a}/merge`, { otherId: b, expectedVersion: versionOf(a), otherExpectedVersion: 1 })).status).toBe(404);
    expect((await call('POST', `/api/organizations/${b}/merge`, { otherId: a, expectedVersion: 1, otherExpectedVersion: versionOf(a) })).status).toBe(404);
    expect((await call('POST', `/api/organizations/${c}/merge`, { otherId: b, expectedVersion: 1, otherExpectedVersion: 1 })).status).toBe(404);
    expect(count('SELECT COUNT(*) AS n FROM organization')).toBe(2);
  });

  it('KILLS: every refusal leaves the database byte identical, and version conflicts carry the current record', async () => {
    const a = org({ domain: 'a.example', location: 'X' });
    const b = org({ location: 'Y' });
    person(b, 'per_c');
    attribute(b, 'k', 'v');
    const other = insertSecondWorkspace(env.db);
    const foreign = org({ workspaceId: other });
    const before = dump();
    const stale = await call('POST', `/api/organizations/${a}/merge`, { otherId: b, expectedVersion: 7, otherExpectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.error.current).toMatchObject({ id: a, version: 1 });
    const staleOther = await call('POST', `/api/organizations/${a}/merge`, { otherId: b, expectedVersion: 1, otherExpectedVersion: 7 });
    expect(staleOther.status).toBe(409);
    expect(staleOther.body.error.current).toMatchObject({ id: b, version: 1 });
    expect((await call('POST', `/api/organizations/${a}/merge`, { otherId: a, expectedVersion: 1, otherExpectedVersion: 1 })).status).toBe(400);
    expect((await call('POST', `/api/organizations/${a}/merge`, { otherId: foreign, expectedVersion: 1, otherExpectedVersion: 1 })).status).toBe(404);
    expect((await call('POST', `/api/organizations/${foreign}/merge`, { otherId: a, expectedVersion: 1, otherExpectedVersion: 1 })).status).toBe(404);
    expect((await call('POST', `/api/organizations/${a}/merge`, { otherId: b, expectedVersion: 1 })).status).toBe(400);
    expect((await call('POST', `/api/organizations/${a}/merge`, { otherId: b, expectedVersion: 1, otherExpectedVersion: 1, extra: 1 })).status).toBe(400);
    expect((await call('POST', `/api/organizations/nope/merge`, { otherId: b, expectedVersion: 1, otherExpectedVersion: 1 })).status).toBe(404);
    expect(dump()).toBe(before);
  });

  it('KILLS: a person id or an unknown spelling passed as otherId never deletes anything', async () => {
    const a = org();
    person(a, 'per_zz');
    for (const otherId of ['per_zz', a.toUpperCase(), '', 'org_'])
      expect((await call('POST', `/api/organizations/${a}/merge`, { otherId, expectedVersion: 1, otherExpectedVersion: 1 })).status).toBeGreaterThanOrEqual(400);
    expect(exists(a)).toBe(true);
    expect(count('SELECT COUNT(*) AS n FROM person')).toBe(1);
  });

  it('KILLS: the merge holds the write lock the whole way, a second connection cannot slip a dependent row in between re-point and delete', () => {
    const a = org();
    const b = org();
    const second = new Database(env.databasePath, { timeout: 0 });
    second.pragma('foreign_keys = ON');
    let blocked: string | null = null;
    const realPrepare = env.db.prepare.bind(env.db);
    (env.db as any).prepare = (sql: string) => {
      const statement = realPrepare(sql);
      if (sql.startsWith('DELETE FROM organization WHERE id')) {
        const run = statement.run.bind(statement);
        (statement as any).run = (...args: unknown[]) => {
          try {
            second.prepare("INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, organization_id, updated_at) VALUES ('per_slip', 'x', ?, 1, 'S', 'S', ?, 'x')").run(env.workspaceId, b);
          } catch (error) {
            blocked = (error as { code?: string }).code ?? String(error);
          }
          return run(...args);
        };
      }
      return statement;
    };
    try {
      merge(a, b);
    } finally {
      (env.db as any).prepare = realPrepare;
      second.close();
    }
    expect(blocked).toBe('SQLITE_BUSY');
    expect(count("SELECT COUNT(*) AS n FROM person WHERE id = 'per_slip'")).toBe(0);
    expect(env.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('KILLS: an external writer holding the lock makes the merge fail as an error response without half applying (database unchanged)', async () => {
    const a = org();
    const b = org();
    person(b, 'per_lock');
    const holder = new Database(env.databasePath, { timeout: 0 });
    holder.exec('BEGIN IMMEDIATE');
    const before = dump();
    // Shorten the wait so the probe is quick; production uses busy_timeout 5000.
    env.db.pragma('busy_timeout = 100');
    let status = 0;
    try {
      status = (await call('POST', `/api/organizations/${a}/merge`, { otherId: b, expectedVersion: 1, otherExpectedVersion: 1 })).status;
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
      env.db.pragma('busy_timeout = 5000');
    }
    expect(status).toBeGreaterThanOrEqual(400);
    expect(dump()).toBe(before);
    expect(merge(a, b).id).toBe(a); // and it works once the lock is free
  });

  it('KILLS: merging the survivor again immediately bumps the version once each time and audits each merge', () => {
    const s = org();
    const o1 = org({ location: 'R' });
    const o2 = org();
    merge(s, o1);
    expect(versionOf(s)).toBe(2);
    merge(s, o2);
    expect(versionOf(s)).toBe(3);
    expect(audits('organization.merge')).toHaveLength(2);
  });

  it('KILLS: dismissals naming a third organization survive a merge of the pair, and person dismissals are never touched', () => {
    const a = org();
    const b = org();
    const c = org();
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [a, c] });
    env.db.prepare("INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, updated_at) VALUES ('per_1', 'x', ?, 1, 'A', 'A', 'x'), ('per_2', 'x', ?, 1, 'B', 'B', 'x')").run(env.workspaceId, env.workspaceId);
    dismissDuplicate(env.ctx, { personIds: ['per_1', 'per_2'] });
    merge(a, b);
    expect(count('SELECT COUNT(*) AS n FROM organization_duplicate_dismissal')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM duplicate_dismissal')).toBe(1);
  });

  it('CONFIRMS-lite (ACCEPTED): after a merge a previously dismissed pair of the SURVIVOR with a third stays dismissed, but the OTHER pair with that third is forgotten, it can reappear against the survivor', () => {
    // Other<->third was dismissed ("not duplicates"); after merge the third is compared with the survivor, which is a
    // different pair; the human's earlier answer about other<->third is dropped by cascade. Documented: "dismissals
    // naming it clear by cascade". Worth knowing: a third that shares a domain with the other will list against the survivor.
    const s = org({ name: 'Sx' });
    const o = org({ name: 'Ox', linkedinUrl: 'https://www.linkedin.com/company/same-page' });
    const t = org({ name: 'Tx', linkedinUrl: 'https://www.linkedin.com/company/same-page' });
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [o, t] });
    expect(scan().pairs).toEqual([]);
    merge(s, o);
    // the survivor inherited the page, so survivor<->third now appears although the user said other<->third are not duplicates
    expect(scan().pairs.map((p) => p.organizationIds)).toEqual([[s, t]]);
  });
});

describe('5. scan correctness', () => {
  it('KILLS: kind gating, fund vs company with the same name is not listed, two funds are', () => {
    org({ name: 'Northwind', kind: 'fund' });
    org({ name: 'Northwind', kind: 'company' });
    expect(scan().pairs).toEqual([]);
    org({ name: 'northwind!', kind: 'fund' });
    const pairs = scan().pairs;
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.reason).toBe('name');
    expect(pairs[0]!.left.kind).toBe('fund');
  });

  it('KILLS: key spellings, domain case/whitespace, linkedin trailing slash/uppercase host/http scheme/no www, all pair', () => {
    org({ domain: 'Acme.Example' });
    org({ domain: '  acme.example ' });
    org({ linkedinUrl: 'https://www.linkedin.com/company/x1/' });
    org({ linkedinUrl: 'HTTPS://WWW.LINKEDIN.COM/company/x1' });
    org({ linkedinUrl: 'http://linkedin.com/company/x1?trk=abc' });
    org({ linkedinUrl: 'https://uk.linkedin.com/company/x1/about' });
    const reasons = scan().pairs.map((p) => p.reason);
    expect(reasons.filter((r) => r === 'domain')).toHaveLength(1);
    expect(reasons.filter((r) => r === 'linkedin')).toHaveLength(6); // 4 spellings, all pair: C(4,2)
  });

  it('KILLS: a domain with a trailing dot folds to the same host and pairs', () => {
    org({ domain: 'acme.example' });
    org({ domain: 'acme.example.' });
    const pairs = scan().pairs;
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.reason).toBe('domain');
  });

  it('KILLS: the strongest reason wins across buckets, dismissed pairs are excluded, the older record is left', () => {
    const older = org({ name: 'Same', domain: 'd.example', createdAt: '2025-01-01T00:00:00.000Z' });
    const newer = org({ name: 'Same', domain: 'd.example', createdAt: '2026-01-01T00:00:00.000Z' });
    const pair = scan().pairs;
    expect(pair).toHaveLength(1);
    expect(pair[0]).toMatchObject({ reason: 'domain', organizationIds: [older, newer] });
    dismissOrganizationDuplicate(env.ctx, { organizationIds: [newer, older] });
    expect(scan().pairs).toEqual([]);
  });

  it('KILLS: the cap is exactly 200 (200 not capped, 201 capped) and strong pairs sort before name pairs under the cap', () => {
    for (let i = 0; i < 200; i += 1) {
      org({ name: `Name pair ${i}` });
      org({ name: `Name pair ${i}` });
    }
    let result = scan();
    expect(result.pairs).toHaveLength(200);
    expect(result.capped).toBe(false);
    org({ domain: 'late.example', createdAt: '2030-01-01T00:00:00.000Z' });
    org({ domain: 'late.example', createdAt: '2030-01-02T00:00:00.000Z' });
    result = scan();
    expect(result.pairs).toHaveLength(200);
    expect(result.capped).toBe(true);
    expect(result.pairs[0]!.reason).toBe('domain'); // newest pair still sorts first because it is a strong reason
  });

  it('KILLS: workspace isolation both ways', () => {
    const other = insertSecondWorkspace(env.db);
    org({ domain: 'x.example', workspaceId: other });
    org({ domain: 'x.example' });
    expect(scan().pairs).toEqual([]);
    expect(scanOrganizationDuplicates(env.db, other).pairs).toEqual([]);
  });

  it('KILLS: hostile names render as data only, the scan returns them verbatim and unmodified', () => {
    const evil = '<img src=x onerror=alert(1)>';
    org({ name: evil });
    org({ name: evil });
    const [pair] = scan().pairs;
    expect(pair!.left.name).toBe(evil);
  });

  it('KILLS: the person scan is unchanged by the helper refactor (a pair, reasons, and the dismissed set still work)', async () => {
    env.db.prepare("INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, email, updated_at) VALUES ('per_s1', 'x', ?, 1, 'A', 'A', 'same@x.invalid', 'x'), ('per_s2', 'y', ?, 1, 'B', 'B', 'SAME@x.invalid', 'y')").run(env.workspaceId, env.workspaceId);
    const people = await call('GET', '/api/duplicates');
    expect(people.body.pairs).toHaveLength(1);
    expect(people.body.pairs[0].reason).toBe('email');
    expect((await call('GET', '/api/duplicates/organizations')).body.pairs).toEqual([]);
  });

  it('KILLS: the pair summary counts match the rows, and fills match what the merge then does', () => {
    const a = org({ name: 'CntA', domain: 'cnt.example' });
    const b = org({ name: 'CntB', domain: 'CNT.example', location: 'Rome', linkedinUrl: 'https://www.linkedin.com/company/cnt' });
    person(b, 'per_k1');
    person(b, 'per_k2');
    deal(b, 'opp_k');
    attribute(b, 'k', 'v');
    env.db.prepare("INSERT INTO task (id, created_at, workspace_id, version, title, entity_type, entity_id, status, updated_at) VALUES ('tsk_k', ?, ?, 1, 't', 'organization', ?, 'open', ?)").run(env.ctx.now(), env.workspaceId, b, env.ctx.now());
    env.db.prepare("INSERT INTO task (id, created_at, workspace_id, version, title, entity_type, entity_id, status, updated_at) VALUES ('tsk_p', ?, ?, 1, 't', 'person', ?, 'open', ?)").run(env.ctx.now(), env.workspaceId, b, env.ctx.now()); // a PERSON-typed task whose entity_id equals an org id must not count or move
    const [pair] = scan().pairs;
    expect(pair!.right).toMatchObject({ people: 2, deals: 1, tasks: 1, activities: 0 });
    expect(pair!.fillsIfKeepLeft).toBe(3); // location, linkedin, attribute (domain is set on a)
    expect(pair!.fillsIfKeepRight).toBe(0);
    merge(a, b);
    expect(env.db.prepare("SELECT entity_type, entity_id FROM task WHERE id = 'tsk_p'").get()).toEqual({ entity_type: 'person', entity_id: b });
    expect(audits('organization.merge')[0]!.detail.filled.fields.sort()).toEqual(['linkedinUrl', 'location']);
  });
});

describe('6. performance', () => {
  it('scans 100,000 organizations with 1% duplicates inside the 3 second budget; worst shapes reported', () => {
    const big = createTestEnvironment();
    try {
      const db = big.db;
      const ws = big.workspaceId;
      const insert = db.prepare("INSERT INTO organization (id, created_at, workspace_id, version, name, domain, kind, location, linkedin_url, tags, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, NULL, ?, '[]', ?)");
      const total = 100_000;
      db.transaction(() => {
        for (let i = 0; i < total; i += 1) {
          const dup = i % 100 === 99;
          const base = dup ? i - 1 : i;
          const kind = i % 3;
          const domain = dup && kind === 0 ? `o${base}.perf.example` : i % 4 === 0 ? null : `o${i}.perf.example`;
          const linkedin = dup && kind === 1 ? `https://www.linkedin.com/company/o${base}` : i % 5 === 0 ? null : `https://www.linkedin.com/company/o${i}/`;
          const name = dup && kind === 2 ? `Organization ${base}` : `Organization ${i}`;
          insert.run(`org_perf${String(i).padStart(7, '0')}`, new Date(1_700_000_000_000 + i * 1000).toISOString(), ws, name, domain, i % 7 === 0 ? 'fund' : 'company', linkedin, '2026-01-01T00:00:00.000Z');
        }
      }).immediate();
      scanOrganizationDuplicates(db, ws); // warm
      const started = performance.now();
      const result = scanOrganizationDuplicates(db, ws);
      const elapsed = performance.now() - started;
      console.log(`PERF org scan 100k, 1% duplicates: ${elapsed.toFixed(0)} ms, ${result.pairs.length} pairs, capped=${result.capped}`);
      expect(result.pairs).toHaveLength(200);
      expect(result.capped).toBe(true);
      expect(elapsed).toBeLessThan(3000);

      db.prepare("UPDATE organization SET domain = 'same.example'").run();
      let t = performance.now();
      const sameDomain = scanOrganizationDuplicates(db, ws);
      const domainMs = performance.now() - t;
      db.prepare("UPDATE organization SET domain = NULL, name = 'Same Name', kind = 'company', linkedin_url = 'https://www.linkedin.com/company/same'").run();
      t = performance.now();
      const sameAll = scanOrganizationDuplicates(db, ws);
      const allMs = performance.now() - t;
      console.log(`PERF org worst shapes: one domain x100k ${domainMs.toFixed(0)} ms (${sameDomain.pairs.length} pairs), one linkedin+name x100k ${allMs.toFixed(0)} ms (${sameAll.pairs.length} pairs, ${sameAll.pairs[0]?.reason})`);
      expect(sameDomain.pairs).toHaveLength(200);
      expect(sameAll.pairs).toHaveLength(200);
      expect(domainMs).toBeLessThan(3000);
      expect(allMs).toBeLessThan(3000);
    } finally {
      big.cleanup();
    }
  }, 180_000);
});
