import { z } from 'zod';
import {
  agentmailRequestTimeoutMilliseconds,
  dailySendCap,
  gmailRequestTimeoutMilliseconds,
  graphRequestTimeoutMilliseconds,
  imapStepTimeoutMilliseconds,
  mailReconcileDelays,
  maxIntentsPerApproval,
} from '../config.js';
import { conflict, notFound, validationError } from '../errors.js';
import {
  acknowledgedUnknownSentence,
  approvalMaxAgeMilliseconds,
  approvalTooOldSentence,
  bodyMaxLength,
  duplicateProtectionExpiredSentence,
  gmailSearchWindowEndedSentence,
  microsoftCheckWindowEndedSentence,
  idempotencyWindowMilliseconds,
  imapCheckWindowEndedSentence,
  isDemoAddress,
  isValidEmail,
  microsoftNoResendSentence,
  microsoftResendApprovalTooOldSentence,
  normalizeEmail,
  parseDraftActivity,
  reasonCodes,
  subjectMaxLength,
  unknownSendTaskTitle,
} from '../mail/rules.js';
import { generateMessageIdHeader } from '../providers/gmail.js';
import { type MailIntent, MailProviderError, mailProviderKinds, mailProviderLabels, type MailProviderKind, type SubmitHooks } from '../providers/mailTypes.js';
import { getActiveMailAccount, getMailAccount } from '../queries/mailProvider.js';
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
import { type ActionContext, emitRecord, mutate, parseInput, type Tx } from './context.js';
import { hashPayload } from './demoResearch.js';
import { enqueueJobIn } from './jobs.js';
import { createMailAdapter, type MailAdapter, markMailProviderRejected } from './mailProviders.js';
import {
  createEmailActivityIn,
  ensureTaskIn,
  type FrozenMessage,
  mailReconcileJobKind,
  messageHash,
  sendOutreachStepTitles,
  settleSendRunIn,
  transitionIntentIn,
} from './sendIntentState.js';

