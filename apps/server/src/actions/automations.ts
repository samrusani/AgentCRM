import { z } from 'zod';
import type { Db } from '../db.js';
import { validationError } from '../errors.js';
import { type AutomationTriggerKind, disabledReasonKey, requireAutomation } from '../queries/automations.js';
import type { Row } from '../records.js';
import { type ActionContext, emitRecord, mutate, parseInput, type Tx, versionConflict } from './context.js';
import { idSchema } from './schemas.js';

const automationName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value), 'The name cannot contain control characters');
const taskTitleMax = 300;
const dayMilliseconds = 24 * 60 * 60 * 1000;

// The title is plain text with one placeholder, {name}. Any other {token} is ordinary text.
const actionConfigSchema = z
  .object({
    taskTitle: z.string().trim().min(1).max(200),
    dueInDays: z.number().int().min(0).max(365),
  })
  .strict();

const stageTriggerSchema = z.object({ pipelineId: idSchema, stageId: idSchema }).strict();
const promotionTriggerSchema = z.object({}).strict();

const createAutomationSchema = z
  .object({
    name: automationName,
    triggerKind: z.enum(['stage_entered', 'person_promoted']),
    triggerConfig: z.unknown().optional(),
    actionConfig: z.unknown(),
    enabled: z.boolean().optional().default(true),
  })
  .strict();

const updateAutomationSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    fields: z
      .object({
        name: automationName,
        triggerConfig: z.unknown(),
        actionConfig: z.unknown(),
        enabled: z.boolean(),
      })
      .partial()
      .strict()
      .refine((fields) => Object.keys(fields).length > 0, 'Provide at least one field to change'),
  })
  .strict();

// A stage trigger must name a pipeline and a stage that exist in this workspace and belong together.
function validateTrigger(tx: Tx, kind: AutomationTriggerKind, raw: unknown): Record<string, string> {
  if (kind === 'person_promoted') {
    parseInput(promotionTriggerSchema, raw ?? {});
    return {};
  }
  const config = parseInput(stageTriggerSchema, raw);
  const pipeline = tx.db.prepare('SELECT id FROM pipeline WHERE workspace_id = ? AND id = ?').get(tx.workspaceId, config.pipelineId);
  if (!pipeline) throw validationError('That pipeline does not exist.');
  const stage = tx.db.prepare('SELECT pipeline_id FROM stage WHERE id = ?').get(config.stageId) as { pipeline_id: string } | undefined;
  if (!stage) throw validationError('That stage does not exist.');
  if (stage.pipeline_id !== config.pipelineId) throw validationError('That stage does not belong to the chosen pipeline.');
  return { pipelineId: config.pipelineId, stageId: config.stageId };
}

