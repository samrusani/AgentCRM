// Adversarial review probes for the auto accept imports setting. Names start with KILLS (a safety property holds, a
// regression for a fixed finding) or "documented limit" (a known, accepted limit asserted as it stands).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { FastifyInstance } from 'fastify';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addSuppression,
  configureApifyConnector,
  controlRun,
  createPerson,
  decideApproval,
  getImportSettings,
  setImportSettings,
  startRun,
  stageCsvImport,
} from '../src/actions/index.js';
import { createContext } from '../src/actions/context.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { processAllJobs, processJobs } from '../src/jobs/worker.js';
import { packageRoot } from '../src/paths.js';
import { getRunDetail } from '../src/queries/runs.js';
import { type ApifyStub, startApifyStub, stubToken, useStub } from './apifyStub.js';
import { createTestEnvironment, driveRun, driveRunAsync } from './helpers.js';
import { commentItems, commentsActorId, postUrl, profileActorId, profileItems, reactionItems, reactionsActorId } from './leadCaptureFixtures.js';

const env = createTestEnvironment();
let stub: ApifyStub;
let restoreApify: () => void;
let app: FastifyInstance;
const actorId = 'tester~lead-scraper';
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

beforeAll(async () => {
  stub = await startApifyStub();
  restoreApify = useStub(stub);
  await configureApifyConnector(env.ctx, { token: stubToken, allowlist });
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

beforeEach(async () => {
  for (const row of env.db.prepare("SELECT id FROM run WHERE status IN ('queued', 'running', 'paused', 'waiting_approval')").all() as { id: string }[]) {
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

const count = (sql: string, ...params: unknown[]): number => Number((env.db.prepare(sql).get(...params) as { n: number }).n);
const people = () => count('SELECT COUNT(*) AS n FROM person');
const runs = () => count('SELECT COUNT(*) AS n FROM run');
const detailOf = (runId: string) => getRunDetail(env.db, env.workspaceId, runId);
const scopeOf = (runId: string) => JSON.parse((env.db.prepare('SELECT scope FROM run WHERE id = ?').get(runId) as { scope: string }).scope) as Record<string, unknown>;
const auditCount = (action: string) => count('SELECT COUNT(*) AS n FROM audit_event WHERE action = ?', action);

async function http(method: string, url: string, options: { payload?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const response = await app.inject({
    method: method as 'GET',
    url,
    headers: { host: '127.0.0.1:4720', ...(options.headers ?? {}) },
    ...(options.raw !== undefined ? { payload: options.raw } : options.payload !== undefined ? { payload: options.payload as object } : {}),
  });
  let body: Record<string, any> | null = null;
  try {
    body = response.body === '' ? null : (JSON.parse(response.body) as Record<string, any>);
  } catch {
    body = null;
  }
  return { status: response.statusCode, body, headers: response.headers };
}

const csv = ['Name,Email,Company', 'Cy Dunn,cy.dunn@example.org,Dunn Works', 'Di Park,di.park@example.org,Park Row'].join('\n');
const csvMapping = { Name: 'name', Email: 'email', Company: 'company' };

async function startCsv(): Promise<string> {
  const response = await http('POST', '/api/imports/csv', { payload: { fileName: 'leads.csv', content: csv, mapping: csvMapping } });
  expect(response.status).toBe(201);
  return response.body!.id as string;
}

function startScrape(origin: 'user' | 'agent' = 'user'): string {
  return startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {}, maxItems: 10 } }, { origin }).id;
}

function startLead(origin: 'user' | 'agent' = 'user'): string {
  return startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions', 'comments'], enrich: false } }, { origin }).id;
}

// Ticks until only the review step is left to run, so a test can act in the gap before the setting is read.
function tickToBeforeReview(runId: string): void {
  for (let tick = 0; tick < 40; tick += 1) {
    const detail = detailOf(runId);
    if (detail.status === 'running' && detail.steps.filter((step) => step.status === 'done').length === detail.steps.length - 1) return;
    expect(['queued', 'running']).toContain(detail.status);
    env.advance(1000);
    processJobs(env.ctx);
  }
  throw new Error('The run never reached its review step.');
}

async function tickToBeforeReviewAsync(runId: string): Promise<void> {
  for (let tick = 0; tick < 80; tick += 1) {
    const detail = detailOf(runId);
    if (detail.status === 'running' && detail.steps.filter((step) => step.status === 'done').length === detail.steps.length - 1) return;
    expect(['queued', 'running']).toContain(detail.status);
    env.advance(1000);
    await processAllJobs(env.ctx);
  }
  throw new Error('The run never reached its review step.');
}

function failure(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'none';
}

describe('origin gate', () => {
  it('KILLS: no scope key lets a caller drop or spoof origin on an import producing run, over the action layer or HTTP', async () => {
    const apifyScope = { actorId, input: {}, maxItems: 10 };
    const leadScope = { postUrl, sources: ['reactions'], enrich: false };
    for (const origin of ['user', 'agent', null, undefined, 'USER', '']) {
      expect(failure(() => startRun(env.ctx, { kind: 'apify_scrape', scope: { ...apifyScope, origin } }, { origin: 'agent' }))).toMatch(/^validation/);
      expect(failure(() => startRun(env.ctx, { kind: 'lead_capture', scope: { ...leadScope, origin } }, { origin: 'agent' }))).toMatch(/^validation/);
      if (origin !== undefined) {
        const viaHttp = await http('POST', '/api/runs', { payload: { kind: 'apify_scrape', scope: { ...apifyScope, origin } } });
        expect(viaHttp.status).toBe(400);
      }
    }
    // A prototype key in the JSON body is refused too, not merged into the stored scope.
    const proto = await http('POST', '/api/runs', { raw: '{"kind":"apify_scrape","scope":{"actorId":"tester~lead-scraper","input":{},"__proto__":{"origin":"user"}}}', headers: { 'content-type': 'application/json' } });
    expect(proto.status).toBe(400);
    expect(runs()).toBe(0);
  });

  it('KILLS: an agent started scrape and lead capture keep origin agent through pause, resume, and every tick, and wait for a human with the setting on', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    const scrape = startScrape('agent');
    env.advance(1000);
    await processAllJobs(env.ctx);
    controlRun(env.ctx, scrape, { action: 'pause' });
    expect(scopeOf(scrape).origin).toBe('agent');
    env.advance(1000);
    await processAllJobs(env.ctx);
    controlRun(env.ctx, scrape, { action: 'resume' });
    for (let tick = 0; tick < 60; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
      expect(scopeOf(scrape).origin).toBe('agent');
      if (detailOf(scrape).status === 'waiting_approval') break;
    }
    expect(detailOf(scrape).status).toBe('waiting_approval');
    expect(detailOf(scrape).approvals[0]).toMatchObject({ status: 'pending', decidedBy: null });
    controlRun(env.ctx, scrape, { action: 'cancel' });

    const lead = startLead('agent');
    for (let tick = 0; tick < 80; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
      expect(scopeOf(lead).origin).toBe('agent');
      if (tick === 3) controlRun(env.ctx, lead, { action: 'pause' });
      if (tick === 5) controlRun(env.ctx, lead, { action: 'resume' });
      if (detailOf(lead).status === 'waiting_approval') break;
    }
    expect(detailOf(lead).status).toBe('waiting_approval');
    expect(people()).toBe(0);
  });

  it('KILLS: through the real MCP server, the agent tools list has no setting or decision tool and agent started imports wait with the setting on', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), 'mcp'],
      cwd: packageRoot,
      env: { ...(process.env as Record<string, string>), AGENTCRM_DB: env.databasePath, AGENTCRM_APIFY_BASE: stub.url },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'auto-accept-review-probe', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(names.join(' ')).not.toMatch(/setting|approv|decid|import|accept/i);
      const started = await client.callTool({
        name: 'crm_start_research',
        arguments: { kind: 'apify_scrape', scope: { actorId, input: {}, maxItems: 10, origin: 'user' } },
      });
      const text = String((started.content as { text: string }[])[0]!.text);
      const runId = (JSON.parse(text) as { runId?: string }).runId;
      expect(runId).toBeTruthy();
      expect(scopeOf(runId!).origin).toBe('agent');
      for (let wait = 0; wait < 100 && detailOf(runId!).status !== 'waiting_approval'; wait += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(detailOf(runId!).status).toBe('waiting_approval');
      expect(detailOf(runId!).approvals[0]).toMatchObject({ status: 'pending', decidedBy: null });
      expect(people()).toBe(0);
    } finally {
      await client.close();
    }
  }, 40_000);

  it('KILLS: the gate fails closed, so every start path stamps origin user and a run whose origin key is missing or unknown waits for a human', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    // startRun stamps origin user when the options give none, for every kind that reaches review.
    const stamped = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId, input: {}, maxItems: 10 } });
    expect(scopeOf(stamped.id).origin).toBe('user');
    controlRun(env.ctx, stamped.id, { action: 'cancel' });
    // An agent run that loses its origin key, or carries an unknown one, is not trusted as a user.
    for (const rewrite of ["json_remove(scope, '$.origin')", "json_set(scope, '$.origin', 'USER')", "json_set(scope, '$.origin', 'system')", "json_set(scope, '$.origin', NULL)"]) {
      const runId = startScrape('agent');
      await tickToBeforeReviewAsync(runId);
      expect(scopeOf(runId).origin).toBe('agent');
      env.db.prepare(`UPDATE run SET scope = ${rewrite} WHERE id = ?`).run(runId);
      await driveRunAsync(env, runId, ['succeeded', 'waiting_approval']);
      expect(detailOf(runId).status, rewrite).toBe('waiting_approval');
      expect(detailOf(runId).approvals[0], rewrite).toMatchObject({ status: 'pending', decidedBy: null });
      expect(people()).toBe(0);
      controlRun(env.ctx, runId, { action: 'cancel' });
      await processAllJobs(env.ctx);
    }
    // An explicit user origin still auto accepts.
    const userRun = startScrape('user');
    await driveRunAsync(env, userRun, ['succeeded', 'waiting_approval']);
    expect(detailOf(userRun).approvals[0]).toMatchObject({ status: 'approved', decidedBy: 'auto_accept' });
  });

  it('KILLS: a CSV import stamps origin user on the HTTP route and the action default, and a CSV run with no origin or an agent origin waits for a human', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    const viaHttp = await startCsv();
    expect(scopeOf(viaHttp).origin).toBe('user');
    const viaDefault = stageCsvImport(env.ctx, { fileName: 'user.csv', content: csv, mapping: csvMapping });
    expect(viaDefault.scope.origin).toBe('user');

    const agentRun = stageCsvImport(env.ctx, { fileName: 'agent.csv', content: csv, mapping: csvMapping }, { origin: 'agent' });
    expect(agentRun.scope.origin).toBe('agent');
    const bareRun = stageCsvImport(env.ctx, { fileName: 'bare.csv', content: csv, mapping: csvMapping });
    env.db.prepare("UPDATE run SET scope = json_remove(scope, '$.origin') WHERE id = ?").run(bareRun.id);
    expect(scopeOf(bareRun.id).origin).toBeUndefined();
    for (const runId of [agentRun.id, bareRun.id]) {
      driveRun(env, runId, ['waiting_approval']);
      expect(detailOf(runId).approvals[0]).toMatchObject({ status: 'pending', decidedBy: null });
      expect((env.db.prepare('SELECT status FROM import_batch WHERE run_id = ?').get(runId) as { status: string }).status).toBe('awaiting_review');
    }
    for (const runId of [viaHttp, viaDefault.id]) {
      driveRun(env, runId, ['succeeded', 'waiting_approval']);
      expect(detailOf(runId).approvals[0]).toMatchObject({ status: 'approved', decidedBy: 'auto_accept' });
    }
    expect(people()).toBeGreaterThan(0);
  });

  it('KILLS: the one open agent run slot still counts only origin agent runs, with user stamped runs beside them', async () => {
    const user = startScrape('user');
    expect(scopeOf(user).origin).toBe('user');
    const first = startScrape('agent');
    expect(failure(() => startScrape('agent'))).toMatch(/^conflict/);
    controlRun(env.ctx, first, { action: 'cancel' });
    controlRun(env.ctx, user, { action: 'cancel' });
    expect(failure(() => startScrape('agent'))).toBe('none');
  });
});

