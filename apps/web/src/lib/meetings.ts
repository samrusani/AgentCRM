import type { Meeting } from '../api/types';

const pad = (value: number) => String(value).padStart(2, '0');

// The value a datetime-local input shows for a stored UTC timestamp: the same instant in the local zone, to the minute.
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The stored form of a datetime-local value, read in the local zone. Empty or unreadable input is null.
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

// The next whole hour, as a datetime-local value: a sensible start for a meeting someone is about to book.
export function nextHourInput(now = new Date()): string {
  const date = new Date(now);
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return toLocalInput(date.toISOString());
}

// Local midnight at the start of today, and the start of the day after tomorrow, as ISO bounds. The Today card asks for
// [start, end): today and tomorrow in the viewer's zone.
export function todayAndTomorrowBounds(now = new Date()): { from: string; to: string } {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 2);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function isTomorrow(iso: string, now = new Date()): boolean {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const time = Date.parse(iso);
  return time >= start.getTime() && time < end.getTime();
}

export function formatClock(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function attendeeLabel(count: number): string {
  return count === 0 ? 'No attendees' : count === 1 ? '1 attendee' : `${count} attendees`;
}

// Upcoming meetings start now or later and read soonest first. Held meetings started before now and read newest first.
export function splitMeetings(meetings: Meeting[], now = Date.now()): { upcoming: Meeting[]; past: Meeting[] } {
  const upcoming = meetings.filter((meeting) => Date.parse(meeting.startsAt) >= now).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const past = meetings.filter((meeting) => Date.parse(meeting.startsAt) < now).sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  return { upcoming, past };
}
