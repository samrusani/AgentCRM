// Adversarial review probes for the saved views wave (saved_view, queries/views.ts, actions/views.ts, /api/views).
// KILLS (attack fails, pinned), CONFIRMS (live defect, passes today, comment says the fix), ACCEPTED (documented limit).
// Nothing here changes application code.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createView, updateView, deleteView, proposeChanges } from '../src/actions/index.js';
import { AppError } from '../src/errors.js';
import { buildApp } from '../src/http/app.js';
import { filterConfig, listViews } from '../src/queries/views.js';
import { createTestEnvironment, insertSecondWorkspace } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  env.cleanup();
});

const host = { host: '127.0.0.1:4720' };
const refused = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return true;
  }
};
const make = (screen: string, config: unknown, name = 'v') => createView(env.ctx, { name, screen, config });
const raw = (id: string, config: string) => env.db.prepare('UPDATE saved_view SET config = ? WHERE id = ?').run(config, id);

describe('whitelist at save', () => {
  it.each([
    ['leads', { pipeline: 'x' }],
    ['relationships', { status: 'open' }],
    ['pipeline', { q: 'x' }],
    ['pipeline', { tab: 'people' }],
    ['leads', { q: 'x'.repeat(257) }],
    ['leads', { sort: 'name' }],
    ['pipeline', { view: 'kanban' }],
    ['pipeline', { status: 'won' }],
    ['leads', { tab: 'orgs' }],
    ['leads', { q: { a: 1 } }],
    ['leads', { q: ['a'] }],
    ['leads', { list: '' }],
    ['leads', { list: '   ' }],
    ['leads', { list: 'x'.repeat(65) }],
    ['leads', { q: 5 }],
    ['leads', { q: null }],
    ['leads', { constructor: 'x' }],
    ['leads', { toString: 'x' }],
    ['leads', { open: 'per_1', import: 'csv', person: 'per_1' }],
    ['dashboard', {}],
  ])('KILLS: %s %j is refused', (screen, config) => {
    expect(refused(() => make(screen, config))).toBe(true);
  });
  it('KILLS: an own __proto__ key is dropped by the record parse, so it is saved as an empty config and never stored', () => {
    const view = make('leads', JSON.parse('{"__proto__": {"q": "x"}}'));
    expect(view.config).toEqual({});
    expect(({} as Record<string, unknown>).q).toBeUndefined();
  });
  it('KILLS: a non object config is refused', () => {
    for (const config of [null, [], 'x', 5]) expect(refused(() => make('leads', config))).toBe(true);
  });
  it('KILLS: boundary q of exactly 256 chars is accepted and survives the read re-filter', () => {
    const view = make('leads', { q: 'é'.repeat(256) });
    expect(view.config.q).toHaveLength(256);
  });
  it('KILLS: update re-validates config against the view own screen, not a smuggled one', () => {
    const view = make('pipeline', { view: 'table' });
    expect(refused(() => updateView(env.ctx, view.id, { expectedVersion: 1, fields: { config: { q: 'x' } } }))).toBe(true);
    expect(refused(() => updateView(env.ctx, view.id, { expectedVersion: 1, fields: { screen: 'leads' } }))).toBe(true);
    expect(refused(() => updateView(env.ctx, view.id, { expectedVersion: 1, fields: {} }))).toBe(true);
  });
  it('KILLS: a list id with hostile characters is stored verbatim (data, not code) and trimmed', () => {
    const view = make('leads', { list: '  lst_1&q=x#frag?y=%00\n  ' });
    expect(view.config.list).toBe('lst_1&q=x#frag?y=%00');
  });
});

