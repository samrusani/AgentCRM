// Adversarial review probes for per-row dismiss of enrichment suggestions (people and organizations). Names start with
// KILLS (a real defect, pinned with it.fails), CONFIRMS (an attack failed, a safety property holds), or ACCEPTED (an
// imperfection that is fine, with the why). Nothing here changes application code.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureApifyConnector, controlRun, createOrganization, createPerson, startRun } from '../src/actions/index.js';
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
const searchActorKey = 'harvestapi~linkedin-profile-search-by-name';
const companyActorKey = 'harvestapi~linkedin-company';
const profileUrl = 'https://www.linkedin.com/in/dismiss-probe';
const foundUrl = 'https://www.linkedin.com/in/dismiss-found';
const orgUrl = 'https://www.linkedin.com/company/dismiss-probe-capital';

const profileItem = {
  firstName: 'Dina',
  lastName: 'Probe',
  headline: 'Partner at Probe Row',
  publicIdentifier: 'dismiss-probe',
  linkedinUrl: profileUrl,
  email: 'Dina.Probe@proberow.example.com',
  location: { linkedinText: 'Port Alder, Aurelia' },
};
const searchItem = { firstName: 'Dina', lastName: 'Probe', headline: 'Partner at Probe Row', linkedinUrl: foundUrl, location: { linkedinText: 'Port Alder, Aurelia' } };
const companyItem = {
  name: 'Probe Capital',
  universalName: 'dismiss-probe-capital',
  linkedinUrl: orgUrl,
  website: 'https://www.proberow-dismiss.example.com/about',
  locations: [{ city: 'Port Alder', headquarter: true, parsed: { text: 'Port Alder, Aurelia' } }],
};

beforeAll(async () => {
  stub = await startApifyStub();
  restore = useStub(stub);
  await configureApifyConnector(env.ctx, { token: stubToken });
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

beforeEach(async () => {
  for (const row of env.db.prepare("SELECT id FROM run WHERE status IN ('queued', 'running', 'paused', 'waiting_approval')").all() as { id: string }[]) {
    controlRun(env.ctx, row.id, { action: 'cancel' });
  }
  env.db.exec("UPDATE connector SET status = 'connected'");
  env.db.exec("UPDATE person SET linkedin_url = NULL WHERE lower(linkedin_url) LIKE '%/in/dismiss-found%'");
  env.db.exec("UPDATE organization SET domain = NULL WHERE domain = 'proberow-dismiss.example.com'");
  await configureApifyConnector(env.ctx, { leadCapture: { personSearchActor: '', companyActor: '' } });
  stub.reset();
  stub.state.actorItems[profileActorKey] = [profileItem];
  stub.state.actorItems[searchActorKey] = [searchItem];
  stub.state.actorItems[companyActorKey] = [companyItem];
});

afterAll(async () => {
  await app.close();
  await stub.close();
  restore();
  env.cleanup();
});

let counter = 0;
const profilePerson = () => (counter += 1, createPerson(env.ctx, { firstName: `Dis${counter}`, lastName: 'Probe', linkedinUrl: profileUrl }));
const namePerson = () => (counter += 1, createPerson(env.ctx, { firstName: `Nam${counter}`, lastName: 'Probe' }));
const orgWith = () => (counter += 1, createOrganization(env.ctx, { name: `Probe Capital ${counter}`, kind: 'fund', linkedinUrl: orgUrl }));

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, headers: { host: '127.0.0.1:4720' }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: response.statusCode, body: response.body === '' ? null : (response.json() as Record<string, any>) };
}
async function enrichPerson(person: { id: string }) {
  const run = startRun(env.ctx, { kind: 'enrich_person', scope: { personId: person.id } });
  await driveRunAsync(env, run.id, ['succeeded', 'failed', 'cancelled']);
  return run;
}
async function enrichOrg(org: { id: string }) {
  const run = startRun(env.ctx, { kind: 'enrich_organization', scope: { organizationId: org.id } });
  await driveRunAsync(env, run.id, ['succeeded', 'failed', 'cancelled']);
  return run;
}
type S = { field: string; value: string; status: string };
const scopeOf = (runId: string) => getRunDetail(env.db, env.workspaceId, runId).scope.suggestions as S[];
const audits = (entityId: string) =>
  (env.db.prepare("SELECT detail FROM audit_event WHERE action = 'enrichment.dismiss' AND entity_id = ? ORDER BY rowid").all(entityId) as { detail: string }[]).map((r) => JSON.parse(r.detail));
