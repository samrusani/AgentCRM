import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configureApifyConnector,
  controlRun,
  createFieldClaim,
  createPerson,
  decideApproval,
  recoverStaleJobs,
  startRun,
} from '../src/actions/index.js';
import {
  isLinkedinPostUrl,
  mapEngagementItem,
  mapProfileItem,
  normalizeProfileUrl,
} from '../src/actions/leadCaptureMapping.js';
import { advanceLeadCaptureRun } from '../src/actions/leadCapture.js';
import { AppError } from '../src/errors.js';
import { buildApp } from '../src/http/app.js';
import { processAllJobs } from '../src/jobs/worker.js';
import { getRunDetail } from '../src/queries/runs.js';
import { type ApifyStub, startApifyStub, stubToken, useStub } from './apifyStub.js';
import { createTestEnvironment, driveRunAsync } from './helpers.js';
import {
  commentItems,
  commentsActorId,
  postUrl,
  profileActorId,
  profileItems,
  reactionItems,
  reactionsActorId,
} from './leadCaptureFixtures.js';

const env = createTestEnvironment();
let stub: ApifyStub;
let restore: () => void;
let app: FastifyInstance;

const fullAllowlist = [
  'harvestapi/linkedin-post-reactions',
  'harvestapi/linkedin-post-comments',
  'harvestapi/linkedin-profile-scraper',
];

beforeAll(async () => {
  stub = await startApifyStub();
  restore = useStub(stub);
  await configureApifyConnector(env.ctx, { token: stubToken, allowlist: fullAllowlist });
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

beforeEach(async () => {
  // Earlier tests may leave runs open, and agent started ones hold the single slot. Close everything unfinished.
  for (const row of env.db
    .prepare("SELECT id FROM run WHERE status IN ('queued', 'running', 'paused', 'waiting_approval')")
    .all() as { id: string }[]) {
    controlRun(env.ctx, row.id, { action: 'cancel' });
  }
  await processAllJobs(env.ctx);
  // Approved imports create people. Each test starts without them.
  env.db.exec('DELETE FROM field_claim; DELETE FROM person; DELETE FROM organization;');
  stub.reset();
  stub.state.actorItems[reactionsActorId] = reactionItems;
  stub.state.actorItems[commentsActorId] = commentItems;
  stub.state.actorItems[profileActorId] = profileItems;
  await configureApifyConnector(env.ctx, {
    token: stubToken,
    allowlist: fullAllowlist,
    leadCapture: { reactionsActor: '', commentsActor: '', profileActor: '' },
  });
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

function failure(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'none';
}

function detailOf(runId: string) {
  return getRunDetail(env.db, env.workspaceId, runId);
}

async function putConnector(payload: unknown) {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/connectors/apify',
    headers: { host: '127.0.0.1:4720' },
    payload: payload as object,
  });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

async function listedApify() {
  const response = await app.inject({ method: 'GET', url: '/api/connectors', headers: { host: '127.0.0.1:4720' } });
  return (response.json().items as Record<string, any>[]).find((item) => item.kind === 'apify')!;
}

async function tick(times: number, milliseconds = 1000) {
  for (let index = 0; index < times; index += 1) {
    env.advance(milliseconds);
    await processAllJobs(env.ctx);
  }
}

// Drives until the run is polling the call with this key, so tests can act mid poll.
async function untilCall(runId: string, key: 'reactions' | 'comments' | 'enrich') {
  for (let index = 0; index < 40; index += 1) {
    const call = (detailOf(runId).scope.calls as Record<string, { apifyRunId?: string }>)[key];
    if (call?.apifyRunId) return call.apifyRunId;
    await tick(1);
  }
  throw new Error(`The ${key} call never started.`);
}

describe('post URL validation', () => {
  const accepted = [
    'https://www.linkedin.com/posts/jane-doe_topic-activity-7100000000000000001-AbCd',
    'https://www.linkedin.com/posts/jane-doe_topic-activity-7100000000000000001-AbCd?utm_source=share&utm_medium=member_desktop',
    'https://linkedin.com/posts/jane-doe-ugcPost-7100000000000000002-Xy_z/',
    'https://uk.linkedin.com/posts/jane-doe_topic-activity-7100000000000000001',
    'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001',
    'https://www.linkedin.com/feed/update/urn:li:ugcPost:7100000000000000002/',
    'https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A7100000000000000001?utm_source=share',
    'http://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001',
    'https://www.linkedin.com/posts/jane-doe_topic-share-7100000000000000003-AbCd',
    'https://www.linkedin.com/posts/jane-doe_topic-share-7100000000000000003',
    'https://www.linkedin.com/feed/update/urn:li:share:7100000000000000003',
    'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7100000000000000003/?utm_source=share',
  ];
  const rejected = [
    '',
    'not a url',
    'www.linkedin.com/posts/jane-doe_topic-activity-7100000000000000001-AbCd',
    'https://www.linkedin.com/in/jane-doe',
    'https://www.linkedin.com/posts/jane-doe_topic-7100000000000000001',
    'https://www.linkedin.com/posts/jane-doe_topic-activity-abc',
    'https://www.linkedin.com/posts/jane-doe_topic-share-abc',
    'https://www.linkedin.com/feed/update/urn:li:share:abc',
    'https://www.linkedin.com/feed/update/urn:li:comment:7100000000000000001',
    'https://www.linkedin.com/feed/update/urn:li:activity:abc',
    'https://www.linkedin.com/feed/',
    'https://notlinkedin.com/posts/jane-doe_topic-activity-7100000000000000001',
    'https://linkedin.com.evil.example/posts/jane-doe_topic-activity-7100000000000000001',
    'https://user:pass@www.linkedin.com/posts/jane-doe_topic-activity-7100000000000000001',
    'ftp://www.linkedin.com/posts/jane-doe_topic-activity-7100000000000000001',
    `https://www.linkedin.com/posts/jane-doe_topic-activity-7100000000000000001-${'a'.repeat(500)}`,
  ];

  it('accepts the documented shapes', () => {
    for (const url of accepted) expect(isLinkedinPostUrl(url), url).toBe(true);
  });

  it('rejects everything else', () => {
    for (const url of rejected) expect(isLinkedinPostUrl(url), url).toBe(false);
    expect(isLinkedinPostUrl(undefined)).toBe(false);
    expect(isLinkedinPostUrl(42)).toBe(false);
  });

  it('refuses a bad URL when starting a run, with a sentence naming the accepted shapes', () => {
    const message = failure(() => startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl: 'https://example.com/post/1' } }));
    expect(message).toMatch(/^validation: scope\.postUrl: /);
    expect(message).toContain('linkedin.com/posts');
    expect(message).toContain('urn:li:activity');
    expect(message).toContain('ugcPost');
    expect(message).toContain('500 characters');
    expect(message).toContain('http:// or https://');
    expect(message).toContain('urn:li:share');
    expect(failure(() => startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl: rejected[rejected.length - 1]! } }))).toMatch(/^validation: /);
  });

  it('validates sources and limits', () => {
    const base = { postUrl };
    const bad = (scope: Record<string, unknown>) => failure(() => startRun(env.ctx, { kind: 'lead_capture', scope: { ...base, ...scope } }));
    expect(bad({ sources: [] })).toMatch(/^validation: scope\.sources/);
    expect(bad({ sources: ['likes'] })).toMatch(/^validation: /);
    expect(bad({ maxPeople: 501 })).toMatch(/^validation: scope\.maxPeople/);
    expect(bad({ maxPeople: 0 })).toMatch(/^validation: scope\.maxPeople/);
    expect(bad({ enrichLimit: 201 })).toMatch(/^validation: scope\.enrichLimit/);
    expect(bad({ enrich: 'yes' })).toMatch(/^validation: scope\.enrich/);
    expect(bad({ extra: true })).toMatch(/^validation: /);
  });

  it('applies the defaults and keeps sources in a fixed order', () => {
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    expect(run.scope).toMatchObject({
      postUrl,
      sources: ['reactions', 'comments'],
      maxPeople: 50,
      enrich: true,
      enrichLimit: 25,
      actors: {
        reactions: 'harvestapi/linkedin-post-reactions',
        comments: 'harvestapi/linkedin-post-comments',
        profile: 'harvestapi/linkedin-profile-scraper',
      },
      calls: {},
    });
    expect(run.simulated).toBe(false);
    expect(run.counts).toMatchObject({ requested: 100, fetched: 0 });
    const reordered = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['comments', 'reactions', 'comments'], enrich: false } });
    expect(reordered.scope.sources).toEqual(['reactions', 'comments']);
    expect(reordered.counts).toMatchObject({ requested: 100 });
  });

  it('needs a connected Apify account', async () => {
    await app.inject({ method: 'DELETE', url: '/api/connectors/apify', headers: { host: '127.0.0.1:4720' } });
    try {
      expect(failure(() => startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } }))).toMatch(/^conflict: Apify is not connected/);
    } finally {
      await configureApifyConnector(env.ctx, { token: stubToken, allowlist: fullAllowlist });
    }
  });
});