export { mailReconcileJobKind };
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
    // Messages are staged for the mail provider in use, and carry it, so only that provider ever submits them.
    const account = getActiveMailAccount(tx.db, tx.workspaceId);
    const provider: MailProviderKind = account?.kind ?? 'agentmail';
    const inboxId = account?.ready ? account.accountId : null;
    const inboxEmail = account?.ready ? account.address : null;
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
      provider,
    }));
    const payload = {
      ...(sourceRunId ? { runId: sourceRunId } : {}),
      count: messages.length,
      mailProvider: provider,
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
          `INSERT INTO send_intent (id, created_at, workspace_id, person_id, draft_activity_id, inbox_id, to_email, subject, body, payload_hash, status, approval_id, updated_at, provider)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?)`,
        )
        .run(item.id, now, tx.workspaceId, item.personId, item.draftActivityId, inboxId, item.to, item.subject, item.body, messageHash(message), approvalId, now, provider);
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
      // Payloads prepared before the provider was recorded do not carry it. Those were all AgentMail.
      provider: z.enum(mailProviderKinds).optional(),
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
  provider: MailProviderKind;
  message_id_header: string | null;
  provider_draft_id: string | null;
  // When the request that sends the draft was last about to leave, for Microsoft. Null when none was recorded.
  send_attempted_at: string | null;
  // 1 when the Microsoft connector was removed while the outcome was unknown: from then on the draft is only read.
  no_resend: number;
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

  const account = getActiveMailAccount(tx.db, tx.workspaceId);
  const stagedFor = ready[0]!.row.provider;
  if (!account || !account.ready) {
    throw conflict(`${mailProviderLabels[account?.kind ?? stagedFor]} is not connected, so nothing was approved. Connect it in Settings, or reject this approval.`);
  }
  for (const { row, message } of ready) {
    if (row.provider !== account.kind) {
      throw conflict('The sending connector changed after these messages were prepared, so nothing was approved. Reject this approval and prepare the send again.');
    }
    if (row.inbox_id !== account.accountId || message.inboxEmail !== account.address) {
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
// `mode` says what the check guards: a first submit, a retry of the same send (AgentMail), or a read only search
// (Gmail and Microsoft). A read only check cannot send anything, so it asks only whether the account can still be read.
// `resend` guards Microsoft sending its own unsent draft again: it asks everything a first submit asks.
type RecheckMode = 'submit' | 'resend' | 'retry_send' | 'read_only';

function recheckIntent(tx: Tx, row: IntentRow, options: { mode: RecheckMode }): string | null {
  if (row.provider_message_id) return 'This message already has a provider message id, so it is not submitted again.';
  const approval = row.approval_id
    ? (tx.db.prepare('SELECT * FROM approval WHERE id = ? AND workspace_id = ?').get(row.approval_id, tx.workspaceId) as Row | undefined)
    : undefined;
  if (!approval || approval.status !== 'approved') return 'The approval for this message is not in place.';
  // Only a first submit, or a draft sent again, needs a fresh approval. A retry of an unknown send carries the same
  // message and key.
  const startsASend = options.mode === 'submit' || options.mode === 'resend';
  if (startsASend && approval.decided_at && Date.parse(tx.now()) - Date.parse(String(approval.decided_at)) > approvalMaxAgeMilliseconds) {
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
  // The approved message names the provider it was staged for. Payloads from before that was recorded were AgentMail.
  if ((message.provider ?? 'agentmail') !== row.provider) return 'The message no longer matches what was approved.';
  const account = getMailAccount(tx.db, tx.workspaceId, row.provider);
  if (!account) return reasonCodes.connectorRemoved;
  // A first submit leaves only from the provider in use. Switching away blocks it, like removing the connector.
  if (startsASend && getActiveMailAccount(tx.db, tx.workspaceId)?.kind !== row.provider) return reasonCodes.connectorRemoved;
  if (account.status !== 'connected') {
    return row.provider === 'agentmail'
      ? 'AgentMail rejected the saved API key.'
      : (account.statusMessage ?? `${mailProviderLabels[row.provider]} no longer accepts the saved sign in.`);
  }
  if (account.accountId !== row.inbox_id || account.address !== message.inboxEmail) {
    return 'The sending inbox changed after approval.';
  }
  if (options.mode === 'read_only') return null;
  if (findSuppression(tx.db, tx.workspaceId, row.to_email)) return reasonCodes.suppressed;
  if (isDemoAddress(row.to_email)) return reasonCodes.demoAddress;
  if (repliedSince(tx, row, String(approval.decided_at ?? row.created_at))) return reasonCodes.replyReceived;
  if (countSentToday(tx.db, tx.workspaceId, row.inbox_id, dayStartFor(tx.now()), row.id) >= dailySendCap) return reasonCodes.dailyCap;
  return null;
}

interface Claim {
  intent: IntentRow;
  adapter: MailAdapter;
  mayResend?: boolean;
}

function toMailIntent(row: IntentRow, adapter: MailAdapter): MailIntent {
  return {
    intentId: row.id,
    accountId: row.inbox_id,
    fromAddress: adapter.account.address ?? row.inbox_id,
    to: row.to_email,
    subject: row.subject,
    body: row.body,
    messageIdHeader: row.message_id_header,
    providerDraftId: row.provider_draft_id,
    replyTo: null,
  };
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
      const reason = recheckIntent(tx, row, { mode: 'submit' });
      if (reason) {
        transitionIntentIn(tx, row.id, ['queued'], 'blocked', { error: reason }, 'block', { reason, stage: 'recheck' });
        continue;
      }
      const adapter = createMailAdapter(ctx, row.provider);
      if (!adapter) {
        transitionIntentIn(tx, row.id, ['queued'], 'blocked', { error: reasonCodes.connectorRemoved }, 'block', { stage: 'recheck' });
        continue;
      }
      // Gmail has no idempotency key. The Message-ID is chosen here and committed in the same transaction that marks
      // the intent submitting, so it is on disk before any request leaves the process. A restart that finds it set
      // and the intent still submitting treats the outcome as unknown and searches for it; it never sends again.
      const messageIdHeader =
        adapter.provider.duplicateProtection === 'message_id_search' ? generateMessageIdHeader(row.id, adapter.account.address ?? row.inbox_id) : null;
      transitionIntentIn(
        tx,
        row.id,
        ['queued'],
        'submitting',
        { submittedAt: tx.now(), ...(messageIdHeader ? { messageIdHeader } : {}) },
        'submit_start',
        {},
      );
      return { intent: messageIdHeader ? { ...row, message_id_header: messageIdHeader } : row, adapter };
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
  result: { messageId: string; threadId: string | null; notes?: string[] },
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
      { via, ...(result.notes && result.notes.length > 0 ? { notes: result.notes } : {}) },
    );
    if (!moved) return;
    const notes = result.notes && result.notes.length > 0 ? `\n\n${result.notes.join('\n')}` : '';
    createEmailActivityIn(tx, {
      personId: row.person_id,
      kind: 'email_out',
      body: `Sent (provider accepted). Delivery is not confirmed.\n\nTo: ${row.to_email}\nSubject: ${row.subject}${notes}`,
    });
  });
}

