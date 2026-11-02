import type { Db } from '../db.js';
import { notFound, validationError } from '../errors.js';
import { type Row } from '../records.js';
import { clampLimit, decodeCursor, encodeCursor, type Page } from './pagination.js';

export const importRowStatuses = ['staged', 'duplicate', 'invalid', 'accepted', 'rejected'] as const;
export type ImportRowStatus = (typeof importRowStatuses)[number];

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

export interface ImportCounts {
  fetched: number;
  staged: number;
  duplicates: number;
  invalid: number;
  accepted: number;
  rejected: number;
}

export const emptyImportCounts: ImportCounts = { fetched: 0, staged: 0, duplicates: 0, invalid: 0, accepted: 0, rejected: 0 };

export function toImportBatch(row: Row) {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    sourceKind: String(row.source_kind),
    sourceRef: parseJson<Record<string, unknown>>(row.source_ref, {}),
    status: String(row.status) as 'staging' | 'awaiting_review' | 'accepted' | 'rejected' | 'failed',
    counts: { ...emptyImportCounts, ...parseJson<Partial<ImportCounts>>(row.counts, {}) },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toImportRow(row: Row, withRaw: boolean) {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    status: String(row.status) as ImportRowStatus,
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    mapped: parseJson<Record<string, unknown>>(row.mapped, {}),
    matchEntityType:
      row.match_entity_type === null || row.match_entity_type === undefined ? null : String(row.match_entity_type),
    matchEntityId: row.match_entity_id === null || row.match_entity_id === undefined ? null : String(row.match_entity_id),
    ...(withRaw ? { raw: parseJson<unknown>(row.raw, null) } : {}),
  };
}

export function getImportBatch(db: Db, workspaceId: string, id: string) {
  const row = db.prepare('SELECT * FROM import_batch WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as
    | Row
    | undefined;
  return row ? toImportBatch(row) : null;
}

export function getImportBatchForRun(db: Db, workspaceId: string, runId: string) {
  const row = db
    .prepare('SELECT * FROM import_batch WHERE workspace_id = ? AND run_id = ? ORDER BY created_at, id LIMIT 1')
    .get(workspaceId, runId) as Row | undefined;
  return row ? toImportBatch(row) : null;
}

export interface ImportDetailInput {
  status?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  withRaw?: boolean | undefined;
}

// Rows page by seq, which is stable because rows are never reordered after staging.
export function getImportDetail(db: Db, workspaceId: string, id: string, input: ImportDetailInput = {}) {
  const batch = getImportBatch(db, workspaceId, id);
  if (!batch) throw notFound('Import');
  const where = ['batch_id = ?'];
  const params: unknown[] = [id];
  if (input.status) {
    if (!(importRowStatuses as readonly string[]).includes(input.status)) {
      throw validationError(`Import row status "${input.status}" is not valid.`);
    }
    where.push('status = ?');
    params.push(input.status);
  }
  if (input.cursor) {
    const cursorId = decodeCursor(input.cursor);
    const cursorRow = db.prepare('SELECT seq FROM import_row WHERE id = ? AND batch_id = ?').get(cursorId, id) as
      | { seq: number }
      | undefined;
    if (!cursorRow) throw validationError('The cursor is not valid.');
    where.push('seq > ?');
    params.push(cursorRow.seq);
  }
  const limit = clampLimit(input.limit);
  const rows = db
    .prepare(`SELECT * FROM import_row WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`)
    .all(...params, limit + 1) as Row[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const page: Page<ReturnType<typeof toImportRow>> = {
    items: pageRows.map((row) => toImportRow(row, input.withRaw === true)),
    nextCursor: hasMore && last ? encodeCursor(String(last.id)) : null,
  };
  return { ...batch, ...page };
}
