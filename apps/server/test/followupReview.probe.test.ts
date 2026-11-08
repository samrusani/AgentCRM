// Adversarial review probes for rule-bound follow-up sends. Each test names the suspicion it checks.
// "CONFIRMS" tests assert the BAD behavior (they pass when the bug is real). "KILLS" tests assert the safe behavior.
// Every probe that once confirmed a bug was flipped to a KILLS test when its fix landed; only the documented limitation
// below still confirms.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prepareSendIntents, stopFollowupRule, syncMail, tickFollowupRules } from '../src/actions/index.js';
import { resetAllData } from '../src/actions/workspace.js';
import { countReserved, countSentToday, dayStartFor } from '../src/queries/sendIntents.js';
import { dueAfter } from '../src/actions/followupRules.js';
import { followupSubject } from '../src/mail/rules.js';
import { startWorker, processMailJobs } from '../src/jobs/worker.js';
import { type AgentmailStub, startAgentmailStub, useAgentmailStub } from './agentmailStub.js';
import { type GoogleStub, startGoogleStub, useGoogleStub } from './googleStub.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';
import { addDraft, addPerson, approve, connectGmail, connectImap, connectMail, drain, insertAcceptedToday, intentOf, markMailSynced, statusOf } from './mailHelpers.js';
import { type FakeMailTransport, useMailTransportStub } from './mailTransportStub.js';

let agentmail: AgentmailStub;
let google: GoogleStub;
let imap: FakeMailTransport;
let restoreAgentmail: () => void;
let restoreGoogle: () => void;
let restoreImap: () => void;
const environments: TestEnvironment[] = [];

beforeAll(async () => {
  agentmail = await startAgentmailStub();
  restoreAgentmail = useAgentmailStub(agentmail);
  google = await startGoogleStub();
  restoreGoogle = useGoogleStub(google);
  ({ stub: imap, restore: restoreImap } = useMailTransportStub());
});

afterEach(() => {
  agentmail.reset();
  google.reset();
  imap.reset();
});

