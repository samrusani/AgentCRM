import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  addSuppression,
  createContext,
  decideApproval,
  disconnectAgentmailConnector,
  prepareSendIntents,
  setMailProvider,
  stopFollowupRule,
  tickFollowupRules,
  tickFollowupRulesIfDue,
} from '../src/actions/index.js';
import { resetAllData } from '../src/actions/workspace.js';
import { dueAfter, followupReplyReference } from '../src/actions/followupRules.js';
import { processMailJobs } from '../src/jobs/worker.js';
import { unknownSendTaskTitle } from '../src/mail/rules.js';
import { openDatabase } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { followupStaleSentence, followupSubject } from '../src/mail/rules.js';
import { buildApp } from '../src/http/app.js';
import { headerValue, parseMime } from '../src/providers/mime.js';
import { listFollowupRules } from '../src/queries/followupRules.js';
import { listSendIntents } from '../src/queries/sendIntents.js';
import { type AgentmailStub, startAgentmailStub, useAgentmailStub } from './agentmailStub.js';
import { type GoogleStub, startGoogleStub, useGoogleStub } from './googleStub.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';
import { type MicrosoftStub, startMicrosoftStub, useMicrosoftStub } from './microsoftStub.js';
import { addDraft, addPerson, approve, connectGmail, connectImap, connectMail, connectMicrosoft, drain, insertAcceptedToday, intentOf, markMailSynced, stage, statusOf } from './mailHelpers.js';
import { type FakeMailTransport, useMailTransportStub } from './mailTransportStub.js';

let agentmail: AgentmailStub;
let google: GoogleStub;
let ms: MicrosoftStub;
let imap: FakeMailTransport;
let restoreAgentmail: () => void;
let restoreGoogle: () => void;
let restoreMicrosoft: () => void;
let restoreImap: () => void;
const environments: TestEnvironment[] = [];

beforeAll(async () => {
  agentmail = await startAgentmailStub();
  restoreAgentmail = useAgentmailStub(agentmail);
  google = await startGoogleStub();
  restoreGoogle = useGoogleStub(google);
  ms = await startMicrosoftStub();
  restoreMicrosoft = useMicrosoftStub(ms);
  ({ stub: imap, restore: restoreImap } = useMailTransportStub());
});

afterEach(() => {
  agentmail.reset();
  google.reset();
  ms.reset();
  imap.reset();
});

afterAll(async () => {
  await agentmail.close();
  await google.close();
  await ms.close();
  restoreMicrosoft();
  restoreAgentmail();
  restoreGoogle();
  restoreImap();
  for (const env of environments) env.cleanup();
});

const day = 86_400_000;
const steps = [
  { waitDays: 3, body: 'Just checking in on my note from last week.' },
  { waitDays: 5, body: 'One last nudge before I close this out.' },
];

async function freshEnv(kind: 'agentmail' | 'imap' | 'gmail' | 'microsoft' = 'agentmail'): Promise<TestEnvironment> {
  const env = createTestEnvironment();
  environments.push(env);
  if (kind === 'imap') await connectImap(env);
  else if (kind === 'gmail') await connectGmail(env, google);
  else if (kind === 'microsoft') await connectMicrosoft(env, ms);
  else await connectMail(env);
  return env;
}

// Moves the test clock. It keeps counting up one millisecond per call, like the default clock. By default the mailbox
// counts as freshly polled at the new time, so a due step may be created; pass `synced: false` to leave the poll record
// as it was.
function warpTo(env: TestEnvironment, isoOrMs: string | number, options: { synced?: boolean } = {}): void {
  let time = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  env.ctx.now = () => new Date(time++).toISOString();
  if (options.synced ?? true) markMailSynced(env);
}

interface RuleRow {
  id: string;
  person_id: string;
  intent_id: string;
  approval_id: string;
  provider: string;
  status: string;
  steps: string;
  next_step: number;
  next_due_at: string | null;
  last_intent_id: string | null;
  stopped_reason: string | null;
}

function ruleRow(env: TestEnvironment, ruleId: string): RuleRow {
  return env.db.prepare('SELECT * FROM followup_rule WHERE id = ?').get(ruleId) as RuleRow;
}

function ruleCount(env: TestEnvironment, where = '1 = 1'): number {
  return (env.db.prepare(`SELECT COUNT(*) AS n FROM followup_rule WHERE ${where}`).get() as { n: number }).n;
}

function stepIntents(env: TestEnvironment, ruleId: string) {
  return env.db.prepare('SELECT * FROM send_intent WHERE followup_rule_id = ? ORDER BY followup_step').all(ruleId) as Record<string, any>[];
}

function auditActions(env: TestEnvironment, entityId: string): string[] {
  return (env.db.prepare('SELECT action FROM audit_event WHERE entity_id = ? ORDER BY rowid').all(entityId) as { action: string }[]).map((row) => row.action);
}

function taskTitles(env: TestEnvironment): string[] {
  return (env.db.prepare("SELECT title FROM task WHERE status = 'open'").all() as { title: string }[]).map((row) => row.title);
}

interface Launched {
  personId: string;
  anchorId: string;
  approvalId: string;
  ruleId: string;
  email: string;
}

let counter = 0;

// Stages one draft with a follow-up plan, approves it, and sends the first message.
async function launch(env: TestEnvironment, name: string, options: { subject?: string; steps?: typeof steps; send?: boolean } = {}): Promise<Launched> {
  counter += 1;
  const email = `${name.toLowerCase()}${counter}@lanternrow.invalid`;
  const person = addPerson(env, name, email);
  const draft = addDraft(env, person.id, options.subject ?? `Hello ${name}`, `Hi ${name}, this is a test message.`);
  const staged = prepareSendIntents(env.ctx, { draftActivityIds: [draft], followups: { steps: options.steps ?? steps } });
  approve(env, staged.approval!.id);
  if (options.send ?? true) await drain(env);
  const rule = env.db.prepare('SELECT id FROM followup_rule WHERE intent_id = ?').get(staged.intents[0]!.id) as { id: string };
  return { personId: person.id, anchorId: staged.intents[0]!.id, approvalId: staged.approval!.id, ruleId: rule.id, email };
}

// Launches, arms the rule, and moves the clock one second past the due time.
async function launchDue(env: TestEnvironment, name: string, options: { subject?: string; steps?: typeof steps } = {}): Promise<Launched> {
  const launched = await launch(env, name, options);
  tickFollowupRules(env.ctx);
  expect(ruleRow(env, launched.ruleId).status).toBe('armed');
  warpTo(env, Date.parse(ruleRow(env, launched.ruleId).next_due_at!) + 1000);
  return launched;
}

// Launches and runs the first step intent into the queue (not yet submitted).
async function launchSending(env: TestEnvironment, name: string): Promise<Launched & { stepId: string }> {
  const launched = await launchDue(env, name);
  tickFollowupRules(env.ctx);
  const rule = ruleRow(env, launched.ruleId);
  expect(rule.status).toBe('sending');
  return { ...launched, stepId: rule.last_intent_id! };
}

function insertInbound(env: TestEnvironment, personId: string, from: string, timestamp: string): void {
  env.db
    .prepare(
      `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, provider_thread_id, direction, person_id, from_email, "to", subject, preview, body_text, labels, provider_timestamp)
       VALUES (?, ?, ?, ?, 'thr_x', 'in', ?, ?, '[]', 'Re: hi', 'ok', 'ok', '[]', ?)`,
    )
    .run(env.ctx.newId('msg'), timestamp, env.workspaceId, `pm_${Math.random().toString(16).slice(2)}`, personId, from, timestamp);
}

function localTime(year: number, month: number, dayOfMonth: number, hour: number): string {
  return new Date(year, month - 1, dayOfMonth, hour, 0, 0).toISOString();
}

