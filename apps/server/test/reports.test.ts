import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { listPipelines } from '../src/queries/pipelines.js';
import { getReports, intakeSource, weekStartOf } from '../src/queries/reports.js';
import { createTestEnvironment, insertSecondWorkspace } from './helpers.js';

const env = createTestEnvironment();
const NOW = new Date('2026-06-15T12:00:00.000Z'); // a Monday
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
let app: FastifyInstance;
let seq = 0;
const id = (prefix: string) => `${prefix}_${String(++seq).padStart(6, '0')}`;

let main: ReturnType<typeof listPipelines>[number];
let other: ReturnType<typeof listPipelines>[number];
let otherWorkspace: string;

function addDeal(pipeline: typeof main, stageIndex: number, fields: { status?: string; amount?: number | null; currency?: string; updatedAt?: string; workspaceId?: string } = {}) {
  const dealId = id('opp');
  const stage = pipeline.stages[stageIndex]!;
  env.db
    .prepare(
      `INSERT INTO opportunity (id, created_at, workspace_id, name, pipeline_id, stage_id, amount_target, currency, status, stage_changed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      dealId,
      daysAgo(200),
      fields.workspaceId ?? env.workspaceId,
      `Deal ${dealId}`,
      pipeline.id,
      stage.id,
      fields.amount === undefined ? 1000 : fields.amount,
      fields.currency ?? 'USD',
      fields.status ?? 'open',
      daysAgo(200),
      fields.updatedAt ?? daysAgo(1),
    );
  return dealId;
}

function addEvent(dealId: string, toStage: string, at: string, fromStage: string | null = null) {
  env.db
    .prepare('INSERT INTO stage_event (id, created_at, opportunity_id, from_stage_id, to_stage_id, at, actor) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id('evt'), at, dealId, fromStage, toStage, at, 'user');
}

function addPerson(createdAt: string, tags: string[], workspaceId = env.workspaceId) {
  const personId = id('per');
  env.db
    .prepare('INSERT INTO person (id, created_at, workspace_id, first_name, tags, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(personId, createdAt, workspaceId, 'Pat', JSON.stringify(tags), createdAt);
  return personId;
}

function addIntent(personId: string, status: string, submittedAt: string | null, workspaceId = env.workspaceId) {
  env.db
    .prepare(
      `INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, submitted_at, updated_at)
       VALUES (?, ?, ?, ?, 'inb', 'a@example.com', 's', 'b', ?, ?, ?, ?)`,
    )
    .run(id('snd'), daysAgo(40), workspaceId, personId, id('hash'), status, submittedAt, daysAgo(1));
}

function addMessage(direction: 'in' | 'out', personId: string | null, at: string, workspaceId = env.workspaceId) {
  env.db
    .prepare(
      `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, direction, person_id, from_email, provider_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, 'a@example.com', ?)`,
    )
    .run(id('msg'), at, workspaceId, id('pm'), direction, personId, at);
}

function addSuppression(reason: string, at: string, workspaceId = env.workspaceId) {
  env.db
    .prepare('INSERT INTO suppression (id, created_at, workspace_id, email, reason) VALUES (?, ?, ?, ?, ?)')
    .run(id('sup'), at, workspaceId, `${id('x')}@example.com`, reason);
}

function addRun(kind: string, status: string, finishedAt: string | null, counts: unknown, workspaceId = env.workspaceId) {
  env.db
    .prepare('INSERT INTO run (id, created_at, workspace_id, kind, title, status, counts, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id('run'), daysAgo(100), workspaceId, kind, 'Run', status, typeof counts === 'string' ? counts : JSON.stringify(counts), finishedAt);
}

beforeAll(async () => {
  const pipelines = listPipelines(env.db, env.workspaceId);
  main = pipelines[0]!;
  env.db
    .prepare('INSERT INTO pipeline (id, created_at, workspace_id, name, version, template) VALUES (?, ?, ?, ?, 1, ?)')
    .run('pip_second', '2026-03-05T00:00:00.000Z', env.workspaceId, 'Second', 'client-sales');
  for (const [index, name] of ['Alpha', 'Beta'].entries()) {
    env.db
      .prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, ?)')
      .run(`stg_second_${index}`, '2026-03-05T00:00:00.000Z', 'pip_second', name, index + 1);
  }
  other = listPipelines(env.db, env.workspaceId).find((pipeline) => pipeline.id === 'pip_second')!;
  otherWorkspace = insertSecondWorkspace(env.db);
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: () => NOW.toISOString() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

describe('reports pipeline', () => {
  it('counts open deals now and closed deals inside the period, per stage', () => {
    addDeal(main, 0, { amount: 1000 });
    addDeal(main, 0, { amount: 500, currency: 'GBP' });
    addDeal(main, 1, { amount: null });
    addDeal(main, 1, { status: 'passed', amount: 200, updatedAt: daysAgo(10) });
    addDeal(main, 1, { status: 'passed', amount: 900, updatedAt: daysAgo(60) });
    addDeal(main, 2, { status: 'lost', amount: 300, updatedAt: daysAgo(10) });
    addDeal(main, 2, { status: 'nurture', amount: 999 });
    const ninety = getReports(env.db, env.workspaceId, 90, main.id, NOW).pipeline;
    expect(ninety.map((stage) => stage.stageId)).toEqual(main.stages.map((stage) => stage.id));
    expect(ninety[0]).toMatchObject({ openCount: 2, openAmounts: [{ currency: 'GBP', amount: 500 }, { currency: 'USD', amount: 1000 }] });
    expect(ninety[1]).toMatchObject({ openCount: 1, openAmounts: [], passedCount: 2, lostCount: 0 });
    expect(ninety[2]).toMatchObject({ openCount: 0, lostCount: 1, lostAmounts: [{ currency: 'USD', amount: 300 }] });
    const thirty = getReports(env.db, env.workspaceId, 30, main.id, NOW).pipeline;
    expect(thirty[1]).toMatchObject({ passedCount: 1, passedAmounts: [{ currency: 'USD', amount: 200 }] });
    const allTime = getReports(env.db, env.workspaceId, null, main.id, NOW).pipeline;
    expect(allTime[1]!.passedCount).toBe(2);
  });

  it('never leaks another pipeline or workspace into the chosen one', () => {
    addDeal(other, 0, { amount: 77777 });
    const before = JSON.stringify(getReports(env.db, env.workspaceId, 90, main.id, NOW).pipeline);
    expect(before).not.toContain('77777');
    const second = getReports(env.db, env.workspaceId, 90, other.id, NOW);
    expect(second.pipeline.map((stage) => stage.name)).toEqual(['Alpha', 'Beta']);
    expect(second.pipeline[0]).toMatchObject({ openCount: 1, openAmounts: [{ currency: 'USD', amount: 77777 }] });
    // Asking for the other workspace's pipeline id from this workspace finds nothing.
    env.db.prepare('INSERT INTO pipeline (id, created_at, workspace_id, name, version, template) VALUES (?, ?, ?, ?, 1, ?)').run('pip_foreign', '2026-03-05T00:00:00.000Z', otherWorkspace, 'Foreign', '');
    expect(getReports(env.db, env.workspaceId, 90, 'pip_foreign', NOW).pipeline).toEqual([]);
  });

  it('defaults to the first pipeline and answers empty pipeline sections for an unknown id', () => {
    expect(getReports(env.db, env.workspaceId, 90, null, NOW).pipeline.map((stage) => stage.stageId)).toEqual(
      main.stages.map((stage) => stage.id),
    );
    const unknown = getReports(env.db, env.workspaceId, 90, 'pip_missing', NOW);
    expect(unknown.pipeline).toEqual([]);
    expect(unknown.stageFlow).toEqual([]);
    expect(Object.keys(unknown).sort()).toEqual(['intake', 'outreach', 'pipeline', 'runs', 'stageFlow']);
  });
});

describe('reports stage flow', () => {
  it('counts creation as entering the first stage and counts re-entries again, inside the period only', () => {
    const [s0, s1, s2] = main.stages.map((stage) => stage.id) as [string, string, string];
    const deal = addDeal(main, 2);
    addEvent(deal, s0, daysAgo(20));
    addEvent(deal, s1, daysAgo(15), s0);
    addEvent(deal, s0, daysAgo(10), s1);
    addEvent(deal, s1, daysAgo(5), s0);
    addEvent(deal, s2, daysAgo(120), s1);
    const foreign = addDeal(other, 0);
    addEvent(foreign, other.stages[0]!.id, daysAgo(2));
    const flow = getReports(env.db, env.workspaceId, 90, main.id, NOW).stageFlow;
    const byId = Object.fromEntries(flow.map((row) => [row.stageId, row.entered]));
    expect(byId[s0]).toBe(2);
    expect(byId[s1]).toBe(2);
    expect(byId[s2]).toBe(0);
    const allTime = getReports(env.db, env.workspaceId, null, main.id, NOW).stageFlow;
    expect(allTime.find((row) => row.stageId === s2)!.entered).toBe(1);
    expect(flow.map((row) => row.name)).toEqual(main.stages.map((stage) => stage.name));
  });
});

describe('reports intake', () => {
  it('reads the source in precedence order and buckets by Monday UTC weeks', () => {
    expect(intakeSource(['captured', 'csv-import'])).toBe('csv');
    expect(intakeSource(['csv-import', 'linkedin-leads'])).toBe('linkedin');
    expect(intakeSource(['linkedin-leads', 'mailbox-import', 'captured'])).toBe('mailbox');
    expect(intakeSource(['transcript-import', 'csv-import'])).toBe('transcript');
    expect(intakeSource(['transcript-import', 'linkedin-leads'])).toBe('linkedin');
    expect(intakeSource(['captured', 'x'])).toBe('captured');
    expect(intakeSource(['CSV-IMPORT', 'vip'])).toBe('manual');
    expect(weekStartOf('2026-06-14T23:59:59.000Z')).toBe('2026-06-08');
    expect(weekStartOf('2026-06-15T00:00:00.000Z')).toBe('2026-06-15');
    expect(weekStartOf('2026-06-21T23:00:00.000Z')).toBe('2026-06-15');

    addPerson('2026-06-15T01:00:00.000Z', ['mailbox-import']);
    addPerson('2026-06-10T10:00:00.000Z', ['captured', 'csv-import']);
    addPerson('2026-06-09T10:00:00.000Z', []);
    addPerson('2026-06-08T10:00:00.000Z', ['linkedin-leads']);
    addPerson('2025-01-01T10:00:00.000Z', ['csv-import']);
    addPerson('2026-06-10T10:00:00.000Z', ['mailbox-import'], otherWorkspace);
    const weeks = getReports(env.db, env.workspaceId, 90, main.id, NOW).intake.weeks;
    expect(weeks).toEqual([
      { weekStart: '2026-06-08', total: 3, bySource: { mailbox: 0, linkedin: 1, transcript: 0, csv: 1, captured: 0, manual: 1 } },
      { weekStart: '2026-06-15', total: 1, bySource: { mailbox: 1, linkedin: 0, transcript: 0, csv: 0, captured: 0, manual: 0 } },
    ]);
    const allTime = getReports(env.db, env.workspaceId, null, main.id, NOW).intake.weeks;
    expect(allTime[0]!.weekStart).toBe('2024-12-30');
  });
});

describe('reports outreach', () => {
  it('counts sends, replies, bounces, and opt outs inside the period for this workspace', () => {
    const person = addPerson(daysAgo(300), []);
    addIntent(person, 'accepted', daysAgo(3));
    addIntent(person, 'replied', daysAgo(4));
    addIntent(person, 'bounced', daysAgo(5));
    addIntent(person, 'accepted', daysAgo(100));
    addIntent(person, 'failed', daysAgo(2));
    addIntent(person, 'awaiting_approval', null);
    addMessage('in', person, daysAgo(2));
    addMessage('in', person, daysAgo(200));
    addMessage('in', null, daysAgo(2));
    addMessage('out', person, daysAgo(2));
    addSuppression('bounce', daysAgo(5));
    addSuppression('bounce', daysAgo(95));
    addSuppression('opt_out', daysAgo(6));
    addSuppression('opt_out', daysAgo(7));
    addSuppression('manual', daysAgo(1));
    const foreignPerson = addPerson(daysAgo(300), [], otherWorkspace);
    addIntent(foreignPerson, 'accepted', daysAgo(1), otherWorkspace);
    addMessage('in', foreignPerson, daysAgo(1), otherWorkspace);
    addSuppression('opt_out', daysAgo(1), otherWorkspace);
    expect(getReports(env.db, env.workspaceId, 90, main.id, NOW).outreach).toEqual({ sends: 3, replies: 1, bounces: 1, optOuts: 2 });
    expect(getReports(env.db, env.workspaceId, 365, main.id, NOW).outreach).toEqual({ sends: 4, replies: 2, bounces: 2, optOuts: 2 });
    expect(getReports(env.db, otherWorkspace, 90, null, NOW).outreach).toEqual({ sends: 1, replies: 1, bounces: 0, optOuts: 1 });
  });
});

describe('reports runs', () => {
  it('buckets finished runs by kind and status and sums only reported estimates', () => {
    addRun('draft', 'succeeded', daysAgo(2), { processed: 1, found: 1, flagged: 0, estimatedUsd: 0.25 });
    addRun('draft', 'succeeded', daysAgo(3), { processed: 1, found: 1, flagged: 0, estimatedUsd: 0.5 });
    addRun('draft', 'failed', daysAgo(4), { processed: 0, found: 0, flagged: 0 });
    addRun('import', 'succeeded', daysAgo(5), 'not json');
    addRun('import', 'succeeded', daysAgo(5), { processed: 0, found: 0, flagged: 0, estimatedUsd: 'lots' });
    addRun('draft', 'succeeded', daysAgo(120), { processed: 1, found: 1, flagged: 0, estimatedUsd: 9 });
    addRun('draft', 'running', null, { processed: 0, found: 0, flagged: 0, estimatedUsd: 100 });
    addRun('draft', 'succeeded', daysAgo(1), { processed: 1, found: 1, flagged: 0, estimatedUsd: 77 }, otherWorkspace);
    const runs = getReports(env.db, env.workspaceId, 90, main.id, NOW).runs;
    expect(runs.groups).toEqual([
      { kind: 'draft', status: 'failed', count: 1 },
      { kind: 'draft', status: 'succeeded', count: 2 },
      { kind: 'import', status: 'succeeded', count: 2 },
    ]);
    expect(runs.estimatedUsd).toBe(0.75);
    expect(runs.runsWithEstimate).toBe(2);
    expect(getReports(env.db, env.workspaceId, null, main.id, NOW).runs.estimatedUsd).toBe(9.75);
  });
});

describe('GET /api/reports', () => {
  it('answers the five keys and validates days', async () => {
    const ok = await app.inject({ method: 'GET', url: `/api/reports?days=90&pipelineId=${main.id}` });
    expect(ok.statusCode).toBe(200);
    expect(Object.keys(ok.json()).sort()).toEqual(['intake', 'outreach', 'pipeline', 'runs', 'stageFlow']);
    expect((await app.inject({ method: 'GET', url: '/api/reports' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/reports?days=365' })).statusCode).toBe(200);
    for (const bad of ['days=7', 'days=abc', 'days=', 'days=90.5', 'days=0']) {
      expect((await app.inject({ method: 'GET', url: `/api/reports?${bad}` })).statusCode).toBe(400);
    }
    const unknown = await app.inject({ method: 'GET', url: '/api/reports?pipelineId=pip_nope' });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().pipeline).toEqual([]);
  });

  it('uses the app clock for the period', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/reports?days=30' });
    expect(response.json().outreach.sends).toBe(3);
  });
});