afterAll(async () => {
  await agentmail.close();
  await google.close();
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

async function freshEnv(kind: 'agentmail' | 'imap' | 'gmail' = 'agentmail'): Promise<TestEnvironment> {
  const env = createTestEnvironment();
  environments.push(env);
  if (kind === 'imap') await connectImap(env);
  else if (kind === 'gmail') await connectGmail(env, google);
  else await connectMail(env);
  return env;
}

// By default the mailbox counts as freshly polled at the new time, so a due step may be created.
function warpTo(env: TestEnvironment, isoOrMs: string | number, options: { synced?: boolean } = {}): void {
  let time = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  env.ctx.now = () => new Date(time++).toISOString();
  if (options.synced ?? true) markMailSynced(env);
}

interface RuleRow {
  id: string;
  person_id: string;
  intent_id: string;
  status: string;
  next_step: number;
  next_due_at: string | null;
  last_intent_id: string | null;
  stopped_reason: string | null;
}

function ruleRow(env: TestEnvironment, ruleId: string): RuleRow {
  return env.db.prepare('SELECT * FROM followup_rule WHERE id = ?').get(ruleId) as RuleRow;
}

function stepIntents(env: TestEnvironment, ruleId: string) {
  return env.db.prepare('SELECT * FROM send_intent WHERE followup_rule_id = ? ORDER BY followup_step').all(ruleId) as Record<string, any>[];
}

let counter = 0;

async function launch(env: TestEnvironment, name: string, options: { subject?: string; send?: boolean } = {}) {
  counter += 1;
  const email = `${name.toLowerCase()}${counter}@lanternrow.invalid`;
  const person = addPerson(env, name, email);
  const draft = addDraft(env, person.id, options.subject ?? `Hello ${name}`, `Hi ${name}, this is a test message.`);
  const staged = prepareSendIntents(env.ctx, { draftActivityIds: [draft], followups: { steps } });
  approve(env, staged.approval!.id);
  if (options.send ?? true) await drain(env);
  const rule = env.db.prepare('SELECT id FROM followup_rule WHERE intent_id = ?').get(staged.intents[0]!.id) as { id: string };
  return { personId: person.id, anchorId: staged.intents[0]!.id, approvalId: staged.approval!.id, ruleId: rule.id, email };
}

async function launchDue(env: TestEnvironment, name: string, options: { subject?: string } = {}) {
  const launched = await launch(env, name, options);
  tickFollowupRules(env.ctx);
  expect(ruleRow(env, launched.ruleId).status).toBe('armed');
  warpTo(env, Date.parse(ruleRow(env, launched.ruleId).next_due_at!) + 1000);
  return launched;
}

function localTime(year: number, month: number, dayOfMonth: number, hour: number, minute = 0): string {
  return new Date(year, month - 1, dayOfMonth, hour, minute, 0).toISOString();
}

describe('INVARIANT: one active rule per person', () => {
  // KILLS: staging excludes a person with an active rule (followup_armed), but a rule only exists after approval, so the
  // approval enforces it too. Two drafts to one person with different subjects, in ONE approval, give one rule.
  it('KILLS: one approval with two different-subject drafts for the same person creates one active rule', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Dup', 'dup@lanternrow.invalid');
    const a = addDraft(env, person.id, 'First topic', 'Body about the first topic.');
    const b = addDraft(env, person.id, 'Second topic', 'Body about the second topic.');
    const staged = prepareSendIntents(env.ctx, { draftActivityIds: [a, b], followups: { steps } });
    expect(staged.intents).toHaveLength(2);
    const decision = approve(env, staged.approval!.id) as any;
    const active = env.db.prepare("SELECT * FROM followup_rule WHERE person_id = ? AND status IN ('waiting','armed','sending')").all(person.id) as RuleRow[];
    expect(active).toHaveLength(1);
    expect(active[0]!.intent_id).toBe(staged.intents[0]!.id);
    expect(decision.followupSkipped).toEqual([expect.objectContaining({ intentId: staged.intents[1]!.id, personId: person.id, reason: 'same_approval' })]);
  });

  it('KILLS: two separate approvals for one person (staged before either is decided) create one active rule and one nudge', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Dup2', 'dup2@lanternrow.invalid');
    const first = prepareSendIntents(env.ctx, { draftActivityIds: [addDraft(env, person.id, 'Topic A', 'Body A is here.')], followups: { steps } });
    const second = prepareSendIntents(env.ctx, { draftActivityIds: [addDraft(env, person.id, 'Topic B', 'Body B is here.')], followups: { steps } });
    expect(second.excluded).toHaveLength(0); // followup_armed cannot fire at staging: no rule exists yet
    approve(env, first.approval!.id);
    const decision = approve(env, second.approval!.id) as any;
    expect(decision.followupSkipped).toEqual([expect.objectContaining({ intentId: second.intents[0]!.id, reason: 'active_rule' })]);
    await drain(env);
    tickFollowupRules(env.ctx);
    const active = env.db.prepare("SELECT * FROM followup_rule WHERE person_id = ? AND status IN ('waiting','armed','sending')").all(person.id) as RuleRow[];
    expect(active).toHaveLength(1);
    // The one rule fires once: a single nudge, not two in one day.
    for (const rule of active) env.db.prepare('UPDATE followup_rule SET next_due_at = ? WHERE id = ?').run(new Date(Date.parse(env.ctx.now()) - 1000).toISOString(), rule.id);
    markMailSynced(env);
    tickFollowupRules(env.ctx);
    const created = env.db.prepare('SELECT subject FROM send_intent WHERE followup_rule_id IS NOT NULL AND person_id = ?').all(person.id) as { subject: string }[];
    expect(created.map((row) => row.subject)).toEqual(['Re: Topic A']);
  });
});