describe('staging with a follow-up plan', () => {
  it('carries the steps in the hashed payload and creates one waiting rule per queued intent on approval', async () => {
    const env = await freshEnv();
    const one = addPerson(env, 'Ada', 'ada@lanternrow.invalid');
    const two = addPerson(env, 'Bo', 'bo@lanternrow.invalid');
    const drafts = [addDraft(env, one.id, 'Intro one', 'Body one'), addDraft(env, two.id, 'Intro two', 'Body two')];
    const staged = prepareSendIntents(env.ctx, { draftActivityIds: drafts, followups: { steps: [{ waitDays: 2, body: '  Padded nudge text here.  ' }] } });
    expect((staged.approval!.payload as any).followups).toEqual({ steps: [{ waitDays: 2, body: 'Padded nudge text here.' }] });
    expect((staged.approval!.payload as any).mailProvider).toBe('agentmail');
    expect(ruleCount(env)).toBe(0);

    // One of the two is cancelled before the decision, so only the other gets a rule.
    env.db.prepare("UPDATE send_intent SET status = 'cancelled' WHERE id = ?").run(staged.intents[1]!.id);
    approve(env, staged.approval!.id);
    expect(ruleCount(env)).toBe(1);
    const rule = env.db.prepare('SELECT * FROM followup_rule').get() as RuleRow;
    expect(rule).toMatchObject({
      person_id: one.id,
      intent_id: staged.intents[0]!.id,
      approval_id: staged.approval!.id,
      provider: 'agentmail',
      status: 'waiting',
      next_step: 1,
      next_due_at: null,
      last_intent_id: null,
      stopped_reason: null,
    });
    expect(rule.id).toMatch(/^fur_[0-9a-f]{12}$/);
    expect(JSON.parse(rule.steps)).toEqual([{ waitDays: 2, body: 'Padded nudge text here.' }]);
    expect(auditActions(env, rule.id)).toEqual(['followup_rule.create']);
  });

  it('creates no rule when the approval is rejected or an intent is blocked at approval', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Cy', 'cy@lanternrow.invalid');
    const staged = prepareSendIntents(env.ctx, { draftActivityIds: [addDraft(env, person.id, 'Hi Cy', 'Body')], followups: { steps } });
    decideApproval(env.ctx, staged.approval!.id, { decision: 'reject' });
    expect(ruleCount(env)).toBe(0);

    const other = addPerson(env, 'Di', 'di@lanternrow.invalid');
    const second = prepareSendIntents(env.ctx, { draftActivityIds: [addDraft(env, other.id, 'Hi Di', 'Body')], followups: { steps } });
    addSuppression(env.ctx, { email: 'di@lanternrow.invalid' });
    approve(env, second.approval!.id);
    expect(statusOf(env, second.intents[0]!.id)).toBe('blocked');
    expect(ruleCount(env)).toBe(0);
  });

  it('keeps a payload without followups working and refuses a payload that gained a plan after hashing', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Ed', 'ed@lanternrow.invalid');
    const plain = stage(env, [addDraft(env, person.id, 'Hi Ed', 'Body')]);
    expect((plain.approval!.payload as any).followups).toBeUndefined();
    approve(env, plain.approval!.id);
    expect(statusOf(env, plain.intents[0]!.id)).toBe('queued');
    expect(ruleCount(env)).toBe(0);

    const other = addPerson(env, 'Flo', 'flo@lanternrow.invalid');
    const tampered = stage(env, [addDraft(env, other.id, 'Hi Flo', 'Body')]);
    const payload = { ...(tampered.approval!.payload as object), followups: { steps } };
    env.db.prepare('UPDATE approval SET payload = ? WHERE id = ?').run(JSON.stringify(payload), tampered.approval!.id);
    expect(() => approve(env, tampered.approval!.id)).toThrow(/changed after it was created/);
    expect(ruleCount(env)).toBe(0);
  });

  it('validates the plan', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Gus', 'gus@lanternrow.invalid');
    const draft = addDraft(env, person.id, 'Hi Gus', 'Body');
    const stageWith = (followups: unknown) => () => prepareSendIntents(env.ctx, { draftActivityIds: [draft], followups });
    const good = { waitDays: 2, body: 'A perfectly fine follow-up.' };
    expect(stageWith({ steps: [] })).toThrow(AppError);
    expect(stageWith({ steps: [good, good, good] })).toThrow(AppError);
    expect(stageWith({ steps: [{ ...good, waitDays: 0 }] })).toThrow(AppError);
    expect(stageWith({ steps: [{ ...good, waitDays: 31 }] })).toThrow(AppError);
    expect(stageWith({ steps: [{ ...good, waitDays: 1.5 }] })).toThrow(AppError);
    expect(stageWith({ steps: [{ ...good, body: '   too short ' }] })).toThrow(AppError);
    expect(stageWith({ steps: [{ ...good, body: 'x'.repeat(2001) }] })).toThrow(AppError);
    expect(stageWith({ steps: [{ ...good, extra: true }] })).toThrow(AppError);
    expect(ruleCount(env)).toBe(0);
    const ok = prepareSendIntents(env.ctx, { draftActivityIds: [draft], followups: { steps: [{ waitDays: 30, body: 'x'.repeat(2000) }, { waitDays: 1, body: '  ten chars!  ' }] } });
    expect((ok.approval!.payload as any).followups.steps[1].body).toBe('ten chars!');
  });

  it('excludes a person with an active rule as followup_armed, and lets them be staged again once it is stopped', async () => {
    const env = await freshEnv();
    const first = await launch(env, 'Hana');
    const draft = addDraft(env, first.personId, 'A different subject', 'Another body');
    for (const status of ['waiting', 'armed', 'sending']) {
      env.db.prepare('UPDATE followup_rule SET status = ? WHERE id = ?').run(status, first.ruleId);
      const staged = stage(env, [draft]);
      expect(staged.approval).toBeNull();
      expect(staged.excluded).toEqual([expect.objectContaining({ personId: first.personId, reason: 'followup_armed' })]);
    }
    for (const status of ['done', 'stopped', 'expired']) {
      env.db.prepare('UPDATE followup_rule SET status = ? WHERE id = ?').run(status, first.ruleId);
      const staged = stage(env, [draft]);
      expect(staged.approval).not.toBeNull();
      decideApproval(env.ctx, staged.approval!.id, { decision: 'reject' });
    }
  });
});

describe('arming', () => {
  it('stays waiting until the anchor is accepted, then arms from the acceptance time', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Ivy', { send: false });
    expect(tickFollowupRules(env.ctx)).toBe(0);
    expect(ruleRow(env, launched.ruleId).status).toBe('waiting');
    await drain(env);
    const acceptedAt = intentOf(env, launched.anchorId).updatedAt;
    expect(tickFollowupRules(env.ctx)).toBe(1);
    const rule = ruleRow(env, launched.ruleId);
    expect(rule).toMatchObject({ status: 'armed', next_step: 1 });
    expect(rule.next_due_at).toBe(dueAfter(acceptedAt, 3));
    expect(auditActions(env, launched.ruleId)).toEqual(['followup_rule.create', 'followup_rule.arm']);
  });

  it('slips a Saturday or Sunday due time to the following Monday at the same local time', async () => {
    const env = await freshEnv();
    const cases = [
      // Wednesday 10:00 plus 3 days is Saturday, plus 4 days is Sunday, plus 2 days is Friday.
      { from: localTime(2026, 2, 4, 10), waitDays: 3, expected: localTime(2026, 2, 9, 10) },
      { from: localTime(2026, 2, 4, 10), waitDays: 4, expected: localTime(2026, 2, 9, 10) },
      { from: localTime(2026, 2, 4, 10), waitDays: 2, expected: localTime(2026, 2, 6, 10) },
    ];
    for (const item of cases) expect(dueAfter(item.from, item.waitDays)).toBe(item.expected);

    const launched = await launch(env, 'Jo', { steps: [{ waitDays: 3, body: 'Following up on my last note.' }] });
    env.db.prepare('UPDATE send_intent SET updated_at = ? WHERE id = ?').run(cases[0]!.from, launched.anchorId);
    tickFollowupRules(env.ctx);
    expect(ruleRow(env, launched.ruleId).next_due_at).toBe(cases[0]!.expected);
  });

  it.each(['failed', 'blocked', 'cancelled', 'replied', 'bounced'])('stops a waiting rule as not_sent when the anchor ends %s', async (status) => {
    const env = await freshEnv();
    const launched = await launch(env, 'Kai', { send: false });
    env.db.prepare('UPDATE send_intent SET status = ? WHERE id = ?').run(status, launched.anchorId);
    tickFollowupRules(env.ctx);
    expect(ruleRow(env, launched.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'not_sent', next_due_at: null });
    expect(auditActions(env, launched.ruleId)).toEqual(['followup_rule.create', 'followup_rule.stop']);
  });
});

