import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { applyChanges, createPerson, proposeChanges, updatePerson } from '../src/actions/index.js';
import { AppError } from '../src/errors.js';
import { buildApp } from '../src/http/app.js';
import { getPerson } from '../src/queries/people.js';
import { getBirthdays, getToday } from '../src/queries/today.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

let counter = 0;
const person = (birthday?: string | null, firstName = `Bday${(counter += 1)}`) => {
  const created = createPerson(env.ctx, { firstName, lastName: 'Test' });
  if (birthday) updatePerson(env.ctx, created.id, { expectedVersion: 1, fields: { birthday } });
  return created;
};

function rejected(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('Expected the call to be rejected.');
}

describe('birthday validation', () => {
  it('accepts both forms, Feb 29 with or without a year it fits, and clears with null or empty', () => {
    const subject = person();
    let version = 1;
    for (const value of ['1986-11-12', '11-12', '02-29', '2024-02-29', '2000-02-29']) {
      const updated = updatePerson(env.ctx, subject.id, { expectedVersion: version, fields: { birthday: value } });
      expect(updated.birthday).toBe(value);
      version = updated.version;
    }
    expect(updatePerson(env.ctx, subject.id, { expectedVersion: version, fields: { birthday: ' 03-04 ' } }).birthday).toBe('03-04');
    expect(updatePerson(env.ctx, subject.id, { expectedVersion: version + 1, fields: { birthday: '' } }).birthday).toBeNull();
    expect(updatePerson(env.ctx, subject.id, { expectedVersion: version + 2, fields: { birthday: '05-06' } }).birthday).toBe('05-06');
    expect(updatePerson(env.ctx, subject.id, { expectedVersion: version + 3, fields: { birthday: null } }).birthday).toBeNull();
  });

  it.each(['junk', '13-01', '2020-13-01', '12-32', '2020-12-32', '02-30', '2024-02-30', '2023-02-29', '00-10', '10-00', '1986/11/12', '11/12', '1986-1-2', '86-11-12', '12-1'])(
    'refuses %s naming both forms',
    (value) => {
      const subject = person();
      const error = rejected(() => updatePerson(env.ctx, subject.id, { expectedVersion: 1, fields: { birthday: value } }));
      expect(error.code).toBe('validation');
      expect(error.message).toContain('YYYY-MM-DD');
      expect(error.message).toContain('MM-DD');
      expect(getPerson(env.db, env.workspaceId, subject.id)).toMatchObject({ birthday: null, version: 1 });
    },
  );
});

describe('birthday writes', () => {
  it('round trips through PATCH, bumps the version, writes no claim, and starts null', async () => {
    const subject = person();
    expect(getPerson(env.db, env.workspaceId, subject.id)?.birthday).toBeNull();
    const response = await app.inject({ method: 'PATCH', url: `/api/people/${subject.id}`, headers: host, payload: { expectedVersion: 1, fields: { birthday: '1986-11-12' } } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ birthday: '1986-11-12', version: 2 });
    const read = await app.inject({ method: 'GET', url: `/api/people/${subject.id}`, headers: host });
    expect(read.json()).toMatchObject({ birthday: '1986-11-12' });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ?').get(subject.id)).toEqual({ n: 0 });
    const bad = await app.inject({ method: 'PATCH', url: `/api/people/${subject.id}`, headers: host, payload: { expectedVersion: 2, fields: { birthday: 'soon' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain('MM-DD');
  });

  it('rides the proposal path: diff, invalid value flagged, apply writes it', () => {
    const subject = person();
    const proposal = proposeChanges(env.ctx, {
      changes: [
        { entityType: 'person', id: subject.id, fields: { birthday: '03-14' } },
        { entityType: 'person', id: subject.id, fields: { birthday: '03-32' } },
      ],
    });
    expect(proposal.valid).toBe(false);
    expect(proposal.changes[0]!.diff).toEqual([{ field: 'birthday', from: null, to: '03-14' }]);
    expect(proposal.changes[1]!.valid).toBe(false);
    expect(proposal.changes[1]!.errors[0]).toContain('MM-DD');
    const good = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: subject.id, fields: { birthday: '03-14' } }] });
    const result = applyChanges(env.ctx, {
      proposalHash: good.proposalHash,
      changes: good.changes.map(({ entityType, id, expectedVersion, fields }) => ({ entityType, id, expectedVersion, fields })),
    });
    expect(result.applied).toHaveLength(1);
    expect(getPerson(env.db, env.workspaceId, subject.id)).toMatchObject({ birthday: '03-14', version: 2 });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ?').get(subject.id)).toEqual({ n: 0 });
  });
});