describe('lead capture mapping', () => {
  it('maps engagement items from the actor shape and the author fallback', () => {
    expect(mapEngagementItem(reactionItems[0])).toEqual({
      name: 'Ada Quill',
      firstName: 'Ada',
      lastName: 'Quill',
      email: null,
      company: null,
      domain: null,
      title: 'Partner at Northwind Labs',
      location: null,
      linkedinUrl: 'https://www.linkedin.com/in/ada-quill',
    });
    expect(mapEngagementItem(commentItems[1])).toMatchObject({
      name: 'Eve Stone',
      title: 'Operator',
      linkedinUrl: 'https://www.linkedin.com/in/eve-stone',
    });
    // The URL is kept only when it is a LinkedIn URL.
    expect(mapEngagementItem({ actor: { name: 'Gus Hale', linkedinUrl: 'https://example.com/gus' } }).linkedinUrl).toBeNull();
    expect(mapEngagementItem({ actor: {} })).toMatchObject({ name: null, linkedinUrl: null });
    expect(mapEngagementItem('text')).toMatchObject({ name: null });
  });

  it('keeps an engagement URL only when it parses as http or https on linkedin.com or a subdomain', () => {
    const urlOf = (linkedinUrl: string) => mapEngagementItem({ actor: { name: 'Gus Hale', linkedinUrl } }).linkedinUrl;
    expect(urlOf('https://www.linkedin.com/in/gus-hale')).toBe('https://www.linkedin.com/in/gus-hale');
    expect(urlOf('http://uk.linkedin.com/in/gus-hale')).toBe('http://uk.linkedin.com/in/gus-hale');
    expect(urlOf('https://linkedin.com/in/gus-hale')).toBe('https://linkedin.com/in/gus-hale');
    expect(urlOf('https://example.com/redirect?to=linkedin.com/in/gus-hale')).toBeNull();
    expect(urlOf('https://linkedin.com.evil.example/in/gus-hale')).toBeNull();
    expect(urlOf('https://notlinkedin.com/in/gus-hale')).toBeNull();
    expect(urlOf('ftp://www.linkedin.com/in/gus-hale')).toBeNull();
    expect(urlOf('linkedin.com/in/gus-hale')).toBeNull();
  });

  it('reads every person field from the actor object when it exists, never mixing it with the author object', () => {
    expect(
      mapEngagementItem({
        actor: { name: 'Ida Fox' },
        author: { name: 'Other Name', headline: 'Other headline', profile_url: 'https://www.linkedin.com/in/other-name' },
      }),
    ).toMatchObject({ name: 'Ida Fox', title: null, linkedinUrl: null });
    expect(
      mapEngagementItem({
        actor: { position: 'Chair', linkedinUrl: 'https://www.linkedin.com/in/ida-fox' },
        author: { name: 'Other Name' },
      }),
    ).toMatchObject({ name: null, title: 'Chair', linkedinUrl: 'https://www.linkedin.com/in/ida-fox' });
    expect(mapEngagementItem({ author: { name: 'Eve Stone', headline: 'Operator', profile_url: 'https://www.linkedin.com/in/eve-stone' } })).toMatchObject({
      name: 'Eve Stone',
      title: 'Operator',
      linkedinUrl: 'https://www.linkedin.com/in/eve-stone',
    });
  });

  it('maps nested and flat profile shapes', () => {
    expect(mapProfileItem(profileItems[0])).toMatchObject({
      name: 'Ben Marsh',
      firstName: 'Ben',
      lastName: 'Marsh',
      title: 'Principal at Harbor Row',
      company: 'Harbor Row',
      location: 'Port Alder, Aurelia',
      linkedinUrl: 'https://www.linkedin.com/in/ben-marsh',
    });
    expect(mapProfileItem(profileItems[2])).toMatchObject({
      name: 'Dan Orr',
      email: 'dan.orr@orrcapital.example.com',
      company: 'Orr Capital',
      title: 'Analyst at Orr Capital',
    });
    // The organization domain comes only from explicit company fields, never from a personal website or url.
    expect(mapProfileItem({ name: 'Ann Lee', company: 'Acme', website: 'ann.dev' }).domain).toBeNull();
    expect(mapProfileItem({ name: 'Ann Lee', company: 'Acme', website: 'https://ann.dev', url: 'https://ann.dev/about', domain: 'ann.dev' }).domain).toBeNull();
    expect(mapProfileItem({ name: 'Ann Lee', company: 'Acme', companyWebsite: 'https://www.acme.example.com/about' }).domain).toBe('acme.example.com');
    expect(mapProfileItem({ name: 'Ann Lee', company: 'Acme', company_domain: 'acme.example.com', website: 'ann.dev' }).domain).toBe('acme.example.com');
    expect(mapProfileItem({ name: 'Ann Lee', companyDomain: 'https://www.linkedin.com/company/acme' }).domain).toBeNull();
    // Flat fields win over the nested fallbacks.
    expect(mapProfileItem({ name: 'Hal Reed', title: 'CTO', company: 'Reed Co', headline: 'Other', currentPosition: [{ companyName: 'Elsewhere' }] })).toMatchObject({
      title: 'CTO',
      company: 'Reed Co',
    });
  });

  it('normalizes profile URLs', () => {
    // The host is case insensitive. The profile id keeps its case because some ids are case sensitive.
    expect(normalizeProfileUrl('https://www.LinkedIn.com/in/Ada-Quill/?trk=x#frag')).toBe('/in/Ada-Quill');
    expect(normalizeProfileUrl('https://WWW.LINKEDIN.COM/in/ACoAABxYz')).toBe('/in/ACoAABxYz');
    expect(normalizeProfileUrl('https://www.linkedin.com/in/ACoAABxYz')).not.toBe(normalizeProfileUrl('https://www.linkedin.com/in/acoaabxyz'));
    expect(normalizeProfileUrl('linkedin.com/in/ada-quill')).toBe('/in/ada-quill');
    expect(normalizeProfileUrl('https://uk.linkedin.com/in/ada-quill/details/')).toBe('/in/ada-quill');
    expect(normalizeProfileUrl('https://www.linkedin.com/company/northwind')).toBeNull();
    expect(normalizeProfileUrl('https://example.com/in/ada-quill')).toBeNull();
    expect(normalizeProfileUrl(null)).toBeNull();
    expect(normalizeProfileUrl('')).toBeNull();
  });
});

