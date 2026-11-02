import { afterAll, describe, expect, it } from 'vitest';
import { seedDatabase } from '../src/seed/seed.js';
import { createTestEnvironment } from './helpers.js';

const anchor = new Date('2026-03-01T12:00:00.000Z');
const first = createTestEnvironment();
const second = createTestEnvironment();
afterAll(() => {
  first.cleanup();
  second.cleanup();
});

function dump(env: typeof first): string {
  const tables = ['workspace', 'organization', 'person', 'opportunity', 'task', 'activity', 'field_claim', 'run', 'run_step', 'approval', 'stage_event'];
  return tables
    .map((table) => JSON.stringify(env.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()))
    .join('\n');
}

describe('seed', () => {
  it('fills the documented volumes', () => {
    const counts = seedDatabase(first.db, { now: anchor });
    expect(counts.people).toBe(60);
    expect(counts.organizations).toBe(30);
    expect(counts.opportunities).toBe(25);
    const tasks = first.db.prepare('SELECT COUNT(*) AS n FROM task').get() as { n: number };
    expect(tasks.n).toBe(15);
    const runs = first.db.prepare('SELECT status FROM run').all() as { status: string }[];
    expect(runs.map((run) => run.status)).toEqual(['succeeded']);
    const statuses = (first.db.prepare('SELECT DISTINCT status FROM field_claim').all() as { status: string }[]).map((row) => row.status).sort();
    expect(statuses).toEqual(['corroborated', 'extracted', 'human_confirmed', 'imported']);
    const stages = (first.db.prepare('SELECT COUNT(DISTINCT stage_id) AS n FROM opportunity').get() as { n: number }).n;
    expect(stages).toBe(7);
  });

  it('is deterministic for the same date', () => {
    seedDatabase(second.db, { now: anchor });
    expect(dump(second)).toBe(dump(first));
  });

  it('refuses to seed twice and replaces data with reset', () => {
    expect(() => seedDatabase(first.db, { now: anchor })).toThrow(/--reset/);
    const counts = seedDatabase(first.db, { now: anchor, reset: true });
    expect(counts.people).toBe(60);
    expect(dump(first)).toBe(dump(second));
  });

  it('uses only example domains for web addresses and emails', () => {
    const emails = first.db.prepare("SELECT email FROM person WHERE email IS NOT NULL").all() as { email: string }[];
    expect(emails.every((row) => /@[a-z0-9.-]*example\.(com|org)$/.test(row.email))).toBe(true);
    const urls = first.db.prepare('SELECT source_url FROM field_claim WHERE source_url IS NOT NULL').all() as { source_url: string }[];
    expect(urls.every((row) => /^https:\/\/example\.(com|org)\//.test(row.source_url))).toBe(true);
  });
});
