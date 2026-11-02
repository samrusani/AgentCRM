import type { Db } from '../db.js';
import { dailySendCap } from '../config.js';
import { notFound, validationError } from '../errors.js';
import type { Row } from '../records.js';
import { getConnector } from './connectors.js';
import { optOutTaskTitle, readOptOutSource, replyTaskTitle } from '../mail/rules.js';
import { paginate, type Page } from './pagination.js';
import { dayBounds } from './tasks.js';

export const intentStatuses = [
  'awaiting_approval',
  'approved',
  'queued',
  'submitting',
  'accepted',
  'failed',
  'unknown',
  'blocked',
  'cancelled',
  'replied',
  'bounced',
] as const;
export type IntentStatus = (typeof intentStatuses)[number];

// An open intent can still produce, or may already have produced, an email. Blocked intents are dead until a
// person prepares a fresh send, so they are not open.
export const openIntentStatuses: readonly IntentStatus[] = ['awaiting_approval', 'approved', 'queued', 'submitting', 'unknown'];
// Statuses where the provider accepted the message at some point.
export const sentIntentStatuses: readonly IntentStatus[] = ['accepted', 'replied', 'bounced'];
// Statuses that have not been sent yet but hold a place in the daily budget.
export const reservingIntentStatuses: readonly IntentStatus[] = ['awaiting_approval', 'approved', 'queued'];

