import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyChanges,
  createAutomation,
  createContext,
  createOpportunity,
  createPerson,
  createPipeline,
  deleteAutomation,
  deletePipeline,
  moveOpportunityStage,
  proposeChanges,
  switchTemplate,
  updateAutomation,
  updateOpportunity,
  withActor,
} from '../src/actions/index.js';
import { promotePersonIn } from '../src/actions/lifecycle.js';
import { mutate } from '../src/actions/context.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { packageRoot } from '../src/paths.js';
import { getAutomation, listAutomations } from '../src/queries/automations.js';
import { listPipelines } from '../src/queries/pipelines.js';
import { createTestEnvironment } from './helpers.js';

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

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, headers: host, ...(payload !== undefined ? { payload: payload as object } : {}) });
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

const pipelines = () => listPipelines(env.db, env.workspaceId);
const mainPipeline = () => pipelines()[0]!;
const stageNamed = (pipeline: ReturnType<typeof mainPipeline>, name: string) => pipeline.stages.find((stage) => stage.name === name)!;
const audits = (action: string) =>
  (env.db.prepare('SELECT entity_id, actor, detail FROM audit_event WHERE action = ? ORDER BY created_at, id').all(action) as {
    entity_id: string;
    actor: string;
    detail: string;
  }[]).map((row) => ({ entityId: row.entity_id, actor: row.actor, detail: JSON.parse(row.detail) as Record<string, any> }));
const tasks = () =>
  env.db.prepare('SELECT * FROM task ORDER BY created_at, id').all() as {
    id: string; title: string; entity_type: string | null; entity_id: string | null; due_at: string | null; status: string;
  }[];
const tasksFor = (entityId: string) => tasks().filter((task) => task.entity_id === entityId);
const day = 24 * 60 * 60 * 1000;

function stageRule(stageName: string, overrides: Record<string, unknown> = {}) {
  const pipeline = mainPipeline();
  return createAutomation(env.ctx, {
    name: `Rule for ${stageName}`,
    triggerKind: 'stage_entered',
    triggerConfig: { pipelineId: pipeline.id, stageId: stageNamed(pipeline, stageName).id },
    actionConfig: { taskTitle: 'Prepare for {name}', dueInDays: 2 },
    ...overrides,
  });
}
const promotionRule = (overrides: Record<string, unknown> = {}) =>
  createAutomation(env.ctx, {
    name: 'Welcome a relationship',
    triggerKind: 'person_promoted',
    triggerConfig: {},
    actionConfig: { taskTitle: 'Say hello to {name}', dueInDays: 0 },
    ...overrides,
  });
const disableAll = () => {
  for (const automation of listAutomations(env.db, env.workspaceId)) {
    if (automation.enabled) updateAutomation(env.ctx, automation.id, { expectedVersion: automation.version, fields: { enabled: false } });
  }
};

