import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import type { DomainEvent } from '../src/events.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let token: string;
const host = { host: 'localhost:4720' };

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
  const response = await app.inject({ method: 'POST', url: '/api/capture/token', headers: host });
  token = response.json().token as string;
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

async function call(url: string, payload: unknown, authorization: string | null = `Bearer ${token}`) {
  const headers: Record<string, string> = { ...host };
  if (authorization !== null) headers.authorization = authorization;
  const response = await app.inject({ method: 'POST', url, headers, payload: payload as object });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

const capture = (payload: unknown) => call('/api/capture', payload);
const note = (payload: unknown, authorization?: string | null) => call('/api/capture/note', payload, authorization);

const count = (sql: string, ...params: unknown[]): number => Number((env.db.prepare(sql).get(...params) as { n: number }).n);
const noteBodies = (id: string): string[] =>
  (env.db.prepare("SELECT body FROM activity WHERE entity_id = ? AND kind = 'note' ORDER BY created_at, id").all(id) as { body: string }[]).map((row) => row.body);

describe('capture note', () => {
  let adaId: string;
  let jackId: string;
  beforeAll(async () => {
    const ada = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/ada-note', name: 'Ada Note', email: 'ada@example.com' });
    adaId = ada.body.person.id;
    const jack = await capture({ source: 'x', url: 'https://x.com/JackNote', name: 'Jack Note' });
    jackId = jack.body.person.id;
  });

  it('appends a note, answers 201 with only the name, audits the length, and emits a record frame', async () => {
    const events: DomainEvent[] = [];
    const unsubscribe = env.bus.subscribe((event) => events.push(event));
    const before = noteBodies(adaId).length;
    const { status, body } = await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/ada-note/?utm=1', note: '  Met at the summit.  ' });
    unsubscribe();
    expect(status).toBe(201);
    expect(body).toEqual({ ok: true, person: { name: 'Ada Note' } });
    expect(noteBodies(adaId)).toHaveLength(before + 1);
    expect(noteBodies(adaId).at(-1)).toBe('Met at the summit.');
    expect(events).toContainEqual({ type: 'record_updated', entityType: 'person', entityId: adaId });
    const audit = env.db
      .prepare("SELECT * FROM audit_event WHERE action = 'capture.note' AND entity_id = ?")
      .all(adaId) as Record<string, unknown>[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(String(audit[0]!.detail))).toEqual({ length: 18 });
    const text = JSON.stringify(audit[0]);
    expect(text).not.toContain('Met at the summit');
  });

  it('resolves an x handle case-insensitively', async () => {
    const { status, body } = await note({ source: 'x', url: 'https://mobile.twitter.com/jACKnote/status/1', note: 'Follow up.' });
    expect(status).toBe(201);
    expect(body.person.name).toBe('Jack Note');
    expect(noteBodies(jackId)).toContain('Follow up.');
  });

  it('does not resolve by email: only the profile columns match', async () => {
    const { status, body } = await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/someone-else', note: 'Hi' });
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });

  it('answers 404 with the capture-first sentence when no one matches', async () => {
    const before = count('SELECT COUNT(*) AS n FROM activity');
    const { status, body } = await note({ source: 'x', url: 'https://x.com/nobody_here', note: 'Hi' });
    expect(status).toBe(404);
    expect(body.error.message).toBe('No one in the CRM matches this profile. Capture it first.');
    expect(count('SELECT COUNT(*) AS n FROM activity')).toBe(before);
  });

  it('answers 401 with no token or a wrong token, writing nothing', async () => {
    const before = count('SELECT COUNT(*) AS n FROM activity');
    const payload = { source: 'linkedin', url: 'https://www.linkedin.com/in/ada-note', note: 'Nope' };
    const missing = await note(payload, null);
    const wrong = await note(payload, 'Bearer cap_wrong');
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('unauthorized');
    expect(count('SELECT COUNT(*) AS n FROM activity')).toBe(before);
  });

  const url = 'https://www.linkedin.com/in/ada-note';
  const invalid: Array<[string, unknown]> = [
    ['a url that is not a profile', { source: 'linkedin', url: 'https://www.linkedin.com/company/acme', note: 'Hi' }],
    ['an x reserved path', { source: 'x', url: 'https://x.com/home', note: 'Hi' }],
    ['an empty note', { source: 'linkedin', url, note: '' }],
    ['a whitespace note', { source: 'linkedin', url, note: ' \n\t ' }],
    ['a note over 2000 characters', { source: 'linkedin', url, note: 'a'.repeat(2001) }],
    ['a note of only zero width and control characters', { source: 'linkedin', url, note: '​\u0000‮\u0007﻿' }],
    ['an unknown key', { source: 'linkedin', url, note: 'Hi', personId: 'x' }],
    ['a missing note', { source: 'linkedin', url }],
  ];
  it.each(invalid)('rejects %s with validation', async (_name, payload) => {
    const before = count('SELECT COUNT(*) AS n FROM activity');
    const { status, body } = await note(payload);
    expect(status).toBe(400);
    expect(body.error.code).toBe('validation');
    expect(count('SELECT COUNT(*) AS n FROM activity')).toBe(before);
  });

  it('accepts exactly 2000 characters', async () => {
    const { status } = await note({ source: 'linkedin', url, note: 'a'.repeat(2000) });
    expect(status).toBe(201);
  });

  it('strips control and invisible characters but keeps line breaks', async () => {
    const { status } = await note({ source: 'x', url: 'https://x.com/JackNote', note: 'one\u0000​\r\ntwo‮\u0007\n\nthree' });
    expect(status).toBe(201);
    expect(noteBodies(jackId).at(-1)).toBe('one\ntwo\n\nthree');
  });
});
