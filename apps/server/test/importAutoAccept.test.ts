import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configureApifyConnector,
  controlRun,
  createPerson,
  decideApproval,
  getImportSettings,
  prepareSendIntents,
  setImportSettings,
  startRun,
} from '../src/actions/index.js';
import { buildApp } from '../src/http/app.js';
import { processAllJobs, processJobs } from '../src/jobs/worker.js';
import { getRunDetail } from '../src/queries/runs.js';
import { type AgentmailStub, startAgentmailStub, useAgentmailStub } from './agentmailStub.js';
import { type ApifyStub, startApifyStub, stubToken, useStub } from './apifyStub.js';
import { createTestEnvironment, driveRun, driveRunAsync, type TestEnvironment } from './helpers.js';
import { commentItems, commentsActorId, postUrl, profileActorId, profileItems, reactionItems, reactionsActorId } from './leadCaptureFixtures.js';
import { addDraft, addPerson, connectMail } from './mailHelpers.js';

const env = createTestEnvironment();
let stub: ApifyStub;
let restoreApify: () => void;
let app: FastifyInstance;
const actorId = 'tester~lead-scraper';
const noteText = 'Auto accepted by the imports setting.';

const allowlist = [
  'tester/lead-scraper',
  'harvestapi/linkedin-post-reactions',
  'harvestapi/linkedin-post-comments',
  'harvestapi/linkedin-profile-scraper',
];

const scrapeItems = [
  { name: 'Ada Quill', email: 'ada.quill@northwind.example.com', company: 'Northwind Labs' },
  { name: 'Ben Marsh', email: 'ben.marsh@harbor.example.org', company: 'Harbor Row' },
];

const csv = ['Name,Email,Company', 'Cy Dunn,cy.dunn@example.org,Dunn Works', 'Di Park,di.park@example.org,Park Row'].join('\n');
const csvMapping = { Name: 'name', Email: 'email', Company: 'company' };