describe('create and validate', () => {
  it('creates both kinds, defaults enabled, and audits', () => {
    const stage = stageRule('Diligence');
    expect(stage).toMatchObject({
      name: 'Rule for Diligence',
      triggerKind: 'stage_entered',
      enabled: true,
      disabledReason: null,
      firedCount: 0,
      version: 1,
      actionConfig: { taskTitle: 'Prepare for {name}', dueInDays: 2 },
    });
    const promoted = promotionRule({ enabled: false });
    expect(promoted).toMatchObject({ triggerKind: 'person_promoted', triggerConfig: {}, enabled: false });
    expect(audits('automation.create').map((entry) => entry.entityId)).toEqual([stage.id, promoted.id]);
    expect(events.some((event) => event.type === 'record_updated' && event.entityType === 'automation' && event.entityId === stage.id)).toBe(true);
    expect(stage.id.startsWith('aut_')).toBe(true);
    disableAll();
  });

  it('refuses bad names, kinds, trigger configs, and action configs', () => {
    const pipeline = mainPipeline();
    const stage = pipeline.stages[1]!;
    const base = {
      name: 'x',
      triggerKind: 'stage_entered',
      triggerConfig: { pipelineId: pipeline.id, stageId: stage.id },
      actionConfig: { taskTitle: 'T', dueInDays: 1 },
    };
    expect(rejected(() => createAutomation(env.ctx, { ...base, name: '  ' })).code).toBe('validation');
    expect(rejected(() => createAutomation(env.ctx, { ...base, name: 'n'.repeat(201) })).code).toBe('validation');
    expect(rejected(() => createAutomation(env.ctx, { ...base, triggerKind: 'task_done' })).code).toBe('validation');
    expect(rejected(() => createAutomation(env.ctx, { ...base, triggerConfig: {} })).code).toBe('validation');
    expect(rejected(() => createAutomation(env.ctx, { ...base, triggerConfig: { pipelineId: pipeline.id } })).code).toBe('validation');
    expect(rejected(() => createAutomation(env.ctx, { ...base, triggerConfig: { pipelineId: 'pip_nope', stageId: stage.id } })).message).toContain('pipeline does not exist');
    expect(rejected(() => createAutomation(env.ctx, { ...base, triggerConfig: { pipelineId: pipeline.id, stageId: 'stg_nope' } })).message).toContain('stage does not exist');
    expect(rejected(() => createAutomation(env.ctx, { ...base, triggerKind: 'person_promoted', triggerConfig: { pipelineId: pipeline.id } })).code).toBe('validation');
    for (const actionConfig of [
      { taskTitle: '', dueInDays: 1 },
      { taskTitle: 'x'.repeat(201), dueInDays: 1 },
      { taskTitle: 'T', dueInDays: -1 },
      { taskTitle: 'T', dueInDays: 366 },
      { taskTitle: 'T', dueInDays: 1.5 },
      { taskTitle: 'T', dueInDays: '2' },
      { taskTitle: 'T' },
      { taskTitle: 'T', dueInDays: 1, send: true },
    ]) {
      expect(rejected(() => createAutomation(env.ctx, { ...base, actionConfig })).code).toBe('validation');
    }
    expect(rejected(() => createAutomation(env.ctx, { ...base, extra: 1 })).code).toBe('validation');
    expect(listAutomations(env.db, env.workspaceId).filter((automation) => automation.name === 'x')).toHaveLength(0);
  });

  it('refuses a stage of another pipeline', () => {
    const other = createPipeline(env.ctx, { name: 'Second', template: 'client-sales' });
    const rejection = rejected(() =>
      createAutomation(env.ctx, {
        name: 'Mismatch',
        triggerKind: 'stage_entered',
        triggerConfig: { pipelineId: mainPipeline().id, stageId: other.stages[2]!.id },
        actionConfig: { taskTitle: 'T', dueInDays: 0 },
      }),
    );
    expect(rejection.message).toContain('does not belong');
  });

  it('accepts other brace tokens as plain text and boundary values', () => {
    const rule = stageRule('Qualified', { actionConfig: { taskTitle: 'Send {deck} to {name} {other}', dueInDays: 365 } });
    expect(rule.actionConfig.taskTitle).toBe('Send {deck} to {name} {other}');
    const zero = stageRule('Qualified', { actionConfig: { taskTitle: 'x'.repeat(200), dueInDays: 0 } });
    expect(zero.actionConfig.dueInDays).toBe(0);
    disableAll();
  });
});

