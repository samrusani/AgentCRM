import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext, switchTemplate } from '../src/actions/index.js';
import { AppError } from '../src/errors.js';
import { buildApp } from '../src/http/app.js';
import { readQualificationConfig } from '../src/qualification/config.js';
import { listPipelines } from '../src/queries/pipelines.js';
import { requireWorkspace } from '../src/queries/workspace.js';
import { seedDatabase } from '../src/seed/seed.js';
import { getTemplate, templates } from '../src/templates.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
// The seed replaces the workspace, so the context and the id are taken after it runs.
let ctx = env.ctx;
let workspaceId = env.workspaceId;

beforeAll(async () => {
  seedDatabase(env.db, { now: new Date('2026-03-01T12:00:00.000Z') });
  workspaceId = requireWorkspace(env.db).id;
  ctx = createContext(env.db, workspaceId, { bus: env.bus, now: env.ctx.now });
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

const stages = () => listPipelines(env.db, workspaceId)[0]!.stages;
const version = () => requireWorkspace(env.db).version;

// Maps every stage that holds opportunities (and every other stage too) by position onto the target template.
function positional(templateId: string): Record<string, string> {
  const target = getTemplate(templateId)!;
  return Object.fromEntries(stages().map((stage, index) => [stage.id, target.stageNames[index]!]));
}

function expectRejected(run: () => unknown, code: string, message: RegExp): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    expect((error as AppError).message).toMatch(message);
    return;
  }
  throw new Error('Expected the call to be rejected.');
}

describe('template registry', () => {
  it('ships the three templates with the contract stage lists', () => {
    expect(templates.map((template) => template.id)).toEqual(['startup-fundraising', 'fund-lp', 'client-sales']);
    expect(new Set(templates.map((template) => template.id)).size).toBe(3);
    expect(getTemplate('startup-fundraising')).toMatchObject({
      name: 'Startup fundraising',
      pipelineName: 'Fundraising',
      stageNames: ['Research', 'Qualified', 'Introduction or outreach', 'Meeting', 'Diligence', 'Commitment', 'Closed'],
    });
    expect(getTemplate('fund-lp')).toMatchObject({
      name: 'Fund LP fundraising',
      pipelineName: 'LP fundraising',
      stageNames: ['Research', 'Qualified', 'Introduction or outreach', 'Meeting', 'Due diligence', 'Soft commitment', 'Subscribed'],
    });
    expect(getTemplate('client-sales')).toMatchObject({
      name: 'Client sales',
      pipelineName: 'Sales',
      stageNames: ['Research', 'Qualified', 'Outreach', 'Discovery', 'Proposal', 'Negotiation', 'Closed'],
    });
    for (const template of templates) {
      expect(template.description.length).toBeGreaterThan(10);
      expect(new Set(template.stageNames).size).toBe(template.stageNames.length);
    }
  });

  it('gives every template a valid qualification config with the do not contact exclusion and unique ids', () => {
    const seen = new Set<string>();
    for (const template of templates) {
      const config = template.defaultQualificationConfig();
      expect(config.exclusions.map((entry) => entry.values)).toEqual([['do-not-contact']]);
      expect(config.criteria).toHaveLength(3);
      for (const criterion of [...config.exclusions, ...config.criteria]) {
        expect(seen.has(criterion.id)).toBe(false);
        seen.add(criterion.id);
      }
    }
    expect(getTemplate('fund-lp')!.defaultQualificationConfig().criteria[2]!.values).toEqual(['lp']);
    expect(getTemplate('client-sales')!.defaultQualificationConfig().criteria[2]!.values).toEqual(['prospect']);
  });
});

