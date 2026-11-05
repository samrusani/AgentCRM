import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applyChanges,
  createOpportunity,
  createOrganization,
  createPerson,
  decideApproval,
  moveOpportunityStage,
  proposeChanges,
  syncMail,
  updateOpportunity,
  updatePerson,
} from '../src/actions/index.js';
import { applyMigrations, listMigrationFiles } from '../src/db.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { migrationsDirectory } from '../src/paths.js';
import { listOrganizations } from '../src/queries/organizations.js';
import { listPeople } from '../src/queries/people.js';
import { listPipelines } from '../src/queries/pipelines.js';
import { type AgentmailStub, startAgentmailStub, stubInboxId, useAgentmailStub } from './agentmailStub.js';
import { createTestEnvironment, driveRun, type TestEnvironment } from './helpers.js';
import { addPerson, connectMail } from './mailHelpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let stub: AgentmailStub;
let restoreStub: () => void;
const mailEnvironments: TestEnvironment[] = [];
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

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await app.inject({ method, url, headers: { ...host, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
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

function promotions(target: TestEnvironment, personId: string): { reason: string }[] {
  return (
    target.db.prepare("SELECT detail FROM audit_event WHERE action = 'person.promote' AND entity_id = ? ORDER BY created_at, id").all(personId) as { detail: string }[]
  ).map((row) => JSON.parse(row.detail) as { reason: string });
}

function stagesOf(target: TestEnvironment) {
  return listPipelines(target.db, target.workspaceId)[0]!.stages;
}

describe('migration 019', () => {
  it('marks people with an inbound email or an opportunity past the first stage as relationships', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of listMigrationFiles().filter((name) => name < '019')) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'One', 't');
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_2', '2026-01-01', 'Two', 't');
      db.prepare('INSERT INTO pipeline (id, created_at, workspace_id, name) VALUES (?, ?, ?, ?)').run('pip_1', '2026-01-01', 'wsp_1', 'Main');
      db.prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, ?)').run('stg_1', '2026-01-01', 'pip_1', 'First', 1);
      db.prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, ?)').run('stg_2', '2026-01-01', 'pip_1', 'Second', 2);
      for (const id of ['per_replied', 'per_sent', 'per_past', 'per_first', 'per_none']) {
        db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, '2026-01-01', 'wsp_1', id, '2026-01-01');
      }
      const message = (id: string, personId: string, direction: string) =>
        db
          .prepare(
            "INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, direction, person_id, from_email, provider_timestamp) VALUES (?, '2026-01-02', 'wsp_1', ?, ?, ?, 'x@example.com', '2026-01-02T00:00:00.000Z')",
          )
          .run(id, `pm_${id}`, direction, personId);
      message('msg_in', 'per_replied', 'in');
      message('msg_out', 'per_sent', 'out');
      const opportunity = (id: string, personId: string, stageId: string) =>
        db
          .prepare(
            "INSERT INTO opportunity (id, created_at, workspace_id, name, pipeline_id, stage_id, person_id, stage_changed_at, updated_at) VALUES (?, '2026-01-02', 'wsp_1', ?, 'pip_1', ?, ?, '2026-01-02', '2026-01-02')",
          )
          .run(id, id, stageId, personId);
      opportunity('opp_past', 'per_past', 'stg_2');
      opportunity('opp_first', 'per_first', 'stg_1');

      expect(applyMigrations(db)).toEqual(['019_lifecycle.sql', '020_lifecycle_indexes.sql']);

      const rows = db.prepare('SELECT id, lifecycle FROM person ORDER BY id').all();
      expect(rows).toEqual([
        { id: 'per_first', lifecycle: 'lead' },
        { id: 'per_none', lifecycle: 'lead' },
        { id: 'per_past', lifecycle: 'relationship' },
        { id: 'per_replied', lifecycle: 'relationship' },
        { id: 'per_sent', lifecycle: 'lead' },
      ]);
      expect(() => db.prepare("UPDATE person SET lifecycle = 'customer' WHERE id = 'per_none'").run()).toThrow(/CHECK/);
      const indexColumns = (db.pragma('index_info(idx_person_lifecycle)') as { name: string }[]).map((column) => column.name);
      expect(indexColumns).toEqual(['workspace_id', 'lifecycle']);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('create and edit', () => {
  it('defaults a new person to lead and accepts an explicit lifecycle', async () => {
    const plain = createPerson(env.ctx, { firstName: 'Lena' });
    expect(plain.lifecycle).toBe('lead');
    const known = createPerson(env.ctx, { firstName: 'Kit', lifecycle: 'relationship' });
    expect(known.lifecycle).toBe('relationship');
    expect(failure(() => createPerson(env.ctx, { firstName: 'Bad', lifecycle: 'customer' })).code).toBe('validation');

    const http = await call('POST', '/api/people', { firstName: 'Via', lastName: 'Http' });
    expect(http.status).toBe(201);
    expect(http.body.lifecycle).toBe('lead');
    const httpKnown = await call('POST', '/api/people', { firstName: 'Via', lastName: 'Known', lifecycle: 'relationship' });
    expect(httpKnown.body.lifecycle).toBe('relationship');
    expect((await call('GET', `/api/people/${http.body.id}`)).body.lifecycle).toBe('lead');
  });

  it('round trips through PATCH and rejects a bad value', async () => {
    const person = createPerson(env.ctx, { firstName: 'Patch', lastName: 'Trip' });
    const changed = await call('PATCH', `/api/people/${person.id}`, { expectedVersion: 1, fields: { lifecycle: 'relationship' } });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ lifecycle: 'relationship', version: 2 });
    const back = await call('PATCH', `/api/people/${person.id}`, { expectedVersion: 2, fields: { lifecycle: 'lead' } });
    expect(back.body).toMatchObject({ lifecycle: 'lead', version: 3 });

    const bad = await call('PATCH', `/api/people/${person.id}`, { expectedVersion: 3, fields: { lifecycle: 'customer' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation');
    expect(lifecycleOf(env, person.id)).toBe('lead');
  });

  it('carries lifecycle through the propose and apply flow', () => {
    const person = createPerson(env.ctx, { firstName: 'Prop', lastName: 'Osal' });
    const proposal = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: person.id, fields: { lifecycle: 'relationship' } }] });
    expect(proposal.valid).toBe(true);
    expect(proposal.changes[0]!.diff).toEqual([{ field: 'lifecycle', from: 'lead', to: 'relationship' }]);
    applyChanges(env.ctx, { proposalHash: proposal.proposalHash, changes: proposal.changes.map((change) => ({ entityType: change.entityType, id: change.id, expectedVersion: change.expectedVersion, fields: change.fields })) });
    expect(lifecycleOf(env, person.id)).toBe('relationship');
    const invalid = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: person.id, fields: { lifecycle: 'other' } }] });
    expect(invalid.valid).toBe(false);
  });
});

