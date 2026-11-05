import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureApifyConnector, controlRun, createOrganization, createPerson, startRun, updateOrganization } from '../src/actions/index.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { packageRoot } from '../src/paths.js';
import { getRunDetail, listRuns } from '../src/queries/runs.js';
import { type ApifyStub, startApifyStub, stubToken, useStub } from './apifyStub.js';
import { createTestEnvironment, driveRunAsync } from './helpers.js';

const env = createTestEnvironment();
let stub: ApifyStub;
let restore: () => void;
let app: FastifyInstance;

const companyActorKey = 'harvestapi~linkedin-company';
const orgUrl = 'https://www.linkedin.com/company/harbor-row-capital';

// A lookup item for the company page above. The website carries a path and a query, and the second location is the headquarters.
const fullItem = {
  name: 'Harbor Row Capital',
  universalName: 'harbor-row-capital',
  linkedinUrl: orgUrl,
  website: 'https://www.HarborRow.example.com/about/team?utm_source=li',
  locations: [
    { city: 'Elsewhere', headquarter: false, parsed: { text: 'Elsewhere, Aurelia' } },
    { city: 'Port Alder', headquarter: true, parsed: { text: 'Port Alder, Aurelia' } },
  ],
};

beforeAll(async () => {
  stub = await startApifyStub();
  restore = useStub(stub);
  await configureApifyConnector(env.ctx, { token: stubToken });
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

beforeEach(async () => {
  for (const row of env.db
    .prepare("SELECT id FROM run WHERE status IN ('queued', 'running', 'paused', 'waiting_approval')")
    .all() as { id: string }[]) {
    controlRun(env.ctx, row.id, { action: 'cancel' });
  }
  env.db.exec("UPDATE connector SET status = 'connected'");
  // Accepted domains stay on their organizations, and a domain can belong to one organization only.
  env.db.exec("UPDATE organization SET domain = NULL WHERE domain = 'harborrow.example.com'");
  await configureApifyConnector(env.ctx, { leadCapture: { companyActor: '' } });
  stub.reset();
  stub.state.actorItems[companyActorKey] = [fullItem];
});

afterAll(async () => {
  await app.close();
  await stub.close();
  restore();
  env.cleanup();
});

function failure(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'none';
}

let counter = 0;
// An organization with a LinkedIn page, so a run looks it up by that link.
function newOrg(fields: Record<string, unknown> = {}) {
  counter += 1;
  return createOrganization(env.ctx, { name: `Harbor Row Capital ${counter}`, kind: 'fund', linkedinUrl: orgUrl, ...fields });
}
// An organization with no LinkedIn page, so a run searches by name.
function newNamedOrg(fields: Record<string, unknown> = {}) {
  counter += 1;
  return createOrganization(env.ctx, { name: `Harbor Row Capital ${counter}`, kind: 'fund', ...fields });
}

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, headers: { host: '127.0.0.1:4720' }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: response.statusCode, body: response.body === '' ? null : (response.json() as Record<string, any>) };
}

async function enrich(organization: { id: string }, until = ['succeeded', 'failed', 'cancelled']) {
  const run = startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: organization.id } });
  const status = await driveRunAsync(env, run.id, until);
  return { run, status, detail: getRunDetail(env.db, env.workspaceId, run.id) };
}

const suggestionFields = (detail: { scope: Record<string, unknown> }) =>
  (detail.scope.suggestions as { field: string }[]).map((suggestion) => suggestion.field);

describe('companyActor setting', () => {
  it('defaults to the company lookup actor, round trips through PUT, and resets per field', async () => {
    const initial = await call('GET', '/api/connectors');
    expect(initial.body!.items[0].settings.leadCapture.companyActor).toBe('harvestapi/linkedin-company');
    const saved = await call('PUT', '/api/connectors/apify', { leadCapture: { companyActor: ' Custom/Company-Lookup ' } });
    expect(saved.status).toBe(200);
    expect(saved.body!.settings.leadCapture.companyActor).toBe('custom~company-lookup');
    // Left out keeps it, and the other four fields are untouched.
    const other = await call('PUT', '/api/connectors/apify', { leadCapture: { postActor: 'keep/me' } });
    expect(other.body!.settings.leadCapture.companyActor).toBe('custom~company-lookup');
    expect(other.body!.settings.leadCapture.profileActor).toBe('harvestapi/linkedin-profile-scraper');
    const reset = await call('PUT', '/api/connectors/apify', { leadCapture: { companyActor: '' } });
    expect(reset.body!.settings.leadCapture.companyActor).toBe('harvestapi/linkedin-company');
    expect(reset.body!.settings.leadCapture.postActor).toBe('keep~me');
    expect((await call('PUT', '/api/connectors/apify', { leadCapture: { companyActor: '..' } })).status).toBe(400);
    await call('PUT', '/api/connectors/apify', { leadCapture: { postActor: '' } });
  });

  it('is the actor a run uses, frozen into the run scope at start', async () => {
    await call('PUT', '/api/connectors/apify', { leadCapture: { companyActor: 'Custom/Company-Lookup' } });
    stub.state.actorItems['custom~company-lookup'] = [fullItem];
    const org = newOrg();
    const { status, detail } = await enrich(org);
    expect(status).toBe('succeeded');
    expect(detail.scope.actorId).toBe('custom~company-lookup');
    expect(stub.state.startActors).toEqual(['custom~company-lookup']);
  });
});

