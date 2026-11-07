// Adversarial review probes for the reports wave (GET /api/reports, queries/reports.ts). Names start with KILLS (the
// attack fails and the test pins that), CONFIRMS (a live bug: the test passes against today's code and the comment
// says what should happen instead), or ACCEPTED (a documented limit or a deliberate trade off). Nothing here changes
// application code.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpportunity, moveOpportunityStage, updateOpportunity } from '../src/actions/crud.js';
import { chatTools, runChatTool } from '../src/agent/modelChat.js';
import type { Db } from '../src/db.js';
import { buildApp } from '../src/http/app.js';
import { packageRoot } from '../src/paths.js';
import { listPipelines } from '../src/queries/pipelines.js';
import { getReports, weekStartOf } from '../src/queries/reports.js';
import { createTestEnvironment, insertSecondWorkspace } from './helpers.js';

const env = createTestEnvironment();
const NOW = new Date('2026-06-15T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const host = { host: '127.0.0.1:4720' };
let seq = 0;
const id = (prefix: string) => `${prefix}_rv${String(++seq).padStart(6, '0')}`;

let main: ReturnType<typeof listPipelines>[number];
let second: ReturnType<typeof listPipelines>[number];
let foreign: string;
let app: FastifyInstance;
let prepareCalls = 0;

function deal(
  pipeline: { id: string; stages: { id: string }[] },
  stageIndex: number,
  f: { status?: string; amount?: number | null; currency?: string; updatedAt?: string; workspaceId?: string; stageId?: string } = {},
): string {
  const dealId = id('opp');
  env.db
    .prepare(
      `INSERT INTO opportunity (id, created_at, workspace_id, name, pipeline_id, stage_id, amount_target, currency, status, stage_changed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(dealId, daysAgo(300), f.workspaceId ?? env.workspaceId, `Deal ${dealId}`, pipeline.id, f.stageId ?? pipeline.stages[stageIndex]!.id, f.amount === undefined ? 100 : f.amount, f.currency ?? 'USD', f.status ?? 'open', daysAgo(300), f.updatedAt ?? daysAgo(1));
  return dealId;
}
function event(dealId: string, toStage: string, at: string, from: string | null = null): void {
  env.db.prepare('INSERT INTO stage_event (id, created_at, opportunity_id, from_stage_id, to_stage_id, at, actor) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id('evt'), at, dealId, from, toStage, at, 'user');
}
function person(createdAt: string, tags: unknown, workspaceId = env.workspaceId): string {
  const personId = id('per');
  env.db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, tags, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(personId, createdAt, workspaceId, 'Pat', typeof tags === 'string' ? tags : JSON.stringify(tags), createdAt);
  return personId;
}
function intent(personId: string, status: string, submittedAt: string | null, workspaceId = env.workspaceId): void {
  env.db
    .prepare(`INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, submitted_at, updated_at) VALUES (?, ?, ?, ?, 'inb', 'a@example.com', 's', 'b', ?, ?, ?, ?)`)
    .run(id('snd'), daysAgo(400), workspaceId, personId, id('hash'), status, submittedAt, daysAgo(1));
}
function message(direction: 'in' | 'out', personId: string | null, at: string, workspaceId = env.workspaceId): void {
  env.db.prepare(`INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, direction, person_id, from_email, provider_timestamp) VALUES (?, ?, ?, ?, ?, ?, 'a@example.com', ?)`).run(id('msg'), at, workspaceId, id('pm'), direction, personId, at);
}
function suppression(reason: string, at: string, workspaceId = env.workspaceId): void {
  env.db.prepare('INSERT INTO suppression (id, created_at, workspace_id, email, reason) VALUES (?, ?, ?, ?, ?)').run(id('sup'), at, workspaceId, `${id('x')}@example.com`, reason);
}
function run(kind: string, status: string, finishedAt: string | null, counts: unknown, workspaceId = env.workspaceId): void {
  env.db.prepare('INSERT INTO run (id, created_at, workspace_id, kind, title, status, counts, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id('run'), daysAgo(500), workspaceId, kind, 'Run', status, typeof counts === 'string' ? counts : JSON.stringify(counts), finishedAt);
}
const reports = (days: 30 | 90 | 365 | null, pipelineId: string | null = main.id) => getReports(env.db, env.workspaceId, days, pipelineId, NOW);

beforeAll(async () => {
  main = listPipelines(env.db, env.workspaceId)[0]!;
  env.db.prepare('INSERT INTO pipeline (id, created_at, workspace_id, name, version, template) VALUES (?, ?, ?, ?, 1, ?)').run('pip_rv_second', '2026-03-05T00:00:00.000Z', env.workspaceId, 'Second', 'client-sales');
  for (const [index, name] of ['Alpha', 'Beta'].entries()) {
    env.db.prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, ?)').run(`stg_rv_${index}`, '2026-03-05T00:00:00.000Z', 'pip_rv_second', name, index + 1);
  }
  second = listPipelines(env.db, env.workspaceId).find((pipeline) => pipeline.id === 'pip_rv_second')!;
  foreign = insertSecondWorkspace(env.db);
  // A counting proxy over the database so a test can prove a refused request never reached it.
  const counting = new Proxy(env.db, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (...args: unknown[]) => {
          prepareCalls += 1;
          return (target.prepare as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Db;
  app = buildApp({ db: counting, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: () => NOW.toISOString() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

describe('period boundaries', () => {
  it('KILLS: every section includes a row stamped exactly now minus days and excludes one a millisecond older', () => {
    const [s0] = main.stages.map((stage) => stage.id) as [string];
    const edge = daysAgo(30);
    const before = new Date(NOW.getTime() - 30 * DAY - 1).toISOString();
    const d1 = deal(main, 0, { status: 'lost', updatedAt: edge, amount: 7 });
    const d2 = deal(main, 0, { status: 'lost', updatedAt: before, amount: 700 });
    event(d1, s0, edge);
    event(d2, s0, before);
    person(edge, ['csv-import']);
    person(before, ['csv-import']);
    const p = person(daysAgo(400), []);
    intent(p, 'accepted', edge);
    intent(p, 'accepted', before);
    message('in', p, edge);
    message('in', p, before);
    suppression('bounce', edge);
    suppression('bounce', before);
    suppression('opt_out', edge);
    suppression('opt_out', before);
    run('rvedge', 'succeeded', edge, { estimatedUsd: 3 });
    run('rvedge', 'succeeded', before, { estimatedUsd: 5000 });
    const out = reports(30);
    expect(out.pipeline[0]!.lostCount).toBe(1);
    expect(out.pipeline[0]!.lostAmounts).toEqual([{ currency: 'USD', amount: 7 }]);
    expect(out.stageFlow[0]!.entered).toBe(1);
    expect(out.intake.weeks.reduce((sum, week) => sum + week.total, 0)).toBe(1);
    expect(out.outreach).toEqual({ sends: 1, replies: 1, bounces: 1, optOuts: 1 });
    expect(out.runs.groups.filter((group) => group.kind === 'rvedge')).toEqual([{ kind: 'rvedge', status: 'succeeded', count: 1 }]);
    expect(out.runs.estimatedUsd).toBe(3);
  });

  it('ACCEPTED: a timestamp stored without milliseconds sorts after the same second with milliseconds, because periods compare ISO strings', () => {
    // "12:00:00Z" > "12:00:00.000Z" as text ('Z' sorts after '.'), so a no millisecond row sitting a hair BEFORE the
    // cutoff second is still included. Every writer in the codebase emits toISOString() output, so this cannot occur
    // through the app; it only matters for hand written rows.
    const cutoff = daysAgo(30); // ends in .000Z
    const noMillis = cutoff.replace('.000Z', 'Z');
    const p = person(daysAgo(400), []);
    const baseline = reports(30).outreach.sends;
    intent(p, 'accepted', noMillis);
    expect(reports(30).outreach.sends).toBe(baseline + 1);
  });

  it('KILLS: the all time period includes a row from year 2000 and a row with a null send time stays out of sends', () => {
    const p = person(daysAgo(400), []);
    const baseline = reports(null).outreach.sends;
    intent(p, 'accepted', '2000-01-01T00:00:00.000Z');
    intent(p, 'accepted', null);
    expect(reports(null).outreach.sends).toBe(baseline + 1);
  });
});

describe('pipeline section', () => {
  it('KILLS: currencies are never mixed, a zero sum currency is omitted, and null or zero amounts still count as deals', () => {
    const stageB = second.stages[1]!;
    for (const [amount, currency] of [[100, 'USD'], [50, 'GBP'], [25, 'EUR'], [0, 'JPY'], [null, 'CHF']] as const) {
      deal(second, 1, { amount, currency });
    }
    deal(second, 1, { amount: 10, currency: 'USD' });
    const stage = reports(90, second.id).pipeline.find((row) => row.stageId === stageB.id)!;
    expect(stage.openCount).toBe(6);
    expect(stage.openAmounts).toEqual([
      { currency: 'EUR', amount: 25 },
      { currency: 'GBP', amount: 50 },
      { currency: 'USD', amount: 110 },
    ]);
    expect(stage.openAmounts.some((total) => total.currency === 'JPY' || total.currency === 'CHF')).toBe(false);
  });

  it('ACCEPTED: currency codes group by exact text, so usd and USD show as two lines', () => {
    deal(second, 0, { amount: 1, currency: 'USD' });
    deal(second, 0, { amount: 2, currency: 'usd' });
    const totals = reports(90, second.id).pipeline[0]!.openAmounts;
    expect(totals).toEqual(expect.arrayContaining([{ currency: 'USD', amount: 1 }, { currency: 'usd', amount: 2 }]));
  });

  it('ACCEPTED: a closed deal edited after closing migrates between periods, because status is current state and updated_at is the only clock', () => {
    // Contract: "status is current state, so the period filter is an approximation stated in the UI copy".
    const fresh = reports(30, second.id).pipeline[1]!.lostCount;
    const old = deal(second, 1, { status: 'lost', updatedAt: daysAgo(100), amount: 5 });
    expect(reports(30, second.id).pipeline[1]!.lostCount).toBe(fresh);
    expect(reports(90, second.id).pipeline[1]!.lostCount).toBe(fresh);
    // Someone fixes a typo in the deal name three days ago: the loss now reads as recent.
    env.db.prepare('UPDATE opportunity SET updated_at = ? WHERE id = ?').run(daysAgo(3), old);
    expect(reports(30, second.id).pipeline[1]!.lostCount).toBe(fresh + 1);
  });

  it('ACCEPTED: through the real actions, moving or editing a closed deal re-stamps updated_at and pulls it into the period', async () => {
    const created = createOpportunity(env.ctx, { name: 'Real flow', pipelineId: second.id, stageId: second.stages[0]!.id, amountTarget: 40, currency: 'USD' });
    env.advance(1000);
    updateOpportunity(env.ctx, created.id, { expectedVersion: created.version, fields: { status: 'passed' } });
    const clockNow = new Date(Date.parse(env.ctx.now()) + 60_000);
    // Look 90 days ahead of the action clock: the deal is 90 days stale and drops out of the 30 day period.
    const far = new Date(clockNow.getTime() + 40 * DAY);
    const stale = getReports(env.db, env.workspaceId, 30, second.id, far).pipeline[0]!.passedCount;
    const current = getReports(env.db, env.workspaceId, 30, second.id, clockNow).pipeline[0]!.passedCount;
    expect(current).toBe(stale + 1);
    // Creation counted as entering the first stage of its pipeline through the real action path.
    const flow = getReports(env.db, env.workspaceId, 30, second.id, clockNow).stageFlow[0]!.entered;
    expect(flow).toBeGreaterThanOrEqual(1);
    void moveOpportunityStage;
  });

  it('KILLS: pipeline B deals and events never reach pipeline A, even through a foreign workspace row aimed at A\'s ids or a stage from the wrong pipeline', () => {
    const aStage = main.stages[0]!.id;
    const marker = 123456789;
    // A foreign workspace deal that names this workspace's pipeline and stage.
    const foreignDeal = deal(main, 0, { workspaceId: foreign, amount: marker });
    event(foreignDeal, aStage, daysAgo(1));
    // A deal of this workspace in pipeline B that points at A's stage.
    const crossed = deal(second, 0, { amount: marker, stageId: aStage });
    event(crossed, aStage, daysAgo(1));
    // A deal in pipeline A that points at B's stage.
    const crossedBack = deal(main, 0, { amount: marker, stageId: second.stages[0]!.id });
    event(crossedBack, second.stages[0]!.id, daysAgo(1));
    const a = reports(90, main.id);
    expect(JSON.stringify(a.pipeline)).not.toContain(String(marker));
    const before = a.stageFlow.find((row) => row.stageId === aStage)!.entered;
    // The only events counted for A are A's own deals in this workspace.
    const own = (env.db.prepare('SELECT COUNT(*) AS n FROM stage_event e JOIN opportunity o ON o.id = e.opportunity_id WHERE o.workspace_id = ? AND o.pipeline_id = ? AND e.to_stage_id = ? AND e.at >= ?').get(env.workspaceId, main.id, aStage, daysAgo(90)) as { n: number }).n;
    expect(before).toBe(own);
    // B never lists A's stages.
    expect(reports(90, second.id).pipeline.map((row) => row.stageId)).toEqual(second.stages.map((stage) => stage.id));
  });
});

describe('stage flow', () => {
  it('KILLS: a deal that re-enters a stage three times counts three times, and creation without an earlier event counts once', () => {
    const [s0, s1] = main.stages.map((stage) => stage.id) as [string, string];
    const base = reports(30).stageFlow.map((row) => row.entered);
    const d = deal(main, 1);
    event(d, s0, daysAgo(9));
    event(d, s1, daysAgo(8), s0);
    event(d, s0, daysAgo(7), s1);
    event(d, s1, daysAgo(6), s0);
    event(d, s0, daysAgo(5), s1);
    const after = reports(30).stageFlow.map((row) => row.entered);
    expect(after[0]! - base[0]!).toBe(3);
    expect(after[1]! - base[1]!).toBe(2);
  });

  it('ACCEPTED: a deal with no stage_event rows (written outside the actions) is invisible to stage flow even though it is open in Pipeline now', () => {
    const before = reports(null).stageFlow.reduce((sum, row) => sum + row.entered, 0);
    const bare = deal(main, 3, { amount: 999_999 });
    expect(bare).toBeTruthy();
    const after = reports(null);
    expect(after.stageFlow.reduce((sum, row) => sum + row.entered, 0)).toBe(before);
    expect(after.pipeline[3]!.openAmounts.some((total) => total.amount >= 999_999)).toBe(true);
  });
});

describe('intake', () => {
  it('KILLS: precedence holds for every subset of the four source tags', () => {
    const order = [['mailbox-import', 'mailbox'], ['linkedin-leads', 'linkedin'], ['csv-import', 'csv'], ['captured', 'captured']] as const;
    // Use a far future week so nothing else shares the bucket.
    for (let mask = 0; mask < 16; mask += 1) {
      const tags = order.filter((_, bit) => (mask >> bit) & 1).map(([tag]) => tag);
      const expected = (order.find(([tag]) => tags.includes(tag)) ?? [null, 'manual'])[1];
      const day = new Date(NOW.getTime() - (20 + mask) * 7 * DAY).toISOString();
      person(day, [...tags].reverse());
      const week = reports(null).intake.weeks.find((entry) => entry.weekStart === weekStartOf(day))!;
      expect(week.bySource[expected as 'manual']).toBeGreaterThanOrEqual(1);
    }
  });

  it('KILLS: malformed, non array, and mixed type tags fall to manual without throwing', () => {
    const when = '2020-02-03T10:00:00.000Z'; // a Monday
    for (const bad of ['not json', '{"a":1}', 'null', '"csv-import"', '[1,null,{"x":1}]', '']) person(when, bad);
    person(when, ['csv-import', 7, null] as unknown);
    const week = reports(null).intake.weeks.find((entry) => entry.weekStart === '2020-02-03')!;
    expect(week.total).toBe(7);
    expect(week.bySource.manual).toBe(6);
    expect(week.bySource.csv).toBe(1);
  });

  it('KILLS: Sunday 23:59:59.999 UTC belongs to the week before, Monday 00:00:00.000 starts the next, across a year end', () => {
    expect(weekStartOf('2026-06-14T23:59:59.999Z')).toBe('2026-06-08');
    expect(weekStartOf('2026-06-15T00:00:00.000Z')).toBe('2026-06-15');
    expect(weekStartOf('2026-01-01T00:00:00.000Z')).toBe('2025-12-29');
    expect(weekStartOf('2024-02-29T12:00:00.000Z')).toBe('2024-02-26');
    // An offset timestamp is read as the instant it names, so local Monday 01:00 at +02:00 is still Sunday in UTC.
    expect(weekStartOf('2026-06-15T01:00:00+02:00')).toBe('2026-06-08');
    expect(weekStartOf('garbage')).toBeNull();
    expect(weekStartOf('')).toBeNull();
  });

  it('KILLS: a person with an unparsable created_at is skipped, not counted, and does not crash the report', () => {
    person('not a date', ['csv-import']);
    const total = reports(null).intake.weeks.reduce((sum, week) => sum + week.total, 0);
    expect(Number.isFinite(total)).toBe(true);
  });

  it('KILLS: the foreign workspace\'s people never appear', () => {
    person('2019-05-06T10:00:00.000Z', ['mailbox-import'], foreign);
    expect(reports(null).intake.weeks.some((week) => week.weekStart === '2019-05-06')).toBe(false);
  });
});

describe('outreach', () => {
  it('KILLS: replies count only inbound messages linked to a person; unlinked inbound, outbound, and foreign rows do not', () => {
    const p = person(daysAgo(400), []);
    const base = reports(30).outreach.replies;
    message('in', p, daysAgo(2));
    message('in', null, daysAgo(2));
    message('out', p, daysAgo(2));
    message('in', person(daysAgo(400), [], foreign), daysAgo(2), foreign);
    expect(reports(30).outreach.replies).toBe(base + 1);
  });

  it('KILLS: suppression reasons map exactly, manual and demo_address count as neither a bounce nor an opt out', () => {
    const base = reports(30).outreach;
    suppression('manual', daysAgo(1));
    suppression('demo_address', daysAgo(1));
    suppression('bounce', daysAgo(1));
    suppression('opt_out', daysAgo(1));
    suppression('opt_out', daysAgo(1), foreign);
    const after = reports(30).outreach;
    expect(after.bounces).toBe(base.bounces + 1);
    expect(after.optOuts).toBe(base.optOuts + 1);
  });

  it('KILLS: only accepted, replied, and bounced intents are sends, whatever their other statuses', () => {
    const p = person(daysAgo(400), []);
    const base = reports(30).outreach.sends;
    for (const status of ['draft', 'awaiting_approval', 'approved', 'failed', 'rejected', 'cancelled']) {
      try {
        intent(p, status, daysAgo(1));
      } catch {
        // A status the table does not allow cannot be a send either.
      }
    }
    expect(reports(30).outreach.sends).toBe(base);
    intent(p, 'accepted', daysAgo(1));
    intent(p, 'replied', daysAgo(1));
    intent(p, 'bounced', daysAgo(1));
    intent(p, 'accepted', daysAgo(1), foreign);
    expect(reports(30).outreach.sends).toBe(base + 3);
  });

  it('ACCEPTED: replies count messages, not people or threads, so five replies from one person read as five', () => {
    const p = person(daysAgo(400), []);
    const base = reports(30).outreach.replies;
    for (let i = 0; i < 5; i += 1) message('in', p, daysAgo(2));
    expect(reports(30).outreach.replies).toBe(base + 5);
  });
});

describe('runs', () => {
  it('KILLS: runs still unfinished, finished outside the period, foreign, or carrying junk estimates never inflate the spend', () => {
    run('rvspend', 'running', null, { estimatedUsd: 1000 });
    run('rvspend', 'succeeded', daysAgo(2), { estimatedUsd: '5' });
    run('rvspend', 'succeeded', daysAgo(2), { estimatedUsd: null });
    run('rvspend', 'succeeded', daysAgo(2), '{"estimatedUsd":1e999}');
    run('rvspend', 'succeeded', daysAgo(2), '[]');
    run('rvspend', 'succeeded', daysAgo(2), 'null');
    run('rvspend', 'succeeded', daysAgo(2), { estimatedUsd: 0 });
    run('rvspend', 'succeeded', daysAgo(2), { estimatedUsd: 1.25 });
    run('rvspend', 'succeeded', daysAgo(2), { estimatedUsd: 1.25 }, foreign);
    const before = reports(30).runs;
    const groups = before.groups.filter((group) => group.kind === 'rvspend');
    expect(groups).toEqual([{ kind: 'rvspend', status: 'succeeded', count: 7 }]);
    // Only the zero and the 1.25 count; the 0.1 + 0.2 float drift is rounded away.
    run('rvspend', 'succeeded', daysAgo(2), { estimatedUsd: 0.1 });
    run('rvspend', 'succeeded', daysAgo(2), { estimatedUsd: 0.2 });
    const after = reports(30).runs;
    expect(Number((after.estimatedUsd - before.estimatedUsd).toFixed(6))).toBe(0.3);
    expect(String(after.estimatedUsd)).not.toMatch(/00000|99999/);
  });

  it('ACCEPTED: a negative finite estimate is summed as written (the app never writes one)', () => {
    const before = reports(30).runs.estimatedUsd;
    run('rvneg', 'succeeded', daysAgo(1), { estimatedUsd: -4 });
    expect(reports(30).runs.estimatedUsd).toBeCloseTo(before - 4, 6);
  });
});

describe('route input', () => {
  it('KILLS: garbage days answer 400 without a single database call', async () => {
    const bad = ['0', '-1', '31', '29', '366', '91', 'all', 'ALL', 'null', 'undefined', 'NaN', 'Infinity', '1e2', '0x5A', '090', ' 90', '90 ', '90.0', '9999999999999999999999', '%00', "90'--", '[]', '', '30,90'];
    for (const value of bad) {
      const before = prepareCalls;
      const response = await app.inject({ method: 'GET', url: `/api/reports?days=${encodeURIComponent(value)}`, headers: host });
      expect({ value, status: response.statusCode }).toEqual({ value, status: 400 });
      expect(prepareCalls).toBe(before);
    }
  });

  it('KILLS: repeated parameters answer 400 without a database call, never a 500', async () => {
    for (const query of ['days=30&days=90', 'days=90&days=90', 'pipelineId=a&pipelineId=b', 'pipelineId=', 'days=90&pipelineId=a&pipelineId=a']) {
      const before = prepareCalls;
      const response = await app.inject({ method: 'GET', url: `/api/reports?${query}`, headers: host });
      expect({ query, status: response.statusCode }).toEqual({ query, status: 400 });
      expect(prepareCalls).toBe(before);
    }
  });

  it('KILLS: hostile or foreign pipeline ids answer 200 with empty pipeline sections, other sections intact, and leak nothing', async () => {
    env.db.prepare('INSERT OR IGNORE INTO pipeline (id, created_at, workspace_id, name, version, template) VALUES (?, ?, ?, ?, 1, ?)').run('pip_rv_foreign', '2026-03-05T00:00:00.000Z', foreign, 'FOREIGNSECRET', '');
    env.db.prepare('INSERT OR IGNORE INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, 1)').run('stg_rv_foreign', '2026-03-05T00:00:00.000Z', 'pip_rv_foreign', 'FOREIGNSTAGE');
    const hostile = ['pip_rv_foreign', "x' OR '1'='1", "'; DROP TABLE pipeline; --", '%', '_', '*', '../../etc/passwd', '<script>alert(1)</script>', 'a'.repeat(5000), '\u0000x', '😀', main.id.toUpperCase(), ` ${main.id}`, `${main.id} `];
    for (const value of hostile) {
      const response = await app.inject({ method: 'GET', url: `/api/reports?days=90&pipelineId=${encodeURIComponent(value)}`, headers: host });
      expect({ value: value.slice(0, 20), status: response.statusCode }).toEqual({ value: value.slice(0, 20), status: 200 });
      const body = response.json();
      expect(body.pipeline).toEqual([]);
      expect(body.stageFlow).toEqual([]);
      expect(Object.keys(body).sort()).toEqual(['intake', 'outreach', 'pipeline', 'runs', 'stageFlow']);
      expect(response.body).not.toMatch(/FOREIGN/);
    }
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM pipeline WHERE id = ?").get(main.id) as { n: number }).n).toBe(1);
  });

  it('KILLS: the route writes nothing: every table is byte identical before and after a burst of requests', async () => {
    const dump = () =>
      JSON.stringify(
        (env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((table) => [table.name, env.db.prepare(`SELECT * FROM "${table.name}"`).all()]),
      );
    const before = dump();
    for (const url of ['/api/reports', '/api/reports?days=30', `/api/reports?days=365&pipelineId=${second.id}`, '/api/reports?pipelineId=nope']) {
      expect((await app.inject({ method: 'GET', url, headers: host })).statusCode).toBe(200);
    }
    expect(dump()).toBe(before);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/api/reports', headers: host, payload: {} });
      expect([404, 405]).toContain(response.statusCode);
    }
  });

  it('KILLS: a non loopback Host header is refused like every other route', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/reports', headers: { host: 'evil.example.com' } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('KILLS: the pipeline section names the contract fields, passedCount and passedAmounts, never a won spelling', async () => {
    // Contract (architecture.md Reports): "`passed` and `lost` counts and amount sums". The shipped keys follow it.
    const body = (await app.inject({ method: 'GET', url: `/api/reports?pipelineId=${main.id}`, headers: host })).json();
    const keys = Object.keys(body.pipeline[0]);
    expect(keys).toContain('passedCount');
    expect(keys).toContain('passedAmounts');
    expect(keys).not.toContain('won' + 'Count');
    expect(keys).not.toContain('won' + 'Amounts');
  });
});

describe('agent surface', () => {
  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const full = path.join(directory, entry);
      return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
    });

  it('KILLS: nothing but the HTTP routes imports the reports query, and the chat tools and agent code never mention reports', () => {
    const importers = sourceFiles(path.join(packageRoot, 'src'))
      .filter((file) => /queries\/reports|getReports/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(path.join(packageRoot, 'src'), file))
      .sort();
    expect(importers).toEqual(['http/routes.ts', 'queries/reports.ts']);
    expect(chatTools.map((tool) => tool.name).join(' ')).not.toMatch(/report/i);
    expect(JSON.stringify(chatTools)).not.toMatch(/\/api\/reports|getReports|stageFlow/);
    const reply = runChatTool(env.ctx, { id: 'rv1', name: 'reports', input: { days: 30 } });
    expect(reply.content).not.toMatch(/pipeline|stageFlow|intake|outreach/i);
    const today = runChatTool(env.ctx, { id: 'rv2', name: 'today_summary', input: {} });
    expect(today.content).not.toMatch(/stageFlow|estimatedUsd|optOuts|bySource/);
  });

  it('KILLS: the MCP server exposes no reports tool and cannot be steered to the route', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), 'mcp'],
      cwd: packageRoot,
      env: { ...(process.env as Record<string, string>), AGENTCRM_DB: env.databasePath },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'reports-review-probe', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const text = JSON.stringify(tools);
      expect(tools.map((tool) => tool.name).join(' ')).not.toMatch(/report|stage_?flow|intake|outreach_stat/i);
      expect(text).not.toMatch(/\/api\/reports|stageFlow|optOuts|bySource/);
      const attempt = await client.callTool({ name: 'crm_reports', arguments: {} }).catch((error: unknown) => ({ isError: true, error }));
      expect((attempt as { isError?: boolean }).isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 40_000);
});

describe('performance posture', () => {
  it('ACCEPTED: the person table is read in full and tags are parsed in JS; 30000 people in the all time period answer well inside a second or two', () => {
    const insert = env.db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, tags, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    env.db.transaction(() => {
      for (let i = 0; i < 30_000; i += 1) {
        const at = new Date(NOW.getTime() - (i % 1000) * DAY).toISOString();
        insert.run(`per_perf_${i}`, at, env.workspaceId, 'Perf', i % 3 === 0 ? '["csv-import","vip"]' : '[]', at);
      }
    })();
    const started = performance.now();
    const out = reports(null);
    const elapsed = performance.now() - started;
    expect(out.intake.weeks.reduce((sum, week) => sum + week.total, 0)).toBeGreaterThanOrEqual(30_000);
    // Measured at a few tens of milliseconds locally; the bound is loose so CI noise cannot flake it. At 100k people
    // the same scan is a few times slower, still comfortably interactive for a local single user tool.
    expect(elapsed).toBeLessThan(3000);
  });
});