describe('promotion on a stage move', () => {
  it('promotes a lead when the opportunity moves past the first stage, once, with an audit row and an event', () => {
    const stages = stagesOf(env);
    const person = createPerson(env.ctx, { firstName: 'Stage', lastName: 'Mover' });
    const opportunity = createOpportunity(env.ctx, { name: 'Stage deal', personId: person.id });
    expect(lifecycleOf(env, person.id)).toBe('lead');

    const events: DomainEvent[] = [];
    const unsubscribe = env.bus.subscribe((event) => events.push(event));
    const moved = moveOpportunityStage(env.ctx, opportunity.id, { stageId: stages[1]!.id, expectedVersion: 1 });
    unsubscribe();
    expect(lifecycleOf(env, person.id)).toBe('relationship');
    expect(promotions(env, person.id)).toEqual([{ reason: 'opportunity' }]);
    expect(events).toContainEqual({ type: 'record_updated', entityType: 'person', entityId: person.id });
    expect((env.db.prepare('SELECT version FROM person WHERE id = ?').get(person.id) as { version: number }).version).toBe(2);

    // A second move does not promote again.
    moveOpportunityStage(env.ctx, opportunity.id, { stageId: stages[2]!.id, expectedVersion: moved.version });
    expect(promotions(env, person.id)).toHaveLength(1);
    expect((env.db.prepare('SELECT version FROM person WHERE id = ?').get(person.id) as { version: number }).version).toBe(2);
  });

  it('does not promote on a move back to the first stage, or when the opportunity names no person', () => {
    const stages = stagesOf(env);
    const person = createPerson(env.ctx, { firstName: 'Back', lastName: 'Mover' });
    // Creation in a later stage is itself a signal; the move back to the first stage is not, and does not undo it.
    const opportunity = createOpportunity(env.ctx, { name: 'Back deal', personId: person.id, stageId: stages[1]!.id });
    expect(lifecycleOf(env, person.id)).toBe('relationship');
    updatePerson(env.ctx, person.id, { expectedVersion: 2, fields: { lifecycle: 'lead' } });
    moveOpportunityStage(env.ctx, opportunity.id, { stageId: stages[0]!.id, expectedVersion: 1 });
    expect(lifecycleOf(env, person.id)).toBe('lead');
    expect(promotions(env, person.id)).toEqual([{ reason: 'opportunity' }]);

    const orphan = createOpportunity(env.ctx, { name: 'No person deal' });
    const before = (env.db.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'person.promote'").get() as { n: number }).n;
    moveOpportunityStage(env.ctx, orphan.id, { stageId: stages[2]!.id, expectedVersion: 1 });
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'person.promote'").get() as { n: number }).n).toBe(before);
  });

  it('keeps a manual demotion until the next stage move, and never reads old history', () => {
    const stages = stagesOf(env);
    const person = createPerson(env.ctx, { firstName: 'Demo', lastName: 'Ted' });
    const opportunity = createOpportunity(env.ctx, { name: 'Demote deal', personId: person.id });
    const moved = moveOpportunityStage(env.ctx, opportunity.id, { stageId: stages[1]!.id, expectedVersion: 1 });
    expect(lifecycleOf(env, person.id)).toBe('relationship');

    updatePerson(env.ctx, person.id, { expectedVersion: 2, fields: { lifecycle: 'lead' } });
    expect(lifecycleOf(env, person.id)).toBe('lead');
    // Edits that are not a stage move do not bring the person back, even though the opportunity sits past stage one.
    const edited = updateOpportunity(env.ctx, opportunity.id, { expectedVersion: moved.version, fields: { owner: 'Sam' } });
    updatePerson(env.ctx, person.id, { expectedVersion: 3, fields: { title: 'Partner' } });
    expect(lifecycleOf(env, person.id)).toBe('lead');
    expect(promotions(env, person.id)).toHaveLength(1);

    moveOpportunityStage(env.ctx, opportunity.id, { stageId: stages[2]!.id, expectedVersion: edited.version });
    expect(lifecycleOf(env, person.id)).toBe('relationship');
    expect(promotions(env, person.id)).toEqual([{ reason: 'opportunity' }, { reason: 'opportunity' }]);
  });

  it('leaves a person who is already a relationship untouched', () => {
    const stages = stagesOf(env);
    const person = createPerson(env.ctx, { firstName: 'Already', lastName: 'Known', lifecycle: 'relationship' });
    const opportunity = createOpportunity(env.ctx, { name: 'Known deal', personId: person.id });
    moveOpportunityStage(env.ctx, opportunity.id, { stageId: stages[1]!.id, expectedVersion: 1 });
    expect(promotions(env, person.id)).toEqual([]);
    expect((env.db.prepare('SELECT version FROM person WHERE id = ?').get(person.id) as { version: number }).version).toBe(1);
  });
});

describe('promotion on an inbound email', () => {
  async function freshMailEnv(): Promise<TestEnvironment> {
    const target = createTestEnvironment();
    mailEnvironments.push(target);
    await connectMail(target);
    return target;
  }

  const at = (target: TestEnvironment, seconds: number) => new Date(Date.parse(target.ctx.now()) + seconds * 1000).toISOString();

  it('promotes the person when an inbound email links to them, once, and not on an outbound email', async () => {
    const target = await freshMailEnv();
    const replier = addPerson(target, 'Ada', 'ada@lanternrow.invalid');
    const recipient = addPerson(target, 'Ben', 'ben@lanternrow.invalid');
    const stranger = addPerson(target, 'Cy', 'cy@lanternrow.invalid');
    stub.addInbound({ from: stubInboxId, to: ['ben@lanternrow.invalid'], labels: ['sent'], timestamp: at(target, 3), subject: 'Hello' });
    stub.addInbound({ from: 'ada@lanternrow.invalid', timestamp: at(target, 5), subject: 'Re: hello' });
    stub.addInbound({ from: 'nobody@nowhere.invalid', timestamp: at(target, 6) });

    const events: DomainEvent[] = [];
    const unsubscribe = target.bus.subscribe((event) => events.push(event));
    await syncMail(target.ctx);
    unsubscribe();

    expect(lifecycleOf(target, replier.id)).toBe('relationship');
    expect(promotions(target, replier.id)).toEqual([{ reason: 'replied' }]);
    expect(events).toContainEqual({ type: 'record_updated', entityType: 'person', entityId: replier.id });
    expect(lifecycleOf(target, recipient.id)).toBe('lead');
    expect(lifecycleOf(target, stranger.id)).toBe('lead');
    expect(promotions(target, recipient.id)).toEqual([]);

    // A second reply from a person who is already a relationship adds no second promotion.
    stub.addInbound({ from: 'ada@lanternrow.invalid', timestamp: at(target, 20), subject: 'Re: again' });
    await syncMail(target.ctx);
    expect(promotions(target, replier.id)).toHaveLength(1);
  });

  it('keeps a manual demotion until a new reply arrives', async () => {
    const target = await freshMailEnv();
    const person = addPerson(target, 'Dee', 'dee@lanternrow.invalid');
    stub.addInbound({ from: 'dee@lanternrow.invalid', timestamp: at(target, 5), subject: 'First' });
    await syncMail(target.ctx);
    expect(lifecycleOf(target, person.id)).toBe('relationship');

    const version = (target.db.prepare('SELECT version FROM person WHERE id = ?').get(person.id) as { version: number }).version;
    updatePerson(target.ctx, person.id, { expectedVersion: version, fields: { lifecycle: 'lead' } });
    await syncMail(target.ctx);
    expect(lifecycleOf(target, person.id)).toBe('lead');

    stub.addInbound({ from: 'dee@lanternrow.invalid', timestamp: at(target, 30), subject: 'Second' });
    await syncMail(target.ctx);
    expect(lifecycleOf(target, person.id)).toBe('relationship');
    expect(promotions(target, person.id)).toEqual([{ reason: 'replied' }, { reason: 'replied' }]);
  });
});

describe('list filters', () => {
  it('filters people by lifecycle in SQL and keeps the cursor valid across pages', async () => {
    const target = createTestEnvironment();
    try {
      const names = ['Abel', 'Bram', 'Cora', 'Dane', 'Elin', 'Fay', 'Gus'];
      const ids = names.map((name, index) =>
        createPerson(target.ctx, { firstName: name, lastName: 'Filter', lifecycle: index % 2 === 0 ? 'relationship' : 'lead' }).id,
      );
      const everyone = listPeople(target.db, target.workspaceId, { limit: 50 }).items;
      expect(everyone).toHaveLength(7);

      const collect = (lifecycle: 'lead' | 'relationship' | undefined) => {
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = listPeople(target.db, target.workspaceId, { lifecycle, limit: 2, ...(cursor ? { cursor } : {}) });
          seen.push(...page.items.map((item) => item.firstName));
          cursor = page.nextCursor ?? undefined;
          pages += 1;
        } while (cursor);
        return { seen, pages };
      };
      expect(collect('relationship')).toEqual({ seen: ['Abel', 'Cora', 'Elin', 'Gus'], pages: 2 });
      expect(collect('lead')).toEqual({ seen: ['Bram', 'Dane', 'Fay'], pages: 2 });
      expect(collect(undefined).seen).toEqual(names);

      // Composes with the search query and the organization filter.
      expect(listPeople(target.db, target.workspaceId, { lifecycle: 'lead', q: 'dane' }).items.map((item) => item.firstName)).toEqual(['Dane']);
      expect(listPeople(target.db, target.workspaceId, { lifecycle: 'relationship', q: 'dane' }).items).toEqual([]);
      expect(ids).toHaveLength(7);
    } finally {
      target.cleanup();
    }
  });

  it('serves the people filter over HTTP and rejects an unknown value', async () => {
    const lead = createPerson(env.ctx, { firstName: 'Zed', lastName: 'Zzlifelead' });
    const known = createPerson(env.ctx, { firstName: 'Zoe', lastName: 'Zzlifeknown', lifecycle: 'relationship' });
    const leads = await call('GET', '/api/people?lifecycle=lead&q=zzlife');
    expect(leads.body.items.map((item: { id: string }) => item.id)).toEqual([lead.id]);
    expect(leads.body.items[0].lifecycle).toBe('lead');
    const relationships = await call('GET', '/api/people?lifecycle=relationship&q=zzlife');
    expect(relationships.body.items.map((item: { id: string }) => item.id)).toEqual([known.id]);
    expect((await call('GET', '/api/people?q=zzlife')).body.items).toHaveLength(2);
    expect((await call('GET', '/api/people?lifecycle=customer')).status).toBe(400);
    expect((await call('GET', '/api/organizations?lifecycle=customer')).status).toBe(400);
  });

  it('derives the organization lifecycle from people and opportunities, with a valid cursor', async () => {
    const target = createTestEnvironment();
    try {
      const byPerson = createOrganization(target.ctx, { name: 'A Person Org', kind: 'company' });
      const byOpportunity = createOrganization(target.ctx, { name: 'B Opportunity Org', kind: 'fund' });
      const leadsOnly = createOrganization(target.ctx, { name: 'C Leads Org', kind: 'company' });
      const empty = createOrganization(target.ctx, { name: 'D Empty Org', kind: 'company' });
      const both = createOrganization(target.ctx, { name: 'E Both Org', kind: 'company' });
      createPerson(target.ctx, { firstName: 'Rel', organizationId: byPerson.id, lifecycle: 'relationship' });
      createPerson(target.ctx, { firstName: 'Lead', organizationId: byOpportunity.id });
      createPerson(target.ctx, { firstName: 'Lead', lastName: 'Two', organizationId: leadsOnly.id });
      createPerson(target.ctx, { firstName: 'Rel', lastName: 'Both', organizationId: both.id, lifecycle: 'relationship' });
      // The opportunity makes the organization a relationship even though its only person is a lead.
      createOpportunity(target.ctx, { name: 'Org only deal', organizationId: byOpportunity.id });
      createOpportunity(target.ctx, { name: 'Both deal', organizationId: both.id });

      const names = (lifecycle?: 'lead' | 'relationship', limit = 50) => {
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = listOrganizations(target.db, target.workspaceId, { limit, ...(lifecycle ? { lifecycle } : {}), ...(cursor ? { cursor } : {}) });
          seen.push(...page.items.map((item) => item.name));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return seen;
      };
      expect(names('relationship')).toEqual(['A Person Org', 'B Opportunity Org', 'E Both Org']);
      expect(names('lead')).toEqual(['C Leads Org', 'D Empty Org']);
      expect(names()).toHaveLength(5);
      // One row per page proves the keyset cursor holds with the EXISTS filters, and an organization shows once.
      expect(names('relationship', 1)).toEqual(['A Person Org', 'B Opportunity Org', 'E Both Org']);
      expect(names('lead', 1)).toEqual(['C Leads Org', 'D Empty Org']);
      expect(empty.id).toBeTruthy();

      // Demoting the only relationship person moves the organization to lead; a new person elsewhere does not matter.
      const person = target.db.prepare('SELECT id, version FROM person WHERE organization_id = ?').get(byPerson.id) as { id: string; version: number };
      updatePerson(target.ctx, person.id, { expectedVersion: person.version, fields: { lifecycle: 'lead' } });
      expect(names('lead')).toEqual(['A Person Org', 'C Leads Org', 'D Empty Org']);
    } finally {
      target.cleanup();
    }
  });

  it('serves the organization filter over HTTP', async () => {
    const organization = createOrganization(env.ctx, { name: 'Httpfilter Org', kind: 'company' });
    createPerson(env.ctx, { firstName: 'Org', lastName: 'Member', organizationId: organization.id, lifecycle: 'relationship' });
    const relationships = await call('GET', '/api/organizations?lifecycle=relationship&q=httpfilter');
    expect(relationships.body.items.map((item: { id: string }) => item.id)).toEqual([organization.id]);
    expect((await call('GET', '/api/organizations?lifecycle=lead&q=httpfilter')).body.items).toEqual([]);
  });
});