describe('the claim', () => {
  it('creates the step intent once when two ticks run, even from two connections', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'Lena');
    const second = openDatabase(env.databasePath);
    try {
      const otherCtx = createContext(second, env.workspaceId, { bus: env.bus, now: env.ctx.now });
      await Promise.all([Promise.resolve().then(() => tickFollowupRules(env.ctx)), Promise.resolve().then(() => tickFollowupRules(otherCtx))]);
      tickFollowupRules(env.ctx);
      tickFollowupRules(otherCtx);
    } finally {
      second.close();
    }
    const created = stepIntents(env, launched.ruleId);
    expect(created).toHaveLength(1);
    const rule = ruleRow(env, launched.ruleId);
    expect(rule).toMatchObject({ status: 'sending', next_step: 1, last_intent_id: created[0]!.id, next_due_at: null });
    expect(created[0]).toMatchObject({
      status: 'queued',
      approval_id: launched.approvalId,
      followup_rule_id: launched.ruleId,
      followup_step: 1,
      person_id: launched.personId,
      to_email: launched.email,
      subject: 'Re: Hello Lena',
      body: steps[0]!.body,
      provider: 'agentmail',
      draft_activity_id: null,
    });
    expect(auditActions(env, launched.ruleId)).toEqual(['followup_rule.create', 'followup_rule.arm', 'followup_rule.send_step']);
    expect(auditActions(env, created[0]!.id)).toEqual(['send_intent.create']);
  });

  it('does nothing before the due time', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Mo');
    tickFollowupRules(env.ctx);
    const due = Date.parse(ruleRow(env, launched.ruleId).next_due_at!);
    warpTo(env, due - 60_000);
    expect(tickFollowupRules(env.ctx)).toBe(0);
    expect(stepIntents(env, launched.ruleId)).toHaveLength(0);
  });

  it('sends step one then step two, measuring the second wait from the first acceptance, and finishes', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'Nia');
    tickFollowupRules(env.ctx);
    await drain(env);
    const first = stepIntents(env, launched.ruleId)[0]!;
    expect(statusOf(env, first.id)).toBe('accepted');
    expect(agentmail.state.sent.map((item) => item.subject)).toEqual(['Hello Nia', 'Re: Hello Nia']);
    expect(agentmail.state.sent[1]!.text).toBe(steps[0]!.body);

    tickFollowupRules(env.ctx);
    const armed = ruleRow(env, launched.ruleId);
    expect(armed).toMatchObject({ status: 'armed', next_step: 2 });
    expect(armed.next_due_at).toBe(dueAfter(intentOf(env, first.id).updatedAt, 5));
    warpTo(env, Date.parse(armed.next_due_at!) + 1000);
    tickFollowupRules(env.ctx);
    await drain(env);
    const created = stepIntents(env, launched.ruleId);
    expect(created.map((item) => [item.followup_step, item.status, item.subject, item.body])).toEqual([
      [1, 'accepted', 'Re: Hello Nia', steps[0]!.body],
      [2, 'accepted', 'Re: Hello Nia', steps[1]!.body],
    ]);
    tickFollowupRules(env.ctx);
    expect(ruleRow(env, launched.ruleId)).toMatchObject({ status: 'done', next_step: 2, next_due_at: null });
    expect(auditActions(env, launched.ruleId)).toEqual([
      'followup_rule.create',
      'followup_rule.arm',
      'followup_rule.send_step',
      'followup_rule.arm',
      'followup_rule.send_step',
      'followup_rule.done',
    ]);
    // A done rule does nothing more.
    expect(tickFollowupRules(env.ctx)).toBe(0);
  });

  it('keeps the subject Re: prefix from doubling, in any case', () => {
    expect(followupSubject('Hello')).toBe('Re: Hello');
    expect(followupSubject('Re: Hello')).toBe('Re: Hello');
    expect(followupSubject('RE: Hello')).toBe('RE: Hello');
    expect(followupSubject('re:hello')).toBe('re:hello');
    expect(followupSubject('Research plans')).toBe('Re: Research plans');
  });

  it('uses the anchor subject through the whole flow', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'Oz', { subject: 'RE: already a reply' });
    tickFollowupRules(env.ctx);
    expect(stepIntents(env, launched.ruleId)[0]!.subject).toBe('RE: already a reply');
  });
});

describe('threading', () => {
  it('threads IMAP steps on the previous accepted message, step two on step one', async () => {
    const env = await freshEnv('imap');
    const launched = await launchDue(env, 'Pia');
    const anchor = env.db.prepare('SELECT message_id_header, provider_thread_id FROM send_intent WHERE id = ?').get(launched.anchorId) as Record<string, string>;
    expect(anchor.message_id_header).toBeTruthy();
    tickFollowupRules(env.ctx);
    const first = stepIntents(env, launched.ruleId)[0]!;
    expect(JSON.parse(first.followup_reply_to)).toEqual({
      threadId: anchor.provider_thread_id,
      inReplyTo: anchor.message_id_header,
      references: [anchor.message_id_header],
    });
    await drain(env);
    const firstRaw = parseMime(imap.sendCalls[1]!.raw);
    expect(headerValue(firstRaw, 'in-reply-to')).toBe(anchor.message_id_header);
    expect(headerValue(firstRaw, 'references')).toBe(anchor.message_id_header);
    expect(headerValue(firstRaw, 'subject')).toBe('Re: Hello Pia');

    tickFollowupRules(env.ctx);
    const afterFirst = intentOf(env, first.id);
    const firstHeader = (env.db.prepare('SELECT message_id_header FROM send_intent WHERE id = ?').get(first.id) as Record<string, string>).message_id_header!;
    expect(afterFirst.status).toBe('accepted');
    warpTo(env, Date.parse(ruleRow(env, launched.ruleId).next_due_at!) + 1000);
    tickFollowupRules(env.ctx);
    const second = stepIntents(env, launched.ruleId)[1]!;
    expect(JSON.parse(second.followup_reply_to)).toEqual({ threadId: firstHeader, inReplyTo: firstHeader, references: [firstHeader] });
    await drain(env);
    const secondRaw = parseMime(imap.sendCalls[2]!.raw);
    expect(headerValue(secondRaw, 'in-reply-to')).toBe(firstHeader);
    expect(headerValue(secondRaw, 'references')).toBe(firstHeader);
  });

  it('threads Gmail steps with the thread id of the previous message', async () => {
    const env = await freshEnv('gmail');
    const launched = await launchDue(env, 'Quin');
    const anchor = env.db.prepare('SELECT message_id_header, provider_thread_id FROM send_intent WHERE id = ?').get(launched.anchorId) as Record<string, string>;
    expect(anchor.provider_thread_id).toBeTruthy();
    tickFollowupRules(env.ctx);
    await drain(env);
    expect(google.state.sent).toHaveLength(2);
    expect(google.state.sent[0]!.requestedThreadId).toBeNull();
    expect(google.state.sent[1]!.requestedThreadId).toBe(anchor.provider_thread_id);
    expect(google.state.sent[1]!.headers['in-reply-to']).toBe(anchor.message_id_header);
    expect(google.state.sent[1]!.subject).toBe('Re: Hello Quin');
  });

  it('sends AgentMail steps as new messages with no reply reference', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'Rae');
    tickFollowupRules(env.ctx);
    expect(stepIntents(env, launched.ruleId)[0]!.followup_reply_to).toBeNull();
  });

  it('builds a reference only for gmail and imap, and only when both ids exist', () => {
    const previous = { message_id_header: '<ac-1@x.invalid>', provider_thread_id: 'thr_1' };
    expect(JSON.parse(followupReplyReference('gmail', previous)!)).toEqual({ threadId: 'thr_1', inReplyTo: '<ac-1@x.invalid>', references: ['<ac-1@x.invalid>'] });
    expect(followupReplyReference('imap', previous)).not.toBeNull();
    expect(followupReplyReference('agentmail', previous)).toBeNull();
    expect(followupReplyReference('microsoft', previous)).toBeNull();
    expect(followupReplyReference('gmail', { ...previous, message_id_header: null })).toBeNull();
    expect(followupReplyReference('gmail', { ...previous, provider_thread_id: null })).toBeNull();
  });
});

