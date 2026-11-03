import type { Db } from '../db.js';
import { notFound, validationError } from '../errors.js';
import { isMailProviderKind, type MailProviderKind } from '../providers/mailTypes.js';
import type { Row } from '../records.js';
import { paginate, type Page } from './pagination.js';

export const followupRuleStatuses = ['waiting', 'armed', 'sending', 'done', 'stopped', 'expired'] as const;
export type FollowupRuleStatus = (typeof followupRuleStatuses)[number];

// A rule in one of these statuses can still send something, so it can be stopped and it blocks staging for the person.
export const activeFollowupStatuses: readonly FollowupRuleStatus[] = ['waiting', 'armed', 'sending'];

export interface FollowupStep {
  waitDays: number;
  body: string;
}

export interface FollowupRule {
  id: string;
  personId: string;
  personName: string;
  status: FollowupRuleStatus;
  steps: FollowupStep[];
  // 1 based number of the step that goes next. While sending it is the step in flight.
  nextStep: number;
  nextDueAt: string | null;
  stoppedReason: string | null;
  provider: MailProviderKind;
  anchorIntentId: string;
  anchorSubject: string;
  lastIntentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function parseSteps(value: unknown): FollowupStep[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is { waitDays: number; body: string } => typeof item?.waitDays === 'number' && typeof item?.body === 'string')
      .map((item) => ({ waitDays: item.waitDays, body: item.body }));
  } catch {
    return [];
  }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function toFollowupRule(row: Row): FollowupRule {
  return {
    id: String(row.id),
    personId: String(row.person_id),
    personName: String(row.person_name ?? ''),
    status: String(row.status) as FollowupRuleStatus,
    steps: parseSteps(row.steps),
    nextStep: Number(row.next_step),
    nextDueAt: text(row.next_due_at),
    stoppedReason: text(row.stopped_reason),
    provider: (isMailProviderKind(row.provider) ? row.provider : 'agentmail') as MailProviderKind,
    anchorIntentId: String(row.intent_id),
    anchorSubject: String(row.anchor_subject ?? ''),
    lastIntentId: text(row.last_intent_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const ruleSelect =
  "SELECT r.*, TRIM(p.first_name || ' ' || p.last_name) AS person_name, i.subject AS anchor_subject FROM followup_rule r JOIN person p ON p.id = r.person_id JOIN send_intent i ON i.id = r.intent_id";

export function getFollowupRule(db: Db, workspaceId: string, id: string): FollowupRule | null {
  const row = db.prepare(`${ruleSelect} WHERE r.workspace_id = ? AND r.id = ?`).get(workspaceId, id) as Row | undefined;
  return row ? toFollowupRule(row) : null;
}

export function requireFollowupRule(db: Db, workspaceId: string, id: string): FollowupRule {
  const rule = getFollowupRule(db, workspaceId, id);
  if (!rule) throw notFound('Follow-up rule');
  return rule;
}

export interface ListFollowupRulesInput {
  // One status, or "active" for waiting, armed, and sending. Omitted means every status.
  status?: string | undefined;
  personId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export function listFollowupRules(db: Db, workspaceId: string, input: ListFollowupRulesInput = {}): Page<FollowupRule> {
  const where = ['r.workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (input.status) {
    const statuses: readonly string[] =
      input.status === 'active' ? activeFollowupStatuses : (followupRuleStatuses as readonly string[]).includes(input.status) ? [input.status] : [];
    if (statuses.length === 0) throw validationError(`status: Follow-up rule status "${input.status}" is not valid.`);
    where.push(`r.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (input.personId) {
    where.push('r.person_id = ?');
    params.push(input.personId);
  }
  return paginate({
    db,
    workspaceId,
    select: ruleSelect,
    table: 'followup_rule',
    alias: 'r',
    where,
    params,
    keys: ['r.created_at', 'r.id'],
    direction: 'DESC',
    cursor: input.cursor,
    limit: input.limit,
    map: toFollowupRule,
  });
}

// True when the person has a rule that can still send, which keeps them out of a new staged send.
export function personHasActiveRule(db: Db, workspaceId: string, personId: string): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM followup_rule WHERE workspace_id = ? AND person_id = ? AND status IN (${activeFollowupStatuses.map(() => '?').join(', ')}) LIMIT 1`)
      .get(workspaceId, personId, ...activeFollowupStatuses),
  );
}