describe('lead capture run', () => {
  it('runs all eight steps, merges both sources into one row per person, and creates records only after approval', async () => {
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    expect(run.status).toBe('queued');
    expect(run.steps.map((step) => step.title)).toEqual([
      'Validate connector, post URL, and limits',
      'Scrape reactions through Apify',
      'Scrape comments through Apify',
      'Stage people from the post',
      'Check for duplicates',
      'Enrich new profiles through Apify',
      'Merge enriched details',
      'Request import review',
    ]);
    const peopleBefore = count('person');
    expect(await driveRunAsync(env, run.id, ['waiting_approval'])).toBe('waiting_approval');
    const waiting = detailOf(run.id);
    expect(waiting.steps.every((step) => step.status === 'done')).toBe(true);
    for (const step of waiting.steps) expect(step.detail, step.title).toBeTruthy();

    // Three billed starts, one per actor, in order.
    expect(stub.state.startActors).toEqual([reactionsActorId, commentsActorId, profileActorId]);
    expect(stub.state.startCalls).toBe(3);
    expect(stub.state.startBodies[0]).toEqual({ posts: [postUrl], maxItems: 50 });
    expect(stub.state.startBodies[1]).toEqual({ posts: [postUrl], maxItems: 50 });
    expect(stub.state.startQueries[0]).toContain('maxItems=50');
    const enrichInput = stub.state.startBodies[2] as { queries: string[]; profileUrls: string[]; usernames: string[] };
    expect(enrichInput.queries).toEqual([
      'https://www.linkedin.com/in/ada-quill',
      'https://www.linkedin.com/in/ben-marsh/?trk=feed',
      'https://www.linkedin.com/in/cara-voss',
      'https://www.linkedin.com/in/dan-orr',
      'https://www.linkedin.com/in/eve-stone',
    ]);
    expect(enrichInput.profileUrls).toEqual(enrichInput.queries);
    expect(enrichInput.usernames).toEqual(enrichInput.queries);
    expect(stub.state.startQueries[2]).toContain('maxItems=5');

    // Calls are tracked per actor run.
    const calls = waiting.scope.calls as Record<string, Record<string, unknown>>;
    expect(calls.reactions).toMatchObject({ actorId: 'harvestapi/linkedin-post-reactions', apifyRunId: 'run_1', finished: true, itemCount: 4 });
    expect(calls.comments).toMatchObject({ apifyRunId: 'run_2', finished: true, itemCount: 4 });
    expect(calls.enrich).toMatchObject({ apifyRunId: 'run_3', finished: true, itemCount: 4 });
    expect(calls.reactions!.startAttemptedAt).toBeTruthy();
    expect(waiting.scope.batchId).toBeTruthy();

    // Seven rows: Ada merged across both sources, Eve, Fay, and one item that names nobody.
    expect(waiting.counts).toMatchObject({ requested: 100, fetched: 7, staged: 6, duplicates: 0, invalid: 1, accepted: 0 });
    expect(waiting.steps[3]!.detail).toContain('Fetched 4 reactions and 4 comments');
    expect(waiting.steps[3]!.detail).toContain('6 unique people');
    expect(waiting.steps[6]!.detail).toContain('Matched 3 of 4 enrichment items');
    expect(waiting.steps[6]!.detail).toContain('1 item matched no staged person');
    expect(waiting.steps[6]!.detail).toContain('2 sent profiles got no usable item back');
    expect(count('person')).toBe(peopleBefore);

    const batchId = waiting.scope.batchId as string;
    const batch = env.db.prepare('SELECT * FROM import_batch WHERE id = ?').get(batchId) as Record<string, any>;
    expect(batch.source_kind).toBe('lead_capture');
    expect(JSON.parse(batch.source_ref)).toEqual({
      postUrl,
      actors: {
        reactions: 'harvestapi/linkedin-post-reactions',
        comments: 'harvestapi/linkedin-post-comments',
        profile: 'harvestapi/linkedin-profile-scraper',
      },
      apifyRunIds: { reactions: 'run_1', comments: 'run_2', enrich: 'run_3' },
    });
    const rows = (env.db.prepare('SELECT * FROM import_row WHERE batch_id = ? ORDER BY seq').all(batchId) as Record<string, any>[]).map((row): Record<string, any> => ({
      ...row,
      raw: JSON.parse(row.raw) as Record<string, any>,
      mapped: JSON.parse(row.mapped) as Record<string, any>,
    }));
    expect(rows.map((row) => row.mapped.name)).toEqual(['Ada Quill', 'Ben Marsh', 'Cara Voss', 'Dan Orr', 'Eve Stone', 'Fay Nolan', null]);
    expect(rows.map((row) => row.status)).toEqual(['staged', 'staged', 'staged', 'staged', 'staged', 'staged', 'invalid']);
    expect(rows[6]!.reason).toContain('No name or profile URL');

    const ada = rows[0]!;
    expect(ada.raw.engagement).toHaveLength(2);
    expect(ada.raw.sources).toHaveLength(2);
    expect(ada.raw.sources[0]).toEqual({ kind: 'reaction', reactionType: 'LIKE' });
    expect(ada.raw.sources[1].kind).toBe('comment');
    expect(ada.raw.sources[1].commentary).toHaveLength(200);
    expect(ada.raw.engagement[1].item.commentary.length).toBeGreaterThan(200);
    expect(ada.raw).not.toHaveProperty('enrichment');
    // The reaction came first, so its title wins over the comment's.
    expect(ada.mapped.title).toBe('Partner at Northwind Labs');

    // Enrichment fills only empty fields and keeps the item.
    const ben = rows[1]!;
    expect(ben.mapped).toMatchObject({ title: 'Principal', company: 'Harbor Row', location: 'Port Alder, Aurelia' });
    expect(ben.raw.enrichment.publicIdentifier).toBe('ben-marsh');
    expect(ben.raw.fieldSources).toMatchObject({ name: 'reactions', title: 'reactions', company: 'enrich', location: 'enrich' });
    const dan = rows[3]!;
    expect(dan.mapped).toMatchObject({ email: 'dan.orr@orrcapital.example.com', company: 'Orr Capital', title: 'Analyst' });
    expect(rows[5]!.raw.fieldSources.name).toBe('comments');

    // Payload and approval.
    const approval = waiting.approvals[0]!;
    expect(approval.kind).toBe('import_review');
    const payload = approval.payload as Record<string, any>;
    expect(Object.keys(payload).sort()).toEqual(['actors', 'batchId', 'counts', 'postUrl', 'sample']);
    expect(payload.postUrl).toBe(postUrl);
    expect(payload.actors).toEqual(JSON.parse(batch.source_ref).actors);
    expect(payload.counts).toEqual({ fetched: 7, staged: 6, duplicates: 0, invalid: 1 });
    expect(approval.title).toBe('Review 6 people from a LinkedIn post');
    // The sample shows what is approved: name, email, company, title, and profile, for the first five rows.
    expect(payload.sample).toHaveLength(5);
    expect(payload.sample[0]).toEqual({
      name: 'Ada Quill',
      email: null,
      company: null,
      title: 'Partner at Northwind Labs',
      linkedinUrl: 'https://www.linkedin.com/in/ada-quill',
    });
    expect(payload.sample[3]).toEqual({
      name: 'Dan Orr',
      email: 'dan.orr@orrcapital.example.com',
      company: 'Orr Capital',
      title: 'Analyst',
      linkedinUrl: 'https://www.linkedin.com/in/dan-orr',
    });

    const decided = decideApproval(env.ctx, approval.id, { decision: 'approve' });
    expect(decided.run.status).toBe('succeeded');
    expect(decided.run.counts).toMatchObject({ fetched: 7, staged: 6, invalid: 1, accepted: 6 });
    expect(count('person')).toBe(peopleBefore + 6);

    const person = (first: string) => env.db.prepare('SELECT * FROM person WHERE first_name = ?').get(first) as Record<string, any>;
    expect(JSON.parse(person('Ben').tags)).toEqual(['linkedin-leads', `via-${run.id}`]);
    const benOrganization = env.db.prepare('SELECT * FROM organization WHERE id = ?').get(person('Ben').organization_id) as Record<string, any>;
    expect(benOrganization.name).toBe('Harbor Row');
    expect(JSON.parse(benOrganization.tags)).toEqual(['linkedin-leads', `via-${run.id}`]);

    const claim = (first: string, field: string) =>
      env.db.prepare("SELECT * FROM field_claim WHERE entity_id = ? AND field = ? AND entity_type = 'person'").get(person(first).id, field) as Record<string, any>;
    for (const [first, field, method] of [
      ['Ben', 'name', 'lead_capture:harvestapi/linkedin-post-reactions'],
      ['Ben', 'title', 'lead_capture:harvestapi/linkedin-post-reactions'],
      ['Ben', 'company', 'lead_capture:harvestapi/linkedin-profile-scraper'],
      ['Ben', 'location', 'lead_capture:harvestapi/linkedin-profile-scraper'],
      ['Dan', 'email', 'lead_capture:harvestapi/linkedin-profile-scraper'],
      ['Eve', 'name', 'lead_capture:harvestapi/linkedin-post-comments'],
      ['Fay', 'name', 'lead_capture:harvestapi/linkedin-post-comments'],
    ] as const) {
      const row = claim(first, field);
      expect(row.extraction_method, `${first} ${field}`).toBe(method);
      // Claims keep the post URL without its query and fragment. The run scope and batch keep it as given.
      expect(row.source_url).toBe(postUrl.split('?')[0]);
      expect(row.source_type).toBe('apify');
      expect(row.status).toBe('imported');
    }
    const orgClaim = env.db
      .prepare("SELECT * FROM field_claim WHERE entity_id = ? AND entity_type = 'organization' AND field = 'name'")
      .get(benOrganization.id) as Record<string, any>;
    expect(orgClaim.extraction_method).toBe('lead_capture:harvestapi/linkedin-profile-scraper');
    expect(claim('Ben', 'linkedinUrl').value).toBe('https://www.linkedin.com/in/ben-marsh/?trk=feed');
  });

  it('excludes known people before the enrichment call is made', async () => {
    const known = createPerson(env.ctx, { firstName: 'Ben', lastName: 'Marsh' });
    createFieldClaim(env.ctx, {
      entityType: 'person',
      entityId: known.id,
      field: 'linkedinUrl',
      value: 'https://LinkedIn.com/in/ben-marsh',
      sourceType: 'import',
      status: 'imported',
    });
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const waiting = detailOf(run.id);
    expect(waiting.steps[4]!.detail).toContain('Found 1 person who is already known');
    expect(waiting.counts).toMatchObject({ fetched: 7, staged: 5, duplicates: 1, invalid: 1 });
    const enrichInput = stub.state.startBodies[2] as { queries: string[] };
    expect(enrichInput.queries).toHaveLength(4);
    expect(enrichInput.queries.some((url) => url.includes('ben-marsh'))).toBe(false);
    const row = env.db.prepare('SELECT status, match_entity_id, reason FROM import_row WHERE batch_id = ? AND seq = 2').get(waiting.scope.batchId) as Record<string, string>;
    expect(row).toMatchObject({ status: 'duplicate', match_entity_id: known.id, reason: 'LinkedIn profile matches an existing person.' });
    expect(waiting.approvals[0]!.payload).toMatchObject({ counts: { fetched: 7, staged: 5, duplicates: 1, invalid: 1 } });
  });

  it('caps the enrichment batch at enrichLimit with one actor run for all of them', async () => {
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, enrichLimit: 2 } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const enrichInput = stub.state.startBodies[2] as { queries: string[] };
    expect(enrichInput.queries).toEqual(['https://www.linkedin.com/in/ada-quill', 'https://www.linkedin.com/in/ben-marsh/?trk=feed']);
    expect(stub.state.startActors.filter((actor) => actor === profileActorId)).toHaveLength(1);
    expect(detailOf(run.id).steps[6]!.detail).toContain('3 more new people were not sent because of the enrichment limit of 2');
  });

  it('re-checks duplicates after enrichment because a new email can reveal a known person', async () => {
    const known = createPerson(env.ctx, { firstName: 'Daniel', lastName: 'Orr', email: 'dan.orr@orrcapital.example.com' });
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const waiting = detailOf(run.id);
    expect(waiting.counts).toMatchObject({ fetched: 7, staged: 5, duplicates: 1, invalid: 1 });
    expect(waiting.steps[4]!.detail).toContain('Found 0 people who are already known');
    expect(waiting.steps[6]!.detail).toContain('1 person turned out to be already known after enrichment');
    const dan = env.db.prepare('SELECT status, match_entity_id, reason FROM import_row WHERE batch_id = ? AND seq = 4').get(waiting.scope.batchId) as Record<string, string>;
    expect(dan).toMatchObject({ status: 'duplicate', match_entity_id: known.id, reason: 'Email matches an existing person.' });
    const peopleBefore = count('person');
    decideApproval(env.ctx, waiting.approvals[0]!.id, { decision: 'approve' });
    expect(count('person')).toBe(peopleBefore + 5);
  });

  it('completes skipped steps with a sentence instead of hanging', async () => {
    const reactionsOnly = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'], enrich: false } });
    await driveRunAsync(env, reactionsOnly.id, ['waiting_approval']);
    const detail = detailOf(reactionsOnly.id);
    expect(detail.steps.every((step) => step.status === 'done')).toBe(true);
    expect(detail.steps[2]!.detail).toBe('Skipped. Comments were not selected as a source.');
    expect(detail.steps[5]!.detail).toBe('Skipped. Enrichment is off for this run.');
    expect(detail.steps[6]!.detail).toContain('Skipped');
    expect(stub.state.startActors).toEqual([reactionsActorId]);
    expect(detail.counts).toMatchObject({ requested: 50, fetched: 4, staged: 4 });
    controlRun(env.ctx, reactionsOnly.id, { action: 'cancel' });

    stub.reset();
    stub.state.actorItems[commentsActorId] = commentItems;
    const commentsOnly = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['comments'], enrich: false } });
    await driveRunAsync(env, commentsOnly.id, ['waiting_approval']);
    expect(detailOf(commentsOnly.id).steps[1]!.detail).toBe('Skipped. Reactions were not selected as a source.');
    expect(stub.state.startActors).toEqual([commentsActorId]);
    controlRun(env.ctx, commentsOnly.id, { action: 'cancel' });
  });

  it('skips enrichment when no staged person has a profile URL', async () => {
    stub.state.actorItems[reactionsActorId] = [{ reactionType: 'LIKE', actor: { name: 'Fay Nolan', position: 'Advisor' } }];
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'] } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const detail = detailOf(run.id);
    expect(detail.steps[5]!.detail).toContain('Skipped. No new person with a profile URL');
    expect(stub.state.startActors).toEqual([reactionsActorId]);
    controlRun(env.ctx, run.id, { action: 'cancel' });
  });

  it('finishes partial with no review when the post has no engagement', async () => {
    stub.state.actorItems[reactionsActorId] = [];
    stub.state.actorItems[commentsActorId] = [];
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    expect(await driveRunAsync(env, run.id, ['partial'])).toBe('partial');
    const detail = detailOf(run.id);
    expect(detail.approvals).toHaveLength(0);
    expect(detail.steps.every((step) => step.status === 'done')).toBe(true);
    expect(detail.steps[3]!.detail).toContain('No people to stage');
    expect(detail.steps[5]!.detail).toContain('Skipped');
    expect(detail.steps[7]!.detail).toContain('nothing to review');
    expect(stub.state.startActors).toEqual([reactionsActorId, commentsActorId]);
  });

  it('rejecting the review creates nothing', async () => {
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, enrich: false } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const peopleBefore = count('person');
    const decided = decideApproval(env.ctx, detailOf(run.id).approvals[0]!.id, { decision: 'reject' });
    expect(decided.run.status).toBe('cancelled');
    expect(count('person')).toBe(peopleBefore);
    const batch = env.db.prepare('SELECT status FROM import_batch WHERE run_id = ?').get(run.id) as { status: string };
    expect(batch.status).toBe('rejected');
  });

  it('freezes the actor ids at start so a settings edit mid run changes nothing', async () => {
    await putConnector({ leadCapture: { reactionsActor: 'Custom/Reactions-Actor' } });
    stub.state.actorItems['custom~reactions-actor'] = reactionItems;
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'], enrich: false } });
    expect(run.scope.actors).toMatchObject({ reactions: 'custom~reactions-actor' });
    await putConnector({ leadCapture: { reactionsActor: '' } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    expect(stub.state.startActors).toEqual(['custom~reactions-actor']);
    expect(detailOf(run.id).approvals[0]!.payload).toMatchObject({ actors: { reactions: 'custom~reactions-actor' } });
    controlRun(env.ctx, run.id, { action: 'cancel' });
  });

  it('keeps the paid engagement results when the enrichment call is rejected', async () => {
    stub.state.actorStartStatus[profileActorId] = 400;
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    expect(await driveRunAsync(env, run.id, ['waiting_approval', 'partial', 'failed'])).toBe('waiting_approval');
    const detail = detailOf(run.id);
    expect(detail.steps.every((step) => step.status === 'done')).toBe(true);
    expect(detail.steps[5]!.detail).toContain('Apify rejected the request (HTTP 400)');
    expect(detail.steps[5]!.detail).toContain('Stub failure.');
    expect(detail.steps[5]!.detail).toContain('still go to review, without enrichment data');
    expect(detail.steps[6]!.detail).toContain('No enrichment data to merge.');
    expect(stub.state.startActors.filter((actor) => actor === profileActorId)).toHaveLength(1);
    expect(detail.counts).toMatchObject({ fetched: 7, staged: 6, invalid: 1 });
    expect(detail.approvals).toHaveLength(1);
    const batch = env.db.prepare('SELECT status FROM import_batch WHERE run_id = ?').get(run.id) as { status: string };
    expect(batch.status).toBe('awaiting_review');
    // The people exist as staged rows without enrichment, and approval still creates them.
    const peopleBefore = count('person');
    decideApproval(env.ctx, detail.approvals[0]!.id, { decision: 'approve' });
    expect(count('person')).toBe(peopleBefore + 6);
    expect(stub.state.abortCalls).toBe(0);
  });

  it('keeps the paid engagement results when the enrichment start outcome is unknown', async () => {
    stub.state.actorStartStatus[profileActorId] = 502;
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    expect(await driveRunAsync(env, run.id, ['waiting_approval', 'partial', 'failed'])).toBe('waiting_approval');
    const detail = detailOf(run.id);
    expect(detail.steps[5]!.status).toBe('done');
    expect(detail.steps[5]!.detail).toContain('Apify console');
    expect(detail.steps[5]!.detail).toContain('recent runs');
    expect(detail.steps[6]!.detail).toBe('No enrichment data to merge.');
    await tick(4, 5000);
    expect(stub.state.startActors.filter((actor) => actor === profileActorId)).toHaveLength(1);
    expect(detail.approvals).toHaveLength(1);
  });

  it('does not match an enrichment item that carries its own profile key by name', async () => {
    stub.state.actorItems[reactionsActorId] = [{ reactionType: 'LIKE', actor: { name: 'Ben Marsh', linkedinUrl: 'https://www.linkedin.com/in/ben-marsh', position: 'Principal' } }];
    // A different Ben Marsh: same name, other profile. His data must not land on the row for /in/ben-marsh.
    stub.state.actorItems[profileActorId] = [
      { firstName: 'Ben', lastName: 'Marsh', publicIdentifier: 'ben-marsh-99', linkedinUrl: 'https://www.linkedin.com/in/ben-marsh-99', currentPosition: [{ companyName: 'Wrong Co' }] },
    ];
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'] } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const waiting = detailOf(run.id);
    expect(waiting.steps[6]!.detail).toContain('Matched 0 of 1 enrichment item');
    expect(waiting.steps[6]!.detail).toContain('1 item matched no staged person and was dropped');
    const row = env.db.prepare('SELECT mapped, raw FROM import_row WHERE batch_id = ?').get(waiting.scope.batchId) as { mapped: string; raw: string };
    expect(JSON.parse(row.mapped)).toMatchObject({ name: 'Ben Marsh', company: null, linkedinUrl: 'https://www.linkedin.com/in/ben-marsh' });
    expect(JSON.parse(row.raw)).not.toHaveProperty('enrichment');
  });

  it('still matches an enrichment item that carries no profile key by its name', async () => {
    stub.state.actorItems[reactionsActorId] = [{ reactionType: 'LIKE', actor: { name: 'Ben Marsh', linkedinUrl: 'https://www.linkedin.com/in/ben-marsh' } }];
    stub.state.actorItems[profileActorId] = [{ fullName: 'Ben Marsh', companyName: 'Harbor Row' }];
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'] } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const waiting = detailOf(run.id);
    expect(waiting.steps[6]!.detail).toContain('Matched 1 of 1 enrichment item');
    const row = env.db.prepare('SELECT mapped FROM import_row WHERE batch_id = ?').get(waiting.scope.batchId) as { mapped: string };
    expect(JSON.parse(row.mapped)).toMatchObject({ company: 'Harbor Row' });
  });

  it('merges people only by profile URL, so items without one stay separate rows', async () => {
    stub.state.actorItems[reactionsActorId] = [
      { reactionType: 'LIKE', actor: { name: 'John Smith', position: 'Engineer' } },
      { reactionType: 'LIKE', actor: { name: 'John Smith', position: 'Lawyer' } },
      { reactionType: 'LIKE', actor: { name: 'Kai Lund', linkedinUrl: 'https://www.linkedin.com/in/kai-lund' } },
    ];
    stub.state.actorItems[commentsActorId] = [
      // Kai has a URL in one source and none in the other: two rows, both visible to the reviewer.
      { commentary: 'Nice.', actor: { name: 'Kai Lund' } },
      { commentary: 'Agreed.', actor: { name: 'John Smith', position: 'Engineer' } },
    ];
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, enrich: false } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const waiting = detailOf(run.id);
    const rows = (env.db.prepare('SELECT mapped, status FROM import_row WHERE batch_id = ? ORDER BY seq').all(waiting.scope.batchId) as { mapped: string; status: string }[]).map(
      (row) => ({ ...(JSON.parse(row.mapped) as Record<string, any>), status: row.status }) as Record<string, any>,
    );
    expect(rows.map((row) => `${row.name}|${row.title ?? ''}|${row.linkedinUrl ? 'url' : 'none'}`)).toEqual([
      'John Smith|Engineer|none',
      'John Smith|Lawyer|none',
      'Kai Lund||url',
      'Kai Lund||none',
      'John Smith|Engineer|none',
    ]);
    expect(rows.every((row) => row.status === 'staged')).toBe(true);
    expect(waiting.counts).toMatchObject({ fetched: 5, staged: 5 });
    expect(waiting.steps[3]!.detail).not.toMatch(/by name|same name/i);
  });

  it('words the ignored item sentence for one and for many', async () => {
    stub.state.actorItems[reactionsActorId] = [{ reactionType: 'LIKE', actor: { name: 'Ada Quill', linkedinUrl: 'https://www.linkedin.com/in/ada-quill' } }, 'text'];
    const one = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'], enrich: false } });
    await driveRunAsync(env, one.id, ['waiting_approval']);
    expect(detailOf(one.id).steps[3]!.detail).toContain(' 1 item was not an object and was ignored.');
    controlRun(env.ctx, one.id, { action: 'cancel' });

    stub.state.actorItems[reactionsActorId] = [{ reactionType: 'LIKE', actor: { name: 'Ada Quill', linkedinUrl: 'https://www.linkedin.com/in/ada-quill' } }, 'text', 7, null];
    const many = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'], enrich: false } });
    await driveRunAsync(env, many.id, ['waiting_approval']);
    expect(detailOf(many.id).steps[3]!.detail).toContain(' 3 items were not objects and were ignored.');
    controlRun(env.ctx, many.id, { action: 'cancel' });
  });

  it('says when the per source cap was reached, once', async () => {
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, maxPeople: 4, enrich: false } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const detail = detailOf(run.id).steps[3]!.detail!;
    expect(detail.split('The per source cap was reached, so more engagement may exist.')).toHaveLength(2);
    controlRun(env.ctx, run.id, { action: 'cancel' });

    const roomy = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, maxPeople: 50, enrich: false } });
    await driveRunAsync(env, roomy.id, ['waiting_approval']);
    expect(detailOf(roomy.id).steps[3]!.detail).not.toContain('per source cap');
  });
});

