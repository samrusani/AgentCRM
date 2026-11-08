// Adversarial review probes for the birthday wave (person.birthday, birthdayField, queries/today.ts getBirthdays).
// KILLS (attack fails, pinned), CONFIRMS (live defect, passes today, comment says the fix), ACCEPTED (documented limit).
// Nothing here changes application code.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyChanges, createPerson, proposeChanges, updatePerson } from '../src/actions/index.js';
import { runChatTool } from '../src/agent/modelChat.js';
import { AppError } from '../src/errors.js';
import { getPersonDetail } from '../src/queries/people.js';
import { getBirthdays } from '../src/queries/today.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
afterAll(() => env.cleanup());

let n = 0;
const person = (firstName = `Pb${(n += 1)}`) => createPerson(env.ctx, { firstName, lastName: 'Probe' });
const setRaw = (id: string, value: string) => env.db.prepare('UPDATE person SET birthday = ? WHERE id = ?').run(value, id);
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);
const tryWrite = (value: string): 'ok' | 'refused' => {
  const p = person();
  try {
    updatePerson(env.ctx, p.id, { expectedVersion: 1, fields: { birthday: value } });
    return 'ok';
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return 'refused';
  }
};
const mine = (found: ReturnType<typeof getBirthdays>, prefix: string) => found.filter((item) => item.name.startsWith(prefix));

describe('parser', () => {
  it.each(['0000-01-01', '-2020-01-01', '+2020-01-01', '11-1', '1-10', '٢٠٢٠-٠١-٠١', '１１-１２', '11-12 x', 'x 11-12', '2020-11-12T00:00', '11-12\n11-12', '1986-11-12-', '12345-11-12', '0-11-12', 'garbage 11-12'])(
    'KILLS: %j is refused',
    (value) => expect(tryWrite(value)).toBe('refused'),
  );
  it('KILLS: padding is trimmed before storage, and a 40 char padded valid value is not tripped by max(20)', () => {
    const p = person();
    const updated = updatePerson(env.ctx, p.id, { expectedVersion: 1, fields: { birthday: `${' '.repeat(40)}\t11-12\n${' '.repeat(40)}` } });
    expect(updated.birthday).toBe('11-12');
  });
  it('KILLS: 9999-12-31 is accepted, and a future year yields no turns rather than a negative age', () => {
    const p = person('Future');
    updatePerson(env.ctx, p.id, { expectedVersion: 1, fields: { birthday: '9999-12-31' } });
    expect(mine(getBirthdays(env.db, env.workspaceId, at(2026, 12, 30)), 'Future')).toEqual([{ personId: p.id, name: 'Future Probe', date: '2026-12-31' }]);
  });
  it('ACCEPTED: years 0001 to 0099 are refused although the shape and calendar are real (Date.UTC maps 0 to 99 to 1900+). No living person is affected, so this stays a documented quirk', () => {
    expect(tryWrite('0099-06-01')).toBe('refused');
    expect(tryWrite('0001-01-01')).toBe('refused');
    expect(tryWrite('0100-06-01')).toBe('ok');
  });
  it('KILLS: century rules for Feb 29 with a year', () => {
    expect(tryWrite('1900-02-29')).toBe('refused');
    expect(tryWrite('2100-02-29')).toBe('refused');
    expect(tryWrite('2000-02-29')).toBe('ok');
    expect(tryWrite('1996-02-29')).toBe('ok');
  });
  it('ACCEPTED: a value that bypassed validation (direct SQL) matching only on its last five characters appears in the window but never carries turns', () => {
    const p = person('Raw');
    setRaw(p.id, 'garbage 06-10');
    expect(mine(getBirthdays(env.db, env.workspaceId, at(2026, 6, 10)), 'Raw')).toEqual([{ personId: p.id, name: 'Raw Probe', date: '2026-06-10' }]);
    const q = person('Raw2');
    setRaw(q.id, 'abcd-06-10'); // length 10, NaN year: turns suppressed
    expect(mine(getBirthdays(env.db, env.workspaceId, at(2026, 6, 10)), 'Raw2')[0]).not.toHaveProperty('turns');
  });
});

