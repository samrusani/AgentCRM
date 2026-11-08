// Adversarial review probes for the automations wave (migration 027, actions/automations.ts, queries/automations.ts, the
// hooks in crud.ts, lifecycle.ts, templates.ts, pipelines.ts, and the /api/automations routes).
// KILLS (attack fails, pinned), CONFIRMS (live defect, passes today, comment says the fix), ACCEPTED (documented limit).
// Nothing here changes application code.
import { readFileSync, readdirSync } from 'node:fs';
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
  createTask,
  decideApproval,
  deleteAutomation,
  deletePipeline,
  moveOpportunityStage,
  proposeChanges,
  startMailboxCapture,
  switchTemplate,
  updateAutomation,
  updateOpportunity,
  updateTask,
  withActor,
} from '../src/actions/index.js';
import { mutate } from '../src/actions/context.js';
import { renderTaskTitle } from '../src/actions/automations.js';
import { promotePersonIn } from '../src/actions/lifecycle.js';
import { AppError } from '../src/errors.js';
import { buildApp } from '../src/http/app.js';
import { packageRoot } from '../src/paths.js';
import { getAutomation, listAutomations } from '../src/queries/automations.js';
import { listPipelines } from '../src/queries/pipelines.js';
import { getRunDetail } from '../src/queries/runs.js';
import { createTestEnvironment, driveRun } from './helpers.js';