describe('enrich_organization run in url mode', () => {
  it('looks up one company page and keeps a suggestion for each empty field', async () => {
    const org = newOrg();
    // The link is already saved, so only the domain and the location are empty.
    const { run, status, detail } = await enrich(org);
    expect(status).toBe('succeeded');
    expect(run.title).toBe(`Enrich ${org.name}`);
    expect(detail.steps.map((step) => [step.title, step.status])).toEqual([
      ['Start the company lookup', 'done'],
      ['Wait for the company lookup to finish', 'done'],
      ['Read the company and suggest fields', 'done'],
    ]);
    expect(detail.steps[2]!.detail).toBe('Suggested 2 fields to fill: domain, location.');
    expect(detail.scope).toMatchObject({
      organizationId: org.id,
      actorId: 'harvestapi/linkedin-company',
      target: orgUrl,
      targetKind: 'url',
      apifyRunId: 'run_1',
      apifyFinished: true,
      suggestions: [
        { field: 'domain', value: 'harborrow.example.com', status: 'pending' },
        { field: 'location', value: 'Port Alder, Aurelia', status: 'pending' },
      ],
    });
    // One billed call, one target, one item.
    expect(stub.state.startCalls).toBe(1);
    expect(stub.state.startActors).toEqual([companyActorKey]);
    expect(stub.state.startBodies[0]).toEqual({ companies: [orgUrl] });
    expect(stub.state.startQueries[0]).toContain('maxItems=5');
    // The run writes nothing to the organization.
    expect(env.db.prepare('SELECT domain, location, version FROM organization WHERE id = ?').get(org.id)).toEqual({
      domain: null,
      location: null,
      version: org.version,
    });
  });

  it('passes the gate for an item that names the page in another case', async () => {
    stub.state.actorItems[companyActorKey] = [{ ...fullItem, linkedinUrl: 'https://www.linkedin.com/company/HARBOR-Row-Capital/' }];
    const { status } = await enrich(newOrg());
    expect(status).toBe('succeeded');
    stub.reset();
    stub.state.actorItems[companyActorKey] = [{ universalName: 'Harbor-Row-Capital', website: 'harborrow.example.com' }];
    const bySlug = await enrich(newOrg());
    expect(bySlug.status).toBe('succeeded');
    expect(suggestionFields(bySlug.detail)).toEqual(['domain']);
  });

  it('fails when the item names a different company, and suggests nothing', async () => {
    stub.state.actorItems[companyActorKey] = [
      { ...fullItem, name: 'Other Co', universalName: 'other-co', linkedinUrl: 'https://www.linkedin.com/company/other-co', inputUrl: orgUrl },
    ];
    const org = newOrg();
    const { status, detail } = await enrich(org);
    expect(status).toBe('failed');
    expect(detail.steps[2]!.status).toBe('failed');
    expect(detail.steps[2]!.detail).toBe(`The lookup returned a different company than ${orgUrl}, so nothing was suggested.`);
    expect(detail.scope.suggestions).toBeUndefined();
    const state = await call('GET', `/api/organizations/${org.id}/enrichment`);
    expect(state.body).toEqual({
      run: { id: detail.id, status: 'failed', startedAt: detail.startedAt, detail: detail.steps[2]!.detail, suggestedCount: 0 },
      suggestions: [],
    });
  });

  it('fails an item with no company link at all, and an empty dataset', async () => {
    stub.state.actorItems[companyActorKey] = [{ name: 'Harbor Row Capital', website: 'https://harborrow.example.com' }];
    const unnamed = await enrich(newOrg());
    expect(unnamed.status).toBe('failed');
    expect(unnamed.detail.steps[2]!.detail).toContain('a different company');
    stub.state.actorItems[companyActorKey] = [];
    const empty = await enrich(newOrg());
    expect(empty.status).toBe('failed');
    expect(empty.detail.steps[2]!.detail).toBe('The lookup returned no company, so nothing was suggested.');
  });

  it('says so when everything the company offered is already filled', async () => {
    const filled = newOrg({ domain: 'already.example.com', location: 'Somewhere' });
    const first = await enrich(filled);
    expect(first.status).toBe('succeeded');
    expect(first.detail.steps[2]!.detail).toBe('Every field the company offered was already filled, so nothing is suggested.');
    expect(first.detail.scope.suggestions).toEqual([]);

    // In url mode the item always offers its own page link, so "nothing new" needs a name lookup (see below).
    stub.state.actorItems[companyActorKey] = [{ linkedinUrl: orgUrl }];
    const second = await enrich(newOrg());
    expect(second.status).toBe('succeeded');
    expect(second.detail.steps[2]!.detail).toBe('Every field the company offered was already filled, so nothing is suggested.');
  });

  it('fails when the Apify run fails', async () => {
    stub.state.actorStatuses[companyActorKey] = ['FAILED'];
    stub.state.statusMessage = 'Actor crashed.';
    const crashed = await enrich(newOrg());
    expect(crashed.status).toBe('failed');
    expect(crashed.detail.steps[1]!.detail).toBe('Apify run ended with status FAILED: Actor crashed..');
  });

  it('never repeats a billed start when a start attempt left no run id', async () => {
    const run = startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: newOrg().id } });
    env.db.prepare("UPDATE run SET scope = json_set(scope, '$.startAttemptedAt', '2026-03-01T00:00:00.000Z') WHERE id = ?").run(run.id);
    expect(await driveRunAsync(env, run.id, ['failed'])).toBe('failed');
    expect(stub.state.startCalls).toBe(0);
    expect(getRunDetail(env.db, env.workspaceId, run.id).steps[0]!.detail).toContain('Check your Apify console');
  });

  it('asks Apify to stop the remote run on cancel, and notes an unknown start on a cancelled run', async () => {
    stub.state.actorStatuses[companyActorKey] = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: newOrg().id } });
    const { processAllJobs } = await import('../src/jobs/worker.js');
    for (let tick = 0; tick < 8 && stub.state.startCalls === 0; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
    }
    expect(stub.state.startCalls).toBe(1);
    const response = await call('POST', `/api/runs/${run.id}/control`, { action: 'cancel' });
    expect(response.body!.status).toBe('cancelled');
    expect(stub.state.abortedRuns).toEqual(['run_1']);

    const marked = startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: newOrg().id } });
    env.db.prepare("UPDATE run SET scope = json_set(scope, '$.startAttemptedAt', '2026-03-01T00:00:00.000Z') WHERE id = ?").run(marked.id);
    controlRun(env.ctx, marked.id, { action: 'cancel' });
    expect(getRunDetail(env.db, env.workspaceId, marked.id).steps[0]!.detail).toContain('may already have been sent before this cancel');
  });
});