describe('update and delete', () => {
  it('updates fields with versioning, keeps the trigger kind, and re-validates config', () => {
    const rule = promotionRule();
    const renamed = updateAutomation(env.ctx, rule.id, { expectedVersion: 1, fields: { name: 'Renamed', actionConfig: { taskTitle: 'Call {name}', dueInDays: 3 } } });
    expect(renamed).toMatchObject({ name: 'Renamed', version: 2, actionConfig: { taskTitle: 'Call {name}', dueInDays: 3 }, triggerKind: 'person_promoted' });
    expect(rejected(() => updateAutomation(env.ctx, rule.id, { expectedVersion: 1, fields: { name: 'Stale' } })).code).toBe('version_conflict');
    expect(rejected(() => updateAutomation(env.ctx, rule.id, { expectedVersion: 2, fields: { triggerKind: 'stage_entered' } })).code).toBe('validation');
    expect(rejected(() => updateAutomation(env.ctx, rule.id, { expectedVersion: 2, fields: {} })).code).toBe('validation');
    expect(rejected(() => updateAutomation(env.ctx, rule.id, { expectedVersion: 2, fields: { triggerConfig: { stageId: 'x', pipelineId: 'y' } } })).code).toBe('validation');
    expect(rejected(() => updateAutomation(env.ctx, rule.id, { expectedVersion: 2, fields: { actionConfig: { taskTitle: 'T', dueInDays: 999 } } })).code).toBe('validation');
    expect(rejected(() => updateAutomation(env.ctx, 'aut_missing', { expectedVersion: 1, fields: { name: 'n' } })).code).toBe('not_found');
    const toggled = updateAutomation(env.ctx, rule.id, { expectedVersion: 2, fields: { enabled: false } });
    expect(toggled).toMatchObject({ enabled: false, version: 3 });
    expect(audits('automation.update').filter((entry) => entry.entityId === rule.id)).toHaveLength(2);

    const stage = stageRule('Meeting');
    const pipeline = mainPipeline();
    expect(rejected(() => updateAutomation(env.ctx, stage.id, { expectedVersion: 1, fields: { triggerConfig: { pipelineId: pipeline.id, stageId: 'stg_nope' } } })).code).toBe('validation');
    const moved = updateAutomation(env.ctx, stage.id, {
      expectedVersion: 1,
      fields: { triggerConfig: { pipelineId: pipeline.id, stageId: stageNamed(pipeline, 'Commitment').id } },
    });
    expect(moved.triggerConfig.stageId).toBe(stageNamed(pipeline, 'Commitment').id);
    disableAll();
  });

  it('deletes the rule, leaves its tasks, and audits', () => {
    disableAll();
    const rule = promotionRule();
    const lead = createPerson(env.ctx, { firstName: 'Del', lastName: 'Eted' });
    mutate(env.ctx, (tx) => promotePersonIn(tx, lead.id, 'replied'));
    expect(tasksFor(lead.id)).toHaveLength(1);
    deleteAutomation(env.ctx, rule.id);
    expect(getAutomation(env.db, env.workspaceId, rule.id)).toBeNull();
    expect(tasksFor(lead.id)).toHaveLength(1);
    expect(audits('automation.delete').at(-1)).toMatchObject({ entityId: rule.id, detail: { firedCount: 1 } });
    expect(rejected(() => deleteAutomation(env.ctx, rule.id)).code).toBe('not_found');
  });
});

