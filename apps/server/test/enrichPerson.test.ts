import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureApifyConnector, controlRun, createPerson, startRun, updatePerson } from '../src/actions/index.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { getRunDetail } from '../src/queries/runs.js';
import { type ApifyStub, startApifyStub, stubToken, useStub } from './apifyStub.js';
import { createTestEnvironment, driveRunAsync } from './helpers.js';

const env = createTestEnvironment();
let stub: ApifyStub;
let restore: () => void;
let app: FastifyInstance;

const profileActorKey = 'harvestapi~linkedin-profile-scraper';
const profileUrl = 'https://www.linkedin.com/in/enrich-me';

// A scraper item that names the profile and carries all three fields.
const fullItem = {
  firstName: 'Enrich',
  lastName: 'Me',
  headline: 'Partner at Harbor Row',
  publicIdentifier: 'enrich-me',
  linkedinUrl: profileUrl,
  email: 'Enrich.Me@harborrow.example.com',
  location: { linkedinText: 'Port Alder, Aurelia' },
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
  stub.reset();
  stub.state.actorItems[profileActorKey] = [fullItem];
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
function newPerson(fields: Record<string, unknown> = {}) {
  counter += 1;
  return createPerson(env.ctx, { firstName: `Person${counter}`, lastName: 'Enrich', linkedinUrl: profileUrl, ...fields });
}

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, headers: { host: '127.0.0.1:4720' }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: response.statusCode, body: response.body === '' ? null : (response.json() as Record<string, any>) };
}

async function enrich(person: { id: string }, until = ['succeeded', 'failed', 'cancelled']) {
  const run = startRun(env.ctx, { kind: 'enrich_person', scope: { personId: person.id } });
  const status = await driveRunAsync(env, run.id, until);
  return { run, status, detail: getRunDetail(env.db, env.workspaceId, run.id) };
}