describe('read-time re-filter', () => {
  it('KILLS: planted junk keys, wrong screen keys, and bad values never leave the read', () => {
    const view = make('leads', { q: 'ok' });
    raw(view.id, JSON.stringify({ q: 'ok', person: 'per_1', import: 'csv', pipeline: 'x', sort: 'name', tab: 'bad', list: 5, nested: { a: 1 }, __proto__x: 1, 'list ': 'x' }));
    const found = listViews(env.db, env.workspaceId, 'leads').find((item) => item.id === view.id)!;
    expect(found.config).toEqual({ q: 'ok' });
  });
  it('KILLS: broken JSON, arrays, null, and primitives read as an empty config', () => {
    const view = make('pipeline', { view: 'board' });
    for (const bad of ['{not json', '[1]', 'null', '"x"', '5', '']) {
      raw(view.id, bad);
      expect(listViews(env.db, env.workspaceId, 'pipeline').find((item) => item.id === view.id)!.config).toEqual({});
    }
  });
  it('KILLS: a planted own __proto__ key does not pollute or survive', () => {
    expect(filterConfig('leads', '{"__proto__": {"q": "x"}, "q": "a"}')).toEqual({ q: 'a' });
    expect(({} as Record<string, unknown>).q).toBeUndefined();
  });
  it('KILLS: the re-filter keeps the trimmed zod output, so a planted padded list id reaches the URL trimmed', () => {
    expect(filterConfig('leads', JSON.stringify({ list: '  x  ' }))).toEqual({ list: 'x' });
  });
  it('ACCEPTED: q is not trimmed server side; a whitespace only q is stored (the web builder trims on save and the screen trims on read)', () => {
    expect(make('leads', { q: '   ' }).config.q).toBe('   ');
  });
  it('ACCEPTED: q may hold control characters (newline, NUL); only names refuse them. The URL builder percent encodes them, so it is inert', () => {
    expect(make('leads', { q: 'a\nb\u0000c' }).config.q).toBe('a\nb\u0000c');
  });
});

describe('names', () => {
  it.each(['\u0000lead', 'a\u0000', 'a\nb', 'tab\there', '\u007f', '\u009f', '   ', ''])('KILLS: name %j refused', (name) => {
    expect(refused(() => make('leads', {}, name))).toBe(true);
  });
  it('KILLS: 200 accepted, 201 refused, trimmed, unicode kept', () => {
    expect(make('leads', {}, 'x'.repeat(200)).name).toHaveLength(200);
    expect(refused(() => make('leads', {}, 'x'.repeat(201)))).toBe(true);
    expect(make('leads', {}, '  Zürich 🇨🇭  ').name).toBe('Zürich 🇨🇭');
  });
  it('ACCEPTED: bidi override and zero width characters (U+202E, U+200B) are allowed in names; they render as text only', () => {
    expect(make('leads', {}, 'a‮b​').name).toBe('a‮b​');
  });
  it('KILLS: rename round trip bumps version once, keeps config, and a stale version conflicts', () => {
    const view = make('leads', { q: 'k' }, 'one');
    const renamed = updateView(env.ctx, view.id, { expectedVersion: 1, fields: { name: 'two' } });
    expect(renamed).toMatchObject({ name: 'two', version: 2, config: { q: 'k' } });
    expect(refused(() => updateView(env.ctx, view.id, { expectedVersion: 1, fields: { name: 'three' } }))).toBe(true);
    expect(listViews(env.db, env.workspaceId, 'leads').find((item) => item.id === view.id)!.name).toBe('two');
  });
});

