// Adversarial review probes for the person lifecycle (migrations 019 and 020). Names start with KILLS (a safety
// property holds, including every finding that was fixed) or ACCEPTED (a behavior that stays, documented in
// docs/architecture.md, "Lifecycle (migration 019)"). Nothing here changes application code.
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applyChanges,
  createContext,
  createOpportunity,
  createOrganization,
  createPerson,
  moveOpportunityStage,
  mutate,
  proposeChanges,
  setImportSettings,
  switchTemplate,
  syncMail,
  updateOpportunity,
  updatePerson,
} from '../src/actions/index.js';
import { promotePersonIn } from '../src/actions/lifecycle.js';
import { applyMigrations, listMigrationFiles } from '../src/db.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { migrationsDirectory } from '../src/paths.js';
import { listOrganizations } from '../src/queries/organizations.js';
import { listPeople } from '../src/queries/people.js';
import { listPipelines } from '../src/queries/pipelines.js';
import { searchAll } from '../src/queries/search.js';
import { type AgentmailStub, startAgentmailStub, stubInboxId, useAgentmailStub } from './agentmailStub.js';
import { createTestEnvironment, driveRun, insertSecondWorkspace, type TestEnvironment } from './helpers.js';
import { addDraft, addPerson, approve, connectMail, drain, intentOf, queueOne, stage } from './mailHelpers.js';

const env = createTestEnvironment();
const mailEnvironments: TestEnvironment[] = [];
let app: FastifyInstance;
let stub: AgentmailStub;
let restoreStub: () => void;
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
  stub = await startAgentmailStub();
  restoreStub = useAgentmailStub(stub);
});

afterEach(() => {
  stub.reset();
});

afterAll(async () => {
  await app.close();
  await stub.close();
  restoreStub();
  for (const mailEnvironment of mailEnvironments) mailEnvironment.cleanup();
  env.cleanup();
});

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, headers: host, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

function failure(work: () => unknown): AppError {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Expected the call to fail.');
}

function lifecycleOf(target: TestEnvironment, personId: string): string {
  return (target.db.prepare('SELECT lifecycle FROM person WHERE id = ?').get(personId) as { lifecycle: string }).lifecycle;
}

function versionOf(target: TestEnvironment, personId: string): number {
  return (target.db.prepare('SELECT version FROM person WHERE id = ?').get(personId) as { version: number }).version;
}

function promotions(target: TestEnvironment, personId: string): { reason: string }[] {
  return (
    target.db.prepare("SELECT detail FROM audit_event WHERE action = 'person.promote' AND entity_id = ? ORDER BY created_at, id").all(personId) as { detail: string }[]
  ).map((row) => JSON.parse(row.detail) as { reason: string });
}

async function freshMailEnv(): Promise<TestEnvironment> {
  const target = createTestEnvironment();
  mailEnvironments.push(target);
  await connectMail(target);
  return target;
}

const at = (target: TestEnvironment, seconds: number) => new Date(Date.parse(target.ctx.now()) + seconds * 1000).toISOString();

// A database that ran 001 to 018, so 019 can be applied against existing data.
function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const file of listMigrationFiles().filter((name) => name < '019')) {
    db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
    db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
  }
  for (const id of ['wsp_1', 'wsp_2']) db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run(id, '2026-01-01', id, 't');
  const pipeline = (id: string, workspace: string) => db.prepare('INSERT INTO pipeline (id, created_at, workspace_id, name) VALUES (?, ?, ?, ?)').run(id, '2026-01-01', workspace, id);
  const stageRow = (id: string, pipelineId: string, seq: number) =>
    db.prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, ?)').run(id, '2026-01-01', pipelineId, id, seq);
  pipeline('pip_1', 'wsp_1');
  pipeline('pip_1b', 'wsp_1');
  pipeline('pip_2', 'wsp_2');
  stageRow('stg_1a', 'pip_1', 1);
  stageRow('stg_1b', 'pip_1', 2);
  stageRow('stg_1b_first', 'pip_1b', 1);
  stageRow('stg_2a', 'pip_2', 1);
  stageRow('stg_2b', 'pip_2', 2);
  return db;
}

function insertPerson(db: Database.Database, id: string, workspace: string, email: string | null = null) {
  db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, email, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, '2026-01-01', workspace, id, email, '2026-01-01');
}

