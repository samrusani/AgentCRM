import { z } from 'zod';
import type { Db } from '../db.js';
import { readSettings } from '../qualification/config.js';
import { type ActionContext, emitRecord, mutate, parseInput, type Tx } from './context.js';

// Workspace settings for imports. Today this holds one switch: whether a batch from a run the user started
// is accepted without waiting in the review queue. It is off until a person turns it on in the UI.
export interface ImportSettings {
  autoAccept: boolean;
}

const settingsSchema = z.object({ autoAccept: z.boolean() }).strict();

// Anything other than a stored object with autoAccept exactly true reads as off.
export function readImportSettings(db: Db, workspaceId: string): ImportSettings {
  const saved = readSettings(db, workspaceId).imports;
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return { autoAccept: false };
  return { autoAccept: (saved as Record<string, unknown>).autoAccept === true };
}

function writeImportSettingsIn(tx: Tx, imports: ImportSettings): void {
  const settings = { ...readSettings(tx.db, tx.workspaceId), imports };
  tx.db.prepare('UPDATE workspace SET settings = ? WHERE id = ?').run(JSON.stringify(settings), tx.workspaceId);
}

export function getImportSettings(ctx: Pick<ActionContext, 'db' | 'workspaceId'>): ImportSettings {
  return readImportSettings(ctx.db, ctx.workspaceId);
}

export function setImportSettings(ctx: ActionContext, input: unknown): ImportSettings {
  const data = parseInput(settingsSchema, input);
  return mutate(ctx, (tx) => {
    writeImportSettingsIn(tx, { autoAccept: data.autoAccept });
    tx.audit('imports.settings_change', 'workspace', tx.workspaceId, { autoAccept: data.autoAccept });
    // Another open tab shows the switch, so it refetches on this signal like it does for capture settings.
    emitRecord(tx, 'import_settings', tx.workspaceId);
    return { autoAccept: data.autoAccept };
  });
}