beforeAll(async () => {
  stub = await startApifyStub();
  restoreApify = useStub(stub);
  await configureApifyConnector(env.ctx, { token: stubToken, allowlist });
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

beforeEach(async () => {
  for (const row of env.db
    .prepare("SELECT id FROM run WHERE status IN ('queued', 'running', 'paused', 'waiting_approval')")
    .all() as { id: string }[]) {
    controlRun(env.ctx, row.id, { action: 'cancel' });
  }
  await processAllJobs(env.ctx);
  env.db.exec('DELETE FROM field_claim; DELETE FROM person; DELETE FROM organization;');
  stub.reset();
  stub.state.items = scrapeItems;
  stub.state.actorItems[reactionsActorId] = reactionItems;
  stub.state.actorItems[commentsActorId] = commentItems;
  stub.state.actorItems[profileActorId] = profileItems;
  setImportSettings(env.ctx, { autoAccept: false });
});

afterAll(async () => {
  await app.close();
  await stub.close();
  restoreApify();
  env.cleanup();
});

function count(table: string): number {
  return Number((env.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function detailOf(runId: string) {
  return getRunDetail(env.db, env.workspaceId, runId);
}

async function http(method: 'GET' | 'PUT', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, headers: { host: '127.0.0.1:4720' }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

async function startCsvRun(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/imports/csv',
    headers: { host: '127.0.0.1:4720' },
    payload: { fileName: 'leads.csv', content: csv, mapping: csvMapping },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

function startScrape(origin: 'user' | 'agent' = 'user'): string {
  return startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {}, maxItems: 10 } }, { origin }).id;
}

function startLead(origin: 'user' | 'agent' = 'user'): string {
  return startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions', 'comments'], enrich: false } }, { origin }).id;
}

// The approval is always written. These are the facts that mark it as decided by the setting.
function expectAutoAccepted(runId: string, accepted: number) {
  const detail = detailOf(runId);
  expect(detail.status).toBe('succeeded');
  expect(detail.approvals).toHaveLength(1);
  const approval = detail.approvals[0]!;
  expect(approval).toMatchObject({ kind: 'import_review', status: 'approved', decidedBy: 'auto_accept', note: noteText });
  expect(approval.decidedAt).toBeTruthy();
  const review = detail.steps[detail.steps.length - 1]!;
  expect(review.status).toBe('done');
  expect(review.detail).toContain('Auto accepted by the imports setting');
  expect(detail.counts).toMatchObject({ accepted });
  const batch = env.db.prepare('SELECT status FROM import_batch WHERE run_id = ?').get(runId) as { status: string };
  expect(batch.status).toBe('accepted');
  return detail;
}

function expectWaiting(runId: string) {
  const detail = detailOf(runId);
  expect(detail.status).toBe('waiting_approval');
  expect(detail.approvals).toHaveLength(1);
  expect(detail.approvals[0]).toMatchObject({ kind: 'import_review', status: 'pending', decidedBy: null, note: null });
  expect(detail.steps[detail.steps.length - 1]!.detail).toContain('Waiting for review');
  return detail;
}

describe('imports settings', () => {
  it('defaults to off, round trips through the API, and audits each change', async () => {
    expect(await http('GET', '/api/imports/settings')).toEqual({ status: 200, body: { autoAccept: false } });
    expect((await http('PUT', '/api/imports/settings', { autoAccept: true })).body).toEqual({ autoAccept: true });
    expect((await http('GET', '/api/imports/settings')).body).toEqual({ autoAccept: true });
    expect(getImportSettings(env.ctx)).toEqual({ autoAccept: true });
    const stored = JSON.parse((env.db.prepare('SELECT settings FROM workspace WHERE id = ?').get(env.workspaceId) as { settings: string }).settings);
    expect(stored.imports).toEqual({ autoAccept: true });
    expect((await http('PUT', '/api/imports/settings', { autoAccept: false })).body).toEqual({ autoAccept: false });
    expect((await http('GET', '/api/imports/settings')).body).toEqual({ autoAccept: false });

    const events = env.db
      .prepare("SELECT actor, entity_type, entity_id, detail FROM audit_event WHERE action = 'imports.settings_change' ORDER BY created_at DESC, rowid DESC LIMIT 2")
      .all() as { actor: string; entity_type: string; entity_id: string; detail: string }[];
    expect(events.map((event) => JSON.parse(event.detail))).toEqual([{ autoAccept: false }, { autoAccept: true }]);
    expect(events[0]).toMatchObject({ actor: 'user', entity_type: 'workspace', entity_id: env.workspaceId });
  });

  it('keeps other workspace settings, rejects bad bodies, and signals other tabs', async () => {
    env.db.prepare('UPDATE workspace SET settings = ? WHERE id = ?').run(JSON.stringify({ capture: { keep: 'me' }, other: 1 }), env.workspaceId);
    const signals: unknown[] = [];
    const unsubscribe = env.bus.subscribe((event) => signals.push(event));
    await http('PUT', '/api/imports/settings', { autoAccept: true });
    unsubscribe();
    const stored = JSON.parse((env.db.prepare('SELECT settings FROM workspace WHERE id = ?').get(env.workspaceId) as { settings: string }).settings);
    expect(stored).toEqual({ capture: { keep: 'me' }, other: 1, imports: { autoAccept: true } });
    expect(signals).toContainEqual({ type: 'record_updated', entityType: 'import_settings', entityId: env.workspaceId });

    for (const body of [{}, { autoAccept: 'yes' }, { autoAccept: true, extra: 1 }, { autoAccept: null }]) {
      const response = await http('PUT', '/api/imports/settings', body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('validation');
    }
    expect(getImportSettings(env.ctx)).toEqual({ autoAccept: true });
    env.db.prepare('UPDATE workspace SET settings = NULL WHERE id = ?').run(env.workspaceId);
  });
});

describe('auto accept off (the default)', () => {
  it('writes the approval and waits for a human on every import kind', async () => {
    const scrape = startScrape();
    await driveRunAsync(env, scrape, ['waiting_approval']);
    expectWaiting(scrape);
    const csvRun = await startCsvRun();
    driveRun(env, csvRun, ['waiting_approval']);
    expectWaiting(csvRun);
    const lead = startLead();
    await driveRunAsync(env, lead, ['waiting_approval']);
    expectWaiting(lead);
    expect(count('person')).toBe(0);
  });

  it('lets a human reject, and nothing is created', async () => {
    const scrape = startScrape();
    await driveRunAsync(env, scrape, ['waiting_approval']);
    const approvalId = expectWaiting(scrape).approvals[0]!.id;
    const decided = decideApproval(env.ctx, approvalId, { decision: 'reject' });
    expect(decided.run.status).toBe('cancelled');
    expect(decided.approval).toMatchObject({ status: 'rejected', decidedBy: 'user' });
    expect(count('person')).toBe(0);
  });

  it('lets a human approve, which stays the same path', async () => {
    const scrape = startScrape();
    await driveRunAsync(env, scrape, ['waiting_approval']);
    const decided = decideApproval(env.ctx, expectWaiting(scrape).approvals[0]!.id, { decision: 'approve' });
    expect(decided.run.status).toBe('succeeded');
    expect(decided.approval).toMatchObject({ status: 'approved', decidedBy: 'user' });
    expect(count('person')).toBe(2);
  });
});

describe('auto accept on, user started runs', () => {
  it('accepts an Apify scrape batch like a human approve would', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    const runId = startScrape();
    expect(await driveRunAsync(env, runId, ['succeeded', 'waiting_approval'])).toBe('succeeded');
    const detail = expectAutoAccepted(runId, 2);
    expect(detail.steps[6]!.detail).toBe('Auto accepted by the imports setting: 2 to import, 0 duplicates, 0 invalid.');
    expect(detail.counts).toMatchObject({ fetched: 2, staged: 2, accepted: 2 });
    expect(count('person')).toBe(2);
    expect(count('organization')).toBe(2);
    const ada = env.db.prepare("SELECT id, tags, organization_id FROM person WHERE email = 'ada.quill@northwind.example.com'").get() as Record<string, string>;
    expect(JSON.parse(ada.tags!)).toEqual(['apify', `via-${runId}`]);
    expect(ada.organization_id).toBeTruthy();
    const claims = env.db.prepare("SELECT source_type, extraction_method, source_url FROM field_claim WHERE entity_id = ?").all(ada.id) as Record<string, string>[];
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim).toMatchObject({ source_type: 'apify', extraction_method: actorId });
      expect(claim.source_url).toContain('console.apify.com');
    }
    const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'approval.approve' AND entity_id = ?").get(detail.approvals[0]!.id) as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ runId, autoAccept: true });
  });

  it('skips duplicates at accept time exactly as a human approve does', async () => {
    createPerson(env.ctx, { firstName: 'Ada', lastName: 'Quill', email: 'ada.quill@northwind.example.com' });
    setImportSettings(env.ctx, { autoAccept: true });
    const runId = startScrape();
    await driveRunAsync(env, runId, ['succeeded', 'waiting_approval']);
    const detail = expectAutoAccepted(runId, 1);
    expect(detail.counts).toMatchObject({ fetched: 2, staged: 1, duplicates: 1, accepted: 1 });
    expect(count('person')).toBe(2);
  });

  it('accepts a CSV import', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    const runId = await startCsvRun();
    expect(driveRun(env, runId, ['succeeded', 'waiting_approval'])).toBe('succeeded');
    expectAutoAccepted(runId, 2);
    const cy = env.db.prepare("SELECT tags FROM person WHERE email = 'cy.dunn@example.org'").get() as { tags: string };
    expect(JSON.parse(cy.tags)).toEqual(['csv-import', `via-${runId}`]);
    expect(count('person')).toBe(2);
  });

  it('accepts a lead capture batch', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    const runId = startLead();
    expect(await driveRunAsync(env, runId, ['succeeded', 'waiting_approval'])).toBe('succeeded');
    const detail = expectAutoAccepted(runId, 6);
    expect(detail.steps[9]!.detail).toContain('Auto accepted by the imports setting');
    expect(count('person')).toBe(6);
    expect(count("field_claim WHERE source_type = 'apify'")).toBeGreaterThan(0);
  });

  it('still finishes partial with no approval when nothing is left to review', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    stub.state.items = [{ note: 'nothing that identifies a person' }];
    const runId = startScrape();
    expect(await driveRunAsync(env, runId, ['partial'])).toBe('partial');
    expect(detailOf(runId).approvals).toHaveLength(0);
  });
});