describe('enrich_person run', () => {
  it('scrapes one profile and keeps a suggestion for each empty field', async () => {
    const person = newPerson();
    const { run, status, detail } = await enrich(person);
    expect(status).toBe('succeeded');
    expect(run.title).toBe(`Enrich ${person.firstName} Enrich`);
    expect(detail.steps.map((step) => [step.title, step.status])).toEqual([
      ['Start the profile scrape', 'done'],
      ['Wait for the profile scrape to finish', 'done'],
      ['Read the profile and suggest fields', 'done'],
    ]);
    expect(detail.steps[2]!.detail).toBe('Suggested 3 fields to fill: title, location, email.');
    expect(detail.scope).toMatchObject({
      personId: person.id,
      actorId: 'harvestapi/linkedin-profile-scraper',
      profileUrl,
      apifyRunId: 'run_1',
      apifyFinished: true,
      suggestions: [
        { field: 'title', value: 'Partner at Harbor Row', status: 'pending' },
        { field: 'location', value: 'Port Alder, Aurelia', status: 'pending' },
        { field: 'email', value: 'enrich.me@harborrow.example.com', status: 'pending' },
      ],
    });
    // One billed call, one target, one item.
    expect(stub.state.startCalls).toBe(1);
    expect(stub.state.startActors).toEqual([profileActorKey]);
    expect(stub.state.startBodies[0]).toEqual({ queries: [profileUrl], profileUrls: [profileUrl], usernames: [profileUrl] });
    // The cap is floored at 5 items: Apify refuses a charge cap below the actor's minimum charge
    // per run (live finding, HTTP 400 on a one item cap). The one target input bounds the bill.
    expect(stub.state.startQueries[0]).toContain('maxItems=5');
    // The run writes nothing to the person.
    expect(env.db.prepare('SELECT title, location, email, version FROM person WHERE id = ?').get(person.id)).toEqual({
      title: null,
      location: null,
      email: null,
      version: person.version,
    });
  });

  it('suggests only the fields that are empty when the profile is read', async () => {
    const person = newPerson({ title: 'Already set' });
    const { detail } = await enrich(person);
    expect(detail.steps[2]!.detail).toBe('Suggested 2 fields to fill: location, email.');
    expect((detail.scope.suggestions as { field: string }[]).map((s) => s.field)).toEqual(['location', 'email']);
  });

  it('says so when everything the profile offered is already filled, and when it offered nothing', async () => {
    const filled = newPerson({ title: 'T', location: 'L', email: `filled${counter}@example.com` });
    const first = await enrich(filled);
    expect(first.status).toBe('succeeded');
    expect(first.detail.steps[2]!.detail).toBe('Every field the profile offered was already filled, so nothing is suggested.');
    expect(first.detail.scope.suggestions).toEqual([]);

    stub.reset();
    stub.state.actorItems[profileActorKey] = [{ firstName: 'Enrich', publicIdentifier: 'enrich-me', linkedinUrl: profileUrl }];
    const bare = newPerson();
    const second = await enrich(bare);
    expect(second.status).toBe('succeeded');
    expect(second.detail.steps[2]!.detail).toBe('The profile offered nothing new.');
  });

  it('fails when the scraped item names a different profile, and suggests nothing', async () => {
    stub.state.actorItems[profileActorKey] = [{ ...fullItem, publicIdentifier: 'someone-else', linkedinUrl: 'https://www.linkedin.com/in/someone-else' }];
    const person = newPerson();
    const { status, detail } = await enrich(person);
    expect(status).toBe('failed');
    expect(detail.steps[2]!.status).toBe('failed');
    expect(detail.steps[2]!.detail).toContain('named a different profile');
    expect(detail.scope.suggestions).toBeUndefined();
    const state = await call('GET', `/api/people/${person.id}/enrichment`);
    expect(state.body).toEqual({
      run: { id: detail.id, status: 'failed', startedAt: detail.startedAt, detail: detail.steps[2]!.detail, suggestedCount: 0 },
      suggestions: [],
    });
  });

  it('matches an item that names the profile by its public identifier alone', async () => {
    stub.state.actorItems[profileActorKey] = [{ headline: 'Analyst', publicIdentifier: 'enrich-me' }];
    const { status, detail } = await enrich(newPerson());
    expect(status).toBe('succeeded');
    expect((detail.scope.suggestions as { field: string }[]).map((s) => s.field)).toEqual(['title']);
  });

  it('fails with an honest detail when the dataset is empty or the Apify run fails', async () => {
    stub.state.actorItems[profileActorKey] = [];
    const empty = await enrich(newPerson());
    expect(empty.status).toBe('failed');
    expect(empty.detail.steps[2]!.detail).toContain('returned no profile');

    stub.reset();
    stub.state.actorItems[profileActorKey] = [fullItem];
    stub.state.actorStatuses[profileActorKey] = ['FAILED'];
    stub.state.statusMessage = 'Actor crashed.';
    const crashed = await enrich(newPerson());
    expect(crashed.status).toBe('failed');
    expect(crashed.detail.steps[1]!.detail).toBe('Apify run ended with status FAILED: Actor crashed..');
  });

  it('never repeats a billed start when a start attempt left no run id', async () => {
    const person = newPerson();
    const run = startRun(env.ctx, { kind: 'enrich_person', scope: { personId: person.id } });
    env.db.prepare("UPDATE run SET scope = json_set(scope, '$.startAttemptedAt', '2026-03-01T00:00:00.000Z') WHERE id = ?").run(run.id);
    const status = await driveRunAsync(env, run.id, ['failed']);
    expect(status).toBe('failed');
    expect(stub.state.startCalls).toBe(0);
    expect(getRunDetail(env.db, env.workspaceId, run.id).steps[0]!.detail).toContain('Check your Apify console');
  });

  it('polls a saved Apify run after a restart instead of starting another', async () => {
    const person = newPerson();
    const run = startRun(env.ctx, { kind: 'enrich_person', scope: { personId: person.id } });
    stub.state.actorStatuses[profileActorKey] = ['RUNNING', 'RUNNING', 'SUCCEEDED'];
    await driveRunAsync(env, run.id, ['running']);
    await driveRunAsync(env, run.id, ['succeeded']);
    expect(stub.state.startCalls).toBe(1);
    expect(stub.state.pollCalls).toBeGreaterThanOrEqual(3);
  });

  it('asks Apify to stop the remote run when the run is cancelled', async () => {
    stub.state.actorStatuses[profileActorKey] = ['RUNNING'];
    const person = newPerson();
    const run = startRun(env.ctx, { kind: 'enrich_person', scope: { personId: person.id } });
    for (let tick = 0; tick < 8 && stub.state.startCalls === 0; tick += 1) {
      env.advance(1000);
      const { processAllJobs } = await import('../src/jobs/worker.js');
      await processAllJobs(env.ctx);
    }
    expect(stub.state.startCalls).toBe(1);
    const response = await call('POST', `/api/runs/${run.id}/control`, { action: 'cancel' });
    expect(response.body!.status).toBe('cancelled');
    expect(stub.state.abortedRuns).toEqual(['run_1']);
  });
});