export interface SendIntent {
  id: string;
  workspaceId: string;
  personId: string;
  personName: string;
  draftActivityId: string | null;
  inboxId: string;
  to: string;
  subject: string;
  body: string;
  status: IntentStatus;
  approvalId: string | null;
  providerMessageId: string | null;
  providerThreadId: string | null;
  error: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function toSendIntent(row: Row): SendIntent {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    personId: String(row.person_id),
    personName: String(row.person_name ?? ''),
    draftActivityId: text(row.draft_activity_id),
    inboxId: String(row.inbox_id),
    to: String(row.to_email),
    subject: String(row.subject),
    body: String(row.body),
    status: String(row.status) as IntentStatus,
    approvalId: text(row.approval_id),
    providerMessageId: text(row.provider_message_id),
    providerThreadId: text(row.provider_thread_id),
    error: text(row.error),
    submittedAt: text(row.submitted_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export const intentSelect =
  "SELECT s.*, TRIM(p.first_name || ' ' || p.last_name) AS person_name FROM send_intent s JOIN person p ON p.id = s.person_id";

export function getSendIntent(db: Db, workspaceId: string, id: string): SendIntent | null {
  const row = db.prepare(`${intentSelect} WHERE s.workspace_id = ? AND s.id = ?`).get(workspaceId, id) as Row | undefined;
  return row ? toSendIntent(row) : null;
}

export function requireSendIntent(db: Db, workspaceId: string, id: string): SendIntent {
  const intent = getSendIntent(db, workspaceId, id);
  if (!intent) throw notFound('Send intent');
  return intent;
}

function parseStatuses(value: string): IntentStatus[] {
  const parts = value.split(',').map((part) => part.trim());
  for (const part of parts) {
    if (!(intentStatuses as readonly string[]).includes(part)) throw validationError(`Send intent status "${part}" is not valid.`);
  }
  return parts as IntentStatus[];
}

export interface ListSendIntentsInput {
  status?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export function listSendIntents(db: Db, workspaceId: string, input: ListSendIntentsInput = {}): Page<SendIntent> {
  const where = ['s.workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (input.status) {
    const statuses = parseStatuses(input.status);
    where.push(`s.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  return paginate({
    db,
    workspaceId,
    select: intentSelect,
    table: 'send_intent',
    alias: 's',
    where,
    params,
    keys: ['s.created_at', 's.id'],
    direction: 'DESC',
    cursor: input.cursor,
    limit: input.limit,
    map: toSendIntent,
  });
}

export interface Suppression {
  id: string;
  email: string;
  reason: 'bounce' | 'opt_out' | 'manual' | 'demo_address';
  source: string;
  createdAt: string;
}

export function toSuppression(row: Row): Suppression {
  return {
    id: String(row.id),
    email: String(row.email),
    reason: String(row.reason) as Suppression['reason'],
    source: String(row.source ?? ''),
    createdAt: String(row.created_at),
  };
}

export function findSuppression(db: Db, workspaceId: string, email: string): Suppression | null {
  const row = db.prepare('SELECT * FROM suppression WHERE workspace_id = ? AND email = ?').get(workspaceId, email.trim().toLowerCase()) as
    | Row
    | undefined;
  return row ? toSuppression(row) : null;
}

export function listSuppressions(
  db: Db,
  workspaceId: string,
  input: { cursor?: string | undefined; limit?: number | undefined } = {},
): Page<Suppression> {
  return paginate({
    db,
    workspaceId,
    select: 'SELECT s.* FROM suppression s',
    table: 'suppression',
    alias: 's',
    where: ['s.workspace_id = ?'],
    params: [workspaceId],
    keys: ['s.created_at', 's.id'],
    direction: 'DESC',
    cursor: input.cursor,
    limit: input.limit,
    map: toSuppression,
  });
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

// Messages the provider accepted today, plus sends whose outcome is not known, which may have gone out. An unknown
// send that a person acknowledged still counts, because acknowledging does not show that it was not sent.
// `excludeIntentId` lets an intent be rechecked without counting itself.
export function countSentToday(db: Db, workspaceId: string, inboxId: string, dayStart: string, excludeIntentId?: string): number {
  const counted = [...sentIntentStatuses, 'unknown', 'submitting'];
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM send_intent WHERE workspace_id = ? AND inbox_id = ?
         AND (status IN (${placeholders(counted)}) OR unknown_acknowledged = 1)
         AND submitted_at >= ? AND id != ?`,
    )
    .get(workspaceId, inboxId, ...counted, dayStart, excludeIntentId ?? '') as { n: number };
  return row.n;
}

// Intents that have not been submitted yet but will use the budget when they are.
export function countReserved(db: Db, workspaceId: string, inboxId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM send_intent WHERE workspace_id = ? AND inbox_id = ? AND status IN (${placeholders(reservingIntentStatuses)})`,
    )
    .get(workspaceId, inboxId, ...reservingIntentStatuses) as { n: number };
  return row.n;
}

export function dayStartFor(now: string): string {
  return dayBounds(new Date(now)).start;
}

export function dailyCapState(db: Db, workspaceId: string, inboxId: string | null, now: string) {
  const bounds = dayBounds(new Date(now));
  const acceptedToday = inboxId ? countSentToday(db, workspaceId, inboxId, bounds.start) : 0;
  const queued = inboxId ? countReserved(db, workspaceId, inboxId) : 0;
  return {
    limit: dailySendCap,
    acceptedToday,
    queued,
    remaining: Math.max(0, dailySendCap - acceptedToday - queued),
    dayStart: bounds.start,
    dayEnd: bounds.end,
  };
}

export interface ReplyAttentionItem {
  // The provider message id of the inbound message, stable across polls.
  id: string;
  personId: string | null;
  personName: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  taskTitle: string;
  optOut?: { matchedWording: string; suppressionId: string };
  // Also sent flat, for opt out items only.
  matchedWording?: string;
  suppressionId?: string;
}

function hasOpenTask(db: Db, workspaceId: string, title: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM task WHERE workspace_id = ? AND status = 'open' AND title = ? LIMIT 1").get(workspaceId, title),
  );
}

function snippetOf(row: Row): string {
  const source = row.body_text ? String(row.body_text) : String(row.preview ?? '');
  const flat = source.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}

// Inbound mail that created a task a person has not finished: a reply from someone the user wrote to,
// or an opt out that suppressed an address and asked for review.
export function listRepliesNeedingAttention(db: Db, workspaceId: string): ReplyAttentionItem[] {
  const items: ReplyAttentionItem[] = [];
  const people = db
    .prepare(
      `SELECT DISTINCT p.id, TRIM(p.first_name || ' ' || p.last_name) AS name FROM send_intent s JOIN person p ON p.id = s.person_id
       WHERE s.workspace_id = ? AND s.status = 'replied'`,
    )
    .all(workspaceId) as { id: string; name: string }[];
  for (const person of people) {
    const taskTitle = replyTaskTitle(person.name);
    if (!hasOpenTask(db, workspaceId, taskTitle)) continue;
    const message = db
      .prepare(
        `SELECT * FROM email_message WHERE workspace_id = ? AND person_id = ? AND direction = 'in' ORDER BY provider_timestamp DESC, id DESC LIMIT 1`,
      )
      .get(workspaceId, person.id) as Row | undefined;
    if (!message) continue;
    items.push({
      id: String(message.provider_message_id),
      personId: person.id,
      personName: person.name,
      fromEmail: String(message.from_email),
      subject: String(message.subject),
      snippet: snippetOf(message),
      receivedAt: String(message.provider_timestamp),
      taskTitle,
    });
  }
  const optOuts = db
    .prepare("SELECT * FROM suppression WHERE workspace_id = ? AND reason = 'opt_out' ORDER BY created_at DESC, id DESC LIMIT 100")
    .all(workspaceId) as Row[];
  for (const suppression of optOuts) {
    const parsed = readOptOutSource(String(suppression.source));
    if (!parsed) continue;
    const message = db
      .prepare('SELECT * FROM email_message WHERE workspace_id = ? AND provider_message_id = ?')
      .get(workspaceId, parsed.providerMessageId) as Row | undefined;
    if (!message) continue;
    const person = message.person_id
      ? (db
          .prepare("SELECT TRIM(first_name || ' ' || last_name) AS name FROM person WHERE id = ? AND workspace_id = ?")
          .get(String(message.person_id), workspaceId) as { name: string } | undefined)
      : undefined;
    const taskTitle = optOutTaskTitle(person?.name ?? String(message.from_email), parsed.wording);
    if (!hasOpenTask(db, workspaceId, taskTitle)) continue;
    // One message can be both a reply and an opt out. Each item keeps its own id so a list can key on it.
    const messageId = String(message.provider_message_id);
    items.push({
      id: items.some((item) => item.id === messageId) ? `${messageId}:opt_out` : messageId,
      personId: message.person_id ? String(message.person_id) : null,
      personName: person?.name ?? String(message.from_email),
      fromEmail: String(message.from_email),
      subject: String(message.subject),
      snippet: snippetOf(message),
      receivedAt: String(message.provider_timestamp),
      taskTitle,
      optOut: { matchedWording: parsed.wording, suppressionId: String(suppression.id) },
      matchedWording: parsed.wording,
      suppressionId: String(suppression.id),
    });
  }
  items.sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
  return items;
}

export function getMailSummary(db: Db, workspaceId: string, now: string) {
  const counts = Object.fromEntries(intentStatuses.map((status) => [status, 0])) as Record<IntentStatus, number>;
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM send_intent WHERE workspace_id = ? GROUP BY status')
    .all(workspaceId) as { status: IntentStatus; n: number }[];
  for (const row of rows) counts[row.status] = row.n;
  const connector = getConnector(db, workspaceId, 'agentmail');
  const suppressed = db.prepare('SELECT COUNT(*) AS n FROM suppression WHERE workspace_id = ?').get(workspaceId) as { n: number };
  const cap = dailyCapState(db, workspaceId, connector?.settings.inboxId ?? null, now);
  const items = listRepliesNeedingAttention(db, workspaceId);
  return {
    counts,
    dailyCap: cap.limit,
    remainingDailyCap: cap.remaining,
    acceptedToday: cap.acceptedToday,
    reservedDailyCap: cap.queued,
    lastSyncAt: connector?.settings.lastSyncAt ?? null,
    lastSyncError: connector?.settings.lastSyncError ?? null,
    repliesNeedingAttention: { count: items.length, items },
    inbox: {
      connected: Boolean(connector) && connector?.status === 'connected',
      status: connector?.status ?? null,
      inboxId: connector?.settings.inboxId ?? null,
      inboxEmail: connector?.settings.inboxEmail ?? null,
    },
    suppressionCount: suppressed.n,
  };
}