describe('http', () => {
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload: payload as object, headers: { ...host, ...headers } });

  it('KILLS: screen is required and validated; repeated or extra query keys are refused', async () => {
    for (const url of ['/api/views', '/api/views?screen=', '/api/views?screen=dashboard', '/api/views?screen=leads&screen=pipeline', '/api/views?screen=leads&x=1', '/api/views?screen[]=leads', '/api/views?screen=LEADS'])
      expect((await call('GET', url)).statusCode, url).toBe(400);
    expect((await call('GET', '/api/views?screen=leads')).statusCode).toBe(200);
  });
  it('KILLS: oldest first and screen scoped', async () => {
    const a = make('relationships', {}, 'first');
    const b = make('relationships', {}, 'second');
    make('pipeline', {}, 'elsewhere');
    const body = (await call('GET', '/api/views?screen=relationships')).json() as { items: { id: string; screen: string }[] };
    const ids = body.items.map((item) => item.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    expect(body.items.every((item) => item.screen === 'relationships')).toBe(true);
  });
  it('KILLS: Origin guard refuses writes from a foreign web origin and allows none or loopback', async () => {
    const view = make('leads', {}, 'guard');
    const evil = { origin: 'https://evil.example.com' };
    expect((await call('POST', '/api/views', { name: 'x', screen: 'leads', config: {} }, evil)).statusCode).toBe(403);
    expect((await call('PATCH', `/api/views/${view.id}`, { expectedVersion: 1, fields: { name: 'x' } }, evil)).statusCode).toBe(403);
    expect((await call('DELETE', `/api/views/${view.id}`, undefined, evil)).statusCode).toBe(403);
    expect((await call('POST', '/api/views', { name: 'ok', screen: 'leads', config: {} }, { origin: 'http://127.0.0.1:5173' })).statusCode).toBe(201);
    expect((await call('POST', '/api/views', { name: 'ok', screen: 'leads', config: {} })).statusCode).toBe(201);
  });
  it('KILLS: strict bodies refuse extra keys and unknown config keys over HTTP', async () => {
    expect((await call('POST', '/api/views', { name: 'x', screen: 'leads', config: {}, workspaceId: 'wsp_x' })).statusCode).toBe(400);
    expect((await call('POST', '/api/views', { name: 'x', screen: 'leads', config: { person: 'per_1' } })).statusCode).toBe(400);
    expect((await call('POST', '/api/views', { name: '\u0000x', screen: 'leads', config: {} })).statusCode).toBe(400);
  });
  it('KILLS: workspace isolation for read, rename and delete', async () => {
    const other = insertSecondWorkspace(env.db);
    env.db.prepare("INSERT INTO saved_view (id, created_at, workspace_id, version, name, screen, config, updated_at) VALUES ('svw_foreign', '2026-03-01T00:00:00.000Z', ?, 1, 'foreign', 'leads', '{}', '2026-03-01T00:00:00.000Z')").run(other);
    const listed = (await call('GET', '/api/views?screen=leads')).json() as { items: { id: string }[] };
    expect(listed.items.some((item) => item.id === 'svw_foreign')).toBe(false);
    expect((await call('PATCH', '/api/views/svw_foreign', { expectedVersion: 1, fields: { name: 'mine' } })).statusCode).toBe(404);
    expect((await call('DELETE', '/api/views/svw_foreign')).statusCode).toBe(404);
    expect(env.db.prepare("SELECT name FROM saved_view WHERE id = 'svw_foreign'").get()).toEqual({ name: 'foreign' });
  });
  it('ACCEPTED: delete is not idempotent over HTTP (second delete is 404). The web invalidates the list after the first, so a double click is the only way to see it', async () => {
    const view = make('leads', {}, 'del');
    expect((await call('DELETE', `/api/views/${view.id}`)).statusCode).toBe(204);
    expect((await call('DELETE', `/api/views/${view.id}`)).statusCode).toBe(404);
    expect(refused(() => deleteView(env.ctx, view.id))).toBe(true);
  });
  it('KILLS: a hostile id path is refused as validation, not a SQL error', async () => {
    for (const id of ["x'; DROP TABLE saved_view;--", '%00', 'a'.repeat(300)]) {
      const status = (await call('DELETE', `/api/views/${encodeURIComponent(id)}`)).statusCode;
      expect([400, 404, 414]).toContain(status);
    }
    expect(env.db.prepare('SELECT count(*) AS n FROM saved_view').get()).toBeTruthy();
  });
});

describe('agent surfaces', () => {
  it('KILLS: proposals refuse a view entity', () => {
    const view = make('leads', {}, 'prop');
    for (const entityType of ['view', 'saved_view']) {
      expect(
        refused(() => proposeChanges(env.ctx, { actor: 'agent', summary: 's', changes: [{ entityType, entityId: view.id, fields: { name: 'hijack' } }] })),
        entityType,
      ).toBe(true);
    }
    expect(listViews(env.db, env.workspaceId, 'leads').find((item) => item.id === view.id)!.name).toBe('prop');
  });
});