describe('enrich_organization run in name mode', () => {
  it('searches by name, takes the first item, and names the company it returned', async () => {
    const org = newNamedOrg();
    const { status, detail } = await enrich(org);
    expect(status).toBe('succeeded');
    expect(stub.state.startBodies[0]).toEqual({ searches: [org.name] });
    expect(stub.state.startQueries[0]).toContain('maxItems=5');
    expect(detail.scope).toMatchObject({ target: org.name, targetKind: 'name', sourceUrl: orgUrl });
    expect(suggestionFields(detail)).toEqual(['linkedinUrl', 'domain', 'location']);
    // The final step detail names what the lookup returned so a person can judge the match.
    expect(detail.steps[2]!.detail).toContain(`The lookup for "${org.name}" returned Harbor Row Capital (${orgUrl}).`);
    expect(detail.steps[2]!.detail).toContain('Check that this is the right company before accepting anything.');
    expect(detail.steps[2]!.detail).toContain('Suggested 3 fields to fill: linkedinUrl, domain, location.');
    const state = await call('GET', `/api/organizations/${org.id}/enrichment`);
    expect(state.body!.run.detail).toBe(detail.steps[2]!.detail);
    expect(state.body!.suggestions).toEqual([
      { field: 'linkedinUrl', value: orgUrl },
      { field: 'domain', value: 'harborrow.example.com' },
      { field: 'location', value: 'Port Alder, Aurelia' },
    ]);
  });

  it('has no identity gate: an item for any company is the candidate', async () => {
    stub.state.actorItems[companyActorKey] = [{ name: 'Totally Different Ltd', universalName: 'totally-different', linkedinUrl: 'https://www.linkedin.com/company/totally-different' }];
    const { status, detail } = await enrich(newNamedOrg());
    expect(status).toBe('succeeded');
    expect(detail.steps[2]!.detail).toContain('returned Totally Different Ltd (https://www.linkedin.com/company/totally-different).');
  });

  it('names the company even when the item has no link, and still names what is missing', async () => {
    stub.state.actorItems[companyActorKey] = [{ name: 'No Link Ltd' }];
    const named = await enrich(newNamedOrg());
    expect(named.detail.steps[2]!.detail).toContain('returned No Link Ltd. Check that this is the right company');
    expect(named.detail.steps[2]!.detail).toContain('The company offered nothing new.');
    stub.state.actorItems[companyActorKey] = [{ website: 'https://nameless.example.com' }];
    const bare = await enrich(newNamedOrg());
    expect(bare.detail.steps[2]!.detail).toContain('returned a company with no name or LinkedIn link.');
  });

  it('answers a null detail while the run is still open', async () => {
    const org = newNamedOrg();
    const run = startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: org.id } });
    expect((await call('GET', `/api/organizations/${org.id}/enrichment`)).body).toEqual({
      run: { id: run.id, status: 'queued', startedAt: null, detail: null, suggestedCount: 0 },
      suggestions: [],
    });
  });
});

