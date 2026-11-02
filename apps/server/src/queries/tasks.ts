import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import { type Row, toTask } from '../records.js';
import { paginate, type Page } from './pagination.js';

export const taskSelect = `SELECT t.*, CASE t.entity_type
    WHEN 'person' THEN (SELECT TRIM(first_name || ' ' || last_name) FROM person WHERE id = t.entity_id)
    WHEN 'organization' THEN (SELECT name FROM organization WHERE id = t.entity_id)
    WHEN 'opportunity' THEN (SELECT name FROM opportunity WHERE id = t.entity_id)
  END AS entity_name FROM task t`;

export type TaskFilter = 'today' | 'overdue' | 'open' | 'done';

export function dayBounds(now: Date): { start: string; end: string } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function getTask(db: Db, workspaceId: string, id: string) {
  const row = db
    .prepare(`${taskSelect} WHERE t.workspace_id = ? AND t.id = ?`)
    .get(workspaceId, id) as Row | undefined;
  return row ? toTask(row) : null;
}

export function requireTask(db: Db, workspaceId: string, id: string) {
  const task = getTask(db, workspaceId, id);
  if (!task) throw notFound('Task');
  return task;
}

export interface ListTasksInput {
  filter?: TaskFilter | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  now?: Date | undefined;
}

export function listTasks(db: Db, workspaceId: string, input: ListTasksInput = {}): Page<ReturnType<typeof toTask>> {
  const where = ['t.workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  const bounds = dayBounds(input.now ?? new Date());
  switch (input.filter ?? 'open') {
    case 'today':
      where.push("t.status = 'open'", 't.due_at >= ?', 't.due_at < ?');
      params.push(bounds.start, bounds.end);
      break;
    case 'overdue':
      where.push("t.status = 'open'", 't.due_at < ?');
      params.push(bounds.start);
      break;
    case 'done':
      where.push("t.status = 'done'");
      break;
    case 'open':
      where.push("t.status = 'open'");
      break;
  }
  return paginate({
    db,
    workspaceId,
    select: taskSelect,
    table: 'task',
    alias: 't',
    where,
    params,
    keys: ["COALESCE(t.due_at, '9999-12-31T00:00:00.000Z')", 't.id'],
    direction: 'ASC',
    cursor: input.cursor,
    limit: input.limit,
    map: toTask,
  });
}
