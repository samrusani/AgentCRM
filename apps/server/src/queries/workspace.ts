import type { Db } from '../db.js';
import { AppError } from '../errors.js';
import { type Row, toWorkspace } from '../records.js';

export function findWorkspace(db: Db) {
  const row = db.prepare('SELECT * FROM workspace ORDER BY created_at, id LIMIT 1').get() as Row | undefined;
  return row ? toWorkspace(row) : null;
}

export function requireWorkspace(db: Db) {
  const workspace = findWorkspace(db);
  if (!workspace) {
    throw new AppError('not_found', 'No workspace exists yet. Run "npm run seed" or start the server once.');
  }
  return workspace;
}

export function getCounts(db: Db, workspaceId: string) {
  const count = (sql: string): number =>
    Number((db.prepare(sql).get(workspaceId) as { n: number }).n);
  return {
    people: count('SELECT COUNT(*) AS n FROM person WHERE workspace_id = ?'),
    organizations: count('SELECT COUNT(*) AS n FROM organization WHERE workspace_id = ?'),
    opportunities: count('SELECT COUNT(*) AS n FROM opportunity WHERE workspace_id = ?'),
    openOpportunities: count("SELECT COUNT(*) AS n FROM opportunity WHERE workspace_id = ? AND status = 'open'"),
    tasksOpen: count("SELECT COUNT(*) AS n FROM task WHERE workspace_id = ? AND status = 'open'"),
    runs: count('SELECT COUNT(*) AS n FROM run WHERE workspace_id = ?'),
    approvalsPending: count("SELECT COUNT(*) AS n FROM approval WHERE workspace_id = ? AND status = 'pending'"),
  };
}