describe('creation paths make leads', () => {
  it('creates a lead from an extension capture', async () => {
    const token = (await call('POST', '/api/capture/token')).body.token as string;
    const captured = await call(
      'POST',
      '/api/capture',
      { source: 'x', url: 'https://x.com/life_capture', name: 'Capture Lead' },
      { authorization: `Bearer ${token}` },
    );
    expect(captured.status).toBe(201);
    expect(lifecycleOf(env, captured.body.person.id)).toBe('lead');
  });

  it('creates leads when an import is accepted', async () => {
    const content = 'Name,Email\nImport Lead,import.lead@example.org\n';
    const created = await call('POST', '/api/imports/csv', { fileName: 'lifecycle.csv', content, mapping: { Name: 'name', Email: 'email' } });
    expect(created.status).toBe(201);
    const runId = created.body.id as string;
    expect(driveRun(env, runId, ['waiting_approval'])).toBe('waiting_approval');
    const approval = env.db.prepare("SELECT id FROM approval WHERE run_id = ? AND status = 'pending'").get(runId) as { id: string };
    decideApproval(env.ctx, approval.id, { decision: 'approve' });
    const row = env.db.prepare("SELECT lifecycle FROM person WHERE email = 'import.lead@example.org'").get() as { lifecycle: string };
    expect(row.lifecycle).toBe('lead');
  });
});
