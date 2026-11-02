import type { Db } from '../db.js';
import { activeRunStatuses, type Row, toRun } from '../records.js';
import { listApprovals } from './runs.js';
import { dayBounds, listTasks } from './tasks.js';
import { getCounts } from './workspace.js';

export function getToday(db: Db, workspaceId: string, now: Date = new Date()) {
  const bounds = dayBounds(now);
  const overdue = listTasks(db, workspaceId, { filter: 'overdue', limit: 200, now }).items;
  const today = listTasks(db, workspaceId, { filter: 'today', limit: 200, now }).items;
  const runsActive = (
    db
      .prepare(
        `SELECT * FROM run WHERE workspace_id = ? AND status IN (${activeRunStatuses.map(() => '?').join(', ')})
         ORDER BY created_at DESC, id DESC LIMIT 50`,
      )
      .all(workspaceId, ...activeRunStatuses) as Row[]
  ).map(toRun);
  return {
    tasksDue: [...overdue, ...today],
    approvalsPending: listApprovals(db, workspaceId, { status: 'pending', limit: 50 }).items,
    runsActive,
    counts: {
      ...getCounts(db, workspaceId),
      tasksOverdue: overdue.length,
      tasksDueToday: today.length,
    },
    dayStart: bounds.start,
    dayEnd: bounds.end,
  };
}
