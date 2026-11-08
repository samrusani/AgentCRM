import type { Db } from '../db.js';
import { activeRunStatuses, type Row, toRun } from '../records.js';
import { listApprovals, trimScopeForList } from './runs.js';
import { dayBounds, listTasks } from './tasks.js';
import { getCounts } from './workspace.js';

const birthdayWindowDays = 7;

const pad = (value: number) => String(value).padStart(2, '0');

// People whose birthday falls from today through seven days ahead (day 7 is in, day 8 is out), against the server's local
// calendar date. The stored value is YYYY-MM-DD or MM-DD, so each day in the window is matched by its MM-DD, which
// handles the Dec to Jan wrap for free. February 29 is stored as written and
// counts as February 28 in a non leap year, so that year's window day Feb 28 also matches 02-29. `turns` is the age on that
// day, only when a year is stored. Results sort soonest first, then by name.
export function getBirthdays(db: Db, workspaceId: string, now: Date = new Date()) {
  const rows = db
    .prepare("SELECT id, first_name, last_name, birthday FROM person WHERE workspace_id = ? AND birthday IS NOT NULL")
    .all(workspaceId) as { id: string; first_name: string; last_name: string; birthday: string }[];
  const byMonthDay = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.birthday.slice(-5);
    byMonthDay.set(key, [...(byMonthDay.get(key) ?? []), row]);
  }
  const found: { personId: string; name: string; date: string; turns?: number; offset: number }[] = [];
  for (let offset = 0; offset <= birthdayWindowDays; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const year = day.getFullYear();
    const monthDay = `${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    const leap = new Date(year, 1, 29).getMonth() === 1;
    const keys = [monthDay];
    if (monthDay === '02-28' && !leap) keys.push('02-29');
    for (const key of keys) {
      for (const row of byMonthDay.get(key) ?? []) {
        const storedYear = row.birthday.length === 10 ? Number(row.birthday.slice(0, 4)) : null;
        found.push({
          personId: row.id,
          name: `${row.first_name} ${row.last_name}`.trim(),
          date: `${year}-${monthDay}`,
          ...(storedYear !== null && year > storedYear ? { turns: year - storedYear } : {}),
          offset,
        });
      }
    }
  }
  return found
    .sort((a, b) => a.offset - b.offset || a.name.localeCompare(b.name) || a.personId.localeCompare(b.personId))
    .map(({ offset: _offset, ...rest }) => rest);
}

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
  ).map((row) => trimScopeForList(toRun(row)));
  return {
    tasksDue: [...overdue, ...today],
    approvalsPending: listApprovals(db, workspaceId, { status: 'pending', limit: 50 }).items,
    runsActive,
    birthdays: getBirthdays(db, workspaceId, now),
    counts: {
      ...getCounts(db, workspaceId),
      tasksOverdue: overdue.length,
      tasksDueToday: today.length,
    },
    dayStart: bounds.start,
    dayEnd: bounds.end,
  };
}