describe('auto accept on, agent started runs', () => {
  it('waits for a human for an Apify scrape', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    const runId = startScrape('agent');
    expect(detailOf(runId).scope).toMatchObject({ origin: 'agent' });
    await driveRunAsync(env, runId, ['waiting_approval', 'succeeded']);
    expectWaiting(runId);
    expect(count('person')).toBe(0);
    const decided = decideApproval(env.ctx, detailOf(runId).approvals[0]!.id, { decision: 'approve' });
    expect(decided.approval).toMatchObject({ decidedBy: 'user' });
    expect(count('person')).toBe(2);
  });

  it('waits for a human for lead capture', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    const runId = startLead('agent');
    await driveRunAsync(env, runId, ['waiting_approval', 'succeeded']);
    expectWaiting(runId);
    expect(count('person')).toBe(0);
  });
});

describe('toggling', () => {
  it('uses the setting at the moment the batch reaches review, not when the run started', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    const runId = await startCsvRun();
    // Tick until only the review step is left, then turn the setting off.
    for (let tick = 0; tick < 30; tick += 1) {
      const detail = detailOf(runId);
      if (detail.status === 'running' && detail.steps.filter((step) => step.status === 'done').length === detail.steps.length - 1) break;
      env.advance(1000);
      processJobs(env.ctx);
      expect(detailOf(runId).status).not.toBe('succeeded');
    }
    expect(detailOf(runId).status).toBe('running');
    setImportSettings(env.ctx, { autoAccept: false });
    expect(driveRun(env, runId, ['waiting_approval', 'succeeded'])).toBe('waiting_approval');
    expectWaiting(runId);
    expect(count('person')).toBe(0);
  });

  it('does not decide a review that was already waiting when the setting turned on', async () => {
    const runId = await startCsvRun();
    driveRun(env, runId, ['waiting_approval']);
    setImportSettings(env.ctx, { autoAccept: true });
    await processAllJobs(env.ctx);
    expectWaiting(runId);
    expect(count('person')).toBe(0);
  });
});

