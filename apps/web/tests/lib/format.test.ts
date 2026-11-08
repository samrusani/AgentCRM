import { birthdayProximity, formatBirthday, formatDueDay } from '../../src/lib/format';

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

describe('formatBirthday', () => {
  it('renders day, short month, and the year only when stored', () => {
    expect(formatBirthday('1986-11-12')).toBe('12 Nov 1986');
    expect(formatBirthday('11-12')).toBe('12 Nov');
    expect(formatBirthday('03-04')).toBe('4 Mar');
    expect(formatBirthday('02-29')).toBe('29 Feb');
  });

  it('shows an unreadable value as stored', () => {
    expect(formatBirthday('soon')).toBe('soon');
  });
});

describe('birthdayProximity', () => {
  const now = new Date(2026, 10, 8, 15).getTime(); // 8 Nov 2026, local

  it('says today on the day and counts days through seven', () => {
    expect(birthdayProximity('11-08', now)).toBe('today');
    expect(birthdayProximity('1990-11-08', now)).toBe('today');
    expect(birthdayProximity('11-09', now)).toBe('in 1 day');
    expect(birthdayProximity('11-12', now)).toBe('in 4 days');
    expect(birthdayProximity('11-15', now)).toBe('in 7 days');
  });

  it('says nothing for day 8, for a birthday just passed, and for junk', () => {
    expect(birthdayProximity('11-16', now)).toBeNull();
    expect(birthdayProximity('11-07', now)).toBeNull();
    expect(birthdayProximity('junk', now)).toBeNull();
  });

  it('wraps across the new year', () => {
    expect(birthdayProximity('01-02', new Date(2026, 11, 28).getTime())).toBe('in 5 days');
  });

  it('treats Feb 29 as Feb 28 in a non leap year and Feb 29 in a leap year', () => {
    expect(birthdayProximity('02-29', new Date(2027, 1, 28).getTime())).toBe('today');
    expect(birthdayProximity('02-29', new Date(2028, 1, 28).getTime())).toBe('in 1 day');
    expect(birthdayProximity('02-29', new Date(2028, 1, 29).getTime())).toBe('today');
  });
});