describe('weekend and cap', () => {
  // KILLS: a cap slip goes through the same weekend adjustment as any due time, so a Friday step slips to Monday.
  it('KILLS: a cap slip from Friday lands on Monday and the step is not created on the weekend', async () => {
    const env = await freshEnv();
    const launched = await launch(env, 'Wknd');
    tickFollowupRules(env.ctx);
    const friday = localTime(2026, 2, 6, 10); // 2026-02-06 is a Friday
    env.db.prepare('UPDATE followup_rule SET next_due_at = ? WHERE id = ?').run(friday, launched.ruleId);
    warpTo(env, Date.parse(friday) + 1000);
    insertAcceptedToday(env, launched.personId, 50);
    tickFollowupRules(env.ctx);
    const slipped = ruleRow(env, launched.ruleId).next_due_at!;
    expect(new Date(slipped).getDay()).toBe(1); // Monday
    // Saturday and Sunday pass with the cap's new day: nothing is created.
    warpTo(env, Date.parse(slipped) - day);
    tickFollowupRules(env.ctx);
    expect(stepIntents(env, launched.ruleId)).toHaveLength(0);
    // Monday arrives and the step is created then.
    warpTo(env, Date.parse(slipped) + 1000);
    tickFollowupRules(env.ctx);
    const created = stepIntents(env, launched.ruleId);
    expect(created).toHaveLength(1);
    expect(new Date(created[0]!.created_at).getDay()).toBe(1);
  });

  it('KILLS: dueAfter never returns Saturday or Sunday (local) across DST changes in several zones', () => {
    const original = process.env.TZ;
    try {
      for (const zone of ['America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Apia', 'UTC']) {
        process.env.TZ = zone;
        for (let hour = 0; hour < 24; hour += 1) {
          for (let offset = 0; offset < 400; offset += 7) {
            const from = new Date(Date.UTC(2026, 0, 1 + offset, hour, 30)).toISOString();
            for (const waitDays of [1, 2, 3, 5, 30]) {
              const due = new Date(dueAfter(from, waitDays));
              expect([0, 6]).not.toContain(due.getDay());
              expect(due.getTime()).toBeGreaterThanOrEqual(Date.parse(from) + waitDays * day - 3_600_000 * 2);
            }
          }
        }
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('KILLS: two rules due in one tick cannot exceed the daily cap (reserved intents count)', async () => {
    const env = await freshEnv();
    const one = await launch(env, 'CapA');
    const two = await launch(env, 'CapB');
    tickFollowupRules(env.ctx); // arms both
    const due = Date.parse(ruleRow(env, two.ruleId).next_due_at!) + 1000;
    warpTo(env, due);
    const inbox = (env.db.prepare('SELECT inbox_id FROM send_intent LIMIT 1').get() as { inbox_id: string }).inbox_id;
    const used = () => countSentToday(env.db, env.workspaceId, inbox, dayStartFor(env.ctx.now())) + countReserved(env.db, env.workspaceId, inbox);
    insertAcceptedToday(env, one.personId, 50 - used() - 1); // exactly one place left
    expect(used()).toBe(49);
    tickFollowupRules(env.ctx);
    tickFollowupRules(env.ctx);
    expect(used()).toBe(50);
    const created = env.db.prepare('SELECT COUNT(*) AS n FROM send_intent WHERE followup_rule_id IS NOT NULL').get() as { n: number };
    expect(created.n).toBe(1);
  });
});

describe('reply races', () => {
  // KILLS (ordering): a due step is created only after a poll that finished after its due time. The real worker runs the
  // follow-up tick immediately BEFORE it starts the poll, so with a slow poll (800ms here, a real Gmail/IMAP round trip is
  // similar) the first tick finds the mailbox unread since before the due time and waits. The poll then stores the reply,
  // and the next tick stops the rule instead of nudging someone who already answered.
  it('KILLS: the real worker does not send the follow-up when the recipient already replied at the provider (reply not yet synced)', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'Racer');
    const nowMs = Date.parse(env.ctx.now());
    // The last poll finished before the step became due.
    markMailSynced(env, new Date(Date.parse(ruleRow(env, launched.ruleId).next_due_at!) - 1000).toISOString());
    agentmail.addInbound({ from: launched.email, timestamp: new Date(nowMs - 5_000).toISOString(), subject: 'Re: Hello Racer', text: 'Thanks, but I am not interested.' });

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(typeof input === 'string' ? input : (input.url ?? input));
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.includes('/messages')) await new Promise((resolve) => setTimeout(resolve, 250));
      return realFetch(input, init);
    }) as typeof fetch;
    const errors: unknown[] = [];
    const inboundCount = () => (env.db.prepare("SELECT COUNT(*) AS n FROM email_message WHERE direction = 'in' AND from_email = ?").get(launched.email) as { n: number }).n;
    // The follow-up lane normally ticks once per poll interval. A short interval lets the test see the tick after the poll.
    const previousTick = process.env.AGENTCRM_FOLLOWUP_TICK_MS;
    process.env.AGENTCRM_FOLLOWUP_TICK_MS = '100';
    const worker = startWorker(env.ctx, (error) => errors.push(error), { recover: false });
    try {
      const deadline = Date.now() + 15_000;
      let sawStepBeforeSync = false;
      while (Date.now() < deadline && ruleRow(env, launched.ruleId).status !== 'stopped') {
        if (inboundCount() === 0 && stepIntents(env, launched.ruleId).length > 0) sawStepBeforeSync = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(sawStepBeforeSync).toBe(false); // nothing was created while the reply was unsynced
      expect(inboundCount()).toBe(1); // the poll stored the reply ...
      expect(ruleRow(env, launched.ruleId)).toMatchObject({ status: 'stopped', stopped_reason: 'replied' }); // ... and the rule stopped
      expect(stepIntents(env, launched.ruleId)).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 700)); // give the mail lane time to send anything it wrongly could
      expect(agentmail.state.sent.some((item) => item.subject === 'Re: Hello Racer')).toBe(false);
    } finally {
      worker.stop();
      globalThis.fetch = realFetch;
      if (previousTick === undefined) delete process.env.AGENTCRM_FOLLOWUP_TICK_MS;
      else process.env.AGENTCRM_FOLLOWUP_TICK_MS = previousTick;
    }
    expect(errors).toEqual([]);
  }, 30_000);

  // KILLS: the connector says the last successful poll was three days ago and the last poll failed, so the due step waits.
  it('KILLS: no follow-up is created while the last successful poll was days ago and the last poll failed', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'Stale');
    const row = env.db.prepare("SELECT id, settings FROM connector WHERE kind = 'agentmail'").get() as { id: string; settings: string };
    const settings = { ...JSON.parse(row.settings), lastSyncAt: new Date(Date.parse(env.ctx.now()) - 3 * day).toISOString(), lastSyncError: 'AgentMail is rate limiting requests. The next poll will try again.' };
    env.db.prepare('UPDATE connector SET settings = ? WHERE id = ?').run(JSON.stringify(settings), row.id);
    tickFollowupRules(env.ctx);
    await drain(env);
    expect(stepIntents(env, launched.ruleId)).toHaveLength(0);
    expect(ruleRow(env, launched.ruleId).status).toBe('armed');
    expect(agentmail.state.sent.some((item) => item.subject.startsWith('Re:'))).toBe(false);
    // A later good poll releases it.
    markMailSynced(env);
    tickFollowupRules(env.ctx);
    await drain(env);
    expect(statusOf(env, stepIntents(env, launched.ruleId)[0]!.id)).toBe('accepted');
  });

  it('KILLS: a reply that is synced between tick and submit blocks the step (second layer works when sync has run)', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'Layer2');
    tickFollowupRules(env.ctx);
    const step = stepIntents(env, launched.ruleId)[0]!;
    agentmail.addInbound({ from: launched.email, timestamp: new Date(Date.parse(env.ctx.now()) + 5).toISOString(), subject: 'Re: Hello Layer2' });
    await syncMail(env.ctx);
    await drain(env);
    expect(['blocked', 'cancelled']).toContain(statusOf(env, step.id));
    expect(agentmail.state.sent.some((item) => item.subject.startsWith('Re:'))).toBe(false);
  });

  it('KILLS: a reply whose provider timestamp predates the anchor (clock skew) misses layer 1 but layer 2 still blocks', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'Skew');
    // stored locally now, but stamped long before the anchor was submitted
    env.db
      .prepare(
        `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, provider_thread_id, direction, person_id, from_email, "to", subject, preview, body_text, labels, provider_timestamp)
         VALUES (?, ?, ?, 'pm_skew', 'thr_x', 'in', ?, ?, '[]', 'Re: x', 'ok', 'ok', '[]', '2020-01-01T00:00:00.000Z')`,
      )
      .run(env.ctx.newId('msg'), env.ctx.now(), env.workspaceId, launched.personId, launched.email);
    tickFollowupRules(env.ctx);
    const created = stepIntents(env, launched.ruleId);
    expect(created).toHaveLength(1); // layer 1 missed it
    await drain(env);
    expect(statusOf(env, created[0]!.id)).toBe('blocked'); // layer 2 caught it
  });

  // Documents a limit of the existing reply model: an unthreaded reply from another address of the same person is not
  // linked to anyone, so nothing stops the rule.
  it('CONFIRMS (limitation): a reply from an alias address on a new thread does not stop the rule', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'Alias');
    agentmail.addInbound({ from: 'alias.of.person@other-domain.invalid', timestamp: new Date(Date.parse(env.ctx.now()) - 2_000).toISOString(), subject: 'Not interested', thread_id: 'thr_new' });
    await syncMail(env.ctx);
    tickFollowupRules(env.ctx);
    expect(ruleRow(env, launched.ruleId).status).toBe('sending');
    await drain(env);
    expect(statusOf(env, stepIntents(env, launched.ruleId)[0]!.id)).toBe('accepted');
  });
});