function storedTrigger(row: Row): Record<string, unknown> {
  try {
    const value = JSON.parse(String(row.trigger_config)) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createAutomation(ctx: ActionContext, input: unknown) {
  const data = parseInput(createAutomationSchema, input);
  return mutate(ctx, (tx) => {
    const triggerConfig = validateTrigger(tx, data.triggerKind, data.triggerConfig);
    const actionConfig = parseInput(actionConfigSchema, data.actionConfig);
    const id = tx.newId('aut');
    const now = tx.now();
    tx.db
      .prepare(
        `INSERT INTO automation (id, created_at, workspace_id, version, name, trigger_kind, trigger_config, action_config, enabled, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, now, tx.workspaceId, data.name, data.triggerKind, JSON.stringify(triggerConfig), JSON.stringify(actionConfig), data.enabled ? 1 : 0, now);
    tx.audit('automation.create', 'automation', id, { name: data.name, triggerKind: data.triggerKind, triggerConfig, actionConfig });
    emitRecord(tx, 'automation', id);
    return requireAutomation(tx.db, tx.workspaceId, id);
  });
}

// The trigger kind never changes; to switch kinds, delete the rule and make a new one.
export function updateAutomation(ctx: ActionContext, id: string, input: unknown) {
  const data = parseInput(updateAutomationSchema, input);
  return mutate(ctx, (tx) => {
    const current = requireAutomation(tx.db, tx.workspaceId, id);
    if (current.version !== data.expectedVersion) throw versionConflict(current);
    const row = tx.db.prepare('SELECT trigger_config FROM automation WHERE id = ? AND workspace_id = ?').get(id, tx.workspaceId) as Row;
    const fields = data.fields;
    const nextEnabled = fields.enabled ?? current.enabled;
    let trigger: Record<string, unknown> = storedTrigger(row);
    if ('triggerConfig' in fields) {
      trigger = validateTrigger(tx, current.triggerKind, fields.triggerConfig);
    } else if (nextEnabled && !current.enabled) {
      // Turning a rule back on re-checks that what it names still exists.
      try {
        trigger = validateTrigger(tx, current.triggerKind, current.triggerConfig);
      } catch {
        throw validationError(
          current.disabledReason
            ? `${current.disabledReason} Edit the automation to pick a pipeline and stage that exist, then turn it on.`
            : 'The pipeline or stage this automation names no longer exists. Edit it to pick ones that do.',
        );
      }
    }
    // The deletion note describes a rule that is still off with the config it was stamped on.
    if (nextEnabled || 'triggerConfig' in fields) delete trigger[disabledReasonKey];
    const nextName = fields.name ?? current.name;
    const nextAction = 'actionConfig' in fields ? parseInput(actionConfigSchema, fields.actionConfig) : current.actionConfig;
    const result = tx.db
      .prepare(
        `UPDATE automation SET name = ?, trigger_config = ?, action_config = ?, enabled = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND version = ?`,
      )
      .run(nextName, JSON.stringify(trigger), JSON.stringify(nextAction), nextEnabled ? 1 : 0, tx.now(), id, tx.workspaceId, data.expectedVersion);
    if (result.changes !== 1) throw versionConflict(requireAutomation(tx.db, tx.workspaceId, id));
    tx.audit('automation.update', 'automation', id, {
      name: nextName,
      changed: Object.keys(fields),
      enabled: nextEnabled,
    });
    emitRecord(tx, 'automation', id);
    return requireAutomation(tx.db, tx.workspaceId, id);
  });
}

// Tasks the rule already created stay; only the rule goes. Its fire events stay in the audit trail.
export function deleteAutomation(ctx: ActionContext, rawId: string): void {
  const id = parseInput(idSchema, rawId);
  mutate(ctx, (tx) => {
    const current = requireAutomation(tx.db, tx.workspaceId, id);
    tx.db.prepare('DELETE FROM automation WHERE id = ? AND workspace_id = ?').run(id, tx.workspaceId);
    tx.audit('automation.delete', 'automation', id, { name: current.name, triggerKind: current.triggerKind, firedCount: current.firedCount });
    emitRecord(tx, 'automation', id);
  });
}

// Replaces the one placeholder with the record's name in a single pass, so a name that itself contains braces or
// replacement patterns is stored as plain text. The result is bounded to the task title limit.
export function renderTaskTitle(template: string, name: string): string {
  const title = template.split('{name}').join(name).trim();
  // The cut never splits a surrogate pair: a high surrogate left at the end steps back one unit.
  const cutAt = (text: string): string => {
    if (text.length <= taskTitleMax) return text;
    const high = text.charCodeAt(taskTitleMax - 1);
    return text.slice(0, high >= 0xd800 && high <= 0xdbff ? taskTitleMax - 1 : taskTitleMax);
  };
  return cutAt(title) || cutAt(name);
}

function parseAction(text: unknown): { taskTitle: string; dueInDays: number } | null {
  try {
    const parsed = actionConfigSchema.safeParse(JSON.parse(String(text)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function fireIn(
  tx: Tx,
  automation: Row,
  action: { taskTitle: string; dueInDays: number },
  link: { entityType: 'opportunity' | 'person'; entityId: string; name: string },
): void {
  const taskId = tx.newId('tsk');
  const now = tx.now();
  const dueAt = new Date(Date.parse(now) + action.dueInDays * dayMilliseconds).toISOString();
  const title = renderTaskTitle(action.taskTitle, link.name);
  tx.db
    .prepare(
      `INSERT INTO task (id, created_at, workspace_id, version, title, entity_type, entity_id, due_at, status, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(taskId, now, tx.workspaceId, title, link.entityType, link.entityId, dueAt, now);
  tx.audit('task.create', 'task', taskId, { title });
  emitRecord(tx, 'task', taskId);
  emitRecord(tx, link.entityType, link.entityId);
  tx.audit('automation.fire', 'automation', String(automation.id), {
    automationId: String(automation.id),
    automationName: String(automation.name),
    taskId,
    [link.entityType === 'person' ? 'personId' : 'opportunityId']: link.entityId,
  });
}

function enabledRules(db: Db, workspaceId: string, kind: AutomationTriggerKind): Row[] {
  return db
    .prepare('SELECT * FROM automation WHERE workspace_id = ? AND enabled = 1 AND trigger_kind = ? ORDER BY created_at, id')
    .all(workspaceId, kind) as Row[];
}

// Called inside the transaction that puts a deal into a stage (create, move, template switch). One task per enabled
// rule that names the stage, linked to the deal. Entering again fires again.
export function fireStageAutomationsIn(tx: Tx, opportunity: { id: string; name: string }, stageId: string): void {
  for (const rule of enabledRules(tx.db, tx.workspaceId, 'stage_entered')) {
    if (storedTrigger(rule).stageId !== stageId) continue;
    const action = parseAction(rule.action_config);
    if (action) fireIn(tx, rule, action, { entityType: 'opportunity', entityId: opportunity.id, name: opportunity.name });
  }
}

// Called inside the transaction that promotes a lead to relationship, whichever reason carried the signal.
export function firePromotionAutomationsIn(tx: Tx, personId: string): void {
  const rules = enabledRules(tx.db, tx.workspaceId, 'person_promoted');
  if (rules.length === 0) return;
  const person = tx.db.prepare('SELECT first_name, last_name FROM person WHERE id = ? AND workspace_id = ?').get(personId, tx.workspaceId) as
    | { first_name: string; last_name: string }
    | undefined;
  if (!person) return;
  const name = `${person.first_name} ${person.last_name}`.trim();
  for (const rule of rules) {
    const action = parseAction(rule.action_config);
    if (action) fireIn(tx, rule, action, { entityType: 'person', entityId: personId, name });
  }
}

// A deleted pipeline or stage switches off every rule that names it and stamps the reason into the rule's trigger
// config, so the delete is never blocked and the rule never fires into nothing.
export function disableAutomationsForDeletionIn(tx: Tx, target: { pipelineId?: string; stageIds?: string[] }, reason: string): void {
  const stageIds = new Set(target.stageIds ?? []);
  const rows = tx.db
    .prepare("SELECT * FROM automation WHERE workspace_id = ? AND trigger_kind = 'stage_entered'")
    .all(tx.workspaceId) as Row[];
  for (const row of rows) {
    const trigger = storedTrigger(row);
    const hit =
      (target.pipelineId !== undefined && trigger.pipelineId === target.pipelineId) ||
      (typeof trigger.stageId === 'string' && stageIds.has(trigger.stageId));
    if (!hit) continue;
    trigger[disabledReasonKey] = reason;
    tx.db
      .prepare('UPDATE automation SET enabled = 0, trigger_config = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ?')
      .run(JSON.stringify(trigger), tx.now(), String(row.id), tx.workspaceId);
    tx.audit('automation.disable', 'automation', String(row.id), { reason });
    emitRecord(tx, 'automation', String(row.id));
  }
}