// Only a first submit that the provider refused can fail. An intent that is unknown stays unknown.
function recordFailed(ctx: ActionContext, intentId: string, reason: string): void {
  mutate(ctx, (tx) => {
    transitionIntentIn(tx, intentId, ['submitting'], 'failed', { error: reason }, 'failed', { reason });
  });
}

function scheduleReconcileIn(tx: Tx, intentId: string, attempt: number, provider: MailProviderKind): boolean {
  const delays = mailReconcileDelays(provider);
  if (attempt >= delays.length) return false;
  const runAt = new Date(Date.parse(tx.now()) + delays[attempt]!).toISOString();
  enqueueJobIn(tx, mailReconcileJobKind, { intentId, attempt, workspaceId: tx.workspaceId }, runAt);
  return true;
}

// The request may or may not have produced an email. The state says so, and the same request is retried later
// with the same idempotency key. The provider keeps keys for about a day, so retries stop after 23 hours.
function recordUnknown(ctx: ActionContext, intentId: string, provider: MailProviderKind, reason: string): void {
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
    if (moved) scheduleReconcileIn(tx, intentId, 0, provider);
  });
}

// Microsoft saves a draft before it sends. The draft's immutable id and its internetMessageId are committed here, in a
// transaction of their own, and the adapter sends nothing until this has returned true. It writes only while the intent
// is still submitting, and never replaces a different draft id that is already saved.
function saveDraftFor(ctx: ActionContext, intentId: string): NonNullable<SubmitHooks['saveDraft']> {
  return (draft) =>
    mutate(ctx, (tx) => {
      const row = tx.db.prepare('SELECT status, provider_draft_id FROM send_intent WHERE id = ? AND workspace_id = ?').get(intentId, tx.workspaceId) as
        | { status: string; provider_draft_id: string | null }
        | undefined;
      if (!row || row.status !== 'submitting') return false;
      if (row.provider_draft_id && row.provider_draft_id !== draft.draftId) return false;
      tx.db
        .prepare('UPDATE send_intent SET provider_draft_id = ?, message_id_header = COALESCE(?, message_id_header), updated_at = ? WHERE id = ? AND workspace_id = ?')
        .run(draft.draftId, draft.internetMessageId, tx.now(), intentId, tx.workspaceId);
      tx.audit('send_intent.draft_saved', 'send_intent', intentId, { adopted: row.provider_draft_id === draft.draftId });
      return true;
    });
}

// Microsoft creates its draft some time after the claim, and a draft can take a while to make. Everything that guards a
// first send is checked again here, in a transaction of its own, immediately before the request that sends the draft.
// When it fails the intent is blocked and nothing is sent; the draft stays in Outlook and the audit record says so.
// When it passes, the time of the attempt is written in the same transaction, so a later check can tell how long ago a
// request may have left. It runs again before a repeat after a 401, which Microsoft rejects before accepting any mail.
function beforeSendFor(ctx: ActionContext, intentId: string): NonNullable<SubmitHooks['beforeSend']> {
  return () =>
    mutate(ctx, (tx) => {
      const row = tx.db.prepare('SELECT * FROM send_intent WHERE id = ? AND workspace_id = ?').get(intentId, tx.workspaceId) as IntentRow | undefined;
      if (!row || row.status !== 'submitting') return 'This message is no longer being sent.';
      const reason = recheckIntent(tx, row, { mode: 'submit' });
      if (reason) {
        transitionIntentIn(tx, row.id, ['submitting'], 'blocked', { error: reason }, 'block', {
          reason,
          stage: 'before_send',
          strayDraftId: row.provider_draft_id,
          note: row.provider === 'microsoft' ? 'The draft stays in Outlook drafts and was not sent.' : 'The message was not sent.',
        });
        return reason;
      }
      tx.db.prepare('UPDATE send_intent SET send_attempted_at = ? WHERE id = ? AND workspace_id = ?').run(tx.now(), row.id, tx.workspaceId);
      return null;
    });
}

