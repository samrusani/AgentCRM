// Adversarial review probes for the multi pipeline wave (migration 022, pipeline CRUD, per pipeline template switch).
// Names start with KILLS (the attack fails and the test pins that), CONFIRMS (a live bug: the test passes against today's
// code and the comment says what should happen instead), or ACCEPTED (a documented limit or a deliberate trade off).
// Nothing here changes application code.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyChanges,
  createContext,
  createOpportunity,
  createPipeline,
  deletePipeline,
  moveOpportunityStage,
  proposeChanges,
  saveQualificationConfig,
  switchTemplate,
  updateOpportunity,
  updatePipeline,
} from '../src/actions/index.js';
import { applyMigrations, openDatabase } from '../src/db.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { migrationsDirectory, packageRoot } from '../src/paths.js';
import { readQualificationConfig } from '../src/qualification/config.js';
import { listPipelines } from '../src/queries/pipelines.js';
import { seedDatabase } from '../src/seed/seed.js';
import { getTemplate } from '../src/templates.js';
import { createTestEnvironment, insertSecondWorkspace, type TestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
const events: DomainEvent[] = [];

beforeAll(async () => {
  env.bus.subscribe((event) => events.push(event));
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

function rejected(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('Expected the call to be rejected.');
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await app.inject({
    method,
    url,
    headers: { host: 'localhost:5173', ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: response.statusCode, body: response.body === '' ? null : (response.json() as Record<string, any>) };
}

const mk = (name: string, template = 'startup-fundraising', e: TestEnvironment = env) => createPipeline(e.ctx, { name, template });
const one = (e: TestEnvironment, id: string) => listPipelines(e.db, e.workspaceId).find((pipeline) => pipeline.id === id)!;
const countOf = (e: TestEnvironment, sql: string, ...params: unknown[]): number => Number((e.db.prepare(sql).get(...params) as { n: number }).n);
const auditCount = (e: TestEnvironment) => countOf(e, 'SELECT COUNT(*) AS n FROM audit_event');
const snapshot = (e: TestEnvironment) =>
  JSON.stringify(
    ['pipeline', 'stage', 'opportunity', 'stage_event', 'activity'].map((table) => e.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).concat([
      e.db.prepare('SELECT settings FROM workspace').all(),
    ]),
  );
const identityMapping = (pipeline: { stages: { id: string; seq: number }[] }, target: string) =>
  Object.fromEntries(pipeline.stages.map((stage) => [stage.id, getTemplate(target)!.stageNames[stage.seq - 1]!]));

function withEnv<T>(run: (e: TestEnvironment) => T): T {
  const e = createTestEnvironment();
  try {
    return run(e);
  } finally {
    e.cleanup();
  }
}

describe('cross pipeline integrity', () => {
  it('KILLS: PATCH on an opportunity cannot carry pipelineId or stageId, over HTTP or the top level', async () => {
    const a = mk('Cross A');
    const b = mk('Cross B');
    const deal = createOpportunity(env.ctx, { name: 'Cross deal', pipelineId: a.id });
    for (const fields of [{ stageId: b.stages[2]!.id }, { pipelineId: b.id }]) {
      const response = await call('PATCH', `/api/opportunities/${deal.id}`, { expectedVersion: deal.version, fields });
      expect(response.status).toBe(400);
    }
    expect((await call('PATCH', `/api/opportunities/${deal.id}`, { expectedVersion: deal.version, stageId: b.stages[0]!.id, fields: { owner: 'x' } })).status).toBe(400);
    expect(env.db.prepare('SELECT pipeline_id, stage_id, version FROM opportunity WHERE id = ?').get(deal.id)).toEqual({
      pipeline_id: a.id,
      stage_id: a.stages[0]!.id,
      version: deal.version,
    });
  });

  it('KILLS: the stage endpoint refuses another pipeline stage (400) and a stage removed by a template switch (404), with no side effect', async () => {
    const a = mk('Stage A');
    const b = mk('Stage B');
    const deal = createOpportunity(env.ctx, { name: 'Stage deal', pipelineId: a.id });
    const before = snapshot(env);
    expect((await call('POST', `/api/opportunities/${deal.id}/stage`, { stageId: b.stages[1]!.id, expectedVersion: deal.version })).status).toBe(400);
    expect(snapshot(env)).toBe(before);

    // A client that still holds the old stage ids after another tab switched the template.
    const switched = switchTemplate(env.ctx, {
      pipelineId: a.id,
      template: 'client-sales',
      stageMapping: identityMapping(a, 'client-sales'),
      replaceQualification: false,
      expectedVersion: a.version,
    });
    const fresh = env.db.prepare('SELECT version FROM opportunity WHERE id = ?').get(deal.id) as { version: number };
    const stale = await call('POST', `/api/opportunities/${deal.id}/stage`, { stageId: a.stages[2]!.id, expectedVersion: fresh.version });
    expect(stale.status).toBe(404);
    expect((await call('POST', '/api/opportunities', { name: 'Late', stageId: a.stages[2]!.id })).status).toBe(404);
    expect(countOf(env, "SELECT COUNT(*) AS n FROM opportunity WHERE name = 'Late'")).toBe(0);
    expect((await call('POST', `/api/opportunities/${deal.id}/stage`, { stageId: switched.stages[2]!.id, expectedVersion: fresh.version })).status).toBe(200);
  });

  it('KILLS: switching pipeline A leaves every row of pipeline B byte identical, deals and stage history included', () => {
    const a = mk('Iso A');
    const b = mk('Iso B');
    const dealA = createOpportunity(env.ctx, { name: 'Iso deal A', pipelineId: a.id });
    const dealB = createOpportunity(env.ctx, { name: 'Iso deal B', pipelineId: b.id });
    moveOpportunityStage(env.ctx, dealB.id, { stageId: b.stages[3]!.id, expectedVersion: dealB.version });
    const rowsB = () =>
      JSON.stringify([
        env.db.prepare('SELECT * FROM pipeline WHERE id = ?').all(b.id),
        env.db.prepare('SELECT * FROM stage WHERE pipeline_id = ? ORDER BY id').all(b.id),
        env.db.prepare('SELECT * FROM opportunity WHERE pipeline_id = ?').all(b.id),
        env.db.prepare('SELECT e.* FROM stage_event e JOIN opportunity o ON o.id = e.opportunity_id WHERE o.pipeline_id = ? ORDER BY e.id').all(b.id),
        env.db.prepare('SELECT * FROM activity WHERE entity_id IN (SELECT id FROM opportunity WHERE pipeline_id = ?) ORDER BY id').all(b.id),
      ]);
    const before = rowsB();
    switchTemplate(env.ctx, {
      pipelineId: a.id,
      template: 'fund-lp',
      stageMapping: { [a.stages[0]!.id]: 'Research' },
      replaceQualification: false,
      expectedVersion: a.version,
    });
    expect(rowsB()).toBe(before);
    expect(env.db.prepare('SELECT pipeline_id FROM opportunity WHERE id = ?').get(dealA.id)).toEqual({ pipeline_id: a.id });
  });

  it('KILLS: every refused switch (foreign stage key, name outside the target, unmapped stage, same template) leaves all rows, events, and audit untouched', () => {
    const a = mk('Refuse A');
    const b = mk('Refuse B');
    createOpportunity(env.ctx, { name: 'Refuse deal', pipelineId: a.id });
    const base = { pipelineId: a.id, replaceQualification: true, expectedVersion: a.version };
    const attempts: Array<Record<string, unknown>> = [
      { ...base, template: 'client-sales', stageMapping: { [a.stages[0]!.id]: 'Research', [b.stages[0]!.id]: 'Research' } },
      { ...base, template: 'client-sales', stageMapping: { [a.stages[0]!.id]: 'Diligence' } },
      { ...base, template: 'client-sales', stageMapping: {} },
      { ...base, template: 'startup-fundraising', stageMapping: { [a.stages[0]!.id]: 'Research' } },
      { ...base, template: 'nope', stageMapping: { [a.stages[0]!.id]: 'Research' } },
    ];
    const before = snapshot(env);
    const auditsBefore = auditCount(env);
    events.length = 0;
    for (const attempt of attempts) expect(rejected(() => switchTemplate(env.ctx, attempt)).code).toBe('validation');
    expect(snapshot(env)).toBe(before);
    expect(auditCount(env)).toBe(auditsBefore);
    expect(events).toEqual([]);
  });

  it('KILLS: a failure after the writes started rolls back the stages, the deals, the qualification replacement, and emits nothing', () => {
    withEnv((iso) => {
      const seen: DomainEvent[] = [];
      iso.bus.subscribe((event) => seen.push(event));
      const board = mk('Rollback', 'startup-fundraising', iso);
      createOpportunity(iso.ctx, { name: 'Rollback deal', pipelineId: board.id, stageId: board.stages[2]!.id });
      const before = snapshot(iso);
      seen.length = 0;
      let made = 0;
      const failing = {
        ...iso.ctx,
        newId: ((prefix: Parameters<typeof iso.ctx.newId>[0]) => {
          if (prefix === 'stg') {
            made += 1;
            if (made === 4) throw new Error('boom');
          }
          return iso.ctx.newId(prefix);
        }) as typeof iso.ctx.newId,
      };
      expect(() =>
        switchTemplate(failing, {
          pipelineId: board.id,
          template: 'client-sales',
          stageMapping: identityMapping(board, 'client-sales'),
          replaceQualification: true,
          expectedVersion: board.version,
        }),
      ).toThrow('boom');
      expect(snapshot(iso)).toBe(before);
      expect(seen).toEqual([]);
    });
  });

  it('KILLS: ids from another workspace are not found for delete, rename, switch, create, and the list filter', async () => {
    const otherWorkspace = insertSecondWorkspace(env.db);
    env.db
      .prepare('INSERT INTO pipeline (id, created_at, workspace_id, version, name, template) VALUES (?, ?, ?, 1, ?, ?)')
      .run('pip_foreign000', '2026-03-02T00:00:00.000Z', otherWorkspace, 'Foreign', 'startup-fundraising');
    env.db.prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, 1)').run('stg_foreign000', '2026-03-02T00:00:00.000Z', 'pip_foreign000', 'Research');
    expect(rejected(() => deletePipeline(env.ctx, 'pip_foreign000')).code).toBe('not_found');
    expect(rejected(() => updatePipeline(env.ctx, 'pip_foreign000', { expectedVersion: 1, fields: { name: 'Mine now' } })).code).toBe('not_found');
    expect(
      rejected(() =>
        switchTemplate(env.ctx, { pipelineId: 'pip_foreign000', template: 'fund-lp', stageMapping: {}, replaceQualification: false, expectedVersion: 1 }),
      ).code,
    ).toBe('not_found');
    expect(rejected(() => createOpportunity(env.ctx, { name: 'Smuggled', stageId: 'stg_foreign000' })).code).toBe('not_found');
    expect(rejected(() => createOpportunity(env.ctx, { name: 'Smuggled', pipelineId: 'pip_foreign000' })).code).toBe('not_found');
    expect((await call('GET', '/api/opportunities?pipelineId=pip_foreign000')).body!.items).toEqual([]);
    expect(env.db.prepare('SELECT name, version FROM pipeline WHERE id = ?').get('pip_foreign000')).toEqual({ name: 'Foreign', version: 1 });
    expect(countOf(env, 'SELECT COUNT(*) AS n FROM stage WHERE pipeline_id = ?', 'pip_foreign000')).toBe(1);
  });
});

describe('delete integrity', () => {
  it('KILLS: a deal in any status (open, passed, lost, nurture) blocks the delete, with the count in singular and plural', () => {
    const board = mk('Status board');
    const deal = createOpportunity(env.ctx, { name: 'Status deal', pipelineId: board.id });
    expect(rejected(() => deletePipeline(env.ctx, board.id)).message).toContain('1 deal.');
    let version = deal.version;
    for (const status of ['passed', 'lost', 'nurture'] as const) {
      version = updateOpportunity(env.ctx, deal.id, { expectedVersion: version, fields: { status, reason: `why ${status}` } }).version;
      const error = rejected(() => deletePipeline(env.ctx, board.id));
      expect(error.code).toBe('conflict');
      expect(error.status).toBe(409);
      expect(error.message).toContain('1 deal.');
    }
    for (const status of ['open', 'passed', 'lost']) createOpportunity(env.ctx, { name: `More ${status}`, pipelineId: board.id, status, ...(status === 'open' ? {} : { reason: 'r' }) });
    expect(rejected(() => deletePipeline(env.ctx, board.id)).message).toContain('4 deals.');
    expect(listPipelines(env.db, env.workspaceId).some((pipeline) => pipeline.id === board.id)).toBe(true);
  });

  it('KILLS: delete then create and create then delete both end consistent (not found, or conflict), never an orphan deal', () => {
    const gone = mk('Race gone');
    deletePipeline(env.ctx, gone.id);
    expect(rejected(() => createOpportunity(env.ctx, { name: 'Late by pipeline', pipelineId: gone.id })).code).toBe('not_found');
    expect(rejected(() => createOpportunity(env.ctx, { name: 'Late by stage', stageId: gone.stages[0]!.id })).code).toBe('not_found');
    const kept = mk('Race kept');
    createOpportunity(env.ctx, { name: 'Early', pipelineId: kept.id });
    expect(rejected(() => deletePipeline(env.ctx, kept.id)).code).toBe('conflict');
    expect(env.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(countOf(env, "SELECT COUNT(*) AS n FROM opportunity WHERE name LIKE 'Late%'")).toBe(0);
  });

  it('KILLS: two connections deleting the only two pipelines cannot leave the workspace with none', () => {
    withEnv((iso) => {
      const first = listPipelines(iso.db, iso.workspaceId)[0]!;
      const second = mk('Second', 'client-sales', iso);
      const otherConnection = openDatabase(iso.databasePath);
      try {
        const otherCtx = createContext(otherConnection, iso.workspaceId, { now: iso.ctx.now });
        deletePipeline(iso.ctx, first.id);
        const error = rejected(() => deletePipeline(otherCtx, second.id));
        expect(error.code).toBe('validation');
        expect(error.message).toMatch(/only pipeline/);
      } finally {
        otherConnection.close();
      }
      expect(listPipelines(iso.db, iso.workspaceId).map((pipeline) => pipeline.id)).toEqual([second.id]);
    });
  });

  it('KILLS: foreign keys are enforced, so a raw delete of a stage a deal sits in, or of a pipeline that has stages, is refused by the database', () => {
    expect(env.db.pragma('foreign_keys', { simple: true })).toBe(1);
    const board = mk('FK board');
    const deal = createOpportunity(env.ctx, { name: 'FK deal', pipelineId: board.id });
    expect(() => env.db.prepare('DELETE FROM stage WHERE id = ?').run(deal.stageId)).toThrow(/FOREIGN KEY/);
    expect(() => env.db.prepare('DELETE FROM pipeline WHERE id = ?').run(board.id)).toThrow(/FOREIGN KEY/);
  });

  it('KILLS: a deleted pipeline leaves no stage, stage history, or activity row pointing at it; the audit trail keeps the record', () => {
    const board = mk('Ghost board', 'fund-lp');
    const stageIds = board.stages.map((stage) => stage.id);
    deletePipeline(env.ctx, board.id);
    const marks = stageIds.map(() => '?').join(',');
    expect(countOf(env, `SELECT COUNT(*) AS n FROM stage_event WHERE to_stage_id IN (${marks}) OR from_stage_id IN (${marks})`, ...stageIds, ...stageIds)).toBe(0);
    expect(countOf(env, `SELECT COUNT(*) AS n FROM opportunity WHERE stage_id IN (${marks})`, ...stageIds)).toBe(0);
    expect(env.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(env.db.prepare("SELECT action FROM audit_event WHERE entity_id = ? ORDER BY created_at, id").all(board.id)).toEqual([
      { action: 'pipeline.create' },
      { action: 'pipeline.delete' },
    ]);
  });

  it('KILLS: the 409 names the count and says plainly that deals cannot be moved or deleted in this version, with no impossible advice', async () => {
    // The amended contract: a documented limit, never advice that cannot be followed. The routes below still refuse both ways out.
    const a = mk('Stuck A');
    const b = mk('Stuck B');
    const deal = createOpportunity(env.ctx, { name: 'Stuck deal', pipelineId: a.id });
    const refusal = rejected(() => deletePipeline(env.ctx, a.id));
    expect(refusal.message).toContain('1 deal');
    expect(refusal.message).toContain('cannot be moved to another pipeline or deleted in this version');
    expect(refusal.message).not.toContain('Move or delete them first');
    expect((await call('DELETE', `/api/opportunities/${deal.id}`)).status).toBe(404);
    expect((await call('POST', `/api/opportunities/${deal.id}/stage`, { stageId: b.stages[0]!.id, expectedVersion: deal.version })).status).toBe(400);
    expect((await call('PATCH', `/api/opportunities/${deal.id}`, { expectedVersion: deal.version, fields: { pipelineId: b.id } })).status).toBe(400);
  });
});

describe('template switch', () => {
  it('KILLS: the refusal names every unmapped stage that holds a deal with its count, counting passed and lost deals too', () => {
    const board = mk('Unmapped');
    createOpportunity(env.ctx, { name: 'U1', pipelineId: board.id, stageId: board.stages[0]!.id });
    createOpportunity(env.ctx, { name: 'U2', pipelineId: board.id, stageId: board.stages[0]!.id, status: 'passed', reason: 'no' });
    createOpportunity(env.ctx, { name: 'U3', pipelineId: board.id, stageId: board.stages[4]!.id, status: 'lost', reason: 'no' });
    const error = rejected(() =>
      switchTemplate(env.ctx, {
        pipelineId: board.id,
        template: 'client-sales',
        stageMapping: { [board.stages[1]!.id]: 'Qualified' },
        replaceQualification: false,
        expectedVersion: board.version,
      }),
    );
    expect(error.code).toBe('validation');
    expect(error.message).toContain('Research (2)');
    expect(error.message).toContain('Diligence (1)');
    expect(error.message).not.toContain('Qualified (');
    expect(one(env, board.id)).toEqual(board);
  });

  it('KILLS: target stage names are exact (case sensitive) but the template id and stage name are trimmed; mapping to a stage of a different template is refused', () => {
    const board = mk('Names');
    const stageMapping = { [board.stages[0]!.id]: 'research' };
    const base = { pipelineId: board.id, template: 'client-sales', replaceQualification: false, expectedVersion: board.version };
    expect(rejected(() => switchTemplate(env.ctx, { ...base, stageMapping })).message).toMatch(/not a stage of the Client sales template/);
    expect(rejected(() => switchTemplate(env.ctx, { ...base, stageMapping: { [board.stages[0]!.id]: 'Introduction or outreach' } })).code).toBe('validation');
    const done = switchTemplate(env.ctx, { ...base, template: ' client-sales ', stageMapping: { [' ' + board.stages[0]!.id + ' ']: ' Research ' } });
    expect(done.template).toBe('client-sales');
  });

  it('ACCEPTED: two old stages may map to the same new stage; deals merge, moved counts key by old stage name, history follows each mapping', () => {
    const board = mk('Merge');
    const d1 = createOpportunity(env.ctx, { name: 'Merge 1', pipelineId: board.id, stageId: board.stages[0]!.id });
    const d2 = createOpportunity(env.ctx, { name: 'Merge 2', pipelineId: board.id, stageId: board.stages[1]!.id });
    const switched = switchTemplate(env.ctx, {
      pipelineId: board.id,
      template: 'client-sales',
      stageMapping: { [board.stages[0]!.id]: 'Research', [board.stages[1]!.id]: 'Research' },
      replaceQualification: false,
      expectedVersion: board.version,
    });
    const research = switched.stages.find((stage) => stage.name === 'Research')!;
    for (const deal of [d1, d2]) {
      expect(env.db.prepare('SELECT stage_id FROM opportunity WHERE id = ?').get(deal.id)).toEqual({ stage_id: research.id });
    }
    const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'workspace.template_change' AND entity_id = ?").get(board.id) as { detail: string };
    expect(JSON.parse(audit.detail).moved).toEqual({ Research: 1, Qualified: 1 });
    expect(env.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('ACCEPTED: history of removed empty stages is dropped and counted, but the follow up rows that merely lose their from stage are nulled, not counted, so the creation event can vanish', () => {
    const board = mk('History');
    const deal = createOpportunity(env.ctx, { name: 'History deal', pipelineId: board.id });
    const moved1 = moveOpportunityStage(env.ctx, deal.id, { stageId: board.stages[1]!.id, expectedVersion: deal.version });
    moveOpportunityStage(env.ctx, deal.id, { stageId: board.stages[3]!.id, expectedVersion: moved1.version });
    expect(countOf(env, 'SELECT COUNT(*) AS n FROM stage_event WHERE opportunity_id = ?', deal.id)).toBe(3);
    const switched = switchTemplate(env.ctx, {
      pipelineId: board.id,
      template: 'client-sales',
      stageMapping: { [board.stages[3]!.id]: 'Discovery' },
      replaceQualification: false,
      expectedVersion: board.version,
    });
    const discovery = switched.stages.find((stage) => stage.name === 'Discovery')!;
    // Two rows pointed only at removed stages and are gone. The third (Qualified to Meeting) lost its from stage.
    expect(env.db.prepare('SELECT from_stage_id, to_stage_id FROM stage_event WHERE opportunity_id = ?').all(deal.id)).toEqual([
      { from_stage_id: null, to_stage_id: discovery.id },
    ]);
    const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'workspace.template_change' AND entity_id = ?").get(board.id) as { detail: string };
    expect(JSON.parse(audit.detail).stageEventsDropped).toBe(2);
    expect(env.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('KILLS: the audit event and the record events have the documented shape, are about the pipeline, and name no workspace record', () => {
    const board = mk('Shape');
    const d1 = createOpportunity(env.ctx, { name: 'Shape 1', pipelineId: board.id, stageId: board.stages[0]!.id });
    const d2 = createOpportunity(env.ctx, { name: 'Shape 2', pipelineId: board.id, stageId: board.stages[0]!.id });
    events.length = 0;
    switchTemplate(env.ctx, {
      pipelineId: board.id,
      template: 'fund-lp',
      stageMapping: { [board.stages[0]!.id]: 'Research' },
      replaceQualification: true,
      expectedVersion: board.version,
    });
    const audit = env.db.prepare("SELECT entity_type, entity_id, detail FROM audit_event WHERE action = 'workspace.template_change' AND entity_id = ?").get(board.id) as {
      entity_type: string;
      entity_id: string;
      detail: string;
    };
    expect(audit.entity_type).toBe('pipeline');
    expect(JSON.parse(audit.detail)).toEqual({
      pipelineId: board.id,
      from: 'startup-fundraising',
      to: 'fund-lp',
      moved: { Research: 2 },
      replacedQualification: true,
    });
    const recordEvents = events.filter((event) => event.type === 'record_updated');
    expect(recordEvents.filter((event) => event.entityType === 'pipeline')).toEqual([{ type: 'record_updated', entityType: 'pipeline', entityId: board.id }]);
    expect(recordEvents.filter((event) => event.entityType === 'opportunity').map((event) => event.entityId).sort()).toEqual([d1.id, d2.id].sort());
    expect(recordEvents.some((event) => event.entityType === 'workspace')).toBe(false);
    const activities = env.db.prepare("SELECT actor, kind, body FROM activity WHERE entity_id IN (?, ?) AND kind = 'stage_change'").all(d1.id, d2.id) as { actor: string; kind: string; body: string }[];
    expect(activities.map((activity) => activity.actor)).toEqual(['system:template', 'system:template']);
    expect(activities[0]!.body).toBe('Moved from Research to Research.');
  });

  it('KILLS: replaceQualification false leaves a saved config byte for byte; true replaces it; both are workspace wide, so a switch of one pipeline changes the rules every pipeline uses (ACCEPTED, documented)', () => {
    withEnv((iso) => {
      const custom = {
        exclusions: [],
        criteria: [{ id: 'crit-keep', label: 'Tagged keeper', target: 'person', field: 'tags', operator: 'contains', values: ['keeper'], enabled: true }],
      };
      saveQualificationConfig(iso.ctx, custom);
      const keeper = mk('Keep rules', 'startup-fundraising', iso);
      const bystander = mk('Bystander', 'fund-lp', iso);
      const settingsBefore = (iso.db.prepare('SELECT settings FROM workspace').get() as { settings: string }).settings;
      switchTemplate(iso.ctx, { pipelineId: keeper.id, template: 'client-sales', stageMapping: {}, replaceQualification: false, expectedVersion: keeper.version });
      expect((iso.db.prepare('SELECT settings FROM workspace').get() as { settings: string }).settings).toBe(settingsBefore);
      const now = one(iso, keeper.id);
      switchTemplate(iso.ctx, { pipelineId: now.id, template: 'startup-fundraising', stageMapping: {}, replaceQualification: true, expectedVersion: now.version });
      expect(readQualificationConfig(iso.db, iso.workspaceId)).toEqual(getTemplate('startup-fundraising')!.defaultQualificationConfig());
      // The bystander pipeline still says fund-lp but its qualification rules are now the startup defaults.
      expect(one(iso, bystander.id).template).toBe('fund-lp');
    });
  });

  it('ACCEPTED: with no saved config, replaceQualification false saves the rules actually in force (workspace.template, frozen), not the switched pipeline\'s old template defaults the doc names', () => {
    // Doc: "the old template's defaults are saved first". For a fund-lp pipeline in a startup workspace the rules in force are
    // the startup ones, so the code keeps them (rules do not silently change). Minimal doc fix: say "the rules in force".
    withEnv((iso) => {
      const lp = mk('LP board', 'fund-lp', iso);
      const inForce = readQualificationConfig(iso.db, iso.workspaceId);
      expect(inForce.defaulted).toBe(true);
      switchTemplate(iso.ctx, { pipelineId: lp.id, template: 'client-sales', stageMapping: {}, replaceQualification: false, expectedVersion: lp.version });
      const saved = readQualificationConfig(iso.db, iso.workspaceId);
      expect(saved.defaulted).toBeUndefined();
      expect(saved).toEqual(getTemplate('startup-fundraising')!.defaultQualificationConfig());
      expect(saved).not.toEqual(getTemplate('fund-lp')!.defaultQualificationConfig());
    });
  });

  it('KILLS: version discipline, a rename invalidates a stale switch and a switch invalidates a stale rename, each 409 carrying the current pipeline', async () => {
    const board = mk('Versions');
    const renamed = updatePipeline(env.ctx, board.id, { expectedVersion: 1, fields: { name: 'Versions renamed' } });
    const stale = await call('POST', '/api/workspace/template', { pipelineId: board.id, template: 'client-sales', stageMapping: {}, replaceQualification: false, expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body!.error.code).toBe('version_conflict');
    expect(stale.body!.error.current).toMatchObject({ id: board.id, name: 'Versions renamed', version: 2, template: 'startup-fundraising' });
    expect(one(env, board.id)).toEqual(renamed);

    const ok = await call('POST', '/api/workspace/template', { pipelineId: board.id, template: 'client-sales', stageMapping: {}, replaceQualification: false, expectedVersion: 2 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: board.id, name: 'Versions renamed', version: 3, template: 'client-sales' });
    const lateRename = await call('PATCH', `/api/pipelines/${board.id}`, { expectedVersion: 2, fields: { name: 'Too late' } });
    expect(lateRename.status).toBe(409);
    expect(lateRename.body!.error.current).toMatchObject({ version: 3, template: 'client-sales' });
    expect(one(env, board.id).name).toBe('Versions renamed');
  });

  it('KILLS: a switch and a rename from two connections serialise; the loser gets version_conflict and nothing half applied', () => {
    withEnv((iso) => {
      const board = mk('Two conns', 'startup-fundraising', iso);
      const other = openDatabase(iso.databasePath);
      try {
        const otherCtx = createContext(other, iso.workspaceId, { now: iso.ctx.now });
        switchTemplate(iso.ctx, { pipelineId: board.id, template: 'fund-lp', stageMapping: {}, replaceQualification: false, expectedVersion: 1 });
        expect(rejected(() => updatePipeline(otherCtx, board.id, { expectedVersion: 1, fields: { name: 'Loser' } })).code).toBe('version_conflict');
        updatePipeline(otherCtx, board.id, { expectedVersion: 2, fields: { name: 'Winner' } });
        expect(rejected(() => switchTemplate(iso.ctx, { pipelineId: board.id, template: 'client-sales', stageMapping: {}, replaceQualification: false, expectedVersion: 2 })).code).toBe('version_conflict');
      } finally {
        other.close();
      }
      expect(one(iso, board.id)).toMatchObject({ name: 'Winner', template: 'fund-lp', version: 3 });
    });
  });

  it('KILLS: a switch on a pipeline deleted mid flight is not found and writes nothing, not even the qualification replacement or orphan stages', () => {
    withEnv((iso) => {
      const doomed = mk('Doomed', 'startup-fundraising', iso);
      deletePipeline(iso.ctx, doomed.id);
      const before = snapshot(iso);
      const stagesBefore = countOf(iso, 'SELECT COUNT(*) AS n FROM stage');
      expect(
        rejected(() =>
          switchTemplate(iso.ctx, { pipelineId: doomed.id, template: 'client-sales', stageMapping: {}, replaceQualification: true, expectedVersion: doomed.version }),
        ).code,
      ).toBe('not_found');
      expect(snapshot(iso)).toBe(before);
      expect(countOf(iso, 'SELECT COUNT(*) AS n FROM stage')).toBe(stagesBefore);
    });
  });

  it('KILLS: the HTTP body is strict, a missing pipelineId, extra keys, a bad version, and a __proto__ mapping key are all 400', async () => {
    const board = mk('Strict');
    const good = { pipelineId: board.id, template: 'client-sales', stageMapping: {}, replaceQualification: false, expectedVersion: board.version };
    const { pipelineId: _omit, ...withoutPipeline } = good;
    for (const body of [
      withoutPipeline,
      { ...good, workspaceId: 'x' },
      { ...good, expectedVersion: 0 },
      { ...good, expectedVersion: 1.5 },
      { ...good, expectedVersion: '1' },
      { ...good, replaceQualification: 'yes' },
      { ...good, stageMapping: [] },
    ]) {
      expect((await call('POST', '/api/workspace/template', body)).status).toBe(400);
    }
    const poisoned = await app.inject({
      method: 'POST',
      url: '/api/workspace/template',
      headers: { host: 'localhost:5173', 'content-type': 'application/json' },
      payload: `{"pipelineId":"${board.id}","template":"client-sales","stageMapping":{"__proto__":"Research"},"replaceQualification":false,"expectedVersion":${board.version}}`,
    });
    expect(poisoned.statusCode).toBe(400);
    expect(one(env, board.id)).toEqual(board);
  });

  it('KILLS: GET /api/templates lost current and lists exactly the five documented keys; GET /api/pipelines carries template and version', async () => {
    const list = await call('GET', '/api/templates');
    expect(list.status).toBe(200);
    for (const item of list.body!.items) expect(Object.keys(item).sort()).toEqual(['description', 'id', 'name', 'pipelineName', 'stageNames']);
    const pipelines = await call('GET', '/api/pipelines');
    expect(pipelines.body!.nextCursor).toBeNull();
    for (const item of pipelines.body!.items) expect(typeof item.version).toBe('number');
  });

  it('KILLS: GET /api/workspace returns { id, name, version } only, so no stale template field can go out of date when a pipeline is switched', async () => {
    // The amended contract drops `template` from the workspace route; each pipeline carries its own.
    withEnv((iso) => {
      const only = listPipelines(iso.db, iso.workspaceId)[0]!;
      switchTemplate(iso.ctx, { pipelineId: only.id, template: 'client-sales', stageMapping: {}, replaceQualification: false, expectedVersion: only.version });
      expect(one(iso, only.id).template).toBe('client-sales');
      expect((iso.db.prepare('SELECT template FROM workspace').get() as { template: string }).template).toBe('startup-fundraising');
    });
    const only = listPipelines(env.db, env.workspaceId)[0]!;
    const before = (await call('GET', '/api/workspace')).body!;
    switchTemplate(env.ctx, { pipelineId: only.id, template: 'fund-lp', stageMapping: identityMapping(only, 'fund-lp'), replaceQualification: false, expectedVersion: only.version });
    const after = (await call('GET', '/api/workspace')).body!;
    expect(Object.keys(before).sort()).toEqual(['id', 'name', 'version']);
    expect(Object.keys(after).sort()).toEqual(['id', 'name', 'version']);
    expect(one(env, only.id).template).toBe('fund-lp');
  });
});

describe('create', () => {
  it('ACCEPTED: names are checked only for trim and length, so an invisible only name, markup, a newline, a NUL, and duplicates are stored verbatim', () => {
    const invisible = mk('​​');
    expect(invisible.name).toBe('​​');
    const markup = mk('<img src=x onerror=alert(1)>');
    expect(markup.name).toBe('<img src=x onerror=alert(1)>');
    expect(mk('Line one\nLine two').name).toBe('Line one\nLine two');
    expect(mk('bidi ‮evil').name).toBe('bidi ‮evil');
    const nul = mk('before\u0000after');
    expect(one(env, nul.id).name).toBe('before\u0000after');
    const twin1 = mk('Twin');
    const twin2 = mk('Twin');
    expect(twin1.id).not.toBe(twin2.id);
    expect(mk(' 　 Padded  ').name).toBe('Padded');
    expect(rejected(() => createPipeline(env.ctx, { name: ' 　﻿ ', template: 'fund-lp' })).code).toBe('validation');
  });

  it('ACCEPTED: the 200 limit counts UTF-16 units, so 100 emoji fit and 101 do not; 200 plain characters fit and 201 do not', () => {
    expect(mk('x'.repeat(200)).name).toHaveLength(200);
    expect(rejected(() => createPipeline(env.ctx, { name: 'x'.repeat(201), template: 'fund-lp' })).code).toBe('validation');
    expect(mk('\u{1F600}'.repeat(100)).name.length).toBe(200);
    expect(rejected(() => createPipeline(env.ctx, { name: '\u{1F600}'.repeat(101), template: 'fund-lp' })).code).toBe('validation');
  });

  it('KILLS: the template id is trimmed to the canonical id but is otherwise exact; prototype property names are not templates', async () => {
    expect(mk('Trim tpl', ' fund-lp ').template).toBe('fund-lp');
    for (const template of ['FUND-LP', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', ' ', 'x'.repeat(65)]) {
      expect(rejected(() => createPipeline(env.ctx, { name: 'Bad tpl', template })).code).toBe('validation');
    }
    expect((await call('POST', '/api/pipelines', { name: 'Bad', template: ['fund-lp'] })).status).toBe(400);
    expect((await call('POST', '/api/pipelines', { name: 'Bad', template: 'fund-lp', version: 9 })).status).toBe(400);
    expect((await call('POST', '/api/pipelines', { name: 'Bad' })).status).toBe(400);
    expect(countOf(env, "SELECT COUNT(*) AS n FROM pipeline WHERE name = 'Bad tpl' OR name = 'Bad'")).toBe(0);
  });

  it('ACCEPTED: there is no cap on the number of pipelines and GET /api/pipelines does not page, so the list grows without bound', async () => {
    withEnv((iso) => {
      for (let index = 0; index < 120; index += 1) mk(`Pile ${index}`, 'client-sales', iso);
      expect(listPipelines(iso.db, iso.workspaceId)).toHaveLength(121);
    });
    const before = listPipelines(env.db, env.workspaceId).length;
    for (let index = 0; index < 60; index += 1) expect((await call('POST', '/api/pipelines', { name: `HTTP pile ${index}`, template: 'client-sales' })).status).toBe(201);
    const listed = await call('GET', '/api/pipelines');
    expect(listed.body!.items.length).toBe(before + 60);
    expect(listed.body!.nextCursor).toBeNull();
  });
});

describe('who can write pipelines', () => {
  it('KILLS: a state changing request with a foreign web Origin (or the null origin) is refused for every pipeline write, and nothing changes', async () => {
    const board = mk('Origin board');
    const before = snapshot(env);
    for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'null']) {
      const headers = { origin };
      expect((await call('POST', '/api/pipelines', { name: 'Evil', template: 'fund-lp' }, headers)).status).toBe(403);
      expect((await call('PATCH', `/api/pipelines/${board.id}`, { expectedVersion: 1, fields: { name: 'Evil' } }, headers)).status).toBe(403);
      expect((await call('DELETE', `/api/pipelines/${board.id}`, undefined, headers)).status).toBe(403);
      expect((await call('POST', '/api/workspace/template', { pipelineId: board.id, template: 'fund-lp', stageMapping: {}, replaceQualification: true, expectedVersion: 1 }, headers)).status).toBe(403);
    }
    expect((await call('POST', '/api/pipelines', { name: 'Evil', template: 'fund-lp' }, { host: 'evil.example' })).status).toBe(403);
    expect(snapshot(env)).toBe(before);
    expect((await call('POST', '/api/pipelines', { name: 'Same origin', template: 'fund-lp' }, { origin: 'http://localhost:5173' })).status).toBe(201);
  });

  it('KILLS: the agent proposal path cannot name a pipeline or stage entity, and cannot smuggle pipelineId or stageId into a deal', () => {
    const board = mk('Agent board');
    const other = mk('Agent other');
    const deal = createOpportunity(env.ctx, { name: 'Agent deal', pipelineId: board.id });
    const before = snapshot(env);
    for (const entityType of ['pipeline', 'stage']) {
      try {
        const proposal = proposeChanges(env.ctx, { changes: [{ entityType, id: board.id, expectedVersion: 1, fields: { name: 'Hijack' } }] });
        expect(proposal.valid).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
      }
      expect(
        rejected(() => applyChanges(env.ctx, { proposalHash: 'a'.repeat(64), changes: [{ entityType, id: board.id, expectedVersion: 1, fields: { name: 'Hijack' } }] })).code,
      ).toBe('validation');
    }
    const proposal = proposeChanges(env.ctx, { changes: [{ entityType: 'opportunity', id: deal.id, expectedVersion: deal.version, fields: { stageId: other.stages[0]!.id, pipelineId: other.id } }] });
    expect(proposal.valid).toBe(false);
    expect(snapshot(env)).toBe(before);
  });

  it('KILLS: through the real MCP server there is no tool that writes a pipeline or template, and crm_describe exposes pipelines with exactly id, name, template, stageNames and no workspace template', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), 'mcp'],
      cwd: packageRoot,
      env: { ...(process.env as Record<string, string>), AGENTCRM_DB: env.databasePath },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'pipeline-review-probe', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).join(' ')).not.toMatch(/pipeline|template|stage/i);
      const described = JSON.parse(String(((await client.callTool({ name: 'crm_describe', arguments: {} })).content as { text: string }[])[0]!.text));
      expect(Object.keys(described.workspace).sort()).toEqual(['id', 'name']);
      expect(described.pipelines.length).toBeGreaterThan(1);
      for (const pipeline of described.pipelines) expect(Object.keys(pipeline).sort()).toEqual(['id', 'name', 'stageNames', 'template']);
      expect(JSON.stringify(described)).not.toMatch(/workspaceId|"version"/);
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe('seed with several pipelines', () => {
  it('KILLS: seeding puts every demo deal in the first pipeline, even after it was switched, and leaves the other pipelines and their versions alone', () => {
    withEnv((iso) => {
      const first = listPipelines(iso.db, iso.workspaceId)[0]!;
      const second = mk('Seed second', 'fund-lp', iso);
      const third = mk('Seed third', 'client-sales', iso);
      switchTemplate(iso.ctx, { pipelineId: first.id, template: 'client-sales', stageMapping: {}, replaceQualification: false, expectedVersion: first.version });
      const beforeOthers = JSON.stringify([one(iso, second.id), one(iso, third.id)]);
      seedDatabase(iso.db, { now: new Date('2026-03-01T12:00:00.000Z') });
      const spread = iso.db.prepare('SELECT pipeline_id, COUNT(*) AS n FROM opportunity GROUP BY pipeline_id').all();
      expect(spread).toEqual([{ pipeline_id: first.id, n: 25 }]);
      expect(JSON.stringify([one(iso, second.id), one(iso, third.id)])).toBe(beforeOthers);
      expect(iso.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
  });
});

describe('migration 022 on existing data', () => {
  function oldDatabase() {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-pipeline-review-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const file of readdirSync(migrationsDirectory).filter((name) => /^\d+_.+\.sql$/.test(name) && name < '022').sort()) {
      db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
    }
    return { db, directory };
  }

  it('KILLS: the backfill follows each pipeline\'s own workspace, carries an unknown or empty template id through, keeps deals and history, and a second run is a no-op', () => {
    const { db, directory } = oldDatabase();
    try {
      const addWorkspace = (id: string, template: string) => db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run(id, '2026-01-01', id, template);
      const addPipeline = (id: string, workspace: string, name: string) => db.prepare('INSERT INTO pipeline (id, created_at, workspace_id, name) VALUES (?, ?, ?, ?)').run(id, '2026-01-01', workspace, name);
      addWorkspace('wsp_a', 'fund-lp');
      addWorkspace('wsp_b', 'client-sales');
      addWorkspace('wsp_c', 'retired-template');
      addWorkspace('wsp_d', '');
      addPipeline('pip_a1', 'wsp_a', 'A one');
      addPipeline('pip_a2', 'wsp_a', 'A two');
      addPipeline('pip_b', 'wsp_b', 'B');
      addPipeline('pip_c', 'wsp_c', 'C');
      addPipeline('pip_d', 'wsp_d', 'D');
      db.prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, 1)').run('stg_a1', '2026-01-01', 'pip_a1', 'Research');
      db.prepare(
        `INSERT INTO opportunity (id, created_at, workspace_id, version, name, pipeline_id, stage_id, currency, status, stage_changed_at, updated_at)
         VALUES ('opp_1', '2026-01-01', 'wsp_a', 4, 'Old deal', 'pip_a1', 'stg_a1', 'USD', 'open', '2026-01-01', '2026-01-01')`,
      ).run();
      db.prepare("INSERT INTO stage_event (id, created_at, opportunity_id, from_stage_id, to_stage_id, at, actor) VALUES ('evt_1', '2026-01-01', 'opp_1', NULL, 'stg_a1', '2026-01-01', 'user')").run();

      expect(applyMigrations(db)).toEqual(['022_pipelines.sql', '023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql']);
      const rows = db.prepare('SELECT id, version, template FROM pipeline ORDER BY id').all();
      expect(rows).toEqual([
        { id: 'pip_a1', version: 1, template: 'fund-lp' },
        { id: 'pip_a2', version: 1, template: 'fund-lp' },
        { id: 'pip_b', version: 1, template: 'client-sales' },
        { id: 'pip_c', version: 1, template: 'retired-template' },
        { id: 'pip_d', version: 1, template: '' },
      ]);
      expect(db.prepare("SELECT version, stage_id FROM opportunity WHERE id = 'opp_1'").get()).toEqual({ version: 4, stage_id: 'stg_a1' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM stage_event').get()).toEqual({ n: 1 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(applyMigrations(db)).toEqual([]);

      // House pattern (011 does the same): the SQL itself is not idempotent, the migrations table is what makes it run once.
      expect(() => db.exec(readFileSync(path.join(migrationsDirectory, '022_pipelines.sql'), 'utf8'))).toThrow(/duplicate column/);
      expect(() => db.exec(readFileSync(path.join(migrationsDirectory, '011_workspace_version.sql'), 'utf8'))).toThrow(/duplicate column/);

      // A pipeline whose template this build does not know can still be switched to a registry template.
      const ctx = createContext(db, 'wsp_c');
      const legacy = listPipelines(db, 'wsp_c')[0]!;
      expect(legacy.template).toBe('retired-template');
      expect(switchTemplate(ctx, { pipelineId: 'pip_c', template: 'fund-lp', stageMapping: {}, replaceQualification: false, expectedVersion: legacy.version })).toMatchObject({
        template: 'fund-lp',
        version: 2,
        name: 'C',
      });
      // The qualification fallback for an unknown workspace template is the startup defaults.
      expect(readQualificationConfig(db, 'wsp_c')).toBeTruthy();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('KILLS: a pipeline whose workspace row is missing (foreign keys off) still gets the startup template instead of an empty one', () => {
    const { db, directory } = oldDatabase();
    try {
      db.pragma('foreign_keys = OFF');
      db.prepare('INSERT INTO pipeline (id, created_at, workspace_id, name) VALUES (?, ?, ?, ?)').run('pip_orphan', '2026-01-01', 'wsp_missing', 'Orphan');
      applyMigrations(db);
      expect(db.prepare('SELECT template FROM pipeline WHERE id = ?').get('pip_orphan')).toEqual({ template: 'startup-fundraising' });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
