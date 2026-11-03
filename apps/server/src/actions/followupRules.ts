import { z } from 'zod';
import { dailySendCap, followupTickMilliseconds } from '../config.js';
import { conflict, notFound } from '../errors.js';
import {
  followupCeilingTaskTitle,
  followupExpiredTaskTitle,
  followupStepNotSentTaskTitle,
  followupSubject,
} from '../mail/rules.js';
import type { MailProviderKind } from '../providers/mailTypes.js';
import {
  activeFollowupStatuses,
  type FollowupRule,
  type FollowupRuleStatus,
  type FollowupStep,
  parseSteps,
  requireFollowupRule,
} from '../queries/followupRules.js';
import { getActiveMailAccount, getActiveMailConnector, getMailAccount } from '../queries/mailProvider.js';
import { countReserved, countSentToday, dayStartFor, findSuppression } from '../queries/sendIntents.js';
import { type ActionContext, emitRecord, mutate, type Tx } from './context.js';
import { ensureTaskIn, type FrozenMessage, messageHash, transitionIntentIn } from './sendIntentState.js';

// The follow-up plan a person attaches when staging a send. One or two steps. The body is trimmed before its length
// is checked, and the same text goes to every recipient in the batch.
export const followupsInputSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            waitDays: z.number().int().min(1).max(30),
            body: z.string().trim().min(10).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict();

export type FollowupsInput = z.output<typeof followupsInputSchema>;

const dayMilliseconds = 24 * 60 * 60 * 1000;
// A due step more than this far past its due time is not sent, for example because the computer was off.
export const followupOverdueMilliseconds = 7 * dayMilliseconds;
// A rule still unfinished this long after its approval expires.
export const followupCeilingMilliseconds = 90 * dayMilliseconds;

interface RuleRow {
  id: string;
  created_at: string;
  workspace_id: string;
  person_id: string;
  intent_id: string;
  approval_id: string;
  provider: MailProviderKind;
  status: FollowupRuleStatus;
  steps: string;
  next_step: number;
  next_due_at: string | null;
  last_intent_id: string | null;
  stopped_reason: string | null;
  updated_at: string;
}

interface AnchorRow {
  id: string;
  person_id: string;
  inbox_id: string;
  to_email: string;
  subject: string;
  status: string;
  submitted_at: string | null;
  updated_at: string;
  created_at: string;
  provider: MailProviderKind;
  message_id_header: string | null;
  provider_thread_id: string | null;
}