describe('window math', () => {
  const originalTz = process.env.TZ;
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });
  it.each(['America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Apia', 'UTC'])('KILLS: one calendar day per offset across DST and zone changes in %s', (zone) => {
    process.env.TZ = zone;
    const p = person(`Tz${zone.replace(/\W/g, '')}`);
    const prefix = `Tz${zone.replace(/\W/g, '')}`;
    // Walk every start date of a year; the person born on day D must show exactly when D is within 0..7 days, with date == D.
    const cases: [number, number, number][] = [[2026, 3, 8], [2026, 3, 29], [2026, 10, 25], [2026, 11, 1], [2026, 4, 5], [2026, 10, 4]];
    for (const [y, m, d] of cases) {
      for (let back = -1; back <= 8; back += 1) {
        const start = new Date(y, m - 1, d - back, 12);
        const target = new Date(y, m - 1, d, 12);
        const text = `${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
        setRaw(p.id, text);
        const found = mine(getBirthdays(env.db, env.workspaceId, start), prefix);
        const expected = back >= 0 && back <= 7;
        expect(found.length, `${zone} start ${start.toDateString()} target ${text}`).toBe(expected ? 1 : 0);
        if (expected) expect(found[0]!.date).toBe(`${target.getFullYear()}-${text}`);
      }
    }
  });
  it('KILLS: near midnight local time still uses the local calendar date', () => {
    process.env.TZ = 'America/New_York';
    const p = person('Late');
    setRaw(p.id, '06-10');
    expect(mine(getBirthdays(env.db, env.workspaceId, new Date(2026, 5, 10, 23, 59, 59)), 'Late')).toHaveLength(1);
    expect(mine(getBirthdays(env.db, env.workspaceId, new Date(2026, 5, 11, 0, 0, 1)), 'Late')).toHaveLength(0);
  });
  it('KILLS: born Dec 31 and Jan 1 across the year wrap get turns for the year of the occurrence', () => {
    const a = person('WrapA');
    const b = person('WrapB');
    setRaw(a.id, '1999-12-31');
    setRaw(b.id, '1999-01-01');
    const found = getBirthdays(env.db, env.workspaceId, at(2026, 12, 28));
    expect(mine(found, 'WrapA')).toEqual([{ personId: a.id, name: 'WrapA Probe', date: '2026-12-31', turns: 27 }]);
    expect(mine(found, 'WrapB')).toEqual([{ personId: b.id, name: 'WrapB Probe', date: '2027-01-01', turns: 28 }]);
    // Starting on Jan 1 itself, WrapA (Dec 31) is yesterday and out.
    expect(mine(getBirthdays(env.db, env.workspaceId, at(2027, 1, 1)), 'WrapA')).toEqual([]);
  });
  it('KILLS: Feb 29 both directions, with a year and without, around leap and non leap Februaries', () => {
    const y = person('LpY');
    const m = person('LpM');
    setRaw(y.id, '2004-02-29');
    setRaw(m.id, '02-29');
    const nonLeap = getBirthdays(env.db, env.workspaceId, at(2027, 2, 21));
    expect(mine(nonLeap, 'LpY')).toEqual([{ personId: y.id, name: 'LpY Probe', date: '2027-02-28', turns: 23 }]);
    expect(mine(nonLeap, 'LpM')).toEqual([{ personId: m.id, name: 'LpM Probe', date: '2027-02-28' }]);
    // Window Feb 28 to Mar 7 of a non leap year: they show on day 0 only, not again on Mar 1.
    expect(mine(getBirthdays(env.db, env.workspaceId, at(2027, 2, 28)), 'Lp')).toHaveLength(2);
    expect(mine(getBirthdays(env.db, env.workspaceId, at(2027, 3, 1)), 'Lp')).toHaveLength(0);
    // Leap year: Feb 28 start shows them on Feb 29 (day 1), not on Feb 28.
    const leap = getBirthdays(env.db, env.workspaceId, at(2028, 2, 28));
    expect(mine(leap, 'LpY')).toEqual([{ personId: y.id, name: 'LpY Probe', date: '2028-02-29', turns: 24 }]);
    // A person born in a leap year turns 0 in the birth year: no turns (positive difference only).
    setRaw(y.id, '2028-02-29');
    expect(mine(getBirthdays(env.db, env.workspaceId, at(2028, 2, 28)), 'LpY')[0]).not.toHaveProperty('turns');
  });
  it('KILLS: a Feb 28 person is never duplicated by the Feb 29 alias', () => {
    const p = person('Twin');
    setRaw(p.id, '02-28');
    expect(mine(getBirthdays(env.db, env.workspaceId, at(2027, 2, 25)), 'Twin')).toHaveLength(1);
  });
  it('KILLS: sort is offset, then name, then id, and a person appears at most once', () => {
    const b = person('SortB');
    const a = person('SortA');
    setRaw(b.id, '08-02');
    setRaw(a.id, '08-02');
    const c = person('SortC');
    setRaw(c.id, '08-01');
    const found = mine(getBirthdays(env.db, env.workspaceId, at(2026, 8, 1)), 'Sort');
    expect(found.map((item) => item.name)).toEqual(['SortC Probe', 'SortA Probe', 'SortB Probe']);
  });
});

describe('proposal path and agent reads', () => {
  it('KILLS: junk proposal is valid:false and never applies; a valid one applies with no claim', () => {
    const p = person('Prop');
    const bad = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: p.id, fields: { birthday: '2023-02-29' } }] });
    expect(bad.valid).toBe(false);
    expect(bad.changes[0]!.errors.join(' ')).toContain('MM-DD');
    expect(() =>
      applyChanges(env.ctx, { proposalHash: bad.proposalHash, changes: bad.changes.map(({ entityType, id, expectedVersion, fields }) => ({ entityType, id, expectedVersion, fields })) }),
    ).toThrow();
    const good = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: p.id, fields: { birthday: ' 12-25 ' } }] });
    expect(good.valid).toBe(true);
    applyChanges(env.ctx, { proposalHash: good.proposalHash, changes: good.changes.map(({ entityType, id, expectedVersion, fields }) => ({ entityType, id, expectedVersion, fields })) });
    expect(getPersonDetail(env.db, env.workspaceId, p.id).birthday).toBe('12-25');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ?').get(p.id)).toEqual({ n: 0 });
  });
  it('KILLS: birthday is in the forModel read and the chat get_record tool', () => {
    const p = person('Read');
    updatePerson(env.ctx, p.id, { expectedVersion: 1, fields: { birthday: '1986-11-12' } });
    expect(getPersonDetail(env.db, env.workspaceId, p.id, { forModel: true }).birthday).toBe('1986-11-12');
    const chat = runChatTool(env.ctx, { id: 'r', name: 'get_record', input: { entityType: 'person', entityId: p.id } });
    expect(chat.content).toContain('1986-11-12');
  });
});

describe('performance posture', () => {
  it('ACCEPTED: one SELECT per call, bucketed by MM-DD; 5000 people sharing one day stay fast (the per bucket array spread is quadratic but bounded by people on one day)', () => {
    const insert = env.db.prepare('INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, tags, updated_at, birthday) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)');
    env.db.transaction(() => {
      for (let i = 0; i < 5000; i += 1) insert.run(`per_bulk${i}`, '2026-01-01', env.workspaceId, `Bulk${String(i).padStart(4, '0')}`, 'X', '[]', '2026-01-01', '05-05');
    })();
    const started = performance.now();
    const found = mine(getBirthdays(env.db, env.workspaceId, at(2026, 5, 5)), 'Bulk');
    expect(found).toHaveLength(5000);
    expect(performance.now() - started).toBeLessThan(3000);
    // Unbounded list: the Today card renders every one of them (no cap). Fix if it matters: slice to a limit with a count.
  });
});