describe('what an item may suggest', () => {
  it('suggests only the fields that are empty when the company is read', async () => {
    const org = newNamedOrg({ domain: 'set.example.com' });
    const { detail } = await enrich(org);
    expect(suggestionFields(detail)).toEqual(['linkedinUrl', 'location']);
    expect(detail.steps[2]!.detail).toContain('Suggested 2 fields to fill: linkedinUrl, location.');
  });

  it('reduces a website with a path and query to its hostname', async () => {
    for (const [website, expected] of [
      ['https://www.Example-Fund.com/team/about?ref=li#top', 'example-fund.com'],
      ['http://deals.example.org:8080/path', 'deals.example.org'],
      ['example.net/contact', 'example.net'],
    ] as const) {
      stub.state.actorItems[companyActorKey] = [{ linkedinUrl: orgUrl, website }];
      const { detail } = await enrich(newOrg());
      expect(detail.scope.suggestions).toEqual([{ field: 'domain', value: expected, status: 'pending' }]);
    }
  });

  it('drops a website that is not a usable domain, or that another organization already holds', async () => {
    for (const website of ['not a url', 'localhost', 'https://www.linkedin.com/company/harbor-row-capital', 42, { url: 'x' }, null]) {
      stub.state.actorItems[companyActorKey] = [{ linkedinUrl: orgUrl, website }];
      const { status, detail } = await enrich(newOrg());
      expect(status).toBe('succeeded');
      expect(detail.scope.suggestions).toEqual([]);
    }
    createOrganization(env.ctx, { name: 'Domain Holder', kind: 'company', domain: 'taken.example.com' });
    stub.state.actorItems[companyActorKey] = [{ linkedinUrl: orgUrl, website: 'https://Taken.Example.com/home' }];
    const { detail } = await enrich(newOrg());
    expect(detail.scope.suggestions).toEqual([]);
  });

  it('reads the headquarters location, the first location without one, and the city when there is no text', async () => {
    const cases: [unknown, string | null][] = [
      [[{ headquarter: false, parsed: { text: 'First, Aurelia' } }, { headquarter: true, parsed: { text: 'Hq, Aurelia' } }], 'Hq, Aurelia'],
      [[{ parsed: { text: 'First, Aurelia' } }, { parsed: { text: 'Second, Aurelia' } }], 'First, Aurelia'],
      [[{ headquarter: true, city: 'Port Alder', parsed: {} }], 'Port Alder'],
      [[{ headquarter: true, parsed: { city: 'Parsed City' } }], 'Parsed City'],
      ['Port Alder', null],
      [[null, 7, 'x'], null],
      [[{ headquarter: true, parsed: 'nope', city: 5 }], null],
      [{ parsed: { text: 'Not an array' } }, null],
    ];
    for (const [locations, expected] of cases) {
      stub.state.actorItems[companyActorKey] = [{ linkedinUrl: orgUrl, locations }];
      const { status, detail } = await enrich(newOrg());
      expect(status).toBe('succeeded');
      expect(detail.scope.suggestions).toEqual(expected === null ? [] : [{ field: 'location', value: expected, status: 'pending' }]);
    }
  });

  it('survives items of unexpected shapes without crashing', async () => {
    for (const item of [{}, [], 'text', 7, { linkedinUrl: 5, website: [], locations: {} }]) {
      stub.state.actorItems[companyActorKey] = [item];
      const named = await enrich(newNamedOrg());
      expect(['succeeded', 'failed']).toContain(named.status);
      expect(named.detail.scope.suggestions ?? []).toEqual([]);
    }
  });

  it('canonicalizes the LinkedIn page and drops a link that is not a company page', async () => {
    stub.state.actorItems[companyActorKey] = [{ ...fullItem, linkedinUrl: 'linkedin.com/company/Harbor-Row-Capital/about/?trk=x' }];
    const good = await enrich(newNamedOrg());
    expect(good.detail.scope.suggestions).toContainEqual({ field: 'linkedinUrl', value: 'https://www.linkedin.com/company/Harbor-Row-Capital', status: 'pending' });
    stub.state.actorItems[companyActorKey] = [{ ...fullItem, universalName: undefined, linkedinUrl: 'https://www.linkedin.com/in/someone' }];
    const bad = await enrich(newNamedOrg());
    expect(suggestionFields(bad.detail)).not.toContain('linkedinUrl');
  });

  it('scrubs scraped text and drops a value over 200 characters instead of cutting it', async () => {
    const hidden = 'Port\u0000 Alder​, Aurelia‮';
    stub.state.actorItems[companyActorKey] = [{ linkedinUrl: orgUrl, locations: [{ headquarter: true, parsed: { text: hidden } }] }];
    const scrubbed = await enrich(newOrg());
    expect(scrubbed.detail.scope.suggestions).toEqual([{ field: 'location', value: 'Port Alder, Aurelia', status: 'pending' }]);

    stub.state.actorItems[companyActorKey] = [{ linkedinUrl: orgUrl, locations: [{ headquarter: true, parsed: { text: 'x'.repeat(201) } }] }];
    const long = await enrich(newOrg());
    expect(long.detail.scope.suggestions).toEqual([]);
    stub.state.actorItems[companyActorKey] = [{ linkedinUrl: orgUrl, locations: [{ headquarter: true, parsed: { text: 'y'.repeat(200) } }] }];
    const edge = await enrich(newOrg());
    expect(edge.detail.scope.suggestions).toEqual([{ field: 'location', value: 'y'.repeat(200), status: 'pending' }]);

    // The company name in the step detail is scrubbed and bounded too.
    stub.state.actorItems[companyActorKey] = [{ name: `Evil\u0000 ‮Name${'z'.repeat(300)}`, linkedinUrl: orgUrl }];
    const named = await enrich(newNamedOrg());
    const detailText = named.detail.steps[2]!.detail!;
    expect(detailText).not.toMatch(/[\u0000​‮]/);
    expect(detailText).not.toContain('z'.repeat(150));
  });
});