describe('no other approval is ever auto decided', () => {
  let mailEnv: TestEnvironment;
  let mail: AgentmailStub;
  let restoreMail: () => void;

  beforeAll(async () => {
    mail = await startAgentmailStub();
    restoreMail = useAgentmailStub(mail);
    mailEnv = createTestEnvironment();
    await connectMail(mailEnv);
  });

  afterAll(async () => {
    await mail.close();
    restoreMail();
    mailEnv.cleanup();
  });

  it('leaves a send review pending with the setting on', () => {
    setImportSettings(mailEnv.ctx, { autoAccept: true });
    const person = addPerson(mailEnv, 'Maren', 'maren.testwell@lanternrow.invalid');
    const draft = addDraft(mailEnv, person.id, 'Seed round intro', 'Hello Maren,\n\nA short note.\n\nThanks');
    const staged = prepareSendIntents(mailEnv.ctx, { draftActivityIds: [draft] });
    expect(staged.approval).toMatchObject({ kind: 'send_review', status: 'pending', decidedBy: null, note: null });
    expect(staged.run!.status).toBe('waiting_approval');
    expect(staged.intents[0]!.status).toBe('awaiting_approval');
  });

  it('leaves a shortlist review pending with the setting on', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    const run = startRun(env.ctx, { kind: 'demo_research', scope: { targetCount: 2 } });
    expect(driveRun(env, run.id, ['waiting_approval', 'succeeded'])).toBe('waiting_approval');
    expect(detailOf(run.id).approvals[0]).toMatchObject({ status: 'pending', decidedBy: null });
  });

  it('decides approvals without a person in exactly one place in the source', () => {
    const root = path.resolve(import.meta.dirname, '../src');
    const hits: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && /autoAcceptActor|'auto_accept'/.test(readFileSync(full, 'utf8'))) hits.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(hits).toEqual(['actions/importReview.ts']);
    const source = readFileSync(path.join(root, 'actions/importReview.ts'), 'utf8');
    // The decision sits in the import_review creation function, after that approval row is inserted.
    const creation = source.slice(source.indexOf('export function requestImportReview'));
    expect(creation.indexOf("'import_review'")).toBeGreaterThan(-1);
    expect(creation.indexOf('autoAcceptActor')).toBeGreaterThan(creation.indexOf("'import_review'"));
    // decideApproval never reads the setting.
    expect(readFileSync(path.join(root, 'actions/approvals.ts'), 'utf8')).not.toMatch(/autoAccept|readImportSettings/);
  });
});