function insertMessage(db: Database.Database, id: string, workspace: string, direction: string, personId: string | null, from = 'x@example.com') {
  db.prepare(
    "INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, direction, person_id, from_email, provider_timestamp) VALUES (?, '2026-01-02', ?, ?, ?, ?, ?, '2026-01-02T00:00:00.000Z')",
  ).run(id, workspace, `pm_${id}`, direction, personId, from);
}

function insertOpportunity(db: Database.Database, id: string, workspace: string, pipelineId: string, stageId: string, personId: string | null) {
  db.prepare(
    "INSERT INTO opportunity (id, created_at, workspace_id, name, pipeline_id, stage_id, person_id, stage_changed_at, updated_at) VALUES (?, '2026-01-02', ?, ?, ?, ?, ?, '2026-01-02', '2026-01-02')",
  ).run(id, workspace, id, pipelineId, stageId, personId);
}

describe('backfill and migration safety', () => {
  it('KILLS: the backfill cannot promote across workspaces, from unlinked mail, from outbound mail, or from a first-stage deal in another pipeline', () => {
    const db = legacyDatabase();
    try {
      for (const id of ['per_msg_other_ws', 'per_opp_other_ws', 'per_null_msg', 'per_out_only', 'per_other_pipeline_first']) insertPerson(db, id, 'wsp_1', `${id}@example.com`);
      insertPerson(db, 'per_ws2_real', 'wsp_2');
      // A message row in workspace 2 that points at a workspace 1 person.
      insertMessage(db, 'msg_cross', 'wsp_2', 'in', 'per_msg_other_ws');
      // An opportunity in workspace 2 past its first stage that names a workspace 1 person.
      insertOpportunity(db, 'opp_cross', 'wsp_2', 'pip_2', 'stg_2b', 'per_opp_other_ws');
      // An inbound message whose sender address equals a person's email but whose link is null.
      insertMessage(db, 'msg_null', 'wsp_1', 'in', null, 'per_null_msg@example.com');
      insertMessage(db, 'msg_out', 'wsp_1', 'out', 'per_out_only');
      insertOpportunity(db, 'opp_first_b', 'wsp_1', 'pip_1b', 'stg_1b_first', 'per_other_pipeline_first');
      // Sanity: the same signals inside their own workspace do promote.
      insertOpportunity(db, 'opp_real', 'wsp_2', 'pip_2', 'stg_2b', 'per_ws2_real');

      expect(applyMigrations(db)).toEqual(['019_lifecycle.sql', '020_lifecycle_indexes.sql', '021_worker_lease.sql', '022_pipelines.sql', '023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql', '030_transcript.sql', '031_duplicates.sql', '032_organization_duplicates.sql', '033_meetings.sql', '034_search_widening.sql', '035_backblaze.sql', '036_contact_fields.sql', '037_crunchbase.sql']);
      const rows = db.prepare('SELECT id, lifecycle FROM person ORDER BY id').all();
      expect(rows).toEqual([
        { id: 'per_msg_other_ws', lifecycle: 'lead' },
        { id: 'per_null_msg', lifecycle: 'lead' },
        { id: 'per_opp_other_ws', lifecycle: 'lead' },
        { id: 'per_other_pipeline_first', lifecycle: 'lead' },
        { id: 'per_out_only', lifecycle: 'lead' },
        { id: 'per_ws2_real', lifecycle: 'relationship' },
      ]);
    } finally {
      db.close();
    }
  });

  it('ACCEPTED: the 019 backfill UPDATE scanned the opportunities of the workspace once per person because no index narrowed by person, a one time cost at 019; 020 adds the index for every ongoing read (documented in architecture.md)', () => {
    const db = legacyDatabase();
    try {
      const text = readFileSync(path.join(migrationsDirectory, '019_lifecycle.sql'), 'utf8');
      db.exec(text);
      const update = text.slice(text.indexOf('UPDATE person'), text.lastIndexOf(';') + 1);
      const explain = () => (db.prepare(`EXPLAIN QUERY PLAN ${update}`).all() as { detail: string }[]).map((row) => row.detail);
      // At 019 the opportunity probe is keyed by workspace only, an index that does not narrow by person.
      const before = explain();
      expect(before.some((line) => /SEARCH op USING (COVERING )?INDEX \w+ \(workspace_id=\?\)$/.test(line))).toBe(true);
      expect(before.some((line) => /SEARCH op .*person_id/.test(line))).toBe(false);
      // After 020 the same statement, and any person to opportunity lookup, is keyed by person.
      db.exec(readFileSync(path.join(migrationsDirectory, '020_lifecycle_indexes.sql'), 'utf8'));
      expect(explain().some((line) => /SEARCH op USING (COVERING )?INDEX idx_opportunity_person \(workspace_id=\? AND person_id=\?\)/.test(line))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('KILLS: running the migrations again is a no-op, a manual demotion survives it, and the CHECK and the index exist on a live database', () => {
    const person = createPerson(env.ctx, { firstName: 'Rerun', lastName: 'Safe', lifecycle: 'relationship' });
    updatePerson(env.ctx, person.id, { expectedVersion: 1, fields: { lifecycle: 'lead' } });
    expect(applyMigrations(env.db)).toEqual([]);
    expect(lifecycleOf(env, person.id)).toBe('lead');
    expect(() => env.db.prepare("UPDATE person SET lifecycle = 'customer' WHERE id = ?").run(person.id)).toThrow(/CHECK/);
    expect(() => env.db.prepare('UPDATE person SET lifecycle = NULL WHERE id = ?').run(person.id)).toThrow(/NOT NULL/);
    const indexes = (env.db.pragma('index_list(person)') as { name: string }[]).map((row) => row.name);
    expect(indexes).toContain('idx_person_lifecycle');
    expect(indexes).toContain('idx_person_organization_lifecycle');
    expect((env.db.pragma('index_list(opportunity)') as { name: string }[]).map((row) => row.name)).toContain('idx_opportunity_person');
    const column = (env.db.pragma('table_info(person)') as { name: string; notnull: number; dflt_value: string }[]).find((row) => row.name === 'lifecycle');
    expect(column).toMatchObject({ notnull: 1, dflt_value: "'lead'" });
  });
});

describe('derived organization filter', () => {
  it('KILLS: the organization lifecycle filter probes person through the organization index, not once per relationship person per row', () => {
    const target = createTestEnvironment();
    try {
      for (const lifecycle of ['lead', 'relationship'] as const) {
        const captured: string[] = [];
        const spy = { prepare: (sql: string) => (captured.push(sql), target.db.prepare(sql)) } as unknown as typeof target.db;
        listOrganizations(spy, target.workspaceId, { lifecycle, limit: 50 });
        const plan = (target.db.prepare(`EXPLAIN QUERY PLAN ${captured.at(-1)!}`).all(target.workspaceId, 51) as { detail: string }[]).map((row) => row.detail);
        expect(plan.some((line) => /^SEARCH pe USING INDEX idx_person_organization_lifecycle \(organization_id=\? AND lifecycle=\?\)/.test(line))).toBe(true);
        expect(plan.some((line) => line.includes('idx_person_lifecycle'))).toBe(false);
      }
      // Many relationship people elsewhere in the workspace must not slow the filter. The bound is generous; the plan
      // assertion above is the precise check.
      const insertOrganization = target.db.prepare("INSERT INTO organization (id, created_at, workspace_id, name, kind, updated_at) VALUES (?, '2026-01-01', ?, ?, 'company', '2026-01-01')");
      const insertPerson = target.db.prepare("INSERT INTO person (id, created_at, workspace_id, first_name, lifecycle, updated_at) VALUES (?, '2026-01-01', ?, ?, 'relationship', '2026-01-01')");
      target.db.transaction(() => {
        for (let index = 0; index < 1000; index += 1) insertOrganization.run(`org_${String(index).padStart(12, '0')}`, target.workspaceId, `Org ${index}`);
        for (let index = 0; index < 20000; index += 1) insertPerson.run(`per_${String(index).padStart(12, '0')}`, target.workspaceId, `P${index}`);
      })();
      const started = performance.now();
      const page = listOrganizations(target.db, target.workspaceId, { lifecycle: 'lead', limit: 50 });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(page.items).toHaveLength(50);
    } finally {
      target.cleanup();
    }
  });

  it('KILLS: paging lead organizations stays consistent when the cursor organization itself flips to relationship between pages', () => {
    const target = createTestEnvironment();
    try {
      const orgs = ['Aa', 'Bb', 'Cc', 'Dd', 'Ee'].map((name) => createOrganization(target.ctx, { name: `${name} Org`, kind: 'company' }));
      const holder = createPerson(target.ctx, { firstName: 'Holder', organizationId: orgs[1]!.id });
      const first = listOrganizations(target.db, target.workspaceId, { lifecycle: 'lead', limit: 2 });
      expect(first.items.map((item) => item.name)).toEqual(['Aa Org', 'Bb Org']);
      // The cursor row (Bb) leaves the lead list before the next page is read.
      updatePerson(target.ctx, holder.id, { expectedVersion: 1, fields: { lifecycle: 'relationship' } });
      const second = listOrganizations(target.db, target.workspaceId, { lifecycle: 'lead', limit: 2, cursor: first.nextCursor! });
      expect(second.items.map((item) => item.name)).toEqual(['Cc Org', 'Dd Org']);
      const third = listOrganizations(target.db, target.workspaceId, { lifecycle: 'lead', limit: 2, cursor: second.nextCursor! });
      expect(third.items.map((item) => item.name)).toEqual(['Ee Org']);
      expect(third.nextCursor).toBeNull();
      // A cursor from another workspace is still refused.
      const other = insertSecondWorkspace(target.db);
      expect(() => listOrganizations(target.db, other, { lifecycle: 'lead', cursor: first.nextCursor! })).toThrow(/cursor/);
    } finally {
      target.cleanup();
    }
  });

  it('KILLS: a relationship person or an opportunity that belongs to another workspace does not make an organization a relationship, and the fit sort pages under the lifecycle filter', () => {
    const target = createTestEnvironment();
    try {
      const other = insertSecondWorkspace(target.db);
      const lonely = createOrganization(target.ctx, { name: 'Lonely Org', kind: 'company' });
      // Rows the application cannot create (cross workspace references) but a damaged database could hold.
      target.db
        .prepare("INSERT INTO person (id, created_at, workspace_id, first_name, organization_id, lifecycle, updated_at) VALUES ('per_aaaaaaaaaaaa', '2026-01-01', ?, 'Foreign', ?, 'relationship', '2026-01-01')")
        .run(other, lonely.id);
      const stages = listPipelines(target.db, target.workspaceId)[0]!.stages;
      target.db
        .prepare(
          "INSERT INTO opportunity (id, created_at, workspace_id, name, pipeline_id, stage_id, organization_id, stage_changed_at, updated_at) VALUES ('opp_aaaaaaaaaaaa', '2026-01-01', ?, 'Foreign deal', (SELECT pipeline_id FROM stage WHERE id = ?), ?, ?, '2026-01-01', '2026-01-01')",
        )
        .run(other, stages[0]!.id, stages[0]!.id, lonely.id);
      expect(listOrganizations(target.db, target.workspaceId, { lifecycle: 'lead' }).items.map((item) => item.name)).toEqual(['Lonely Org']);
      expect(listOrganizations(target.db, target.workspaceId, { lifecycle: 'relationship' }).items).toEqual([]);

      for (const [index, name] of ['Una', 'Dos', 'Tres', 'Cuatro', 'Cinco'].entries()) {
        createPerson(target.ctx, { firstName: name, lastName: 'Fit', lifecycle: index % 2 === 0 ? 'lead' : 'relationship' });
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = listPeople(target.db, target.workspaceId, { lifecycle: 'lead', sort: 'fit', limit: 1, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((item) => item.firstName));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen.sort()).toEqual(['Cinco', 'Tres', 'Una']);
    } finally {
      target.cleanup();
    }
  });
});

describe('promotion integrity', () => {
  it('KILLS: an agent can set lifecycle through propose and apply, and the audit trail names the agent, the old value, and the new one', () => {
    const agent = createContext(env.db, env.workspaceId, { actor: 'agent:mcp', bus: env.bus, now: env.ctx.now });
    const person = createPerson(env.ctx, { firstName: 'Agent', lastName: 'Target' });
    const proposal = proposeChanges(agent, { changes: [{ entityType: 'person', id: person.id, fields: { lifecycle: 'relationship' } }] });
    expect(proposal.valid).toBe(true);
    const events: DomainEvent[] = [];
    const unsubscribe = env.bus.subscribe((event) => events.push(event));
    applyChanges(agent, {
      proposalHash: proposal.proposalHash,
      changes: proposal.changes.map((change) => ({ entityType: change.entityType, id: change.id, expectedVersion: change.expectedVersion, fields: change.fields })),
    });
    unsubscribe();
    expect(lifecycleOf(env, person.id)).toBe('relationship');
    const audit = env.db.prepare("SELECT actor, detail FROM audit_event WHERE action = 'person.update' AND entity_id = ?").get(person.id) as { actor: string; detail: string };
    expect(audit.actor).toBe('agent:mcp');
    expect(JSON.parse(audit.detail)).toEqual({ changes: { lifecycle: { from: 'lead', to: 'relationship' } } });
    expect(promotions(env, person.id)).toEqual([]);
    expect(events).toContainEqual({ type: 'record_updated', entityType: 'person', entityId: person.id });
    // The preview rejects a value outside the two, and a stale version fails the apply as a whole.
    expect(proposeChanges(agent, { changes: [{ entityType: 'person', id: person.id, fields: { lifecycle: 'Customer' } }] }).valid).toBe(false);
    expect(failure(() => applyChanges(agent, { proposalHash: proposal.proposalHash, changes: [{ entityType: 'person', id: person.id, expectedVersion: 1, fields: { lifecycle: 'relationship' } }] })).code).toBe('version_conflict');
  });

  it('KILLS: a promotion transaction in another workspace cannot touch the person, and a deal there cannot name this workspace person', () => {
    const target = createTestEnvironment();
    try {
      const otherId = insertSecondWorkspace(target.db);
      const other = createContext(target.db, otherId, { bus: target.bus, now: target.ctx.now });
      const person = createPerson(target.ctx, { firstName: 'Home', lastName: 'Only' });
      const promoted = mutate(other, (tx) => promotePersonIn(tx, person.id, 'replied'));
      expect(promoted).toBe(false);
      expect(lifecycleOf(target, person.id)).toBe('lead');
      expect(versionOf(target, person.id)).toBe(1);
      target.db.prepare("INSERT INTO pipeline (id, created_at, workspace_id, name) VALUES ('pip_bbbbbbbbbbbb', '2026-01-01', ?, 'Other')").run(otherId);
      target.db.prepare("INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES ('stg_bbbbbbbbbbbb', '2026-01-01', 'pip_bbbbbbbbbbbb', 'One', 1)").run();
      expect(failure(() => createOpportunity(other, { name: 'Cross deal', personId: person.id })).code).toBe('not_found');
    } finally {
      target.cleanup();
    }
  });

  it('KILLS: a stage move into another pipeline is refused and promotes nobody, and a late stage after a promotion adds no second audit row', () => {
    const target = createTestEnvironment();
    try {
      const stages = listPipelines(target.db, target.workspaceId)[0]!.stages;
      target.db.prepare("INSERT INTO pipeline (id, created_at, workspace_id, name) VALUES ('pip_cccccccccccc', '2099-01-01', ?, 'Second')").run(target.workspaceId);
      target.db.prepare("INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES ('stg_cccccccccccc', '2026-01-01', 'pip_cccccccccccc', 'Late', 3)").run();
      const person = createPerson(target.ctx, { firstName: 'Pipe', lastName: 'Line' });
      const opportunity = createOpportunity(target.ctx, { name: 'Pipe deal', personId: person.id });
      expect(failure(() => moveOpportunityStage(target.ctx, opportunity.id, { stageId: 'stg_cccccccccccc', expectedVersion: 1 })).code).toBe('validation');
      expect(lifecycleOf(target, person.id)).toBe('lead');
      const moved = moveOpportunityStage(target.ctx, opportunity.id, { stageId: stages[3]!.id, expectedVersion: 1 });
      moveOpportunityStage(target.ctx, opportunity.id, { stageId: stages[1]!.id, expectedVersion: moved.version });
      expect(promotions(target, person.id)).toEqual([{ reason: 'opportunity' }]);
    } finally {
      target.cleanup();
    }
  });

  it('KILLS: a deal created in a late stage and a deal re-pointed at a lead while in a late stage promote with reason opportunity, once only, while a first stage deal and a template switch never do', () => {
    const target = createTestEnvironment();
    try {
      const stages = listPipelines(target.db, target.workspaceId)[0]!.stages;
      const created = createPerson(target.ctx, { firstName: 'Created', lastName: 'Late' });
      createOpportunity(target.ctx, { name: 'Late deal', personId: created.id, stageId: stages[3]!.id });
      expect(lifecycleOf(target, created.id)).toBe('relationship');
      expect(promotions(target, created.id)).toEqual([{ reason: 'opportunity' }]);
      // Once only: a second late deal, and a move to another late stage, add no second audit row or version bump.
      const afterFirst = versionOf(target, created.id);
      const second = createOpportunity(target.ctx, { name: 'Second late deal', personId: created.id, stageId: stages[2]!.id });
      moveOpportunityStage(target.ctx, second.id, { stageId: stages[3]!.id, expectedVersion: second.version });
      expect(promotions(target, created.id)).toEqual([{ reason: 'opportunity' }]);
      expect(versionOf(target, created.id)).toBe(afterFirst);

      const repointed = createPerson(target.ctx, { firstName: 'Repointed', lastName: 'Lead' });
      const orphan = createOpportunity(target.ctx, { name: 'Orphan late', stageId: stages[2]!.id });
      expect(promotions(target, repointed.id)).toEqual([]);
      updateOpportunity(target.ctx, orphan.id, { expectedVersion: 1, fields: { personId: repointed.id } });
      expect(lifecycleOf(target, repointed.id)).toBe('relationship');
      expect(promotions(target, repointed.id)).toEqual([{ reason: 'opportunity' }]);

      // A first stage deal, created for a person or re-pointed at one, is no signal.
      const early = createPerson(target.ctx, { firstName: 'Early', lastName: 'Lead' });
      createOpportunity(target.ctx, { name: 'Early deal', personId: early.id });
      const earlyOrphan = createOpportunity(target.ctx, { name: 'Early orphan' });
      const earlyRepointed = createPerson(target.ctx, { firstName: 'EarlyRepointed', lastName: 'Lead' });
      updateOpportunity(target.ctx, earlyOrphan.id, { expectedVersion: 1, fields: { personId: earlyRepointed.id } });
      expect(lifecycleOf(target, early.id)).toBe('lead');
      expect(lifecycleOf(target, earlyRepointed.id)).toBe('lead');

      // A template switch renames stages and is never a signal, even when it lands a deal in a later stage.
      const switched = createPerson(target.ctx, { firstName: 'Switched', lastName: 'Lead' });
      const switchedDeal = createOpportunity(target.ctx, { name: 'Switch deal', personId: switched.id });
      // Contract change: the template switch is per pipeline, so it names the pipeline and carries the pipeline's version.
      const pipeline = target.db.prepare('SELECT id, version FROM pipeline WHERE workspace_id = ?').get(target.workspaceId) as { id: string; version: number };
      switchTemplate(target.ctx, {
        pipelineId: pipeline.id,
        template: 'client-sales',
        stageMapping: { [stages[0]!.id]: 'Proposal', [stages[3]!.id]: 'Proposal', [stages[2]!.id]: 'Proposal' },
        replaceQualification: false,
        expectedVersion: pipeline.version,
      });
      const seq = (target.db.prepare('SELECT s.seq FROM opportunity o JOIN stage s ON s.id = o.stage_id WHERE o.id = ?').get(switchedDeal.id) as { seq: number }).seq;
      expect(seq).toBeGreaterThan(1);
      expect(lifecycleOf(target, switched.id)).toBe('lead');
      expect(promotions(target, switched.id)).toEqual([]);
    } finally {
      target.cleanup();
    }
  });

  it('KILLS: a mailer daemon delay notice that is not a recognized bounce, sitting on the thread of a sent message, does not promote the recipient', async () => {
    const target = await freshMailEnv();
    const intentId = queueOne(target, 'Dora', 'dora@lanternrow.invalid');
    await drain(target);
    const intent = intentOf(target, intentId);
    expect(lifecycleOf(target, intent.personId)).toBe('lead');
    stub.addInbound({
      from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
      timestamp: at(target, 5),
      thread_id: intent.providerThreadId!,
      subject: 'Delivery Status Notification (Delay)',
      text: 'Delivery to dora@lanternrow.invalid is delayed. The server will keep trying.',
    });
    await syncMail(target.ctx);
    expect(lifecycleOf(target, intent.personId)).toBe('lead');
    expect(promotions(target, intent.personId)).toEqual([]);
  });

  it('KILLS: a third party writing "unsubscribe" on a known thread suppresses the person it names but does not promote them, while the person writing it themselves is a sender matching their own email and promotes (documented in architecture.md)', async () => {
    const target = await freshMailEnv();
    const intentId = queueOne(target, 'Pia', 'pia@lanternrow.invalid');
    const selfId = queueOne(target, 'Sol', 'sol@lanternrow.invalid');
    await drain(target);
    const intent = intentOf(target, intentId);
    const selfIntent = intentOf(target, selfId);
    stub.addInbound({ from: 'assistant@elsewhere.invalid', timestamp: at(target, 5), thread_id: intent.providerThreadId!, text: 'Please unsubscribe Pia.' });
    stub.addInbound({ from: 'sol@lanternrow.invalid', timestamp: at(target, 6), thread_id: selfIntent.providerThreadId!, text: 'Please unsubscribe me.' });
    await syncMail(target.ctx);
    expect(target.db.prepare("SELECT COUNT(*) AS n FROM suppression WHERE email = 'pia@lanternrow.invalid' AND reason = 'opt_out'").get()).toEqual({ n: 1 });
    expect(lifecycleOf(target, intent.personId)).toBe('lead');
    expect(promotions(target, intent.personId)).toEqual([]);
    expect(lifecycleOf(target, selfIntent.personId)).toBe('relationship');
    expect(promotions(target, selfIntent.personId)).toEqual([{ reason: 'replied' }]);
  });

  it('KILLS: when a known colleague replies on the thread of a send to someone else, the colleague wrote the message and so promotes themselves, while the recipient (whose intent is marked replied and who gets the reply task) is never promoted by someone else\'s mail (documented in architecture.md)', async () => {
    const target = await freshMailEnv();
    const colleague = addPerson(target, 'Colleague', 'colleague@lanternrow.invalid');
    const intentId = queueOne(target, 'Rhea', 'rhea@lanternrow.invalid');
    await drain(target);
    const intent = intentOf(target, intentId);
    stub.addInbound({ from: 'colleague@lanternrow.invalid', timestamp: at(target, 5), thread_id: intent.providerThreadId!, text: 'Rhea will answer next week.' });
    await syncMail(target.ctx);
    expect(intentOf(target, intentId).status).toBe('replied');
    expect(target.db.prepare("SELECT COUNT(*) AS n FROM task WHERE entity_id = ? AND title LIKE 'Reply received%'").get(intent.personId)).toEqual({ n: 1 });
    expect(lifecycleOf(target, colleague.id)).toBe('relationship');
    expect(promotions(target, colleague.id)).toEqual([{ reason: 'replied' }]);
    expect(lifecycleOf(target, intent.personId)).toBe('lead');
    expect(promotions(target, intent.personId)).toEqual([]);
  });

  it('KILLS: replaying every stored message after the connector cursor is wiped re-promotes nobody who was demoted by hand', async () => {
    const target = await freshMailEnv();
    const person = addPerson(target, 'Replay', 'replay@lanternrow.invalid');
    stub.addInbound({ from: 'replay@lanternrow.invalid', timestamp: at(target, 5), subject: 'First' });
    await syncMail(target.ctx);
    expect(lifecycleOf(target, person.id)).toBe('relationship');
    updatePerson(target.ctx, person.id, { expectedVersion: versionOf(target, person.id), fields: { lifecycle: 'lead' } });
    target.db.prepare("UPDATE connector SET settings = json_remove(settings, '$.lastMessageTimestamp') WHERE kind = 'agentmail'").run();
    const result = await syncMail(target.ctx);
    expect(result.messagesStored).toBe(0);
    expect(lifecycleOf(target, person.id)).toBe('lead');
    expect(promotions(target, person.id)).toHaveLength(1);
  });

  it('ACCEPTED: an old message that first syncs after a manual demotion counts as new and promotes again even though it predates the demotion (documented in architecture.md)', async () => {
    const target = await freshMailEnv();
    const person = addPerson(target, 'Late', 'late@lanternrow.invalid');
    stub.addInbound({ from: 'late@lanternrow.invalid', timestamp: at(target, 5), subject: 'Recent' });
    await syncMail(target.ctx);
    updatePerson(target.ctx, person.id, { expectedVersion: versionOf(target, person.id), fields: { lifecycle: 'lead' } });
    const demotedAt = (target.db.prepare("SELECT updated_at FROM person WHERE id = ?").get(person.id) as { updated_at: string }).updated_at;
    const old = stub.addInbound({ from: 'late@lanternrow.invalid', timestamp: at(target, -86400 * 400), subject: 'Ancient' });
    expect(old.timestamp < demotedAt).toBe(true);
    target.db.prepare("UPDATE connector SET settings = json_remove(settings, '$.lastMessageTimestamp') WHERE kind = 'agentmail'").run();
    await syncMail(target.ctx);
    expect(lifecycleOf(target, person.id)).toBe('relationship');
    expect(promotions(target, person.id)).toHaveLength(2);
  });

  it('KILLS: a bounce event, an outbound copy of our own send, and a stranger reply promote nobody', async () => {
    const target = await freshMailEnv();
    const intentId = queueOne(target, 'Ivo', 'ivo@lanternrow.invalid');
    await drain(target);
    const intent = intentOf(target, intentId);
    stub.addEvent({ message_id: intent.providerMessageId!, label: 'bounced' });
    stub.addInbound({ from: stubInboxId, to: ['ivo@lanternrow.invalid'], labels: ['sent'], timestamp: at(target, 3), subject: 'Hello' });
    stub.addInbound({ from: 'stranger@nowhere.invalid', timestamp: at(target, 4), thread_id: 'thr_unrelated' });
    await syncMail(target.ctx);
    expect(lifecycleOf(target, intent.personId)).toBe('lead');
    expect(target.db.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'person.promote'").get()).toEqual({ n: 0 });
  });
});

describe('fail closed creation paths', () => {
  it('KILLS: a person created through an auto accepted CSV import is a lead', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    try {
      const created = await call('POST', '/api/imports/csv', {
        fileName: 'auto.csv',
        content: 'Name,Email\nAuto Lead,auto.lead@example.org\n',
        mapping: { Name: 'name', Email: 'email' },
      });
      expect(created.status).toBe(201);
      expect(driveRun(env, created.body.id as string, ['succeeded', 'waiting_approval'])).toBe('succeeded');
      const row = env.db.prepare("SELECT lifecycle FROM person WHERE email = 'auto.lead@example.org'").get() as { lifecycle: string };
      expect(row.lifecycle).toBe('lead');
    } finally {
      setImportSettings(env.ctx, { autoAccept: false });
    }
  });

  it('KILLS: the HTTP create and PATCH reject every lifecycle that is not exactly lead or relationship, and reject unknown keys', async () => {
    for (const bad of ['Lead', 'RELATIONSHIP', 'customer', '', null, 1, true, ['lead']]) {
      const response = await call('POST', '/api/people', { firstName: 'Bad', lifecycle: bad });
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call('POST', '/api/people', { firstName: 'Bad', lifecycles: 'lead' })).status).toBe(400);
    const person = createPerson(env.ctx, { firstName: 'Strict', lastName: 'Patch' });
    for (const bad of [null, '', 'Lead', 0]) {
      expect((await call('PATCH', `/api/people/${person.id}`, { expectedVersion: 1, fields: { lifecycle: bad } })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call('GET', '/api/people?lifecycle=')).status).toBe(400);
    expect((await call('GET', '/api/people?lifecycle=Lead')).status).toBe(400);
    expect(lifecycleOf(env, person.id)).toBe('lead');
    expect(versionOf(env, person.id)).toBe(1);
  });

  it('KILLS: search ignores lifecycle entirely, so a lead and a relationship both turn up, with or without the filter parameter', async () => {
    const lead = createPerson(env.ctx, { firstName: 'Zqsearch', lastName: 'Alpha' });
    const known = createPerson(env.ctx, { firstName: 'Zqsearch', lastName: 'Beta', lifecycle: 'relationship' });
    const found = searchAll(env.db, env.workspaceId, 'zqsearch');
    expect(found.people.map((item: { id: string }) => item.id).sort()).toEqual([lead.id, known.id].sort());
    const http = await call('GET', '/api/search?q=zqsearch&lifecycle=lead');
    expect(http.status).toBe(200);
    expect((http.body.people as { id: string }[]).map((item) => item.id).sort()).toEqual([lead.id, known.id].sort());
  });
});