describe('stop conditions', () => {
  it('stops as replied when an inbound message from the person arrived after the anchor was submitted', async () => {
    const env = await launchDueEnv();
    const { env: e, launched } = env;
    insertInbound(e, launched.personId, launched.email, new Date(Date.parse(e.ctx.now()) - 1000).toISOString());
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, launched.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'replied' });
    expect(stepIntents(e, launched.ruleId)).toHaveLength(0);
  });

  it('does not count an inbound message that predates the anchor', async () => {
    const e = await freshEnv();
    const launched = await launch(e, 'Sol');
    insertInbound(e, launched.personId, launched.email, '2026-01-01T00:00:00.000Z');
    tickFollowupRules(e.ctx);
    warpTo(e, Date.parse(ruleRow(e, launched.ruleId).next_due_at!) + 1000);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, launched.ruleId).status).toBe('sending');
  });

  it('stops as suppressed for any suppression reason', async () => {
    const e = await freshEnv();
    const launched = await launchDue(e, 'Tess');
    e.db
      .prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES ('sup_000000000001', ?, ?, ?, 'opt_out', 'test')")
      .run(e.ctx.now(), e.workspaceId, launched.email);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, launched.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'suppressed' });
  });

  it('stops as bounced when the anchor or a previous step bounced', async () => {
    const e = await freshEnv();
    const launched = await launchDue(e, 'Uma');
    e.db.prepare("UPDATE send_intent SET status = 'bounced' WHERE id = ?").run(launched.anchorId);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, launched.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'bounced' });

    const other = await launchDue(e, 'Vic');
    tickFollowupRules(e.ctx);
    await drain(e);
    tickFollowupRules(e.ctx);
    warpTo(e, Date.parse(ruleRow(e, other.ruleId).next_due_at!) + 1000);
    const first = stepIntents(e, other.ruleId)[0]!;
    e.db.prepare("UPDATE send_intent SET status = 'bounced' WHERE id = ?").run(first.id);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, other.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'bounced' });
    expect(stepIntents(e, other.ruleId)).toHaveLength(1);
  });

  it('checks reply before suppression, suppression before bounce, bounce before connector', async () => {
    const e = await freshEnv();
    const launched = await launchDue(e, 'Wes');
    insertInbound(e, launched.personId, launched.email, new Date(Date.parse(e.ctx.now()) - 1000).toISOString());
    e.db.prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES ('sup_000000000002', ?, ?, ?, 'manual', 't')").run(e.ctx.now(), e.workspaceId, launched.email);
    e.db.prepare("UPDATE send_intent SET status = 'bounced' WHERE id = ?").run(launched.anchorId);
    e.db.prepare("UPDATE followup_rule SET provider = 'gmail' WHERE id = ?").run(launched.ruleId);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, launched.ruleId).stopped_reason).toBe('replied');
  });

  it('stops as connector_changed at tick time when the provider is no longer the one in use', async () => {
    const e = await freshEnv();
    const launched = await launchDue(e, 'Xan');
    e.db.prepare("UPDATE followup_rule SET provider = 'gmail' WHERE id = ?").run(launched.ruleId);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, launched.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'connector_changed' });
  });

  it('stops active rules of a connector when it is removed, with no task, and cancels a queued step', async () => {
    const e = await freshEnv();
    const waiting = await launch(e, 'Yara', { send: false });
    const done = await launch(e, 'Abe');
    const sending = await launchSending(e, 'Zed');
    e.db.prepare("UPDATE followup_rule SET status = 'done' WHERE id = ?").run(done.ruleId);
    const tasksBefore = taskTitles(e).length;
    disconnectAgentmailConnector(e.ctx);
    expect(ruleRow(e, waiting.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'connector_changed' });
    expect(ruleRow(e, sending.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'connector_changed' });
    expect(ruleRow(e, done.ruleId).status).toBe('done');
    expect(statusOf(e, sending.stepId)).toBe('blocked');
    expect(taskTitles(e).length).toBe(tasksBefore);
  });

  it('stops the rules of the old provider when the provider is switched', async () => {
    const e = await freshEnv();
    await connectImap(e);
    const launched = await launch(e, 'Bea');
    setMailProvider(e.ctx, { kind: 'imap' });
    expect(ruleRow(e, launched.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'connector_changed' });
  });

  it('stops by hand, cancels the queued step, and answers a second stop with the same rule', async () => {
    const e = await freshEnv();
    const sending = await launchSending(e, 'Cal');
    const bus: unknown[] = [];
    const unsubscribe = e.bus.subscribe((event) => bus.push(event));
    const rule = stopFollowupRule(e.ctx, sending.ruleId);
    expect(rule).toMatchObject({ id: sending.ruleId, status: 'stopped', stoppedReason: 'stopped_by_user', nextDueAt: null });
    expect(statusOf(e, sending.stepId)).toBe('cancelled');
    expect(bus).toContainEqual({ type: 'followup_updated', ruleId: sending.ruleId, personId: sending.personId });
    expect(auditActions(e, sending.ruleId)).toContain('followup_rule.stop');
    unsubscribe();

    const again = stopFollowupRule(e.ctx, sending.ruleId);
    expect(again).toEqual(rule);
    expect(auditActions(e, sending.ruleId).filter((action) => action === 'followup_rule.stop')).toHaveLength(1);
    await drain(e);
    expect(agentmail.state.sent.map((item) => item.subject)).toEqual(['Hello Cal']);
  });

  it('stops waiting and armed rules by hand, and refuses done and expired ones', async () => {
    const e = await freshEnv();
    const waiting = await launch(e, 'Dee', { send: false });
    expect(stopFollowupRule(e.ctx, waiting.ruleId).status).toBe('stopped');
    const armed = await launch(e, 'Eli');
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, armed.ruleId).status).toBe('armed');
    expect(stopFollowupRule(e.ctx, armed.ruleId)).toMatchObject({ status: 'stopped', stoppedReason: 'stopped_by_user' });
    for (const status of ['done', 'expired']) {
      const other = await launch(e, 'Fay', { send: false });
      e.db.prepare('UPDATE followup_rule SET status = ? WHERE id = ?').run(status, other.ruleId);
      expect(() => stopFollowupRule(e.ctx, other.ruleId)).toThrow(/cannot be stopped/);
      expect(ruleRow(e, other.ruleId).status).toBe(status);
    }
    expect(() => stopFollowupRule(e.ctx, 'fur_000000000000')).toThrow(AppError);
  });
});

async function launchDueEnv() {
  const env = await freshEnv();
  const launched = await launchDue(env, 'Reed');
  return { env, launched };
}

describe('caps, expiry, and staleness', () => {
  it('slips the due time by one day when the daily cap is full, and creates nothing', async () => {
    const e = await freshEnv();
    const launched = await launchDue(e, 'Gil');
    const due = ruleRow(e, launched.ruleId).next_due_at!;
    insertAcceptedToday(e, launched.personId, 50);
    expect(tickFollowupRules(e.ctx)).toBe(1);
    expect(ruleRow(e, launched.ruleId)).toMatchObject({ status: 'armed', next_due_at: new Date(Date.parse(due) + day).toISOString() });
    expect(stepIntents(e, launched.ruleId)).toHaveLength(0);
    expect(auditActions(e, launched.ruleId)).toContain('followup_rule.slip');
  });

  it('expires a step more than 7 days overdue with a task and sends nothing', async () => {
    const e = await freshEnv();
    const launched = await launch(e, 'Hope');
    tickFollowupRules(e.ctx);
    const due = Date.parse(ruleRow(e, launched.ruleId).next_due_at!);
    warpTo(e, due + 7 * day - 60_000);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, launched.ruleId).status).toBe('sending');

    const late = await launch(e, 'Ian');
    tickFollowupRules(e.ctx);
    warpTo(e, Date.parse(ruleRow(e, late.ruleId).next_due_at!) + 7 * day + 60_000);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, late.ruleId)).toMatchObject({ status: 'expired', stopped_reason: 'overdue', next_due_at: null });
    expect(stepIntents(e, late.ruleId)).toHaveLength(0);
    expect(taskTitles(e)).toContain('Follow-up to Ian Testwell was not sent: the computer was off past the send window');
  });

  it('expires a rule more than 90 days after its approval decision', async () => {
    const e = await freshEnv();
    const launched = await launch(e, 'Jade');
    tickFollowupRules(e.ctx);
    const due = Date.parse(ruleRow(e, launched.ruleId).next_due_at!);
    e.db.prepare('UPDATE approval SET decided_at = ? WHERE id = ?').run(new Date(due - 91 * day).toISOString(), launched.approvalId);
    warpTo(e, due + 60_000);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, launched.ruleId)).toMatchObject({ status: 'expired', stopped_reason: 'ceiling', next_due_at: null });
    expect(stepIntents(e, launched.ruleId)).toHaveLength(0);
    expect(taskTitles(e)).toContain('Follow-up to Jade Testwell was not sent: the plan expired 90 days after approval');
    expect(taskTitles(e)).not.toContain('Follow-up to Jade Testwell was not sent: the computer was off past the send window');
  });

  it('judges a step by its own creation time, not the approval age, and blocks one left queued for a day', async () => {
    const e = await freshEnv();
    const fresh = await launchDue(e, 'Kit');
    // The approval is days old by now, which would block a first message. The step is new, so it is sent.
    tickFollowupRules(e.ctx);
    await drain(e);
    expect(statusOf(e, stepIntents(e, fresh.ruleId)[0]!.id)).toBe('accepted');

    const stale = await launchDue(e, 'Lou');
    tickFollowupRules(e.ctx);
    const step = stepIntents(e, stale.ruleId)[0]!;
    warpTo(e, Date.parse(step.created_at) + day + 60_000);
    await drain(e);
    expect(intentOf(e, step.id)).toMatchObject({ status: 'blocked', error: followupStaleSentence });
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, stale.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'step_not_sent' });
    expect(taskTitles(e)).toContain('Follow-up to Lou Testwell was not sent');
  });

  it('still blocks an ordinary first message whose approval is over a day old', async () => {
    const e = await freshEnv();
    const launched = await launch(e, 'Max', { send: false });
    warpTo(e, Date.parse(e.ctx.now()) + day + 60_000);
    await drain(e);
    expect(intentOf(e, launched.anchorId)).toMatchObject({ status: 'blocked', error: 'Approved more than a day ago. Review and approve again.' });
  });

  it('refuses a step whose text no longer matches the approved plan', async () => {
    const e = await freshEnv();
    const launched = await launchDue(e, 'Nell');
    tickFollowupRules(e.ctx);
    const step = stepIntents(e, launched.ruleId)[0]!;
    e.db.prepare('UPDATE send_intent SET body = ? WHERE id = ?').run('Something else entirely.', step.id);
    await drain(e);
    expect(intentOf(e, step.id)).toMatchObject({ status: 'blocked', error: 'The message no longer matches what was approved.' });
  });
});