describe('enrich_person start guards', () => {
  it('requires a ready Apify connector', async () => {
    const person = newPerson();
    env.db.exec("UPDATE connector SET status = 'error'");
    expect(failure(() => startRun(env.ctx, { kind: 'enrich_person', scope: { personId: person.id } }))).toMatch(/^validation: Apify rejected/);
    const other = createTestEnvironment();
    try {
      const stranger = createPerson(other.ctx, { firstName: 'No', lastName: 'Connector', linkedinUrl: profileUrl });
      expect(failure(() => startRun(other.ctx, { kind: 'enrich_person', scope: { personId: stranger.id } }))).toBe(
        'validation: Apify is not connected. Connect Apify in Settings first.',
      );
    } finally {
      other.cleanup();
    }
  });

  it('requires an existing person with a LinkedIn profile', () => {
    const bare = createPerson(env.ctx, { firstName: 'No', lastName: 'Profile' });
    expect(failure(() => startRun(env.ctx, { kind: 'enrich_person', scope: { personId: bare.id } }))).toBe(
      'validation: Save a LinkedIn profile on this person before enriching them.',
    );
    expect(failure(() => startRun(env.ctx, { kind: 'enrich_person', scope: { personId: 'per_missing' } }))).toMatch(/^validation: That person was not found/);
    expect(failure(() => startRun(env.ctx, { kind: 'enrich_person', scope: {} }))).toMatch(/^validation: /);
    expect(failure(() => startRun(env.ctx, { kind: 'enrich_person', scope: { personId: bare.id, extra: 1 } }))).toMatch(/^validation: /);
  });

  it('allows one open run per person, and another once it ends', async () => {
    const person = newPerson();
    const first = startRun(env.ctx, { kind: 'enrich_person', scope: { personId: person.id } });
    expect(failure(() => startRun(env.ctx, { kind: 'enrich_person', scope: { personId: person.id } }))).toMatch(
      /^validation: An enrichment run for this person is already open/,
    );
    // A different person is not blocked.
    expect(startRun(env.ctx, { kind: 'enrich_person', scope: { personId: newPerson().id } }).status).toBe('queued');
    controlRun(env.ctx, first.id, { action: 'cancel' });
    expect(startRun(env.ctx, { kind: 'enrich_person', scope: { personId: person.id } }).status).toBe('queued');
    // The same over HTTP: a 400 with the message.
    const refused = await call('POST', '/api/runs', { kind: 'enrich_person', scope: { personId: person.id } });
    expect(refused.status).toBe(400);
    expect(refused.body!.error.code).toBe('validation');
  });

  it('rejects an agent origin with an honest message', () => {
    const person = newPerson();
    const message = failure(() => startRun(env.ctx, { kind: 'enrich_person', scope: { personId: person.id } }, { origin: 'agent' }));
    expect(message).toMatch(/^validation: Profile enrichment can only be started by a person in the app/);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM run WHERE kind = 'enrich_person' AND json_extract(scope, '$.personId') = ?").get(person.id)).toEqual({ n: 0 });
  });
});