describe('enrich_organization start guards', () => {
  it('requires a ready Apify connector', () => {
    const org = newOrg();
    env.db.exec("UPDATE connector SET status = 'error'");
    expect(failure(() => startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: org.id } }))).toMatch(/^validation: Apify rejected/);
    const other = createTestEnvironment();
    try {
      const stranger = createOrganization(other.ctx, { name: 'No Connector', kind: 'company' });
      expect(failure(() => startRun(other.ctx, { kind: 'enrich_organization', scope: { organizationId: stranger.id } }))).toBe(
        'validation: Apify is not connected. Connect Apify in Settings first.',
      );
    } finally {
      other.cleanup();
    }
  });

  it('starts for an organization with no LinkedIn page, but needs an existing one and a clean scope', () => {
    expect(startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: newNamedOrg().id } }).status).toBe('queued');
    expect(failure(() => startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: 'org_missing' } }))).toMatch(
      /^validation: That organization was not found/,
    );
    expect(failure(() => startRun(env.ctx, { kind: 'enrich_organization', scope: {} }))).toMatch(/^validation: /);
    expect(failure(() => startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: newOrg().id, extra: 1 } }))).toMatch(/^validation: /);
  });

  it('allows one open run per organization, and another once it ends', async () => {
    const org = newOrg();
    const first = startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: org.id } });
    expect(failure(() => startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: org.id } }))).toMatch(
      /^validation: An enrichment run for this organization is already open/,
    );
    expect(startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: newOrg().id } }).status).toBe('queued');
    controlRun(env.ctx, first.id, { action: 'cancel' });
    expect(startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: org.id } }).status).toBe('queued');
    const refused = await call('POST', '/api/runs', { kind: 'enrich_organization', scope: { organizationId: org.id } });
    expect(refused.status).toBe(400);
    expect(refused.body!.error.code).toBe('validation');
  });

  it('is not blocked by an open person run, and does not block one', () => {
    counter += 1;
    const person = createPerson(env.ctx, { firstName: `Pat${counter}`, lastName: 'Enrich', linkedinUrl: `https://www.linkedin.com/in/pat-enrich-${counter}` });
    const org = newOrg();
    expect(startRun(env.ctx, { kind: 'enrich_person', scope: { personId: person.id } }).status).toBe('queued');
    expect(startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: org.id } }).status).toBe('queued');
  });

  it('rejects an agent origin with an honest message and creates nothing', () => {
    const org = newOrg();
    const message = failure(() => startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: org.id } }, { origin: 'agent' }));
    expect(message).toMatch(/^validation: Organization enrichment can only be started by a person in the app/);
    expect(
      env.db.prepare("SELECT COUNT(*) AS n FROM run WHERE kind = 'enrich_organization' AND json_extract(scope, '$.organizationId') = ?").get(org.id),
    ).toEqual({ n: 0 });
  });

  it('is workspace scoped: another workspace cannot start a run for the organization', () => {
    const org = newOrg();
    const other = createTestEnvironment();
    try {
      expect(failure(() => startRun(other.ctx, { kind: 'enrich_organization', scope: { organizationId: org.id } }))).toMatch(/^validation: /);
    } finally {
      other.cleanup();
    }
  });
});