describe('stage entry firing', () => {
  it('fires on move, links the deal, substitutes the name, sets the due date, audits, and counts again on re-entry', () => {
    disableAll();
    const rule = stageRule('Diligence');
    const pipeline = mainPipeline();
    const deal = createOpportunity(env.ctx, { name: 'Acme seed round' });
    expect(tasksFor(deal.id)).toHaveLength(0);
    const before = Date.parse(env.ctx.now());
    const moved = moveOpportunityStage(env.ctx, deal.id, { stageId: stageNamed(pipeline, 'Diligence').id, expectedVersion: deal.version });
    const [task] = tasksFor(deal.id);
    expect(task).toMatchObject({ title: 'Prepare for Acme seed round', entity_type: 'opportunity', entity_id: deal.id, status: 'open' });
    const due = Date.parse(task!.due_at!);
    expect(due - before).toBeGreaterThanOrEqual(2 * day);
    expect(due - before).toBeLessThan(2 * day + 60_000);
    const fire = audits('automation.fire').at(-1)!;
    expect(fire.entityId).toBe(rule.id);
    expect(fire.detail).toMatchObject({ automationId: rule.id, taskId: task!.id, opportunityId: deal.id });
    expect(audits('task.create').some((entry) => entry.entityId === task!.id)).toBe(true);
    expect(events.some((event) => event.type === 'record_updated' && event.entityType === 'task' && event.entityId === task!.id)).toBe(true);
    expect(getAutomation(env.db, env.workspaceId, rule.id)!.firedCount).toBe(1);

    // Out and back in fires again.
    const out = moveOpportunityStage(env.ctx, deal.id, { stageId: stageNamed(pipeline, 'Meeting').id, expectedVersion: moved.version });
    moveOpportunityStage(env.ctx, deal.id, { stageId: stageNamed(pipeline, 'Diligence').id, expectedVersion: out.version });
    expect(tasksFor(deal.id)).toHaveLength(2);
    expect(getAutomation(env.db, env.workspaceId, rule.id)!.firedCount).toBe(2);
  });

  it('fires on create into the stage, one task per matching enabled rule, and never for other stages', () => {
    disableAll();
    const pipeline = mainPipeline();
    stageRule('Meeting');
    stageRule('Meeting', { name: 'Second meeting rule', actionConfig: { taskTitle: 'Agenda for {name}', dueInDays: 0 } });
    const off = stageRule('Meeting', { name: 'Off', enabled: false });
    stageRule('Closed');
    const deal = createOpportunity(env.ctx, { name: 'Created in meeting', stageId: stageNamed(pipeline, 'Meeting').id });
    expect(tasksFor(deal.id).map((task) => task.title).sort()).toEqual(['Agenda for Created in meeting', 'Prepare for Created in meeting']);
    expect(getAutomation(env.db, env.workspaceId, off.id)!.firedCount).toBe(0);
    const first = createOpportunity(env.ctx, { name: 'Created first stage' });
    expect(tasksFor(first.id)).toHaveLength(0);
    disableAll();
  });

  it('stores hostile names as plain task titles', () => {
    disableAll();
    const rule = stageRule('Qualified', { actionConfig: { taskTitle: '{name} then {name} $& $1 {other}', dueInDays: 1 } });
    const hostile = '<script>alert(1)</script> {name} $& \'; DROP TABLE task;--';
    const deal = createOpportunity(env.ctx, { name: hostile, stageId: stageNamed(mainPipeline(), 'Qualified').id });
    const [task] = tasksFor(deal.id);
    expect(task!.title).toBe(`${hostile} then ${hostile} $& $1 {other}`.slice(0, 300));
    expect(tasks().length).toBeGreaterThan(0);
    // A long name is bounded to the task title limit.
    const long = createOpportunity(env.ctx, { name: 'L'.repeat(200), stageId: stageNamed(mainPipeline(), 'Qualified').id });
    expect(tasksFor(long.id)[0]!.title.length).toBeLessThanOrEqual(300);
    deleteAutomation(env.ctx, rule.id);
  });

  it('does not fire when the move fails and rolls back with the transaction', () => {
    disableAll();
    const rule = stageRule('Commitment');
    const deal = createOpportunity(env.ctx, { name: 'Stale mover' });
    const stageId = stageNamed(mainPipeline(), 'Commitment').id;
    expect(rejected(() => moveOpportunityStage(env.ctx, deal.id, { stageId, expectedVersion: 99 })).code).toBe('version_conflict');
    expect(tasksFor(deal.id)).toHaveLength(0);
    expect(getAutomation(env.db, env.workspaceId, rule.id)!.firedCount).toBe(0);
    disableAll();
  });

  it('never fires from a disabled rule and a toggle takes effect immediately', () => {
    disableAll();
    const rule = stageRule('Meeting', { enabled: false });
    const pipeline = mainPipeline();
    const a = createOpportunity(env.ctx, { name: 'Disabled path', stageId: stageNamed(pipeline, 'Meeting').id });
    expect(tasksFor(a.id)).toHaveLength(0);
    updateAutomation(env.ctx, rule.id, { expectedVersion: 1, fields: { enabled: true } });
    const b = createOpportunity(env.ctx, { name: 'Enabled path', stageId: stageNamed(pipeline, 'Meeting').id });
    expect(tasksFor(b.id)).toHaveLength(1);
    disableAll();
  });
});

