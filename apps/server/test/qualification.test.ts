import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFieldClaim, createOrganization, createPerson, startRun } from '../src/actions/index.js';
import { buildApp } from '../src/http/app.js';
import { type Criterion, defaultQualificationConfig } from '../src/qualification/config.js';
import { evaluateCriterion, evaluatePerson, type ClaimFact, type PersonFacts } from '../src/qualification/evaluate.js';
import { getRunDetail } from '../src/queries/runs.js';
import { seedDatabase } from '../src/seed/seed.js';
import { createTestEnvironment, driveRun } from './helpers.js';

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

async function call(method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, payload: payload as object | undefined, headers: { host: '127.0.0.1:4720' } });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

const now = '2026-03-10T00:00:00.000Z';

function facts(overrides: Partial<PersonFacts> = {}): PersonFacts {
  return {
    person: { name: 'Ada Quill', title: 'Managing Partner', location: 'Port Alder', email: 'ada@example.com', tags: ['Seed', 'angel'] },
    organization: { name: 'Northwind', kind: 'fund', domain: 'northwind.example.com', location: null, tags: [] },
    personClaim: () => undefined,
    organizationClaim: () => undefined,
    ...overrides,
  };
}

function criterion(overrides: Partial<Criterion>): Criterion {
  return { id: 'c1', label: 'Test', target: 'person', field: 'title', operator: 'contains', values: ['partner'], enabled: true, ...overrides };
}

describe('qualification config', () => {
  it('returns the template defaults, marked as defaults, until something is saved', async () => {
    const response = await call('GET', '/api/qualification');
    expect(response.status).toBe(200);
    expect(response.body.defaulted).toBe(true);
    const defaults = defaultQualificationConfig();
    expect(response.body.exclusions).toEqual(defaults.exclusions);
    expect(response.body.criteria).toEqual(defaults.criteria);
    expect(response.body.exclusions[0]).toMatchObject({ target: 'person', field: 'tags', operator: 'contains', values: ['do-not-contact'] });
    expect(response.body.criteria.map((entry: Criterion) => [entry.target, entry.field, entry.operator, entry.values])).toEqual([
      ['organization', 'kind', 'equals', ['fund']],
      ['person', 'title', 'contains', ['partner', 'principal', 'scout', 'head of']],
      ['person', 'tags', 'contains', ['seed']],
    ]);
  });

  it('rejects invalid configs and saves nothing', async () => {
    const valid = defaultQualificationConfig();
    const attempts: [string, unknown][] = [
      ['unknown field', { exclusions: [], criteria: [{ ...valid.criteria[0], field: 'phone' }] }],
      ['field the target cannot read', { exclusions: [], criteria: [{ ...valid.criteria[0], target: 'person', field: 'kind' }] }],
      ['unknown operator', { exclusions: [], criteria: [{ ...valid.criteria[0], operator: 'startsWith' }] }],
      ['no values', { exclusions: [], criteria: [{ ...valid.criteria[0], values: [] }] }],
      ['duplicate ids', { exclusions: [{ ...valid.exclusions[0], id: 'same' }], criteria: [{ ...valid.criteria[0], id: 'same' }] }],
      ['missing lists', { criteria: [] }],
      ['empty label', { exclusions: [], criteria: [{ ...valid.criteria[0], label: ' ' }] }],
    ];
    for (const [name, body] of attempts) {
      const response = await call('PUT', '/api/qualification', body);
      expect(response.status, name).toBe(400);
      expect(response.body.error.code, name).toBe('validation');
    }
    expect((await call('GET', '/api/qualification')).body.defaulted).toBe(true);
  });

  it('replaces the whole config, audits the change, and no longer says defaulted', async () => {
    const config = {
      exclusions: [],
      criteria: [
        { id: 'crt_ab12cd34', label: 'Has a title', target: 'person', field: 'title', operator: 'exists', enabled: true },
        { id: 'crt_ef56ab78', label: 'In Austin or Dublin', target: 'person', field: 'location', operator: 'in', values: ['Austin', 'Dublin'], enabled: false },
      ],
    };
    const saved = await call('PUT', '/api/qualification', config);
    expect(saved.status).toBe(200);
    expect(saved.body.criteria[0]).toEqual({ ...config.criteria[0], values: [] });
    expect(saved.body.defaulted).toBeUndefined();
    const read = await call('GET', '/api/qualification');
    expect(read.body).toEqual(saved.body);
    const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'qualification.update'").all() as { detail: string }[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail)).toEqual({ exclusions: 0, criteria: 2 });
    const again = await call('PUT', '/api/qualification', defaultQualificationConfig());
    expect(again.body.criteria).toHaveLength(3);
    expect(again.body.defaulted).toBeUndefined();
  });

  it('is written by the seed', () => {
    const seeded = createTestEnvironment();
    try {
      seedDatabase(seeded.db, { now: new Date('2026-03-01T12:00:00.000Z') });
      const row = seeded.db.prepare('SELECT settings FROM workspace').get() as { settings: string };
      expect(JSON.parse(row.settings).qualification).toEqual(defaultQualificationConfig());
    } finally {
      seeded.cleanup();
    }
  });
});

