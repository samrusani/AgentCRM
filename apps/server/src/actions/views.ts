import { z } from 'zod';
import { configSchemaFor, requireView, viewScreens } from '../queries/views.js';
import { type ActionContext, emitRecord, mutate, parseInput, versionConflict } from './context.js';
import { idSchema } from './schemas.js';

const viewName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value), 'The name cannot contain control characters');

const screenSchema = z.enum(viewScreens);

const createViewSchema = z.object({ name: viewName, screen: screenSchema, config: z.record(z.unknown()) }).strict();

const updateViewSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    fields: z
      .object({ name: viewName, config: z.record(z.unknown()) })
      .partial()
      .strict()
      .refine((fields) => Object.keys(fields).length > 0, 'Provide at least one field to change'),
  })
  .strict();

function parseConfig(screen: (typeof viewScreens)[number], config: unknown): Record<string, string> {
  return parseInput(configSchemaFor(screen), config) as Record<string, string>;
}

// A saved view is a named shortcut to URL state on one screen. It holds whitelisted keys only and never a query or
// rows. A list or pipeline id may dangle on purpose, so existence is not checked. Applying a view is a click in the web
// app that navigates; nothing here (or anywhere on the agent side) applies one.
export function createView(ctx: ActionContext, input: unknown) {
  const data = parseInput(createViewSchema, input);
  const config = parseConfig(data.screen, data.config);
  return mutate(ctx, (tx) => {
    const id = tx.newId('svw');
    const now = tx.now();
    tx.db
      .prepare('INSERT INTO saved_view (id, created_at, workspace_id, version, name, screen, config, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
      .run(id, now, tx.workspaceId, data.name, data.screen, JSON.stringify(config), now);
    tx.audit('view.create', 'view', id, { name: data.name, screen: data.screen, keys: Object.keys(config) });
    emitRecord(tx, 'view', id);
    return requireView(tx.db, tx.workspaceId, id);
  });
}

export function updateView(ctx: ActionContext, id: string, input: unknown) {
  const data = parseInput(updateViewSchema, input);
  return mutate(ctx, (tx) => {
    const current = requireView(tx.db, tx.workspaceId, id);
    if (current.version !== data.expectedVersion) throw versionConflict(current);
    const nextName = data.fields.name ?? current.name;
    const nextConfig = data.fields.config ? parseConfig(current.screen, data.fields.config) : current.config;
    const result = tx.db
      .prepare('UPDATE saved_view SET name = ?, config = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND version = ?')
      .run(nextName, JSON.stringify(nextConfig), tx.now(), id, tx.workspaceId, data.expectedVersion);
    if (result.changes !== 1) throw versionConflict(requireView(tx.db, tx.workspaceId, id));
    tx.audit('view.update', 'view', id, { name: nextName, screen: current.screen, changed: Object.keys(data.fields) });
    emitRecord(tx, 'view', id);
    return requireView(tx.db, tx.workspaceId, id);
  });
}

export function deleteView(ctx: ActionContext, rawId: string): void {
  const id = parseInput(idSchema, rawId);
  mutate(ctx, (tx) => {
    const current = requireView(tx.db, tx.workspaceId, id);
    tx.db.prepare('DELETE FROM saved_view WHERE id = ? AND workspace_id = ?').run(id, tx.workspaceId);
    tx.audit('view.delete', 'view', id, { name: current.name, screen: current.screen });
    emitRecord(tx, 'view', id);
  });
}