describe('stop semantics', () => {
  // KILLS: Stop only cancels queued/approved step intents, but a step in `unknown` whose rule has stopped is never
  // retried by reconcile, so "Nothing more will be sent" holds. It keeps its unknown task for a person to check.
  it('KILLS: a step left unknown by a 503 is not delivered by the reconcile retry after Stop', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'StopUnknown');
    tickFollowupRules(env.ctx);
    const step = stepIntents(env, launched.ruleId)[0]!;
    agentmail.state.sendScript.push({ type: 'respond', status: 503 });
    await processMailJobs(env.ctx);
    expect(statusOf(env, step.id)).toBe('unknown');
    const rule = stopFollowupRule(env.ctx, launched.ruleId);
    expect(rule.status).toBe('stopped');
    expect(statusOf(env, step.id)).toBe('unknown'); // stop could not touch it
    warpTo(env, Date.parse(env.ctx.now()) + 5_000);
    await processMailJobs(env.ctx);
    await processMailJobs(env.ctx);
    expect(statusOf(env, step.id)).toBe('unknown');
    expect(agentmail.state.sent.some((item) => item.subject === 'Re: Hello StopUnknown')).toBe(false);
    const tasks = env.db.prepare("SELECT title FROM task WHERE status = 'open'").all() as { title: string }[];
    expect(tasks.map((task) => task.title)).toContain('Check whether the email to StopUnknown Testwell was sent');
  });

  it('KILLS: stopping while a step is submitting leaves the rule stopped and creates no later step', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'StopSub');
    tickFollowupRules(env.ctx);
    const step = stepIntents(env, launched.ruleId)[0]!;
    env.db.prepare("UPDATE send_intent SET status = 'submitting' WHERE id = ?").run(step.id);
    stopFollowupRule(env.ctx, launched.ruleId);
    expect(statusOf(env, step.id)).toBe('submitting');
    env.db.prepare("UPDATE send_intent SET status = 'accepted' WHERE id = ?").run(step.id);
    warpTo(env, Date.parse(env.ctx.now()) + 60 * day);
    tickFollowupRules(env.ctx);
    expect(stepIntents(env, launched.ruleId)).toHaveLength(1);
    expect(ruleRow(env, launched.ruleId).status).toBe('stopped');
  });
});