describe('evaluation', () => {
  it('matches case insensitively and cites the record when no claim exists', () => {
    const result = evaluateCriterion(criterion({}), facts(), now);
    expect(result.outcome).toBe('matched');
    expect(result.evidence).toEqual({ source: 'record', value: 'Managing Partner' });
    expect(result.reason).toContain('Record data, no claim.');
  });

  it('returns not_matched when the value is present and does not match', () => {
    const result = evaluateCriterion(criterion({ values: ['principal', 'scout'] }), facts(), now);
    expect(result.outcome).toBe('not_matched');
    expect(result.reason).toContain('does not match principal or scout');
  });

  it('returns unknown for a missing field, an empty tag list, and a missing organization, never a match', () => {
    const noTitle = facts({ person: { ...facts().person, title: null } });
    expect(evaluateCriterion(criterion({}), noTitle, now)).toMatchObject({ outcome: 'unknown', evidence: null });
    expect(evaluateCriterion(criterion({ operator: 'exists' }), noTitle, now).outcome).toBe('unknown');
    const noTags = facts({ person: { ...facts().person, tags: [] } });
    expect(evaluateCriterion(criterion({ field: 'tags', values: ['seed'] }), noTags, now).outcome).toBe('unknown');
    const noOrg = facts({ organization: null });
    const orgResult = evaluateCriterion(criterion({ target: 'organization', field: 'kind', operator: 'equals', values: ['fund'] }), noOrg, now);
    expect(orgResult).toMatchObject({ outcome: 'unknown', evidence: null });
    expect(orgResult.reason).toContain('no organization');
  });

  it('supports equals, in, and exists on strings and tags', () => {
    expect(evaluateCriterion(criterion({ field: 'location', operator: 'equals', values: ['port alder'] }), facts(), now).outcome).toBe('matched');
    expect(evaluateCriterion(criterion({ field: 'location', operator: 'in', values: ['Austin', 'Dublin'] }), facts(), now).outcome).toBe('not_matched');
    expect(evaluateCriterion(criterion({ field: 'tags', operator: 'equals', values: ['SEED'] }), facts(), now).outcome).toBe('matched');
    expect(evaluateCriterion(criterion({ field: 'tags', operator: 'contains', values: ['see'] }), facts(), now).outcome).toBe('matched');
    expect(evaluateCriterion(criterion({ field: 'email', operator: 'exists', values: [] }), facts(), now).outcome).toBe('matched');
    expect(evaluateCriterion(criterion({ target: 'organization', field: 'kind', operator: 'equals', values: ['fund'] }), facts(), now).outcome).toBe('matched');
  });

  it('cites the newest claim with its status and age when it agrees with the record', () => {
    const claim: ClaimFact = { id: 'clm_aaaaaaaaaaaa', value: 'managing partner', status: 'corroborated', observedAt: '2026-02-28T00:00:00.000Z' };
    const result = evaluateCriterion(criterion({}), facts({ personClaim: (field) => (field === 'title' ? claim : undefined) }), now);
    expect(result.outcome).toBe('matched');
    expect(result.evidence).toEqual({ source: 'claim', claimId: claim.id, status: 'corroborated', observedAt: claim.observedAt, ageDays: 10, value: 'managing partner' });
    expect(result.reason).toContain('Newest title claim is corroborated, observed 10 days ago.');
  });

  it('falls back to record data when the newest claim disagrees with the record, and says so', () => {
    const claim: ClaimFact = { id: 'clm_bbbbbbbbbbbb', value: 'Associate', status: 'extracted', observedAt: now };
    const result = evaluateCriterion(criterion({}), facts({ personClaim: () => claim }), now);
    expect(result.evidence).toEqual({ source: 'record', value: 'Managing Partner' });
    expect(result.reason).toContain('differs from the record');
  });

  it('marks excluded people with reasons and still computes every criterion', () => {
    const config = defaultQualificationConfig();
    const excluded = evaluatePerson(config, facts({ person: { ...facts().person, tags: ['seed', 'do-not-contact'] } }), now);
    expect(excluded.excluded).toBe(true);
    expect(excluded.excludedReasons).toHaveLength(1);
    expect(excluded.excludedReasons[0]).toContain('Tagged do not contact');
    expect(excluded).toMatchObject({ matched: 3, total: 3, unknown: 0, computedAt: now });
    expect(excluded.criteria.map((entry) => entry.outcome)).toEqual(['matched', 'matched', 'matched']);

    const clear = evaluatePerson(config, facts(), now);
    expect(clear).toMatchObject({ excluded: false, excludedReasons: [] });
  });

  it('skips disabled rules', () => {
    const config = defaultQualificationConfig();
    config.criteria[0]!.enabled = false;
    config.exclusions[0]!.enabled = false;
    const result = evaluatePerson(config, facts({ person: { ...facts().person, tags: ['do-not-contact'] } }), now);
    expect(result.total).toBe(2);
    expect(result.excluded).toBe(false);
    expect(result.criteria.map((entry) => entry.id)).toEqual(['crit-title-investing-role', 'crit-tag-seed']);
  });
});