describe('the sending state', () => {
  async function sendingRule(e: TestEnvironment, name: string) {
    return launchSending(e, name);
  }

  it('stays sending while the step is unknown, queued, or submitting', async () => {
    const e = await freshEnv();
    const launched = await sendingRule(e, 'Ona');
    for (const status of ['queued', 'submitting', 'unknown']) {
      e.db.prepare('UPDATE send_intent SET status = ? WHERE id = ?').run(status, launched.stepId);
      expect(tickFollowupRules(e.ctx)).toBe(0);
      expect(ruleRow(e, launched.ruleId).status).toBe('sending');
    }
  });

  it.each([
    ['replied', 'stopped', 'replied', false],
    ['bounced', 'stopped', 'bounced', false],
    ['failed', 'stopped', 'step_not_sent', true],
    ['blocked', 'stopped', 'step_not_sent', true],
    ['cancelled', 'stopped', 'step_not_sent', true],
  ])('moves a sending rule on a step that is %s', async (stepStatus, status, reason, taskExpected) => {
    const e = await freshEnv();
    const launched = await sendingRule(e, 'Pam');
    e.db.prepare('UPDATE send_intent SET status = ? WHERE id = ?').run(stepStatus, launched.stepId);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, launched.ruleId)).toMatchObject({ status, stopped_reason: reason });
    expect(taskTitles(e).includes('Follow-up to Pam Testwell was not sent')).toBe(taskExpected);
  });

  it('re-arms after an accepted step with steps left and finishes after the last', async () => {
    const e = await freshEnv();
    const launched = await sendingRule(e, 'Quill');
    e.db.prepare("UPDATE send_intent SET status = 'accepted', updated_at = ? WHERE id = ?").run(localTime(2026, 2, 4, 10), launched.stepId);
    tickFollowupRules(e.ctx);
    // Five days after Wednesday is Monday, so no slip.
    expect(ruleRow(e, launched.ruleId)).toMatchObject({ status: 'armed', next_step: 2, next_due_at: localTime(2026, 2, 9, 10) });
    e.db.prepare("UPDATE followup_rule SET status = 'sending', next_step = 2 WHERE id = ?").run(launched.ruleId);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, launched.ruleId)).toMatchObject({ status: 'done', next_step: 2 });
  });
});