// The adopt scan met a draft of this intent that was edited after approval. It is not adopted, and the record says so.
function noteStrayDraftFor(ctx: ActionContext, intentId: string): NonNullable<SubmitHooks['noteStrayDraft']> {
  return (draft) =>
    mutate(ctx, (tx) => {
      tx.audit('send_intent.stray_draft', 'send_intent', intentId, {
        draftId: draft.draftId,
        note: 'A draft in Outlook was edited after approval, so it was not adopted. It was left in Outlook drafts.',
      });
    });
}

// Submits one queued intent. Returns false when there was nothing to do.
export async function submitNextIntent(ctx: ActionContext): Promise<boolean> {
  const claim = claimNextQueued(ctx);
  if (!claim) return false;
  const { intent, adapter } = claim;
  try {
    const result = await adapter.provider.submit(toMailIntent(intent, adapter), {
      saveDraft: saveDraftFor(ctx, intent.id),
      beforeSend: beforeSendFor(ctx, intent.id),
      noteStrayDraft: noteStrayDraftFor(ctx, intent.id),
    });
    recordAccepted(ctx, intent.id, ['submitting'], result, 'submit');
  } catch (error) {
    if (error instanceof MailProviderError && error.definitive) {
      if (error.kind === 'unauthorized') markMailProviderRejected(ctx, adapter);
      recordFailed(ctx, intent.id, error.message);
    } else {
      recordUnknown(ctx, intent.id, intent.provider, error instanceof MailProviderError ? error.message : 'The request failed in an unexpected way.');
    }
  }
  return true;
}

// True when the checking window has ended. For AgentMail it is the time the provider may already have forgotten the
// idempotency key; for Gmail it is how long the app keeps searching. The window starts when the intent is claimed
// for submit, so it starts at submitted_at.
function duplicateProtectionExpired(row: { submitted_at: string | null; created_at: string }, now: string): boolean {
  const started = Date.parse(row.submitted_at ?? row.created_at);
  return Number.isFinite(started) && Date.parse(now) - started > idempotencyWindowMilliseconds;
}

function windowEndedSentence(provider: MailProviderKind): string {
  if (provider === 'microsoft') return microsoftCheckWindowEndedSentence;
  if (provider === 'imap') return imapCheckWindowEndedSentence;
  return provider === 'gmail' ? gmailSearchWindowEndedSentence : duplicateProtectionExpiredSentence;
}

function stillUnknownSentence(provider: MailProviderKind, checks: number): string {
  if (provider === 'microsoft') return `Still unknown after ${checks} checks. Look in Sent Items and Drafts of the Microsoft account before sending again.`;
  if (provider === 'imap') return `Still unknown after ${checks} checks. Look in the Sent folder of the mailbox in the provider's webmail before sending again.`;
  return provider === 'gmail'
    ? `Still unknown after ${checks} checks. Look in the sent mail of the Gmail account before sending again.`
    : `Still unknown after ${checks} checks. Look in the sent folder of the AgentMail inbox before sending again.`;
}

// Gmail, Microsoft, and IMAP checks read the provider instead of repeating the request, so they need only a working account.
function checksAreReadOnly(provider: MailProviderKind): boolean {
  return provider !== 'agentmail';
}

function endSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// An unknown intent that needs a person to look says why once and has a task for a person.
function noteUnknownIn(tx: Tx, row: IntentRow, sentence: string, action: string, reason: string): void {
  const alreadySaid = row.error?.includes(sentence) ?? false;
  if (!alreadySaid) {
    transitionIntentIn(tx, row.id, ['unknown'], 'unknown', { appendError: sentence }, action, { reason });
  }
  ensureTaskIn(tx, { title: unknownSendTaskTitle(personNameOf(tx, row.person_id)), personId: row.person_id });
}

// An unknown intent that can no longer be checked safely stays unknown, says why once, and has a task for a person.
function stopCheckingIn(tx: Tx, row: IntentRow, sentence: string, reason: string): void {
  noteUnknownIn(tx, row, sentence, 'reconcile_stopped', reason);
}

// A request that timed out may still be processed by Outlook a little later. A draft is therefore sent again only after
// the last attempt is older than two request timeouts plus thirty seconds.
function resendWaitMilliseconds(): number {
  return 2 * graphRequestTimeoutMilliseconds() + 30_000;
}