// The time a step is due: the wait after `from`, with a Saturday or Sunday slipped to the following Monday at the
// same time of day (server local time).
export function dueAfter(from: string, waitDays: number): string {
  const start = Date.parse(from);
  const date = new Date((Number.isFinite(start) ? start : Date.now()) + waitDays * dayMilliseconds);
  const weekday = date.getDay();
  if (weekday === 6) date.setDate(date.getDate() + 2);
  else if (weekday === 0) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function emitRule(tx: Tx, rule: Pick<RuleRow, 'id' | 'person_id'>): void {
  tx.emit({ type: 'followup_updated', ruleId: rule.id, personId: rule.person_id });
}

interface RulePatch {
  nextStep?: number;
  nextDueAt?: string | null;
  stoppedReason?: string | null;
}

// The only place a rule changes status. The row must still be in one of the `from` states, so two writers cannot both
// move it. Every transition is audited and announced.
function transitionRuleIn(
  tx: Tx,
  rule: RuleRow,
  from: readonly FollowupRuleStatus[],
  to: FollowupRuleStatus,
  patch: RulePatch,
  action: string,
  detail: Record<string, unknown> = {},
): boolean {
  const assignments = ['status = ?', 'updated_at = ?'];
  const params: unknown[] = [to, tx.now()];
  if (patch.nextStep !== undefined) {
    assignments.push('next_step = ?');
    params.push(patch.nextStep);
  }
  if (patch.nextDueAt !== undefined) {
    assignments.push('next_due_at = ?');
    params.push(patch.nextDueAt);
  }
  if (patch.stoppedReason !== undefined) {
    assignments.push('stopped_reason = ?');
    params.push(patch.stoppedReason);
  }
  const result = tx.db
    .prepare(`UPDATE followup_rule SET ${assignments.join(', ')} WHERE id = ? AND workspace_id = ? AND status IN (${from.map(() => '?').join(', ')})`)
    .run(...params, rule.id, tx.workspaceId, ...from);
  if (result.changes === 0) return false;
  tx.audit(`followup_rule.${action}`, 'followup_rule', rule.id, { from: rule.status, to, ...detail });
  emitRule(tx, rule);
  return true;
}

function stopRuleIn(tx: Tx, rule: RuleRow, from: readonly FollowupRuleStatus[], reason: string, extra: Record<string, unknown> = {}): boolean {
  return transitionRuleIn(tx, rule, from, 'stopped', { stoppedReason: reason, nextDueAt: null }, 'stop', { reason, ...extra });
}

function personNameOf(tx: Tx, personId: string): string {
  const row = tx.db.prepare('SELECT first_name, last_name FROM person WHERE id = ? AND workspace_id = ?').get(personId, tx.workspaceId) as
    | { first_name: string; last_name: string }
    | undefined;
  return row ? `${row.first_name} ${row.last_name}`.trim() : 'this person';
}

function getRuleRow(tx: Tx, ruleId: string): RuleRow | undefined {
  return tx.db.prepare('SELECT * FROM followup_rule WHERE id = ? AND workspace_id = ?').get(ruleId, tx.workspaceId) as RuleRow | undefined;
}

function getIntentRow(tx: Tx, intentId: string): AnchorRow | undefined {
  return tx.db.prepare('SELECT * FROM send_intent WHERE id = ? AND workspace_id = ?').get(intentId, tx.workspaceId) as AnchorRow | undefined;
}

// Reads the follow-up plan out of an approved send_review payload. The approval decision already verified the payload
// hash, so these are the steps the person saw. Returns null when the payload carries no plan.
export function readFrozenFollowups(payload: unknown): FollowupStep[] | null {
  const parsed = z.object({ followups: z.unknown().optional() }).safeParse(payload);
  if (!parsed.success || parsed.data.followups === undefined) return null;
  const plan = followupsInputSchema.safeParse(parsed.data.followups);
  if (!plan.success) throw conflict('The follow-up plan in this approval is not valid, so nothing was approved. Reject it and prepare the send again.');
  return plan.data.steps;
}

// Called inside the approval decision for each intent that was queued. The steps come from the approved payload.
export function createFollowupRuleIn(
  tx: Tx,
  input: { personId: string; intentId: string; approvalId: string; provider: MailProviderKind; steps: FollowupStep[] },
): string {
  const id = tx.newId('fur');
  const now = tx.now();
  tx.db
    .prepare(
      `INSERT INTO followup_rule (id, created_at, workspace_id, person_id, intent_id, approval_id, provider, status, steps, next_step, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, 1, ?)`,
    )
    .run(id, now, tx.workspaceId, input.personId, input.intentId, input.approvalId, input.provider, JSON.stringify(input.steps), now);
  tx.audit('followup_rule.create', 'followup_rule', id, {
    intentId: input.intentId,
    approvalId: input.approvalId,
    provider: input.provider,
    steps: input.steps.length,
  });
  emitRule(tx, { id, person_id: input.personId });
  return id;
}

// Stops every active rule of a provider. `provider` stops that provider's rules (its connector was removed), and
// `notProvider` stops every rule of the others (the sending provider was switched). No task: the rule list shows why.
export function stopRulesForProviderIn(tx: Tx, where: { provider?: MailProviderKind; notProvider?: MailProviderKind }, reason: string): number {
  const clauses = ['workspace_id = ?', `status IN (${activeFollowupStatuses.map(() => '?').join(', ')})`];
  const params: unknown[] = [tx.workspaceId, ...activeFollowupStatuses];
  if (where.provider) {
    clauses.push('provider = ?');
    params.push(where.provider);
  }
  if (where.notProvider) {
    clauses.push('provider != ?');
    params.push(where.notProvider);
  }
  const rows = tx.db.prepare(`SELECT * FROM followup_rule WHERE ${clauses.join(' AND ')}`).all(...params) as RuleRow[];
  let stopped = 0;
  for (const rule of rows) {
    if (stopRuleIn(tx, rule, activeFollowupStatuses, reason)) {
      cancelQueuedStepIn(tx, rule, 'The follow-up rule stopped because the sending connector changed.');
      stopped += 1;
    }
  }
  return stopped;
}

// A step intent that has not left the queue is cancelled with the rule. One that is being submitted cannot be called back.
function cancelQueuedStepIn(tx: Tx, rule: RuleRow, reason: string): void {
  if (!rule.last_intent_id) return;
  transitionIntentIn(tx, rule.last_intent_id, ['awaiting_approval', 'approved', 'queued'], 'cancelled', { error: reason }, 'cancel', { by: tx.actor, followupRuleId: rule.id });
}

// Stops a rule by hand. A rule that is already stopped answers with itself, so a second click changes nothing. A rule
// that finished or expired cannot be stopped.
export function stopFollowupRule(ctx: ActionContext, ruleId: string): FollowupRule {
  mutate(ctx, (tx) => {
    const rule = getRuleRow(tx, ruleId);
    if (!rule) throw notFound('Follow-up rule');
    if (rule.status === 'stopped') return;
    if (rule.status === 'done' || rule.status === 'expired') {
      throw conflict(`This follow-up rule is ${rule.status}, so it cannot be stopped.`);
    }
    if (stopRuleIn(tx, rule, activeFollowupStatuses, 'stopped_by_user', { by: tx.actor })) {
      cancelQueuedStepIn(tx, rule, 'The follow-up rule was stopped by a person.');
    }
  });
  return requireFollowupRule(ctx.db, ctx.workspaceId, ruleId);
}

// --- The worker's tick ---------------------------------------------------------------------------------------------

function repliedAfter(tx: Tx, rule: RuleRow, anchor: AnchorRow): boolean {
  const since = anchor.submitted_at ?? anchor.updated_at;
  const replied = tx.db
    .prepare(
      `SELECT 1 FROM email_message WHERE workspace_id = ? AND direction = 'in' AND (person_id = ? OR from_email = ?) AND provider_timestamp > ? LIMIT 1`,
    )
    .get(tx.workspaceId, rule.person_id, anchor.to_email.toLowerCase(), since);
  if (replied) return true;
  const settledAsReplied = tx.db
    .prepare("SELECT 1 FROM send_intent WHERE workspace_id = ? AND status = 'replied' AND (id = ? OR followup_rule_id = ?) LIMIT 1")
    .get(tx.workspaceId, anchor.id, rule.id);
  return Boolean(settledAsReplied);
}

function bouncedBefore(tx: Tx, rule: RuleRow): boolean {
  return Boolean(
    tx.db
      .prepare("SELECT 1 FROM send_intent WHERE workspace_id = ? AND status = 'bounced' AND (id = ? OR followup_rule_id = ?) LIMIT 1")
      .get(tx.workspaceId, rule.intent_id, rule.id),
  );
}

function connectorChanged(tx: Tx, rule: RuleRow, anchor: AnchorRow): boolean {
  if (!getMailAccount(tx.db, tx.workspaceId, rule.provider)) return true;
  const active = getActiveMailAccount(tx.db, tx.workspaceId);
  return !active || active.kind !== rule.provider || active.accountId !== anchor.inbox_id;
}

// An expired rule says why: more than 7 days past a due step ('overdue'), or 90 days past its approval ('ceiling').
function expire(tx: Tx, rule: RuleRow, reason: 'overdue' | 'ceiling'): boolean {
  const moved = transitionRuleIn(tx, rule, ['armed'], 'expired', { nextDueAt: null, stoppedReason: reason }, 'expire', { reason });
  if (moved) {
    const who = personNameOf(tx, rule.person_id);
    ensureTaskIn(tx, { title: reason === 'ceiling' ? followupCeilingTaskTitle(who) : followupExpiredTaskTitle(who), personId: rule.person_id });
  }
  return moved;
}

// True when the mail provider in use finished a poll without an error at a time after `dueMilliseconds`. A due step is
// created only then: sending before looking at the mailbox could nudge someone who already replied.
function syncedAfter(tx: Tx, rule: RuleRow, dueMilliseconds: number): boolean {
  const connector = getActiveMailConnector(tx.db, tx.workspaceId);
  if (!connector || connector.kind !== rule.provider) return false;
  if (connector.settings.lastSyncError) return false;
  const syncedAt = connector.settings.lastSyncAt ? Date.parse(connector.settings.lastSyncAt) : Number.NaN;
  return Number.isFinite(syncedAt) && syncedAt > dueMilliseconds;
}

// Stop conditions, checked for every active rule at every tick, due or not. Returns the reason, or null to carry on.
function stopReasonFor(tx: Tx, rule: RuleRow, anchor: AnchorRow): string | null {
  if (repliedAfter(tx, rule, anchor)) return 'replied';
  if (findSuppression(tx.db, tx.workspaceId, anchor.to_email)) return 'suppressed';
  if (bouncedBefore(tx, rule)) return 'bounced';
  if (connectorChanged(tx, rule, anchor)) return 'connector_changed';
  return null;
}

// Returns null when no stop condition holds, otherwise whether this tick moved the rule. A step still in the queue goes
// with the rule.
function applyStopChecks(tx: Tx, rule: RuleRow, anchor: AnchorRow): boolean | null {
  const reason = stopReasonFor(tx, rule, anchor);
  if (!reason) return null;
  const moved = stopRuleIn(tx, rule, activeFollowupStatuses, reason);
  if (moved) cancelQueuedStepIn(tx, rule, 'The follow-up rule stopped.');
  return moved;
}

// The JSON saved on a step intent so its adapter threads the message under the previous accepted one, or null.
export function followupReplyReference(
  provider: MailProviderKind,
  previous: Pick<AnchorRow, 'message_id_header' | 'provider_thread_id'>,
): string | null {
  // AgentMail and Microsoft have no reply path in their adapters, so their follow-ups go out as new messages.
  if (provider !== 'gmail' && provider !== 'imap') return null;
  if (!previous.message_id_header || !previous.provider_thread_id) return null;
  return JSON.stringify({ threadId: previous.provider_thread_id, inReplyTo: previous.message_id_header, references: [previous.message_id_header] });
}

function approvedInboxEmail(tx: Tx, rule: RuleRow): string | null {
  const row = tx.db.prepare('SELECT payload FROM approval WHERE id = ? AND workspace_id = ?').get(rule.approval_id, tx.workspaceId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload) as { messages?: { intentId?: unknown; inboxEmail?: unknown }[] };
    const message = payload.messages?.find((item) => item?.intentId === rule.intent_id);
    return typeof message?.inboxEmail === 'string' && message.inboxEmail !== '' ? message.inboxEmail : null;
  } catch {
    return null;
  }
}