describe('organization enrichment suggestions', () => {
  it('answers null when the organization has no run, and 404 for an unknown one', async () => {
    const org = newOrg();
    expect((await call('GET', `/api/organizations/${org.id}/enrichment`)).body).toEqual({ run: null, suggestions: [] });
    expect((await call('GET', '/api/organizations/org_missing/enrichment')).status).toBe(404);
  });

  it('reads the newest run of the organization', async () => {
    const org = newOrg();
    const first = await enrich(org);
    const second = await enrich(org);
    const state = await call('GET', `/api/organizations/${org.id}/enrichment`);
    expect(state.body!.run.id).toBe(second.run.id);
    expect(state.body!.run.id).not.toBe(first.run.id);
  });

  it('accepts a domain: field, claim, version, audit, and event in one step', async () => {
    const org = newOrg();
    const { run } = await enrich(org);
    const events: DomainEvent[] = [];
    const unsubscribe = env.bus.subscribe((event) => events.push(event));
    const response = await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'domain', expectedVersion: org.version });
    unsubscribe();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: org.id, domain: 'harborrow.example.com', version: org.version + 1 });
    expect(env.db.prepare('SELECT location FROM organization WHERE id = ?').get(org.id)).toEqual({ location: null });
    expect(
      env.db.prepare("SELECT value, source_type, source_url, extraction_method, status FROM field_claim WHERE entity_id = ? AND field = 'domain'").all(org.id),
    ).toEqual([
      {
        value: 'harborrow.example.com',
        source_type: 'apify',
        source_url: orgUrl,
        extraction_method: 'enrich:harvestapi/linkedin-company',
        status: 'imported',
      },
    ]);
    expect(env.db.prepare("SELECT 1 FROM audit_event WHERE action = 'enrichment.accept' AND entity_id = ?").get(org.id)).toBeTruthy();
    expect(events.some((event) => event.type === 'record_updated' && event.entityType === 'organization' && event.entityId === org.id)).toBe(true);
    expect((getRunDetail(env.db, env.workspaceId, run.id).scope.suggestions as { field: string; status: string }[]).map((s) => [s.field, s.status])).toEqual([
      ['domain', 'accepted'],
      ['location', 'pending'],
    ]);
    // Accepting the same suggestion again is refused, and the other one stays pending.
    const again = await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'domain', expectedVersion: org.version + 1 });
    expect(again.status).toBe(409);
    expect(again.body!.error.code).toBe('conflict');
    expect((await call('GET', `/api/organizations/${org.id}/enrichment`)).body!.suggestions).toEqual([{ field: 'location', value: 'Port Alder, Aurelia' }]);
  });

  it('accepts a location, and a linkedinUrl that writes the column and a claim', async () => {
    const org = newNamedOrg();
    const { run } = await enrich(org);
    const located = await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'location', expectedVersion: org.version });
    expect(located.status).toBe(200);
    expect(located.body).toMatchObject({ location: 'Port Alder, Aurelia', version: org.version + 1 });
    const linked = await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'linkedinUrl', expectedVersion: org.version + 1 });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ linkedinUrl: orgUrl, version: org.version + 2 });
    expect(env.db.prepare('SELECT linkedin_url, location, domain FROM organization WHERE id = ?').get(org.id)).toEqual({
      linkedin_url: orgUrl,
      location: 'Port Alder, Aurelia',
      domain: null,
    });
    expect(
      env.db.prepare("SELECT value, source_type, source_url, extraction_method, status FROM field_claim WHERE entity_id = ? AND field = 'linkedinUrl'").all(org.id),
    ).toEqual([{ value: orgUrl, source_type: 'apify', source_url: orgUrl, extraction_method: 'enrich:harvestapi/linkedin-company', status: 'imported' }]);
    // The name still matches in name mode, so the last suggestion can be accepted too.
    const domain = await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'domain', expectedVersion: org.version + 2 });
    expect(domain.status).toBe(200);
    expect((await call('GET', `/api/organizations/${org.id}/enrichment`)).body).toMatchObject({ suggestions: [] });
  });

  it('answers 409 conflict when the field got a value after the run, and keeps the suggestion pending', async () => {
    const org = newOrg();
    const { run } = await enrich(org);
    const edited = updateOrganization(env.ctx, org.id, { expectedVersion: org.version, fields: { location: 'Typed by hand' } });
    const response = await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'location', expectedVersion: edited.version });
    expect(response.status).toBe(409);
    expect(response.body!.error.code).toBe('conflict');
    expect(env.db.prepare('SELECT location FROM organization WHERE id = ?').get(org.id)).toEqual({ location: 'Typed by hand' });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ? AND field = 'location'").get(org.id)).toEqual({ n: 0 });
    expect((await call('GET', `/api/organizations/${org.id}/enrichment`)).body!.suggestions.map((s: { field: string }) => s.field)).toContain('location');
  });

  it('answers 409 conflict when the run is not the newest one', async () => {
    const org = newOrg();
    const old = await enrich(org);
    await enrich(org);
    const response = await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: old.run.id, field: 'domain', expectedVersion: org.version });
    expect(response.status).toBe(409);
    expect(response.body!.error.code).toBe('conflict');
    expect(env.db.prepare('SELECT domain FROM organization WHERE id = ?').get(org.id)).toEqual({ domain: null });
  });

  it('answers 409 conflict when the LinkedIn link changed in url mode', async () => {
    const org = newOrg();
    const { run } = await enrich(org);
    const edited = updateOrganization(env.ctx, org.id, { expectedVersion: org.version, fields: { linkedinUrl: 'https://www.linkedin.com/company/another-firm' } });
    const response = await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'domain', expectedVersion: edited.version });
    expect(response.status).toBe(409);
    expect(response.body!.error.code).toBe('conflict');
    expect(response.body!.error.message).toContain('LinkedIn link changed');
    expect(env.db.prepare('SELECT domain FROM organization WHERE id = ?').get(org.id)).toEqual({ domain: null });
  });

  it('answers 409 conflict when the name changed in name mode', async () => {
    const org = newNamedOrg();
    const { run } = await enrich(org);
    const renamed = updateOrganization(env.ctx, org.id, { expectedVersion: org.version, fields: { name: 'A Different Name' } });
    const response = await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'domain', expectedVersion: renamed.version });
    expect(response.status).toBe(409);
    expect(response.body!.error.code).toBe('conflict');
    expect(response.body!.error.message).toContain('name changed');
    expect(env.db.prepare('SELECT domain, linkedin_url FROM organization WHERE id = ?').get(org.id)).toEqual({ domain: null, linkedin_url: null });
  });

  it('answers 409 conflict for a domain another organization took after the run', async () => {
    const org = newOrg();
    const { run } = await enrich(org);
    createOrganization(env.ctx, { name: 'Late Domain Holder', kind: 'company', domain: 'harborrow.example.com' });
    const response = await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'domain', expectedVersion: org.version });
    expect(response.status).toBe(409);
    expect(env.db.prepare('SELECT domain FROM organization WHERE id = ?').get(org.id)).toEqual({ domain: null });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ? AND field = 'domain'").get(org.id)).toEqual({ n: 0 });
  });

  it('answers version_conflict for a stale version and leaves everything as it was', async () => {
    const org = newOrg();
    const { run } = await enrich(org);
    updateOrganization(env.ctx, org.id, { expectedVersion: org.version, fields: { tags: ['edited'] } });
    const response = await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'domain', expectedVersion: org.version });
    expect(response.status).toBe(409);
    expect(response.body!.error.code).toBe('version_conflict');
    expect(env.db.prepare('SELECT domain FROM organization WHERE id = ?').get(org.id)).toEqual({ domain: null });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ?").get(org.id)).toEqual({ n: 0 });
    expect((await call('GET', `/api/organizations/${org.id}/enrichment`)).body!.suggestions).toHaveLength(2);
  });

  it('refuses another organization, a run that is not succeeded, a field with no suggestion, and bad bodies', async () => {
    const org = newOrg();
    const other = newOrg();
    const { run } = await enrich(org);
    const wrongOrg = await call('POST', `/api/organizations/${other.id}/enrichment`, { runId: run.id, field: 'domain', expectedVersion: other.version });
    expect(wrongOrg.status).toBe(404);
    expect((await call('DELETE', `/api/organizations/${other.id}/enrichment?runId=${run.id}`)).status).toBe(404);

    const open = startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: other.id } });
    const notDone = await call('POST', `/api/organizations/${other.id}/enrichment`, { runId: open.id, field: 'domain', expectedVersion: other.version });
    expect(notDone.status).toBe(409);
    expect(notDone.body!.error.code).toBe('conflict');

    const noSuggestion = await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'linkedinUrl', expectedVersion: org.version });
    expect(noSuggestion.status).toBe(409);
    // An unknown run id is a 404.
    expect((await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: 'run_missing', field: 'domain', expectedVersion: 1 })).status).toBe(404);
    expect((await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'name', expectedVersion: 1 })).status).toBe(400);
    expect((await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'domain' })).status).toBe(400);
  });

  it('dismisses the remaining pending suggestions and nothing else, idempotently', async () => {
    const org = newOrg();
    const { run } = await enrich(org);
    await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'location', expectedVersion: org.version });
    const dismissed = await call('DELETE', `/api/organizations/${org.id}/enrichment?runId=${run.id}`);
    expect(dismissed.status).toBe(204);
    expect((getRunDetail(env.db, env.workspaceId, run.id).scope.suggestions as { field: string; status: string }[]).map((s) => [s.field, s.status])).toEqual([
      ['domain', 'dismissed'],
      ['location', 'accepted'],
    ]);
    const state = await call('GET', `/api/organizations/${org.id}/enrichment`);
    expect(state.body!.suggestions).toEqual([]);
    expect(state.body!.run.suggestedCount).toBe(2);
    expect((await call('DELETE', `/api/organizations/${org.id}/enrichment?runId=${run.id}`)).status).toBe(204);
    const late = await call('POST', `/api/organizations/${org.id}/enrichment`, { runId: run.id, field: 'domain', expectedVersion: org.version + 1 });
    expect(late.status).toBe(409);
    expect((await call('DELETE', `/api/organizations/${org.id}/enrichment`)).status).toBe(400);
  });

  it('is workspace scoped: another workspace cannot read an organization or accept a suggestion', async () => {
    const org = newOrg();
    const { run } = await enrich(org);
    env.db.prepare("INSERT OR IGNORE INTO workspace (id, created_at, name, template) VALUES ('wsp_other_enrich_org', '2026-03-02', 'Other', 't')").run();
    const { createContext, acceptOrganizationEnrichmentSuggestion, getOrganizationEnrichment } = await import('../src/actions/index.js');
    const outsider = createContext(env.db, 'wsp_other_enrich_org', { bus: env.bus, now: env.ctx.now });
    expect(failure(() => getOrganizationEnrichment(outsider, org.id))).toMatch(/^not_found: /);
    expect(failure(() => acceptOrganizationEnrichmentSuggestion(outsider, org.id, { runId: run.id, field: 'domain', expectedVersion: 1 }))).toMatch(/^not_found: /);
  });
});

