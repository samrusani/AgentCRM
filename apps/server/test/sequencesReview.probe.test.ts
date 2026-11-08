// Adversarial review probes for the sequences wave: the five step follow-up cap, the 90 day ceiling at staging, and
// follow-up sequences (migration 028, actions/sequences.ts, queries/sequences.ts, /api/sequences).
// KILLS (attack fails, pinned), CONFIRMS (live defect, passes today, comment says the fix), ACCEPTED (documented limit).
// Nothing here changes application code.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applyChanges,
  createSequence,
  decideApproval,
  deleteSequence,
  prepareSendIntents,
  proposeChanges,
  tickFollowupRules,
  updateSequence,
  withActor,
} from '../src/actions/index.js';
import { readFrozenFollowups, followupStepsSchema } from '../src/actions/followupRules.js';
import { messageHash } from '../src/actions/sendIntentState.js';
import { resetAllData } from '../src/actions/workspace.js';
import { AppError } from '../src/errors.js';
import { buildApp } from '../src/http/app.js';
import { packageRoot } from '../src/paths.js';
import { listSequences } from '../src/queries/sequences.js';
import { type AgentmailStub, startAgentmailStub, useAgentmailStub } from './agentmailStub.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';
import { addDraft, addPerson, approve, connectMail, drain, markMailSynced } from './mailHelpers.js';

let agentmail: AgentmailStub;
let restoreAgentmail: () => void;
const environments: TestEnvironment[] = [];
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  agentmail = await startAgentmailStub();
  restoreAgentmail = useAgentmailStub(agentmail);
});
afterEach(() => agentmail.reset());
afterAll(async () => {
  await agentmail.close();
  restoreAgentmail();
  for (const env of environments) env.cleanup();
});

const day = 86_400_000;

async function freshEnv(): Promise<TestEnvironment> {
  const env = createTestEnvironment();
  environments.push(env);
  await connectMail(env);
  return env;
}

function warpTo(env: TestEnvironment, ms: number, options: { synced?: boolean } = {}): void {
  let time = ms;
  env.ctx.now = () => new Date(time++).toISOString();
  if (options.synced ?? true) markMailSynced(env);
}

interface RuleRow {
  id: string;
  person_id: string;
  intent_id: string;
  approval_id: string;
  status: string;
  steps: string;
  next_step: number;
  next_due_at: string | null;
  last_intent_id: string | null;
  stopped_reason: string | null;
}
const ruleRow = (env: TestEnvironment, id: string) => env.db.prepare('SELECT * FROM followup_rule WHERE id = ?').get(id) as RuleRow;
const stepIntents = (env: TestEnvironment, ruleId: string) =>
  env.db.prepare('SELECT * FROM send_intent WHERE followup_rule_id = ? ORDER BY followup_step').all(ruleId) as Record<string, any>[];
const intent = (env: TestEnvironment, id: string) => env.db.prepare('SELECT * FROM send_intent WHERE id = ?').get(id) as Record<string, any>;
const followupSent = () => agentmail.state.sent.filter((item) => item.subject.startsWith('Re:'));

let counter = 0;
const stepsFor = (tag: string, waits: number[]) => waits.map((waitDays, index) => ({ waitDays, body: `Step ${index + 1} of ${tag}: a distinct approved nudge.` }));

async function launch(env: TestEnvironment, name: string, waits = [1, 1, 1, 1, 1]) {
  counter += 1;
  const email = `${name.toLowerCase()}${counter}@lanternrow.invalid`;
  const person = addPerson(env, name, email);
  const draft = addDraft(env, person.id, `Hello ${name}${counter}`, `Hi ${name}, this is a test message.`);
  const steps = stepsFor(`${name}${counter}`, waits);
  const staged = prepareSendIntents(env.ctx, { draftActivityIds: [draft], followups: { steps } });
  approve(env, staged.approval!.id);
  await drain(env);
  const rule = env.db.prepare('SELECT id FROM followup_rule WHERE intent_id = ?').get(staged.intents[0]!.id) as { id: string };
  return { personId: person.id, anchorId: staged.intents[0]!.id, approvalId: staged.approval!.id, ruleId: rule.id, email, steps };
}

// One full step: arm, wait out the due time (plus `late`), create the step, send it, advance the rule.
async function runStep(env: TestEnvironment, ruleId: string, late = 1000) {
  tickFollowupRules(env.ctx);
  warpTo(env, Date.parse(ruleRow(env, ruleId).next_due_at!) + late);
  tickFollowupRules(env.ctx);
  await drain(env);
  tickFollowupRules(env.ctx);
}

// Leaves the rule armed with step `k` next.
async function armedAt(env: TestEnvironment, ruleId: string, k: number) {
  tickFollowupRules(env.ctx);
  while (ruleRow(env, ruleId).next_step < k) await runStep(env, ruleId);
  expect(ruleRow(env, ruleId)).toMatchObject({ status: 'armed', next_step: k });
}