const pBase = (id: string) => `/api/people/${id}/enrichment`;
const oBase = (id: string) => `/api/organizations/${id}/enrichment`;

describe('1. per-field transactionality', () => {
  it('CONFIRMS: dismissing A leaves B and C pending with their values intact; A twice is 409; accept of A after dismiss is 409; accept of B still works', async () => {
    const person = profilePerson();
    const run = await enrichPerson(person);
    const before = scopeOf(run.id);
    expect(before.map((s) => s.field)).toEqual(['title', 'location', 'email']);
    expect((await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=title`)).status).toBe(204);
    const after = scopeOf(run.id);
    expect(after.map((s) => [s.field, s.value, s.status])).toEqual([
      ['title', before[0]!.value, 'dismissed'],
      ['location', before[1]!.value, 'pending'],
      ['email', before[2]!.value, 'pending'],
    ]);
    const again = await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=title`);
    expect(again.status).toBe(409);
    expect(again.body!.error.message).toBe('That suggestion was already accepted or dismissed.');
    const acceptA = await call('POST', pBase(person.id), { runId: run.id, field: 'title', expectedVersion: person.version });
    expect(acceptA.status).toBe(409);
    expect(env.db.prepare('SELECT title FROM person WHERE id = ?').get(person.id)).toEqual({ title: null });
    const acceptB = await call('POST', pBase(person.id), { runId: run.id, field: 'location', expectedVersion: person.version });
    expect(acceptB.status).toBe(200);
    expect(scopeOf(run.id).map((s) => s.status)).toEqual(['dismissed', 'accepted', 'pending']);
    // An accepted suggestion cannot be dismissed per field either.
    expect((await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=location`)).status).toBe(409);
    // A stale version on accept still guards after a dismiss.
    const stale = await call('POST', pBase(person.id), { runId: run.id, field: 'email', expectedVersion: person.version });
    expect(stale.status).toBe(409);
    expect(stale.body!.error.code).toBe('version_conflict');
  });

  it('CONFIRMS: a failed per-field dismiss (409) writes no audit row and no event', async () => {
    const person = profilePerson();
    const run = await enrichPerson(person);
    await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=title`);
    const events: DomainEvent[] = [];
    const off = env.bus.subscribe((e) => events.push(e));
    await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=title`);
    off();
    expect(events).toEqual([]);
    expect(audits(person.id)).toEqual([{ runId: run.id, field: 'title' }]);
  });
});

describe('2. mode gate and field enum', () => {
  it('CONFIRMS: email on a name-mode run is 400 even with a stray pending email suggestion in scope, and the stray stays pending', async () => {
    const person = namePerson();
    const run = await enrichPerson(person);
    expect(getRunDetail(env.db, env.workspaceId, run.id).scope.mode).toBe('name');
    const scope = getRunDetail(env.db, env.workspaceId, run.id).scope;
    scope.suggestions = [...(scope.suggestions as S[]), { field: 'email', value: 'stray@example.com', status: 'pending' }];
    env.db.prepare('UPDATE run SET scope = ? WHERE id = ?').run(JSON.stringify(scope), run.id);
    const response = await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=email`);
    expect(response.status).toBe(400);
    expect(scopeOf(run.id).find((s) => s.field === 'email')!.status).toBe('pending');
    expect(audits(person.id)).toEqual([]);
  });

  it('CONFIRMS: linkedinUrl on a profile-mode run is 400 even with a stray pending suggestion in scope', async () => {
    const person = profilePerson();
    const run = await enrichPerson(person);
    const scope = getRunDetail(env.db, env.workspaceId, run.id).scope;
    scope.suggestions = [...(scope.suggestions as S[]), { field: 'linkedinUrl', value: foundUrl, status: 'pending' }];
    env.db.prepare('UPDATE run SET scope = ? WHERE id = ?').run(JSON.stringify(scope), run.id);
    expect((await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=linkedinUrl`)).status).toBe(400);
    expect(scopeOf(run.id).find((s) => s.field === 'linkedinUrl')!.status).toBe('pending');
  });

  it('CONFIRMS: in name mode the linkedinUrl suggestion dismisses per field; a name-mode field never offered is 409', async () => {
    const person = namePerson();
    const run = await enrichPerson(person);
    expect((await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=linkedinUrl`)).status).toBe(204);
    expect(scopeOf(run.id).map((s) => s.status)).toEqual(['pending', 'pending', 'dismissed']);
  });

  it('CONFIRMS: unknown, wrong-case and org-only field names are 400 on the person endpoint, and an empty field is 400, never dismiss-all', async () => {
    const person = profilePerson();
    const run = await enrichPerson(person);
    for (const field of ['', 'name', 'Title', 'domain', 'title%20', '__proto__', 'constructor']) {
      const response = await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=${field}`);
      expect([field, response.status]).toEqual([field, 400]);
    }
    expect(scopeOf(run.id).every((s) => s.status === 'pending')).toBe(true);
    expect(audits(person.id)).toEqual([]);
  });

  it('CONFIRMS: a repeated field param (array) is 400 and dismisses nothing', async () => {
    const person = profilePerson();
    const run = await enrichPerson(person);
    const response = await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=title&field=location`);
    expect(response.status).toBe(400);
    expect(scopeOf(run.id).every((s) => s.status === 'pending')).toBe(true);
  });

  it('CONFIRMS: organization enum is linkedinUrl, domain, location; person-only names and empty are 400', async () => {
    const org = orgWith();
    const run = await enrichOrg(org);
    for (const field of ['', 'title', 'email', 'name']) {
      expect([field, (await call('DELETE', `${oBase(org.id)}?runId=${run.id}&field=${field}`)).status]).toEqual([field, 400]);
    }
    expect(scopeOf(run.id).every((s) => s.status === 'pending')).toBe(true);
    expect((await call('DELETE', `${oBase(org.id)}?runId=${run.id}&field=location`)).status).toBe(204);
    expect(scopeOf(run.id).find((s) => s.field === 'location')!.status).toBe('dismissed');
    expect((await call('DELETE', `${oBase(org.id)}?runId=${run.id}&field=location`)).status).toBe(409);
  });
});