describe('lead capture repeat captures', () => {
  it('marks people already staged in another pending import as duplicates before any enrichment is bought', async () => {
    const first = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    await driveRunAsync(env, first.id, ['waiting_approval']);
    const firstDetail = detailOf(first.id);
    expect(stub.state.startActors).toEqual([reactionsActorId, commentsActorId, profileActorId]);
    expect(firstDetail.counts).toMatchObject({ fetched: 7, staged: 6, duplicates: 0, invalid: 1 });

    // The same post again while the first import still waits for review.
    const second = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    await driveRunAsync(env, second.id, ['waiting_approval']);
    const detail = detailOf(second.id);
    // Two more engagement scrapes and no second profile enrichment: every person with a profile URL is already staged.
    expect(stub.state.startActors).toEqual([reactionsActorId, commentsActorId, profileActorId, reactionsActorId, commentsActorId]);
    expect(detail.steps[4]!.detail).toContain('Found 5 people who are already known');
    expect(detail.steps[5]!.detail).toContain('Skipped. No new person with a profile URL');
    expect(detail.steps[6]!.detail).toContain('Skipped');
    // Fay has no email and no profile URL, so nothing can match her. Everyone with a key is a duplicate.
    expect(detail.counts).toMatchObject({ fetched: 7, staged: 1, duplicates: 5, invalid: 1 });
    const firstBatchId = firstDetail.scope.batchId as string;
    const rows = env.db.prepare('SELECT status, reason FROM import_row WHERE batch_id = ? ORDER BY seq').all(detail.scope.batchId) as { status: string; reason: string | null }[];
    expect(rows.map((row) => row.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', 'staged', 'invalid']);
    for (const row of rows.slice(0, 5)) {
      expect(row.reason).toContain('Already staged in another pending import');
      expect(row.reason).toContain(firstBatchId);
    }
    expect(detail.approvals[0]!.payload).toMatchObject({ counts: { fetched: 7, staged: 1, duplicates: 5, invalid: 1 } });
  });

  it('stops matching once the other import is no longer pending', async () => {
    const first = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, enrich: false } });
    await driveRunAsync(env, first.id, ['waiting_approval']);
    controlRun(env.ctx, first.id, { action: 'cancel' });
    const second = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, enrich: false } });
    await driveRunAsync(env, second.id, ['waiting_approval']);
    expect(detailOf(second.id).counts).toMatchObject({ fetched: 7, staged: 6, duplicates: 0, invalid: 1 });
  });

  it('re-checks pending imports after enrichment because a new email can reveal a person already staged', async () => {
    const first = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    await driveRunAsync(env, first.id, ['waiting_approval']);
    const startsBefore = stub.state.startCalls;

    // Same person under another profile URL. Only enrichment shows the email that matches the staged Dan Orr.
    stub.state.actorItems[reactionsActorId] = [{ reactionType: 'LIKE', actor: { name: 'D. Orr', linkedinUrl: 'https://www.linkedin.com/in/dan-orr-alt' } }];
    stub.state.actorItems[profileActorId] = [
      { fullName: 'Dan Orr', email: 'dan.orr@orrcapital.example.com', linkedinUrl: 'https://www.linkedin.com/in/dan-orr-alt' },
    ];
    const second = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'] } });
    await driveRunAsync(env, second.id, ['waiting_approval', 'partial']);
    const detail = detailOf(second.id);
    expect(stub.state.startCalls).toBe(startsBefore + 2);
    expect(detail.steps[6]!.detail).toContain('1 person turned out to be already known after enrichment');
    const row = env.db.prepare('SELECT status, reason FROM import_row WHERE batch_id = ?').get(detail.scope.batchId) as { status: string; reason: string };
    expect(row.status).toBe('duplicate');
    expect(row.reason).toContain('Already staged in another pending import');
    expect(row.reason).toContain(detailOf(first.id).scope.batchId as string);
  });

  it('skips a row at approval when a person with its LinkedIn profile was added after staging', async () => {
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, enrich: false } });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const waiting = detailOf(run.id);
    expect(waiting.counts).toMatchObject({ staged: 6, duplicates: 0 });
    // Created after staging, with no email, so only the profile can reveal it. The URL differs in host case and query.
    const late = createPerson(env.ctx, { firstName: 'Cara', lastName: 'Voss' });
    createFieldClaim(env.ctx, {
      entityType: 'person',
      entityId: late.id,
      field: 'linkedinUrl',
      value: 'https://LinkedIn.com/in/cara-voss/?utm_source=x',
      sourceType: 'import',
      status: 'imported',
    });
    const peopleBefore = count('person');
    const decided = decideApproval(env.ctx, waiting.approvals[0]!.id, { decision: 'approve' });
    expect(decided.run.status).toBe('succeeded');
    expect(decided.run.counts).toMatchObject({ fetched: 7, staged: 5, duplicates: 1, invalid: 1, accepted: 5 });
    expect(count('person')).toBe(peopleBefore + 5);
    const row = env.db.prepare('SELECT status, reason, match_entity_id FROM import_row WHERE batch_id = ? AND seq = 3').get(waiting.scope.batchId) as Record<string, string>;
    expect(row).toMatchObject({
      status: 'duplicate',
      reason: 'A person with this LinkedIn profile was added after staging.',
      match_entity_id: late.id,
    });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM person WHERE first_name = 'Cara'").get()).toEqual({ n: 1 });
    const batch = env.db.prepare('SELECT status, counts FROM import_batch WHERE run_id = ?').get(run.id) as { status: string; counts: string };
    expect(batch.status).toBe('accepted');
    expect(JSON.parse(batch.counts)).toMatchObject({ staged: 5, duplicates: 1, accepted: 5 });
  });
});