// Fails closed: a missing or unreadable time is never enough to send again.
function resendWaitReason(row: Pick<IntentRow, 'send_attempted_at'>, now: string): string | null {
  if (!row.send_attempted_at) return 'No time was recorded for the last send attempt.';
  const attempted = Date.parse(row.send_attempted_at);
  const current = Date.parse(now);
  if (!Number.isFinite(attempted) || !Number.isFinite(current)) return 'The time of the last send attempt could not be read.';
  return current - attempted > resendWaitMilliseconds() ? null : 'The last send attempt is too recent.';
}

// Why Microsoft may not send its saved draft again right now, or null when it may.
//  marker: the connector was removed while the outcome was unknown, so the draft is only ever read.
//  approval_age: the approval is more than a day old, the rule for a first send.
//  recheck: a guard of a first send fails (suppression, reply, cap, connector, account, provider in use).
//  wait: the last send attempt is too recent, or has no readable time.
interface ResendBlock {
  kind: 'marker' | 'approval_age' | 'recheck' | 'wait';
  reason: string;
}

function microsoftResendBlock(tx: Tx, row: IntentRow, checkWait: boolean): ResendBlock | null {
  if (row.no_resend === 1) return { kind: 'marker', reason: microsoftNoResendSentence };
  const reason = recheckIntent(tx, row, { mode: 'resend' });
  if (reason === approvalTooOldSentence) return { kind: 'approval_age', reason: microsoftResendApprovalTooOldSentence };
  if (reason) return { kind: 'recheck', reason };
  if (checkWait) {
    const wait = resendWaitReason(row, tx.now());
    if (wait) return { kind: 'wait', reason: wait };
  }
  return null;
}

// Intents being checked right now in this process. The mail lane is single flight today (one worker tick at a time), so
// two checks of one intent never overlap; this keeps it true if a second caller is ever added, because two checks
// racing could each decide to send the same draft.
const reconciling = new Set<string>();

// Checks an intent whose outcome is unknown, through the provider that staged it.
// AgentMail: retries the same request with the same key. The full recheck applies, so a suppression or a reply that
// arrived since stops the retry instead of risking a first send. A key older than 23 hours is never reused, because
// the provider forgets keys after a day and the retry could send a second email.
// Gmail: a read only search for the saved Message-ID. Nothing is ever sent from here, so only the account is rechecked.
// Microsoft: reads the saved draft. It may send that same draft again, but only when every guard of a first send passes
// (also the one day approval age and the wait since the last attempt), the draft still holds exactly the approved
// message, and the guards pass once more immediately before the request.
export async function reconcileIntent(ctx: ActionContext, payload: Record<string, unknown>): Promise<void> {
  const key = `${ctx.workspaceId}:${String(payload.intentId)}`;
  if (reconciling.has(key)) return;
  reconciling.add(key);
  try {
    await reconcileIntentOnce(ctx, payload);
  } finally {
    reconciling.delete(key);
  }
}

interface ReconcileClaim extends Claim {
  // Why a Microsoft draft may not be sent again, or null when it may.
  block: ResendBlock | null;
}