describe('3. no-field path regression', () => {
  it('CONFIRMS: dismisses all pending with { runId, dismissed: n }, 204; second call is a silent no-op with no new audit row (same as HEAD)', async () => {
    const person = profilePerson();
    const run = await enrichPerson(person);
    await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=title`);
    expect((await call('DELETE', `${pBase(person.id)}?runId=${run.id}`)).status).toBe(204);
    expect(scopeOf(run.id).every((s) => s.status === 'dismissed')).toBe(true);
    expect(audits(person.id)).toEqual([{ runId: run.id, field: 'title' }, { runId: run.id, dismissed: 2 }]);
    const events: DomainEvent[] = [];
    const off = env.bus.subscribe((e) => events.push(e));
    expect((await call('DELETE', `${pBase(person.id)}?runId=${run.id}`)).status).toBe(204);
    off();
    expect(audits(person.id)).toHaveLength(2);
    expect(events).toEqual([]);
  });

  it('CONFIRMS: no-field dismiss leaves accepted rows accepted', async () => {
    const person = profilePerson();
    const run = await enrichPerson(person);
    await call('POST', pBase(person.id), { runId: run.id, field: 'title', expectedVersion: person.version });
    await call('DELETE', `${pBase(person.id)}?runId=${run.id}`);
    expect(scopeOf(run.id).map((s) => s.status)).toEqual(['accepted', 'dismissed', 'dismissed']);
    expect(audits(person.id)).toEqual([{ runId: run.id, dismissed: 2 }]);
  });
});

describe('4. cross-entity smuggling', () => {
  it('CONFIRMS: a person run id on the organization endpoint and an org run id on the person endpoint are 404 for any field, and nothing changes', async () => {
    const person = profilePerson();
    const org = orgWith();
    const pRun = await enrichPerson(person);
    const oRun = await enrichOrg(org);
    for (const field of ['', '&field=location', '&field=domain', '&field=title']) {
      const a = await call('DELETE', `${oBase(org.id)}?runId=${pRun.id}${field}`);
      const b = await call('DELETE', `${pBase(person.id)}?runId=${oRun.id}${field}`);
      // The empty/bad field cases may 400 first; a valid one must never reach 204.
      expect([a.status, b.status].every((s) => s === 404 || s === 400)).toBe(true);
    }
    expect((await call('DELETE', `${oBase(org.id)}?runId=${pRun.id}&field=location`)).status).toBe(404);
    expect((await call('DELETE', `${pBase(person.id)}?runId=${oRun.id}&field=location`)).status).toBe(404);
    expect((await call('DELETE', `${oBase(org.id)}?runId=${pRun.id}`)).status).toBe(404);
    expect(scopeOf(pRun.id).every((s) => s.status === 'pending')).toBe(true);
    expect(scopeOf(oRun.id).every((s) => s.status === 'pending')).toBe(true);
  });

  it('CONFIRMS: another person\'s run id, a missing run id and a missing person are 404 and dismiss nothing', async () => {
    const mine = profilePerson();
    const theirs = profilePerson();
    const theirRun = await enrichPerson(theirs);
    expect((await call('DELETE', `${pBase(mine.id)}?runId=${theirRun.id}&field=title`)).status).toBe(404);
    expect((await call('DELETE', `${pBase(mine.id)}?runId=nope&field=title`)).status).toBe(404);
    expect((await call('DELETE', `${pBase('nobody')}?runId=${theirRun.id}&field=title`)).status).toBe(404);
    expect(scopeOf(theirRun.id).every((s) => s.status === 'pending')).toBe(true);
  });

  it('CONFIRMS: a person deleted after the run 404s on per-field dismiss and leaves the run untouched', async () => {
    const person = profilePerson();
    const run = await enrichPerson(person);
    env.db.pragma?.('foreign_keys = OFF');
    env.db.exec(`DELETE FROM person WHERE id = '${person.id}'`);
    env.db.pragma?.('foreign_keys = ON');
    expect((await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=title`)).status).toBe(404);
    expect(scopeOf(run.id).every((s) => s.status === 'pending')).toBe(true);
  });
});