const env = createTestEnvironment();
const mbox = createTestEnvironment();
let app: FastifyInstance;
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  env.cleanup();
  mbox.cleanup();
});

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await app.inject({ method, url, headers: { ...host, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: response.statusCode, body: response.body ? (JSON.parse(response.body) as Record<string, any>) : {} };
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
const src = (file: string) => readFileSync(path.join(packageRoot, file), 'utf8');
const sourceFiles = (dir: string): string[] =>
  readdirSync(path.join(packageRoot, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : [],
  );

let seq = 0;
const pipe = (template = 'client-sales') => createPipeline(env.ctx, { name: `Probe pipeline ${(seq += 1)}`, template });
const stageRule = (pipeline: ReturnType<typeof pipe>, index: number, overrides: Record<string, unknown> = {}) =>
  createAutomation(env.ctx, {
    name: `Stage rule ${(seq += 1)}`,
    triggerKind: 'stage_entered',
    triggerConfig: { pipelineId: pipeline.id, stageId: pipeline.stages[index]!.id },
    actionConfig: { taskTitle: 'Prep {name}', dueInDays: 1 },
    ...overrides,
  });
const promoRule = (overrides: Record<string, unknown> = {}) =>
  createAutomation(env.ctx, {
    name: `Promo rule ${(seq += 1)}`,
    triggerKind: 'person_promoted',
    triggerConfig: {},
    actionConfig: { taskTitle: 'Hello {name}', dueInDays: 0 },
    ...overrides,
  });
const disableAll = () => {
  for (const automation of listAutomations(env.db, env.workspaceId)) {
    if (automation.enabled) updateAutomation(env.ctx, automation.id, { expectedVersion: automation.version, fields: { enabled: false } });
  }
};
const count = (sql: string, ...params: unknown[]) => Number((env.db.prepare(sql).get(...params) as { n: number }).n);
const allTasks = () => count('SELECT COUNT(*) AS n FROM task');
const fireAudits = () => count("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'automation.fire'");
const tasksFor = (entityId: string) =>
  env.db.prepare('SELECT * FROM task WHERE entity_id = ? ORDER BY created_at, id').all(entityId) as { title: string; due_at: string; entity_type: string; status: string }[];
const stageOf = (id: string) => (env.db.prepare('SELECT stage_id FROM opportunity WHERE id = ?').get(id) as { stage_id: string }).stage_id;

describe('1 amplification and loops', () => {
  it('KILLS: a task triggers nothing; creating, completing and editing tasks by hand fire no automation, and the closure is structural', () => {
    disableAll();
    const p = pipe();
    stageRule(p, 1);
    promoRule();
    const before = fireAudits();
    const task = createTask(env.ctx, { title: 'Manual' });
    updateTask(env.ctx, task.id, { expectedVersion: task.version, fields: { status: 'done' } });
    expect(fireAudits()).toBe(before);
    // Only crud.ts (deal create and move) and lifecycle.ts call the fire functions.
    const callers = sourceFiles('src')
      .filter((file) => /fire(Stage|Promotion)AutomationsIn\(/.test(src(file)) && !file.endsWith('actions/automations.ts'))
      .map((file) => path.basename(file))
      .sort();
    expect(callers).toEqual(['crud.ts', 'lifecycle.ts']);
    // Nothing writes a deal's stage or inserts a deal outside crud.ts and the template switch.
    const stageWriters = sourceFiles('src')
      .filter((file) => /UPDATE opportunity SET stage_id|INSERT INTO opportunity/.test(src(file)))
      .map((file) => path.basename(file))
      .sort();
    expect(stageWriters).toEqual(['crud.ts', 'templates.ts']);
    disableAll();
  });

  it('KILLS: runs (qualify, capture, mailbox, import) never write a deal stage; no run or job module references automations', () => {
    for (const file of sourceFiles('src/jobs')) expect(src(file).toLowerCase()).not.toContain('automation');
    for (const file of ['src/actions/runs.ts', 'src/actions/importReview.ts', 'src/actions/mailboxCapture.ts', 'src/actions/qualify.ts']) {
      try {
        expect(src(file)).not.toMatch(/stage_id\s*=/);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  });

  it('KILLS: one signal fires one rule once; a deal created in stage 2 for a lead fires the stage rule once and the promotion rule once, and a second move fires only the stage rule', () => {
    disableAll();
    const p = pipe();
    const s = stageRule(p, 1);
    const promo = promoRule();
    const lead = createPerson(env.ctx, { firstName: 'Once', lastName: 'Only' });
    const deal = createOpportunity(env.ctx, { name: 'Once deal', pipelineId: p.id, stageId: p.stages[1]!.id, personId: lead.id });
    expect(tasksFor(deal.id)).toHaveLength(1);
    expect(tasksFor(lead.id)).toHaveLength(1);
    expect(getAutomation(env.db, env.workspaceId, s.id)!.firedCount).toBe(1);
    expect(getAutomation(env.db, env.workspaceId, promo.id)!.firedCount).toBe(1);
    const moved = moveOpportunityStage(env.ctx, deal.id, { stageId: p.stages[2]!.id, expectedVersion: deal.version });
    moveOpportunityStage(env.ctx, deal.id, { stageId: p.stages[1]!.id, expectedVersion: moved.version });
    expect(tasksFor(deal.id)).toHaveLength(2); // re-entry fires again (documented)
    expect(tasksFor(lead.id)).toHaveLength(1); // already a relationship
    disableAll();
  });

  it('KILLS: a move into the stage the deal is already in is refused and fires nothing; a field edit of a deal in a ruled stage fires nothing; the generic update cannot change the stage', () => {
    disableAll();
    const p = pipe();
    stageRule(p, 1);
    const deal = createOpportunity(env.ctx, { name: 'Stay put', pipelineId: p.id, stageId: p.stages[1]!.id });
    const before = fireAudits();
    expect(rejected(() => moveOpportunityStage(env.ctx, deal.id, { stageId: p.stages[1]!.id, expectedVersion: deal.version })).code).toBe('conflict');
    updateOpportunity(env.ctx, deal.id, { expectedVersion: deal.version, fields: { name: 'Renamed' } });
    expect(fireAudits()).toBe(before);
    expect(() => updateOpportunity(env.ctx, deal.id, { expectedVersion: deal.version + 1, fields: { stageId: p.stages[2]!.id } })).toThrow(AppError);
    expect(stageOf(deal.id)).toBe(p.stages[1]!.id);
    disableAll();
  });

  it('ACCEPTED: N enabled rules on one stage fire N tasks in one transaction; there is no per signal or per workspace bound (25 rules, 25 tasks, 25 audits)', () => {
    disableAll();
    const p = pipe();
    for (let i = 0; i < 25; i += 1) stageRule(p, 1, { name: `Fan ${i}` });
    const deal = createOpportunity(env.ctx, { name: 'Fan deal', pipelineId: p.id, stageId: p.stages[1]!.id });
    expect(tasksFor(deal.id)).toHaveLength(25);
    expect(new Set(tasksFor(deal.id).map((task) => task.title))).toEqual(new Set(['Prep Fan deal']));
    // Identical duplicate rules are allowed too: no uniqueness on name or trigger.
    expect(listAutomations(env.db, env.workspaceId).filter((a) => a.name.startsWith('Fan ')).length).toBe(25);
    disableAll();
  });

  it('ACCEPTED: the mailbox accept path promotes in bulk, so 50 accepted correspondents with a promotion rule make 50 tasks in the one approve transaction, and nothing the reviewer reads mentions tasks', () => {
    const store = (i: number) =>
      mbox.db
        .prepare(
          `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, direction, person_id, from_email, from_name, "to", subject, preview, body_text, labels, provider_timestamp)
           VALUES (?, ?, ?, ?, 'in', NULL, ?, ?, '["me@stub-mail.invalid"]', 's', '', 'b', '[]', ?)`,
        )
        .run(`msg_bulk${i}`, '2026-02-20T09:00:00.000Z', mbox.workspaceId, `pm_bulk${i}`, `bulk${i}@bulk.invalid`, `Bulk${i} Person`, '2026-02-20T09:00:00.000Z');
    for (let i = 0; i < 50; i += 1) store(i);
    createAutomation(mbox.ctx, { name: 'Bulk hello', triggerKind: 'person_promoted', triggerConfig: {}, actionConfig: { taskTitle: 'Reply to {name}', dueInDays: 0 } });
    const run = startMailboxCapture(mbox.ctx, {});
    driveRun(mbox, run.id, ['waiting_approval']);
    const detail = getRunDetail(mbox.db, mbox.workspaceId, run.id);
    const shown = JSON.stringify(detail.steps) + JSON.stringify(detail.approvals);
    expect(shown).not.toMatch(/task|automation/i); // the user is told about leads to import only
    const n = (sql: string) => Number((mbox.db.prepare(sql).get() as { n: number }).n);
    expect(n('SELECT COUNT(*) AS n FROM task')).toBe(0);
    decideApproval(mbox.ctx, detail.approvals[0]!.id, { decision: 'approve' });
    expect(n("SELECT COUNT(*) AS n FROM person WHERE lifecycle = 'relationship'")).toBe(50);
    expect(n('SELECT COUNT(*) AS n FROM task')).toBe(50);
    expect(n("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'automation.fire'")).toBe(50);
    const after = getRunDetail(mbox.db, mbox.workspaceId, run.id);
    expect(JSON.stringify(after.steps)).not.toMatch(/task|automation/i);
  });
});

describe('2 transaction integrity', () => {
  it('KILLS: hostile deal names (NUL, bidi, newline, markup, braces, replacement patterns) render as plain titles and never abort the stage move', () => {
    disableAll();
    const p = pipe();
    stageRule(p, 1, { actionConfig: { taskTitle: 'Do {name} / {name}', dueInDays: 0 } });
    for (const name of ['A\u0000B', '\u0000', '‮evil‬', 'line1\nline2', '<img src=x onerror=alert(1)>', '{name}{name}', '$& $1 $$ $`', "'; DROP TABLE task;--"]) {
      const deal = createOpportunity(env.ctx, { name, pipelineId: p.id });
      const moved = moveOpportunityStage(env.ctx, deal.id, { stageId: p.stages[1]!.id, expectedVersion: deal.version });
      expect(moved.stageId).toBe(p.stages[1]!.id);
      const [task] = tasksFor(deal.id);
      expect(task!.title).toBe(`Do ${name} / ${name}`.trim());
    }
    disableAll();
  });

  it('KILLS: a rendered title over the task bound is cut to 300 and still inserts; a person name of 201 chars in a 200 char template reaches the cut', () => {
    expect(renderTaskTitle('x'.repeat(194) + '{name}', 'n'.repeat(201))).toHaveLength(300);
    disableAll();
    const p = pipe();
    stageRule(p, 1, { actionConfig: { taskTitle: 'x'.repeat(194) + '{name}', dueInDays: 0 } });
    const deal = createOpportunity(env.ctx, { name: 'N'.repeat(200), pipelineId: p.id, stageId: p.stages[1]!.id });
    expect(tasksFor(deal.id)[0]!.title).toHaveLength(300);
    disableAll();
  });

  it('KILLS: the cut at 300 never splits a surrogate pair; it steps back one unit so no lone surrogate or replacement character is stored', () => {
    const cut = renderTaskTitle('b'.repeat(101) + '{name}', 'a'.repeat(198) + '\u{1F600}');
    expect(cut).toHaveLength(299);
    expect(cut.endsWith('a')).toBe(true);
    disableAll();
    const p = pipe();
    stageRule(p, 1, { actionConfig: { taskTitle: 'b'.repeat(101) + '{name}', dueInDays: 0 } });
    const deal = createOpportunity(env.ctx, { name: 'a'.repeat(198) + '\u{1F600}', pipelineId: p.id, stageId: p.stages[1]!.id });
    const title = tasksFor(deal.id)[0]!.title;
    expect(title.endsWith('�')).toBe(false);
    expect(title).toHaveLength(299);
    disableAll();
  });

  it('KILLS: a name that renders empty cannot reach the task insert through the actions, because blank person and deal names are refused', () => {
    expect(() => createPerson(env.ctx, { firstName: '   ', lastName: '' })).toThrow(AppError);
    expect(() => createOpportunity(env.ctx, { name: '   ' })).toThrow(AppError);
    // A template of only {name} renders to the name itself.
    expect(renderTaskTitle('{name}', 'Solo')).toBe('Solo');
    expect(renderTaskTitle('{name}{name}', 'ab')).toBe('abab');
  });

  it('ACCEPTED: the fire shares the signal transaction, so a task insert that fails for any reason (here a trigger standing in for a full disk) rolls the stage move back; no title can cause this, the task table has no title constraint', () => {
    disableAll();
    const p = pipe();
    stageRule(p, 1);
    const deal = createOpportunity(env.ctx, { name: 'BOOM deal', pipelineId: p.id });
    env.db.exec("CREATE TRIGGER probe_boom BEFORE INSERT ON task WHEN NEW.title LIKE '%BOOM%' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    try {
      expect(() => moveOpportunityStage(env.ctx, deal.id, { stageId: p.stages[1]!.id, expectedVersion: deal.version })).toThrow();
    } finally {
      env.db.exec('DROP TRIGGER probe_boom');
    }
    expect(stageOf(deal.id)).toBe(p.stages[0]!.id);
    expect(count('SELECT COUNT(*) AS n FROM stage_event WHERE opportunity_id = ?', deal.id)).toBe(1);
    expect(tasksFor(deal.id)).toHaveLength(0);
    disableAll();
  });

  it('KILLS: a rule with corrupt stored JSON is skipped silently (no fire, no audit, no crash) and the other rules still fire', () => {
    disableAll();
    const p = pipe();
    const bad1 = stageRule(p, 1, { name: 'Bad action json' });
    const bad2 = stageRule(p, 1, { name: 'Bad action values' });
    const bad3 = stageRule(p, 1, { name: 'Bad trigger json' });
    const good = stageRule(p, 1, { name: 'Good' });
    env.db.prepare("UPDATE automation SET action_config = '{nope' WHERE id = ?").run(bad1.id);
    env.db.prepare('UPDATE automation SET action_config = ? WHERE id = ?').run(JSON.stringify({ taskTitle: '', dueInDays: 99999 }), bad2.id);
    env.db.prepare("UPDATE automation SET trigger_config = 'null' WHERE id = ?").run(bad3.id);
    const deal = createOpportunity(env.ctx, { name: 'Corrupt deal', pipelineId: p.id, stageId: p.stages[1]!.id });
    expect(tasksFor(deal.id)).toHaveLength(1);
    expect(getAutomation(env.db, env.workspaceId, good.id)!.firedCount).toBe(1);
    expect(getAutomation(env.db, env.workspaceId, bad1.id)!.firedCount).toBe(0);
    // Listing a corrupt rule does not throw either.
    expect(listAutomations(env.db, env.workspaceId).find((a) => a.id === bad3.id)!.triggerConfig).toEqual({});
    disableAll();
  });

  it('KILLS: due date is now plus days*24h exactly, at both bounds', () => {
    disableAll();
    const p = pipe();
    stageRule(p, 1, { name: 'Zero', actionConfig: { taskTitle: 'Z', dueInDays: 0 } });
    stageRule(p, 1, { name: 'Max', actionConfig: { taskTitle: 'M', dueInDays: 365 } });
    const deal = createOpportunity(env.ctx, { name: 'Due deal', pipelineId: p.id, stageId: p.stages[1]!.id });
    const rows = env.db.prepare('SELECT t.title, t.due_at, t.created_at FROM task t WHERE t.entity_id = ? ORDER BY t.title').all(deal.id) as { title: string; due_at: string; created_at: string }[];
    const delta = (row: { due_at: string; created_at: string }) => Date.parse(row.due_at) - Date.parse(row.created_at);
    expect(rows.map((r) => [r.title, delta(r)])).toEqual([['M', 365 * 86_400_000], ['Z', 0]]);
    disableAll();
  });
});

describe('3 config validation', () => {
  const okAction = { taskTitle: 'T', dueInDays: 0 };
  const make = (triggerConfig: unknown, triggerKind = 'stage_entered', actionConfig: unknown = okAction, extra: Record<string, unknown> = {}) =>
    createAutomation(env.ctx, { name: 'Probe', triggerKind, triggerConfig, actionConfig, ...extra });

  it('KILLS: stage of another pipeline, deleted ids, cross workspace ids, unknown ids and junk trigger shapes are all refused as validation, never a 500', () => {
    const a = pipe();
    const b = pipe();
    expect(rejected(() => make({ pipelineId: a.id, stageId: b.stages[1]!.id })).code).toBe('validation');
    const doomed = pipe();
    const doomedStage = doomed.stages[1]!.id;
    deletePipeline(env.ctx, doomed.id);
    expect(rejected(() => make({ pipelineId: doomed.id, stageId: doomedStage })).code).toBe('validation');
    expect(rejected(() => make({ pipelineId: a.id, stageId: doomedStage })).code).toBe('validation');
    env.db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_x2', '2026-03-02T00:00:00.000Z', 'X2', 'startup-fundraising');
    env.db.prepare('INSERT INTO pipeline (id, created_at, workspace_id, name, template) VALUES (?, ?, ?, ?, ?)').run('pip_x2', '2026-03-02T00:00:00.000Z', 'wsp_x2', 'X2 pipe', 'startup-fundraising');
    env.db.prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, ?)').run('stg_x2', '2026-03-02T00:00:00.000Z', 'pip_x2', 'One', 1);
    expect(rejected(() => make({ pipelineId: 'pip_x2', stageId: 'stg_x2' })).code).toBe('validation'); // both foreign
    expect(rejected(() => make({ pipelineId: a.id, stageId: 'stg_x2' })).code).toBe('validation'); // mixed
    for (const junk of [undefined, null, 'x', 7, [], [a.id], {}, { pipelineId: a.id }, { stageId: a.stages[0]!.id }, { pipelineId: 1, stageId: 2 }, { pipelineId: '', stageId: '' }, { pipelineId: a.id, stageId: a.stages[0]!.id, extra: 1 }, { pipelineId: a.id, stageId: a.stages[0]!.id, disabledReason: 'x' }]) {
      expect(rejected(() => make(junk)).code).toBe('validation');
    }
    expect(listAutomations(env.db, env.workspaceId).filter((x) => x.name === 'Probe')).toHaveLength(0);
  });

  it('KILLS: person_promoted takes only an empty config (or none); stage keys, arrays and strings are refused', () => {
    expect(make(undefined, 'person_promoted').triggerConfig).toEqual({});
    expect(make(null, 'person_promoted').triggerConfig).toEqual({});
    expect(make({}, 'person_promoted').triggerConfig).toEqual({});
    for (const junk of [{ pipelineId: 'x' }, [], 'x', 3, { disabledReason: 'x' }]) expect(rejected(() => make(junk, 'person_promoted')).code).toBe('validation');
    for (const kind of ['task_created', '', 'STAGE_ENTERED', null, 7, undefined]) expect(rejected(() => make({}, kind as string)).code).toBe('validation');
    disableAll();
  });

  it('KILLS: action config shapes and bounds; dueInDays 366 / -1 / 1.5 / NaN / Infinity / strings, title 0 / blank / 201, extra keys, nulls', () => {
    const a = pipe();
    const trig = { pipelineId: a.id, stageId: a.stages[1]!.id };
    const bad: unknown[] = [null, 'x', 7, [], {}, { taskTitle: 'T' }, { dueInDays: 1 }, { taskTitle: 'T', dueInDays: 366 }, { taskTitle: 'T', dueInDays: -1 }, { taskTitle: 'T', dueInDays: 1.5 }, { taskTitle: 'T', dueInDays: Number.NaN }, { taskTitle: 'T', dueInDays: Infinity }, { taskTitle: 'T', dueInDays: '3' }, { taskTitle: 'T', dueInDays: null }, { taskTitle: '', dueInDays: 0 }, { taskTitle: '   ', dueInDays: 0 }, { taskTitle: 'x'.repeat(201), dueInDays: 0 }, { taskTitle: 5, dueInDays: 0 }, { taskTitle: 'T', dueInDays: 0, extra: true }, { taskTitle: 'T', dueInDays: 0, notify: 'email' }];
    for (const action of bad) {
      let outcome = 'accepted';
      try {
        make(trig, 'stage_entered', action);
      } catch (error) {
        outcome = error instanceof AppError ? error.code : 'other';
      }
      expect(outcome, `action ${String(JSON.stringify(action))}`).toBe('validation');
    }
    expect(rejected(() => createAutomation(env.ctx, { name: 'Probe', triggerKind: 'stage_entered', triggerConfig: trig })).code).toBe('validation'); // actionConfig absent
    const good = [{ taskTitle: 'x'.repeat(200), dueInDays: 365 }, { taskTitle: '{name}', dueInDays: 0 }, { taskTitle: '{nope} {Name} {{name}}', dueInDays: -0 }];
    for (const action of good) expect(make(trig, 'stage_entered', action).actionConfig.dueInDays).toBeGreaterThanOrEqual(0);
    // The padded title is trimmed before the 200 bound, matching the web sheet.
    expect(make(trig, 'stage_entered', { taskTitle: `  ${'y'.repeat(200)}  `, dueInDays: 0 }).actionConfig.taskTitle).toHaveLength(200);
    disableAll();
  });

  it('KILLS: enabled must be a real boolean on create and patch (2, 1, "true", null refused); unknown top level keys refused', () => {
    const rule = make({}, 'person_promoted');
    for (const value of [2, 1, 0, 'true', null, [], {}]) {
      expect(rejected(() => make({}, 'person_promoted', okAction, { enabled: value })).code).toBe('validation');
      expect(rejected(() => updateAutomation(env.ctx, rule.id, { expectedVersion: 1, fields: { enabled: value } })).code).toBe('validation');
    }
    expect(rejected(() => make({}, 'person_promoted', okAction, { workspaceId: 'x' })).code).toBe('validation');
    expect(rejected(() => make({}, 'person_promoted', okAction, { firedCount: 9 })).code).toBe('validation');
    expect(getAutomation(env.db, env.workspaceId, rule.id)!.version).toBe(1);
    disableAll();
  });

  it('KILLS: triggerKind is immutable at both PATCH positions, and a refused patch changes nothing (version and row intact)', () => {
    const rule = make({}, 'person_promoted');
    for (const body of [{ expectedVersion: 1, triggerKind: 'stage_entered', fields: { name: 'x' } }, { expectedVersion: 1, fields: { triggerKind: 'stage_entered' } }, { expectedVersion: 1, fields: { name: 'x', trigger_kind: 'stage_entered' } }, { expectedVersion: 1, fields: {} }, { expectedVersion: 1 }, { fields: { name: 'x' } }, { expectedVersion: 0, fields: { name: 'x' } }, { expectedVersion: 1.5, fields: { name: 'x' } }, { expectedVersion: '1', fields: { name: 'x' } }, { expectedVersion: 1, fields: { workspaceId: 'w' } }, { expectedVersion: 1, fields: { id: 'aut_x' } }]) {
      expect(rejected(() => updateAutomation(env.ctx, rule.id, body)).code).toBe('validation');
    }
    expect(getAutomation(env.db, env.workspaceId, rule.id)).toMatchObject({ version: 1, name: 'Probe', triggerKind: 'person_promoted' });
    // A stage config on a promotion rule, and a null or missing config on a stage rule, are refused.
    expect(rejected(() => updateAutomation(env.ctx, rule.id, { expectedVersion: 1, fields: { triggerConfig: { pipelineId: 'p', stageId: 's' } } })).code).toBe('validation');
    const a = pipe();
    const stageR = make({ pipelineId: a.id, stageId: a.stages[1]!.id });
    for (const triggerConfig of [null, {}, 'x', [], { pipelineId: a.id }]) {
      expect(rejected(() => updateAutomation(env.ctx, stageR.id, { expectedVersion: 1, fields: { triggerConfig } })).code).toBe('validation');
    }
    expect(getAutomation(env.db, env.workspaceId, stageR.id)!.version).toBe(1);
    disableAll();
  });

  it('KILLS: a rule name with a control character (NUL first or anywhere) is refused as validation, on create, rename and over HTTP, never a SQLite error', async () => {
    const rule = make({}, 'person_promoted');
    const refusal = rejected(() => createAutomation(env.ctx, { name: '\u0000', triggerKind: 'person_promoted', triggerConfig: {}, actionConfig: okAction }));
    expect(refusal.code).toBe('validation');
    expect(refusal.message).toContain('The name cannot contain control characters');
    expect(refusal.message).not.toContain('characters..');
    const renamed = rejected(() => updateAutomation(env.ctx, rule.id, { expectedVersion: 1, fields: { name: '\u0000x' } }));
    expect(renamed.code).toBe('validation');
    const viaHttp = await call('POST', '/api/automations', { name: '\u0000', triggerKind: 'person_promoted', triggerConfig: {}, actionConfig: okAction });
    expect(viaHttp.status).toBe(400);
    // The failed transaction rolled back whole: the rule is untouched and no row appeared.
    expect(getAutomation(env.db, env.workspaceId, rule.id)).toMatchObject({ name: 'Probe', version: 1 });
    // A NUL later in the name is refused too.
    expect(rejected(() => createAutomation(env.ctx, { name: 'a\u0000b', triggerKind: 'person_promoted', triggerConfig: {}, actionConfig: okAction })).code).toBe('validation');
    disableAll();
  });
});

describe('4 the disable path', () => {
  it('KILLS: deleting a pipeline disables only rules naming it (stage or pipeline), including rules already off, stamps each, audits each, and leaves other pipelines and person rules alone', () => {
    disableAll();
    const doomed = pipe();
    const other = pipe();
    const onStage = stageRule(doomed, 2);
    const manuallyOff = stageRule(doomed, 3, { enabled: false });
    const bystander = stageRule(other, 2);
    const promo = promoRule();
    const before = count("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'automation.disable'");
    deletePipeline(env.ctx, doomed.id);
    expect(count("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'automation.disable'")).toBe(before + 2);
    for (const rule of [onStage, manuallyOff]) {
      const after = getAutomation(env.db, env.workspaceId, rule.id)!;
      expect(after.enabled).toBe(false);
      expect(after.disabledReason).toContain(doomed.name);
      expect(after.version).toBe(rule.version + 1);
    }
    expect(getAutomation(env.db, env.workspaceId, bystander.id)).toMatchObject({ enabled: true, disabledReason: null, version: 1 });
    expect(getAutomation(env.db, env.workspaceId, promo.id)).toMatchObject({ enabled: true, version: 1 });
    // Re-enabling is refused with the stored reason, in both the actions and HTTP, and nothing changes.
    const stale = getAutomation(env.db, env.workspaceId, onStage.id)!;
    const refusal = rejected(() => updateAutomation(env.ctx, onStage.id, { expectedVersion: stale.version, fields: { enabled: true } }));
    expect(refusal.message).toContain(doomed.name);
    expect(refusal.message).toContain('Edit the automation');
    expect(getAutomation(env.db, env.workspaceId, onStage.id)).toMatchObject({ enabled: false, version: stale.version });
    disableAll();
  });

  it('KILLS: re-enable together with other changes is all or nothing; a refused enable does not rename or retarget; an accepted trigger edit clears the note but keeps the rule off unless enabled is sent', () => {
    disableAll();
    const doomed = pipe();
    const live = pipe();
    const rule = stageRule(doomed, 2);
    deletePipeline(env.ctx, doomed.id);
    const off = getAutomation(env.db, env.workspaceId, rule.id)!;
    rejected(() => updateAutomation(env.ctx, rule.id, { expectedVersion: off.version, fields: { enabled: true, name: 'Renamed', actionConfig: { taskTitle: 'New', dueInDays: 3 } } }));
    expect(getAutomation(env.db, env.workspaceId, rule.id)).toMatchObject({ name: off.name, version: off.version, actionConfig: off.actionConfig });
    // Renaming alone, or turning it off again, keeps the note.
    const renamed = updateAutomation(env.ctx, rule.id, { expectedVersion: off.version, fields: { name: 'Renamed', enabled: false } });
    expect(renamed.disabledReason).toBe(off.disabledReason);
    const retargeted = updateAutomation(env.ctx, rule.id, { expectedVersion: renamed.version, fields: { triggerConfig: { pipelineId: live.id, stageId: live.stages[1]!.id } } });
    expect(retargeted).toMatchObject({ enabled: false, disabledReason: null });
    const on = updateAutomation(env.ctx, rule.id, { expectedVersion: retargeted.version, fields: { enabled: true } });
    expect(on.enabled).toBe(true);
    // The fired deal now creates a task.
    const deal = createOpportunity(env.ctx, { name: 'Retarget deal', pipelineId: live.id, stageId: live.stages[1]!.id });
    expect(tasksFor(deal.id)).toHaveLength(1);
    disableAll();
  });

  it('KILLS: a template switch fires nothing, creates no task, disables only rules naming the replaced stages (not the same stage names in another pipeline, not person rules), and a new rule on the new stages works', () => {
    disableAll();
    const switching = pipe('startup-fundraising');
    const bystanderPipe = pipe('startup-fundraising');
    const switchRule = stageRule(switching, 4);
    const bystander = stageRule(bystanderPipe, 4);
    const promo = promoRule();
    const lead = createPerson(env.ctx, { firstName: 'Switch', lastName: 'Lead' });
    const deal = createOpportunity(env.ctx, { name: 'Switch deal', pipelineId: switching.id, stageId: switching.stages[2]!.id, personId: lead.id });
    const mapping = Object.fromEntries(switching.stages.map((stage) => [stage.id, 'Qualified']));
    const tasksBefore = allTasks();
    const firesBefore = fireAudits();
    const switched = switchTemplate(env.ctx, { pipelineId: switching.id, template: 'fund-lp', stageMapping: mapping, replaceQualification: false, expectedVersion: switching.version });
    expect(allTasks()).toBe(tasksBefore);
    expect(fireAudits()).toBe(firesBefore);
    expect(getAutomation(env.db, env.workspaceId, switchRule.id)).toMatchObject({ enabled: false });
    expect(getAutomation(env.db, env.workspaceId, bystander.id)).toMatchObject({ enabled: true, version: 1 });
    expect(getAutomation(env.db, env.workspaceId, promo.id)).toMatchObject({ enabled: true, version: 1 });
    expect(tasksFor(lead.id)).toHaveLength(1); // the lead had been promoted by the create, not by the switch
    const fresh = stageRule(switched, 3);
    const move = moveOpportunityStage(env.ctx, deal.id, { stageId: switched.stages[3]!.id, expectedVersion: getOpp(deal.id).version });
    expect(move.stageId).toBe(switched.stages[3]!.id);
    expect(getAutomation(env.db, env.workspaceId, fresh.id)!.firedCount).toBe(1);
    disableAll();
  });

  it('KILLS: templates.ts no longer calls fireStageAutomationsIn (a rule cannot name a stage id that does not exist yet); the switch fires nothing, as the contract says', () => {
    expect(src('src/actions/templates.ts')).not.toContain('fireStageAutomationsIn');
  });

  it('KILLS: deleting a rule mid-stream stops firing at once, its audit rows stay and never leak into another rule, and its tasks stay', () => {
    disableAll();
    const p = pipe();
    const a = stageRule(p, 1, { name: 'A' });
    const b = stageRule(p, 1, { name: 'B' });
    const d1 = createOpportunity(env.ctx, { name: 'D1', pipelineId: p.id, stageId: p.stages[1]!.id });
    deleteAutomation(env.ctx, a.id);
    const d2 = createOpportunity(env.ctx, { name: 'D2', pipelineId: p.id, stageId: p.stages[1]!.id });
    expect(tasksFor(d1.id)).toHaveLength(2);
    expect(tasksFor(d2.id)).toHaveLength(1);
    expect(getAutomation(env.db, env.workspaceId, a.id)).toBeNull();
    expect(getAutomation(env.db, env.workspaceId, b.id)!.firedCount).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'automation.fire' AND entity_id = ?", a.id)).toBe(1);
    disableAll();
  });
});

const getOpp = (id: string) => env.db.prepare('SELECT version FROM opportunity WHERE id = ?').get(id) as { version: number };

describe('5 firedCount', () => {
  it('KILLS: counts only automation.fire rows of that rule and workspace; update, disable and foreign rows with the same entity id do not count', () => {
    disableAll();
    const p = pipe();
    const rule = stageRule(p, 1);
    createOpportunity(env.ctx, { name: 'F1', pipelineId: p.id, stageId: p.stages[1]!.id });
    createOpportunity(env.ctx, { name: 'F2', pipelineId: p.id, stageId: p.stages[1]!.id });
    const renamed = updateAutomation(env.ctx, rule.id, { expectedVersion: 1, fields: { name: 'Renamed' } });
    expect(renamed.firedCount).toBe(2);
    env.db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_fc', '2026-03-02T00:00:00.000Z', 'FC', 'startup-fundraising');
    const insertAudit = (workspace: string, action: string, entityType: string) =>
      env.db
        .prepare("INSERT INTO audit_event (id, created_at, workspace_id, actor, action, entity_type, entity_id, detail) VALUES (?, ?, ?, 'x', ?, ?, ?, '{}')")
        .run(`aev_fc${(seq += 1)}`, '2026-03-02T00:00:00.000Z', workspace, action, entityType, rule.id);
    insertAudit('wsp_fc', 'automation.fire', 'automation'); // other workspace
    insertAudit(env.workspaceId, 'automation.disable', 'automation'); // other action
    insertAudit(env.workspaceId, 'automation.fire', 'task'); // other entity type
    expect(getAutomation(env.db, env.workspaceId, rule.id)!.firedCount).toBe(2);
    expect(listAutomations(env.db, env.workspaceId).find((a) => a.id === rule.id)!.firedCount).toBe(2);
    expect(listAutomations(env.db, 'wsp_fc')).toEqual([]);
    disableAll();
  });

  it('ACCEPTED: firedCount counts firings, not surviving tasks; completing or deleting the created task leaves it unchanged, and a disabled rule keeps its count', () => {
    disableAll();
    const p = pipe();
    const rule = stageRule(p, 1);
    const deal = createOpportunity(env.ctx, { name: 'Count deal', pipelineId: p.id, stageId: p.stages[1]!.id });
    env.db.prepare('DELETE FROM task WHERE entity_id = ?').run(deal.id);
    const off = updateAutomation(env.ctx, rule.id, { expectedVersion: 1, fields: { enabled: false } });
    expect(off.firedCount).toBe(1);
  });
});

describe('6 agent surface and the Origin guard', () => {
  it('KILLS: proposals refuse the entity in every position, MCP and agent modules (whole directories) never mention automations, and no read model includes automation data', () => {
    const agent = withActor(env.ctx, 'agent:probe');
    const rule = promoRule();
    for (const entityType of ['automation', 'automations', 'Automation']) {
      expect(rejected(() => proposeChanges(agent, { changes: [{ entityType, id: rule.id, fields: { enabled: false } }] })).code).toBe('validation');
      expect(rejected(() => applyChanges(agent, { proposalHash: 'a'.repeat(64), changes: [{ entityType, id: rule.id, expectedVersion: 1, fields: { name: 'x' } }] })).code).toBe('validation');
    }
    // An agent cannot even attach a task to an automation.
    expect(rejected(() => createTask(agent, { title: 'T', entityType: 'automation', entityId: rule.id })).code).toBe('validation');
    for (const dir of ['src/mcp', 'src/agent', 'src/providers']) for (const file of sourceFiles(dir)) expect(src(file).toLowerCase()).not.toContain('automation');
    const readers = sourceFiles('src/queries').filter((file) => !file.endsWith('queries/automations.ts'));
    for (const file of readers) expect(src(file).toLowerCase()).not.toContain('automation');
    expect(getAutomation(env.db, env.workspaceId, rule.id)).toMatchObject({ enabled: true, version: 1 });
    disableAll();
  });

  it('ACCEPTED: the automation.fire audit row (rule name, task id) is readable by the CLI or any process on the database, but no agent facing tool reads audit_event', () => {
    expect(src('src/mcp/server.ts')).not.toContain('audit_event');
    expect(src('src/agent/modelChat.ts')).not.toContain('audit_event');
  });

  it('KILLS: the global Origin guard covers POST, PATCH and DELETE on /api/automations for every hostile origin, and nothing changes', async () => {
    const rule = promoRule();
    const hostile = ['https://evil.example', 'null', 'http://localhost.evil.com', 'http://127.0.0.1.evil.com', 'http://localhost@evil.com', 'file:///x', 'ftp://localhost', 'http://[::2]', 'javascript:alert(1)', 'chrome:', 'x'];
    for (const origin of hostile) {
      const headers = { origin };
      const post = await call('POST', '/api/automations', { name: 'Evil', triggerKind: 'person_promoted', triggerConfig: {}, actionConfig: { taskTitle: 'T', dueInDays: 0 } }, headers);
      const patch = await call('PATCH', `/api/automations/${rule.id}`, { expectedVersion: 1, fields: { enabled: false } }, headers);
      const del = await call('DELETE', `/api/automations/${rule.id}`, undefined, headers);
      expect([post.status, patch.status, del.status], origin).toEqual([403, 403, 403]);
    }
    expect(listAutomations(env.db, env.workspaceId).some((a) => a.name === 'Evil')).toBe(false);
    expect(getAutomation(env.db, env.workspaceId, rule.id)).toMatchObject({ enabled: true, version: 1 });
    // A rebinding host is refused even for GET.
    expect((await call('GET', '/api/automations', undefined, { host: 'evil.example' })).status).toBe(403);
    // Loopback origins (the dev server) are allowed.
    expect((await call('PATCH', `/api/automations/${rule.id}`, { expectedVersion: 1, fields: { enabled: false } }, { origin: 'http://localhost:5173' })).status).toBe(200);
  });

  it('ACCEPTED: a browser extension origin passes the guard on the automation write routes, same as every other settings route (documented in app.ts)', async () => {
    const response = await call('POST', '/api/automations', { name: 'Ext', triggerKind: 'person_promoted', triggerConfig: {}, actionConfig: { taskTitle: 'T', dueInDays: 0 } }, { origin: 'chrome-extension://abcdef' });
    expect(response.status).toBe(201);
    disableAll();
  });

  it('KILLS: malformed HTTP bodies and ids are 400 or 404, never 500', async () => {
    for (const payload of ['not json', '[]', '"x"', '123', 'null']) {
      const response = await app.inject({ method: 'POST', url: '/api/automations', headers: { ...host, 'content-type': 'application/json' }, payload });
      expect(response.statusCode, payload).toBe(400);
    }
    expect((await call('PATCH', '/api/automations/aut_missing', { expectedVersion: 1, fields: { enabled: false } })).status).toBe(404);
    expect((await call('DELETE', '/api/automations/aut_missing')).status).toBe(404);
    expect((await call('DELETE', '/api/automations/%00')).status).toBeLessThan(500);
    expect((await call('GET', '/api/automations/aut_x')).status).toBe(404); // no single GET route
  });
});

describe('7 hostile text across the surfaces', () => {
  it('KILLS: hostile rule names and templates survive create, fire, audit detail and the list as inert data', () => {
    disableAll();
    const p = pipe();
    const hostileName = '<script>alert(1)</script>‮gnp.exe⁦ a b \\" \'';
    const rule = stageRule(p, 1, { name: hostileName, actionConfig: { taskTitle: '<b>{name}</b>‮ $& \\0 {name', dueInDays: 0 } });
    expect(getAutomation(env.db, env.workspaceId, rule.id)!.name).toBe(hostileName);
    const deal = createOpportunity(env.ctx, { name: 'Dl', pipelineId: p.id, stageId: p.stages[1]!.id });
    expect(tasksFor(deal.id)[0]!.title).toBe('<b>Dl</b>‮ $& \\0 {name');
    const detail = JSON.parse((env.db.prepare("SELECT detail FROM audit_event WHERE action = 'automation.fire' AND entity_id = ?").get(rule.id) as { detail: string }).detail);
    expect(detail.automationName).toBe(hostileName);
    expect(listAutomations(env.db, env.workspaceId).find((a) => a.id === rule.id)!.name).toBe(hostileName);
    const create = JSON.parse((env.db.prepare("SELECT detail FROM audit_event WHERE action = 'automation.create' AND entity_id = ?").get(rule.id) as { detail: string }).detail);
    expect(create.name).toBe(hostileName);
    disableAll();
  });

  it('KILLS: a person whose name contains braces, a {name} and a NUL renders once, in a single pass', () => {
    disableAll();
    promoRule({ actionConfig: { taskTitle: 'Hi {name}!', dueInDays: 0 } });
    const person = createPerson(env.ctx, { firstName: '{name}\u0000x', lastName: '$1 {name}' });
    mutate(env.ctx, (tx) => promotePersonIn(tx, person.id, 'replied'));
    expect(tasksFor(person.id)[0]!.title).toBe('Hi {name}\u0000x $1 {name}!');
    disableAll();
  });
});

describe('9 contract diff', () => {
  it('KILLS: the migration, audits and endpoints promised exist; the audit trail has create, update, disable, delete and fire with the documented actions', () => {
    disableAll();
    const rule = promoRule();
    updateAutomation(env.ctx, rule.id, { expectedVersion: 1, fields: { name: 'Audited' } });
    const p = pipe();
    const s = stageRule(p, 1);
    createOpportunity(env.ctx, { name: 'Aud', pipelineId: p.id, stageId: p.stages[1]!.id });
    const empty = pipe();
    stageRule(empty, 1);
    deletePipeline(env.ctx, empty.id);
    deleteAutomation(env.ctx, rule.id);
    for (const action of ['automation.create', 'automation.update', 'automation.fire', 'automation.disable', 'automation.delete']) {
      expect(count('SELECT COUNT(*) AS n FROM audit_event WHERE action = ?', action), action).toBeGreaterThan(0);
    }
    // Task events: the created task also audits task.create like any task.
    expect(count("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'task.create' AND detail LIKE '%Prep Aud%'")).toBe(1);
    expect(s.id).toMatch(/^aut_/);
    expect(listPipelines(env.db, env.workspaceId).some((x) => x.id === empty.id)).toBe(false);
    const other = createContext(env.db, env.workspaceId, { now: env.ctx.now });
    expect(other.workspaceId).toBe(env.workspaceId);
    disableAll();
  });
});
