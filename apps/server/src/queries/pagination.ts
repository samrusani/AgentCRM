import type { Db } from '../db.js';
import { validationError } from '../errors.js';
import type { Row } from '../records.js';

export const defaultLimit = 50;
export const maxLimit = 200;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return defaultLimit;
  return Math.min(Math.max(Math.trunc(limit), 1), maxLimit);
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[a-z]{3}_[0-9a-f]{12}$/.test(id)) throw validationError('The cursor is not valid.');
  return id;
}

export interface PageSpec<T> {
  db: Db;
  workspaceId: string;
  // SELECT list, FROM and JOIN clauses. The main table uses the alias given in `alias`.
  select: string;
  table: string;
  alias: string;
  where: string[];
  params: unknown[];
  // Sort expressions on the main table. The last one must be the id column.
  keys: string[];
  direction: 'ASC' | 'DESC';
  cursor?: string | undefined;
  limit?: number | undefined;
  map: (row: Row) => T;
}

export function paginate<T>(spec: PageSpec<T>): Page<T> {
  const limit = clampLimit(spec.limit);
  const where = [...spec.where];
  const params = [...spec.params];
  if (spec.cursor) {
    const cursorId = decodeCursor(spec.cursor);
    const exists = spec.db
      .prepare(`SELECT 1 FROM ${spec.table} WHERE id = ? AND workspace_id = ?`)
      .get(cursorId, spec.workspaceId);
    if (!exists) throw validationError('The cursor is not valid.');
    const keyList = spec.keys.join(', ');
    const comparator = spec.direction === 'ASC' ? '>' : '<';
    where.push(
      `(${keyList}) ${comparator} (SELECT ${keyList} FROM ${spec.table} AS ${spec.alias} WHERE ${spec.alias}.id = ?)`,
    );
    params.push(cursorId);
  }
  const sql = `${spec.select} WHERE ${where.length > 0 ? where.join(' AND ') : '1 = 1'} ORDER BY ${spec.keys
    .map((key) => `${key} ${spec.direction}`)
    .join(', ')} LIMIT ?`;
  const rows = spec.db.prepare(sql).all(...params, limit + 1) as Row[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(spec.map),
    nextCursor: hasMore && last ? encodeCursor(String(last.id)) : null,
  };
}

export function containsPattern(query: string): string {
  const escaped = query.trim().toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}

export function prefixPattern(query: string): string {
  return containsPattern(query).slice(0, -1);
}