describe('tamper and validation', () => {
  it('KILLS: editing the stored rule steps does not change what is sent (submit verifies against the approved payload)', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'Tamper');
    env.db.prepare('UPDATE followup_rule SET steps = ? WHERE id = ?').run(JSON.stringify([{ waitDays: 1, body: 'Buy my crypto course now please.' }]), launched.ruleId);
    tickFollowupRules(env.ctx);
    await drain(env);
    const step = stepIntents(env, launched.ruleId)[0]!;
    expect(step.body).toBe('Buy my crypto course now please.'); // the rule row WAS trusted for creation
    expect(statusOf(env, step.id)).toBe('blocked'); // but the submit recheck refuses it
    expect(agentmail.state.sent.some((item) => item.text?.includes('crypto'))).toBe(false);
  });

  it('KILLS: editing the step intent body or subject after creation is refused at submit', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'Tamper2');
    tickFollowupRules(env.ctx);
    const step = stepIntents(env, launched.ruleId)[0]!;
    env.db.prepare("UPDATE send_intent SET subject = 'Re: something else' WHERE id = ?").run(step.id);
    await drain(env);
    expect(statusOf(env, step.id)).toBe('blocked');
  });

  it('KILLS: editing the approved payload without its hash blocks the step', async () => {
    const env = await freshEnv();
    const launched = await launchDue(env, 'Tamper3');
    tickFollowupRules(env.ctx);
    const row = env.db.prepare('SELECT payload FROM approval WHERE id = ?').get(launched.approvalId) as { payload: string };
    env.db.prepare('UPDATE approval SET payload = ? WHERE id = ?').run(row.payload.replace('One last nudge', 'Two last nudge'), launched.approvalId);
    await drain(env);
    expect(statusOf(env, stepIntents(env, launched.ruleId)[0]!.id)).toBe('blocked');
  });

  it('KILLS: the route rejects coerced, extra, empty, and over-long follow-up input', async () => {
    const env = await freshEnv();
    const person = addPerson(env, 'Val', 'val@lanternrow.invalid');
    const draft = addDraft(env, person.id, 'Hello Val', 'Hi Val.');
    const bad: unknown[] = [
      { steps: [{ waitDays: '3', body: 'A perfectly good follow-up body.' }] },
      { steps: [{ waitDays: 3.5, body: 'A perfectly good follow-up body.' }] },
      { steps: [{ waitDays: 0, body: 'A perfectly good follow-up body.' }] },
      { steps: [{ waitDays: 31, body: 'A perfectly good follow-up body.' }] },
      { steps: [{ waitDays: 3, body: '          short   ' }] },
      { steps: [{ waitDays: 3, body: 'x'.repeat(2001) }] },
      { steps: [{ waitDays: 3, body: 'A perfectly good follow-up body.', extra: 1 }] },
      { steps: [] },
      // Contract: one to five steps, and waits that add up to 90 days or more are refused at staging.
      { steps: [steps[0], steps[1], steps[0], steps[1], steps[0], steps[1]] },
      { steps: [{ waitDays: 30, body: 'A perfectly good follow-up body.' }, { waitDays: 30, body: 'A perfectly good follow-up body.' }, { waitDays: 30, body: 'A perfectly good follow-up body.' }] },
      { steps: [steps[0]], extra: true },
      null,
      [],
      'steps',
    ];
    for (const followups of bad) {
      expect(() => prepareSendIntents(env.ctx, { draftActivityIds: [draft], followups })).toThrow();
    }
    // five steps within the ceiling are accepted (waits add up to 89 days)
    const five = [30, 30, 25, 3, 1].map((waitDays) => ({ waitDays, body: 'A perfectly good follow-up body.' }));
    expect(() => prepareSendIntents(env.ctx, { draftActivityIds: [draft], followups: { steps: five } })).not.toThrow();
    // exactly 10 trimmed characters and 2000 characters are accepted
    expect(() => prepareSendIntents(env.ctx, { draftActivityIds: [draft], followups: { steps: [{ waitDays: 30, body: '  0123456789  ' }] } })).not.toThrow();
  });

  it('KILLS: Re: handling for odd subjects', () => {
    expect(followupSubject('Re: hi')).toBe('Re: hi');
    expect(followupSubject('RE: hi')).toBe('RE: hi');
    expect(followupSubject('  re:hi')).toBe('  re:hi');
    expect(followupSubject('Hello')).toBe('Re: Hello');
    expect(followupSubject('Ré: Hello')).toBe('Re: Ré: Hello');
    expect(followupSubject('x'.repeat(300))).toBe(`Re: ${'x'.repeat(300)}`);
    expect(followupSubject('')).toBe('Re: ');
  });
});

