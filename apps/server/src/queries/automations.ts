import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import type { Row } from '../records.js';

export type AutomationTriggerKind = 'stage_entered' | 'person_promoted';

export interface AutomationTriggerConfig {
  pipelineId?: string;
  stageId?: string;
}

export interface AutomationActionConfig {
  taskTitle: string;
  dueInDays: number;
}

export interface Automation {
  id: string;
  workspaceId: string;
  name: string;
  triggerKind: AutomationTriggerKind;
  triggerConfig: AutomationTriggerConfig;
  actionConfig: AutomationActionConfig;
  enabled: boolean;
  // Set when a deleted pipeline or stage switched the rule off. The list shows it in muted text.
  disabledReason: string | null;
  // How many times the rule has fired, counted from the audit trail.
  firedCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// The note a deletion stamps into the stored trigger config lives next to pipelineId and stageId.
export const disabledReasonKey = 'disabledReason';

function parseObject(text: unknown): Record<string, unknown> {
  try {
    const value = JSON.parse(String(text)) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function toAutomation(row: Row, firedCount: number): Automation {
  const stored = parseObject(row.trigger_config);
  const action = parseObject(row.action_config);
  const triggerConfig: AutomationTriggerConfig = {};
  if (typeof stored.pipelineId === 'string') triggerConfig.pipelineId = stored.pipelineId;
  if (typeof stored.stageId === 'string') triggerConfig.stageId = stored.stageId;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    triggerKind: row.trigger_kind as AutomationTriggerKind,
    triggerConfig,
    actionConfig: { taskTitle: String(action.taskTitle ?? ''), dueInDays: Number(action.dueInDays ?? 0) },
    enabled: Number(row.enabled) === 1,
    disabledReason: typeof stored[disabledReasonKey] === 'string' ? (stored[disabledReasonKey] as string) : null,
    firedCount,
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function firedCounts(db: Db, workspaceId: string): Map<string, number> {
  const rows = db
    .prepare(
      "SELECT entity_id, COUNT(*) AS n FROM audit_event WHERE workspace_id = ? AND action = 'automation.fire' AND entity_type = 'automation' GROUP BY entity_id",
    )
    .all(workspaceId) as { entity_id: string; n: number }[];
  return new Map(rows.map((row) => [row.entity_id, Number(row.n)]));
}

// Newest first, each with its fired count from one grouped audit query.
export function listAutomations(db: Db, workspaceId: string): Automation[] {
  const counts = firedCounts(db, workspaceId);
  const rows = db.prepare('SELECT * FROM automation WHERE workspace_id = ? ORDER BY created_at DESC, id DESC').all(workspaceId) as Row[];
  return rows.map((row) => toAutomation(row, counts.get(String(row.id)) ?? 0));
}

export function getAutomation(db: Db, workspaceId: string, id: string): Automation | null {
  const row = db.prepare('SELECT * FROM automation WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as Row | undefined;
  if (!row) return null;
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM audit_event WHERE workspace_id = ? AND action = 'automation.fire' AND entity_type = 'automation' AND entity_id = ?")
    .get(workspaceId, id) as { n: number };
  return toAutomation(row, Number(count.n));
}

export function requireAutomation(db: Db, workspaceId: string, id: string): Automation {
  const automation = getAutomation(db, workspaceId, id);
  if (!automation) throw notFound('Automation');
  return automation;
}