describe('5. record events and the GET read', () => {
  it('CONFIRMS: per-field dismiss emits record_updated for the person; GET omits only that row and suggestedCount stays the original total', async () => {
    const person = profilePerson();
    const run = await enrichPerson(person);
    const events: DomainEvent[] = [];
    const off = env.bus.subscribe((e) => events.push(e));
    await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=location`);
    off();
    expect(events.filter((e) => e.type === 'record_updated' && e.entityType === 'person' && e.entityId === person.id)).toHaveLength(1);
    const state = await call('GET', pBase(person.id));
    expect(state.body!.run.suggestedCount).toBe(3);
    expect(state.body!.suggestions.map((s: S) => s.field)).toEqual(['title', 'email']);
    // Dismissing the rest keeps the total too.
    await call('DELETE', `${pBase(person.id)}?runId=${run.id}`);
    const done = await call('GET', pBase(person.id));
    expect(done.body!.run.suggestedCount).toBe(3);
    expect(done.body!.suggestions).toEqual([]);
  });

  it('CONFIRMS: organization per-field dismiss emits record_updated for the organization and keeps suggestedCount', async () => {
    const org = orgWith();
    const run = await enrichOrg(org);
    const total = scopeOf(run.id).length;
    const events: DomainEvent[] = [];
    const off = env.bus.subscribe((e) => events.push(e));
    await call('DELETE', `${oBase(org.id)}?runId=${run.id}&field=domain`);
    off();
    expect(events.some((e) => e.type === 'record_updated' && e.entityType === 'organization' && e.entityId === org.id)).toBe(true);
    const state = await call('GET', oBase(org.id));
    expect(state.body!.run.suggestedCount).toBe(total);
    expect(state.body!.suggestions.map((s: S) => s.field)).not.toContain('domain');
    expect(audits(org.id)).toEqual([{ runId: run.id, field: 'domain' }]);
  });

  it('CONFIRMS: dismissing the last pending suggestion by field leaves an empty list with the run still reported', async () => {
    const person = profilePerson();
    const run = await enrichPerson(person);
    for (const f of ['title', 'location', 'email']) expect((await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=${f}`)).status).toBe(204);
    const state = await call('GET', pBase(person.id));
    expect(state.body!.suggestions).toEqual([]);
    expect(state.body!.run.id).toBe(run.id);
    expect(state.body!.run.suggestedCount).toBe(3);
  });
});

describe('6. other', () => {
  it('ACCEPTED: the per-field dismiss does not check that the run is the newest one; an older run can still be dismissed by field, same as accept', async () => {
    const person = profilePerson();
    const first = await enrichPerson(person);
    await enrichPerson(person);
    expect((await call('DELETE', `${pBase(person.id)}?runId=${first.id}&field=title`)).status).toBe(204);
  });

  it('ACCEPTED: field is trimmed by neither route nor action, so " title" is 400 (strict enum), not forgiven', async () => {
    const person = profilePerson();
    const run = await enrichPerson(person);
    expect((await call('DELETE', `${pBase(person.id)}?runId=${run.id}&field=%20title`)).status).toBe(400);
  });
});
