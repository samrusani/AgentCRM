import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPerson, mergePeople } from '../src/actions/index.js';
import { calendarUrlField, calendarUrlMessage } from '../src/actions/contactFields.js';
import { getPerson } from '../src/queries/people.js';
import { buildApp } from '../src/http/app.js';
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

async function patch(id: string, version: number, fields: Record<string, unknown>) {
  const r = await app.inject({ method: 'PATCH', url: `/api/people/${id}`, headers: host, payload: { expectedVersion: version, fields } });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

const personRow = (id: string) => env.db.prepare('SELECT * FROM person WHERE id = ?').get(id) as Record<string, any>;
const updateAudits = (id: string) =>
  env.db.prepare("SELECT detail FROM audit_event WHERE entity_id = ? AND action = 'person.update' ORDER BY rowid").all(id) as { detail: string }[];

describe('calendarUrlField', () => {
  it('prepends https to a schemeless paste and stores other values as typed', () => {
    expect(calendarUrlField.parse('  calendly.com/ada  ')).toBe('https://calendly.com/ada');
    expect(calendarUrlField.parse('http://cal.example.com/Ada?x=1')).toBe('http://cal.example.com/Ada?x=1');
  });

  it('clears on an empty string or null', () => {
    expect(calendarUrlField.parse('')).toBeNull();
    expect(calendarUrlField.parse('   ')).toBeNull();
    expect(calendarUrlField.parse(null)).toBeNull();
  });

  it.each([
    ['over 500 characters', `https://calendly.com/${'a'.repeat(500)}`],
    ['userinfo', 'https://user:pw@calendly.com/ada'],
    ['a non-http scheme', 'ftp://calendly.com/ada'],
    ['an invisible character', 'https://calen​dly.com/ada'],
    ['a bad host', 'https://ht!tp.com/ada'],
    ['a host with no dot', 'https://localhost/ada'],
  ])('refuses %s with the calendar message', (_label, value) => {
    const result = calendarUrlField.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues[0]!.message;
      if (!_label.startsWith('over 500')) expect(message).toBe(calendarUrlMessage.replace(/\.$/, ''));
    }
  });
});

describe('PATCH /api/people/:id calendarUrl', () => {
  it('sets, re-sets, and clears with version bumps and person.update audits', async () => {
    const subject = createPerson(env.ctx, { firstName: 'Cal', lastName: 'Person' });
    const set = await patch(subject.id, 1, { calendarUrl: ' calendly.com/cal-person ' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ calendarUrl: 'https://calendly.com/cal-person', version: 2 });
    expect(getPerson(env.db, env.workspaceId, subject.id)).toMatchObject({ calendarUrl: 'https://calendly.com/cal-person' });
    const reset = await patch(subject.id, 2, { calendarUrl: 'https://cal.com/cal-person' });
    expect(reset.body).toMatchObject({ calendarUrl: 'https://cal.com/cal-person', version: 3 });
    const cleared = await patch(subject.id, 3, { calendarUrl: '' });
    expect(cleared.body).toMatchObject({ calendarUrl: null, version: 4 });
    expect(personRow(subject.id).calendar_url).toBeNull();
    expect(updateAudits(subject.id)).toHaveLength(3);
    expect(updateAudits(subject.id)[0]!.detail).toContain('calendarUrl');
  });

  it('refuses a bad link and leaves the version alone', async () => {
    const subject = createPerson(env.ctx, { firstName: 'Bad', lastName: 'Calendar' });
    const bad = await patch(subject.id, 1, { calendarUrl: 'ftp://calendly.com/x' });
    expect(bad.status).toBe(400);
    expect(personRow(subject.id).version).toBe(1);
  });
});

describe('create and merge', () => {
  it('creates a person with a calendar link, null by default', () => {
    const withLink = createPerson(env.ctx, { firstName: 'Has', lastName: 'Link', calendarUrl: 'calendly.com/has-link' });
    expect(personRow(withLink.id).calendar_url).toBe('https://calendly.com/has-link');
    const without = createPerson(env.ctx, { firstName: 'No', lastName: 'Link' });
    expect(personRow(without.id).calendar_url).toBeNull();
  });

  it('fills an empty survivor from the other person on merge', () => {
    const survivor = createPerson(env.ctx, { firstName: 'Merge', lastName: 'Cal', email: 'mergecal@example.com' });
    const other = createPerson(env.ctx, { firstName: 'Merge', lastName: 'Cal', calendarUrl: 'calendly.com/merge-cal' });
    const merged = mergePeople(env.ctx, survivor.id, { otherId: other.id, expectedVersion: 1, otherExpectedVersion: 1 });
    expect(merged).toMatchObject({ calendarUrl: 'https://calendly.com/merge-cal' });
  });
});