async function reconcileIntentOnce(ctx: ActionContext, payload: Record<string, unknown>): Promise<void> {
  const intentId = String(payload.intentId);
  const attempt = Number(payload.attempt ?? 0);
  const claim = mutate(ctx, (tx): ReconcileClaim | null => {
    const row = tx.db.prepare('SELECT * FROM send_intent WHERE id = ? AND workspace_id = ?').get(intentId, tx.workspaceId) as IntentRow | undefined;
    if (!row || row.status !== 'unknown') return null;
    if (duplicateProtectionExpired(row, tx.now())) {
      stopCheckingIn(tx, row, windowEndedSentence(row.provider), checksAreReadOnly(row.provider) ? 'search_window_ended' : 'idempotency_expired');
      return null;
    }
    const reason = recheckIntent(tx, row, { mode: checksAreReadOnly(row.provider) ? 'read_only' : 'retry_send' });
    if (reason && checksAreReadOnly(row.provider)) {
      // The read only search cannot run (the sign in failed, was removed, or is for a different account). Say so now,
      // once, with a task for a person, instead of waiting quietly. The search resumes when the same account is ready.
      stopCheckingIn(tx, row, `Checking again stopped: ${endSentence(reason === reasonCodes.connectorRemoved ? `The ${mailProviderLabels[row.provider]} connector was removed` : reason)} It stays unknown until the same ${mailProviderLabels[row.provider]} account is ${row.provider === 'imap' ? 'connected' : 'signed in'} again or a person acknowledges it.`, 'cannot_check');
      return null;
    }
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
    const adapter = createMailAdapter(ctx, row.provider);
    if (!adapter) return null;
    // Microsoft may send its own unsent draft again, so it is told whether it may: every guard of a first send passes
    // (suppression, a reply since approval, the daily cap, the provider still in use, an approval under a day old), the
    // connector was not removed in the meantime, and the last send attempt is long enough ago. When one fails it can
    // still learn that the message went out, but it cannot send.
    const block = row.provider === 'microsoft' ? microsoftResendBlock(tx, row, true) : null;
    return { intent: row, adapter, mayResend: row.provider === 'microsoft' && block === null, block };
  });
  if (!claim) return;
  const { intent, adapter } = claim;
  let block = claim.block;
  // Runs inside the adapter, immediately before the request that sends the draft again. The guards are read again then,
  // and the time of the attempt is recorded before the request leaves.
  let firstResendRequest = true;
  const beforeResend = (): string | null =>
    mutate(ctx, (tx) => {
      const row = tx.db.prepare('SELECT * FROM send_intent WHERE id = ? AND workspace_id = ?').get(intent.id, tx.workspaceId) as IntentRow | undefined;
      if (!row || row.status !== 'unknown') return 'This message is no longer unknown.';
      // A repeat after a 401 happens moments after the first request was stamped, so only the first one waits.
      const found = microsoftResendBlock(tx, row, firstResendRequest);
      if (found) {
        block = found;
        return found.reason;
      }
      firstResendRequest = false;
      tx.db.prepare('UPDATE send_intent SET send_attempted_at = ? WHERE id = ? AND workspace_id = ?').run(tx.now(), row.id, tx.workspaceId);
      return null;
    });
  const result = await adapter.provider.reconcileUnknown(toMailIntent(intent, adapter), {
    mayResend: claim.mayResend ?? false,
    ...(intent.provider === 'microsoft' ? { beforeResend } : {}),
  });
  if (result.outcome === 'accepted') {
    recordAccepted(ctx, intent.id, ['unknown', 'cancelled'], { messageId: result.messageId, threadId: result.threadId }, 'reconcile');
    return;
  }
  // The saved draft was edited after approval. It is never sent, the checks stop, and a person gets a task.
  if (result.outcome === 'needs_person' && result.reason === 'draft_changed') {
    mutate(ctx, (tx) => {
      const row = tx.db.prepare('SELECT * FROM send_intent WHERE id = ? AND workspace_id = ?').get(intent.id, tx.workspaceId) as IntentRow | undefined;
      if (row?.status === 'unknown') stopCheckingIn(tx, row, result.sentence, 'draft_changed');
    });
    return;
  }
  // Nothing found shows the draft is still a draft. An approval over a day old will not send it, so checking stops.
  if (result.outcome === 'not_found' && block?.kind === 'approval_age') {
    const sentence = block.reason;
    mutate(ctx, (tx) => {
      const row = tx.db.prepare('SELECT * FROM send_intent WHERE id = ? AND workspace_id = ?').get(intent.id, tx.workspaceId) as IntentRow | undefined;
      if (row?.status === 'unknown') stopCheckingIn(tx, row, sentence, 'approval_too_old');
    });
    return;
  }
  if (result.outcome === 'unavailable' && result.error.definitive) {
    const error = result.error;
    // A refusal on a retry does not prove the first request failed: the key may have been rotated or the inbox
    // deleted after the email went out. The intent stays unknown so the draft cannot be staged again by mistake.
    if (error.kind === 'unauthorized') markMailProviderRejected(ctx, adapter);
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
  // Checks go on, but a person needs to know. A message that is neither a draft nor in Sent Items, and a draft that may
  // never be sent again because the connector was removed, each keep the intent unknown with a task.
  const note =
    result.outcome === 'needs_person'
      ? { sentence: result.sentence, reason: result.reason }
      : result.outcome === 'not_found' && block?.kind === 'marker'
        ? { sentence: block.reason, reason: 'no_resend' }
        : null;
  mutate(ctx, (tx) => {
    const next = attempt + 1;
    const reason = result.outcome === 'unavailable' ? result.error.message : note ? note.sentence : 'The message was not found yet.';
    if (note) {
      const row = tx.db.prepare('SELECT * FROM send_intent WHERE id = ? AND workspace_id = ?').get(intent.id, tx.workspaceId) as IntentRow | undefined;
      if (row?.status === 'unknown') noteUnknownIn(tx, row, note.sentence, 'reconcile_note', note.reason);
    }
    if (scheduleReconcileIn(tx, intent.id, next, intent.provider)) {
      transitionIntentIn(tx, intent.id, ['unknown'], 'unknown', {}, 'reconcile_retry', { attempt: next, reason });
      return;
    }
    const moved = transitionIntentIn(
      tx,
      intent.id,
      ['unknown'],
      'unknown',
      { appendError: stillUnknownSentence(intent.provider, next) },
      'reconcile_exhausted',
      { reason },
    );
    if (moved) ensureTaskIn(tx, { title: unknownSendTaskTitle(personNameOf(tx, intent.person_id)), personId: intent.person_id });
  });
}

// A process that stopped while a request was on the wire leaves an intent in submitting. Nobody knows what the
// provider did, so it becomes unknown and the same key is retried later.
export function recoverSubmittingIntents(ctx: ActionContext, olderThanMilliseconds = 0): number {
  return mutate(ctx, (tx) => {
    const now = tx.now();
    const cutoff = new Date(Date.parse(now) - olderThanMilliseconds).toISOString();
    const rows = tx.db
      .prepare("SELECT id, person_id, created_at, submitted_at, provider FROM send_intent WHERE workspace_id = ? AND status = 'submitting' AND updated_at <= ?")
      .all(tx.workspaceId, cutoff) as { id: string; person_id: string; created_at: string; submitted_at: string | null; provider: MailProviderKind }[];
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
          { error: expired ? `${base} ${windowEndedSentence(row.provider)}` : base },
          'unknown',
          { reason: 'interrupted', ...(expired ? { idempotencyExpired: true } : {}) },
        )
      ) {
        if (expired) ensureTaskIn(tx, { title: unknownSendTaskTitle(personNameOf(tx, row.person_id)), personId: row.person_id });
        else scheduleReconcileIn(tx, row.id, 0, row.provider);
        moved += 1;
      }
    }
    return moved;
  });
}

