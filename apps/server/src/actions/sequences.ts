import { z } from 'zod';
import { requireSequence } from '../queries/sequences.js';
import { type ActionContext, emitRecord, mutate, parseInput, versionConflict } from './context.js';
import { assertWithinCeiling, followupStepsSchema } from './followupRules.js';
import { idSchema } from './schemas.js';

const sequenceName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value), 'The name cannot contain control characters');

const createSequenceSchema = z.object({ name: sequenceName, steps: followupStepsSchema }).strict();

const updateSequenceSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    fields: z
      .object({ name: sequenceName, steps: followupStepsSchema })
      .partial()
      .strict()
      .refine((fields) => Object.keys(fields).length > 0, 'Provide at least one field to change'),
  })
  .strict();

// A follow-up sequence is a saved preset for the prepare editor. Its steps are checked with the same schema and the same
// 90 day ceiling as staged follow-ups, so a preset can never hold a plan staging would refuse. Nothing here creates a
// send, an approval, or a rule, and a staged send never points back at a sequence.
export function createSequence(ctx: ActionContext, input: unknown) {
  const data = parseInput(createSequenceSchema, input);
  assertWithinCeiling(data.steps);
  return mutate(ctx, (tx) => {
    const id = tx.newId('sqn');
    const now = tx.now();
    tx.db
      .prepare('INSERT INTO sequence (id, created_at, workspace_id, version, name, steps, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .run(id, now, tx.workspaceId, data.name, JSON.stringify(data.steps), now);
    tx.audit('sequence.create', 'sequence', id, { name: data.name, steps: data.steps.length });
    emitRecord(tx, 'sequence', id);
    return requireSequence(tx.db, tx.workspaceId, id);
  });
}

export function updateSequence(ctx: ActionContext, id: string, input: unknown) {
  const data = parseInput(updateSequenceSchema, input);
  if (data.fields.steps) assertWithinCeiling(data.fields.steps);
  return mutate(ctx, (tx) => {
    const current = requireSequence(tx.db, tx.workspaceId, id);
    if (current.version !== data.expectedVersion) throw versionConflict(current);
    const nextName = data.fields.name ?? current.name;
    const nextSteps = data.fields.steps ?? current.steps;
    const result = tx.db
      .prepare('UPDATE sequence SET name = ?, steps = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND version = ?')
      .run(nextName, JSON.stringify(nextSteps), tx.now(), id, tx.workspaceId, data.expectedVersion);
    if (result.changes !== 1) throw versionConflict(requireSequence(tx.db, tx.workspaceId, id));
    tx.audit('sequence.update', 'sequence', id, { name: nextName, steps: nextSteps.length, changed: Object.keys(data.fields) });
    emitRecord(tx, 'sequence', id);
    return requireSequence(tx.db, tx.workspaceId, id);
  });
}

// Sends and rules already staged keep their own frozen copy of the steps, so they are not touched.
export function deleteSequence(ctx: ActionContext, rawId: string): void {
  const id = parseInput(idSchema, rawId);
  mutate(ctx, (tx) => {
    const current = requireSequence(tx.db, tx.workspaceId, id);
    tx.db.prepare('DELETE FROM sequence WHERE id = ? AND workspace_id = ?').run(id, tx.workspaceId);
    tx.audit('sequence.delete', 'sequence', id, { name: current.name, steps: current.steps.length });
    emitRecord(tx, 'sequence', id);
  });
}