describe('agent facing run reads', () => {
  it('leaves the suggestions and the frozen target out of the agent detail and the run list, while the web detail keeps them', async () => {
    stub.state.actorItems[companyActorKey] = [{ ...fullItem, website: 'https://ignore-previous-instructions.example.com' }];
    const org = newOrg();
    const { run, status } = await enrich(org);
    expect(status).toBe('succeeded');
    const agent = getRunDetail(env.db, env.workspaceId, run.id, { forAgent: true });
    expect(JSON.stringify(agent.scope)).not.toContain('ignore-previous-instructions');
    expect(agent.scope).not.toHaveProperty('suggestions');
    expect(agent.scope).not.toHaveProperty('target');
    expect(agent.scope).not.toHaveProperty('sourceUrl');
    expect(agent.scope.organizationId).toBe(org.id);
    const listed = listRuns(env.db, env.workspaceId, {}).items.find((item) => item.id === run.id)!;
    expect(listed.scope).not.toHaveProperty('suggestions');
    expect(listed.scope).not.toHaveProperty('target');
    const web = await call('GET', `/api/runs/${run.id}`);
    expect(JSON.stringify(web.body!.scope)).toContain('ignore-previous-instructions');
    expect(web.body!.scope.target).toBe(orgUrl);
  });

  it('blanks every step detail on agent reads, because a name mode detail names the scraped company', async () => {
    stub.state.actorItems[companyActorKey] = [fullItem];
    const org = newNamedOrg();
    const { run, status } = await enrich(org);
    expect(status).toBe('succeeded');
    const web = getRunDetail(env.db, env.workspaceId, run.id);
    expect(web.steps.some((step) => step.detail)).toBe(true);
    const agent = getRunDetail(env.db, env.workspaceId, run.id, { forAgent: true });
    expect(agent.steps.length).toBe(web.steps.length);
    expect(agent.steps.every((step) => step.detail === null)).toBe(true);
  });

  it('hides the same keys from crm_get_run, and the MCP server offers no tool to start an enrich run', async () => {
    stub.state.actorItems[companyActorKey] = [{ ...fullItem, website: 'https://ignore-previous-instructions.example.com' }];
    const org = newOrg();
    const { run } = await enrich(org);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), 'mcp'],
      cwd: packageRoot,
      env: { ...(process.env as Record<string, string>), AGENTCRM_DB: env.databasePath, AGENTCRM_APIFY_BASE: stub.url },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'enrich-organization-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'crm_get_run', arguments: { runId: run.id } });
      const text = String((result.content as { text: string }[])[0]!.text);
      expect(text).not.toContain('ignore-previous-instructions');
      expect(text).not.toContain(orgUrl);
      expect(text).not.toContain('suggestions');
      const { tools } = await client.listTools();
      expect(JSON.stringify(tools)).not.toMatch(/enrich_organization/);
      const attempt = await client.callTool({ name: 'crm_start_research', arguments: { kind: 'enrich_organization', scope: { organizationId: org.id } } });
      expect(attempt.isError).toBe(true);
    } finally {
      await client.close();
    }
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM run WHERE kind = 'enrich_organization' AND json_extract(scope, '$.organizationId') = ?").get(org.id)).toEqual({ n: 1 });
  }, 30_000);
});
