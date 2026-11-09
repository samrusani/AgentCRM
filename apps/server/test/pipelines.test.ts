import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyChanges,
  createOpportunity,
  createPipeline,
  deletePipeline,
  moveOpportunityStage,
  proposeChanges,
  switchTemplate,
  updatePipeline,
} from '../src/actions/index.js';
import { applyMigrations } from '../src/db.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { migrationsDirectory } from '../src/paths.js';
import { listPipelines } from '../src/queries/pipelines.js';
import { requireWorkspace } from '../src/queries/workspace.js';
import { getTemplate, templates } from '../src/templates.js';
import { createTestEnvironment } from './helpers.js';

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

const all = () => listPipelines(env.db, env.workspaceId);
const stageCount = (pipelineId: string) =>
  Number((env.db.prepare('SELECT COUNT(*) AS n FROM stage WHERE pipeline_id = ?').get(pipelineId) as { n: number }).n);
const auditsFor = (action: string) =>
  env.db.prepare('SELECT entity_type, entity_id, detail FROM audit_event WHERE action = ? ORDER BY created_at, id').all(action) as {
    entity_type: string;
    entity_id: string;
    detail: string;
  }[];

describe('migration 022', () => {
  it('adds the pipeline version and template and backfills the template from the workspace', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      const files = readdirSync(migrationsDirectory).filter((name) => /^\d+_.+\.sql$/.test(name) && name < '022').sort();
      expect(files.at(-1)).toBe('021_worker_lease.sql');
      for (const file of files) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'One', 'fund-lp');
      db.prepare('INSERT INTO pipeline (id, created_at, workspace_id, name) VALUES (?, ?, ?, ?)').run('pip_1', '2026-01-01', 'wsp_1', 'LP fundraising');

      expect(applyMigrations(db)).toEqual(['022_pipelines.sql', '023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql', '030_transcript.sql', '031_duplicates.sql', '032_organization_duplicates.sql', '033_meetings.sql', '034_search_widening.sql', '035_backblaze.sql']);
      expect(db.prepare('SELECT version, template FROM pipeline').get()).toEqual({ version: 1, template: 'fund-lp' });
      // The workspace column stays as it was.
      expect(db.prepare('SELECT template FROM workspace').get()).toEqual({ template: 'fund-lp' });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('gives a freshly bootstrapped pipeline its template and version 1', () => {
    expect(all()).toHaveLength(1);
    expect(all()[0]).toMatchObject({ template: 'startup-fundraising', version: 1 });
  });
});