describe('threading headers', () => {
  it('KILLS: a CRLF in a persisted followup_reply_to is refused by the IMAP composer and nothing is sent', async () => {
    const env = await freshEnv('imap');
    const launched = await launchDue(env, 'Hdr');
    tickFollowupRules(env.ctx);
    const step = stepIntents(env, launched.ruleId)[0]!;
    env.db
      .prepare('UPDATE send_intent SET followup_reply_to = ? WHERE id = ?')
      .run(JSON.stringify({ threadId: 't', inReplyTo: '<a@b>\r\nBcc: evil@evil.invalid', references: ['<a@b>'] }), step.id);
    const sentBefore = imap.sent.length;
    await drain(env);
    expect(imap.sent.length).toBe(sentBefore);
    expect(['failed', 'blocked', 'unknown']).toContain(statusOf(env, step.id));
  });

  it('KILLS: non-follow-up intents never carry a reply reference', async () => {
    const env = await freshEnv('imap');
    const launched = await launch(env, 'NoThread');
    expect((intentOf(env, launched.anchorId) as any).followupReplyTo ?? null).toBeNull();
    const row = env.db.prepare('SELECT followup_reply_to FROM send_intent WHERE id = ?').get(launched.anchorId) as { followup_reply_to: string | null };
    expect(row.followup_reply_to).toBeNull();
  });
});

describe('regressions outside the lane', () => {
  // KILLS: crm seed --reset used to fail on the circular followup_rule and send_intent references as soon as any rule
  // existed. It now clears the references first and deletes the rules before the intents.
  it('KILLS: resetAllData succeeds and empties the database once a follow-up rule exists', async () => {
    const env = await freshEnv();
    await launch(env, 'Reset', { send: false });
    expect((env.db.prepare('SELECT COUNT(*) AS n FROM followup_rule').get() as { n: number }).n).toBe(1);
    expect(() => resetAllData(env.db)).not.toThrow();
    for (const table of ['followup_rule', 'send_intent', 'approval', 'person', 'workspace']) {
      expect((env.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
  });
});