describe('promotion firing', () => {
  it('fires on the opportunity reason through a stage move and a re-point, and on the replied reason', () => {
    disableAll();
    const rule = promotionRule();
    const pipeline = mainPipeline();
    const viaMove = createPerson(env.ctx, { firstName: 'Via', lastName: 'Move' });
    const deal = createOpportunity(env.ctx, { name: 'Move deal', personId: viaMove.id });
    expect(tasksFor(viaMove.id)).toHaveLength(0);
    moveOpportunityStage(env.ctx, deal.id, { stageId: stageNamed(pipeline, 'Meeting').id, expectedVersion: deal.version });
    expect(tasksFor(viaMove.id).map((task) => [task.title, task.entity_type])).toEqual([['Say hello to Via Move', 'person']]);
    expect(tasksFor(viaMove.id)[0]!.due_at).not.toBeNull();

    const viaRepoint = createPerson(env.ctx, { firstName: 'Via', lastName: 'Repoint' });
    const lonely = createOpportunity(env.ctx, { name: 'Lonely deal', stageId: stageNamed(pipeline, 'Meeting').id });
    updateOpportunity(env.ctx, lonely.id, { expectedVersion: lonely.version, fields: { personId: viaRepoint.id } });
    expect(tasksFor(viaRepoint.id)).toHaveLength(1);

    const viaReply = createPerson(env.ctx, { firstName: 'Via', lastName: 'Reply' });
    mutate(env.ctx, (tx) => promotePersonIn(tx, viaReply.id, 'replied'));
    expect(tasksFor(viaReply.id)).toHaveLength(1);
    // A second signal on a relationship promotes nothing, so nothing fires again.
    mutate(env.ctx, (tx) => promotePersonIn(tx, viaReply.id, 'replied'));
    expect(tasksFor(viaReply.id)).toHaveLength(1);
    expect(getAutomation(env.db, env.workspaceId, rule.id)!.firedCount).toBe(3);
    expect(audits('automation.fire').at(-1)!.detail).toMatchObject({ automationId: rule.id, personId: viaReply.id });
    disableAll();
  });

  it('does not fire when disabled, for people created as relationships, or when the deal creation fails', () => {
    disableAll();
    const rule = promotionRule({ enabled: false });
    const person = createPerson(env.ctx, { firstName: 'Quiet', lastName: 'Lead' });
    mutate(env.ctx, (tx) => promotePersonIn(tx, person.id, 'replied'));
    expect(tasksFor(person.id)).toHaveLength(0);
    updateAutomation(env.ctx, rule.id, { expectedVersion: 1, fields: { enabled: true } });
    const direct = createPerson(env.ctx, { firstName: 'Born', lastName: 'Relationship', lifecycle: 'relationship' });
    expect(tasksFor(direct.id)).toHaveLength(0);
    expect(rejected(() => createOpportunity(env.ctx, { name: 'Bad', personId: 'per_missing', stageId: mainPipeline().stages[2]!.id })).code).toBe('not_found');
    disableAll();
  });
});

