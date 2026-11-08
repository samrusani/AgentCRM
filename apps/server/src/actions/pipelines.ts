import { z } from 'zod';
import { conflict, validationError } from '../errors.js';
import { requirePipeline } from '../queries/pipelines.js';
import { getTemplate, templates } from '../templates.js';
import { disableAutomationsForDeletionIn } from './automations.js';
import { type ActionContext, emitRecord, mutate, parseInput, versionConflict } from './context.js';
import { opportunityFields } from './entities.js';
import { idSchema } from './schemas.js';

// The pipeline name follows the same rule as other record names: trimmed, 1 to 200 characters.
const pipelineName = opportunityFields.name;

const createPipelineSchema = z.object({ name: pipelineName, template: z.string().trim().min(1).max(64) }).strict();

const updatePipelineSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    fields: z.object({ name: pipelineName }).strict(),
  })
  .strict();

// Creates a pipeline with the template's ordered stage set. A pipeline is configuration, so it carries no records yet.
export function createPipeline(ctx: ActionContext, input: unknown) {
  const data = parseInput(createPipelineSchema, input);
  const template = getTemplate(data.template);
  if (!template) {
    throw validationError(`Unknown template "${data.template}". Use one of: ${templates.map((entry) => entry.id).join(', ')}.`);
  }
  return mutate(ctx, (tx) => {
    const id = tx.newId('pip');
    const now = tx.now();
    tx.db
      .prepare('INSERT INTO pipeline (id, created_at, workspace_id, version, name, template) VALUES (?, ?, ?, 1, ?, ?)')
      .run(id, now, tx.workspaceId, data.name, template.id);
    template.stageNames.forEach((name, index) => {
      tx.db
        .prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, ?)')
        .run(tx.newId('stg'), now, id, name, index + 1);
    });
    tx.audit('pipeline.create', 'pipeline', id, { name: data.name, template: template.id });
    emitRecord(tx, 'pipeline', id);
    return requirePipeline(tx.db, tx.workspaceId, id);
  });
}

// Renames a pipeline. The template and the stages change only through the template switch.
export function updatePipeline(ctx: ActionContext, id: string, input: unknown) {
  const data = parseInput(updatePipelineSchema, input);
  return mutate(ctx, (tx) => {
    const current = requirePipeline(tx.db, tx.workspaceId, id);
    if (current.version !== data.expectedVersion) throw versionConflict(current);
    const result = tx.db
      .prepare('UPDATE pipeline SET name = ?, version = version + 1 WHERE id = ? AND workspace_id = ? AND version = ?')
      .run(data.fields.name, id, tx.workspaceId, data.expectedVersion);
    if (result.changes !== 1) throw versionConflict(requirePipeline(tx.db, tx.workspaceId, id));
    tx.audit('pipeline.update', 'pipeline', id, { from: current.name, to: data.fields.name });
    emitRecord(tx, 'pipeline', id);
    return requirePipeline(tx.db, tx.workspaceId, id);
  });
}

// Deletes a pipeline and its stages. Refused while any opportunity of any status names it, and for the last pipeline.
export function deletePipeline(ctx: ActionContext, rawId: string): void {
  const id = parseInput(idSchema, rawId);
  mutate(ctx, (tx) => {
    const current = requirePipeline(tx.db, tx.workspaceId, id);
    const deals = Number(
      (
        tx.db.prepare('SELECT COUNT(*) AS n FROM opportunity WHERE workspace_id = ? AND pipeline_id = ?').get(tx.workspaceId, id) as {
          n: number;
        }
      ).n,
    );
    if (deals > 0) {
      throw conflict(
        `This pipeline still holds ${deals} ${deals === 1 ? 'deal' : 'deals'}. Deals cannot be moved to another pipeline or deleted in this version, so this pipeline cannot be deleted.`,
      );
    }
    const pipelineCount = Number(
      (tx.db.prepare('SELECT COUNT(*) AS n FROM pipeline WHERE workspace_id = ?').get(tx.workspaceId) as { n: number }).n,
    );
    if (pipelineCount <= 1) throw validationError('This is the only pipeline. A workspace keeps at least one.');
    disableAutomationsForDeletionIn(tx, { pipelineId: id }, `The pipeline "${current.name}" this rule named was deleted.`);
    tx.db.prepare('DELETE FROM stage WHERE pipeline_id = ?').run(id);
    tx.db.prepare('DELETE FROM pipeline WHERE id = ? AND workspace_id = ?').run(id, tx.workspaceId);
    tx.audit('pipeline.delete', 'pipeline', id, { name: current.name, template: current.template });
    emitRecord(tx, 'pipeline', id);
  });
}
