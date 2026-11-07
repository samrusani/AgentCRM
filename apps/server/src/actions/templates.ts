import { z } from 'zod';
import { notFound, validationError } from '../errors.js';
import { configSchema, currentTemplateDefaults, readSettings } from '../qualification/config.js';
import { getPipeline } from '../queries/pipelines.js';
import { getTemplate, templates } from '../templates.js';
import { type ActionContext, emitRecord, mutate, parseInput, versionConflict } from './context.js';
import { writeConfigIn } from './qualify.js';
import { idSchema } from './schemas.js';

export const templateActor = 'system:template';

const switchTemplateSchema = z
  .object({
    pipelineId: idSchema,
    template: z.string().trim().min(1).max(64),
    stageMapping: z.record(z.string().trim().min(1).max(64), z.string().trim().min(1).max(200)),
    replaceQualification: z.boolean(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();

// The registry listing. Which template a pipeline runs is read from the pipeline, not from here.
export function listTemplates() {
  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    pipelineName: template.pipelineName,
    stageNames: [...template.stageNames],
  }));
}

// Switches ONE pipeline to another template in one transaction. The other pipelines, records, tags, claims, tasks, and
// history stay. The qualification config stays workspace wide, so it is replaced only when asked.
export function switchTemplate(ctx: ActionContext, input: unknown) {
  const data = parseInput(switchTemplateSchema, input);
  const target = getTemplate(data.template);
  if (!target) {
    throw validationError(`Unknown template "${data.template}". Use one of: ${templates.map((template) => template.id).join(', ')}.`);
  }
  return mutate(ctx, (tx) => {
    const pipeline = getPipeline(tx.db, tx.workspaceId, data.pipelineId);
    if (!pipeline) throw notFound('Pipeline');
    if (pipeline.version !== data.expectedVersion) throw versionConflict(pipeline);
    const from = pipeline.template;
    if (from === target.id) throw validationError(`This pipeline already uses the ${target.name} template.`);

    const pipelineId = pipeline.id;
    const oldStages = pipeline.stages.map((stage) => ({ id: stage.id, name: stage.name }));
    const oldIds = new Set(oldStages.map((stage) => stage.id));

    for (const [stageId, newName] of Object.entries(data.stageMapping)) {
      if (!oldIds.has(stageId)) throw validationError(`Stage "${stageId}" is not a stage of this pipeline.`);
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

    // Keep the current config as it is. When nothing was saved the config in force is the workspace's default set
    // (read from workspace.template, which is frozen now that each pipeline records its own template), so save it
    // explicitly and the rules in force cannot change later.
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

    // The pipeline keeps its own name (names are the user's in a multi pipeline workspace; the template's pipeline name
    // only prefills the New pipeline sheet). workspace.template is not written: the pipeline records its own template.
    const result = tx.db
      .prepare('UPDATE pipeline SET template = ?, version = version + 1 WHERE id = ? AND workspace_id = ? AND version = ?')
      .run(target.id, pipelineId, tx.workspaceId, data.expectedVersion);
    if (result.changes !== 1) throw versionConflict(getPipeline(tx.db, tx.workspaceId, pipelineId));

    tx.audit('workspace.template_change', 'pipeline', pipelineId, {
      pipelineId,
      from,
      to: target.id,
      moved,
      replacedQualification: data.replaceQualification,
      ...(stageEventsDropped > 0 ? { stageEventsDropped } : {}),
    });
    emitRecord(tx, 'pipeline', pipelineId);
    return getPipeline(tx.db, tx.workspaceId, pipelineId)!;
  });
}
