import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import type { Row } from '../records.js';

export interface ListRecord {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

const listSelect = `SELECT l.*, (SELECT COUNT(*) FROM list_member m WHERE m.list_id = l.id) AS member_count FROM list l`;

function toList(row: Row): ListRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    version: Number(row.version),
    memberCount: Number(row.member_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// Newest first, with the member count. Lists hold people only in this version.
export function listLists(db: Db, workspaceId: string): ListRecord[] {
  return (
    db.prepare(`${listSelect} WHERE l.workspace_id = ? ORDER BY l.created_at DESC, l.id DESC`).all(workspaceId) as Row[]
  ).map(toList);
}

export function getList(db: Db, workspaceId: string, id: string): ListRecord | null {
  const row = db.prepare(`${listSelect} WHERE l.workspace_id = ? AND l.id = ?`).get(workspaceId, id) as Row | undefined;
  return row ? toList(row) : null;
}

export function requireList(db: Db, workspaceId: string, id: string): ListRecord {
  const list = getList(db, workspaceId, id);
  if (!list) throw notFound('List');
  return list;
}

// The lists a person belongs to, newest membership first. Only this workspace's lists count.
export function listsForPerson(db: Db, workspaceId: string, personId: string): { id: string; name: string }[] {
  return (
    db
      .prepare(
        `SELECT l.id, l.name FROM list_member m JOIN list l ON l.id = m.list_id
         WHERE l.workspace_id = ? AND m.person_id = ? ORDER BY m.created_at DESC, m.rowid DESC`,
      )
      .all(workspaceId, personId) as Row[]
  ).map((row) => ({ id: String(row.id), name: String(row.name) }));
}
