import { hashPayload } from './demoResearch.js';
import { enqueueJobIn } from './jobs.js';
import { emitRecord, type Tx } from './context.js';
import type { IntentStatus } from '../queries/sendIntents.js';
import { reasonCodes } from '../mail/rules.js';

// The exact message a person approves. This object is hashed per intent and also appears in the approval payload.
export interface FrozenMessage {
  intentId: string;
  to: string;
  subject: string;
  body: string;
  inboxEmail: string;
}

export function messageHash(message: FrozenMessage): string {
  return hashPayload(
    JSON.stringify({
      intentId: message.intentId,
      to: message.to,
      subject: message.subject,
      body: message.body,
      inboxEmail: message.inboxEmail,
    }),
  );
}

export interface IntentPatch {
  // Replaces the error text. null clears it.
  error?: string | null;
  // Adds a sentence after any existing error text.
  appendError?: string;
  providerMessageId?: string;
  providerThreadId?: string | null;
  // The self generated Message-ID of a Gmail send, written in the same transaction that marks the intent submitting.
  messageIdHeader?: string;
  submittedAt?: string;
  // Set when a person acknowledges an intent whose outcome was unknown.
  unknownAcknowledged?: boolean;
}

export const sendOutreachStepTitles = ['Check recipients', 'Review messages', 'Send messages'] as const;

// Statuses that still have work to do. A run stays running while any of its intents is in one of them.
const unsettledStatuses = ['awaiting_approval', 'approved', 'queued', 'submitting'] as const;

// The only place an intent changes state. The row must be in one of the `from` states, so two writers
// cannot both move the same intent. Every transition is audited and announced.
export function transitionIntentIn(
  tx: Tx,
  intentId: string,
  from: readonly IntentStatus[],
  to: IntentStatus,
  patch: IntentPatch,
  action: string,
  detail: Record<string, unknown> = {},
): boolean {
  const row = tx.db
    .prepare('SELECT status, error FROM send_intent WHERE id = ? AND workspace_id = ?')
    .get(intentId, tx.workspaceId) as { status: IntentStatus; error: string | null } | undefined;
  if (!row || !from.includes(row.status)) return false;
  // An unknown outcome is never settled by guessing. Only a provider answer can move it to accepted, and only a
  // person can acknowledge it.
  if (row.status === 'unknown' && to === 'failed') return false;
  let error = row.error;
  if (patch.error !== undefined) error = patch.error;
  if (patch.appendError) error = error ? `${error} ${patch.appendError}` : patch.appendError;
  const assignments = ['status = ?', 'error = ?', 'updated_at = ?'];
  const params: unknown[] = [to, error, tx.now()];
  if (patch.providerMessageId !== undefined) {
    assignments.push('provider_message_id = ?');
    params.push(patch.providerMessageId);
  }
  if (patch.providerThreadId !== undefined) {
    assignments.push('provider_thread_id = ?');
    params.push(patch.providerThreadId);
  }
  if (patch.messageIdHeader !== undefined) {
    assignments.push('message_id_header = ?');
    params.push(patch.messageIdHeader);
  }
  if (patch.submittedAt !== undefined) {
    assignments.push('submitted_at = ?');
    params.push(patch.submittedAt);
  }
  if (patch.unknownAcknowledged !== undefined) {
    assignments.push('unknown_acknowledged = ?');
    params.push(patch.unknownAcknowledged ? 1 : 0);
  }
  tx.db
    .prepare(`UPDATE send_intent SET ${assignments.join(', ')} WHERE id = ? AND workspace_id = ? AND status = ?`)
    .run(...params, intentId, tx.workspaceId, row.status);
  tx.audit(`send_intent.${action}`, 'send_intent', intentId, { from: row.status, to, ...detail });
  emitRecord(tx, 'send_intent', intentId);
  const run = tx.db
    .prepare(
      `SELECT a.run_id AS run_id FROM send_intent s JOIN approval a ON a.id = s.approval_id WHERE s.id = ? AND s.workspace_id = ?`,
    )
    .get(intentId, tx.workspaceId) as { run_id: string } | undefined;
  if (run) settleSendRunIn(tx, run.run_id);
  return true;
}