describe('decision site', () => {
  it('KILLS: the setting turning on between staging and review leaves the pending approval to the human, and a human reject cancels and creates nothing', async () => {
    const runId = await startCsv();
    driveRun(env, runId, ['waiting_approval']);
    setImportSettings(env.ctx, { autoAccept: true });
    await processAllJobs(env.ctx);
    env.advance(5000);
    processJobs(env.ctx);
    const approval = detailOf(runId).approvals[0]!;
    expect(approval).toMatchObject({ status: 'pending', decidedBy: null });
    const rejected = await http('POST', `/api/approvals/${approval.id}/decision`, { payload: { decision: 'reject' } });
    expect(rejected.status).toBe(200);
    expect(detailOf(runId).status).toBe('cancelled');
    expect(detailOf(runId).approvals[0]).toMatchObject({ status: 'rejected', decidedBy: 'user' });
    expect(people()).toBe(0);
    expect((env.db.prepare('SELECT status FROM import_batch WHERE run_id = ?').get(runId) as { status: string }).status).toBe('rejected');
  });

  it('KILLS: the auto decision leaves no window where the approval is pending, and a later human decision cannot double apply or flip it', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    const runId = await startCsv();
    for (let tick = 0; tick < 30; tick += 1) {
      env.advance(1000);
      processJobs(env.ctx);
      expect(count("SELECT COUNT(*) AS n FROM approval WHERE run_id = ? AND status = 'pending'", runId)).toBe(0);
      if (detailOf(runId).status === 'succeeded') break;
    }
    const approvalId = detailOf(runId).approvals[0]!.id;
    expect(people()).toBe(2);
    const again = decideApproval(env.ctx, approvalId, { decision: 'approve' });
    expect(again.alreadyDecided).toBe(true);
    expect(failure(() => decideApproval(env.ctx, approvalId, { decision: 'reject' }))).toMatch(/^conflict/);
    expect((await http('POST', `/api/approvals/${approvalId}/decision`, { payload: { decision: 'reject' } })).status).toBe(409);
    expect(people()).toBe(2);
    expect(detailOf(runId).status).toBe('succeeded');
    expect(count("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'approval.approve' AND entity_id = ?", approvalId)).toBe(1);
  });

  it('KILLS: the setting is read in one place, and enrichment suggestions stay pending with the setting on', async () => {
    const root = path.resolve(import.meta.dirname, '../src');
    const readers: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && /readImportSettings|getImportSettings|autoAccept/.test(readFileSync(full, 'utf8'))) readers.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(readers.sort()).toEqual(['actions/importReview.ts', 'actions/importSettings.ts', 'actions/index.ts', 'http/routes.ts']);

    setImportSettings(env.ctx, { autoAccept: true });
    stub.state.actorItems['harvestapi~linkedin-profile-scraper'] = [
      { firstName: 'Enrich', lastName: 'Me', publicIdentifier: 'enrich-me', linkedinUrl: 'https://www.linkedin.com/in/enrich-me', email: 'enrich.me@harborrow.example.com', location: { linkedinText: 'Port Alder, Aurelia' } },
    ];
    const person = createPerson(env.ctx, { firstName: 'Enrich', lastName: 'Target', linkedinUrl: 'https://www.linkedin.com/in/enrich-me' });
    const run = startRun(env.ctx, { kind: 'enrich_person', scope: { personId: person.id } });
    await driveRunAsync(env, run.id, ['succeeded', 'failed', 'cancelled']);
    const after = env.db.prepare('SELECT email, location FROM person WHERE id = ?').get(person.id) as { email: string | null; location: string | null };
    expect(after).toEqual({ email: null, location: null });
    expect(JSON.stringify(scopeOf(run.id).suggestions ?? [])).toContain('enrich.me@harborrow.example.com');
  });

  it('KILLS: the auto decision and the acceptance it triggers are audited under actor auto_accept, and the human path still records the person', async () => {
    setImportSettings(env.ctx, { autoAccept: true });
    const runId = await startCsv();
    driveRun(env, runId, ['succeeded', 'waiting_approval']);
    const approvalId = detailOf(runId).approvals[0]!.id;
    const row = env.db.prepare("SELECT actor, detail FROM audit_event WHERE action = 'approval.approve' AND entity_id = ?").get(approvalId) as { actor: string; detail: string };
    expect(row.actor).toBe('auto_accept');
    expect(JSON.parse(row.detail)).toMatchObject({ autoAccept: true });
    const accepted = env.db.prepare("SELECT actor FROM audit_event WHERE action = 'run.succeeded' AND entity_id = ?").get(runId) as { actor: string };
    expect(accepted.actor).toBe('auto_accept');
    // The approval being created is still the worker's act, not the decision.
    const created = env.db.prepare("SELECT actor FROM audit_event WHERE action = 'approval.create' AND entity_id = ?").get(approvalId) as { actor: string };
    expect(created.actor).toBe('system');
    // The human path records the person.
    setImportSettings(env.ctx, { autoAccept: false });
    const humanRun = await startCsv();
    env.db.exec('DELETE FROM field_claim; DELETE FROM person; DELETE FROM organization;');
    driveRun(env, humanRun, ['waiting_approval']);
    const humanApproval = detailOf(humanRun).approvals[0]!.id;
    decideApproval(env.ctx, humanApproval, { decision: 'approve' });
    const human = env.db.prepare("SELECT actor FROM audit_event WHERE action = 'approval.approve' AND entity_id = ?").get(humanApproval) as { actor: string };
    expect(human.actor).toBe('user');
    const humanDone = env.db.prepare("SELECT actor FROM audit_event WHERE action = 'run.succeeded' AND entity_id = ?").get(humanRun) as { actor: string };
    expect(humanDone.actor).toBe('user');
  });
});