// Leaves the rule `sending` step `k`: the step intent exists and has not been submitted.
async function sendingAt(env: TestEnvironment, ruleId: string, k: number) {
  await armedAt(env, ruleId, k);
  warpTo(env, Date.parse(ruleRow(env, ruleId).next_due_at!) + 1000);
  tickFollowupRules(env.ctx);
  expect(ruleRow(env, ruleId).status).toBe('sending');
  return intent(env, ruleRow(env, ruleId).last_intent_id!);
}

function insertInbound(env: TestEnvironment, personId: string, from: string, timestamp: string): void {
  env.db
    .prepare(
      `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, provider_thread_id, direction, person_id, from_email, "to", subject, preview, body_text, labels, provider_timestamp)
       VALUES (?, ?, ?, ?, 'thr_x', 'in', ?, ?, '[]', 'Re: hi', 'ok', 'ok', '[]', ?)`,
    )
    .run(env.ctx.newId('msg'), timestamp, env.workspaceId, `pm_${Math.random().toString(16).slice(2)}`, personId, from, timestamp);
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

const BLOCKED = 'The message no longer matches what was approved.';

describe('1 frozen text with five steps', () => {
  // KILLS: all five approved texts go out in order, byte for byte, one message each.
  it('KILLS: a five step plan sends exactly the five approved texts in order', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Five');
    for (let k = 1; k <= 5; k += 1) await runStep(env, launched.ruleId);
    expect(ruleRow(env, launched.ruleId)).toMatchObject({ status: 'done' });
    expect(stepIntents(env, launched.ruleId).map((row) => row.body)).toEqual(launched.steps.map((step) => step.body));
    expect(followupSent().map((item) => item.text)).toEqual(launched.steps.map((step) => step.body));
    expect(stepIntents(env, launched.ruleId).map((row) => row.status)).toEqual(Array(5).fill('accepted'));
  });

  // KILLS: one character of difference, in any of several disguises, blocks the step and sends nothing.
  it.each([
    ['one letter changed', (b: string) => b.replace('nudge', 'nudgf')],
    ['trailing space', (b: string) => `${b} `],
    ['zero width space inserted', (b: string) => b.replace('distinct', 'dis​tinct')],
    ['cyrillic homoglyph', (b: string) => b.replace('a', 'а')],
    ['line break swapped for space', (b: string) => b.replace(': a', ':\na')],
  ])('KILLS: step 4 text edited on the intent (%s) is blocked and rule stops', async (_label, mutateBody) => {
    const env = await freshEnv();
    const launched = await launch(env, 'Edit');
    const step = await sendingAt(env, launched.ruleId, 4);
    expect(step.body).toBe(launched.steps[3]!.body);
    const before = followupSent().length;
    env.db.prepare('UPDATE send_intent SET body = ? WHERE id = ?').run(mutateBody(step.body), step.id);
    await drain(env);
    expect(intent(env, step.id)).toMatchObject({ status: 'blocked', error: BLOCKED });
    expect(followupSent()).toHaveLength(before);
    tickFollowupRules(env.ctx);
    expect(ruleRow(env, launched.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'step_not_sent' });
  });

  // KILLS: recomputing the intent's own hash over a new text does not help, the approved payload still disagrees.
  it('KILLS: a step 5 body rewritten together with its payload_hash is still blocked', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Rehash');
    const step = await sendingAt(env, launched.ruleId, 5);
    const body = 'Totally different text that nobody approved.';
    const hash = messageHash({ intentId: step.id, to: step.to_email, subject: step.subject, body, inboxEmail: step.inbox_id });
    env.db.prepare('UPDATE send_intent SET body = ?, payload_hash = ? WHERE id = ?').run(body, hash, step.id);
    await drain(env);
    expect(intent(env, step.id).status).toBe('blocked');
    expect(followupSent()).toHaveLength(4);
  });

  // KILLS: editing the approved payload (the frozen plan) trips the approval payload hash.
  it('KILLS: editing step 4 inside the approval payload blocks the step', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Payload');
    const step = await sendingAt(env, launched.ruleId, 4);
    const row = env.db.prepare('SELECT payload FROM approval WHERE id = ?').get(launched.approvalId) as { payload: string };
    const payload = JSON.parse(row.payload);
    payload.followups.steps[3].body = 'Edited inside the approval payload text.';
    env.db.prepare('UPDATE approval SET payload = ? WHERE id = ?').run(JSON.stringify(payload), launched.approvalId);
    env.db.prepare('UPDATE send_intent SET body = ? WHERE id = ?').run('Edited inside the approval payload text.', step.id);
    await drain(env);
    expect(intent(env, step.id)).toMatchObject({ status: 'blocked', error: BLOCKED });
    expect(followupSent()).toHaveLength(3);
  });

  // KILLS: the rule row's copy of the steps is swapped (4 and 5) before the tick builds step 4; the intent then carries
  // step 5's words in slot 4 and the approved payload refuses it.
  it('KILLS: swapping steps 4 and 5 in the rule row blocks the step built from the swapped copy', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Swap');
    await armedAt(env, launched.ruleId, 4);
    const steps = JSON.parse(ruleRow(env, launched.ruleId).steps);
    [steps[3], steps[4]] = [steps[4], steps[3]];
    env.db.prepare('UPDATE followup_rule SET steps = ? WHERE id = ?').run(JSON.stringify(steps), launched.ruleId);
    warpTo(env, Date.parse(ruleRow(env, launched.ruleId).next_due_at!) + 1000);
    tickFollowupRules(env.ctx);
    const step = stepIntents(env, launched.ruleId).at(-1)!;
    expect(step.body).toBe(launched.steps[4]!.body); // the swapped copy
    await drain(env);
    expect(intent(env, step.id)).toMatchObject({ status: 'blocked', error: BLOCKED });
    expect(followupSent()).toHaveLength(3);
  });

  // KILLS: relabelling the step number (4 to 5) while keeping step 4's words.
  it('KILLS: an intent relabelled step 5 that holds step 4 text is blocked', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Relabel');
    const step = await sendingAt(env, launched.ruleId, 4);
    env.db.prepare('UPDATE send_intent SET followup_step = 5 WHERE id = ?').run(step.id);
    await drain(env);
    expect(intent(env, step.id).status).toBe('blocked');
    expect(followupSent()).toHaveLength(3);
  });

  // KILLS: a step from rule B pointed at rule A (and A's approval) is judged against A's payload and refused.
  it('KILLS: step text from a different approved rule is refused', async () => {
    const env = await freshEnv();
    const a = await launch(env, 'RuleA');
    const b = await launch(env, 'RuleB');
    // Bring both to step 4 sending. They are separate people, so both proceed.
    await armedAt(env, a.ruleId, 4);
    await armedAt(env, b.ruleId, 4);
    warpTo(env, Math.max(Date.parse(ruleRow(env, a.ruleId).next_due_at!), Date.parse(ruleRow(env, b.ruleId).next_due_at!)) + 1000);
    tickFollowupRules(env.ctx);
    const stepB = stepIntents(env, b.ruleId).at(-1)!;
    expect(stepB.body).toBe(b.steps[3]!.body);
    env.db.prepare('UPDATE send_intent SET followup_rule_id = ?, approval_id = ? WHERE id = ?').run(a.ruleId, a.approvalId, stepB.id);
    const before = followupSent().length;
    await drain(env);
    expect(intent(env, stepB.id)).toMatchObject({ status: 'blocked', error: BLOCKED });
    // A's own step 4 went out; B's stolen one did not.
    expect(followupSent()).toHaveLength(before + 1);
    expect(followupSent().some((item) => item.text === b.steps[3]!.body)).toBe(false);
  });

  // ACCEPTED: the submit check verifies TEXT against the approved step at the intent's own followup_step. It does not
  // check that steps go in order. A writer to the database who sets next_step 5 while armed at 4 makes the engine send
  // the genuine approved step 5 early. The text is still exactly what was approved; reaching this takes direct DB access.
  it('ACCEPTED: with direct DB access next_step can jump 4 to 5; only genuine approved text goes out', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Jump');
    await armedAt(env, launched.ruleId, 4);
    env.db.prepare('UPDATE followup_rule SET next_step = 5 WHERE id = ?').run(launched.ruleId);
    warpTo(env, Date.parse(ruleRow(env, launched.ruleId).next_due_at!) + 1000);
    tickFollowupRules(env.ctx);
    await drain(env);
    const last = stepIntents(env, launched.ruleId).at(-1)!;
    expect(last.followup_step).toBe(5);
    expect(last.body).toBe(launched.steps[4]!.body);
    expect(followupSent().at(-1)!.text).toBe(launched.steps[4]!.body);
  });

  // KILLS: backward compatibility. A payload approved before this wave carries at most two steps in the same shape.
  it('KILLS: a hand built two step payload from before the wave still reads', () => {
    const old = { messages: [], followups: { steps: [{ waitDays: 3, body: 'Just checking in on my note.' }, { waitDays: 5, body: 'One last nudge before I close.' }] } };
    expect(readFrozenFollowups(old)).toEqual(old.followups.steps);
    expect(readFrozenFollowups({ messages: [] })).toBeNull();
  });

  it('KILLS: an old two step payload approved through the real flow arms, sends both steps, and finishes', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Legacy', [2, 3]);
    const payload = JSON.parse((env.db.prepare('SELECT payload FROM approval WHERE id = ?').get(launched.approvalId) as { payload: string }).payload);
    expect(Object.keys(payload.followups)).toEqual(['steps']);
    expect(payload.followups.steps.map((step: object) => Object.keys(step))).toEqual([['waitDays', 'body'], ['waitDays', 'body']]);
    await runStep(env, launched.ruleId);
    await runStep(env, launched.ruleId);
    expect(ruleRow(env, launched.ruleId).status).toBe('done');
    expect(followupSent()).toHaveLength(2);
  });

  // KILLS/ACCEPTED: the ceiling is deliberately not in the zod schema so frozen payloads still parse. Pin both halves:
  // five 30 day steps parse from a frozen payload; six steps and malformed plans are still refused, so an approval
  // never silently drops the plan.
  it('KILLS: frozen payload parsing keeps the cap of five and refuses malformed plans instead of dropping them', () => {
    const big = { followups: { steps: Array.from({ length: 5 }, (_, i) => ({ waitDays: 30, body: `Frozen step number ${i} text.` })) } };
    expect(readFrozenFollowups(big)).toHaveLength(5); // sum 150 still reads: the ceiling is a staging rule
    for (const followups of [
      { steps: Array.from({ length: 6 }, (_, i) => ({ waitDays: 1, body: `Frozen step number ${i} text.` })) },
      { steps: [] },
      null,
      false,
      [],
      { steps: [{ waitDays: 1, body: 'Frozen step text here.' }], extra: 1 },
      { steps: [{ waitDays: 1, body: 'Frozen step text here.', extra: 1 }] },
    ]) {
      expect(rejected(() => readFrozenFollowups({ followups })).code).toBe('conflict');
    }
    expect(followupStepsSchema.safeParse(big.followups.steps).success).toBe(true);
  });
});

