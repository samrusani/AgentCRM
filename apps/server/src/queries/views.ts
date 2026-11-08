import { z } from 'zod';
import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import type { Row } from '../records.js';

export const viewScreens = ['leads', 'relationships', 'pipeline'] as const;
export type ViewScreen = (typeof viewScreens)[number];

// An id here may dangle: the screen's own fallback handles a deleted list or pipeline, so existence is never checked.
const viewIdValue = z.string().trim().min(1).max(64);

// One strict schema per screen: the whitelist of URL state a view may carry. Unknown keys are refused.
const peopleConfigSchema = z
  .object({
    tab: z.enum(['people', 'organizations']),
    q: z.string().max(256),
    list: viewIdValue,
    sort: z.literal('fit'),
  })
  .partial()
  .strict();

const pipelineConfigSchema = z
  .object({
    pipeline: viewIdValue,
    status: z.enum(['open', 'nurture', 'passed', 'lost', 'all']),
    view: z.enum(['board', 'table']),
  })
  .partial()
  .strict();

export function configSchemaFor(screen: ViewScreen) {
  return screen === 'pipeline' ? pipelineConfigSchema : peopleConfigSchema;
}

export type ViewConfig = Record<string, string>;

// Read time re-filter: keeps only the keys whose values still pass the screen's whitelist, so junk that reached the
// database by any other route never reaches a URL.
export function filterConfig(screen: ViewScreen, raw: unknown): ViewConfig {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const schema = configSchemaFor(screen);
  const kept: ViewConfig = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Object.hasOwn(schema.shape, key)) continue;
    const field = (schema.shape as Record<string, z.ZodTypeAny>)[key]!;
    const result = field.safeParse(value);
    if (result.success && typeof result.data === 'string') kept[key] = result.data;
  }
  return kept;
}

export interface SavedView {
  id: string;
  workspaceId: string;
  name: string;
  screen: ViewScreen;
  config: ViewConfig;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toSavedView(row: Row): SavedView {
  const screen = String(row.screen) as ViewScreen;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    screen,
    config: filterConfig(screen, row.config),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// Oldest first, so a view keeps its place in the select as others come and go.
export function listViews(db: Db, workspaceId: string, screen: ViewScreen): SavedView[] {
  const rows = db
    .prepare('SELECT * FROM saved_view WHERE workspace_id = ? AND screen = ? ORDER BY created_at, id')
    .all(workspaceId, screen) as Row[];
  return rows.map(toSavedView);
}

export function getView(db: Db, workspaceId: string, id: string): SavedView | null {
  const row = db.prepare('SELECT * FROM saved_view WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as Row | undefined;
  return row ? toSavedView(row) : null;
}

export function requireView(db: Db, workspaceId: string, id: string): SavedView {
  const view = getView(db, workspaceId, id);
  if (!view) throw notFound('View');
  return view;
}