describe('enrichment suggestions', () => {
  it('answers null when the person has no run, and 404 for an unknown person', async () => {
    const person = newPerson();
    expect((await call('GET', `/api/people/${person.id}/enrichment`)).body).toEqual({ run: null, suggestions: [] });
    expect((await call('GET', '/api/people/per_missing/enrichment')).status).toBe(404);
  });

  it('shows an open run with a null detail and no suggestions', async () => {
    const person = newPerson();
    const run = startRun(env.ctx, { kind: 'enrich_person', scope: { personId: person.id } });
    expect((await call('GET', `/api/people/${person.id}/enrichment`)).body).toEqual({
      run: { id: run.id, status: 'queued', startedAt: null, detail: null, suggestedCount: 0 },
      suggestions: [],
    });
  });

  it('answers the three shapes the sheet renders from: pending, found nothing, all handled', async () => {
    // Pending rows.
    const person = newPerson();
    const { run, detail } = await enrich(person);
    const pending = await call('GET', `/api/people/${person.id}/enrichment`);
    expect(pending.body).toEqual({
      run: { id: run.id, status: 'succeeded', startedAt: detail.startedAt, detail: 'Suggested 3 fields to fill: title, location, email.', suggestedCount: 3 },
      suggestions: [
        { field: 'title', value: 'Partner at Harbor Row' },
        { field: 'location', value: 'Port Alder, Aurelia' },
        { field: 'email', value: 'enrich.me@harborrow.example.com' },
      ],
    });

    // All handled: one accepted, the rest dismissed. The count stays 3 and nothing is pending.
    const accepted = await call('POST', `/api/people/${person.id}/enrichment`, { runId: run.id, field: 'title', expectedVersion: person.version });
    expect(accepted.status).toBe(200);
    expect((await call('DELETE', `/api/people/${person.id}/enrichment?runId=${run.id}`)).status).toBe(204);
    const handled = await call('GET', `/api/people/${person.id}/enrichment`);
    expect(handled.body).toEqual({
      run: { id: run.id, status: 'succeeded', startedAt: detail.startedAt, detail: 'Suggested 3 fields to fill: title, location, email.', suggestedCount: 3 },
      suggestions: [],
    });

    // Found nothing: succeeded with a count of 0 and the detail to show.
    stub.reset();
    stub.state.actorItems[profileActorKey] = [{ publicIdentifier: 'enrich-me', linkedinUrl: profileUrl }];
    const quiet = newPerson();
    const empty = await enrich(quiet);
    expect((await call('GET', `/api/people/${quiet.id}/enrichment`)).body).toEqual({
      run: { id: empty.run.id, status: 'succeeded', startedAt: empty.detail.startedAt, detail: 'The profile offered nothing new.', suggestedCount: 0 },
      suggestions: [],
    });
  });

  it('reads the newest run of the person', async () => {
    const person = newPerson();
    const first = await enrich(person);
    const second = await enrich(person);
    const state = await call('GET', `/api/people/${person.id}/enrichment`);
    expect(state.body!.run.id).toBe(second.run.id);
    expect(state.body!.run.id).not.toBe(first.run.id);
  });

  it('accepts one suggestion: field, claim, version, audit, and event in one step', async () => {
    const person = newPerson();
    const { run } = await enrich(person);
    const events: DomainEvent[] = [];
    const unsubscribe = env.bus.subscribe((event) => events.push(event));
    const response = await call('POST', `/api/people/${person.id}/enrichment`, { runId: run.id, field: 'location', expectedVersion: person.version });
    unsubscribe();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: person.id, location: 'Port Alder, Aurelia', version: person.version + 1 });
    expect(env.db.prepare('SELECT title, email FROM person WHERE id = ?').get(person.id)).toEqual({ title: null, email: null });
    expect(
      env.db.prepare("SELECT value, source_type, source_url, extraction_method, status FROM field_claim WHERE entity_id = ? AND field = 'location'").all(person.id),
    ).toEqual([
      {
        value: 'Port Alder, Aurelia',
        source_type: 'apify',
        source_url: profileUrl,
        extraction_method: 'enrich:harvestapi/linkedin-profile-scraper',
        status: 'imported',
      },
    ]);
    expect(events.some((event) => event.type === 'record_updated' && event.entityType === 'person' && event.entityId === person.id)).toBe(true);
    expect((getRunDetail(env.db, env.workspaceId, run.id).scope.suggestions as { field: string; status: string }[]).map((s) => [s.field, s.status])).toEqual([
      ['title', 'pending'],
      ['location', 'accepted'],
      ['email', 'pending'],
    ]);
    // Accepting the same suggestion again is refused, and the other two stay pending.
    const again = await call('POST', `/api/people/${person.id}/enrichment`, { runId: run.id, field: 'location', expectedVersion: person.version + 1 });
    expect(again.status).toBe(409);
    expect(again.body!.error.code).toBe('conflict');
    expect((await call('GET', `/api/people/${person.id}/enrichment`)).body!.suggestions).toHaveLength(2);
  });

  it('answers 409 conflict when the field got a value after the run, and keeps the suggestion pending', async () => {
    const person = newPerson();
    const { run } = await enrich(person);
    const edited = updatePerson(env.ctx, person.id, { expectedVersion: person.version, fields: { title: 'Typed by hand' } });
    const response = await call('POST', `/api/people/${person.id}/enrichment`, { runId: run.id, field: 'title', expectedVersion: edited.version });
    expect(response.status).toBe(409);
    expect(response.body!.error.code).toBe('conflict');
    expect(env.db.prepare('SELECT title FROM person WHERE id = ?').get(person.id)).toEqual({ title: 'Typed by hand' });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ? AND field = 'title'").get(person.id)).toEqual({ n: 0 });
  });

  it('answers version_conflict for a stale version and leaves everything as it was', async () => {
    const person = newPerson();
    const { run } = await enrich(person);
    updatePerson(env.ctx, person.id, { expectedVersion: person.version, fields: { tags: ['edited'] } });
    const response = await call('POST', `/api/people/${person.id}/enrichment`, { runId: run.id, field: 'title', expectedVersion: person.version });
    expect(response.status).toBe(409);
    expect(response.body!.error.code).toBe('version_conflict');
    expect(env.db.prepare('SELECT title FROM person WHERE id = ?').get(person.id)).toEqual({ title: null });
    expect((await call('GET', `/api/people/${person.id}/enrichment`)).body!.suggestions).toHaveLength(3);
  });

  it('refuses a run of another person, a run that is not succeeded, and a field with no suggestion', async () => {
    const person = newPerson();
    const other = newPerson();
    const { run } = await enrich(person);
    const wrongPerson = await call('POST', `/api/people/${other.id}/enrichment`, { runId: run.id, field: 'title', expectedVersion: other.version });
    expect(wrongPerson.status).toBe(404);
    expect((await call('DELETE', `/api/people/${other.id}/enrichment?runId=${run.id}`)).status).toBe(404);

    const open = startRun(env.ctx, { kind: 'enrich_person', scope: { personId: other.id } });
    const notDone = await call('POST', `/api/people/${other.id}/enrichment`, { runId: open.id, field: 'title', expectedVersion: other.version });
    expect(notDone.status).toBe(409);
    expect(notDone.body!.error.code).toBe('conflict');

    const partial = newPerson({ title: 'Has title' });
    const second = await enrich(partial);
    const noSuggestion = await call('POST', `/api/people/${partial.id}/enrichment`, { runId: second.run.id, field: 'title', expectedVersion: partial.version });
    expect(noSuggestion.status).toBe(409);
    expect((await call('POST', `/api/people/${person.id}/enrichment`, { runId: run.id, field: 'company', expectedVersion: 1 })).status).toBe(400);
    expect((await call('POST', `/api/people/${person.id}/enrichment`, { runId: run.id, field: 'title' })).status).toBe(400);
  });

  it('dismisses the remaining pending suggestions and nothing else', async () => {
    const person = newPerson();
    const { run } = await enrich(person);
    await call('POST', `/api/people/${person.id}/enrichment`, { runId: run.id, field: 'email', expectedVersion: person.version });
    const dismissed = await call('DELETE', `/api/people/${person.id}/enrichment?runId=${run.id}`);
    expect(dismissed.status).toBe(204);
    expect((getRunDetail(env.db, env.workspaceId, run.id).scope.suggestions as { field: string; status: string }[]).map((s) => [s.field, s.status])).toEqual([
      ['title', 'dismissed'],
      ['location', 'dismissed'],
      ['email', 'accepted'],
    ]);
    expect((await call('GET', `/api/people/${person.id}/enrichment`)).body!.suggestions).toEqual([]);
    // Dismissing twice is harmless, and a dismissed suggestion cannot be accepted.
    expect((await call('DELETE', `/api/people/${person.id}/enrichment?runId=${run.id}`)).status).toBe(204);
    const late = await call('POST', `/api/people/${person.id}/enrichment`, { runId: run.id, field: 'title', expectedVersion: person.version + 1 });
    expect(late.status).toBe(409);
    expect((await call('DELETE', `/api/people/${person.id}/enrichment`)).status).toBe(400);
  });

  it('is workspace scoped: another workspace cannot read a person or accept a suggestion', async () => {
    const person = newPerson();
    const { run } = await enrich(person);
    env.db.prepare("INSERT OR IGNORE INTO workspace (id, created_at, name, template) VALUES ('wsp_other_enrich', '2026-03-02', 'Other', 't')").run();
    const { createContext, acceptEnrichmentSuggestion, getEnrichment } = await import('../src/actions/index.js');
    const outsider = createContext(env.db, 'wsp_other_enrich', { bus: env.bus, now: env.ctx.now });
    expect(failure(() => getEnrichment(outsider, person.id))).toMatch(/^not_found: /);
    expect(failure(() => acceptEnrichmentSuggestion(outsider, person.id, { runId: run.id, field: 'title', expectedVersion: 1 }))).toMatch(/^not_found: /);
  });
});
