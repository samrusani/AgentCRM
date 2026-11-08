import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import { type Row, toMeeting } from '../records.js';

export const defaultMeetingLimit = 200;
export const maxMeetingLimit = 500;

const meetingSelect = `SELECT m.*,
    (SELECT name FROM organization WHERE id = m.organization_id) AS organization_name,
    (SELECT name FROM opportunity WHERE id = m.opportunity_id) AS opportunity_name,
    (SELECT COUNT(*) FROM meeting_attendee a WHERE a.meeting_id = m.id) AS attendee_count
  FROM meeting m`;

export interface ListMeetingsInput {
  from?: string | undefined;
  to?: string | undefined;
  organizationId?: string | undefined;
  personId?: string | undefined;
  limit?: number | undefined;
  order?: 'asc' | 'desc' | undefined;
}

// Ordered by start time. `from` is inclusive and `to` is exclusive, both on starts_at.
export function listMeetings(db: Db, workspaceId: string, input: ListMeetingsInput = {}) {
  const where = ['m.workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (input.from) {
    where.push('m.starts_at >= ?');
    params.push(input.from);
  }
  if (input.to) {
    where.push('m.starts_at < ?');
    params.push(input.to);
  }
  if (input.organizationId) {
    where.push('m.organization_id = ?');
    params.push(input.organizationId);
  }
  if (input.personId) {
    where.push('EXISTS (SELECT 1 FROM meeting_attendee x WHERE x.meeting_id = m.id AND x.person_id = ?)');
    params.push(input.personId);
  }
  const limit =
    input.limit === undefined || Number.isNaN(input.limit)
      ? defaultMeetingLimit
      : Math.min(Math.max(Math.trunc(input.limit), 1), maxMeetingLimit);
  const rows = db
    // Descending order exists for the past view: under the cap, ascending would keep the oldest rows and cut the
    // newest, the opposite of what a "newest first" list must keep.
    .prepare(`${meetingSelect} WHERE ${where.join(' AND ')} ORDER BY m.starts_at${input.order === 'desc' ? ' DESC' : ''}, m.id${input.order === 'desc' ? ' DESC' : ''} LIMIT ?`)
    .all(...(params as never[]), limit) as Row[];
  return { items: rows.map(toMeeting), nextCursor: null as string | null };
}

export function meetingAttendees(db: Db, meetingId: string): { id: string; name: string }[] {
  return (
    db
      .prepare(
        `SELECT p.id, TRIM(p.first_name || ' ' || p.last_name) AS name FROM meeting_attendee a JOIN person p ON p.id = a.person_id
         WHERE a.meeting_id = ? ORDER BY a.created_at, a.rowid`,
      )
      .all(meetingId) as Row[]
  ).map((row) => ({ id: String(row.id), name: String(row.name) }));
}

export function getMeetingRow(db: Db, workspaceId: string, id: string) {
  const row = db.prepare(`${meetingSelect} WHERE m.workspace_id = ? AND m.id = ?`).get(workspaceId, id) as Row | undefined;
  return row ? toMeeting(row) : null;
}

// One meeting with its attendees. Names are resolved at read time and never stored.
export function getMeeting(db: Db, workspaceId: string, id: string) {
  const meeting = getMeetingRow(db, workspaceId, id);
  return meeting ? { ...meeting, attendees: meetingAttendees(db, id) } : null;
}

export function requireMeeting(db: Db, workspaceId: string, id: string) {
  const meeting = getMeeting(db, workspaceId, id);
  if (!meeting) throw notFound('Meeting');
  return meeting;
}