describe('switchTemplate', () => {
  it('moves opportunities by the mapping, writes activities and the audit event, and bumps the version', () => {
    const before = listPipelines(env.db, workspaceId)[0]!;
    const oldById = new Map(before.stages.map((stage) => [stage.id, stage.name]));
    const opportunities = env.db.prepare('SELECT id, stage_id, version FROM opportunity').all() as { id: string; stage_id: string; version: number }[];
    expect(opportunities.length).toBeGreaterThan(0);
    const mapping: Record<string, string> = {};
    const target = getTemplate('client-sales')!;
    for (const stage of before.stages) mapping[stage.id] = target.stageNames[stage.seq - 1]!;
    const expectedMoved: Record<string, number> = {};
    for (const opportunity of opportunities) {
      const name = oldById.get(opportunity.stage_id)!;
      expectedMoved[name] = (expectedMoved[name] ?? 0) + 1;
    }
    const startVersion = version();
    const activitiesBefore = Number((env.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'stage_change'").get() as { n: number }).n);

    const result = switchTemplate(ctx, { template: 'client-sales', stageMapping: mapping, replaceQualification: false, expectedVersion: startVersion });

    expect(result).toEqual({ id: workspaceId, name: 'Demo workspace', template: 'client-sales', version: startVersion + 1 });
    const after = listPipelines(env.db, workspaceId)[0]!;
    expect(after.id).toBe(before.id);
    expect(after.name).toBe('Sales');
    expect(after.stages.map((stage) => stage.name)).toEqual([...target.stageNames]);
    expect(after.stages.map((stage) => stage.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const newById = new Map(after.stages.map((stage) => [stage.id, stage.name]));
    for (const opportunity of opportunities) {
      const row = env.db.prepare('SELECT stage_id, version FROM opportunity WHERE id = ?').get(opportunity.id) as { stage_id: string; version: number };
      expect(newById.get(row.stage_id)).toBe(mapping[opportunity.stage_id]);
      expect(row.version).toBe(opportunity.version + 1);
    }
    const activities = env.db.prepare("SELECT body, actor FROM activity WHERE kind = 'stage_change' AND actor = 'system:template'").all() as { body: string; actor: string }[];
    expect(activities).toHaveLength(opportunities.length);
    expect(Number((env.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'stage_change'").get() as { n: number }).n)).toBe(activitiesBefore + opportunities.length);
    expect(activities[0]!.body).toMatch(/^Moved from .+ to .+\.$/);
    const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'workspace.template_change'").get() as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ from: 'startup-fundraising', to: 'client-sales', moved: expectedMoved });
    // No stage event points at a deleted stage.
    expect(env.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('keeps the qualification config when not asked to replace it, even when it was never saved', () => {
    // The seed saved the startup defaults. The config stayed as it was across the switch above.
    expect(readQualificationConfig(env.db, workspaceId).criteria.map((entry) => entry.id)).toEqual(
      getTemplate('startup-fundraising')!.defaultQualificationConfig().criteria.map((entry) => entry.id),
    );
  });

  it('replaces the qualification config when asked', () => {
    switchTemplate(ctx, { template: 'fund-lp', stageMapping: positional('fund-lp'), replaceQualification: true, expectedVersion: version() });
    const config = readQualificationConfig(env.db, workspaceId);
    expect(config.defaulted).toBeUndefined();
    expect({ exclusions: config.exclusions, criteria: config.criteria }).toEqual(getTemplate('fund-lp')!.defaultQualificationConfig());
    expect(requireWorkspace(env.db).template).toBe('fund-lp');
    expect(listPipelines(env.db, workspaceId)[0]!.name).toBe('LP fundraising');
  });

  it('switches back and forth', () => {
    const start = version();
    switchTemplate(ctx, { template: 'startup-fundraising', stageMapping: positional('startup-fundraising'), replaceQualification: false, expectedVersion: start });
    switchTemplate(ctx, { template: 'client-sales', stageMapping: positional('client-sales'), replaceQualification: false, expectedVersion: start + 1 });
    expect(version()).toBe(start + 2);
    expect(stages().map((stage) => stage.name)).toEqual([...getTemplate('client-sales')!.stageNames]);
    expect(Number((env.db.prepare('SELECT COUNT(*) AS n FROM stage').get() as { n: number }).n)).toBe(7);
    expect(env.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('lets a stage with no opportunities be omitted and keeps stage history pointing at real stages', () => {
    const current = stages();
    const emptied = current[6]!;
    const receiving = current[5]!;
    env.db.prepare('UPDATE opportunity SET stage_id = ? WHERE stage_id = ?').run(receiving.id, emptied.id);
    const someOpportunity = (env.db.prepare('SELECT id FROM opportunity LIMIT 1').get() as { id: string }).id;
    env.db
      .prepare('INSERT INTO stage_event (id, created_at, opportunity_id, from_stage_id, to_stage_id, at, actor) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('evt_history01', '2026-03-01T10:00:00.000Z', someOpportunity, receiving.id, emptied.id, '2026-03-01T10:00:00.000Z', 'user');
    const mapping = Object.fromEntries(current.filter((stage) => stage.id !== emptied.id).map((stage) => [stage.id, getTemplate('startup-fundraising')!.stageNames[stage.seq - 1]!]));
    const result = switchTemplate(ctx, { template: 'startup-fundraising', stageMapping: mapping, replaceQualification: false, expectedVersion: version() });
    expect(result.template).toBe('startup-fundraising');
    expect(stages().map((stage) => stage.name)).toEqual([...getTemplate('startup-fundraising')!.stageNames]);
    expect(env.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(env.db.prepare("SELECT 1 FROM stage_event WHERE id = 'evt_history01'").get()).toBeUndefined();
    const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'workspace.template_change' ORDER BY created_at DESC LIMIT 1").get() as { detail: string };
    expect(JSON.parse(audit.detail).stageEventsDropped).toBeGreaterThanOrEqual(1);
  });

  it('saves the old template defaults when nothing was saved and the config is meant to stay', () => {
    env.db.prepare('UPDATE workspace SET settings = NULL WHERE id = ?').run(workspaceId);
    expect(readQualificationConfig(env.db, workspaceId).defaulted).toBe(true);
    switchTemplate(ctx, { template: 'fund-lp', stageMapping: positional('fund-lp'), replaceQualification: false, expectedVersion: version() });
    const config = readQualificationConfig(env.db, workspaceId);
    expect(config.defaulted).toBeUndefined();
    expect(config.criteria.map((entry) => entry.id)).toEqual(getTemplate('startup-fundraising')!.defaultQualificationConfig().criteria.map((entry) => entry.id));
  });

  it('rejects an unknown template, the current template, bad targets, unmapped stages, and unknown stage ids', () => {
    const current = requireWorkspace(env.db);
    const base = { stageMapping: positional('client-sales'), replaceQualification: false, expectedVersion: current.version };
    expectRejected(() => switchTemplate(ctx, { ...base, template: 'nope' }), 'validation', /Unknown template "nope"/);
    expectRejected(() => switchTemplate(ctx, { ...base, template: current.template }), 'validation', new RegExp(`already uses the ${getTemplate(current.template)!.name} template`));
    const first = stages()[0]!;
    expectRejected(
      () => switchTemplate(ctx, { ...base, template: 'client-sales', stageMapping: { ...base.stageMapping, [first.id]: 'Diligence' } }),
      'validation',
      /"Diligence" is not a stage of the Client sales template/,
    );
    expectRejected(
      () => switchTemplate(ctx, { ...base, template: 'client-sales', stageMapping: { ...base.stageMapping, stg_missing: 'Research' } }),
      'validation',
      /Stage "stg_missing" is not a stage of this workspace/,
    );
    const holding = env.db.prepare('SELECT s.id, s.name FROM stage s JOIN opportunity o ON o.stage_id = s.id GROUP BY s.id LIMIT 1').get() as { id: string; name: string };
    const partial = { ...base.stageMapping };
    delete partial[holding.id];
    expectRejected(
      () => switchTemplate(ctx, { ...base, template: 'client-sales', stageMapping: partial }),
      'validation',
      new RegExp(`Not mapped: .*${holding.name}`),
    );
    expectRejected(() => switchTemplate(ctx, { ...base, template: 'client-sales', replaceQualification: 'yes' }), 'validation', /replaceQualification/);
    // Nothing changed.
    expect(requireWorkspace(env.db).version).toBe(current.version);
    expect(requireWorkspace(env.db).template).toBe(current.template);
  });

  it('rejects a stale version with version_conflict carrying the current workspace', () => {
    const current = requireWorkspace(env.db);
    try {
      switchTemplate(ctx, { template: 'client-sales', stageMapping: positional('client-sales'), replaceQualification: false, expectedVersion: current.version - 1 });
      throw new Error('Expected a conflict.');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('version_conflict');
      expect((error as AppError).status).toBe(409);
      expect((error as AppError).current).toEqual({ id: current.id, name: current.name, template: current.template, version: current.version });
    }
  });

  it('serves the routes', async () => {
    const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
      const response = await app.inject({ method, url, payload, headers: { host: 'localhost:5173' } });
      return { status: response.statusCode, body: response.json() };
    };
    const current = requireWorkspace(env.db);
    const list = await call('GET', '/api/templates');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(3);
    expect(Object.keys(list.body.items[0]).sort()).toEqual(['current', 'description', 'id', 'name', 'pipelineName', 'stageNames']);
    expect(list.body.items.filter((item: { current: boolean }) => item.current).map((item: { id: string }) => item.id)).toEqual([current.template]);

    expect((await call('GET', '/api/workspace')).body).toEqual({ id: current.id, name: current.name, template: current.template, version: current.version });

    const target = current.template === 'fund-lp' ? 'client-sales' : 'fund-lp';
    const stale = await call('POST', '/api/workspace/template', { template: target, stageMapping: positional(target), replaceQualification: false, expectedVersion: current.version + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'version_conflict', current: { id: current.id, template: current.template, version: current.version } });

    const bad = await call('POST', '/api/workspace/template', { template: target, stageMapping: {}, replaceQualification: false, expectedVersion: current.version });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation');
    expect(bad.body.error.message).toContain('Not mapped:');

    const ok = await call('POST', '/api/workspace/template', { template: target, stageMapping: positional(target), replaceQualification: true, expectedVersion: current.version });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id: current.id, name: current.name, template: target, version: current.version + 1 });
    expect((await call('GET', '/api/templates')).body.items.find((item: { current: boolean }) => item.current).id).toBe(target);
  });
});
