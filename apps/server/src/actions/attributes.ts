import { z } from 'zod';
import { uniqueAttributeKey } from '../attributes.js';
import { countAttributeValues, requireAttributeDef } from '../queries/attributes.js';
import { emitRecord, mutate, parseInput, versionConflict, type ActionContext } from './context.js';
import { idSchema, optionalText } from './schemas.js';

const label = z.string().trim().min(1).max(200);
const description = optionalText(500);

const createAttributeSchema = z
  .object({
    entityType: z.enum(['person', 'organization']),
    label,
    kind: z.enum(['text', 'number', 'money']),
    description: description.optional().default(null),
  })
  .strict();

// Kind and key are fixed at creation, so they are not accepted here.
const updateAttributeSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    fields: z
      .object({ label, description })
      .partial()
      .strict()
      .refine((fields) => Object.keys(fields).length > 0, 'Provide at least one field to change'),
  })
  .strict();

// Defines a custom attribute. The key is slugified from the label and never changes; it goes last in display order.
export function createAttribute(ctx: ActionContext, input: unknown) {
  const data = parseInput(createAttributeSchema, input);
  return mutate(ctx, (tx) => {
    const id = tx.newId('atd');
    const now = tx.now();
    const key = uniqueAttributeKey(tx.db, tx.workspaceId, data.entityType, data.label);
    const last = tx.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM attribute_def WHERE workspace_id = ? AND entity_type = ?')
      .get(tx.workspaceId, data.entityType) as { seq: number };
    tx.db
      .prepare(
        `INSERT INTO attribute_def (id, created_at, workspace_id, version, entity_type, key, label, kind, description, seq, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, now, tx.workspaceId, data.entityType, key, data.label, data.kind, data.description, Number(last.seq) + 1, now);
    tx.audit('attribute.create', 'attribute_def', id, { entityType: data.entityType, key, label: data.label, kind: data.kind });
    emitRecord(tx, 'attribute_def', id);
    return requireAttributeDef(tx.db, tx.workspaceId, id);
  });
}

// Renames a definition or edits its description. Values stay as they are; reads show the new label.
export function updateAttribute(ctx: ActionContext, id: string, input: unknown) {
  const data = parseInput(updateAttributeSchema, input);
  return mutate(ctx, (tx) => {
    const current = requireAttributeDef(tx.db, tx.workspaceId, id);
    if (current.version !== data.expectedVersion) throw versionConflict(current);
    const nextLabel = data.fields.label ?? current.label;
    const nextDescription = 'description' in data.fields ? (data.fields.description ?? null) : current.description;
    const result = tx.db
      .prepare(
        'UPDATE attribute_def SET label = ?, description = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND version = ?',
      )
      .run(nextLabel, nextDescription, tx.now(), id, tx.workspaceId, data.expectedVersion);
    if (result.changes !== 1) throw versionConflict(requireAttributeDef(tx.db, tx.workspaceId, id));
    tx.audit('attribute.update', 'attribute_def', id, {
      key: current.key,
      from: { label: current.label, description: current.description },
      to: { label: nextLabel, description: nextDescription },
    });
    emitRecord(tx, 'attribute_def', id);
    return requireAttributeDef(tx.db, tx.workspaceId, id);
  });
}

// Deletes a definition and, through the foreign key, every value it holds. Claims that name the attribute stay as history.
export function deleteAttribute(ctx: ActionContext, rawId: string): void {
  const id = parseInput(idSchema, rawId);
  mutate(ctx, (tx) => {
    const current = requireAttributeDef(tx.db, tx.workspaceId, id);
    const valueCount = countAttributeValues(tx.db, tx.workspaceId, id);
    tx.db.prepare('DELETE FROM attribute_def WHERE id = ? AND workspace_id = ?').run(id, tx.workspaceId);
    tx.audit('attribute.delete', 'attribute_def', id, {
      entityType: current.entityType,
      key: current.key,
      label: current.label,
      valueCount,
    });
    emitRecord(tx, 'attribute_def', id);
  });
}