// A submit that has been "submitting" longer than this is treated as interrupted. It must outlast a live submit, or a
// second process could mark a request that is still on the wire as unknown. Each request is allowed the full request
// timeout. The margin covers the database writes around them.
// Gmail and AgentMail: the worst case is a send that needs a token refresh, is refused with a 401, refreshes again, and
// sends again: four requests. With the default timeouts that is 90 seconds.
// Microsoft: a submit makes up to five Graph calls: a draft create, a drafts scan, a second create, a second scan, and
// the send. Each call can send its request twice (a 401 repeats it) and can renew the token twice (before the request
// and after the 401), and a renewal that meets a finished sign in makes a second token request. That is
// 5 * (2 + 2 * 2) = 30 requests, 8 minutes with the default timeout.
const worstCaseSubmitRequests = 4;
const worstCaseMicrosoftGraphCalls = 5;
const worstCaseMicrosoftRequestsPerCall = 2 + 2 * 2;
const worstCaseMicrosoftSubmitRequests = worstCaseMicrosoftGraphCalls * worstCaseMicrosoftRequestsPerCall;
const staleSubmitMarginMilliseconds = 30_000;
// IMAP: the transport gives one whole send five steps of the step timeout, and one whole IMAP operation (the Sent copy)
// five more: two to connect, two for the work, one to log out. These are hard deadlines, enforced by the transport.
const imapSendSteps = 5;
const imapAppendSteps = 5;

export function staleSubmittingMilliseconds(): number {
  return (
    Math.max(
      Math.max(agentmailRequestTimeoutMilliseconds(), gmailRequestTimeoutMilliseconds()) * worstCaseSubmitRequests,
      graphRequestTimeoutMilliseconds() * worstCaseMicrosoftSubmitRequests,
      imapStepTimeoutMilliseconds() * (imapSendSteps + imapAppendSteps),
    ) + staleSubmitMarginMilliseconds
  );
}

// Submits queued intents one at a time, oldest first, up to `limit` per call.
export async function processQueuedIntents(ctx: ActionContext, limit = 5): Promise<number> {
  recoverSubmittingIntents(ctx, staleSubmittingMilliseconds());
  let submitted = 0;
  while (submitted < limit && (await submitNextIntent(ctx))) submitted += 1;
  return submitted;
}