describe('2 stops mid sequence', () => {
  type Stop = [string, (env: TestEnvironment, l: Awaited<ReturnType<typeof launch>>) => void, string];
  const stops: Stop[] = [
    ['reply', (env, l) => insertInbound(env, l.personId, l.email, new Date(Date.parse(env.ctx.now()) + 1).toISOString()), 'replied'],
    ['suppression (manual)', (env, l) => void env.db.prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES (?, ?, ?, ?, 'manual', 't')").run(env.ctx.newId('sup'), env.ctx.now(), env.workspaceId, l.email), 'suppressed'],
    ['opt out', (env, l) => void env.db.prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES (?, ?, ?, ?, 'opt_out', 't')").run(env.ctx.newId('sup'), env.ctx.now(), env.workspaceId, l.email), 'suppressed'],
    ['bounce of step 3', (env, l) => void env.db.prepare("UPDATE send_intent SET status = 'bounced' WHERE followup_rule_id = ? AND followup_step = 3").run(l.ruleId), 'bounced'],
  ];
  it.each(stops)('KILLS: %s after step 3 stops steps 4 and 5', async (_label, apply, reason) => {
    const env = await freshEnv();
    const launched = await launch(env, 'Stopper');
    for (let k = 1; k <= 3; k += 1) await runStep(env, launched.ruleId);
    expect(followupSent()).toHaveLength(3);
    apply(env, launched);
    tickFollowupRules(env.ctx);
    expect(ruleRow(env, launched.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: reason });
    warpTo(env, Date.now() + 40 * day);
    for (let i = 0; i < 3; i += 1) tickFollowupRules(env.ctx);
    await drain(env);
    expect(stepIntents(env, launched.ruleId)).toHaveLength(3);
    expect(followupSent()).toHaveLength(3);
  });

  // KILLS: step 4 created, then a reply lands before submit: the recheck blocks it and nothing is sent.
  it('KILLS: a reply between creating step 5 and submitting it blocks the send', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Late');
    const step = await sendingAt(env, launched.ruleId, 5);
    insertInbound(env, launched.personId, launched.email, new Date(Date.parse(env.ctx.now()) + 5).toISOString());
    await drain(env);
    expect(['blocked', 'cancelled']).toContain(intent(env, step.id).status);
    expect(followupSent()).toHaveLength(4);
  });

  // KILLS: the sync gate holds at every one of the five steps.
  it('KILLS: the sync gate holds per step: no step 1..5 is created until a poll finishes after its due time', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Gate');
    for (let k = 1; k <= 5; k += 1) {
      tickFollowupRules(env.ctx);
      const due = Date.parse(ruleRow(env, launched.ruleId).next_due_at!);
      warpTo(env, due + 1000, { synced: false });
      markMailSynced(env, new Date(due - 1000).toISOString()); // last poll finished before the due time
      tickFollowupRules(env.ctx);
      expect(stepIntents(env, launched.ruleId)).toHaveLength(k - 1);
      expect(ruleRow(env, launched.ruleId)).toMatchObject({ status: 'armed', next_step: k });
      markMailSynced(env); // a poll finishes after the due time
      tickFollowupRules(env.ctx);
      expect(stepIntents(env, launched.ruleId)).toHaveLength(k);
      await drain(env);
      tickFollowupRules(env.ctx);
    }
    expect(ruleRow(env, launched.ruleId).status).toBe('done');
  });

  it('KILLS: one active rule per person still holds at approval with five step plans', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Once', 'once@lanternrow.invalid');
    const steps = stepsFor('once', [1, 1, 1, 1, 1]);
    const first = prepareSendIntents(env.ctx, { draftActivityIds: [addDraft(env, person.id, 'Topic A', 'Body A is here.')], followups: { steps } });
    const second = prepareSendIntents(env.ctx, { draftActivityIds: [addDraft(env, person.id, 'Topic B', 'Body B is here.')], followups: { steps } });
    approve(env, first.approval!.id);
    const decision = approve(env, second.approval!.id) as any;
    expect(decision.followupSkipped).toEqual([expect.objectContaining({ personId: person.id, reason: 'active_rule' })]);
    const active = env.db.prepare("SELECT id FROM followup_rule WHERE person_id = ? AND status IN ('waiting','armed','sending')").all(person.id);
    expect(active).toHaveLength(1);
  });

  it('KILLS: the 7 day overdue expiry fires at step 4 with a task and no send', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Overdue');
    await armedAt(env, launched.ruleId, 4);
    warpTo(env, Date.parse(ruleRow(env, launched.ruleId).next_due_at!) + 7 * day + 5000);
    tickFollowupRules(env.ctx);
    expect(ruleRow(env, launched.ruleId)).toMatchObject({ status: 'expired', stopped_reason: 'overdue' });
    await drain(env);
    expect(followupSent()).toHaveLength(3);
  });

  // ACCEPTED (documented): a plan whose waits sum to 89 can still expire with reason ceiling when each send is late (inside
  // the 7 day overdue window) so the last step comes due more than 90 days after approval. Staging cannot predict slips.
  it('ACCEPTED: an 89 day plan whose steps are each sent six days late expires with reason ceiling and a task', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Slip', [18, 18, 18, 18, 17]);
    expect(launched.steps.reduce((sum, step) => sum + step.waitDays, 0)).toBe(89);
    for (let guard = 0; guard < 6 && ruleRow(env, launched.ruleId).status !== 'expired'; guard += 1) {
      if (ruleRow(env, launched.ruleId).status === 'done') break;
      await runStep(env, launched.ruleId, 6 * day);
    }
    const rule = ruleRow(env, launched.ruleId);
    expect(rule).toMatchObject({ status: 'expired', stopped_reason: 'ceiling' });
    expect(stepIntents(env, launched.ruleId).length).toBeLessThan(5);
    const tasks = env.db.prepare('SELECT title FROM task WHERE entity_id = ?').all(launched.personId) as { title: string }[];
    expect(tasks.length).toBeGreaterThan(0);
  });
});