describe('createPipeline', () => {
  it('seeds the template stages in order for each template, audits, and emits record_updated', () => {
    for (const template of templates) {
      events.length = 0;
      const name = `${template.name} board`;
      const created = createPipeline(env.ctx, { name, template: template.id });
      expect(created).toMatchObject({ name, template: template.id, version: 1, workspaceId: env.workspaceId });
      expect(created.stages.map((stage) => stage.name)).toEqual([...template.stageNames]);
      expect(created.stages.map((stage) => stage.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(new Set(created.stages.map((stage) => stage.pipelineId))).toEqual(new Set([created.id]));
      const audit = auditsFor('pipeline.create').at(-1)!;
      expect(audit).toMatchObject({ entity_type: 'pipeline', entity_id: created.id });
      expect(JSON.parse(audit.detail)).toEqual({ name, template: template.id });
      expect(events).toEqual([{ type: 'record_updated', entityType: 'pipeline', entityId: created.id }]);
    }
    expect(all()).toHaveLength(4);
    // Creation appends: the first pipeline stays first.
    expect(all()[0]!.template).toBe('startup-fundraising');
  });

  it('trims the name and refuses a blank name, an unknown template, and unknown fields', () => {
    expect(createPipeline(env.ctx, { name: '  Padded  ', template: 'client-sales' }).name).toBe('Padded');
    expect(rejected(() => createPipeline(env.ctx, { name: '   ', template: 'client-sales' })).code).toBe('validation');
    expect(rejected(() => createPipeline(env.ctx, { name: 'x'.repeat(201), template: 'client-sales' })).code).toBe('validation');
    expect(rejected(() => createPipeline(env.ctx, { name: 'Nope', template: 'nope' })).message).toMatch(/Unknown template "nope"/);
    expect(rejected(() => createPipeline(env.ctx, { name: 'Extra', template: 'client-sales', stages: [] })).code).toBe('validation');
    expect(all().some((pipeline) => pipeline.name === 'Nope' || pipeline.name === 'Extra')).toBe(false);
  });
});

describe('updatePipeline', () => {
  it('renames, bumps the version, audits, and refuses a stale version with the current pipeline', () => {
    const target = createPipeline(env.ctx, { name: 'US investor pipeline', template: 'startup-fundraising' });
    events.length = 0;
    const renamed = updatePipeline(env.ctx, target.id, { expectedVersion: 1, fields: { name: 'US investors' } });
    expect(renamed).toMatchObject({ id: target.id, name: 'US investors', version: 2, template: 'startup-fundraising' });
    expect(renamed.stages).toEqual(target.stages);
    expect(events).toEqual([{ type: 'record_updated', entityType: 'pipeline', entityId: target.id }]);
    const audit = auditsFor('pipeline.update').at(-1)!;
    expect(audit).toMatchObject({ entity_type: 'pipeline', entity_id: target.id });
    expect(JSON.parse(audit.detail)).toEqual({ from: 'US investor pipeline', to: 'US investors' });

    const conflict = rejected(() => updatePipeline(env.ctx, target.id, { expectedVersion: 1, fields: { name: 'Stale' } }));
    expect(conflict.code).toBe('version_conflict');
    expect(conflict.status).toBe(409);
    expect(conflict.current).toEqual(renamed);
    expect(all().find((pipeline) => pipeline.id === target.id)!.name).toBe('US investors');
  });

  it('refuses unknown fields, a blank name, and an unknown pipeline', () => {
    const [first] = all();
    expect(rejected(() => updatePipeline(env.ctx, first!.id, { expectedVersion: 1, fields: { template: 'fund-lp' } })).code).toBe('validation');
    expect(rejected(() => updatePipeline(env.ctx, first!.id, { expectedVersion: 1, fields: { name: ' ' } })).code).toBe('validation');
    expect(rejected(() => updatePipeline(env.ctx, 'pip_missing', { expectedVersion: 1, fields: { name: 'X' } })).code).toBe('not_found');
  });
});

describe('deletePipeline', () => {
  it('refuses while any opportunity names the pipeline and says how many', () => {
    const board = createPipeline(env.ctx, { name: 'Busy board', template: 'client-sales' });
    createOpportunity(env.ctx, { name: 'Deal one', pipelineId: board.id });
    const passed = createOpportunity(env.ctx, { name: 'Deal two', pipelineId: board.id, status: 'passed' });
    expect(passed.status).toBe('passed');
    const error = rejected(() => deletePipeline(env.ctx, board.id));
    expect(error.code).toBe('conflict');
    expect(error.status).toBe(409);
    expect(error.message).toContain('2 deals');
    expect(stageCount(board.id)).toBe(7);
    expect(all().some((pipeline) => pipeline.id === board.id)).toBe(true);
  });

  it('deletes an empty pipeline with its stages, audits, and emits record_updated', () => {
    const board = createPipeline(env.ctx, { name: 'Empty board', template: 'fund-lp' });
    const other = all().find((pipeline) => pipeline.id !== board.id)!;
    const otherStages = stageCount(other.id);
    events.length = 0;
    deletePipeline(env.ctx, board.id);
    expect(all().some((pipeline) => pipeline.id === board.id)).toBe(false);
    expect(stageCount(board.id)).toBe(0);
    expect(stageCount(other.id)).toBe(otherStages);
    const audit = auditsFor('pipeline.delete').at(-1)!;
    expect(audit).toMatchObject({ entity_type: 'pipeline', entity_id: board.id });
    expect(JSON.parse(audit.detail)).toEqual({ name: 'Empty board', template: 'fund-lp' });
    expect(events).toEqual([{ type: 'record_updated', entityType: 'pipeline', entityId: board.id }]);
    expect(rejected(() => deletePipeline(env.ctx, board.id)).code).toBe('not_found');
    expect(env.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('refuses to delete the last pipeline of the workspace', () => {
    const lone = createTestEnvironment();
    try {
      const only = listPipelines(lone.db, lone.workspaceId)[0]!;
      const error = rejected(() => deletePipeline(lone.ctx, only.id));
      expect(error.code).toBe('validation');
      expect(error.message).toMatch(/only pipeline/);
      expect(listPipelines(lone.db, lone.workspaceId)).toHaveLength(1);
    } finally {
      lone.cleanup();
    }
  });
});

describe('template switch per pipeline', () => {
  it('changes only the named pipeline: its stages, deals, template, name, and version', () => {
    const us = createPipeline(env.ctx, { name: 'Switch US', template: 'startup-fundraising' });
    const uk = createPipeline(env.ctx, { name: 'Switch UK', template: 'startup-fundraising' });
    const usDeal = createOpportunity(env.ctx, { name: 'US deal', stageId: us.stages[3]!.id });
    const ukDeal = createOpportunity(env.ctx, { name: 'UK deal', stageId: uk.stages[3]!.id });
    const workspaceBefore = requireWorkspace(env.db);
    const target = getTemplate('client-sales')!;

    const switched = switchTemplate(env.ctx, {
      pipelineId: uk.id,
      template: 'client-sales',
      stageMapping: Object.fromEntries(uk.stages.map((stage) => [stage.id, target.stageNames[stage.seq - 1]!])),
      replaceQualification: false,
      expectedVersion: uk.version,
    });

    // Contract change: the switch keeps the pipeline's own name instead of renaming it to the template's pipeline name.
    expect(switched).toMatchObject({ id: uk.id, name: 'Switch UK', template: 'client-sales', version: uk.version + 1 });
    expect(switched.stages.map((stage) => stage.name)).toEqual([...target.stageNames]);
    // The UK deal moved into the new Discovery stage of the UK pipeline.
    const ukRow = env.db.prepare('SELECT pipeline_id, stage_id FROM opportunity WHERE id = ?').get(ukDeal.id) as { pipeline_id: string; stage_id: string };
    expect(ukRow.pipeline_id).toBe(uk.id);
    expect(switched.stages.find((stage) => stage.id === ukRow.stage_id)!.name).toBe('Discovery');
    // The US pipeline is exactly as it was, deal included.
    const usAfter = all().find((pipeline) => pipeline.id === us.id)!;
    expect(usAfter).toEqual(us);
    const usRow = env.db.prepare('SELECT stage_id, version FROM opportunity WHERE id = ?').get(usDeal.id) as { stage_id: string; version: number };
    expect(usRow).toEqual({ stage_id: us.stages[3]!.id, version: usDeal.version });
    // The workspace row is not written: not its template, not its version.
    expect(requireWorkspace(env.db)).toEqual(workspaceBefore);
    const audit = auditsFor('workspace.template_change').at(-1)!;
    expect(JSON.parse(audit.detail)).toMatchObject({ pipelineId: uk.id, from: 'startup-fundraising', to: 'client-sales', moved: { Meeting: 1 } });
    expect(env.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('keeps the pipeline\'s own name, however the template names its pipeline', () => {
    const board = createPipeline(env.ctx, { name: 'My own name', template: 'startup-fundraising' });
    for (const template of ['client-sales', 'fund-lp']) {
      const current = all().find((pipeline) => pipeline.id === board.id)!;
      const switched = switchTemplate(env.ctx, { pipelineId: board.id, template, stageMapping: {}, replaceQualification: false, expectedVersion: current.version });
      expect(switched.name).toBe('My own name');
      expect(all().find((pipeline) => pipeline.id === board.id)!.name).toBe('My own name');
    }
  });

  it('takes the pipeline version as expectedVersion, not the workspace version', () => {
    const board = createPipeline(env.ctx, { name: 'Versioned', template: 'startup-fundraising' });
    updatePipeline(env.ctx, board.id, { expectedVersion: 1, fields: { name: 'Versioned again' } });
    const base = { pipelineId: board.id, template: 'fund-lp', stageMapping: {}, replaceQualification: false };
    // The workspace version (1) matches the first pipeline's version but not this pipeline's current version (2).
    expect(requireWorkspace(env.db).version).toBe(1);
    const error = rejected(() => switchTemplate(env.ctx, { ...base, expectedVersion: 1 }));
    expect(error.code).toBe('version_conflict');
    expect(error.current).toMatchObject({ id: board.id, version: 2 });
    expect(switchTemplate(env.ctx, { ...base, expectedVersion: 2 })).toMatchObject({ template: 'fund-lp', version: 3 });
  });

  it('refuses a stage of another pipeline in the mapping and a pipeline that does not exist', () => {
    const a = createPipeline(env.ctx, { name: 'Map A', template: 'startup-fundraising' });
    const b = createPipeline(env.ctx, { name: 'Map B', template: 'startup-fundraising' });
    const base = { template: 'client-sales', replaceQualification: false, expectedVersion: a.version };
    const foreign = rejected(() => switchTemplate(env.ctx, { ...base, pipelineId: a.id, stageMapping: { [b.stages[0]!.id]: 'Research' } }));
    expect(foreign.message).toMatch(/is not a stage of this pipeline/);
    expect(rejected(() => switchTemplate(env.ctx, { ...base, pipelineId: 'pip_missing', stageMapping: {} })).code).toBe('not_found');
    expect(stageCount(b.id)).toBe(7);
  });
});

describe('cross pipeline guards', () => {
  it('refuses to move a deal to a stage of another pipeline', () => {
    const a = createPipeline(env.ctx, { name: 'Guard A', template: 'startup-fundraising' });
    const b = createPipeline(env.ctx, { name: 'Guard B', template: 'startup-fundraising' });
    const deal = createOpportunity(env.ctx, { name: 'Guarded', pipelineId: a.id });
    const error = rejected(() => moveOpportunityStage(env.ctx, deal.id, { stageId: b.stages[2]!.id, expectedVersion: deal.version }));
    expect(error.code).toBe('validation');
    expect(error.message).toMatch(/different pipeline/);
    const row = env.db.prepare('SELECT pipeline_id, stage_id, version FROM opportunity WHERE id = ?').get(deal.id) as { pipeline_id: string; stage_id: string; version: number };
    expect(row).toEqual({ pipeline_id: a.id, stage_id: a.stages[0]!.id, version: deal.version });
    // A stage of its own pipeline still moves.
    expect(moveOpportunityStage(env.ctx, deal.id, { stageId: a.stages[2]!.id, expectedVersion: deal.version }).stageId).toBe(a.stages[2]!.id);
  });

  it('refuses to create a deal whose stage belongs to another pipeline than its pipelineId', () => {
    const a = createPipeline(env.ctx, { name: 'Create A', template: 'startup-fundraising' });
    const b = createPipeline(env.ctx, { name: 'Create B', template: 'startup-fundraising' });
    const before = Number((env.db.prepare('SELECT COUNT(*) AS n FROM opportunity').get() as { n: number }).n);
    const error = rejected(() => createOpportunity(env.ctx, { name: 'Mismatch', pipelineId: a.id, stageId: b.stages[1]!.id }));
    expect(error.code).toBe('validation');
    expect(error.message).toMatch(/does not belong to the pipeline/);
    expect(Number((env.db.prepare('SELECT COUNT(*) AS n FROM opportunity').get() as { n: number }).n)).toBe(before);
    // Matching ids work, a pipelineId alone lands in that pipeline's first stage, and a stageId alone implies its pipeline.
    expect(createOpportunity(env.ctx, { name: 'Match', pipelineId: b.id, stageId: b.stages[1]!.id })).toMatchObject({ pipelineId: b.id, stageId: b.stages[1]!.id });
    expect(createOpportunity(env.ctx, { name: 'First', pipelineId: b.id })).toMatchObject({ pipelineId: b.id, stageId: b.stages[0]!.id });
    expect(createOpportunity(env.ctx, { name: 'Implied', stageId: a.stages[1]!.id })).toMatchObject({ pipelineId: a.id });
  });

  it('refuses creating through the HTTP route with a mismatched stage', async () => {
    const a = createPipeline(env.ctx, { name: 'Http A', template: 'startup-fundraising' });
    const b = createPipeline(env.ctx, { name: 'Http B', template: 'startup-fundraising' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/opportunities',
      payload: { name: 'Over HTTP', pipelineId: a.id, stageId: b.stages[0]!.id },
      headers: { host: 'localhost:5173' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation');
  });

  it('keeps the agent proposal path from creating or re-pointing deals across pipelines', () => {
    // The proposal flow only edits existing records and the opportunity field set has no pipelineId or stageId, so a
    // proposal that tries to carry either one is invalid at propose time and refused at apply time.
    const a = createPipeline(env.ctx, { name: 'Proposal A', template: 'startup-fundraising' });
    const b = createPipeline(env.ctx, { name: 'Proposal B', template: 'startup-fundraising' });
    const deal = createOpportunity(env.ctx, { name: 'Proposed', pipelineId: a.id });
    for (const fields of [{ stageId: b.stages[0]!.id }, { pipelineId: b.id }]) {
      const proposal = proposeChanges(env.ctx, { changes: [{ entityType: 'opportunity', id: deal.id, expectedVersion: deal.version, fields }] });
      expect(proposal.valid).toBe(false);
      expect(proposal.changes[0]!.errors.join(' ')).toMatch(/Unrecognized key/);
      expect(
        rejected(() =>
          applyChanges(env.ctx, { proposalHash: proposal.proposalHash, changes: [{ entityType: 'opportunity', id: deal.id, expectedVersion: deal.version, fields }] }),
        ).code,
      ).toBe('validation');
    }
    expect(env.db.prepare('SELECT pipeline_id, stage_id FROM opportunity WHERE id = ?').get(deal.id)).toEqual({ pipeline_id: a.id, stage_id: a.stages[0]!.id });
  });
});

describe('pipeline routes', () => {
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
    const response = await app.inject({ method, url, payload, headers: { host: 'localhost:5173' } });
    return { status: response.statusCode, body: response.body ? response.json() : null };
  };

  it('lists pipelines with template and version and creates, renames, and deletes over HTTP', async () => {
    const list = await call('GET', '/api/pipelines');
    expect(list.status).toBe(200);
    expect(Object.keys(list.body.items[0]).sort()).toEqual(['id', 'name', 'stages', 'template', 'version', 'workspaceId']);

    const created = await call('POST', '/api/pipelines', { name: 'Route board', template: 'client-sales' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Route board', template: 'client-sales', version: 1 });
    expect(created.body.stages).toHaveLength(7);

    expect((await call('POST', '/api/pipelines', { name: '', template: 'client-sales' })).status).toBe(400);
    expect((await call('POST', '/api/pipelines', { name: 'Bad', template: 'nope' })).status).toBe(400);

    const renamed = await call('PATCH', `/api/pipelines/${created.body.id}`, { expectedVersion: 1, fields: { name: 'Route board 2' } });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Route board 2', version: 2 });
    const stale = await call('PATCH', `/api/pipelines/${created.body.id}`, { expectedVersion: 1, fields: { name: 'Nope' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'version_conflict', current: renamed.body });

    await call('POST', '/api/opportunities', { name: 'Route deal', pipelineId: created.body.id });
    const blocked = await call('DELETE', `/api/pipelines/${created.body.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('conflict');
    expect(blocked.body.error.message).toContain('1 deal');

    const empty = await call('POST', '/api/pipelines', { name: 'Route empty', template: 'fund-lp' });
    expect((await call('DELETE', `/api/pipelines/${empty.body.id}`)).status).toBe(204);
    expect((await call('DELETE', `/api/pipelines/${empty.body.id}`)).status).toBe(404);
  });
});