function stepNotSent(tx: Tx, rule: RuleRow, from: readonly FollowupRuleStatus[], detail: Record<string, unknown>): boolean {
  const moved = stopRuleIn(tx, rule, from, 'step_not_sent', detail);
  if (moved) ensureTaskIn(tx, { title: followupStepNotSentTaskTitle(personNameOf(tx, rule.person_id)), personId: rule.person_id });
  return moved;
}

function tickWaiting(tx: Tx, rule: RuleRow, steps: FollowupStep[]): boolean {
  const anchor = getIntentRow(tx, rule.intent_id);
  if (!anchor) return stopRuleIn(tx, rule, ['waiting'], 'not_sent', { anchorStatus: 'missing' });
  if (['failed', 'blocked', 'cancelled', 'replied', 'bounced'].includes(anchor.status)) {
    return stopRuleIn(tx, rule, ['waiting'], 'not_sent', { anchorStatus: anchor.status });
  }
  const stopped = applyStopChecks(tx, rule, anchor);
  if (stopped !== null) return stopped;
  if (anchor.status === 'accepted') {
    const step = steps[rule.next_step - 1];
    if (!step) return stopRuleIn(tx, rule, ['waiting'], 'not_sent', { anchorStatus: anchor.status });
    const due = dueAfter(anchor.updated_at, step.waitDays);
    return transitionRuleIn(tx, rule, ['waiting'], 'armed', { nextDueAt: due }, 'arm', { nextDueAt: due, step: rule.next_step });
  }
  return false;
}

