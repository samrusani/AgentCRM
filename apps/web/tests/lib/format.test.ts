import { formatDueDay } from '../../src/lib/format';

describe('formatDueDay', () => {
  // Local time strings (no Z) so the result does not depend on the machine time zone.
  it('renders weekday, day, month in that order', () => {
    expect(formatDueDay('2026-11-10T12:00:00')).toBe('Tue 10 Nov');
  });

  it('does not pad a single digit day', () => {
    expect(formatDueDay('2026-01-05T09:30:00')).toBe('Mon 5 Jan');
  });

  it('renders the last day of the year', () => {
    expect(formatDueDay('2026-12-25T23:00:00')).toBe('Fri 25 Dec');
  });

  it('renders a weekend date as it falls, not skipped', () => {
    expect(formatDueDay('2026-11-14T12:00:00')).toBe('Sat 14 Nov');
  });

  it('returns an empty string for null, undefined, empty, and unreadable input', () => {
    expect(formatDueDay(null)).toBe('');
    expect(formatDueDay(undefined)).toBe('');
    expect(formatDueDay('')).toBe('');
    expect(formatDueDay('not a date')).toBe('');
  });
});
