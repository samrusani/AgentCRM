import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { processJobs } from '../src/jobs/worker.js';
import { seedDatabase } from '../src/seed/seed.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;

beforeAll(async () => {
  seedDatabase(env.db, { now: new Date('2026-03-01T12:00:00.000Z') });
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

async function get(url: string) {
  const response = await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4720' } });
  return { status: response.statusCode, body: response.json() };
}

async function send(method: 'POST' | 'PATCH', url: string, payload: unknown) {
  const response = await app.inject({ method, url, payload: payload as object, headers: { host: '127.0.0.1:4720' } });
  return { status: response.statusCode, body: response.json() };
}

describe('basic endpoints', () => {
  it('reports health without an absolute path', async () => {
    const { status, body } = await get('/api/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.dbPath).not.toContain('/');
  });

  it('returns the workspace and the today summary', async () => {
    // Contract change: /api/workspace is { id, name, version }; the template lives on each pipeline.
    expect(Object.keys((await get('/api/workspace')).body).sort()).toEqual(['id', 'name', 'version']);
    const today = (await get('/api/today')).body;
    expect(Array.isArray(today.tasksDue)).toBe(true);
    expect(today.counts.people).toBe(60);
    expect(today.tasksDue.length).toBeGreaterThan(0);
  });

  it('lists pipelines with ordered stages', async () => {
    const { body } = await get('/api/pipelines');
    expect(body.items[0].stages.map((stage: { name: string }) => stage.name)).toEqual([
      'Research',
      'Qualified',
      'Introduction or outreach',
      'Meeting',
      'Diligence',
      'Commitment',
      'Closed',
    ]);
  });

  it('returns the error envelope for unknown routes, ids, and bad input', async () => {
    expect((await get('/api/nope')).body.error.code).toBe('not_found');
    expect((await get('/api/people/per_000000000000')).status).toBe(404);
    const invalid = await send('POST', '/api/people', { firstName: '' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('validation');
    expect((await get('/api/tasks?filter=bogus')).status).toBe(400);
  });

  it('refuses requests with a non loopback host name', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example.com' } });
    expect(response.statusCode).toBe(403);
  });

  it('matches the host header exactly', async () => {
    const hostStatus = async (host: string) =>
      (await app.inject({ method: 'GET', url: '/api/health', headers: { host } })).statusCode;
    for (const host of ['127.0.0.1', 'localhost', '[::1]', '127.0.0.1:4720', 'localhost:5173', '[::1]:80']) {
      expect(await hostStatus(host)).toBe(200);
    }
    for (const host of ['127.0.0.1:@evil.com', '127.0.0.1:', '127.0.0.1:123456', 'localhost:abc', 'localhost.evil.com', '[::1]x']) {
      expect(await hostStatus(host)).toBe(403);
    }
  });
});

describe('http errors and pagination', () => {
  it('returns 409 version_conflict with the current record', async () => {
    const list = (await get('/api/people?limit=1')).body;
    const person = list.items[0];
    const first = await send('PATCH', `/api/people/${person.id}`, { expectedVersion: 1, fields: { title: 'Partner' } });
    expect(first.status).toBe(200);
    const stale = await send('PATCH', `/api/people/${person.id}`, { expectedVersion: 1, fields: { title: 'Principal' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.error.current.version).toBe(2);
  });

  it('pages through every person with cursors', async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const url: string = `/api/people?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { body } = await get(url);
      ids.push(...body.items.map((item: { id: string }) => item.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    expect((await get('/api/people?cursor=bogus')).status).toBe(400);
  });

  it('searches by name, email, and organization', async () => {
    const { body } = await get('/api/search?q=lanternrow');
    expect(body.organizations.length).toBeGreaterThan(0);
    expect(body.people.length).toBeGreaterThan(0);
    expect((await get('/api/people?q=lanternrow')).body.items.length).toBeGreaterThan(0);
    expect((await get('/api/organizations?q=example.org')).body.items.length).toBeGreaterThan(0);
  });

  it('returns detail payloads with evidence', async () => {
    const person = (await get('/api/people?limit=1')).body.items[0];
    const detail = (await get(`/api/people/${person.id}`)).body;
    expect(detail.claims.length).toBeGreaterThan(0);
    expect(typeof detail.affiliationsSummary).toBe('string');
    expect(detail).toHaveProperty('organization');
    const organization = (await get(`/api/organizations/${person.organizationId}`)).body;
    expect(organization.people.length).toBeGreaterThan(0);
    const opportunities = (await get('/api/opportunities?status=open&limit=200')).body.items;
    expect(opportunities.length).toBeGreaterThan(10);
    const first = (await get(`/api/opportunities/${opportunities[0].id}`)).body;
    expect(first.stageEvents.length).toBeGreaterThan(0);
  });

  it('moves a stage with a version check', async () => {
    const pipelines = (await get('/api/pipelines')).body.items[0];
    const opportunity = (await get('/api/opportunities?stageId=' + pipelines.stages[0].id)).body.items[0];
    const target = pipelines.stages[1].id;
    const moved = await send('POST', `/api/opportunities/${opportunity.id}/stage`, { stageId: target, expectedVersion: opportunity.version });
    expect(moved.status).toBe(200);
    expect(moved.body.stageId).toBe(target);
    const stale = await send('POST', `/api/opportunities/${opportunity.id}/stage`, { stageId: pipelines.stages[2].id, expectedVersion: opportunity.version });
    expect(stale.body.error.code).toBe('version_conflict');
    const timeline = (await get(`/api/activities?entityType=opportunity&entityId=${opportunity.id}`)).body.items;
    expect(timeline[0].kind).toBe('stage_change');
  });

  it('posts a note through the route exactly as the web client sends it', async () => {
    const person = (await get('/api/people?limit=1')).body.items[0];
    const created = await send('POST', '/api/activities', {
      entityType: 'person',
      entityId: person.id,
      kind: 'note',
      body: 'Met at the demo day.',
    });
    expect(created.status).toBe(201);
    expect(created.body.kind).toBe('note');
    const withoutKind = await send('POST', '/api/activities', {
      entityType: 'person',
      entityId: person.id,
      body: 'Second note.',
    });
    expect(withoutKind.status).toBe(201);
    const wrongKind = await send('POST', '/api/activities', {
      entityType: 'person',
      entityId: person.id,
      kind: 'email_draft',
      body: 'Not a note.',
    });
    expect(wrongKind.status).toBe(400);
    const timeline = (await get(`/api/activities?entityType=person&entityId=${person.id}`)).body.items;
    expect(timeline.some((item: { body: string }) => item.body === 'Met at the demo day.')).toBe(true);
  });

  it('creates and completes tasks', async () => {
    const created = await send('POST', '/api/tasks', { title: 'Call the team', dueAt: '2026-03-01T15:00:00.000Z' });
    expect(created.status).toBe(201);
    const done = await send('PATCH', `/api/tasks/${created.body.id}`, { expectedVersion: 1, fields: { status: 'done' } });
    expect(done.body.status).toBe('done');
    const doneList = (await get('/api/tasks?filter=done')).body.items;
    expect(doneList.some((task: { id: string }) => task.id === created.body.id)).toBe(true);
  });
});

describe('run cycle over http', () => {
  it('runs a simulated research cycle and finishes after approval', async () => {
    const created = await send('POST', '/api/runs', { kind: 'demo_research', title: 'HTTP cycle' });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('queued');
    const runId = created.body.id as string;

    let status = 'queued';
    for (let tick = 0; tick < 30 && status !== 'waiting_approval'; tick += 1) {
      env.advance(1000);
      processJobs(env.ctx);
      status = (await get(`/api/runs/${runId}`)).body.status;
    }
    expect(status).toBe('waiting_approval');

    const pending = (await get('/api/approvals?status=pending')).body.items;
    const approval = pending.find((item: { runId: string }) => item.runId === runId);
    expect(approval.runTitle).toBe('HTTP cycle');
    const decided = await send('POST', `/api/approvals/${approval.id}/decision`, { decision: 'approve' });
    expect(decided.status).toBe(200);
    expect(decided.body.run.status).toBe('succeeded');
    const repeated = await send('POST', `/api/approvals/${approval.id}/decision`, { decision: 'approve' });
    expect(repeated.status).toBe(200);
    expect(repeated.body.alreadyDecided).toBe(true);
    const opposite = await send('POST', `/api/approvals/${approval.id}/decision`, { decision: 'reject' });
    expect(opposite.status).toBe(409);
    expect((await get(`/api/runs/${runId}`)).body.status).toBe('succeeded');
    expect((await get('/api/runs?status=succeeded')).body.items.length).toBeGreaterThan(1);
  });
});

describe('agent messages', () => {
  it('says plainly that no model is connected and offers the demo run', async () => {
    for (const text of ['hello', 'find investors for my seed round', 'what is the weather']) {
      const { body } = await send('POST', '/api/agent/message', { text });
      expect(body.reply).toContain('No model connected');
      expect(body.actions.some((action: { kind: string }) => action.kind === 'start_demo_run')).toBe(true);
    }
  });

  it('offers the demo run for investor leads and never the Apify setup without explicit wording', async () => {
    for (const text of ['find investor leads', 'find leads for my seed round', 'build a list of leads']) {
      const { body } = await send('POST', '/api/agent/message', { text });
      const kinds = body.actions.map((action: { kind: string }) => action.kind);
      expect(kinds).toContain('start_demo_run');
      expect(kinds).not.toContain('start_apify_import');
    }
  });

  it('searches records for a name that contains the word lead', async () => {
    const created = await send('POST', '/api/organizations', { name: 'Lead Capital' });
    expect(created.status).toBe(201);
    const { body } = await send('POST', '/api/agent/message', { text: 'open Lead Capital' });
    expect(body.actions[0]).toMatchObject({ kind: 'open_record', entityType: 'organization', entityId: created.body.id });
  });

  it('suggests opening a record and answers counts from real data', async () => {
    const person = (await get('/api/people?limit=1')).body.items[0];
    const lookup = await send('POST', '/api/agent/message', { text: `tell me about ${person.name}` });
    expect(lookup.body.actions[0]).toMatchObject({ kind: 'open_record', entityType: 'person', entityId: person.id });
    const total = (await get('/api/today')).body.counts.people;
    const counts = await send('POST', '/api/agent/message', { text: 'how many people do we have?' });
    expect(counts.body.reply).toContain(`${total} people`);
    expect((await send('POST', '/api/agent/message', { text: '' })).status).toBe(400);
  });
});