describe('template switch and deletions', () => {
  it('disables rules naming removed stages with a reason, fires nothing and creates no task for moved deals, and never blocks', () => {
    disableAll();
    const pipeline = createPipeline(env.ctx, { name: 'Switchable', template: 'startup-fundraising' });
    const diligence = pipeline.stages.find((stage) => stage.name === 'Diligence')!;
    const rule = createAutomation(env.ctx, {
      name: 'Diligence prep',
      triggerKind: 'stage_entered',
      triggerConfig: { pipelineId: pipeline.id, stageId: diligence.id },
      actionConfig: { taskTitle: 'Prep {name}', dueInDays: 1 },
    });
    const promoted = promotionRule();
    const dealA = createOpportunity(env.ctx, { name: 'Switch A', pipelineId: pipeline.id, stageId: diligence.id });
    const dealB = createOpportunity(env.ctx, { name: 'Switch B', pipelineId: pipeline.id, stageId: diligence.id });
    expect(tasksFor(dealA.id)).toHaveLength(1);
    const mapping = Object.fromEntries(pipeline.stages.map((stage) => [stage.id, stage.id === diligence.id ? 'Due diligence' : 'Research']));
    const switched = switchTemplate(env.ctx, {
      pipelineId: pipeline.id,
      template: 'fund-lp',
      stageMapping: mapping,
      replaceQualification: false,
      expectedVersion: pipeline.version,
    });
    expect(switched.template).toBe('fund-lp');
    const after = getAutomation(env.db, env.workspaceId, rule.id)!;
    expect(after.enabled).toBe(false);
    expect(after.disabledReason).toContain('Switchable');
    expect(after.disabledReason).toContain('removed');
    expect(audits('automation.disable').at(-1)).toMatchObject({ entityId: rule.id });
    // Contract (architecture.md Automations): a template switch fires nothing.
    expect(tasksFor(dealA.id)).toHaveLength(1);
    expect(tasksFor(dealB.id)).toHaveLength(1);
    // An unrelated person rule is untouched.
    expect(getAutomation(env.db, env.workspaceId, promoted.id)!.enabled).toBe(true);
    // Turning the dangling rule back on is refused with the reason; a fresh trigger config clears the note.
    const refused = rejected(() => updateAutomation(env.ctx, rule.id, { expectedVersion: after.version, fields: { enabled: true } }));
    expect(refused.code).toBe('validation');
    expect(refused.message).toContain('Switchable');
    const fixed = updateAutomation(env.ctx, rule.id, {
      expectedVersion: after.version,
      fields: { triggerConfig: { pipelineId: switched.id, stageId: switched.stages.find((stage) => stage.name === 'Due diligence')!.id }, enabled: true },
    });
    expect(fixed).toMatchObject({ enabled: true, disabledReason: null });
    disableAll();
  });

  it('deleting a pipeline disables rules that name it with a reason and the delete succeeds', () => {
    disableAll();
    const doomed = createPipeline(env.ctx, { name: 'Doomed pipeline', template: 'client-sales' });
    const rule = createAutomation(env.ctx, {
      name: 'Doomed rule',
      triggerKind: 'stage_entered',
      triggerConfig: { pipelineId: doomed.id, stageId: doomed.stages[3]!.id },
      actionConfig: { taskTitle: 'T {name}', dueInDays: 0 },
    });
    const bystander = stageRule('Meeting');
    deletePipeline(env.ctx, doomed.id);
    const after = getAutomation(env.db, env.workspaceId, rule.id)!;
    expect(after).toMatchObject({ enabled: false });
    expect(after.disabledReason).toContain('Doomed pipeline');
    expect(after.disabledReason).toContain('deleted');
    expect(getAutomation(env.db, env.workspaceId, bystander.id)!.enabled).toBe(true);
    // Renaming the disabled rule keeps the note; only an edit of the trigger or turning it on changes it.
    const renamed = updateAutomation(env.ctx, rule.id, { expectedVersion: after.version, fields: { name: 'Still doomed' } });
    expect(renamed.disabledReason).toBe(after.disabledReason);
    disableAll();
  });
});

describe('http', () => {
  it('serves the four endpoints with firedCount, immutable triggerKind, and a 204 delete', async () => {
    disableAll();
    const pipeline = mainPipeline();
    const stageId = stageNamed(pipeline, 'Meeting').id;
    const created = await call('POST', '/api/automations', {
      name: 'Http rule',
      triggerKind: 'stage_entered',
      triggerConfig: { pipelineId: pipeline.id, stageId },
      actionConfig: { taskTitle: 'Http {name}', dueInDays: 4 },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ enabled: true, firedCount: 0, version: 1 });
    const bad = await call('POST', '/api/automations', { name: 'x', triggerKind: 'stage_entered', triggerConfig: {}, actionConfig: { taskTitle: 'T', dueInDays: 0 } });
    expect(bad.status).toBe(400);

    createOpportunity(env.ctx, { name: 'Http deal', stageId });
    const listed = await call('GET', '/api/automations');
    expect(listed.status).toBe(200);
    expect(listed.body.items[0]).toMatchObject({ id: created.body.id, firedCount: 1 });
    expect(listed.body.nextCursor).toBeNull();
    const newest = listed.body.items.map((item: { createdAt: string }) => item.createdAt);
    expect([...newest].sort().reverse()).toEqual(newest);

    const kind = await call('PATCH', `/api/automations/${created.body.id}`, { expectedVersion: 1, fields: { triggerKind: 'person_promoted' } });
    expect(kind.status).toBe(400);
    const patched = await call('PATCH', `/api/automations/${created.body.id}`, { expectedVersion: 1, fields: { enabled: false } });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ enabled: false, version: 2, firedCount: 1 });
    expect((await call('PATCH', `/api/automations/${created.body.id}`, { expectedVersion: 1, fields: { enabled: true } })).status).toBe(409);

    const removed = await app.inject({ method: 'DELETE', url: `/api/automations/${created.body.id}`, headers: host });
    expect(removed.statusCode).toBe(204);
    expect((await call('DELETE', `/api/automations/${created.body.id}`)).status).toBe(404);
    expect(tasks().some((task) => task.title === 'Http Http deal')).toBe(true);
  });

  it('refuses a cross-site origin like other settings writes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/automations',
      headers: { host: '127.0.0.1:4720', origin: 'https://evil.example' },
      payload: { name: 'Evil', triggerKind: 'person_promoted', triggerConfig: {}, actionConfig: { taskTitle: 'T', dueInDays: 0 } },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(listAutomations(env.db, env.workspaceId).some((automation) => automation.name === 'Evil')).toBe(false);
  });
});

