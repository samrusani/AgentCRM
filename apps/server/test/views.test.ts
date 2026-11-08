import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyChanges, createContext, createView, deleteView, proposeChanges, updateView, withActor } from '../src/actions/index.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { packageRoot } from '../src/paths.js';
import { getView, listViews } from '../src/queries/views.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
const events: DomainEvent[] = [];
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  env.bus.subscribe((event) => events.push(event));
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await app.inject({ method, url, headers: { ...host, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: response.statusCode, body: response.body ? (response.json() as Record<string, any>) : {} };
}

function rejected(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('Expected the call to be refused.');
}

const audits = (action: string) =>
  (env.db.prepare('SELECT entity_id AS entityId, detail FROM audit_event WHERE action = ? ORDER BY rowid').all(action) as { entityId: string; detail: string }[]).map((row) => ({
    entityId: row.entityId,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
  }));

describe('view CRUD', () => {
  it('creates a view per screen, lists oldest first per screen, renames, replaces config, and deletes with audits and events', () => {
    const people = createView(env.ctx, { name: '  UK angels  ', screen: 'leads', config: { tab: 'people', q: 'fund', list: 'lst_gone', sort: 'fit' } });
    expect(people).toMatchObject({ name: 'UK angels', screen: 'leads', version: 1, config: { tab: 'people', q: 'fund', list: 'lst_gone', sort: 'fit' } });
    expect(people.id).toMatch(/^svw_/);
    const rel = createView(env.ctx, { name: 'Orgs', screen: 'relationships', config: { tab: 'organizations', q: '' } });
    const pipe = createView(env.ctx, { name: 'Open UK', screen: 'pipeline', config: { pipeline: 'pln_missing', status: 'all', view: 'table' } });
    const second = createView(env.ctx, { name: 'Second leads view', screen: 'leads', config: {} });
    expect(listViews(env.db, env.workspaceId, 'leads').map((item) => item.id)).toEqual([people.id, second.id]);
    expect(listViews(env.db, env.workspaceId, 'relationships').map((item) => item.id)).toEqual([rel.id]);
    expect(listViews(env.db, env.workspaceId, 'pipeline').map((item) => item.id)).toEqual([pipe.id]);

    const renamed = updateView(env.ctx, people.id, { expectedVersion: 1, fields: { name: 'Renamed' } });
    expect(renamed).toMatchObject({ name: 'Renamed', version: 2, config: people.config });
    const reconfigured = updateView(env.ctx, people.id, { expectedVersion: 2, fields: { config: { tab: 'organizations' } } });
    expect(reconfigured).toMatchObject({ version: 3, config: { tab: 'organizations' } });
    expect(rejected(() => updateView(env.ctx, people.id, { expectedVersion: 1, fields: { name: 'Stale' } })).code).toBe('version_conflict');

    deleteView(env.ctx, second.id);
    expect(getView(env.db, env.workspaceId, second.id)).toBeNull();
    expect(rejected(() => deleteView(env.ctx, second.id)).code).toBe('not_found');

    expect(audits('view.create').map((entry) => entry.entityId)).toEqual(expect.arrayContaining([people.id, rel.id, pipe.id, second.id]));
    expect(audits('view.update').filter((entry) => entry.entityId === people.id)).toHaveLength(2);
    expect(audits('view.delete').at(-1)).toMatchObject({ entityId: second.id });
    expect(events.some((event) => event.type === 'record_updated' && event.entityType === 'view' && event.entityId === people.id)).toBe(true);
    for (const id of [people.id, rel.id, pipe.id]) deleteView(env.ctx, id);
  });

  it('accepts dangling list and pipeline ids without checking they exist', () => {
    const a = createView(env.ctx, { name: 'Dangling list', screen: 'relationships', config: { list: 'lst_does_not_exist' } });
    const b = createView(env.ctx, { name: 'Dangling pipeline', screen: 'pipeline', config: { pipeline: 'pln_does_not_exist' } });
    expect(a.config).toEqual({ list: 'lst_does_not_exist' });
    expect(b.config).toEqual({ pipeline: 'pln_does_not_exist' });
    deleteView(env.ctx, a.id);
    deleteView(env.ctx, b.id);
  });

  it('refuses unknown keys, cross screen keys, bad enums, and bad values, on create and on update', () => {
    const bad: Array<[string, unknown]> = [
      ['leads', { extra: 'x' }],
      ['leads', { pipeline: 'pln_1' }],
      ['leads', { status: 'open' }],
      ['leads', { view: 'board' }],
      ['relationships', { tab: 'deals' }],
      ['relationships', { sort: 'name' }],
      ['relationships', { q: 'x'.repeat(257) }],
      ['relationships', { q: 5 }],
      ['relationships', { list: '' }],
      ['relationships', { list: 'x'.repeat(65) }],
      ['relationships', { list: { $ne: 1 } }],
      ['pipeline', { tab: 'people' }],
      ['pipeline', { q: 'x' }],
      ['pipeline', { sort: 'fit' }],
      ['pipeline', { status: 'won' }],
      ['pipeline', { view: 'kanban' }],
      ['pipeline', { pipeline: '' }],
      ['pipeline', 'not an object'],
      ['pipeline', null],
      ['pipeline', [['view', 'board']]],
      ['nowhere', {}],
    ];
    for (const [screen, config] of bad) {
      expect(rejected(() => createView(env.ctx, { name: 'Bad', screen, config })).code).toBe('validation');
    }
    expect(createView(env.ctx, { name: 'Edge', screen: 'leads', config: { q: 'x'.repeat(256) } }).config.q).toHaveLength(256);
    const keep = createView(env.ctx, { name: 'Keep', screen: 'pipeline', config: { view: 'table' } });
    expect(rejected(() => updateView(env.ctx, keep.id, { expectedVersion: 1, fields: { config: { tab: 'people' } } })).code).toBe('validation');
    expect(rejected(() => updateView(env.ctx, keep.id, { expectedVersion: 1, fields: { config: { view: 'board', extra: 1 } } })).code).toBe('validation');
    expect(rejected(() => updateView(env.ctx, keep.id, { expectedVersion: 1, fields: { screen: 'leads' } })).code).toBe('validation');
    expect(getView(env.db, env.workspaceId, keep.id)).toMatchObject({ version: 1, config: { view: 'table' } });
    for (const view of listViews(env.db, env.workspaceId, 'leads')) deleteView(env.ctx, view.id);
    deleteView(env.ctx, keep.id);
  });

  it('refuses empty, over long, and control character names, extra fields, and an empty edit', () => {
    for (const name of ['', '   ', 'x'.repeat(201), 'bad\u0000name', 'tab\tname', 'line\nbreak', 'del\u007fname']) {
      expect(rejected(() => createView(env.ctx, { name, screen: 'leads', config: {} })).code).toBe('validation');
    }
    expect(rejected(() => createView(env.ctx, { name: 'Extra', screen: 'leads', config: {}, id: 'svw_x' })).code).toBe('validation');
    expect(rejected(() => createView(env.ctx, { name: 'No config', screen: 'leads' })).code).toBe('validation');
    const keep = createView(env.ctx, { name: 'x'.repeat(200), screen: 'leads', config: {} });
    expect(keep.name).toHaveLength(200);
    expect(rejected(() => updateView(env.ctx, keep.id, { expectedVersion: 1, fields: { name: 'a\u0007b' } })).code).toBe('validation');
    expect(rejected(() => updateView(env.ctx, keep.id, { expectedVersion: 1, fields: {} })).code).toBe('validation');
    expect(rejected(() => updateView(env.ctx, keep.id, { expectedVersion: 1, fields: { name: 'K', extra: 1 } })).code).toBe('validation');
    deleteView(env.ctx, keep.id);
  });

  it('re-filters a stored config against the whitelist at read time', () => {
    const view = createView(env.ctx, { name: 'Planted', screen: 'relationships', config: { q: 'ok' } });
    const plant = (config: string) => env.db.prepare('UPDATE saved_view SET config = ? WHERE id = ?').run(config, view.id);
    plant(JSON.stringify({ tab: 'organizations', q: 'ok', status: 'open', sort: 'name', list: '', evil: '<script>', constructor: 'x', __proto__: 'y', extra: { a: 1 } }));
    expect(getView(env.db, env.workspaceId, view.id)!.config).toEqual({ tab: 'organizations', q: 'ok' });
    plant(JSON.stringify({ q: 'x'.repeat(300), sort: 'fit' }));
    expect(getView(env.db, env.workspaceId, view.id)!.config).toEqual({ sort: 'fit' });
    plant('{not json');
    expect(getView(env.db, env.workspaceId, view.id)!.config).toEqual({});
    plant('[1,2]');
    expect(getView(env.db, env.workspaceId, view.id)!.config).toEqual({});
    plant('null');
    expect(listViews(env.db, env.workspaceId, 'relationships').find((item) => item.id === view.id)!.config).toEqual({});
    env.db.prepare("UPDATE saved_view SET screen = 'pipeline', config = ? WHERE id = ?").run(JSON.stringify({ pipeline: 'pln_1', tab: 'people', view: 'table', status: 'bogus' }), view.id);
    expect(getView(env.db, env.workspaceId, view.id)!.config).toEqual({ pipeline: 'pln_1', view: 'table' });
    deleteView(env.ctx, view.id);
  });

  it('is isolated by workspace', () => {
    env.db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_view2', '2026-03-02T00:00:00.000Z', 'Other', 'startup-fundraising');
    const other = createContext(env.db, 'wsp_view2', { bus: env.bus, now: env.ctx.now });
    const theirs = createView(other, { name: 'Theirs', screen: 'leads', config: {} });
    const mine = createView(env.ctx, { name: 'Mine', screen: 'leads', config: {} });
    expect(listViews(env.db, env.workspaceId, 'leads').some((item) => item.id === theirs.id)).toBe(false);
    expect(listViews(env.db, 'wsp_view2', 'leads').map((item) => item.id)).toEqual([theirs.id]);
    expect(rejected(() => updateView(env.ctx, theirs.id, { expectedVersion: 1, fields: { name: 'Hijack' } })).code).toBe('not_found');
    expect(rejected(() => deleteView(env.ctx, theirs.id)).code).toBe('not_found');
    expect(getView(env.db, 'wsp_view2', theirs.id)!.name).toBe('Theirs');
    deleteView(env.ctx, mine.id);
    deleteView(other, theirs.id);
  });
});

describe('http', () => {
  it('serves the four endpoints with a 204 delete and a validated screen filter', async () => {
    const created = await call('POST', '/api/views', { name: 'Http', screen: 'pipeline', config: { view: 'table' } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Http', screen: 'pipeline', version: 1, config: { view: 'table' } });
    expect((await call('POST', '/api/views', { name: 'Http', screen: 'pipeline', config: { tab: 'people' } })).status).toBe(400);
    const listed = await call('GET', '/api/views?screen=pipeline');
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((item: any) => item.id)).toContain(created.body.id);
    expect(listed.body.nextCursor).toBeNull();
    expect((await call('GET', '/api/views?screen=leads')).body.items.some((item: any) => item.id === created.body.id)).toBe(false);
    for (const url of ['/api/views', '/api/views?screen=', '/api/views?screen=today', '/api/views?screen=leads&screen=pipeline', '/api/views?screen=leads&x=1']) {
      expect((await call('GET', url)).status).toBe(400);
    }
    const patched = await call('PATCH', `/api/views/${created.body.id}`, { expectedVersion: 1, fields: { name: 'Http 2' } });
    expect(patched.body).toMatchObject({ name: 'Http 2', version: 2 });
    expect((await call('PATCH', `/api/views/${created.body.id}`, { expectedVersion: 1, fields: { name: 'Stale' } })).status).toBe(409);
    expect((await call('PATCH', '/api/views/svw_nope', { expectedVersion: 1, fields: { name: 'X' } })).status).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/views/${created.body.id}`, headers: host })).statusCode).toBe(204);
    expect((await call('DELETE', `/api/views/${created.body.id}`)).status).toBe(404);
  });

  it('refuses a cross-site origin like other settings writes', async () => {
    const response = await call('POST', '/api/views', { name: 'Evil', screen: 'leads', config: {} }, { origin: 'https://evil.example' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(listViews(env.db, env.workspaceId, 'leads').some((item) => item.name === 'Evil')).toBe(false);
  });
});

describe('agent surfaces stay closed', () => {
  it('has no view entity type for proposals and no MCP, model facing, or CLI mention', () => {
    const agent = withActor(env.ctx, 'agent:probe');
    const saved = createView(env.ctx, { name: 'Closed', screen: 'leads', config: {} });
    for (const run of [
      () => proposeChanges(agent, { changes: [{ entityType: 'view', id: saved.id, fields: { name: 'Hacked' } }] }),
      () => applyChanges(agent, { proposalHash: 'a'.repeat(64), changes: [{ entityType: 'view', id: saved.id, expectedVersion: 1, fields: { name: 'Hacked' } }] }),
    ]) {
      expect(rejected(run).code).toBe('validation');
    }
    expect(getView(env.db, env.workspaceId, saved.id)!.name).toBe('Closed');
    for (const file of ['src/mcp/server.ts', 'src/agent/modelChat.ts', 'src/agent/message.ts', 'src/cli.ts']) {
      expect(readFileSync(path.join(packageRoot, file), 'utf8').toLowerCase()).not.toMatch(/saved_view|svw|createview|listviews/);
    }
    deleteView(env.ctx, saved.id);
  });
});