describe('events and the worker lane', () => {
  it('emits followup_updated for creation, arming, and stopping', async () => {
    const e = await freshEnv();
    const frames: any[] = [];
    e.bus.subscribe((event) => {
      if (event.type === 'followup_updated') frames.push(event);
    });
    const launched = await launch(e, 'Rhea');
    tickFollowupRules(e.ctx);
    stopFollowupRule(e.ctx, launched.ruleId);
    expect(frames).toHaveLength(3);
    for (const frame of frames) expect(frame).toEqual({ type: 'followup_updated', ruleId: launched.ruleId, personId: launched.personId });
  });

  it('walks the rules at most once per interval', async () => {
    const e = await freshEnv();
    const previous = process.env.AGENTCRM_FOLLOWUP_TICK_MS;
    process.env.AGENTCRM_FOLLOWUP_TICK_MS = '3600000';
    try {
      await launch(e, 'Sid');
      expect(tickFollowupRulesIfDue(e.ctx)).toBe(1);
      expect(tickFollowupRulesIfDue(e.ctx)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.AGENTCRM_FOLLOWUP_TICK_MS;
      else process.env.AGENTCRM_FOLLOWUP_TICK_MS = previous;
    }
  });
});

describe('http', () => {
  let app: FastifyInstance;
  let e: TestEnvironment;

  beforeAll(async () => {
    e = await freshEnv();
    app = buildApp({ db: e.db, bus: e.bus, databasePath: e.databasePath, logLevel: 'silent', now: () => e.ctx.now() });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }), headers: { host: '127.0.0.1:4720' } });
    return { status: response.statusCode, body: response.json() };
  }

  it('stages with followups over HTTP, lists rules newest first with filters, and stops one', async () => {
    const person = addPerson(e, 'Tia', 'tia@lanternrow.invalid');
    const draft = addDraft(e, person.id, 'Intro Tia', 'Body');
    const staged = await call('POST', '/api/send-intents', { draftActivityIds: [draft], followups: { steps: [{ waitDays: 2, body: '  Gentle nudge for you.  ' }] } });
    expect(staged.status).toBe(201);
    expect(staged.body.approval.payload.followups).toEqual({ steps: [{ waitDays: 2, body: 'Gentle nudge for you.' }] });
    const bad = await call('POST', '/api/send-intents', { draftActivityIds: [draft], followups: { steps: [{ waitDays: 0, body: 'Gentle nudge for you.' }] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation');
    await call('POST', `/api/approvals/${staged.body.approval.id}/decision`, { decision: 'approve' });
    await drain(e);

    const second = await launch(e, 'Uri');
    tickFollowupRules(e.ctx);
    const list = await call('GET', '/api/followup-rules');
    expect(list.status).toBe(200);
    expect(list.body.nextCursor).toBeNull();
    expect(list.body.items.map((item: any) => item.personName)).toEqual(['Uri Testwell', 'Tia Testwell']);
    expect(list.body.items[0]).toEqual({
      id: second.ruleId,
      personId: second.personId,
      personName: 'Uri Testwell',
      status: 'armed',
      steps,
      nextStep: 1,
      nextDueAt: ruleRow(e, second.ruleId).next_due_at,
      stoppedReason: null,
      provider: 'agentmail',
      anchorIntentId: second.anchorId,
      anchorSubject: 'Hello Uri',
      lastIntentId: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect((await call('GET', '/api/followup-rules?status=armed')).body.items).toHaveLength(2);
    expect((await call('GET', '/api/followup-rules?status=waiting')).body.items).toHaveLength(0);
    expect((await call('GET', '/api/followup-rules?status=active&limit=200')).body.items).toHaveLength(2);
    expect((await call('GET', `/api/followup-rules?personId=${person.id}`)).body.items).toHaveLength(1);
    expect((await call('GET', '/api/followup-rules?status=nonsense')).status).toBe(400);
    const paged = await call('GET', '/api/followup-rules?limit=1');
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.nextCursor).not.toBeNull();
    expect((await call('GET', `/api/followup-rules?limit=1&cursor=${paged.body.nextCursor}`)).body.items[0].personName).toBe('Tia Testwell');

    const stopped = await call('POST', `/api/followup-rules/${second.ruleId}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.rule).toMatchObject({ id: second.ruleId, status: 'stopped', stoppedReason: 'stopped_by_user', nextDueAt: null });
    const again = await call('POST', `/api/followup-rules/${second.ruleId}/stop`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(stopped.body);
    expect((await call('GET', '/api/followup-rules?status=active')).body.items).toHaveLength(1);

    e.db.prepare("UPDATE followup_rule SET status = 'done' WHERE id = ?").run(second.ruleId);
    const conflict = await call('POST', `/api/followup-rules/${second.ruleId}/stop`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('conflict');
    expect((await call('POST', '/api/followup-rules/fur_000000000000/stop')).status).toBe(404);
  });

  it('adds followupRuleId and followupStep to send intents', async () => {
    // The stub restarts its message ids after every test, and this database already holds the first test's.
    agentmail.state.nextId = 1000;
    const launched = await launch(e, 'Val');
    tickFollowupRules(e.ctx);
    warpTo(e, Date.parse(ruleRow(e, launched.ruleId).next_due_at!) + 1000);
    tickFollowupRules(e.ctx);
    const rows = (await call('GET', '/api/send-intents')).body.items as any[];
    const anchor = rows.find((item) => item.id === launched.anchorId);
    const step = rows.find((item) => item.followupRuleId === launched.ruleId);
    expect(anchor).toMatchObject({ followupRuleId: null, followupStep: null });
    expect(step).toMatchObject({ followupRuleId: launched.ruleId, followupStep: 1, subject: 'Re: Hello Val', address: 'crm@stub-mail.invalid' });
    expect(listSendIntents(e.db, e.workspaceId).items.find((item) => item.id === step.id)?.followupStep).toBe(1);
    expect(listFollowupRules(e.db, e.workspaceId, { status: 'sending' }).items.map((item) => item.id)).toContain(launched.ruleId);
  });
});


describe('the sync gate', () => {
  async function dueRule(name: string) {
    const e = await freshEnv();
    const launched = await launchDue(e, name);
    return { e, launched, due: Date.parse(ruleRow(e, launched.ruleId).next_due_at!) };
  }

  it('creates the step once the mailbox was read without error after the due time', async () => {
    const { e, launched, due } = await dueRule('Gate1');
    markMailSynced(e, new Date(due + 500).toISOString());
    expect(tickFollowupRules(e.ctx)).toBe(1);
    expect(ruleRow(e, launched.ruleId).status).toBe('sending');
    expect(stepIntents(e, launched.ruleId)).toHaveLength(1);
  });

  it('waits, without slipping, blocking, or a task, while the last poll is older than the due time, missing, or failed', async () => {
    const { e, launched, due } = await dueRule('Gate2');
    const before = ruleRow(e, launched.ruleId);
    const audits = auditActions(e, launched.ruleId);
    const tasks = taskTitles(e);
    const settle = () => {
      expect(tickFollowupRules(e.ctx)).toBe(0);
      expect(ruleRow(e, launched.ruleId)).toEqual(before);
      expect(stepIntents(e, launched.ruleId)).toHaveLength(0);
      expect(auditActions(e, launched.ruleId)).toEqual(audits);
      expect(taskTitles(e)).toEqual(tasks);
    };
    // Polled before the step became due.
    markMailSynced(e, new Date(due - 1000).toISOString());
    settle();
    // Polled exactly at the due time is not after it.
    markMailSynced(e, new Date(due).toISOString());
    settle();
    // Never polled.
    e.db.prepare("UPDATE connector SET settings = json_remove(settings, '$.lastSyncAt') WHERE kind = 'agentmail'").run();
    settle();
    // Polled after the due time, but that poll failed.
    markMailSynced(e, new Date(due + 1000).toISOString());
    const row = e.db.prepare("SELECT id, settings FROM connector WHERE kind = 'agentmail'").get() as { id: string; settings: string };
    e.db.prepare('UPDATE connector SET settings = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.settings), lastSyncError: 'AgentMail is rate limiting requests.' }), row.id);
    settle();

    // The next good poll releases it.
    markMailSynced(e, new Date(due + 2000).toISOString());
    expect(tickFollowupRules(e.ctx)).toBe(1);
    expect(ruleRow(e, launched.ruleId).status).toBe('sending');
  });

  it('reads the connector of the provider in use: a poll record on another connector does not count', async () => {
    const e = await freshEnv();
    await connectImap(e);
    const launched = await launchDue(e, 'Gate3');
    expect(ruleRow(e, launched.ruleId).provider).toBe('agentmail');
    // AgentMail is in use. A fresh poll record on the IMAP connector alone does not release the step.
    const due = Date.parse(ruleRow(e, launched.ruleId).next_due_at!);
    markMailSynced(e, new Date(due - 1000).toISOString());
    const imapRow = e.db.prepare("SELECT id, settings FROM connector WHERE kind = 'imap'").get() as { id: string; settings: string };
    e.db.prepare('UPDATE connector SET settings = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(imapRow.settings), lastSyncAt: new Date(due + 5000).toISOString() }), imapRow.id);
    tickFollowupRules(e.ctx);
    expect(stepIntents(e, launched.ruleId)).toHaveLength(0);
  });

  it('still expires a rule that can never sync, once it is more than 7 days overdue', async () => {
    const e = await freshEnv();
    const launched = await launch(e, 'Gate4');
    tickFollowupRules(e.ctx);
    const due = Date.parse(ruleRow(e, launched.ruleId).next_due_at!);
    warpTo(e, due + 7 * day + 60_000, { synced: false });
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, launched.ruleId)).toMatchObject({ status: 'expired', stopped_reason: 'overdue' });
  });

  it('does not wake the cap slip until the mailbox was read: a full cap with a stale poll changes nothing', async () => {
    const e = await freshEnv();
    const launched = await launchDue(e, 'Gate5');
    const due = Date.parse(ruleRow(e, launched.ruleId).next_due_at!);
    markMailSynced(e, new Date(due - 1000).toISOString());
    insertAcceptedToday(e, launched.personId, 50);
    expect(tickFollowupRules(e.ctx)).toBe(0);
    expect(ruleRow(e, launched.ruleId).next_due_at).toBe(new Date(due).toISOString());
  });
});

describe('stop checks run on every tick', () => {
  async function armedNotDue(name: string) {
    const e = await freshEnv();
    const launched = await launch(e, name);
    tickFollowupRules(e.ctx);
    const rule = ruleRow(e, launched.ruleId);
    expect(rule.status).toBe('armed');
    expect(Date.parse(rule.next_due_at!)).toBeGreaterThan(Date.parse(e.ctx.now()));
    return { e, launched };
  }

  it('stops an armed rule that is not due when the person replied', async () => {
    const { e, launched } = await armedNotDue('Tick1');
    insertInbound(e, launched.personId, launched.email, new Date(Date.parse(e.ctx.now()) + 1000).toISOString());
    expect(tickFollowupRules(e.ctx)).toBe(1);
    expect(ruleRow(e, launched.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'replied', next_due_at: null });
  });

  it('stops an armed rule that is not due on a suppression, a bounce, and a changed connector', async () => {
    const e = await freshEnv();
    const a = await launch(e, 'Tick2a');
    const b = await launch(e, 'Tick2b');
    const c = await launch(e, 'Tick2c');
    tickFollowupRules(e.ctx);
    e.db.prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES ('sup_000000000010', ?, ?, ?, 'manual', 't')").run(e.ctx.now(), e.workspaceId, a.email);
    e.db.prepare("UPDATE send_intent SET status = 'bounced' WHERE id = ?").run(b.anchorId);
    e.db.prepare("UPDATE followup_rule SET provider = 'gmail' WHERE id = ?").run(c.ruleId);
    expect(tickFollowupRules(e.ctx)).toBe(3);
    expect(ruleRow(e, a.ruleId).stopped_reason).toBe('suppressed');
    expect(ruleRow(e, b.ruleId).stopped_reason).toBe('bounced');
    expect(ruleRow(e, c.ruleId).stopped_reason).toBe('connector_changed');
  });

  it('stops a waiting rule whose anchor is still queued when the address was suppressed', async () => {
    const e = await freshEnv();
    const launched = await launch(e, 'Tick3', { send: false });
    e.db.prepare("INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES ('sup_000000000011', ?, ?, ?, 'opt_out', 't')").run(e.ctx.now(), e.workspaceId, launched.email);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, launched.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'suppressed' });
  });

  it('stops a sending rule on a reply, cancels its queued step, and sends nothing', async () => {
    const e = await freshEnv();
    const sending = await launchSending(e, 'Tick4');
    insertInbound(e, sending.personId, sending.email, new Date(Date.parse(e.ctx.now()) + 1000).toISOString());
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, sending.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'replied' });
    expect(statusOf(e, sending.stepId)).toBe('cancelled');
    await drain(e);
    expect(agentmail.state.sent.map((item) => item.subject)).toEqual(['Hello Tick4']);
  });

  it('leaves a healthy armed rule alone before it is due', async () => {
    const { e, launched } = await armedNotDue('Tick5');
    const before = ruleRow(e, launched.ruleId);
    expect(tickFollowupRules(e.ctx)).toBe(0);
    expect(ruleRow(e, launched.ruleId)).toEqual(before);
  });
});

describe('one active rule per person', () => {
  it('creates a rule for only the first queued message of a person in one approval, and reports and audits the other', async () => {
    const e = await freshEnv();
    const person = addPerson(e, 'Once', 'once@lanternrow.invalid');
    const other = addPerson(e, 'Other', 'other@lanternrow.invalid');
    const staged = prepareSendIntents(e.ctx, {
      draftActivityIds: [addDraft(e, person.id, 'First topic', 'Body about the first topic.'), addDraft(e, other.id, 'Topic for other', 'Body for the other person.'), addDraft(e, person.id, 'Second topic', 'Body about the second topic.')],
      followups: { steps },
    });
    expect(staged.intents).toHaveLength(3);
    const decision = approve(e, staged.approval!.id) as any;
    expect(ruleCount(e)).toBe(2);
    expect(ruleCount(e, `person_id = '${person.id}'`)).toBe(1);
    expect(e.db.prepare('SELECT intent_id FROM followup_rule WHERE person_id = ?').get(person.id)).toEqual({ intent_id: staged.intents[0]!.id });
    // Both of the person's messages still go out. Only the second has no follow-ups.
    expect(decision.queued).toBe(3);
    expect(decision.followupSkipped).toEqual([{ intentId: staged.intents[2]!.id, personId: person.id, personName: 'Once Testwell', reason: 'same_approval' }]);
    expect(decision.skipped).toEqual([]);
    const skips = e.db.prepare("SELECT entity_id, detail FROM audit_event WHERE action = 'followup_rule.skip'").all() as { entity_id: string; detail: string }[];
    expect(skips).toHaveLength(1);
    expect(skips[0]!.entity_id).toBe(person.id);
    expect(JSON.parse(skips[0]!.detail)).toMatchObject({ personName: 'Once Testwell', reason: 'same_approval', approvalId: staged.approval!.id });
  });

  it('creates no rule for a person who already has an active rule from another approval', async () => {
    const e = await freshEnv();
    const person = addPerson(e, 'Twice', 'twice@lanternrow.invalid');
    const first = prepareSendIntents(e.ctx, { draftActivityIds: [addDraft(e, person.id, 'Topic A', 'Body A is here.')], followups: { steps } });
    const second = prepareSendIntents(e.ctx, { draftActivityIds: [addDraft(e, person.id, 'Topic B', 'Body B is here.')], followups: { steps } });
    expect((approve(e, first.approval!.id) as any).followupSkipped).toEqual([]);
    const decision = approve(e, second.approval!.id) as any;
    expect(decision.queued).toBe(1);
    expect(decision.followupSkipped).toEqual([{ intentId: second.intents[0]!.id, personId: person.id, personName: 'Twice Testwell', reason: 'active_rule' }]);
    await drain(e);
    tickFollowupRules(e.ctx);
    expect(ruleCount(e, `person_id = '${person.id}' AND status IN ('waiting','armed','sending')`)).toBe(1);
    expect(auditActions(e, person.id)).toContain('followup_rule.skip');
    // Once the first rule is done, a later approval gets a rule again.
    e.db.prepare("UPDATE followup_rule SET status = 'done' WHERE person_id = ?").run(person.id);
    const third = prepareSendIntents(e.ctx, { draftActivityIds: [addDraft(e, person.id, 'Topic C', 'Body C is here.')], followups: { steps } });
    expect((approve(e, third.approval!.id) as any).followupSkipped).toEqual([]);
    expect(ruleCount(e, `person_id = '${person.id}' AND status = 'waiting'`)).toBe(1);
  });

  it('adds no followupSkipped field to the decision of an approval without a plan', async () => {
    const e = await freshEnv();
    const person = addPerson(e, 'Plain', 'plain@lanternrow.invalid');
    const decision = approve(e, stage(e, [addDraft(e, person.id, 'Hi Plain', 'Body')]).approval!.id) as any;
    expect(decision.followupSkipped).toEqual([]);
    expect(decision.queued).toBe(1);
  });
});

describe('a stop holds for steps in unknown states', () => {
  it('blocks a queued step with followup_stopped when its rule is no longer sending', async () => {
    const e = await freshEnv();
    const sending = await launchSending(e, 'Hold1');
    // A stop that did not cancel the step, for example one that landed between the tick and the submit.
    e.db.prepare("UPDATE followup_rule SET status = 'stopped', stopped_reason = 'stopped_by_user', next_due_at = NULL WHERE id = ?").run(sending.ruleId);
    await drain(e);
    expect(intentOf(e, sending.stepId)).toMatchObject({ status: 'blocked', error: 'followup_stopped' });
    expect(agentmail.state.sent.map((item) => item.subject)).toEqual(['Hello Hold1']);
    for (const status of ['expired', 'done', 'waiting', 'armed']) {
      const other = await launchSending(e, `Hold${status}`);
      e.db.prepare('UPDATE followup_rule SET status = ? WHERE id = ?').run(status, other.ruleId);
      await drain(e);
      expect(intentOf(e, other.stepId)).toMatchObject({ status: 'blocked', error: 'followup_stopped' });
    }
  });

  it('never retries an AgentMail step left unknown after Stop, keeps the unknown task, and sends nothing', async () => {
    const e = await freshEnv();
    const sending = await launchSending(e, 'Hold2');
    agentmail.state.sendScript.push({ type: 'respond', status: 503 });
    await processMailJobs(e.ctx);
    expect(statusOf(e, sending.stepId)).toBe('unknown');
    expect(stopFollowupRule(e.ctx, sending.ruleId).status).toBe('stopped');
    const attempts = agentmail.state.sent.length;
    warpTo(e, Date.parse(e.ctx.now()) + 5_000);
    await processMailJobs(e.ctx);
    await processMailJobs(e.ctx);
    expect(intentOf(e, sending.stepId).status).toBe('unknown');
    expect(intentOf(e, sending.stepId).error).toContain('stopped after this message was staged');
    expect(agentmail.state.sent).toHaveLength(attempts);
    expect(agentmail.state.sent.some((item) => item.subject === 'Re: Hello Hold2')).toBe(false);
    expect(taskTitles(e)).toContain(unknownSendTaskTitle('Hold2 Testwell'));
    expect(e.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status IN ('queued', 'running')").get()).toEqual({ n: 0 });
  });

  it('never retries an AgentMail step left unknown after the rule expired', async () => {
    const e = await freshEnv();
    const sending = await launchSending(e, 'Hold3');
    agentmail.state.sendScript.push({ type: 'respond', status: 503 });
    await processMailJobs(e.ctx);
    expect(statusOf(e, sending.stepId)).toBe('unknown');
    e.db.prepare("UPDATE followup_rule SET status = 'expired', stopped_reason = 'ceiling' WHERE id = ?").run(sending.ruleId);
    warpTo(e, Date.parse(e.ctx.now()) + 5_000);
    await processMailJobs(e.ctx);
    await processMailJobs(e.ctx);
    expect(intentOf(e, sending.stepId).status).toBe('unknown');
    expect(agentmail.state.sent.some((item) => item.subject === 'Re: Hello Hold3')).toBe(false);
  });

  it('still retries an unknown step while its rule is sending', async () => {
    const e = await freshEnv();
    const sending = await launchSending(e, 'Hold4');
    agentmail.state.sendScript.push({ type: 'respond', status: 503 });
    await processMailJobs(e.ctx);
    expect(statusOf(e, sending.stepId)).toBe('unknown');
    warpTo(e, Date.parse(e.ctx.now()) + 5_000);
    await processMailJobs(e.ctx);
    await processMailJobs(e.ctx);
    expect(statusOf(e, sending.stepId)).toBe('accepted');
  });

  it('never sends a Microsoft draft again after Stop, even though the sanctioned resend path exists', async () => {
    const e = await freshEnv('microsoft');
    const sending = await launchSending(e, 'Hold6');
    // The send request failed before Outlook acted: the draft is saved and still a draft, and the outcome is unknown.
    const sentBefore = ms.state.sent.length;
    ms.state.sendScript.push({ type: 'respond', status: 503 });
    await processMailJobs(e.ctx);
    expect(statusOf(e, sending.stepId)).toBe('unknown');
    const attempts = ms.state.sendAttempts.length;
    expect(attempts).toBeGreaterThan(0);
    expect(Object.values(ms.state.messages).filter((message) => message.isDraft)).toHaveLength(1);
    expect(ms.state.sent).toHaveLength(sentBefore);
    expect(stopFollowupRule(e.ctx, sending.ruleId).status).toBe('stopped');
    // Long past the wait before a saved draft may be sent again, which a live rule would have allowed.
    warpTo(e, Date.parse(e.ctx.now()) + 60_000);
    await processMailJobs(e.ctx);
    await processMailJobs(e.ctx);
    // The check still reads the draft, which can only learn the truth, but the resend it would have made is refused.
    const draftId = (e.db.prepare('SELECT provider_draft_id FROM send_intent WHERE id = ?').get(sending.stepId) as { provider_draft_id: string }).provider_draft_id;
    expect(ms.state.paths).toContain(`GET /v1.0/me/messages/${draftId}`);
    expect(statusOf(e, sending.stepId)).toBe('unknown');
    expect(ms.state.sendAttempts).toHaveLength(attempts);
    expect(ms.state.sent).toHaveLength(sentBefore);
    expect(ms.state.messages[draftId]!.isDraft).toBe(true);
    expect(Object.values(ms.state.messages).filter((message) => message.isDraft)).toHaveLength(1);
    // Checking goes on, so a later read can still settle the truth.
    expect(e.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind = 'mail_reconcile' AND status = 'queued'").get()).toEqual({ n: 1 });
  });

  it('refuses the Microsoft resend when the rule stops after the check passed and before the request leaves', async () => {
    const e = await freshEnv('microsoft');
    const sending = await launchSending(e, 'Hold7');
    const sentBefore = ms.state.sent.length;
    ms.state.sendScript.push({ type: 'respond', status: 503 });
    await processMailJobs(e.ctx);
    expect(statusOf(e, sending.stepId)).toBe('unknown');
    const attempts = ms.state.sendAttempts.length;
    warpTo(e, Date.parse(e.ctx.now()) + 60_000);
    // The stop lands while the draft is being read, which is after the claim allowed a resend and before the final guard.
    let stopped = false;
    ms.state.onRequest = ({ method, path }) => {
      if (stopped || method !== 'GET' || !path.startsWith('/me/messages/')) return;
      stopped = true;
      e.db.prepare("UPDATE followup_rule SET status = 'stopped', stopped_reason = 'stopped_by_user', next_due_at = NULL WHERE id = ?").run(sending.ruleId);
    };
    await processMailJobs(e.ctx);
    await processMailJobs(e.ctx);
    expect(stopped).toBe(true);
    expect(statusOf(e, sending.stepId)).toBe('unknown');
    expect(ms.state.sendAttempts).toHaveLength(attempts);
    expect(ms.state.sent).toHaveLength(sentBefore);
  });

  it('lets a read only search settle a Gmail step after Stop, because it can only learn the truth', async () => {
    const e = await freshEnv('gmail');
    const sending = await launchSending(e, 'Hold5');
    google.state.sendScript.push({ type: 'process_then_respond', status: 502 });
    await processMailJobs(e.ctx);
    expect(statusOf(e, sending.stepId)).toBe('unknown');
    stopFollowupRule(e.ctx, sending.ruleId);
    warpTo(e, Date.parse(e.ctx.now()) + 60_000);
    await processMailJobs(e.ctx);
    await processMailJobs(e.ctx);
    expect(statusOf(e, sending.stepId)).toBe('accepted');
    // Exactly one copy of the step went out, and none was sent after the stop.
    expect(google.state.sent.filter((item) => item.subject === 'Re: Hello Hold5')).toHaveLength(1);
    expect(google.state.sendAttempts).toHaveLength(2);
  });
});

describe('resetting all data', () => {
  it('clears the database even when rules, steps, and their circular references exist', async () => {
    const e = await freshEnv();
    const sending = await launchSending(e, 'Wipe');
    await launch(e, 'Wipe2', { send: false });
    expect(ruleCount(e)).toBe(2);
    expect(stepIntents(e, sending.ruleId)).toHaveLength(1);
    expect(() => resetAllData(e.db)).not.toThrow();
    for (const table of ['followup_rule', 'send_intent', 'person', 'approval', 'workspace', 'audit_event']) {
      expect((e.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
  });
});

describe('weekends and expiry wording', () => {
  it('slips a full cap to the next weekday: a Friday due time lands on Monday, not Saturday', async () => {
    const e = await freshEnv();
    const launched = await launch(e, 'Slip');
    tickFollowupRules(e.ctx);
    const friday = localTime(2026, 2, 6, 10);
    e.db.prepare('UPDATE followup_rule SET next_due_at = ? WHERE id = ?').run(friday, launched.ruleId);
    warpTo(e, Date.parse(friday) + 1000);
    insertAcceptedToday(e, launched.personId, 50);
    tickFollowupRules(e.ctx);
    const slipped = ruleRow(e, launched.ruleId).next_due_at!;
    expect(slipped).toBe(localTime(2026, 2, 9, 10));
    expect(new Date(slipped).getDay()).toBe(1);
    // A weekday slip is still one day.
    const midweek = localTime(2026, 2, 4, 10);
    e.db.prepare('UPDATE followup_rule SET next_due_at = ? WHERE id = ?').run(midweek, launched.ruleId);
    warpTo(e, Date.parse(midweek) + 1000);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, launched.ruleId).next_due_at).toBe(localTime(2026, 2, 5, 10));
  });

  it('records overdue or ceiling as the reason an expired rule ended, with its own task wording', async () => {
    const e = await freshEnv();
    const late = await launch(e, 'Late');
    const old = await launch(e, 'Old');
    tickFollowupRules(e.ctx);
    const due = Date.parse(ruleRow(e, late.ruleId).next_due_at!);
    e.db.prepare('UPDATE approval SET decided_at = ? WHERE id = ?').run(new Date(due - 91 * day).toISOString(), old.approvalId);
    // Old is 60 seconds past due and Late is 8 days past due; the ceiling applies to Old only.
    e.db.prepare('UPDATE followup_rule SET next_due_at = ? WHERE id = ?').run(new Date(due + 8 * day).toISOString(), old.ruleId);
    warpTo(e, due + 8 * day + 60_000);
    tickFollowupRules(e.ctx);
    expect(ruleRow(e, late.ruleId)).toMatchObject({ status: 'expired', stopped_reason: 'overdue' });
    expect(ruleRow(e, old.ruleId)).toMatchObject({ status: 'expired', stopped_reason: 'ceiling' });
    expect(taskTitles(e)).toEqual(
      expect.arrayContaining([
        'Follow-up to Late Testwell was not sent: the computer was off past the send window',
        'Follow-up to Old Testwell was not sent: the plan expired 90 days after approval',
      ]),
    );
    expect(listFollowupRules(e.db, e.workspaceId, { status: 'expired' }).items.map((item) => item.stoppedReason).sort()).toEqual(['ceiling', 'overdue']);
  });
});

describe('lane isolation', () => {
  it('reports a rule that throws and carries on with the rest', async () => {
    const e = await freshEnv();
    const first = await launch(e, 'Boom');
    const second = await launch(e, 'Fine');
    tickFollowupRules(e.ctx);
    warpTo(e, Date.parse(ruleRow(e, second.ruleId).next_due_at!) + 1000);
    e.db.exec(`CREATE TRIGGER boom_rule BEFORE UPDATE ON followup_rule WHEN OLD.id = '${first.ruleId}' BEGIN SELECT RAISE(ABORT, 'rule exploded'); END`);
    const errors: unknown[] = [];
    expect(tickFollowupRules(e.ctx, (error) => errors.push(error))).toBe(1);
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toContain('rule exploded');
    expect(ruleRow(e, second.ruleId).status).toBe('sending');
    expect(ruleRow(e, first.ruleId).status).toBe('armed');
    e.db.exec('DROP TRIGGER boom_rule');
  });
});