// A send run succeeds only when every one of its messages has left the queue. It is partial when any message
// failed, bounced, was blocked, or has an unknown outcome, and cancelled when every message was cancelled.
export function settleSendRunIn(tx: Tx, runId: string): void {
  const run = tx.db
    .prepare("SELECT id, status FROM run WHERE id = ? AND workspace_id = ? AND kind = 'send_outreach'")
    .get(runId, tx.workspaceId) as { id: string; status: string } | undefined;
  if (!run || run.status !== 'running') return;
  const rows = tx.db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM send_intent WHERE workspace_id = ? AND approval_id IN (SELECT id FROM approval WHERE run_id = ?) GROUP BY status`,
    )
    .all(tx.workspaceId, runId) as { status: string; n: number }[];
  if (rows.length === 0) return;
  const counts = Object.fromEntries(rows.map((row) => [row.status, row.n])) as Record<string, number>;
  if (unsettledStatuses.some((status) => (counts[status] ?? 0) > 0)) return;
  const total = rows.reduce((sum, row) => sum + row.n, 0);
  const problems = (counts.failed ?? 0) + (counts.bounced ?? 0) + (counts.blocked ?? 0) + (counts.unknown ?? 0);
  const finalStatus = (counts.cancelled ?? 0) === total ? 'cancelled' : problems > 0 ? 'partial' : 'succeeded';
  const now = tx.now();
  const detail =
    problems > 0
      ? `${problems} of ${total} did not go out cleanly. See the outbox.`
      : finalStatus === 'cancelled'
        ? 'Every message was cancelled.'
        : `${(counts.accepted ?? 0) + (counts.replied ?? 0)} accepted by the provider.`;
  tx.db
    .prepare("UPDATE run_step SET status = 'done', detail = ?, finished_at = ? WHERE run_id = ? AND status = 'running'")
    .run(detail, now, runId);
  tx.db.prepare('UPDATE run SET status = ?, finished_at = ? WHERE id = ?').run(finalStatus, now, runId);
  tx.audit(`run.${finalStatus}`, 'run', runId, { problems });
  tx.emit({ type: 'run_updated', runId });
}

// Moves queued and approved intents to blocked. Intents that are being submitted are left alone, because the
// request is already on its way and only the provider can say what happened to it.
export function blockWaitingIntentsIn(
  tx: Tx,
  where: { personId?: string; toEmail?: string; inboxId?: string; provider?: string; notProvider?: string },
  reason: string,
): number {
  const clauses = ["workspace_id = ?", "status IN ('queued', 'approved')"];
  const params: unknown[] = [tx.workspaceId];
  if (where.personId) {
    clauses.push('person_id = ?');
    params.push(where.personId);
  }
  if (where.toEmail) {
    clauses.push('lower(to_email) = ?');
    params.push(where.toEmail.toLowerCase());
  }
  if (where.inboxId) {
    clauses.push('inbox_id = ?');
    params.push(where.inboxId);
  }
  if (where.provider) {
    clauses.push('provider = ?');
    params.push(where.provider);
  }
  if (where.notProvider) {
    clauses.push('provider != ?');
    params.push(where.notProvider);
  }
  const rows = tx.db.prepare(`SELECT id FROM send_intent WHERE ${clauses.join(' AND ')}`).all(...params) as { id: string }[];
  let blocked = 0;
  for (const row of rows) {
    if (transitionIntentIn(tx, row.id, ['queued', 'approved'], 'blocked', { error: reason }, 'block', { reason })) blocked += 1;
  }
  return blocked;
}

export interface SuppressionInsert {
  email: string;
  reason: 'bounce' | 'opt_out' | 'manual';
  source: string;
}

// Returns the new suppression id, or null when the address was already suppressed. A new suppression
// immediately blocks queued and approved intents to that address.
export function insertSuppressionIn(tx: Tx, input: SuppressionInsert): string | null {
  const email = input.email.trim().toLowerCase();
  const existing = tx.db.prepare('SELECT id FROM suppression WHERE workspace_id = ? AND email = ?').get(tx.workspaceId, email);
  if (existing) return null;
  const id = tx.newId('sup');
  tx.db
    .prepare('INSERT INTO suppression (id, created_at, workspace_id, email, reason, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, tx.now(), tx.workspaceId, email, input.reason, input.source);
  tx.audit('suppression.create', 'suppression', id, { reason: input.reason });
  blockWaitingIntentsIn(tx, { toEmail: email }, reasonCodes.suppressed);
  return id;
}

export function createTaskIn(tx: Tx, input: { title: string; personId: string | null }): string {
  const id = tx.newId('tsk');
  const now = tx.now();
  tx.db
    .prepare(
      `INSERT INTO task (id, created_at, workspace_id, version, title, entity_type, entity_id, due_at, status, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(id, now, tx.workspaceId, input.title, input.personId ? 'person' : null, input.personId, now, now);
  tx.audit('task.create', 'task', id, { title: input.title });
  emitRecord(tx, 'task', id);
  if (input.personId) emitRecord(tx, 'person', input.personId);
  return id;
}

// Creates the task only when an open one with the same title does not exist for the person already.
export function ensureTaskIn(tx: Tx, input: { title: string; personId: string | null }): string {
  const existing = tx.db
    .prepare(
      "SELECT id FROM task WHERE workspace_id = ? AND status = 'open' AND title = ? AND COALESCE(entity_id, '') = ? LIMIT 1",
    )
    .get(tx.workspaceId, input.title, input.personId ?? '') as { id: string } | undefined;
  return existing ? existing.id : createTaskIn(tx, input);
}

export function createEmailActivityIn(tx: Tx, input: { personId: string; kind: 'email_out' | 'email_in'; body: string }): string {
  const id = tx.newId('act');
  tx.db
    .prepare('INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, tx.now(), tx.workspaceId, 'person', input.personId, input.kind, input.body, tx.actor);
  tx.audit('activity.create', 'person', input.personId, { activityId: id, kind: input.kind });
  emitRecord(tx, 'person', input.personId);
  return id;
}

export const mailReconcileJobKind = 'mail_reconcile';

// The Gmail account is signed in and working again. A message whose outcome was unknown for that same address goes
// back on the reconcile schedule, so the read only search for its Message-ID starts again on the next tick. Messages
// a person already acknowledged are cancelled, so they are not unknown any more and are not touched. A message that
// already has a reconcile job waiting is left alone.
export function resumeGmailReconcilesIn(tx: Tx, address: string): number {
  const rows = tx.db
    .prepare("SELECT id FROM send_intent WHERE workspace_id = ? AND provider = 'gmail' AND status = 'unknown' AND lower(inbox_id) = ?")
    .all(tx.workspaceId, address.toLowerCase()) as { id: string }[];
  let resumed = 0;
  for (const row of rows) {
    const waiting = tx.db
      .prepare("SELECT 1 FROM job WHERE kind = ? AND status IN ('queued', 'running') AND json_extract(payload, '$.intentId') = ?")
      .get(mailReconcileJobKind, row.id);
    if (waiting) continue;
    enqueueJobIn(tx, mailReconcileJobKind, { intentId: row.id, attempt: 0, workspaceId: tx.workspaceId }, tx.now());
    tx.audit('send_intent.reconcile_resumed', 'send_intent', row.id, { address });
    resumed += 1;
  }
  return resumed;
}