function tickArmed(tx: Tx, rule: RuleRow, steps: FollowupStep[]): boolean {
  const now = tx.now();
  const anchor = getIntentRow(tx, rule.intent_id);
  if (!anchor) return stopRuleIn(tx, rule, ['armed'], 'not_sent', { anchorStatus: 'missing' });
  if (!rule.next_due_at) {
    const step = steps[rule.next_step - 1];
    const due = dueAfter(anchor.updated_at, step?.waitDays ?? 1);
    return transitionRuleIn(tx, rule, ['armed'], 'armed', { nextDueAt: due }, 'reschedule', { nextDueAt: due });
  }
  const due = Date.parse(rule.next_due_at);
  const current = Date.parse(now);
  if (!Number.isFinite(due) || current < due) return false;

  const decided = tx.db.prepare('SELECT decided_at FROM approval WHERE id = ? AND workspace_id = ?').get(rule.approval_id, tx.workspaceId) as
    | { decided_at: string | null }
    | undefined;
  if (current - due > followupOverdueMilliseconds) return expire(tx, rule, 'overdue');
  const decidedAt = decided?.decided_at ? Date.parse(decided.decided_at) : Number.NaN;
  if (Number.isFinite(decidedAt) && current - decidedAt > followupCeilingMilliseconds) return expire(tx, rule, 'ceiling');

  const step = steps[rule.next_step - 1];
  if (!step) return stepNotSent(tx, rule, ['armed'], { reason: 'missing_step', step: rule.next_step });

  // The mailbox must have been read, without error, after the step became due. Until then the rule simply waits: nothing
  // slips, blocks, or gets a task, and the overdue expiry above ends a rule whose mailbox can never be read.
  if (!syncedAfter(tx, rule, due)) return false;

  // A full daily cap moves the step back a day, weekend adjusted. It never blocks and creates nothing.
  const room = dailySendCap - countSentToday(tx.db, tx.workspaceId, anchor.inbox_id, dayStartFor(now)) - countReserved(tx.db, tx.workspaceId, anchor.inbox_id);
  if (room <= 0) {
    const slipped = dueAfter(new Date(due).toISOString(), 1);
    return transitionRuleIn(tx, rule, ['armed'], 'armed', { nextDueAt: slipped }, 'slip', { reason: 'daily_cap', nextDueAt: slipped });
  }

  const previous = rule.next_step > 1 && rule.last_intent_id ? getIntentRow(tx, rule.last_intent_id) : anchor;
  if (!previous || previous.status !== 'accepted') return false;
  const inboxEmail = approvedInboxEmail(tx, rule) ?? getActiveMailAccount(tx.db, tx.workspaceId)?.address ?? anchor.inbox_id;
  const intentId = tx.newId('snd');
  const message: FrozenMessage = {
    intentId,
    to: anchor.to_email,
    subject: followupSubject(anchor.subject),
    body: step.body,
    inboxEmail,
  };

  // Compare and set on (rule, armed, next step). A second tick finds the rule already sending and creates nothing.
  const claimed = tx.db
    .prepare("UPDATE followup_rule SET status = 'sending', next_due_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'armed' AND next_step = ?")
    .run(now, rule.id, tx.workspaceId, rule.next_step);
  if (claimed.changes === 0) return false;
  tx.db
    .prepare(
      `INSERT INTO send_intent (id, created_at, workspace_id, person_id, draft_activity_id, inbox_id, to_email, subject, body, payload_hash, status, approval_id, updated_at, provider, followup_rule_id, followup_step, followup_reply_to)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      intentId,
      now,
      tx.workspaceId,
      rule.person_id,
      anchor.inbox_id,
      message.to,
      message.subject,
      message.body,
      messageHash(message),
      rule.approval_id,
      now,
      rule.provider,
      rule.id,
      rule.next_step,
      followupReplyReference(rule.provider, previous),
    );
  tx.db.prepare('UPDATE followup_rule SET last_intent_id = ? WHERE id = ? AND workspace_id = ?').run(intentId, rule.id, tx.workspaceId);
  tx.audit('send_intent.create', 'send_intent', intentId, { approvalId: rule.approval_id, followupRuleId: rule.id, followupStep: rule.next_step });
  emitRecord(tx, 'send_intent', intentId);
  tx.audit('followup_rule.send_step', 'followup_rule', rule.id, { from: 'armed', to: 'sending', step: rule.next_step, intentId });
  emitRule(tx, rule);
  return true;
}

function tickSending(tx: Tx, rule: RuleRow, steps: FollowupStep[]): boolean {
  const intent = rule.last_intent_id ? getIntentRow(tx, rule.last_intent_id) : undefined;
  if (!intent) return stepNotSent(tx, rule, ['sending'], { reason: 'missing_intent' });
  if (intent.status === 'accepted') {
    if (rule.next_step < steps.length) {
      const next = rule.next_step + 1;
      const due = dueAfter(intent.updated_at, steps[next - 1]!.waitDays);
      return transitionRuleIn(tx, rule, ['sending'], 'armed', { nextStep: next, nextDueAt: due }, 'arm', { nextDueAt: due, step: next });
    }
    return transitionRuleIn(tx, rule, ['sending'], 'done', { nextDueAt: null }, 'done', { step: rule.next_step });
  }
  if (intent.status === 'replied') return stopRuleIn(tx, rule, ['sending'], 'replied', { intentId: intent.id });
  if (intent.status === 'bounced') return stopRuleIn(tx, rule, ['sending'], 'bounced', { intentId: intent.id });
  if (intent.status === 'failed' || intent.status === 'blocked' || intent.status === 'cancelled') {
    return stepNotSent(tx, rule, ['sending'], { intentId: intent.id, intentStatus: intent.status });
  }
  // queued, submitting, and unknown stay as they are. Reconciliation settles an unknown intent.
  return false;
}

function tickRuleIn(tx: Tx, ruleId: string): boolean {
  const rule = getRuleRow(tx, ruleId);
  if (!rule || !(activeFollowupStatuses as readonly string[]).includes(rule.status)) return false;
  const steps = parseSteps(rule.steps);
  if (rule.status === 'waiting') return tickWaiting(tx, rule, steps);
  if (rule.status === 'armed') {
    const anchor = getIntentRow(tx, rule.intent_id);
    const stopped = anchor ? applyStopChecks(tx, rule, anchor) : null;
    if (stopped !== null) return stopped;
    return tickArmed(tx, rule, steps);
  }
  const anchor = getIntentRow(tx, rule.intent_id);
  const stopped = anchor ? applyStopChecks(tx, rule, anchor) : null;
  if (stopped !== null) return stopped;
  return tickSending(tx, rule, steps);
}

// Walks every rule that can still act, one short transaction per rule. Returns how many rules changed. One rule that
// throws is reported and skipped, so it cannot starve the rest.
export function tickFollowupRules(ctx: ActionContext, onError: (error: unknown) => void = defaultOnError): number {
  const ids = ctx.db
    .prepare(`SELECT id FROM followup_rule WHERE workspace_id = ? AND status IN (${activeFollowupStatuses.map(() => '?').join(', ')}) ORDER BY created_at, id`)
    .all(ctx.workspaceId, ...activeFollowupStatuses) as { id: string }[];
  let changed = 0;
  for (const { id } of ids) {
    try {
      if (mutate(ctx, (tx) => tickRuleIn(tx, id))) changed += 1;
    } catch (error) {
      onError(error);
    }
  }
  return changed;
}

function defaultOnError(error: unknown): void {
  console.error(`Follow-up rule tick failed: ${error instanceof Error ? error.message : String(error)}`);
}

const lastTick = new Map<string, number>();

// The worker calls this on every tick. It walks the rules at most once per follow-up interval, which follows the mail
// poll interval.
export function tickFollowupRulesIfDue(ctx: ActionContext, onError?: (error: unknown) => void): number | null {
  const last = lastTick.get(ctx.workspaceId) ?? 0;
  if (Date.now() - last < followupTickMilliseconds()) return null;
  lastTick.set(ctx.workspaceId, Date.now());
  return tickFollowupRules(ctx, onError);
}