describe('3 the ceiling at staging', () => {
  const stage = (env: TestEnvironment, waits: number[], extra: Record<string, unknown> = {}) => {
    const person = addPerson(env, 'Ceil', `ceil${(counter += 1)}@lanternrow.invalid`);
    const draft = addDraft(env, person.id, 'Hello ceil', 'Hi, a message.');
    return () => prepareSendIntents(env.ctx, { draftActivityIds: [draft], followups: { steps: stepsFor('c', waits) }, ...extra });
  };
  const counts = (env: TestEnvironment) => ({
    intents: (env.db.prepare('SELECT COUNT(*) AS n FROM send_intent').get() as { n: number }).n,
    approvals: (env.db.prepare('SELECT COUNT(*) AS n FROM approval').get() as { n: number }).n,
    runs: (env.db.prepare('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n,
  });

  it('KILLS: sum 90 refused in every split, nothing staged; 89 accepted; six steps refused', async () => {
    const env = await freshEnv();
    for (const waits of [[30, 30, 30], [18, 18, 18, 18, 18], [30, 30, 20, 5, 5], [30, 30, 29, 1]]) {
      const before = counts(env);
      const error = rejected(stage(env, waits));
      expect(error.code).toBe('validation');
      expect(error.message).toMatch(/^The waits add up to \d+ days; follow-ups stop after 90 days\. Shorten a wait or remove a step\.$/);
      expect(counts(env)).toEqual(before);
    }
    for (const waits of [[30, 30, 29], [17, 18, 18, 18, 18], [1]]) expect(stage(env, waits)().approval).not.toBeNull();
    const before = counts(env);
    expect(rejected(stage(env, [1, 1, 1, 1, 1, 1])).code).toBe('validation');
    expect(counts(env)).toEqual(before);
  });

  // KILLS: the server check sits in prepareSendIntents, so the HTTP route cannot be used to skip what the UI enforces.
  it('KILLS: POST /api/send-intents refuses sum 90 and six steps directly', async () => {
    const env = await freshEnv();
    const app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
    await app.ready();
    try {
      const person = addPerson(env, 'Route', 'route@lanternrow.invalid');
      const draft = addDraft(env, person.id, 'Hello route', 'Hi, a message.');
      const before = counts(env);
      for (const waits of [[30, 30, 30], [1, 1, 1, 1, 1, 1]]) {
        const response = await app.inject({ method: 'POST', url: '/api/send-intents', headers: host, payload: { draftActivityIds: [draft], followups: { steps: stepsFor('r', waits) } } });
        expect(response.statusCode).toBe(400);
      }
      expect(counts(env)).toEqual(before);
      const ok = await app.inject({ method: 'POST', url: '/api/send-intents', headers: host, payload: { draftActivityIds: [draft], followups: { steps: stepsFor('r', [30, 30, 29]) } } });
      expect(ok.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it('KILLS: the ceiling is enforced on stringy and fractional waits only through the schema (no coercion past it)', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Coerce', 'coerce@lanternrow.invalid');
    const draft = addDraft(env, person.id, 'Hello coerce', 'Hi, a message.');
    for (const waitDays of ['30', 30.5, Number.NaN, -1, 31, null]) {
      const steps = [{ waitDays, body: 'A perfectly fine nudge text.' }];
      expect(rejected(() => prepareSendIntents(env.ctx, { draftActivityIds: [draft], followups: { steps } })).code).toBe('validation');
    }
  });
});

describe('4 sequences never touch sends', () => {
  it('KILLS: mutating then deleting the sequence between staging and sending leaves the sent text byte identical and no sequence id anywhere on the send path', async () => {
    const env = await freshEnv();
    const saved = createSequence(env.ctx, { name: 'Sqn Secret Name', steps: stepsFor('seq', [1, 1, 1]) });
    const person = addPerson(env, 'Seq', 'seq@lanternrow.invalid');
    const draft = addDraft(env, person.id, 'Hello seq', 'Hi, a message.');
    const staged = prepareSendIntents(env.ctx, { draftActivityIds: [draft], followups: { steps: saved.steps } });
    updateSequence(env.ctx, saved.id, { expectedVersion: 1, fields: { steps: [{ waitDays: 1, body: 'REPLACED sequence text, never to be sent.' }] } });
    approve(env, staged.approval!.id);
    await drain(env);
    const rule = env.db.prepare('SELECT id FROM followup_rule WHERE intent_id = ?').get(staged.intents[0]!.id) as { id: string };
    await runStep(env, rule.id);
    deleteSequence(env.ctx, saved.id);
    await runStep(env, rule.id);
    await runStep(env, rule.id);
    expect(ruleRow(env, rule.id).status).toBe('done');
    expect(followupSent().map((item) => item.text)).toEqual(saved.steps.map((step) => step.body));
    expect(ruleRow(env, rule.id).steps).toBe(JSON.stringify(saved.steps));
    const dump = JSON.stringify([
      env.db.prepare('SELECT * FROM followup_rule').all(),
      env.db.prepare('SELECT * FROM send_intent').all(),
      env.db.prepare('SELECT * FROM approval').all(),
      env.db.prepare("SELECT * FROM audit_event WHERE action NOT LIKE 'sequence.%'").all(),
      env.db.prepare('SELECT * FROM run').all(),
    ]);
    expect(dump).not.toContain(saved.id);
    expect(dump).not.toContain('Sqn Secret Name');
    expect(dump).not.toContain('REPLACED sequence text');
  });

  it('KILLS: only the sequence modules, routes, and the index reference the sequence table or its modules', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
    const allowed = new Set(['actions/sequences.ts', 'queries/sequences.ts', 'http/routes.ts', 'actions/index.ts']);
    const offenders = walk(path.join(packageRoot, 'src'))
      .map((file) => path.relative(path.join(packageRoot, 'src'), file))
      .filter((file) => file.endsWith('.ts') && !allowed.has(file))
      .filter((file) => /\b(FROM|INTO|UPDATE|JOIN)\s+sequence\b|queries\/sequences|actions\/sequences|requireSequence|getSequence/.test(readFileSync(path.join(packageRoot, 'src', file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  // The full wipe clears sequence rows like every other table with a workspace foreign key, so a saved sequence can
  // never block it (resetAllData lists 'sequence' next to 'automation').
  it('KILLS: resetAllData wipes cleanly when a sequence exists', async () => {
    const env = createTestEnvironment();
    environments.push(env);
    const person = addPerson(env, 'Wipe', 'wipe@lanternrow.invalid');
    createSequence(env.ctx, { name: 'Never blocks the wipe', steps: stepsFor('w', [2]) });
    resetAllData(env.db);
    expect((env.db.prepare('SELECT COUNT(*) AS n FROM person WHERE id = ?').get(person.id) as { n: number }).n).toBe(0);
    expect((env.db.prepare('SELECT COUNT(*) AS n FROM sequence').get() as { n: number }).n).toBe(0);
  });
});

describe('5 CRUD hygiene', () => {
  const env = createTestEnvironment();
  let app: FastifyInstance;
  const ok = (n = 1) => ({ waitDays: 2, body: `Follow-up text number ${n} for a sequence.` });
  beforeAll(async () => {
    app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    env.cleanup();
  });
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.inject({ method, url, headers: { ...host, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: response.statusCode, body: response.body ? (response.json() as Record<string, any>) : {} };
  };

  it('KILLS: leading, trailing, and embedded control characters in names are refused (NUL first)', () => {
    for (const name of ['\u0000abc', 'abc\u0000', 'a\u0000b', '\u001fabc', '\u0080abc', '\u009fabc', '\u007f', '\u0000']) {
      expect(rejected(() => createSequence(env.ctx, { name, steps: [ok()] })).code).toBe('validation');
    }
    expect(listSequences(env.db, env.workspaceId).filter((item) => /[\u0000-\u001f\u007f-\u009f]/.test(item.name))).toHaveLength(0);
  });

  // ACCEPTED: only C0, DEL and C1 controls are refused. Bidi overrides, zero width characters, and line/paragraph
  // separators pass in a name. The UI renders names as text (web probe), so this is cosmetic spoofing within the user's
  // own settings list, not a send path.
  it('ACCEPTED: bidi, zero width, and U+2028 characters are allowed in names and stored verbatim', () => {
    for (const name of ['evil‮gnp.txt', 'zero​width', 'line sep', '﻿bom']) {
      const made = createSequence(env.ctx, { name, steps: [ok()] });
      expect(made.name).toBe(name.trim());
      deleteSequence(env.ctx, made.id);
    }
  });

  it('KILLS: step bodies at 9 and 2001 characters are refused, 10 and 2000 accepted; hostile bodies stored as plain text', () => {
    for (const body of ['x'.repeat(9), 'x'.repeat(2001), `   ${'x'.repeat(9)}   `]) {
      expect(rejected(() => createSequence(env.ctx, { name: 'Body', steps: [{ waitDays: 2, body }] })).code).toBe('validation');
    }
    const hostile = ['<script>alert(1)</script>', '‮evil bidi text', '{{first_name}} ${x} <b>bold</b>'].map((body) => ({ waitDays: 2, body }));
    const made = createSequence(env.ctx, { name: 'Hostile', steps: [...hostile, { waitDays: 1, body: 'x'.repeat(2000) }, { waitDays: 1, body: 'x'.repeat(10) }] });
    expect(made.steps.map((step) => step.body)).toEqual([...hostile.map((step) => step.body), 'x'.repeat(2000), 'x'.repeat(10)]);
    deleteSequence(env.ctx, made.id);
  });

  it('KILLS: non-array and wrongly shaped steps, extra keys, and top level extras are refused', () => {
    const bad: unknown[] = [undefined, null, 'string', 7, {}, { 0: ok() }, [null], [[ok()]], [{ waitDays: 2 }], [{ body: ok().body }], [{ ...ok(), __proto__x: 1, extra: 1 }], new Array(6).fill(ok())];
    for (const steps of bad) expect(rejected(() => createSequence(env.ctx, { name: 'Shape', steps })).code).toBe('validation');
    expect(rejected(() => createSequence(env.ctx, { name: 'Extra', steps: [ok()], id: 'sqn_x' })).code).toBe('validation');
    expect(rejected(() => createSequence(env.ctx, { name: 'Extra', steps: [ok()], version: 9, workspaceId: 'wsp_other' })).code).toBe('validation');
    expect(rejected(() => createSequence(env.ctx, 'nope')).code).toBe('validation');
    expect(rejected(() => createSequence(env.ctx, null)).code).toBe('validation');
  });

  it('KILLS: version conflicts, bad expectedVersion shapes, and ceiling on update leave the row untouched', () => {
    const made = createSequence(env.ctx, { name: 'Versions', steps: [ok()] });
    for (const expectedVersion of [0, -1, 1.5, '1', null, undefined]) {
      expect(rejected(() => updateSequence(env.ctx, made.id, { expectedVersion, fields: { name: 'X' } })).code).toBe('validation');
    }
    expect(rejected(() => updateSequence(env.ctx, made.id, { expectedVersion: 2, fields: { name: 'X' } })).code).toBe('version_conflict');
    expect(rejected(() => updateSequence(env.ctx, made.id, { expectedVersion: 1, fields: { steps: [30, 30, 30].map((waitDays) => ({ waitDays, body: ok().body })) } })).code).toBe('validation');
    expect(rejected(() => updateSequence(env.ctx, 'not an id', { expectedVersion: 1, fields: { name: 'X' } })).code).not.toBe('internal');
    const row = listSequences(env.db, env.workspaceId).find((item) => item.id === made.id)!;
    expect(row).toMatchObject({ name: 'Versions', version: 1 });
    deleteSequence(env.ctx, made.id);
  });

  it('KILLS: a second delete answers not_found, never a 5xx; hostile ids are 4xx', async () => {
    const made = createSequence(env.ctx, { name: 'Twice', steps: [ok()] });
    expect((await call('DELETE', `/api/sequences/${made.id}`)).status).toBe(204);
    expect((await call('DELETE', `/api/sequences/${made.id}`)).status).toBe(404);
    for (const id of ['x', '%00', "sqn_' OR 1=1 --", 'sqn_' + 'a'.repeat(500), '..%2F..%2Fetc']) {
      const status = (await call('DELETE', `/api/sequences/${id}`)).status;
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
  });

  it('KILLS: the Origin guard refuses cross-site POST, PATCH, and DELETE and changes nothing', async () => {
    const made = createSequence(env.ctx, { name: 'Guarded', steps: [ok()] });
    const evil = { origin: 'https://evil.example' };
    expect((await call('POST', '/api/sequences', { name: 'Evil', steps: [ok()] }, evil)).status).toBeGreaterThanOrEqual(400);
    expect((await call('PATCH', `/api/sequences/${made.id}`, { expectedVersion: 1, fields: { name: 'Evil' } }, evil)).status).toBeGreaterThanOrEqual(400);
    expect((await call('DELETE', `/api/sequences/${made.id}`, undefined, evil)).status).toBeGreaterThanOrEqual(400);
    const rows = listSequences(env.db, env.workspaceId);
    expect(rows.find((item) => item.id === made.id)).toMatchObject({ name: 'Guarded', version: 1 });
    expect(rows.some((item) => item.name === 'Evil')).toBe(false);
    deleteSequence(env.ctx, made.id);
  });

  it('KILLS: workspace isolation holds over HTTP lists and by id', async () => {
    env.db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_seqprobe', '2026-03-02T00:00:00.000Z', 'Other', 'startup-fundraising');
    env.db
      .prepare('INSERT INTO sequence (id, created_at, workspace_id, version, name, steps, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .run('sqn_foreign0001', '2026-03-02T00:00:00.000Z', 'wsp_seqprobe', 'Foreign', JSON.stringify([ok()]), '2026-03-02T00:00:00.000Z');
    const listed = await call('GET', '/api/sequences');
    expect(listed.body.items.some((item: any) => item.id === 'sqn_foreign0001')).toBe(false);
    expect((await call('PATCH', '/api/sequences/sqn_foreign0001', { expectedVersion: 1, fields: { name: 'Taken' } })).status).toBe(404);
    expect((await call('DELETE', '/api/sequences/sqn_foreign0001')).status).toBe(404);
  });

  // ACCEPTED (robustness, low): a stored row whose steps JSON is corrupt reads as zero steps via parseSteps rather than
  // failing, so one bad row cannot take the list down; but the preset then appears as a 0 step sequence the UI can offer.
  // Staging still validates whatever the editor holds, so no send risk. Fix if wanted: skip or flag unreadable rows.
  it('ACCEPTED: a corrupt steps column lists as an empty sequence instead of failing the list', async () => {
    env.db
      .prepare('INSERT INTO sequence (id, created_at, workspace_id, version, name, steps, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .run('sqn_corrupt00001', '2026-03-03T00:00:00.000Z', env.workspaceId, 'Corrupt', '{not json', '2026-03-03T00:00:00.000Z');
    const listed = await call('GET', '/api/sequences');
    expect(listed.status).toBe(200);
    expect(listed.body.items.find((item: any) => item.id === 'sqn_corrupt00001').steps).toEqual([]);
    env.db.prepare('DELETE FROM sequence WHERE id = ?').run('sqn_corrupt00001');
  });
});

describe('6 agent surfaces', () => {
  it('KILLS: proposals and applies refuse the sequence entity type; no model, MCP, or CLI source mentions sequences', () => {
    const env = createTestEnvironment();
    environments.push(env);
    const saved = createSequence(env.ctx, { name: 'Closed', steps: stepsFor('a', [2]) });
    const agent = withActor(env.ctx, 'agent:probe');
    for (const run of [
      () => proposeChanges(agent, { changes: [{ entityType: 'sequence', id: saved.id, fields: { name: 'Hacked' } }] }),
      () => applyChanges(agent, { proposalHash: 'a'.repeat(64), changes: [{ entityType: 'sequence', id: saved.id, expectedVersion: 1, fields: { name: 'Hacked' } }] }),
    ]) {
      expect(rejected(run).code).toBe('validation');
    }
    expect(listSequences(env.db, env.workspaceId)[0]).toMatchObject({ name: 'Closed', version: 1 });
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
    for (const dir of ['mcp', 'agent']) {
      for (const file of walk(path.join(packageRoot, 'src', dir))) {
        expect(readFileSync(file, 'utf8').toLowerCase(), file).not.toContain('sequence');
      }
    }
    expect(readFileSync(path.join(packageRoot, 'src/cli.ts'), 'utf8').toLowerCase()).not.toMatch(/sequences|sqn/);
  });

  // KILLS: agents have no path to staging, deciding, or stopping sends: neither the MCP server nor the chat agent imports
  // those actions or the sequence actions, and the HTTP routes are not reachable from a model tool.
  it('KILLS: the MCP server and the chat agent never import the send, approval, follow-up, or sequence actions', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
    for (const dir of ['mcp', 'agent']) {
      for (const file of walk(path.join(packageRoot, 'src', dir))) {
        expect(readFileSync(file, 'utf8'), file).not.toMatch(/prepareSendIntents|decideApproval|controlSendIntent|stopFollowupRule|tickFollowupRules|createSequence|api\/send-intents|api\/sequences/);
      }
    }
  });
});