describe('lead capture start safety', () => {
  it('does not send a start request when another tick marked the attempt after this one read the run', async () => {
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'], enrich: false } });
    // Queued to running, then validation, which leaves the reactions step running with no marker.
    await advanceLeadCaptureRun(env.ctx, run.id);
    await advanceLeadCaptureRun(env.ctx, run.id);
    expect(detailOf(run.id).steps[1]!.status).toBe('running');
    // Another tick writes its marker after this tick has read the scope and before it records its own.
    let raced = false;
    const racing = {
      ...env.ctx,
      now: () => {
        if (!raced) {
          raced = true;
          const scope = { ...detailOf(run.id).scope, calls: { reactions: { actorId: 'harvestapi/linkedin-post-reactions', startAttemptedAt: env.ctx.now() } } };
          env.db.prepare('UPDATE run SET scope = ? WHERE id = ?').run(JSON.stringify(scope), run.id);
        }
        return env.ctx.now();
      },
    };
    await advanceLeadCaptureRun(racing, run.id);
    expect(raced).toBe(true);
    expect(stub.state.startCalls).toBe(0);
    // The marker stays as the other tick wrote it, and the next tick fails the run instead of posting.
    expect(await driveRunAsync(env, run.id, ['failed'])).toBe('failed');
    expect(stub.state.startCalls).toBe(0);
    expect(detailOf(run.id).steps[1]!.detail).toContain('Apify console');
  });

  it('records the attempt before the request and fails an unknown outcome without a second start', async () => {
    stub.state.actorStartStatus[commentsActorId] = 502;
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    expect(await driveRunAsync(env, run.id, ['failed', 'partial'])).toBe('failed');
    await tick(6, 5000);
    expect(stub.state.startActors).toEqual([reactionsActorId, commentsActorId]);
    const detail = detailOf(run.id);
    expect(detail.steps[1]!.status).toBe('done');
    expect(detail.steps[2]!.status).toBe('failed');
    expect(detail.steps[2]!.detail).toContain('Apify console');
    expect(detail.steps[2]!.detail).toContain('recent runs');
    const calls = detail.scope.calls as Record<string, Record<string, unknown>>;
    expect(calls.comments!.startAttemptedAt).toBeTruthy();
    expect(calls.comments!.apifyRunId).toBeUndefined();
    // The finished reactions run is not stopped, and no unknown run id exists to stop.
    expect(stub.state.abortCalls).toBe(0);
    expect(detail.steps.slice(3).every((step) => step.status === 'skipped')).toBe(true);
  });

  it('treats an unreadable answer as an unknown outcome', async () => {
    stub.state.startGarbage = true;
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    expect(await driveRunAsync(env, run.id, ['failed'])).toBe('failed');
    await tick(3, 5000);
    expect(stub.state.startCalls).toBe(1);
    expect(detailOf(run.id).steps[1]!.detail).toContain('Apify console');
  });

  it('does not post again when a crash left an attempted start without a run id', async () => {
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    const scope = { ...detailOf(run.id).scope, calls: { reactions: { actorId: 'harvestapi/linkedin-post-reactions', startAttemptedAt: env.ctx.now() } } };
    env.db.prepare('UPDATE run SET scope = ? WHERE id = ?').run(JSON.stringify(scope), run.id);
    expect(await driveRunAsync(env, run.id, ['failed'])).toBe('failed');
    expect(stub.state.startCalls).toBe(0);
    expect(detailOf(run.id).steps[1]!.detail).toContain('Apify console');
  });

  it('does not start a second actor run when the scope already holds a run id for the call', async () => {
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'], enrich: false } });
    stub.state.runs['run_existing'] = { actor: reactionsActorId, datasetId: 'ds_existing', polls: 0 };
    stub.state.datasets['ds_existing'] = reactionItems;
    const scope = {
      ...detailOf(run.id).scope,
      calls: {
        reactions: {
          actorId: 'harvestapi/linkedin-post-reactions',
          startAttemptedAt: env.ctx.now(),
          apifyRunId: 'run_existing',
          datasetId: 'ds_existing',
          startedAt: env.ctx.now(),
        },
      },
    };
    env.db.prepare('UPDATE run SET scope = ? WHERE id = ?').run(JSON.stringify(scope), run.id);
    expect(await driveRunAsync(env, run.id, ['waiting_approval'])).toBe('waiting_approval');
    expect(stub.state.startCalls).toBe(0);
    controlRun(env.ctx, run.id, { action: 'cancel' });
  });

  it('polls the saved run after a restart instead of starting again', async () => {
    stub.state.actorStatuses[commentsActorId] = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    await untilCall(run.id, 'comments');
    await tick(3);
    expect(stub.state.startActors).toEqual([reactionsActorId, commentsActorId]);
    // The process stopped mid tick: the job is left in "running" and the next start recovers it.
    env.db.prepare("UPDATE job SET status = 'running' WHERE status = 'queued'").run();
    expect(recoverStaleJobs(env.ctx)).toBeGreaterThan(0);
    stub.state.actorStatuses[commentsActorId] = ['SUCCEEDED'];
    stub.state.runs['run_2']!.polls = 0;
    expect(await driveRunAsync(env, run.id, ['waiting_approval'])).toBe('waiting_approval');
    expect(stub.state.startActors).toEqual([reactionsActorId, commentsActorId, profileActorId]);
  });

  it('clears the marker after a rate limit so the retry can start', async () => {
    stub.state.actorStartStatus[reactionsActorId] = 429;
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'], enrich: false } });
    for (let index = 0; index < 20 && stub.state.startActors.length === 0; index += 1) await tick(1);
    expect(stub.state.startActors).toEqual([reactionsActorId]);
    const calls = detailOf(run.id).scope.calls as Record<string, Record<string, unknown>>;
    expect(calls.reactions!.startAttemptedAt ?? null).toBeNull();
    delete stub.state.actorStartStatus[reactionsActorId];
    expect(await driveRunAsync(env, run.id, ['waiting_approval'])).toBe('waiting_approval');
    expect(stub.state.startActors).toEqual([reactionsActorId, reactionsActorId]);
    controlRun(env.ctx, run.id, { action: 'cancel' });
  });
});