describe('setting write and CSRF', () => {
  it('KILLS: a foreign web origin, a null origin, lookalike loopback names, and a foreign Host cannot write the setting or stage a CSV', async () => {
    const before = { runs: runs(), audits: auditCount('imports.settings_change') };
    for (const origin of ['https://evil.example', 'null', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example', 'http://localhost:4720@evil.example', 'file://', 'https://[::1].evil.example']) {
      const put = await http('PUT', '/api/imports/settings', { payload: { autoAccept: true }, headers: { origin } });
      expect(put.status, origin).toBe(403);
      const csvPost = await http('POST', '/api/imports/csv', { payload: { fileName: 'x.csv', content: csv, mapping: csvMapping }, headers: { origin } });
      expect(csvPost.status, origin).toBe(403);
    }
    const rebound = await http('PUT', '/api/imports/settings', { payload: { autoAccept: true }, headers: { host: 'evil.example:4720' } });
    expect(rebound.status).toBe(403);
    expect(getImportSettings(env.ctx)).toEqual({ autoAccept: false });
    expect({ runs: runs(), audits: auditCount('imports.settings_change') }).toEqual(before);
  });

  it('KILLS: the simple request content types a page can send cross site never parse into the setting or a CSV run, and preflight is never granted', async () => {
    const before = runs();
    const types = ['text/plain', 'text/plain;application/json', 'text/plain; charset=utf-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'];
    for (const contentType of types) {
      for (const method of ['PUT', 'POST']) {
        const put = await http(method, '/api/imports/settings', { raw: '{"autoAccept":true}', headers: { 'content-type': contentType, origin: 'http://localhost:9999' } });
        expect(put.status, `${method} ${contentType}`).toBeGreaterThanOrEqual(400);
      }
      const csvPost = await http('POST', '/api/imports/csv', {
        raw: JSON.stringify({ fileName: 'x.csv', content: csv, mapping: csvMapping }),
        headers: { 'content-type': contentType, origin: 'http://localhost:9999' },
      });
      expect(csvPost.status, contentType).toBeGreaterThanOrEqual(400);
    }
    expect(getImportSettings(env.ctx)).toEqual({ autoAccept: false });
    expect(runs()).toBe(before);
    for (const url of ['/api/imports/settings', '/api/imports/csv']) {
      const preflight = await http('OPTIONS', url, { headers: { origin: 'http://localhost:9999', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' } });
      expect(Object.keys(preflight.headers).filter((name) => name.toLowerCase().startsWith('access-control-'))).toEqual([]);
    }
  });

  it('documented limit: the server alone accepts the write from any other loopback port and from any browser extension id, so only the browser preflight stands behind a hostile local page', async () => {
    for (const origin of ['http://localhost:9999', 'http://127.0.0.1:1', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'moz-extension://deadbeef']) {
      const put = await http('PUT', '/api/imports/settings', { payload: { autoAccept: true }, headers: { origin } });
      expect(put.status, origin).toBe(200);
      expect(getImportSettings(env.ctx)).toEqual({ autoAccept: true });
      setImportSettings(env.ctx, { autoAccept: false });
      const before = runs();
      const staged = await http('POST', '/api/imports/csv', { payload: { fileName: 'x.csv', content: csv, mapping: csvMapping }, headers: { origin } });
      expect(staged.status, origin).toBe(201);
      expect(runs()).toBe(before + 1);
    }
  });

  it('KILLS: non object bodies, string and numeric booleans, and extra keys are refused and the stored value never changes', async () => {
    setImportSettings(env.ctx, { autoAccept: false });
    const audits = auditCount('imports.settings_change');
    const bodies = ['[]', '[true]', 'null', '"true"', 'true', '1', '{"autoAccept":"true"}', '{"autoAccept":1}', '{"autoAccept":"on"}', '{"autoAccept":true,"imports":{"autoAccept":true}}', '{"autoAccept":true,"__proto__":{"autoAccept":true}}', '{"AutoAccept":true}'];
    for (const raw of bodies) {
      const response = await http('PUT', '/api/imports/settings', { raw, headers: { 'content-type': 'application/json' } });
      expect(response.status, raw).toBe(400);
    }
    expect(getImportSettings(env.ctx)).toEqual({ autoAccept: false });
    expect(auditCount('imports.settings_change')).toBe(audits);
  });

  it('KILLS: anything but a stored object with autoAccept exactly true reads as off, including corrupt settings', () => {
    const stored = [
      { imports: { autoAccept: 'true' } },
      { imports: { autoAccept: 1 } },
      { imports: [true] },
      { imports: 'on' },
      { imports: null },
      { imports: { autoAcceptX: true } },
      { autoAccept: true },
    ];
    for (const value of stored) {
      env.db.prepare('UPDATE workspace SET settings = ? WHERE id = ?').run(JSON.stringify(value), env.workspaceId);
      expect(getImportSettings(env.ctx)).toEqual({ autoAccept: false });
    }
    for (const raw of ['{not json', '[]', 'null', '"x"']) {
      env.db.prepare('UPDATE workspace SET settings = ? WHERE id = ?').run(raw, env.workspaceId);
      expect(getImportSettings(env.ctx)).toEqual({ autoAccept: false });
    }
    env.db.prepare('UPDATE workspace SET settings = NULL WHERE id = ?').run(env.workspaceId);
  });
});

describe('data flow parity', () => {
  const parityCsv = [
    'Name,Email,Company,Domain',
    'Ada Quill,ada.quill@acme.example.com,Acme Co,acme.example.com',
    'Ben Marsh,ben.marsh@acme.example.com,Acme Co,acme.example.com',
    'Ada Quill,ada.quill@acme.example.com,Acme Co,acme.example.com',
    ',,,',
    'Eve Known,eve.known@known.example.org,Known Org,known.example.org',
    'Gus Late,gus.late@late.example.org,Late Org,late.example.org',
    'Sue Pressed,sue.suppressed@sup.example.org,Sup Org,sup.example.org',
    'Only Name,,Name Only Co,',
    ',only.email@mail.example.org,,',
  ].join('\n');
  const parityMapping = { Name: 'name', Email: 'email', Company: 'company', Domain: 'domain' };

  interface Snapshot {
    persons: unknown[];
    organizations: unknown[];
    claims: unknown[];
    rows: unknown[];
    batch: unknown;
    run: unknown;
    steps: unknown[];
    audit: string[];
    recordEvents: string[];
  }

  function normalize(text: string, runId: string): string {
    return text.split(runId).join('<run>').replace(/\b(run|imp|row|per|org|clm|apr|stp)_[0-9a-f]{12}\b/g, '<id>');
  }

  function snapshot(runId: string, events: DomainEvent[], auditFrom: number): Snapshot {
    const clean = (value: unknown) => JSON.parse(normalize(JSON.stringify(value), runId));
    const batch = env.db.prepare('SELECT id, status, counts FROM import_batch WHERE run_id = ?').get(runId) as { id: string; status: string; counts: string };
    const run = env.db.prepare('SELECT status, counts, finished_at IS NOT NULL AS finished FROM run WHERE id = ?').get(runId);
    return {
      persons: clean(
        env.db
          .prepare('SELECT p.first_name, p.last_name, p.email, p.title, p.location, p.tags, p.version, o.name AS org FROM person p LEFT JOIN organization o ON o.id = p.organization_id ORDER BY p.first_name, p.last_name, p.email')
          .all(),
      ),
      organizations: clean(env.db.prepare('SELECT name, domain, kind, location, tags, version FROM organization ORDER BY name').all()),
      claims: clean(
        env.db
          .prepare('SELECT entity_type, field, value, source_url, source_type, status, extraction_method FROM field_claim ORDER BY entity_type, field, value')
          .all(),
      ),
      rows: clean(env.db.prepare('SELECT seq, status, reason, match_entity_type FROM import_row WHERE batch_id = ? ORDER BY seq').all(batch.id)),
      batch: clean({ status: batch.status, counts: JSON.parse(batch.counts) }),
      run: clean({ ...(run as object), counts: JSON.parse((run as { counts: string }).counts) }),
      steps: clean(detailOf(runId).steps.map((step) => [step.title, step.status])),
      audit: (env.db.prepare('SELECT action FROM audit_event WHERE rowid > ? ORDER BY rowid').all(auditFrom) as { action: string }[]).map((row) => row.action).filter((action) => !action.startsWith('run.step')),
      recordEvents: events.filter((event) => event.type === 'record_updated').map((event) => `${(event as { entityType: string }).entityType}`).sort(),
    };
  }

  async function flow(auto: boolean): Promise<Snapshot> {
    env.db.exec('DELETE FROM field_claim; DELETE FROM person; DELETE FROM organization;');
    createPerson(env.ctx, { firstName: 'Eve', lastName: 'Known', email: 'eve.known@known.example.org' });
    setImportSettings(env.ctx, { autoAccept: auto });
    const auditFrom = (env.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_event').get() as { n: number }).n;
    const events: DomainEvent[] = [];
    const unsubscribe = env.bus.subscribe((event) => events.push(event));
    const response = await http('POST', '/api/imports/csv', { payload: { fileName: 'parity.csv', content: parityCsv, mapping: parityMapping } });
    expect(response.status).toBe(201);
    const runId = response.body!.id as string;
    tickToBeforeReview(runId);
    // A record that appears after staging but before acceptance, which only the accept time dedupe can catch.
    createPerson(env.ctx, { firstName: 'Gus', lastName: 'Late', email: 'gus.late@late.example.org' });
    if (auto) {
      expect(driveRun(env, runId, ['succeeded', 'partial', 'waiting_approval'])).not.toBe('waiting_approval');
    } else {
      driveRun(env, runId, ['waiting_approval']);
      decideApproval(env.ctx, detailOf(runId).approvals[0]!.id, { decision: 'approve' });
    }
    unsubscribe();
    return snapshot(runId, events, auditFrom);
  }

  it('KILLS: with the setting on, dedupe, invalid rows, late conflicts, suppressed addresses, claims, tags, counts, and record events match a human approve row for row', async () => {
    addSuppression(env.ctx, { email: 'sue.suppressed@sup.example.org', reason: 'manual' });
    const human = await flow(false);
    const auto = await flow(true);
    expect(auto.persons).toEqual(human.persons);
    expect(auto.organizations).toEqual(human.organizations);
    expect(auto.claims).toEqual(human.claims);
    expect(auto.rows).toEqual(human.rows);
    expect(auto.batch).toEqual(human.batch);
    expect(auto.run).toEqual(human.run);
    expect(auto.recordEvents).toEqual(human.recordEvents);
    // The only audit difference is the waiting_approval transition a human path goes through.
    expect(human.audit.filter((action) => !auto.audit.includes(action))).toEqual(['run.waiting_approval']);
    expect(auto.audit.filter((action) => !human.audit.includes(action))).toEqual([]);
    expect(auto.persons.length).toBeGreaterThan(3);
    expect(JSON.stringify(auto.rows)).toContain('invalid');
    expect(JSON.stringify(auto.rows)).toContain('duplicate');
    expect(JSON.stringify(auto.rows)).toContain('was added after staging');
  }, 30_000);
});
