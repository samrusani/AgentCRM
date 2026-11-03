import { z } from 'zod';
import type { Db } from '../db.js';
import { validationError } from '../errors.js';
import { configSchema, currentTemplateDefaults, readSettings } from '../qualification/config.js';
import { requireWorkspace } from '../queries/workspace.js';
import { getTemplate, templates } from '../templates.js';
import { type ActionContext, emitRecord, mutate, parseInput, versionConflict } from './context.js';
import { writeConfigIn } from './qualify.js';
import type { Row } from '../records.js';

export const templateActor = 'system:template';

const switchTemplateSchema = z
  .object({
    template: z.string().trim().min(1).max(64),
    stageMapping: z.record(z.string().trim().min(1).max(64), z.string().trim().min(1).max(200)),
    replaceQualification: z.boolean(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();

export function listTemplates(db: Db, workspaceId: string) {
  const row = db.prepare('SELECT template FROM workspace WHERE id = ?').get(workspaceId) as { template: string } | undefined;
  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    pipelineName: template.pipelineName,
    stageNames: [...template.stageNames],
    current: template.id === row?.template,
  }));
}

// The shape GET /api/workspace returns. A version conflict carries the same shape as the current record.
function workspaceView(db: Db) {
  const { id, name, template, version } = requireWorkspace(db);
  return { id, name, template, version };
}

// Switches the workspace to another template in one transaction. Records, tags, claims, tasks, and history stay.
export function switchTemplate(ctx: ActionContext, input: unknown) {
  const data = parseInput(switchTemplateSchema, input);
  const target = getTemplate(data.template);
  if (!target) {
    throw validationError(`Unknown template "${data.template}". Use one of: ${templates.map((template) => template.id).join(', ')}.`);
  }
  return mutate(ctx, (tx) => {
    const workspace = requireWorkspace(tx.db);
    if (workspace.id !== tx.workspaceId) throw validationError('The workspace was not found.');
    if (workspace.version !== data.expectedVersion) throw versionConflict(workspaceView(tx.db));
    const from = workspace.template;
    if (from === target.id) throw validationError(`The workspace already uses the ${target.name} template.`);

    const pipeline = tx.db
      .prepare('SELECT id FROM pipeline WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1')
      .get(tx.workspaceId) as Row | undefined;
    if (!pipeline) throw validationError('The workspace has no pipeline.');
    const pipelineId = String(pipeline.id);
    const oldStages = (
      tx.db.prepare('SELECT id, name FROM stage WHERE pipeline_id = ? ORDER BY seq, id').all(pipelineId) as { id: string; name: string }[]
    );
    const oldIds = new Set(oldStages.map((stage) => stage.id));

    for (const [stageId, newName] of Object.entries(data.stageMapping)) {
      if (!oldIds.has(stageId)) throw validationError(`Stage "${stageId}" is not a stage of this workspace.`);
      if (!target.stageNames.includes(newName)) {
        throw validationError(`"${newName}" is not a stage of the ${target.name} template. Use one of: ${target.stageNames.join(', ')}.`);
      }
    }

    const counts = new Map<string, number>();
    for (const row of tx.db
      .prepare('SELECT stage_id, COUNT(*) AS n FROM opportunity WHERE workspace_id = ? AND pipeline_id = ? GROUP BY stage_id')
      .all(tx.workspaceId, pipelineId) as { stage_id: string; n: number }[]) {
      counts.set(row.stage_id, Number(row.n));
    }
    const unmapped = oldStages.filter((stage) => (counts.get(stage.id) ?? 0) > 0 && data.stageMapping[stage.id] === undefined);
    if (unmapped.length > 0) {
      throw validationError(
        `Choose a new stage for every stage that holds opportunities. Not mapped: ${unmapped.map((stage) => `${stage.name} (${counts.get(stage.id)})`).join(', ')}.`,
      );
    }

    // Keep the current config as it is. When nothing was saved the config in force is the old template's defaults,
    // so save those before the template changes, or the new template's defaults would take their place.
    const savedConfig = configSchema.safeParse(readSettings(tx.db, tx.workspaceId).qualification);
    if (data.replaceQualification) {
      writeConfigIn(tx, target.defaultQualificationConfig());
    } else if (!savedConfig.success) {
      const settings = { ...readSettings(tx.db, tx.workspaceId), qualification: currentTemplateDefaults(tx.db, tx.workspaceId) };
      tx.db.prepare('UPDATE workspace SET settings = ? WHERE id = ?').run(JSON.stringify(settings), tx.workspaceId);
    }

    const now = tx.now();
    const newIdByName = new Map<string, string>();
    target.stageNames.forEach((name, index) => {
      const id = tx.newId('stg');
      newIdByName.set(name, id);
      tx.db
        .prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, ?)')
        .run(id, now, pipelineId, name, index + 1);
    });

    const moved: Record<string, number> = {};
    for (const stage of oldStages) {
      const newName = data.stageMapping[stage.id];
      if (newName === undefined) continue;
      const newId = newIdByName.get(newName)!;
      const opportunities = tx.db
        .prepare('SELECT id FROM opportunity WHERE workspace_id = ? AND pipeline_id = ? AND stage_id = ? ORDER BY id')
        .all(tx.workspaceId, pipelineId, stage.id) as { id: string }[];
      for (const opportunity of opportunities) {
        const stamp = tx.now();
        tx.db
          .prepare(
            'UPDATE opportunity SET stage_id = ?, stage_changed_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ?',
          )
          .run(newId, stamp, stamp, opportunity.id, tx.workspaceId);
        tx.db
          .prepare('INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(tx.newId('act'), stamp, tx.workspaceId, 'opportunity', opportunity.id, 'stage_change', `Moved from ${stage.name} to ${newName}.`, templateActor);
        emitRecord(tx, 'opportunity', opportunity.id);
      }
      if (opportunities.length > 0) moved[stage.name] = (moved[stage.name] ?? 0) + opportunities.length;
      // Stage history keeps pointing at a stage that exists: old events follow the mapping.
      tx.db.prepare('UPDATE stage_event SET from_stage_id = ? WHERE from_stage_id = ?').run(newId, stage.id);
      tx.db.prepare('UPDATE stage_event SET to_stage_id = ? WHERE to_stage_id = ?').run(newId, stage.id);
    }

    // A stage that was left out of the mapping has no opportunities. Its history cannot point at a stage that no longer exists.
    let stageEventsDropped = 0;
    for (const stage of oldStages) {
      if (data.stageMapping[stage.id] !== undefined) continue;
      tx.db.prepare('UPDATE stage_event SET from_stage_id = NULL WHERE from_stage_id = ?').run(stage.id);
      stageEventsDropped += tx.db.prepare('DELETE FROM stage_event WHERE to_stage_id = ?').run(stage.id).changes;
    }
    for (const stage of oldStages) tx.db.prepare('DELETE FROM stage WHERE id = ?').run(stage.id);

    tx.db.prepare('UPDATE pipeline SET name = ? WHERE id = ?').run(target.pipelineName, pipelineId);
    const result = tx.db
      .prepare('UPDATE workspace SET template = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run(target.id, tx.workspaceId, data.expectedVersion);
    if (result.changes !== 1) throw versionConflict(workspaceView(tx.db));

    tx.audit('workspace.template_change', 'workspace', tx.workspaceId, {
      from,
      to: target.id,
      moved,
      replacedQualification: data.replaceQualification,
      ...(stageEventsDropped > 0 ? { stageEventsDropped } : {}),
    });
    emitRecord(tx, 'workspace', tx.workspaceId);
    return workspaceView(tx.db);
  });
}
