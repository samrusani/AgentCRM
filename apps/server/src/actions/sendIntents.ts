import { z } from 'zod';
import { dailySendCap, mailReconcileDelays, maxIntentsPerApproval, agentmailRequestTimeoutMilliseconds } from '../config.js';
import { conflict, notFound, validationError } from '../errors.js';
import {
  acknowledgedUnknownSentence,
  approvalMaxAgeMilliseconds,
  approvalTooOldSentence,
  bodyMaxLength,
  duplicateProtectionExpiredSentence,
  idempotencyWindowMilliseconds,
  isDemoAddress,
  isValidEmail,
  normalizeEmail,
  parseDraftActivity,
  reasonCodes,
  subjectMaxLength,
  unknownSendTaskTitle,
} from '../mail/rules.js';
import { AgentmailError, sendMessage } from '../providers/agentmail.js';
import { getConnector, getConnectorSecret } from '../queries/connectors.js';
import { getRun } from '../queries/runs.js';
import {
  countReserved,
  countSentToday,
  dayStartFor,
  findSuppression,
  openIntentStatuses,
  requireSendIntent,
  sentIntentStatuses,
  type SendIntent,
} from '../queries/sendIntents.js';
import { requireApproval } from '../queries/runs.js';
import type { Approval, Row } from '../records.js';
import { markAgentmailError } from './agentmailConnector.js';
import { type ActionContext, emitRecord, mutate, parseInput, type Tx } from './context.js';
import { hashPayload } from './demoResearch.js';
import { enqueueJobIn } from './jobs.js';
import {
  createEmailActivityIn,
  ensureTaskIn,
  type FrozenMessage,
  messageHash,
  sendOutreachStepTitles,
  settleSendRunIn,
  transitionIntentIn,
} from './sendIntentState.js';

export const mailReconcileJobKind = 'mail_reconcile';
export const sendOutreachKind = 'send_outreach';
export const sendReviewKind = 'send_review';
export { sendOutreachStepTitles };