describe('qualify run', () => {
  const people: Record<string, { id: string; organizationId: string | null }> = {};

  it('evaluates everyone, writes results, and reports honest counts', async () => {
    await call('PUT', '/api/qualification', defaultQualificationConfig());
    const fund = createOrganization(env.ctx, { name: 'Northwind', domain: 'northwind.example.com', kind: 'fund' });
    const company = createOrganization(env.ctx, { name: 'Brightco', domain: 'brightco.example.com', kind: 'company' });
    const make = (key: string, input: Parameters<typeof createPerson>[1]) => {
      const person = createPerson(env.ctx, input);
      people[key] = { id: person.id, organizationId: person.organizationId };
    };
    // Matches all three criteria, with claims for the title.
    make('perfect', { firstName: 'Ada', lastName: 'Perfect', email: 'ada@northwind.example.com', title: 'General Partner', organizationId: fund.id, tags: ['seed'] });
    createFieldClaim(env.ctx, { entityType: 'person', entityId: people.perfect!.id, field: 'title', value: 'General partner', sourceUrl: 'https://example.com/ada', sourceType: 'web_page', status: 'corroborated', observedAt: '2026-02-25T00:00:00.000Z' });
    // Matches two, fails the title.
    make('partial', { firstName: 'Ben', lastName: 'Partial', email: 'ben@northwind.example.com', title: 'Associate', organizationId: fund.id, tags: ['seed'] });
    // No title and no organization: unknown on two criteria.
    make('sparse', { firstName: 'Cy', lastName: 'Sparse', email: 'cy@example.com', title: null, organizationId: null, tags: ['seed'] });
    // Matches everything but is excluded.
    make('blocked', { firstName: 'Dee', lastName: 'Blocked', email: 'dee@northwind.example.com', title: 'Principal', organizationId: fund.id, tags: ['seed', 'do-not-contact'] });
    make('company', { firstName: 'Eve', lastName: 'Company', email: 'eve@brightco.example.com', title: 'Head of Finance', organizationId: company.id, tags: ['angel'] });

    const started = await call('POST', '/api/runs', { kind: 'qualify' });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ kind: 'qualify', status: 'queued', simulated: false, scope: {}, title: 'Qualify people' });
    expect(driveRun(env, started.body.id, ['succeeded'])).toBe('succeeded');

    const run = getRunDetail(env.db, env.workspaceId, started.body.id);
    expect(run.approvals).toEqual([]);
    expect(run.steps.map((step) => step.status)).toEqual(['done', 'done', 'done']);
    expect(run.counts).toEqual({ processed: 5, found: 2, flagged: 1, excluded: 1 });

    const perfect = (await call('GET', `/api/people/${people.perfect!.id}`)).body.qualification;
    expect(perfect).toMatchObject({ excluded: false, excludedReasons: [], matched: 3, total: 3, unknown: 0 });
    expect(perfect.criteria.map((entry: { id: string; outcome: string }) => [entry.id, entry.outcome])).toEqual([
      ['crit-org-fund', 'matched'],
      ['crit-title-investing-role', 'matched'],
      ['crit-tag-seed', 'matched'],
    ]);
    const title = perfect.criteria[1];
    expect(title.evidence).toMatchObject({ source: 'claim', status: 'corroborated' });
    expect(title.reason).toContain('corroborated');
    expect(perfect.criteria[0].evidence).toEqual({ source: 'record', value: 'fund' });

    const sparse = (await call('GET', `/api/people/${people.sparse!.id}`)).body.qualification;
    expect(sparse).toMatchObject({ matched: 1, total: 3, unknown: 2 });
    expect(sparse.criteria.map((entry: { outcome: string }) => entry.outcome)).toEqual(['unknown', 'unknown', 'matched']);

    const blocked = (await call('GET', `/api/people/${people.blocked!.id}`)).body.qualification;
    expect(blocked).toMatchObject({ excluded: true, matched: 3, total: 3 });
    expect(blocked.excludedReasons).toHaveLength(1);

    const list = (await call('GET', '/api/people?limit=50')).body.items;
    const byId = new Map(list.map((item: { id: string; qualification: unknown }) => [item.id, item.qualification]));
    const computedAt = (await call('GET', `/api/people/${people.partial!.id}`)).body.qualification.computedAt;
    expect(computedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(byId.get(people.partial!.id)).toEqual({ matched: 2, total: 3, unknown: 0, excluded: false, computedAt });
    expect(byId.get(people.blocked!.id)).toEqual({
      matched: 3,
      total: 3,
      unknown: 0,
      excluded: true,
      computedAt: (await call('GET', `/api/people/${people.blocked!.id}`)).body.qualification.computedAt,
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM qualification_result').get()).toEqual({ n: 5 });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'qualification.compute'").get()).toEqual({ n: 1 });
  });

  it('does not change person records', () => {
    const row = env.db.prepare('SELECT version, title, tags FROM person WHERE id = ?').get(people.perfect!.id) as { version: number; title: string };
    expect(row.version).toBe(1);
    expect(row.title).toBe('General Partner');
  });

  it('orders by fit, keeps the cursor working across pages, and puts excluded and never qualified people last', async () => {
    const late = createPerson(env.ctx, { firstName: 'Zed', lastName: 'Late', email: 'zed@example.com', tags: [] });
    expect((await call('GET', `/api/people/${late.id}`)).body.qualification).toBeNull();
    const everyone = (await call('GET', '/api/people?sort=fit&limit=50')).body;
    const names = everyone.items.map((item: { name: string }) => item.name);
    // Not excluded: perfect (3 matched), partial (2 matched), then company and sparse tie on 1 matched, so the one with fewer unknowns (company, 0) comes first.
    // Then excluded: blocked. Then never qualified: Zed Late.
    expect(names).toEqual(['Ada Perfect', 'Ben Partial', 'Eve Company', 'Cy Sparse', 'Dee Blocked', 'Zed Late']);
    expect(everyone.items.at(-1).qualification).toBeNull();

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { items: { name: string }[]; nextCursor: string | null } = (
        await call('GET', `/api/people?sort=fit&limit=2${cursor ? `&cursor=${cursor}` : ''}`)
      ).body as never;
      collected.push(...page.items.map((item) => item.name));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(collected).toEqual(names);

    const byName = (await call('GET', '/api/people?limit=50')).body.items.map((item: { name: string }) => item.name);
    expect(byName).toEqual(['Dee Blocked', 'Eve Company', 'Zed Late', 'Ben Partial', 'Ada Perfect', 'Cy Sparse']);
    expect((await call('GET', '/api/people?sort=other')).status).toBe(400);
  });

  it('limits a run to people with a tag and finishes partial when no one has it', async () => {
    const scoped = await call('POST', '/api/runs', { kind: 'qualify', scope: { tag: 'ANGEL' } });
    expect(scoped.body.title).toBe('Qualify people tagged ANGEL');
    driveRun(env, scoped.body.id, ['succeeded']);
    expect(getRunDetail(env.db, env.workspaceId, scoped.body.id).counts).toEqual({ processed: 1, found: 0, flagged: 0, excluded: 0 });

    const empty = await call('POST', '/api/runs', { kind: 'qualify', scope: { tag: 'no-such-tag' } });
    expect(driveRun(env, empty.body.id, ['partial'])).toBe('partial');
    const detail = getRunDetail(env.db, env.workspaceId, empty.body.id);
    expect(detail.counts).toEqual({ processed: 0, found: 0, flagged: 0, excluded: 0 });
    expect(detail.steps.map((step) => step.status)).toEqual(['done', 'skipped', 'skipped']);

    expect((await call('POST', '/api/runs', { kind: 'qualify', scope: { other: 1 } })).status).toBe(400);
  });

  it('refreshes results when the run repeats and when an agent starts it', async () => {
    env.db.prepare("UPDATE person SET title = 'Partner' WHERE id = ?").run(people.partial!.id);
    const run = startRun(env.ctx, { kind: 'qualify' }, { origin: 'agent' });
    driveRun(env, run.id, ['succeeded']);
    const payload = (await call('GET', `/api/people/${people.partial!.id}`)).body.qualification;
    expect(payload.matched).toBe(3);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM qualification_result').get()).toEqual({ n: 6 });
  });

  it('processes more people than one chunk', async () => {
    for (let index = 0; index < 205; index += 1) {
      createPerson(env.ctx, { firstName: 'Bulk', lastName: `Person${String(index).padStart(3, '0')}`, email: `bulk${index}@example.com`, tags: ['bulk'] });
    }
    const run = startRun(env.ctx, { kind: 'qualify', scope: { tag: 'bulk' } });
    driveRun(env, run.id, ['succeeded'], 60);
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    expect(detail.counts.processed).toBe(205);
    expect(detail.steps[1]!.detail).toBe('Evaluated 205 of 205 people.');
  });
});
