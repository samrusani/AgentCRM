import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { processJobs } from '../src/jobs/worker.js';
import { seedDatabase } from '../src/seed/seed.js';
import { createTestEnvironment } from './helpers.js';

// One success case for every route the web client calls, against a temporary database and no live server.
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

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { host: 'localhost:5173' },
  });
  return { status: response.statusCode, body: response.json() };
}

describe('web client contract', () => {
  it('serves every read route the client calls', async () => {
    expect((await call('GET', '/api/workspace')).status).toBe(200);
    const today = await call('GET', '/api/today');
    expect(today.status).toBe(200);
    expect(today.body).toHaveProperty('tasksDue');
    expect(today.body).toHaveProperty('approvalsPending');
    expect(today.body).toHaveProperty('runsActive');
    expect(today.body).toHaveProperty('counts');

    const people = await call('GET', '/api/people?limit=5');
    expect(people.status).toBe(200);
    expect(people.body.items.length).toBeGreaterThan(0);
    const person = people.body.items[0];
    expect((await call('GET', `/api/people/${person.id}`)).body.id).toBe(person.id);

    const organizations = await call('GET', '/api/organizations?limit=5');
    expect(organizations.status).toBe(200);
    const organization = organizations.body.items[0];
    expect((await call('GET', `/api/organizations/${organization.id}`)).body.id).toBe(organization.id);

    const pipelines = await call('GET', '/api/pipelines');
    expect(pipelines.status).toBe(200);
    expect(pipelines.body.items[0].stages.length).toBeGreaterThan(0);

    const opportunities = await call('GET', '/api/opportunities?status=open&limit=5');
    expect(opportunities.status).toBe(200);
    const opportunity = opportunities.body.items[0];
    expect((await call('GET', `/api/opportunities/${opportunity.id}`)).body.id).toBe(opportunity.id);

    expect((await call('GET', '/api/tasks?filter=open')).status).toBe(200);
    const activities = await call('GET', `/api/activities?entityType=person&entityId=${person.id}`);
    expect(activities.status).toBe(200);
    expect(Array.isArray(activities.body.items)).toBe(true);
    expect((await call('GET', '/api/runs')).status).toBe(200);
    expect((await call('GET', '/api/approvals?status=pending')).status).toBe(200);
    expect((await call('GET', '/api/search?q=lanternrow')).body).toHaveProperty('people');

    const message = await call('POST', '/api/agent/message', { text: 'hello' });
    expect(message.status).toBe(200);
    expect(message.body.modelConnected).toBe(false);
    expect(Array.isArray(message.body.actions)).toBe(true);
  });

  it('accepts every write route the client calls', async () => {
    const person = (await call('GET', '/api/people?limit=1')).body.items[0];

    const note = await call('POST', '/api/activities', {
      entityType: 'person',
      entityId: person.id,
      kind: 'note',
      body: 'Contract test note.',
    });
    expect(note.status).toBe(201);
    expect(note.body.kind).toBe('note');

    const task = await call('POST', '/api/tasks', { title: 'Contract test task', dueAt: '2026-03-02T09:00:00.000Z' });
    expect(task.status).toBe(201);

    const patched = await call('PATCH', `/api/people/${person.id}`, {
      expectedVersion: person.version,
      fields: { title: 'Contract tester' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.title).toBe('Contract tester');

    const pipeline = (await call('GET', '/api/pipelines')).body.items[0];
    const opportunity = (await call('GET', `/api/opportunities?stageId=${pipeline.stages[0].id}&limit=1`)).body.items[0];
    const moved = await call('POST', `/api/opportunities/${opportunity.id}/stage`, {
      stageId: pipeline.stages[1].id,
      expectedVersion: opportunity.version,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.stageId).toBe(pipeline.stages[1].id);

    const run = await call('POST', '/api/runs', { kind: 'demo_research', title: 'Contract run' });
    expect(run.status).toBe(201);
    for (let tick = 0; tick < 30; tick += 1) {
      env.advance(1000);
      processJobs(env.ctx);
      if ((await call('GET', `/api/runs/${run.body.id}`)).body.status === 'waiting_approval') break;
    }
    const detail = await call('GET', `/api/runs/${run.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('waiting_approval');

    const approvals = (await call('GET', '/api/approvals?status=pending')).body.items;
    const approval = approvals.find((item: { runId: string }) => item.runId === run.body.id);
    const decided = await call('POST', `/api/approvals/${approval.id}/decision`, { decision: 'approve' });
    expect(decided.status).toBe(200);
    expect(decided.body.run.status).toBe('succeeded');
  });
});