const prepareSchema = z
  .object({
    draftActivityIds: z.array(z.string().trim().min(1).max(64)).max(200).optional(),
    runId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export interface Exclusion {
  personId: string | null;
  personName: string;
  draftActivityId: string | null;
  toEmail: string;
  // One of the reason codes the web app knows, or a plain sentence.
  reason: string;
}

interface Candidate {
  activityId: string | null;
  personId: string | null;
  activityBody: string | null;
  // Set when the draft could not be matched to a saved activity.
  missing?: string;
  personName?: string;
}

interface PersonRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
}

function subjectComparisonKey(subject: string): string {
  return subject.normalize('NFC').trim().toLowerCase();
}

function fullName(person: { first_name: string; last_name: string }): string {
  return `${person.first_name} ${person.last_name}`.trim();
}

function resolveCandidates(tx: Tx, data: z.output<typeof prepareSchema>): { candidates: Candidate[]; sourceRunId: string | null } {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let sourceRunId: string | null = null;

  for (const id of data.draftActivityIds ?? []) {
    const row = tx.db
      .prepare("SELECT id, entity_id, body FROM activity WHERE id = ? AND workspace_id = ? AND entity_type = 'person' AND kind = 'email_draft'")
      .get(id, tx.workspaceId) as { id: string; entity_id: string; body: string } | undefined;
    if (!row) throw notFound(`Draft "${id}"`);
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    candidates.push({ activityId: row.id, personId: row.entity_id, activityBody: row.body });
  }

  if (data.runId) {
    const run = getRun(tx.db, tx.workspaceId, data.runId);
    if (!run) throw notFound('Run');
    if (run.kind !== 'draft_outreach') throw validationError('runId: Only a draft outreach run has drafts to send.');
    if (run.status !== 'succeeded' && run.status !== 'partial') {
      throw conflict('The drafts from this run are not saved yet. Approve the drafts first, then prepare to send.');
    }
    sourceRunId = run.id;
    const drafts = Array.isArray(run.scope.drafts) ? (run.scope.drafts as Record<string, unknown>[]) : [];
    for (const draft of drafts) {
      const personId = typeof draft.personId === 'string' ? draft.personId : null;
      const subject = typeof draft.subject === 'string' ? draft.subject : '';
      const body = typeof draft.body === 'string' ? draft.body : '';
      const personName = typeof draft.personName === 'string' ? draft.personName : undefined;
      if (!personId) continue;
      const activities = tx.db
        .prepare(
          "SELECT id, body FROM activity WHERE workspace_id = ? AND entity_type = 'person' AND entity_id = ? AND kind = 'email_draft' AND created_at >= ? ORDER BY created_at DESC, id DESC",
        )
        .all(tx.workspaceId, personId, run.createdAt) as { id: string; body: string }[];
      const match = activities.find((activity) => activity.body.includes(`Subject: ${subject}`) && activity.body.includes(body));
      if (!match) {
        candidates.push({
          activityId: null,
          personId,
          activityBody: null,
          missing: 'The saved draft for this person could not be found.',
          ...(personName ? { personName } : {}),
        });
        continue;
      }
      if (seen.has(match.id)) continue;
      seen.add(match.id);
      candidates.push({ activityId: match.id, personId, activityBody: match.body });
    }
  }
  return { candidates, sourceRunId };
}

export interface PrepareResult {
  approval: Approval | null;
  run: ReturnType<typeof getRun>;
  intents: SendIntent[];
  excluded: Exclusion[];
  remainingDailyCap: number;
}

// Freezes each eligible draft into a send intent and asks for one approval that shows every full message.
// Nothing leaves the machine here. The worker submits only after a person approves.
export function prepareSendIntents(ctx: ActionContext, input: unknown): PrepareResult {
  const data = parseInput(prepareSchema, input);
  if ((data.draftActivityIds ?? []).length === 0 && !data.runId) {
    throw validationError('draftActivityIds: Send draftActivityIds, a runId, or both.');
  }
  const created = mutate(ctx, (tx) => {
    const { candidates, sourceRunId } = resolveCandidates(tx, data);
    const connector = getConnector(tx.db, tx.workspaceId, 'agentmail');
    const inboxId = connector?.status === 'connected' ? connector.settings.inboxId : null;
    const inboxEmail = connector?.status === 'connected' ? connector.settings.inboxEmail : null;
    const now = tx.now();
    let room = inboxId
      ? dailySendCap - countSentToday(tx.db, tx.workspaceId, inboxId, dayStartFor(now)) - countReserved(tx.db, tx.workspaceId, inboxId)
      : 0;

    const excluded: Exclusion[] = [];
    const staged: { id: string; personId: string; personName: string; draftActivityId: string; to: string; subject: string; body: string }[] = [];

    for (const candidate of candidates) {
      const person = candidate.personId
        ? (tx.db
            .prepare('SELECT id, first_name, last_name, email FROM person WHERE id = ? AND workspace_id = ?')
            .get(candidate.personId, tx.workspaceId) as PersonRow | undefined)
        : undefined;
      const personName = person ? fullName(person) : (candidate.personName ?? 'Unknown person');
      const rawEmail = person?.email ?? '';
      const email = normalizeEmail(rawEmail);
      const exclude = (reason: string): void => {
        excluded.push({
          personId: person?.id ?? null,
          personName,
          draftActivityId: candidate.activityId,
          toEmail: email,
          reason,
        });
      };

      if (!inboxId || !inboxEmail) {
        exclude(reasonCodes.noInbox);
        continue;
      }
      if (!person) {
        exclude('The person for this draft no longer exists.');
        continue;
      }
      if (!email || !isValidEmail(email)) {
        exclude(reasonCodes.invalidRecipient);
        continue;
      }
      if (isDemoAddress(email)) {
        exclude(reasonCodes.demoAddress);
        continue;
      }
      if (findSuppression(tx.db, tx.workspaceId, email)) {
        exclude(reasonCodes.suppressed);
        continue;
      }
      if (candidate.missing || !candidate.activityBody || !candidate.activityId) {
        exclude(candidate.missing ?? 'The saved draft for this person could not be found.');
        continue;
      }
      const parsed = parseDraftActivity(candidate.activityBody);
      if (!parsed || parsed.subject.length > subjectMaxLength || parsed.body.length > bodyMaxLength) {
        exclude('This draft could not be read as a subject and a body within the length limits.');
        continue;
      }
      const alreadySent = tx.db
        .prepare(
          `SELECT 1 FROM send_intent WHERE workspace_id = ? AND draft_activity_id = ? AND status IN (${sentIntentStatuses.map(() => '?').join(', ')}) LIMIT 1`,
        )
        .get(tx.workspaceId, candidate.activityId, ...sentIntentStatuses);
      if (alreadySent) {
        exclude('This draft was already sent.');
        continue;
      }
      const openStatuses = [...openIntentStatuses];
      const openMarks = openStatuses.map(() => '?').join(', ');
      // The draft activity is the primary key for "already staged": an open intent for the same saved draft
      // always excludes it, whatever the subject says.
      const sameDraftOpen =
        staged.some((item) => item.draftActivityId === candidate.activityId) ||
        tx.db
          .prepare(`SELECT 1 FROM send_intent WHERE workspace_id = ? AND draft_activity_id = ? AND status IN (${openMarks}) LIMIT 1`)
          .get(tx.workspaceId, candidate.activityId, ...openStatuses);
      if (sameDraftOpen) {
        exclude(reasonCodes.duplicateOpenIntent);
        continue;
      }
      // An unknown outcome that a person acknowledged may still have gone out, so the draft is not staged again.
      const acknowledgedUnknown = tx.db
        .prepare('SELECT 1 FROM send_intent WHERE workspace_id = ? AND draft_activity_id = ? AND unknown_acknowledged = 1 LIMIT 1')
        .get(tx.workspaceId, candidate.activityId);
      if (acknowledgedUnknown) {
        exclude(acknowledgedUnknownSentence);
        continue;
      }
      // The same person and subject in another draft is compared in JavaScript, because SQLite lower() only folds ASCII.
      const subjectKey = subjectComparisonKey(parsed.subject);
      const openSubjects = tx.db
        .prepare(`SELECT subject FROM send_intent WHERE workspace_id = ? AND person_id = ? AND status IN (${openMarks})`)
        .all(tx.workspaceId, person.id, ...openStatuses) as { subject: string }[];
      const duplicate =
        staged.some((item) => item.personId === person.id && subjectComparisonKey(item.subject) === subjectKey) ||
        openSubjects.some((item) => subjectComparisonKey(item.subject) === subjectKey);
      if (duplicate) {
        exclude(reasonCodes.duplicateOpenIntent);
        continue;
      }
      if (room - staged.length <= 0) {
        exclude(reasonCodes.dailyCap);
        continue;
      }
      if (staged.length >= maxIntentsPerApproval) {
        exclude(`Only ${maxIntentsPerApproval} messages go into one approval. Prepare the rest in a second approval.`);
        continue;
      }
      staged.push({
        id: tx.newId('snd'),
        personId: person.id,
        personName,
        draftActivityId: candidate.activityId,
        to: email,
        subject: parsed.subject,
        body: parsed.body,
      });
    }

    const remainingDailyCap = Math.max(0, room - staged.length);
    if (staged.length === 0 || !inboxId || !inboxEmail) {
      return { runId: null, approvalId: null, intentIds: [] as string[], excluded, remainingDailyCap: Math.max(0, room) };
    }

    const messages = staged.map((item) => ({
      intentId: item.id,
      personName: item.personName,
      to: item.to,
      subject: item.subject,
      body: item.body,
      inboxEmail,
    }));
    const payload = {
      ...(sourceRunId ? { runId: sourceRunId } : {}),
      count: messages.length,
      inboxEmail,
      messages,
      excluded: excluded.map((item) => ({ personName: item.personName, toEmail: item.toEmail, reason: item.reason })),
      remainingDailyCap,
    };
    const serialized = JSON.stringify(payload);

    const runId = tx.newId('run');
    const title = `Send ${messages.length} ${messages.length === 1 ? 'email' : 'emails'} for review`;
    tx.db
      .prepare(
        `INSERT INTO run (id, created_at, workspace_id, kind, title, status, scope, counts, started_at)
         VALUES (?, ?, ?, ?, ?, 'waiting_approval', ?, ?, ?)`,
      )
      .run(
        runId,
        now,
        tx.workspaceId,
        sendOutreachKind,
        title,
        JSON.stringify({ intentIds: staged.map((item) => item.id), sourceRunId, draftActivityIds: staged.map((item) => item.draftActivityId) }),
        JSON.stringify({ processed: candidates.length, found: messages.length, flagged: excluded.length }),
        now,
      );
    tx.db
      .prepare(
        "INSERT INTO run_step (id, created_at, run_id, seq, title, status, detail, started_at, finished_at) VALUES (?, ?, ?, 1, ?, 'done', ?, ?, ?)",
      )
      .run(tx.newId('stp'), now, runId, sendOutreachStepTitles[0], `${messages.length} ready, ${excluded.length} excluded.`, now, now);
    tx.db
      .prepare(
        "INSERT INTO run_step (id, created_at, run_id, seq, title, status, detail, started_at) VALUES (?, ?, ?, 2, ?, 'running', ?, ?)",
      )
      .run(tx.newId('stp'), now, runId, sendOutreachStepTitles[1], 'Waiting for your decision. Nothing is sent until you approve.', now);
    tx.db
      .prepare("INSERT INTO run_step (id, created_at, run_id, seq, title, status) VALUES (?, ?, ?, 3, ?, 'pending')")
      .run(tx.newId('stp'), now, runId, sendOutreachStepTitles[2]);
    tx.audit('run.create', 'run', runId, { kind: sendOutreachKind, intents: messages.length, excluded: excluded.length });

    const approvalId = tx.newId('apr');
    tx.db
      .prepare(
        `INSERT INTO approval (id, created_at, workspace_id, run_id, kind, title, payload, payload_hash, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(approvalId, now, tx.workspaceId, runId, sendReviewKind, `Send ${messages.length} ${messages.length === 1 ? 'email' : 'emails'} from ${inboxEmail}`, serialized, hashPayload(serialized));
    tx.audit('approval.create', 'approval', approvalId, { runId, kind: sendReviewKind });

    for (const item of staged) {
      const message: FrozenMessage = { intentId: item.id, to: item.to, subject: item.subject, body: item.body, inboxEmail };
      tx.db
        .prepare(
          `INSERT INTO send_intent (id, created_at, workspace_id, person_id, draft_activity_id, inbox_id, to_email, subject, body, payload_hash, status, approval_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?)`,
        )
        .run(item.id, now, tx.workspaceId, item.personId, item.draftActivityId, inboxId, item.to, item.subject, item.body, messageHash(message), approvalId, now);
      tx.audit('send_intent.create', 'send_intent', item.id, { approvalId, draftActivityId: item.draftActivityId });
      emitRecord(tx, 'send_intent', item.id);
    }
    tx.emit({ type: 'run_updated', runId });
    tx.emit({ type: 'approval_updated', approvalId, runId });
    return { runId, approvalId, intentIds: staged.map((item) => item.id), excluded, remainingDailyCap };
  });

  const intents = created.intentIds.map((id) => requireSendIntent(ctx.db, ctx.workspaceId, id));
  return {
    approval: created.approvalId ? requireApproval(ctx.db, ctx.workspaceId, created.approvalId) : null,
    run: created.runId ? getRun(ctx.db, ctx.workspaceId, created.runId) : null,
    intents,
    excluded: created.excluded,
    remainingDailyCap: created.remainingDailyCap,
  };
}

const reviewPayloadSchema = z.object({
  messages: z.array(
    z.object({
      intentId: z.string(),
      personName: z.string().default(''),
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      inboxEmail: z.string(),
    }),
  ),
});

type ReviewMessage = z.output<typeof reviewPayloadSchema>['messages'][number];

function readReviewMessages(payload: unknown): ReviewMessage[] {
  const parsed = reviewPayloadSchema.safeParse(payload);
  if (!parsed.success) throw conflict('This approval does not carry the full messages, so it cannot be approved. Reject it and prepare the send again.');
  return parsed.data.messages;
}

interface IntentRow {
  id: string;
  person_id: string;
  inbox_id: string;
  to_email: string;
  subject: string;
  body: string;
  payload_hash: string;
  status: string;
  approval_id: string | null;
  created_at: string;
  error: string | null;
  provider_message_id: string | null;
  submitted_at: string | null;
}

// Both hashes must agree: the approved text and the row's current text. A row edited after review fails this.
function intentMatchesMessage(row: IntentRow, message: ReviewMessage): boolean {
  const approved: FrozenMessage = {
    intentId: message.intentId,
    to: message.to,
    subject: message.subject,
    body: message.body,
    inboxEmail: message.inboxEmail,
  };
  const current: FrozenMessage = {
    intentId: row.id,
    to: row.to_email,
    subject: row.subject,
    body: row.body,
    inboxEmail: message.inboxEmail,
  };
  return messageHash(approved) === row.payload_hash && messageHash(current) === row.payload_hash;
}

function repliedSince(tx: Tx, row: Pick<IntentRow, 'person_id' | 'to_email'>, since: string): boolean {
  return Boolean(
    tx.db
      .prepare(
        `SELECT 1 FROM email_message WHERE workspace_id = ? AND direction = 'in' AND (person_id = ? OR from_email = ?)
           AND (provider_timestamp >= ? OR created_at >= ?) LIMIT 1`,
      )
      .get(tx.workspaceId, row.person_id, row.to_email.toLowerCase(), since, since),
  );
}

export interface ApprovalOutcome {
  queued: number;
  blocked: number;
  skipped: { intentId: string; personName: string; reason: string }[];
  // True when every message was cancelled, so there was nothing to approve.
  nothingToSend: boolean;
}

// Runs inside the approval decision. Queues only intents that are still awaiting and whose text matches what
// was approved. A cancelled intent is skipped. An intent whose text differs refuses the whole decision.
export function approveSendReview(tx: Tx, approval: Approval): ApprovalOutcome {
  const messages = readReviewMessages(approval.payload);
  const connector = getConnector(tx.db, tx.workspaceId, 'agentmail');
  const ready: { row: IntentRow; message: ReviewMessage }[] = [];
  const skipped: ApprovalOutcome['skipped'] = [];

  for (const message of messages) {
    const row = tx.db
      .prepare('SELECT * FROM send_intent WHERE id = ? AND workspace_id = ? AND approval_id = ?')
      .get(message.intentId, tx.workspaceId, approval.id) as IntentRow | undefined;
    if (!row) throw conflict('A message in this approval no longer exists, so nothing was approved. Reject it and prepare the send again.');
    if (row.status === 'cancelled') {
      skipped.push({ intentId: row.id, personName: message.personName, reason: 'cancelled' });
      continue;
    }
    if (row.status !== 'awaiting_approval') {
      throw conflict(`A message in this approval is ${row.status.replace('_', ' ')}, so nothing was approved.`);
    }
    if (!intentMatchesMessage(row, message)) {
      throw conflict('A message changed after it was shown for review, so nothing was approved. Reject this approval and prepare the send again.');
    }
    ready.push({ row, message });
  }

  if (ready.length === 0) return { queued: 0, blocked: 0, skipped, nothingToSend: true };

  if (!connector || connector.status !== 'connected' || !connector.settings.inboxId) {
    throw conflict('AgentMail is not connected, so nothing was approved. Connect it in Settings, or reject this approval.');
  }
  for (const { row, message } of ready) {
    if (row.inbox_id !== connector.settings.inboxId || message.inboxEmail !== connector.settings.inboxEmail) {
      throw conflict('The sending inbox changed after these messages were prepared, so nothing was approved. Reject this approval and prepare the send again.');
    }
  }

  let queued = 0;
  let blocked = 0;
  for (const { row } of ready) {
    let reason: string | null = null;
    if (findSuppression(tx.db, tx.workspaceId, row.to_email)) reason = reasonCodes.suppressed;
    else if (repliedSince(tx, row, row.created_at)) reason = reasonCodes.replyReceived;
    if (reason) {
      transitionIntentIn(tx, row.id, ['awaiting_approval'], 'blocked', { error: reason }, 'block', { reason });
      blocked += 1;
    } else {
      transitionIntentIn(tx, row.id, ['awaiting_approval'], 'queued', {}, 'queue', { approvalId: approval.id });
      queued += 1;
    }
  }
  return { queued, blocked, skipped, nothingToSend: false };
}

export function rejectSendReview(tx: Tx, approvalId: string): number {
  return cancelWaitingIntentsIn(tx, ['awaiting_approval'], 'approval_id = ?', approvalId, 'The send was rejected.');
}

function cancelWaitingIntentsIn(
  tx: Tx,
  statuses: readonly ('awaiting_approval' | 'approved' | 'queued')[],
  condition: string,
  parameter: string,
  reason: string,
): number {
  const rows = tx.db
    .prepare(`SELECT id FROM send_intent WHERE workspace_id = ? AND status IN (${statuses.map(() => '?').join(', ')}) AND ${condition}`)
    .all(tx.workspaceId, ...statuses, parameter) as { id: string }[];
  let cancelled = 0;
  for (const row of rows) {
    if (transitionIntentIn(tx, row.id, statuses, 'cancelled', { error: reason }, 'cancel', { reason })) cancelled += 1;
  }
  return cancelled;
}

// A send_outreach run that is cancelled from the runs list takes its waiting and queued messages with it.
// A message that is already being submitted cannot be called back.
export function cancelIntentsForRunIn(tx: Tx, runId: string, reason: string): number {
  return cancelWaitingIntentsIn(
    tx,
    ['awaiting_approval', 'approved', 'queued'],
    'approval_id IN (SELECT id FROM approval WHERE run_id = ?)',
    runId,
    reason,
  );
}

// Called inside the approval decision once the messages are queued. The run keeps running until every message
// has left the queue, then settles as succeeded, partial, or cancelled.
export function startSendingRunIn(tx: Tx, run: { id: string; counts: { processed: number; found: number; flagged: number } }, outcome: ApprovalOutcome): void {
  const now = tx.now();
  const detail = `Approved. ${outcome.queued} queued to send, ${outcome.blocked} blocked, ${outcome.skipped.length} cancelled earlier.`;
  tx.db
    .prepare("UPDATE run_step SET status = 'done', detail = ?, finished_at = ? WHERE run_id = ? AND seq = 2")
    .run(detail, now, run.id);
  tx.db
    .prepare("UPDATE run_step SET status = 'running', detail = ?, started_at = ? WHERE run_id = ? AND seq = 3")
    .run('Messages are sent one at a time. This finishes when each one has left the queue.', now, run.id);
  tx.db
    .prepare("UPDATE run SET status = 'running', counts = ? WHERE id = ?")
    .run(JSON.stringify({ ...run.counts, found: outcome.queued, flagged: run.counts.flagged + outcome.blocked + outcome.skipped.length }), run.id);
  tx.audit('run.sending', 'run', run.id, { queued: outcome.queued, blocked: outcome.blocked });
  settleSendRunIn(tx, run.id);
}

const controlSchema = z.object({ action: z.enum(['cancel', 'acknowledge']) }).strict();
const cancellable = ['awaiting_approval', 'approved', 'queued', 'blocked'] as const;
const acknowledgeable = ['unknown', 'blocked'] as const;

export function controlSendIntent(ctx: ActionContext, intentId: string, input: unknown): SendIntent {
  const { action } = parseInput(controlSchema, input);
  mutate(ctx, (tx) => {
    const intent = tx.db.prepare('SELECT status FROM send_intent WHERE id = ? AND workspace_id = ?').get(intentId, tx.workspaceId) as
      | { status: string }
      | undefined;
    if (!intent) throw notFound('Send intent');
    const allowed: readonly string[] = action === 'cancel' ? cancellable : acknowledgeable;
    if (!allowed.includes(intent.status)) {
      if (intent.status === 'submitting') throw conflict('This message is being sent right now, so it cannot be changed.');
      throw conflict(
        action === 'cancel'
          ? `A message that is ${intent.status.replace('_', ' ')} cannot be cancelled.`
          : `Only a message with an unknown or blocked state can be acknowledged. This one is ${intent.status.replace('_', ' ')}.`,
      );
    }
    if (action === 'cancel') {
      transitionIntentIn(tx, intentId, cancellable, 'cancelled', {}, 'cancel', { by: tx.actor });
    } else {
      transitionIntentIn(
        tx,
        intentId,
        acknowledgeable,
        'cancelled',
        {
          appendError: intent.status === 'unknown' ? 'Acknowledged by a person. Whether this email was sent was never confirmed.' : 'Acknowledged by a person.',
          ...(intent.status === 'unknown' ? { unknownAcknowledged: true } : {}),
        },
        'acknowledge',
        { by: tx.actor, acknowledgedState: intent.status },
      );
    }
  });
  return requireSendIntent(ctx.db, ctx.workspaceId, intentId);
}

// Checks that run immediately before a submit, and again before a reconciliation retry. All of them read the
// database, so the result is as fresh as the claim that follows it. Returns the reason to block, or null.
function recheckIntent(tx: Tx, row: IntentRow, options: { checkApprovalAge: boolean }): string | null {
  if (row.provider_message_id) return 'This message already has a provider message id, so it is not submitted again.';
  const approval = row.approval_id
    ? (tx.db.prepare('SELECT * FROM approval WHERE id = ? AND workspace_id = ?').get(row.approval_id, tx.workspaceId) as Row | undefined)
    : undefined;
  if (!approval || approval.status !== 'approved') return 'The approval for this message is not in place.';
  // Only a first submit needs a fresh approval. A retry of an unknown send carries the same message and key.
  if (options.checkApprovalAge && approval.decided_at && Date.parse(tx.now()) - Date.parse(String(approval.decided_at)) > approvalMaxAgeMilliseconds) {
    return approvalTooOldSentence;
  }
  let message: ReviewMessage | undefined;
  try {
    message = readReviewMessages(JSON.parse(String(approval.payload))).find((item) => item.intentId === row.id);
  } catch {
    message = undefined;
  }
  if (hashPayload(String(approval.payload)) !== String(approval.payload_hash) || !message || !intentMatchesMessage(row, message)) {
    return 'The message no longer matches what was approved.';
  }
  const connector = getConnector(tx.db, tx.workspaceId, 'agentmail');
  if (!connector) return reasonCodes.connectorRemoved;
  if (connector.status !== 'connected') return 'AgentMail rejected the saved API key.';
  if (connector.settings.inboxId !== row.inbox_id || connector.settings.inboxEmail !== message.inboxEmail) {
    return 'The sending inbox changed after approval.';
  }
  if (findSuppression(tx.db, tx.workspaceId, row.to_email)) return reasonCodes.suppressed;
  if (isDemoAddress(row.to_email)) return reasonCodes.demoAddress;
  if (repliedSince(tx, row, String(approval.decided_at ?? row.created_at))) return reasonCodes.replyReceived;
  if (countSentToday(tx.db, tx.workspaceId, row.inbox_id, dayStartFor(tx.now()), row.id) >= dailySendCap) return reasonCodes.dailyCap;
  return null;
}

interface Claim {
  intent: IntentRow;
  apiKey: string;
}

// Takes the oldest queued intent, rechecks it, and marks it submitting, all in one transaction. Only one intent is
// ever submitting at a time, so a second tick cannot start a second request while the first is on the wire.
function claimNextQueued(ctx: ActionContext): Claim | null {
  return mutate(ctx, (tx) => {
    const busy = tx.db.prepare("SELECT 1 FROM send_intent WHERE workspace_id = ? AND status = 'submitting' LIMIT 1").get(tx.workspaceId);
    if (busy) return null;
    for (;;) {
      const row = tx.db
        .prepare("SELECT * FROM send_intent WHERE workspace_id = ? AND status = 'queued' ORDER BY created_at, id LIMIT 1")
        .get(tx.workspaceId) as IntentRow | undefined;
      if (!row) return null;
      const reason = recheckIntent(tx, row, { checkApprovalAge: true });
      if (reason) {
        transitionIntentIn(tx, row.id, ['queued'], 'blocked', { error: reason }, 'block', { reason, stage: 'recheck' });
        continue;
      }
      const apiKey = getConnectorSecret(tx.db, tx.workspaceId, 'agentmail');
      if (!apiKey) {
        transitionIntentIn(tx, row.id, ['queued'], 'blocked', { error: reasonCodes.connectorRemoved }, 'block', { stage: 'recheck' });
        continue;
      }
      transitionIntentIn(tx, row.id, ['queued'], 'submitting', { submittedAt: tx.now() }, 'submit_start', {});
      return { intent: row, apiKey };
    }
  });
}

function personNameOf(tx: Tx, personId: string): string {
  const row = tx.db.prepare('SELECT first_name, last_name FROM person WHERE id = ?').get(personId) as
    | { first_name: string; last_name: string }
    | undefined;
  return row ? fullName(row) : 'this person';
}

function recordAccepted(
  ctx: ActionContext,
  intentId: string,
  from: ('submitting' | 'unknown' | 'cancelled')[],
  result: { messageId: string; threadId: string | null },
  via: string,
): void {
  mutate(ctx, (tx) => {
    const row = tx.db.prepare('SELECT * FROM send_intent WHERE id = ? AND workspace_id = ?').get(intentId, tx.workspaceId) as IntentRow | undefined;
    if (!row) return;
    const moved = transitionIntentIn(
      tx,
      intentId,
      from,
      'accepted',
      { error: null, providerMessageId: result.messageId, providerThreadId: result.threadId },
      'accepted',
      { via },
    );
    if (!moved) return;
    createEmailActivityIn(tx, {
      personId: row.person_id,
      kind: 'email_out',
      body: `Sent (provider accepted). Delivery is not confirmed.\n\nTo: ${row.to_email}\nSubject: ${row.subject}`,
    });
  });
}

// Only a first submit that the provider refused can fail. An intent that is unknown stays unknown.
function recordFailed(ctx: ActionContext, intentId: string, reason: string): void {
  mutate(ctx, (tx) => {
    transitionIntentIn(tx, intentId, ['submitting'], 'failed', { error: reason }, 'failed', { reason });
  });
}

function scheduleReconcileIn(tx: Tx, intentId: string, attempt: number): boolean {
  const delays = mailReconcileDelays();
  if (attempt >= delays.length) return false;
  const runAt = new Date(Date.parse(tx.now()) + delays[attempt]!).toISOString();
  enqueueJobIn(tx, mailReconcileJobKind, { intentId, attempt, workspaceId: tx.workspaceId }, runAt);
  return true;
}

// The request may or may not have produced an email. The state says so, and the same request is retried later
// with the same idempotency key. The provider keeps keys for about a day, so retries stop after 23 hours.
function recordUnknown(ctx: ActionContext, intentId: string, reason: string): void {
  mutate(ctx, (tx) => {
    const moved = transitionIntentIn(
      tx,
      intentId,
      ['submitting'],
      'unknown',
      { error: `Outcome unknown: ${reason} The email may or may not have been sent.` },
      'unknown',
      { reason },
    );
    if (moved) scheduleReconcileIn(tx, intentId, 0);
  });
}

// Submits one queued intent. Returns false when there was nothing to do.
export async function submitNextIntent(ctx: ActionContext): Promise<boolean> {
  const claim = claimNextQueued(ctx);
  if (!claim) return false;
  const { intent, apiKey } = claim;
  try {
    const result = await sendMessage(apiKey, {
      inboxId: intent.inbox_id,
      idempotencyKey: intent.id,
      to: intent.to_email,
      subject: intent.subject,
      text: intent.body,
    });
    recordAccepted(ctx, intent.id, ['submitting'], result, 'submit');
  } catch (error) {
    if (error instanceof AgentmailError && error.definitive) {
      if (error.kind === 'unauthorized') markAgentmailError(ctx, apiKey);
      recordFailed(ctx, intent.id, error.message);
    } else {
      recordUnknown(ctx, intent.id, error instanceof AgentmailError ? error.message : 'The request failed in an unexpected way.');
    }
  }
  return true;
}

// True when the provider may already have forgotten the idempotency key. The key is first used when the intent
// is claimed for submit, so the window starts at submitted_at.
function duplicateProtectionExpired(row: { submitted_at: string | null; created_at: string }, now: string): boolean {
  const started = Date.parse(row.submitted_at ?? row.created_at);
  return Number.isFinite(started) && Date.parse(now) - started > idempotencyWindowMilliseconds;
}

function endSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// An unknown intent that can no longer be checked safely stays unknown, says why once, and has a task for a person.
function stopCheckingIn(tx: Tx, row: IntentRow, sentence: string, reason: string): void {
  const alreadySaid = row.error?.includes(sentence) ?? false;
  if (!alreadySaid) {
    transitionIntentIn(tx, row.id, ['unknown'], 'unknown', { appendError: sentence }, 'reconcile_stopped', { reason });
  }
  ensureTaskIn(tx, { title: unknownSendTaskTitle(personNameOf(tx, row.person_id)), personId: row.person_id });
}

// Retries the same request with the same key for an intent whose outcome is unknown. The full recheck applies, so a
// suppression or a reply that arrived since stops the retry instead of risking a first send. A key older than
// 23 hours is never reused, because the provider forgets keys after a day and the retry could send a second email.
export async function reconcileIntent(ctx: ActionContext, payload: Record<string, unknown>): Promise<void> {
  const intentId = String(payload.intentId);
  const attempt = Number(payload.attempt ?? 0);
  const claim = mutate(ctx, (tx): Claim | null => {
    const row = tx.db.prepare('SELECT * FROM send_intent WHERE id = ? AND workspace_id = ?').get(intentId, tx.workspaceId) as IntentRow | undefined;
    if (!row || row.status !== 'unknown') return null;
    if (duplicateProtectionExpired(row, tx.now())) {
      stopCheckingIn(tx, row, duplicateProtectionExpiredSentence, 'idempotency_expired');
      return null;
    }
    const reason = recheckIntent(tx, row, { checkApprovalAge: false });
    if (reason) {
      transitionIntentIn(
        tx,
        intentId,
        ['unknown'],
        'unknown',
        { appendError: `Checking again stopped: ${reason}. It stays unknown until a person acknowledges it.` },
        'reconcile_stopped',
        { reason },
      );
      return null;
    }
    const apiKey = getConnectorSecret(tx.db, tx.workspaceId, 'agentmail');
    return apiKey ? { intent: row, apiKey } : null;
  });
  if (!claim) return;
  const { intent, apiKey } = claim;
  try {
    const result = await sendMessage(apiKey, {
      inboxId: intent.inbox_id,
      idempotencyKey: intent.id,
      to: intent.to_email,
      subject: intent.subject,
      text: intent.body,
    });
    recordAccepted(ctx, intent.id, ['unknown', 'cancelled'], result, 'reconcile');
  } catch (error) {
    if (error instanceof AgentmailError && error.definitive) {
      // A refusal on a retry does not prove the first request failed: the key may have been rotated or the inbox
      // deleted after the email went out. The intent stays unknown so the draft cannot be staged again by mistake.
      if (error.kind === 'unauthorized') markAgentmailError(ctx, apiKey);
      mutate(ctx, (tx) => {
        const row = tx.db.prepare('SELECT * FROM send_intent WHERE id = ? AND workspace_id = ?').get(intent.id, tx.workspaceId) as IntentRow | undefined;
        if (!row || row.status !== 'unknown') return;
        stopCheckingIn(
          tx,
          row,
          `Checking again stopped: ${endSentence(error.message)} This does not show the email was not sent. It stays unknown until a person acknowledges it.`,
          'refused_on_retry',
        );
      });
      return;
    }
    mutate(ctx, (tx) => {
      const next = attempt + 1;
      const reason = error instanceof AgentmailError ? error.message : 'The request failed in an unexpected way.';
      if (scheduleReconcileIn(tx, intent.id, next)) {
        transitionIntentIn(tx, intent.id, ['unknown'], 'unknown', {}, 'reconcile_retry', { attempt: next, reason });
        return;
      }
      const moved = transitionIntentIn(
        tx,
        intent.id,
        ['unknown'],
        'unknown',
        { appendError: `Still unknown after ${next} checks. Look in the sent folder of the AgentMail inbox before sending again.` },
        'reconcile_exhausted',
        { reason },
      );
      if (moved) ensureTaskIn(tx, { title: unknownSendTaskTitle(personNameOf(tx, intent.person_id)), personId: intent.person_id });
    });
  }
}

// A process that stopped while a request was on the wire leaves an intent in submitting. Nobody knows what the
// provider did, so it becomes unknown and the same key is retried later.
export function recoverSubmittingIntents(ctx: ActionContext, olderThanMilliseconds = 0): number {
  return mutate(ctx, (tx) => {
    const now = tx.now();
    const cutoff = new Date(Date.parse(now) - olderThanMilliseconds).toISOString();
    const rows = tx.db
      .prepare("SELECT id, person_id, created_at, submitted_at FROM send_intent WHERE workspace_id = ? AND status = 'submitting' AND updated_at <= ?")
      .all(tx.workspaceId, cutoff) as { id: string; person_id: string; created_at: string; submitted_at: string | null }[];
    let moved = 0;
    for (const row of rows) {
      // Past the idempotency window the same key could send a second email, so no retry is scheduled.
      const expired = duplicateProtectionExpired(row, now);
      const base = 'Outcome unknown: the app stopped while this message was being sent. The email may or may not have been sent.';
      if (
        transitionIntentIn(
          tx,
          row.id,
          ['submitting'],
          'unknown',
          { error: expired ? `${base} ${duplicateProtectionExpiredSentence}` : base },
          'unknown',
          { reason: 'interrupted', ...(expired ? { idempotencyExpired: true } : {}) },
        )
      ) {
        if (expired) ensureTaskIn(tx, { title: unknownSendTaskTitle(personNameOf(tx, row.person_id)), personId: row.person_id });
        else scheduleReconcileIn(tx, row.id, 0);
        moved += 1;
      }
    }
    return moved;
  });
}

export function staleSubmittingMilliseconds(): number {
  return agentmailRequestTimeoutMilliseconds() * 2 + 30_000;
}

// Submits queued intents one at a time, oldest first, up to `limit` per call.
export async function processQueuedIntents(ctx: ActionContext, limit = 5): Promise<number> {
  recoverSubmittingIntents(ctx, staleSubmittingMilliseconds());
  let submitted = 0;
  while (submitted < limit && (await submitNextIntent(ctx))) submitted += 1;
  return submitted;
}