describe('birthdays on Today', () => {
  // Local noon, so the local calendar date is unambiguous in any timezone.
  const at = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12);

  it('includes today and day 7, excludes day 8 and yesterday, sorted soonest first with turns only when a year is stored', () => {
    // Names carry a per test prefix because the people in this file share one workspace.
    const today = person('2026-09-10', 'WinToday');
    const day7 = person('09-17', 'WinSeven');
    const day3 = person('1990-09-13', 'WinThree');
    person('09-18', 'WinEight');
    person('09-09', 'WinYesterday');
    const found = getBirthdays(env.db, env.workspaceId, at(2026, 9, 10)).filter((item) => item.name.startsWith('Win'));
    expect(found).toEqual([
      { personId: today.id, name: 'WinToday Test', date: '2026-09-10' }, // stored year equals this year: no turns
      { personId: day3.id, name: 'WinThree Test', date: '2026-09-13', turns: 36 },
      { personId: day7.id, name: 'WinSeven Test', date: '2026-09-17' },
    ]);
  });

  it('gives turns on the day itself and breaks ties by name', () => {
    person('1980-04-02', 'TieB');
    person('1970-04-02', 'TieA');
    const found = getBirthdays(env.db, env.workspaceId, at(2026, 4, 2)).filter((item) => item.name.startsWith('Tie'));
    expect(found.map((item) => [item.name, item.date, item.turns])).toEqual([
      ['TieA Test', '2026-04-02', 56],
      ['TieB Test', '2026-04-02', 46],
    ]);
  });

  it('wraps across December and January with the date in the new year', () => {
    const dec = person('12-30', 'WrapDec');
    const jan = person('1999-01-03', 'WrapJan');
    person('01-09', 'WrapLate');
    const found = getBirthdays(env.db, env.workspaceId, at(2026, 12, 28)).filter((item) => item.name.startsWith('Wrap'));
    expect(found).toEqual([
      { personId: dec.id, name: 'WrapDec Test', date: '2026-12-30' },
      { personId: jan.id, name: 'WrapJan Test', date: '2027-01-03', turns: 28 },
    ]);
  });

  it('counts Feb 29 as Feb 28 in a non leap year and as Feb 29 in a leap year', () => {
    const leapling = person('2000-02-29', 'Leap');
    const nonLeap = getBirthdays(env.db, env.workspaceId, at(2027, 2, 25)).filter((item) => item.name.startsWith('Leap'));
    expect(nonLeap).toEqual([{ personId: leapling.id, name: 'Leap Test', date: '2027-02-28', turns: 27 }]);
    expect(getBirthdays(env.db, env.workspaceId, at(2027, 3, 1)).filter((item) => item.name.startsWith('Leap'))).toEqual([]);
    const leapYear = getBirthdays(env.db, env.workspaceId, at(2028, 2, 25)).filter((item) => item.name.startsWith('Leap'));
    expect(leapYear).toEqual([{ personId: leapling.id, name: 'Leap Test', date: '2028-02-29', turns: 28 }]);
    // A Feb 28 person and a Feb 29 person both show on Feb 28 of a non leap year.
    const regular = person('02-28', 'LeapPal');
    const both = getBirthdays(env.db, env.workspaceId, at(2027, 2, 28)).filter((item) => item.name.startsWith('Leap'));
    expect(both.map((item) => item.personId).sort()).toEqual([leapling.id, regular.id].sort());
  });

  it('is scoped to the workspace and appears on GET /api/today, creating no tasks', async () => {
    env.db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_other', '2026-01-01', 'Other', 't');
    env.db
      .prepare('INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, tags, updated_at, birthday) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)')
      .run('per_foreign', '2026-01-01', 'wsp_other', 'Foreign', 'Person', '[]', '2026-01-01', '07-04');
    const mine = person('07-04', 'Isolated');
    const found = getToday(env.db, env.workspaceId, at(2026, 7, 4)).birthdays.filter((item) => item.name.startsWith('Isolated') || item.name.startsWith('Foreign'));
    expect(found).toEqual([{ personId: mine.id, name: 'Isolated Test', date: '2026-07-04' }]);
    expect(getToday(env.db, 'wsp_other', at(2026, 7, 4)).birthdays.map((item) => item.personId)).toEqual(['per_foreign']);
    const tasksBefore = env.db.prepare('SELECT COUNT(*) AS n FROM task').get();
    const response = await app.inject({ method: 'GET', url: '/api/today', headers: host });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().birthdays)).toBe(true);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM task').get()).toEqual(tasksBefore);
  });
});