describe('agent surfaces stay closed', () => {
  it('has no automation entity type for proposals and no MCP or model facing mention', () => {
    const agent = withActor(env.ctx, 'agent:probe');
    const rule = promotionRule();
    for (const run of [
      () => proposeChanges(agent, { changes: [{ entityType: 'automation', id: rule.id, fields: { enabled: false } }] }),
      () => applyChanges(agent, { proposalHash: 'a'.repeat(64), changes: [{ entityType: 'automation', id: rule.id, expectedVersion: 1, fields: { enabled: false } }] }),
    ]) {
      expect(rejected(run).code).toBe('validation');
    }
    expect(getAutomation(env.db, env.workspaceId, rule.id)!.enabled).toBe(true);
    for (const file of ['src/mcp/server.ts', 'src/agent/modelChat.ts', 'src/agent/message.ts']) {
      expect(readFileSync(path.join(packageRoot, file), 'utf8').toLowerCase()).not.toContain('automation');
    }
    disableAll();
  });
});

describe('workspace isolation', () => {
  it('keeps rules, firing, and counts inside their workspace', () => {
    disableAll();
    const rule = stageRule('Meeting');
    const now = '2026-03-02T00:00:00.000Z';
    env.db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_other', now, 'Other', 'startup-fundraising');
    env.db.prepare('INSERT INTO pipeline (id, created_at, workspace_id, name, template) VALUES (?, ?, ?, ?, ?)').run('pip_other', now, 'wsp_other', 'Other pipeline', 'startup-fundraising');
    env.db.prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, ?)').run('stg_other1', now, 'pip_other', 'One', 1);
    env.db.prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, ?)').run('stg_other2', now, 'pip_other', 'Two', 2);
    const other = createContext(env.db, 'wsp_other', { now: env.ctx.now });
    // The other workspace cannot see, edit, or delete this workspace's rule or name its stages.
    expect(listAutomations(env.db, 'wsp_other')).toEqual([]);
    expect(rejected(() => updateAutomation(other, rule.id, { expectedVersion: 1, fields: { enabled: false } })).code).toBe('not_found');
    expect(rejected(() => deleteAutomation(other, rule.id)).code).toBe('not_found');
    expect(
      rejected(() =>
        createAutomation(other, {
          name: 'Cross',
          triggerKind: 'stage_entered',
          triggerConfig: { pipelineId: mainPipeline().id, stageId: mainPipeline().stages[2]!.id },
          actionConfig: { taskTitle: 'T', dueInDays: 0 },
        }),
      ).code,
    ).toBe('validation');
    // Its own deals fire only its own rules.
    const ownRule = createAutomation(other, {
      name: 'Other rule',
      triggerKind: 'stage_entered',
      triggerConfig: { pipelineId: 'pip_other', stageId: 'stg_other2' },
      actionConfig: { taskTitle: 'Other {name}', dueInDays: 0 },
    });
    createOpportunity(other, { name: 'Other deal', stageId: 'stg_other2' });
    expect(getAutomation(env.db, 'wsp_other', ownRule.id)!.firedCount).toBe(1);
    expect(getAutomation(env.db, env.workspaceId, rule.id)!.firedCount).toBe(0);
    expect(listAutomations(env.db, 'wsp_other')).toHaveLength(1);
    disableAll();
  });
});