describe('lead capture abort', () => {
  it('asks Apify to stop the running call when the run is cancelled mid poll', async () => {
    stub.state.actorStatuses[reactionsActorId] = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    const remote = await untilCall(run.id, 'reactions');
    await tick(3);
    expect(detailOf(run.id).steps[1]!.detail).toMatch(/RUNNING\. Elapsed \d+ s\./);
    controlRun(env.ctx, run.id, { action: 'cancel' });
    await tick(1);
    expect(stub.state.abortedRuns).toEqual([remote]);
    const detail = detailOf(run.id);
    expect(detail.status).toBe('cancelled');
    expect(detail.steps[1]!.detail).toContain(`Asked Apify to stop run ${remote}`);
    await tick(2);
    expect(stub.state.abortCalls).toBe(1);
  });

  it('stops only unfinished calls and does not touch a call that already finished', async () => {
    stub.state.actorStatuses[commentsActorId] = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    const remote = await untilCall(run.id, 'comments');
    await tick(2);
    controlRun(env.ctx, run.id, { action: 'pause' });
    controlRun(env.ctx, run.id, { action: 'cancel' });
    await tick(1);
    expect(stub.state.abortedRuns).toEqual([remote]);
    expect(remote).toBe('run_2');
  });

  it('requests an abort for every unfinished call on a cancelled run', async () => {
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    controlRun(env.ctx, run.id, { action: 'pause' });
    const now = env.ctx.now();
    const call = (id: string, finished = false) => ({ actorId: 'a/b', startAttemptedAt: now, apifyRunId: id, datasetId: 'ds', startedAt: now, finished });
    const scope = { ...detailOf(run.id).scope, calls: { reactions: call('run_x'), comments: call('run_y'), enrich: call('run_z', true) } };
    env.db.prepare('UPDATE run SET scope = ? WHERE id = ?').run(JSON.stringify(scope), run.id);
    controlRun(env.ctx, run.id, { action: 'cancel' });
    expect(stub.state.abortCalls).toBe(0);
    await tick(1);
    expect(stub.state.abortedRuns.sort()).toEqual(['run_x', 'run_y']);
    const detail = detailOf(run.id);
    expect(detail.steps[1]!.detail).toContain('Asked Apify to stop run run_x');
    expect(detail.steps[2]!.detail).toContain('Asked Apify to stop run run_y');
    const calls = detail.scope.calls as Record<string, Record<string, unknown>>;
    expect(calls.reactions!.abortRequested).toBe(true);
    expect(calls.comments!.abortRequested).toBe(true);
    expect(calls.enrich!.abortRequested).toBeUndefined();
    await tick(2);
    expect(stub.state.abortCalls).toBe(2);
  });

  it('times out an enrichment call, stops the remote run, and still sends the staged people to review', async () => {
    const undo = useStub(stub, { AGENTCRM_APIFY_TIMEOUT_MS: '4000' });
    try {
      stub.state.actorStatuses[profileActorId] = ['RUNNING'];
      const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
      expect(await driveRunAsync(env, run.id, ['waiting_approval', 'partial', 'failed'])).toBe('waiting_approval');
      const detail = detailOf(run.id);
      expect(detail.steps[5]!.status).toBe('done');
      expect(detail.steps[5]!.detail).toContain('Timed out');
      expect(detail.steps[5]!.detail).toContain('Asked Apify to stop run run_3');
      expect(detail.steps[6]!.detail).toBe('No enrichment data to merge.');
      expect(stub.state.abortedRuns).toEqual(['run_3']);
      expect(detail.approvals).toHaveLength(1);
      expect((detail.scope.calls as Record<string, Record<string, unknown>>).enrich).toMatchObject({ failed: true, abortRequested: true });
      const batch = env.db.prepare('SELECT status FROM import_batch WHERE run_id = ?').get(run.id) as { status: string };
      expect(batch.status).toBe('awaiting_review');
      await tick(2);
      expect(stub.state.abortCalls).toBe(1);
    } finally {
      undo();
    }
  });

  it('fails active lead capture runs and stops their calls when the connector is removed', async () => {
    stub.state.actorStatuses[commentsActorId] = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    await untilCall(run.id, 'comments');
    await tick(2);
    const response = await app.inject({ method: 'DELETE', url: '/api/connectors/apify', headers: { host: '127.0.0.1:4720' } });
    expect(response.statusCode).toBe(204);
    try {
      expect(stub.state.abortedRuns).toEqual(['run_2']);
      const detail = detailOf(run.id);
      expect(detail.status).toBe('failed');
      expect(detail.steps[2]!.detail).toContain('disconnected');
      expect(detail.steps[2]!.detail).toContain('Asked Apify to stop run run_2');
    } finally {
      await configureApifyConnector(env.ctx, { token: stubToken, allowlist: fullAllowlist });
    }
  });

  it('asks Apify to stop through the cancel route', async () => {
    stub.state.actorStatuses[reactionsActorId] = ['RUNNING'];
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } });
    await untilCall(run.id, 'reactions');
    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/control`,
      headers: { host: '127.0.0.1:4720' },
      payload: { action: 'cancel' },
    });
    expect(response.statusCode).toBe(200);
    expect(stub.state.abortedRuns).toEqual(['run_1']);
    expect(response.json().scope.calls.reactions.abortRequested).toBe(true);
  });
});

describe('lead capture policy', () => {
  it('requires every involved actor on the allowlist for an agent run', async () => {
    await configureApifyConnector(env.ctx, { allowlist: ['harvestapi/linkedin-post-reactions'] });
    const refused = failure(() => startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } }, { origin: 'agent' }));
    expect(refused).toMatch(/^conflict: /);
    expect(refused).toContain('harvestapi/linkedin-post-comments');
    expect(refused).toContain('harvestapi/linkedin-profile-scraper');
    expect(refused).toContain('allowlist');
    // Comments are not selected, but enrichment is on.
    const noProfile = failure(() => startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'] } }, { origin: 'agent' }));
    expect(noProfile).toContain('harvestapi/linkedin-profile-scraper');
    expect(noProfile).not.toContain('linkedin-post-comments');
    const allowed = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'], enrich: false } }, { origin: 'agent' });
    expect(allowed.status).toBe('queued');
    expect(allowed.scope.origin).toBe('agent');
    controlRun(env.ctx, allowed.id, { action: 'cancel' });
    // A person in the app can use the configured actors as they are.
    const own = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } }, { origin: 'user' });
    expect(own.status).toBe('queued');
    controlRun(env.ctx, own.id, { action: 'cancel' });
  });

  it('checks the allowlist against the configured actors, whatever their spelling', async () => {
    await putConnector({ leadCapture: { reactionsActor: 'other~custom-reactions' } });
    await configureApifyConnector(env.ctx, { allowlist: ['Other/Custom-Reactions'] });
    const run = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl, sources: ['reactions'], enrich: false } }, { origin: 'agent' });
    expect(run.scope.actors).toMatchObject({ reactions: 'other~custom-reactions' });
    controlRun(env.ctx, run.id, { action: 'cancel' });
  });

  it('shares the single agent started run slot with Apify imports', async () => {
    await configureApifyConnector(env.ctx, { allowlist: [...fullAllowlist, 'tester/lead-scraper'] });
    const first = startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } }, { origin: 'agent' });
    expect(failure(() => startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } }, { origin: 'agent' }))).toContain('One agent started run may be open at a time');
    expect(failure(() => startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId: 'tester~lead-scraper', input: {} } }, { origin: 'agent' }))).toContain('One agent started run');
    expect(startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } }, { origin: 'user' }).status).toBe('queued');
    controlRun(env.ctx, first.id, { action: 'cancel' });
    const apify = startRun(env.ctx, { kind: 'apify_scrape', scope: { actorId: 'tester~lead-scraper', input: {} } }, { origin: 'agent' });
    expect(failure(() => startRun(env.ctx, { kind: 'lead_capture', scope: { postUrl } }, { origin: 'agent' }))).toContain('One agent started run');
    controlRun(env.ctx, apify.id, { action: 'cancel' });
  });
});

describe('lead capture connector settings', () => {
  it('serializes effective actor ids, with defaults when nothing was saved', async () => {
    const entry = await listedApify();
    expect(entry.settings.leadCapture).toEqual({
      reactionsActor: 'harvestapi/linkedin-post-reactions',
      commentsActor: 'harvestapi/linkedin-post-comments',
      profileActor: 'harvestapi/linkedin-profile-scraper',
    });
    expect(entry.settings.allowlist).toEqual(fullAllowlist);
  });

  it('accepts a leadCapture-only body, normalizes ids, and resets an empty field', async () => {
    const saved = await putConnector({ leadCapture: { reactionsActor: 'My-User/My-Reactions', commentsActor: 'my~comments', profileActor: ' Another/Profile ' } });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.leadCapture).toEqual({
      reactionsActor: 'my-user~my-reactions',
      commentsActor: 'my~comments',
      profileActor: 'another~profile',
    });
    // Token, allowlist, and username are untouched.
    expect(saved.body.settings.allowlist).toEqual(fullAllowlist);
    expect(saved.body.settings.username).toBe('tester');
    expect(saved.body.tokenMasked).toBe('****1234');
    expect((await listedApify()).settings.leadCapture.reactionsActor).toBe('my-user~my-reactions');

    // A single field alone changes only that field. An empty string resets it.
    const reset = await putConnector({ leadCapture: { reactionsActor: '' } });
    expect(reset.status).toBe(200);
    expect(reset.body.settings.leadCapture).toEqual({
      reactionsActor: 'harvestapi/linkedin-post-reactions',
      commentsActor: 'my~comments',
      profileActor: 'another~profile',
    });
    const cleared = await putConnector({ leadCapture: { commentsActor: '', profileActor: '' } });
    expect(cleared.body.settings.leadCapture).toEqual({
      reactionsActor: 'harvestapi/linkedin-post-reactions',
      commentsActor: 'harvestapi/linkedin-post-comments',
      profileActor: 'harvestapi/linkedin-profile-scraper',
    });
    const stored = JSON.parse((env.db.prepare("SELECT settings FROM connector WHERE kind = 'apify'").get() as { settings: string }).settings);
    expect(stored.leadCapture).toEqual({});
  });

  it('keeps the actor ids when the token or the allowlist changes', async () => {
    await putConnector({ leadCapture: { reactionsActor: 'keep~me' } });
    const allowlist = await putConnector({ allowlist: ['keep/me'] });
    expect(allowlist.body.settings.leadCapture.reactionsActor).toBe('keep~me');
    const token = await putConnector({ token: stubToken });
    expect(token.body.settings.leadCapture.reactionsActor).toBe('keep~me');
    expect(token.body.settings.allowlist).toEqual(['keep/me']);
  });

  it('rejects bad ids and empty bodies', async () => {
    expect((await putConnector({ leadCapture: { reactionsActor: '..' } })).status).toBe(400);
    expect((await putConnector({ leadCapture: { reactionsActor: 'a b' } })).status).toBe(400);
    expect((await putConnector({ leadCapture: { reactionsActor: 'a/../b' } })).status).toBe(400);
    expect((await putConnector({ leadCapture: { reactionsActor: 'x'.repeat(201) } })).status).toBe(400);
    expect((await putConnector({ leadCapture: { unknown: 'a/b' } })).status).toBe(400);
    expect((await putConnector({})).status).toBe(400);
    expect((await putConnector({ leadCapture: {} })).status).toBe(200);
    expect((await listedApify()).settings.leadCapture.reactionsActor).toBe('harvestapi/linkedin-post-reactions');
  });
});
