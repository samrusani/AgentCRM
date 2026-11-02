import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configureApifyConnector,
  controlRun,
  createOrganization,
  createPerson,
  decideApproval,
  recoverStaleJobs,
  startRun,
} from '../src/actions/index.js';
import { mapItem } from '../src/actions/apifyMapping.js';
import { AppError } from '../src/errors.js';
import { buildApp } from '../src/http/app.js';
import { processAllJobs } from '../src/jobs/worker.js';
import { getRunDetail } from '../src/queries/runs.js';
import { type ApifyStub, startApifyStub, stubToken, useStub } from './apifyStub.js';
import { createTestEnvironment, driveRunAsync } from './helpers.js';

const env = createTestEnvironment();
let stub: ApifyStub;
let restore: () => void;
let app: FastifyInstance;
const actorId = 'tester~lead-scraper';

beforeAll(async () => {
  stub = await startApifyStub();
  restore = useStub(stub);
  await configureApifyConnector(env.ctx, { token: stubToken, allowlist: ['tester/lead-scraper'] });
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

beforeEach(() => {
  stub.reset();
});

afterAll(async () => {
  await app.close();
  await stub.close();
  restore();
  env.cleanup();
});

function count(table: string): number {
  return Number((env.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function conflictMessage(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'none';
}

async function getJson(url: string) {
  const response = await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4720' } });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

const leadItems = [
  {
    fullName: 'Ada Quill',
    email: 'Ada.Quill@northwind.example.com',
    company: 'Northwind Labs',
    website: 'https://www.northwind.example.com/about',
    position: 'Partner',
    city: 'Port Alder',
    country: 'Aurelia',
    linkedinUrl: 'https://www.linkedin.com/in/ada-quill',
  },
  {
    firstName: 'Ben',
    lastName: 'Marsh',
    emails: ['ben.marsh@harbor.example.org'],
    organization: 'Harbor Row',
    title: 'Principal',
    profileUrl: 'https://linkedin.com/in/ben-marsh',
  },
  { name: 'Cara Voss', email: 'cara.voss@northwind.example.com', companyName: 'Northwind Labs', domain: 'northwind.example.com' },
  { note: 'nothing that identifies a person' },
  { name: 'Existing Person', email: 'existing.person@example.com' },
  { name: 'Dan Orr', company: 'Existing Org Inc', jobTitle: 'Founder' },
];

describe('apify field mapping', () => {
  it('maps the common lead fields and leaves the rest in raw', () => {
    expect(mapItem(leadItems[0])).toEqual({
      name: 'Ada Quill',
      firstName: 'Ada',
      lastName: 'Quill',
      email: 'ada.quill@northwind.example.com',
      company: 'Northwind Labs',
      domain: 'northwind.example.com',
      title: 'Partner',
      location: 'Port Alder, Aurelia',
      linkedinUrl: 'https://www.linkedin.com/in/ada-quill',
    });
    expect(mapItem(leadItems[1])).toMatchObject({ name: 'Ben Marsh', email: 'ben.marsh@harbor.example.org', company: 'Harbor Row' });
    expect(mapItem({ email: 'not an email' }).email).toBeNull();
    expect(mapItem('text')).toMatchObject({ name: null, email: null });
  });
});

describe('apify_scrape run', () => {
  it('runs the full flow, stages rows, and creates records only after approval', async () => {
    createPerson(env.ctx, { firstName: 'Existing', lastName: 'Person', email: 'existing.person@example.com' });
    createOrganization(env.ctx, { name: 'Existing Org Inc' });
    stub.state.items = leadItems;
    stub.state.runStatuses = ['READY', 'RUNNING', 'RUNNING', 'SUCCEEDED'];
    const peopleBefore = count('person');
    const organizationsBefore = count('organization');

    const queued = startRun(env.ctx, {
      kind: 'apify_scrape',
      title: 'Apify import: Lead scraper',
      scope: { actorId, input: { queries: ['fintech'] }, maxItems: 50 },
    });
    expect(queued.status).toBe('queued');
    expect(queued.title).toBe('Apify import: Lead scraper');
    expect(queued.simulated).toBe(false);
    expect(queued.steps.map((step) => step.title)).toHaveLength(7);

    expect(await driveRunAsync(env, queued.id, ['waiting_approval'])).toBe('waiting_approval');
    const waiting = getRunDetail(env.db, env.workspaceId, queued.id);
    expect(stub.state.startCalls).toBe(1);
    expect(stub.state.startBodies[0]).toEqual({ queries: ['fintech'] });
    expect(stub.state.startQueries[0]).toContain('maxItems=50');
    expect(waiting.scope).toMatchObject({ actorId, maxItems: 50, apifyRunId: 'run_1' });
    expect(waiting.steps.every((step) => step.status === 'done')).toBe(true);
    expect(waiting.steps[2]!.detail).toContain('SUCCEEDED');
    expect(waiting.counts).toMatchObject({ requested: 50, fetched: 6, staged: 4, duplicates: 1, invalid: 1, accepted: 0 });
    expect(count('person')).toBe(peopleBefore);
    expect(count('organization')).toBe(organizationsBefore);

    const approval = waiting.approvals[0]!;
    expect(approval.kind).toBe('import_review');
    const payload = approval.payload as { batchId: string; actorId: string; counts: unknown; sample: { name: string }[] };
    expect(Object.keys(payload).sort()).toEqual(['actorId', 'batchId', 'counts', 'sample']);
    expect(payload.actorId).toBe(actorId);
    expect(payload.counts).toEqual({ fetched: 6, staged: 4, duplicates: 1, invalid: 1 });
    expect(payload.sample.map((row) => row.name)).toEqual(['Ada Quill', 'Ben Marsh', 'Cara Voss', 'Dan Orr']);
    expect(Object.keys(payload.sample[0]!).sort()).toEqual(['company', 'email', 'name']);

    const stepActions = (
      env.db.prepare("SELECT action FROM audit_event WHERE entity_type = 'run' AND entity_id = ?").all(queued.id) as { action: string }[]
    ).map((row) => row.action);
    expect(stepActions.filter((action) => action === 'run.step_start')).toHaveLength(7);
    expect(stepActions).toContain('run.step_progress');

    const decided = decideApproval(env.ctx, approval.id, { decision: 'approve' });
    expect(decided.run.status).toBe('succeeded');
    expect(decided.run.counts).toMatchObject({ requested: 50, fetched: 6, staged: 4, duplicates: 1, invalid: 1, accepted: 4 });
    expect(count('person')).toBe(peopleBefore + 4);
    expect(count('organization')).toBe(organizationsBefore + 2);

    const ada = env.db.prepare("SELECT * FROM person WHERE email = 'ada.quill@northwind.example.com'").get() as Record<string, string>;
    expect(ada).toMatchObject({ first_name: 'Ada', last_name: 'Quill', title: 'Partner', location: 'Port Alder, Aurelia' });
    const northwind = env.db.prepare("SELECT * FROM organization WHERE domain = 'northwind.example.com'").get() as Record<string, string>;
    expect(northwind.name).toBe('Northwind Labs');
    expect(ada.organization_id).toBe(northwind.id);
    const cara = env.db.prepare("SELECT organization_id FROM person WHERE email = 'cara.voss@northwind.example.com'").get() as Record<string, string>;
    expect(cara.organization_id).toBe(northwind.id);
    const existingOrg = env.db.prepare("SELECT id FROM organization WHERE name = 'Existing Org Inc'").get() as { id: string };
    const dan = env.db.prepare("SELECT organization_id FROM person WHERE first_name = 'Dan'").get() as Record<string, string>;
    expect(dan.organization_id).toBe(existingOrg.id);

    const claims = env.db
      .prepare("SELECT * FROM field_claim WHERE source_type = 'apify' AND entity_id = ?")
      .all(ada.id) as Record<string, string>[];
    expect(claims.map((claim) => claim.field).sort()).toEqual(['company', 'email', 'linkedinUrl', 'location', 'name', 'title']);
    for (const claim of claims) {
      expect(claim.source_url).toBe('https://console.apify.com/actors/runs/run_1');
      expect(claim.extraction_method).toBe(actorId);
      expect(claim.status).toBe('imported');
    }
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM field_claim WHERE entity_type = 'organization' AND source_type = 'apify'").get()).toEqual({ n: 3 });

    const batch = (await getJson(`/api/imports/${payload.batchId}`)).body;
    expect(batch.status).toBe('accepted');
    expect(batch.counts).toMatchObject({ fetched: 6, staged: 4, duplicates: 1, invalid: 1, accepted: 4, rejected: 0 });
    const accepted = batch.items.filter((row: { status: string }) => row.status === 'accepted');
    expect(accepted).toHaveLength(4);
    expect(accepted[0].matchEntityType).toBe('person');
    expect(accepted[0].matchEntityId).toBe(ada.id);
  });

  it('marks duplicates and invalid rows with reasons and matched ids', async () => {
    const stone = createOrganization(env.ctx, { name: 'Stoneworks', domain: 'stoneworks.example.com' });
    const eve = createPerson(env.ctx, { firstName: 'Eve', lastName: 'Stone', organizationId: stone.id });
    const known = createPerson(env.ctx, { firstName: 'Kay', lastName: 'Known', email: 'kay.known@example.com' });
    stub.state.items = [
      { name: 'Kay Known', email: 'KAY.KNOWN@example.com' },
      { name: 'Eve  Stone', company: 'Stoneworks', domain: 'stoneworks.example.com' },
      { name: 'Fresh Face', email: 'fresh.face@example.com', company: 'Stoneworks' },
      { name: 'Fresh Twin', email: 'fresh.face@example.com' },
      { company: 'Only a company' },
    ];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const batchId = (getRunDetail(env.db, env.workspaceId, run.id).approvals[0]!.payload as { batchId: string }).batchId;
    const rows = (await getJson(`/api/imports/${batchId}`)).body.items as Record<string, any>[];
    expect(rows.map((row) => row.status)).toEqual(['duplicate', 'duplicate', 'staged', 'duplicate', 'invalid']);
    expect(rows[0]).toMatchObject({ matchEntityType: 'person', matchEntityId: known.id, reason: 'Email matches an existing person.' });
    expect(rows[1]).toMatchObject({ matchEntityType: 'person', matchEntityId: eve.id });
    expect(rows[2]).toMatchObject({ matchEntityType: 'organization', matchEntityId: stone.id });
    expect(rows[3]!.reason).toContain('row 3');
    expect(rows[4]!.reason).toContain('No name or email');

    const peopleBefore = count('person');
    decideApproval(env.ctx, getRunDetail(env.db, env.workspaceId, run.id).approvals[0]!.id, { decision: 'approve' });
    expect(count('person')).toBe(peopleBefore + 1);
  });

  it('pages import rows with a status filter and returns raw only on request', async () => {
    stub.state.items = Array.from({ length: 7 }, (_, index) => ({
      name: `Paged Person ${index + 1}`,
      email: `paged${index + 1}@example.com`,
      extra: 'kept in raw',
    }));
    stub.state.items.push({ nothing: true });
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {}, maxItems: 8 } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const batchId = (getRunDetail(env.db, env.workspaceId, run.id).approvals[0]!.payload as { batchId: string }).batchId;

    const first = (await getJson(`/api/imports/${batchId}?limit=3`)).body;
    expect(first.items.map((row: { seq: number }) => row.seq)).toEqual([1, 2, 3]);
    expect(first.nextCursor).not.toBeNull();
    expect(first.items[0]).not.toHaveProperty('raw');
    expect(first.counts).toMatchObject({ fetched: 8, staged: 7, invalid: 1 });
    const second = (await getJson(`/api/imports/${batchId}?limit=3&cursor=${encodeURIComponent(first.nextCursor)}`)).body;
    expect(second.items.map((row: { seq: number }) => row.seq)).toEqual([4, 5, 6]);
    const last = (await getJson(`/api/imports/${batchId}?limit=3&cursor=${encodeURIComponent(second.nextCursor)}`)).body;
    expect(last.nextCursor).toBeNull();
    const invalid = (await getJson(`/api/imports/${batchId}?status=invalid`)).body;
    expect(invalid.items).toHaveLength(1);
    expect((await getJson(`/api/imports/${batchId}?status=bogus`)).status).toBe(400);
    const withRaw = (await getJson(`/api/imports/${batchId}?limit=1&withRaw=true`)).body;
    expect(withRaw.items[0].raw).toMatchObject({ extra: 'kept in raw' });
    expect(withRaw.items[0].mapped).toMatchObject({ name: 'Paged Person 1' });

    controlRun(env.ctx, run.id, { action: 'cancel' });
    const closed = (await getJson(`/api/imports/${batchId}`)).body;
    expect(closed.status).toBe('rejected');
    expect(closed.items.filter((row: { status: string }) => row.status === 'rejected')).toHaveLength(7);
  });

  it('rejecting the review cancels the run and creates nothing', async () => {
    stub.state.items = [{ name: 'Reject Me', email: 'reject.me@example.com' }];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const waiting = getRunDetail(env.db, env.workspaceId, run.id);
    const peopleBefore = count('person');
    const decided = decideApproval(env.ctx, waiting.approvals[0]!.id, { decision: 'reject' });
    expect(decided.run.status).toBe('cancelled');
    expect(count('person')).toBe(peopleBefore);
    const batch = (await getJson(`/api/imports/${(waiting.approvals[0]!.payload as { batchId: string }).batchId}`)).body;
    expect(batch.status).toBe('rejected');
    expect(batch.items.map((row: { status: string }) => row.status)).toEqual(['rejected']);
    expect(batch.counts.rejected).toBe(1);
  });

  it('fails the run without creating records when Apify reports FAILED', async () => {
    stub.state.items = [{ name: 'Never Imported', email: 'never@example.com' }];
    stub.state.runStatuses = ['RUNNING', 'FAILED'];
    stub.state.statusMessage = 'Actor crashed.';
    const peopleBefore = count('person');
    const batchesBefore = count('import_batch');
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    expect(await driveRunAsync(env, run.id, ['failed', 'partial', 'waiting_approval'])).toBe('failed');
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    expect(detail.steps[2]!.status).toBe('failed');
    expect(detail.steps[2]!.detail).toContain('FAILED');
    expect(detail.steps[2]!.detail).toContain('Actor crashed.');
    expect(detail.steps.slice(3).every((step) => step.status === 'skipped')).toBe(true);
    expect(detail.approvals).toHaveLength(0);
    expect(count('person')).toBe(peopleBefore);
    expect(count('import_batch')).toBe(batchesBefore);
    expect(stub.state.datasetCalls).toBe(0);
  });

  it('fails when the Apify run is aborted', async () => {
    stub.state.runStatuses = ['ABORTED'];
    const aborted = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    expect(await driveRunAsync(env, aborted.id, ['failed'])).toBe('failed');
    expect(getRunDetail(env.db, env.workspaceId, aborted.id).steps[2]!.detail).toContain('ABORTED');
  });

  it('times out, asks Apify to stop, and fails the run', async () => {
    const undo = useStub(stub, { AGENTCRM_APIFY_TIMEOUT_MS: '4000' });
    try {
      stub.state.runStatuses = ['RUNNING'];
      const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
      expect(await driveRunAsync(env, run.id, ['failed'])).toBe('failed');
      const detail = getRunDetail(env.db, env.workspaceId, run.id);
      expect(detail.steps[2]!.detail).toContain('Timed out');
      expect(stub.state.abortCalls).toBe(1);
      expect(stub.state.startQueries[0]).toContain('timeout=4');
    } finally {
      undo();
    }
  });

  it('shows elapsed time in the poll step while waiting', async () => {
    stub.state.runStatuses = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    for (let tick = 0; tick < 6; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
    }
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    expect(detail.status).toBe('running');
    expect(detail.steps[2]!.status).toBe('running');
    expect(detail.steps[2]!.detail).toMatch(/RUNNING\. Elapsed \d+ s\./);
    controlRun(env.ctx, run.id, { action: 'cancel' });
    expect(getRunDetail(env.db, env.workspaceId, run.id).steps[2]!.status).toBe('skipped');
    env.advance(1000);
    await processAllJobs(env.ctx);
    expect(stub.state.abortCalls).toBe(1);
  });

  it('polls the existing Apify run after a restart instead of starting another', async () => {
    stub.state.items = [{ name: 'Resumed Person', email: 'resumed@example.com' }];
    stub.state.runStatuses = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    for (let tick = 0; tick < 6; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
    }
    expect(stub.state.startCalls).toBe(1);
    expect(getRunDetail(env.db, env.workspaceId, run.id).scope.apifyRunId).toBe('run_1');

    // The process stopped mid tick: the job is left in "running" and the next start recovers it.
    env.db.prepare("UPDATE job SET status = 'running' WHERE status = 'queued'").run();
    expect(recoverStaleJobs(env.ctx)).toBeGreaterThan(0);
    stub.state.runStatuses = ['SUCCEEDED'];
    expect(await driveRunAsync(env, run.id, ['waiting_approval'])).toBe('waiting_approval');
    expect(stub.state.startCalls).toBe(1);
  });

  it('does not start a second actor run when the scope already holds an Apify run id', async () => {
    stub.state.items = [{ name: 'Scope Person', email: 'scope.person@example.com' }];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    const scope = { ...getRunDetail(env.db, env.workspaceId, run.id).scope, apifyRunId: 'run_existing', apifyDatasetId: 'ds_1', apifyStartedAt: env.ctx.now() };
    env.db.prepare('UPDATE run SET scope = ? WHERE id = ?').run(JSON.stringify(scope), run.id);
    expect(await driveRunAsync(env, run.id, ['waiting_approval'])).toBe('waiting_approval');
    expect(stub.state.startCalls).toBe(0);
    expect(getRunDetail(env.db, env.workspaceId, run.id).steps[1]!.detail).toContain('run_existing');
  });

  it('supports pause and resume while polling', async () => {
    stub.state.items = [{ name: 'Paused Person', email: 'paused@example.com' }];
    stub.state.runStatuses = ['RUNNING', 'RUNNING', 'SUCCEEDED'];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    for (let tick = 0; tick < 5; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
    }
    expect(controlRun(env.ctx, run.id, { action: 'pause' }).status).toBe('paused');
    const polls = stub.state.pollCalls;
    for (let tick = 0; tick < 3; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
    }
    expect(stub.state.pollCalls).toBe(polls);
    controlRun(env.ctx, run.id, { action: 'resume' });
    expect(await driveRunAsync(env, run.id, ['waiting_approval'])).toBe('waiting_approval');
    expect(stub.state.startCalls).toBe(1);
  });

  it('finishes partial with no review when nothing can be imported', async () => {
    stub.state.items = [];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    expect(await driveRunAsync(env, run.id, ['partial'])).toBe('partial');
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    expect(detail.approvals).toHaveLength(0);
    expect(detail.steps[3]!.detail).toBe('The dataset has no items.');
    expect(detail.counts).toMatchObject({ fetched: 0, staged: 0 });
  });

  it('ends the run when Apify rejects the saved token mid run', async () => {
    stub.state.runStatuses = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    for (let tick = 0; tick < 4; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
    }
    stub.state.token = 'apify_api_rotated0000';
    expect(await driveRunAsync(env, run.id, ['failed'])).toBe('failed');
    expect(getRunDetail(env.db, env.workspaceId, run.id).steps[2]!.detail).toContain('token');
    expect(getRunDetail(env.db, env.workspaceId, run.id).steps[2]!.detail).not.toContain(stubToken);
    stub.state.token = stubToken;
    await configureApifyConnector(env.ctx, { token: stubToken });
  });
});

describe('apify start safety', () => {
  async function untilStartSettled(runId: string): Promise<string> {
    return driveRunAsync(env, runId, ['failed']);
  }

  it('fails on a 502 without a second start request', async () => {
    stub.state.startStatus = 502;
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    expect(await untilStartSettled(run.id)).toBe('failed');
    for (let tick = 0; tick < 6; tick += 1) {
      env.advance(5000);
      await processAllJobs(env.ctx);
    }
    expect(stub.state.startCalls).toBe(1);
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    expect(detail.steps[1]!.status).toBe('failed');
    expect(detail.steps[1]!.detail).toContain('Apify console');
    expect(detail.steps[1]!.detail).toContain('recent runs');
    expect(detail.scope.startAttemptedAt).toBeTruthy();
    expect(detail.scope.apifyRunId).toBeUndefined();
  });

  it('treats an unreadable answer to a start as an unknown outcome and does not retry', async () => {
    stub.state.startGarbage = true;
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    expect(await untilStartSettled(run.id)).toBe('failed');
    env.advance(5000);
    await processAllJobs(env.ctx);
    expect(stub.state.startCalls).toBe(1);
    expect(getRunDetail(env.db, env.workspaceId, run.id).steps[1]!.detail).toContain('Apify console');
  });

  it('does not post again when a crash left an attempted start without a run id', async () => {
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    const scope = { ...getRunDetail(env.db, env.workspaceId, run.id).scope, startAttemptedAt: env.ctx.now() };
    env.db.prepare('UPDATE run SET scope = ? WHERE id = ?').run(JSON.stringify(scope), run.id);
    expect(await untilStartSettled(run.id)).toBe('failed');
    expect(stub.state.startCalls).toBe(0);
    expect(getRunDetail(env.db, env.workspaceId, run.id).steps[1]!.detail).toContain('Apify console');
  });

  it('records the attempt before the request and clears it after a rate limit so the retry can start', async () => {
    stub.state.startStatus = 429;
    stub.state.items = [{ name: 'Rate Limited', email: 'rate.limited@example.com' }];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    for (let tick = 0; tick < 20 && stub.state.startCalls === 0; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
    }
    expect(stub.state.startCalls).toBe(1);
    expect(getRunDetail(env.db, env.workspaceId, run.id).scope.startAttemptedAt ?? null).toBeNull();
    stub.state.startStatus = 201;
    expect(await driveRunAsync(env, run.id, ['waiting_approval'])).toBe('waiting_approval');
    expect(stub.state.startCalls).toBe(2);
    controlRun(env.ctx, run.id, { action: 'cancel' });
  });
});

describe('apify abort on cancel and failure', () => {
  async function untilPolling(runId: string): Promise<void> {
    for (let tick = 0; tick < 12 && !getRunDetail(env.db, env.workspaceId, runId).scope.apifyRunId; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
    }
    expect(getRunDetail(env.db, env.workspaceId, runId).scope.apifyRunId).toBe('run_1');
  }

  it('asks Apify to stop when a paused run is cancelled through the API', async () => {
    stub.state.runStatuses = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    await untilPolling(run.id);
    controlRun(env.ctx, run.id, { action: 'pause' });
    for (let tick = 0; tick < 3; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
    }
    expect(stub.state.abortCalls).toBe(0);
    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/control`,
      headers: { host: '127.0.0.1:4720' },
      payload: { action: 'cancel' },
    });
    expect(response.statusCode).toBe(200);
    expect(stub.state.abortCalls).toBe(1);
    expect(response.json().scope.abortRequested).toBe(true);
    expect(response.json().steps[2].detail).toContain('Asked Apify to stop run run_1');
    // The queued job finds the request already made and does not send a second one.
    env.advance(1000);
    await processAllJobs(env.ctx);
    expect(stub.state.abortCalls).toBe(1);
  });

  it('queues the abort for the worker when a paused run is cancelled without the API', async () => {
    stub.state.runStatuses = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    await untilPolling(run.id);
    controlRun(env.ctx, run.id, { action: 'pause' });
    for (let tick = 0; tick < 3; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
    }
    expect(controlRun(env.ctx, run.id, { action: 'cancel' }).status).toBe('cancelled');
    expect(stub.state.abortCalls).toBe(0);
    env.advance(1000);
    await processAllJobs(env.ctx);
    expect(stub.state.abortCalls).toBe(1);
  });

  it('keeps the cancel when the abort request fails and says so in the step detail', async () => {
    stub.state.runStatuses = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    await untilPolling(run.id);
    const original = stub.state.token;
    // Aborting needs the saved token to be accepted. A rotated token makes the abort call fail.
    stub.state.token = 'apify_api_rotated0000';
    controlRun(env.ctx, run.id, { action: 'cancel' });
    env.advance(1000);
    await processAllJobs(env.ctx);
    stub.state.token = original;
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    expect(detail.status).toBe('cancelled');
    expect(detail.steps[2]!.detail).toContain('Could not ask Apify to stop run run_1');
    expect(stub.state.abortCalls).toBe(0);
  });

  it('asks Apify to stop when retries run out', async () => {
    stub.state.runStatuses = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    await untilPolling(run.id);
    stub.state.pollStatus = 503;
    expect(await driveRunAsync(env, run.id, ['failed'])).toBe('failed');
    expect(stub.state.abortCalls).toBe(1);
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    expect(detail.steps[2]!.detail).toContain('The run stopped after 3 attempts');
    expect(detail.steps[2]!.detail).toContain('Asked Apify to stop run run_1');
  });

  it('fails active runs and asks Apify to stop them when the connector is removed', async () => {
    stub.state.runStatuses = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    await untilPolling(run.id);
    const response = await app.inject({ method: 'DELETE', url: '/api/connectors/apify', headers: { host: '127.0.0.1:4720' } });
    expect(response.statusCode).toBe(204);
    expect(stub.state.abortCalls).toBe(1);
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    expect(detail.status).toBe('failed');
    expect(detail.steps[2]!.detail).toContain('disconnected');
    expect(detail.steps[2]!.detail).toContain('Asked Apify to stop run run_1');
    await configureApifyConnector(env.ctx, { token: stubToken, allowlist: ['tester/lead-scraper'] });
  });

  it('does not ask Apify to stop a run that already finished', async () => {
    stub.state.items = [{ name: 'Done Already', email: 'done.already@example.com' }];
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    controlRun(env.ctx, run.id, { action: 'cancel' });
    env.advance(1000);
    await processAllJobs(env.ctx);
    expect(stub.state.abortCalls).toBe(0);
  });
});

describe('import approval with late conflicts', () => {
  async function stageRows(items: unknown[]) {
    stub.state.items = items;
    const run = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {} } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    return getRunDetail(env.db, env.workspaceId, run.id);
  }

  function rowStatuses(batchId: string): string[] {
    return (
      env.db.prepare('SELECT status FROM import_row WHERE batch_id = ? ORDER BY seq').all(batchId) as { status: string }[]
    ).map((row) => row.status);
  }

  it('marks a row that conflicts after staging as duplicate and accepts the rest', async () => {
    const waiting = await stageRows([
      { name: 'Late One', email: 'late.one@example.com' },
      { name: 'Late Two', email: 'late.two@example.com' },
      { name: 'Late Three', email: 'late.three@example.com' },
    ]);
    const batchId = (waiting.approvals[0]!.payload as { batchId: string }).batchId;
    createPerson(env.ctx, { firstName: 'Taken', lastName: 'Meanwhile', email: 'LATE.TWO@example.com' });
    const peopleBefore = count('person');
    const decided = decideApproval(env.ctx, waiting.approvals[0]!.id, { decision: 'approve' });
    expect(decided.run.status).toBe('succeeded');
    expect(rowStatuses(batchId)).toEqual(['accepted', 'duplicate', 'accepted']);
    expect(count('person')).toBe(peopleBefore + 2);
    expect(decided.run.counts).toMatchObject({ fetched: 3, staged: 2, duplicates: 1, invalid: 0, accepted: 2 });
    const reason = env.db.prepare("SELECT reason FROM import_row WHERE batch_id = ? AND seq = 2").get(batchId) as { reason: string };
    expect(reason.reason).toContain('added after staging');
  });

  it('rolls back only the conflicting row when the conflict appears while importing', async () => {
    const waiting = await stageRows([
      { name: 'Savepoint One', email: 'savepoint.one@example.com' },
      { name: 'Savepoint Two', email: 'savepoint.two@example.com', company: 'Rollback Co', domain: 'rollback.example.com' },
      { name: 'Savepoint Three', email: 'savepoint.three@example.com' },
    ]);
    const batchId = (waiting.approvals[0]!.payload as { batchId: string }).batchId;
    // Row 2 now shares row 1's email, which no pre-check can see. It would create an organization first.
    const mapped = JSON.parse((env.db.prepare('SELECT mapped FROM import_row WHERE batch_id = ? AND seq = 2').get(batchId) as { mapped: string }).mapped);
    env.db
      .prepare('UPDATE import_row SET mapped = ? WHERE batch_id = ? AND seq = 2')
      .run(JSON.stringify({ ...mapped, email: 'savepoint.one@example.com' }), batchId);
    const organizationsBefore = count('organization');
    const decided = decideApproval(env.ctx, waiting.approvals[0]!.id, { decision: 'approve' });
    expect(decided.run.status).toBe('succeeded');
    expect(rowStatuses(batchId)).toEqual(['accepted', 'duplicate', 'accepted']);
    expect(count('organization')).toBe(organizationsBefore);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM organization WHERE domain = 'rollback.example.com'").get()).toEqual({ n: 0 });
    expect(decided.run.counts).toMatchObject({ accepted: 2, duplicates: 1, staged: 2 });
  });
});

describe('apify run policy', () => {
  it('limits agent runs to the connector allowlist', () => {
    const scope = { actorId: 'other~map-finder', input: {} };
    const refused = conflictMessage(() => startRun(env.ctx, { kind: 'apify_scrape', scope }, { origin: 'agent' }));
    expect(refused).toContain('conflict');
    expect(refused).toContain('allowlist');
    expect(refused).toContain('other~map-finder');

    expect(startRun(env.ctx, { kind: 'apify_scrape', scope }, { origin: 'user' }).status).toBe('queued');
    const first = startRun(env.ctx, { kind: 'apify_scrape', scope: { ...scope, actorId: 'tester~lead-scraper' } }, { origin: 'agent' });
    expect(first.status).toBe('queued');
    controlRun(env.ctx, first.id, { action: 'cancel' });
    const second = startRun(env.ctx, { kind: 'apify_scrape', scope: { ...scope, actorId: 'Tester/Lead-Scraper' } }, { origin: 'agent' });
    expect(second.status).toBe('queued');
    controlRun(env.ctx, second.id, { action: 'cancel' });
  });

  it('allows one open agent started import at a time', () => {
    const scope = { actorId: 'tester~lead-scraper', input: {} };
    const first = startRun(env.ctx, { kind: 'apify_scrape', scope }, { origin: 'agent' });
    const refused = conflictMessage(() => startRun(env.ctx, { kind: 'apify_scrape', scope }, { origin: 'agent' }));
    expect(refused).toContain('conflict');
    expect(refused).toContain('One agent started import may run at a time');
    // A person can still start their own import, and demo runs are not counted.
    const own = startRun(env.ctx, { kind: 'apify_scrape', scope }, { origin: 'user' });
    expect(own.status).toBe('queued');
    expect(startRun(env.ctx, { kind: 'demo_research', scope: {} }, { origin: 'agent' }).status).toBe('queued');
    controlRun(env.ctx, own.id, { action: 'cancel' });
    // Pausing does not free the slot. Cancelling does.
    controlRun(env.ctx, first.id, { action: 'pause' });
    expect(conflictMessage(() => startRun(env.ctx, { kind: 'apify_scrape', scope }, { origin: 'agent' }))).toContain('One agent');
    controlRun(env.ctx, first.id, { action: 'cancel' });
    const next = startRun(env.ctx, { kind: 'apify_scrape', scope }, { origin: 'agent' });
    expect(next.status).toBe('queued');
    controlRun(env.ctx, next.id, { action: 'cancel' });
  });

  it('rejects actor ids that are or contain dot segments', async () => {
    for (const bad of ['.', '..', 'tester/..', '../tester', 'tester/./x']) {
      expect(conflictMessage(() => startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId: bad, input: {} } }))).toMatch(/^validation: /);
    }
    const put = await app.inject({
      method: 'PUT',
      url: '/api/connectors/apify',
      headers: { host: '127.0.0.1:4720' },
      payload: { allowlist: ['tester/lead-scraper', '..'] },
    });
    expect(put.statusCode).toBe(400);
    const detail = await app.inject({ method: 'GET', url: '/api/connectors/apify/actors/..', headers: { host: '127.0.0.1:4720' } });
    expect(detail.statusCode).not.toBe(200);
    expect(stub.state.paths.some((entry) => entry.includes('/v2/acts/..'))).toBe(false);
    // A dot inside a name is still fine.
    const dotted = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId: 'tester/lead.scraper', input: {} } });
    expect(dotted.status).toBe('queued');
    controlRun(env.ctx, dotted.id, { action: 'cancel' });
  });

  it('validates the scope and requires a connector', async () => {
    expect(conflictMessage(() => startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {}, maxItems: 5000 } }))).toContain('maxItems');
    expect(conflictMessage(() => startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId } }))).toContain('input');
    const response = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { host: '127.0.0.1:4720' },
      payload: { kind: 'apify_scrape', scope: { actorId: 'other~map-finder', input: { a: 1 } } },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().scope.maxItems).toBe(100);
  });
});
