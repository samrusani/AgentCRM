import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeXProfileUrl } from '../src/actions/capture.js';
import { buildApp } from '../src/http/app.js';
import type { DomainEvent } from '../src/events.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
const host = { host: 'localhost:4720' };

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

type Method = 'GET' | 'POST' | 'DELETE';

async function call(method: Method, url: string, options: { payload?: unknown; authorization?: string } = {}) {
  const headers: Record<string, string> = { ...host };
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  const response = await app.inject({ method, url, headers, ...(options.payload !== undefined ? { payload: options.payload as object } : {}) });
  const text = response.body;
  return { status: response.statusCode, body: text === '' ? null : (JSON.parse(text) as Record<string, any>) };
}

async function newToken(): Promise<string> {
  const { status, body } = await call('POST', '/api/capture/token');
  expect(status).toBe(201);
  return body!.token as string;
}

const bearer = (token: string) => `Bearer ${token}`;

const count = (sql: string, ...params: unknown[]): number =>
  Number((env.db.prepare(sql).get(...params) as { n: number }).n);
const totals = () => ({
  people: count('SELECT COUNT(*) AS n FROM person'),
  claims: count('SELECT COUNT(*) AS n FROM field_claim'),
  activities: count('SELECT COUNT(*) AS n FROM activity'),
  audits: count('SELECT COUNT(*) AS n FROM audit_event'),
  organizations: count('SELECT COUNT(*) AS n FROM organization'),
});

describe('capture token', () => {
  it('answers 401 on both guarded routes before any token exists', async () => {
    const verify = await call('POST', '/api/capture/verify', { authorization: 'Bearer cap_nothing' });
    expect(verify.status).toBe(401);
    expect(verify.body!.error.code).toBe('unauthorized');
    expect(verify.body!.error.message).toContain('Settings');
    const capture = await call('POST', '/api/capture', {
      authorization: 'Bearer cap_nothing',
      payload: { source: 'x', url: 'https://x.com/someone', name: 'Someone' },
    });
    expect(capture.status).toBe(401);
    expect(count('SELECT COUNT(*) AS n FROM person')).toBe(0);
  });

  it('reports not configured, then generates, rotates, and removes the token', async () => {
    expect((await call('GET', '/api/capture/settings')).body).toEqual({ configured: false, createdAt: null });

    const first = await call('POST', '/api/capture/token');
    expect(first.status).toBe(201);
    const token = first.body!.token as string;
    expect(token).toMatch(/^cap_[A-Za-z0-9_-]{43}$/);
    expect(token.length).toBe(47);
    expect(typeof first.body!.createdAt).toBe('string');

    const settings = await call('GET', '/api/capture/settings');
    expect(settings.body).toEqual({ configured: true, createdAt: first.body!.createdAt });
    expect(JSON.stringify(settings.body)).not.toContain(token);

    // Only the hash is stored.
    const stored = (env.db.prepare('SELECT settings FROM workspace').get() as { settings: string }).settings;
    expect(stored).not.toContain(token);
    expect(JSON.parse(stored).capture.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    expect((await call('POST', '/api/capture/verify', { authorization: bearer(token) })).status).toBe(200);

    const second = await newToken();
    expect(second).not.toBe(token);
    expect((await call('POST', '/api/capture/verify', { authorization: bearer(token) })).status).toBe(401);
    expect((await call('POST', '/api/capture/verify', { authorization: bearer(second) })).status).toBe(200);

    const removed = await call('DELETE', '/api/capture/token');
    expect(removed.status).toBe(204);
    expect((await call('GET', '/api/capture/settings')).body).toEqual({ configured: false, createdAt: null });
    expect((await call('POST', '/api/capture/verify', { authorization: bearer(second) })).status).toBe(401);
    // Removing again is harmless.
    expect((await call('DELETE', '/api/capture/token')).status).toBe(204);
  });

  it('keeps other workspace settings when the token changes', async () => {
    env.db.prepare('UPDATE workspace SET settings = ? WHERE id = ?').run(JSON.stringify({ modelProvider: 'openai' }), env.workspaceId);
    await newToken();
    expect(JSON.parse((env.db.prepare('SELECT settings FROM workspace').get() as { settings: string }).settings).modelProvider).toBe('openai');
    await call('DELETE', '/api/capture/token');
    expect(JSON.parse((env.db.prepare('SELECT settings FROM workspace').get() as { settings: string }).settings)).toEqual({ modelProvider: 'openai' });
  });

  it('rejects missing, wrong scheme, malformed, and wrong tokens on both routes', async () => {
    const token = await newToken();
    const body = { source: 'x', url: 'https://x.com/someone', name: 'Someone' };
    const attempts: (string | undefined)[] = [
      undefined,
      `Basic ${token}`,
      token,
      'Bearer',
      'Bearer ',
      `Bearer ${token} extra`,
      'Bearer cap_wrong',
      `Bearer ${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
    ];
    for (const authorization of attempts) {
      const verify = await call('POST', '/api/capture/verify', authorization === undefined ? {} : { authorization });
      expect(verify.status, String(authorization)).toBe(401);
      expect(verify.body!.error.code).toBe('unauthorized');
      const capture = await call('POST', '/api/capture', { payload: body, ...(authorization === undefined ? {} : { authorization }) });
      expect(capture.status, String(authorization)).toBe(401);
    }
    expect(count('SELECT COUNT(*) AS n FROM person')).toBe(0);
  });

  it('accepts a case insensitive scheme and answers 401 before parsing a bad body', async () => {
    const token = await newToken();
    const verify = await call('POST', '/api/capture/verify', { authorization: `bEaReR ${token}` });
    expect(verify.status).toBe(200);
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/capture',
      headers: { ...host, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('returns the workspace name from verify', async () => {
    const token = await newToken();
    const { status, body } = await call('POST', '/api/capture/verify', { authorization: bearer(token) });
    expect(status).toBe(200);
    const name = (env.db.prepare('SELECT name FROM workspace').get() as { name: string }).name;
    expect(body).toEqual({ ok: true, workspace: name });
  });

  it('still enforces the loopback host check on guarded routes', async () => {
    const token = await newToken();
    const response = await app.inject({
      method: 'POST',
      url: '/api/capture/verify',
      headers: { host: 'example.com', authorization: bearer(token) },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('capture a person', () => {
  let token: string;
  beforeAll(async () => {
    token = await newToken();
  });
  const capture = (payload: unknown) => call('POST', '/api/capture', { authorization: bearer(token), payload });

  const fullLinkedin = {
    source: 'linkedin',
    url: 'https://www.linkedin.com/in/Ada-Lovelace-123/?utm_source=share',
    name: 'Ada Lovelace',
    headline: 'Founder at Analytical Engines',
    company: 'Analytical Engines',
    location: 'London, UK',
    bio: 'Writes the first programs.',
    website: 'https://example.com/ada',
    email: 'Ada@Example.com',
  };

  it('creates a person with claims, tags, a note, an audit row, and a record event', async () => {
    const events: DomainEvent[] = [];
    const unsubscribe = env.bus.subscribe((event) => events.push(event));
    const before = totals();
    const { status, body } = await capture(fullLinkedin);
    unsubscribe();
    expect(status).toBe(201);
    expect(body!.outcome).toBe('created');
    expect(body!.person.name).toBe('Ada Lovelace');
    const id = body!.person.id as string;

    const row = env.db.prepare('SELECT * FROM person WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({
      workspace_id: env.workspaceId,
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      title: 'Founder at Analytical Engines',
      location: 'London, UK',
      organization_id: null,
      next_action_at: null,
    });
    expect(JSON.parse(String(row.tags))).toEqual(['captured', 'linkedin']);

    const canonical = 'https://www.linkedin.com/in/Ada-Lovelace-123';
    const claims = env.db
      .prepare('SELECT field, value, source_type, source_url, extraction_method, status FROM field_claim WHERE entity_id = ? ORDER BY field')
      .all(id) as Record<string, string>[];
    expect(claims.map((claim) => [claim.field, claim.value])).toEqual([
      ['company', 'Analytical Engines'],
      ['email', 'ada@example.com'],
      ['linkedinUrl', canonical],
      ['location', 'London, UK'],
      ['name', 'Ada Lovelace'],
      ['title', 'Founder at Analytical Engines'],
      ['website', 'https://example.com/ada'],
    ]);
    for (const claim of claims) {
      expect(claim.source_type).toBe('extension');
      expect(claim.source_url).toBe(canonical);
      expect(claim.extraction_method).toBe('extension:linkedin');
      expect(claim.status).toBe('imported');
    }

    const notes = env.db.prepare("SELECT kind, body FROM activity WHERE entity_id = ?").all(id) as { kind: string; body: string }[];
    expect(notes).toEqual([{ kind: 'note', body: `Captured from LinkedIn ${canonical}.\n\nWrites the first programs.` }]);

    expect(count("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'capture.person' AND entity_id = ?", id)).toBe(1);
    expect(events).toContainEqual({ type: 'record_updated', entityType: 'person', entityId: id });
    expect(totals().organizations).toBe(before.organizations);
    expect(totals().people).toBe(before.people + 1);
  });

  it('writes a note without a bio paragraph and skips absent claims', async () => {
    const { status, body } = await capture({ source: 'linkedin', url: 'linkedin.com/in/grace-hopper', name: '  Grace   Hopper ' });
    expect(status).toBe(201);
    const id = body!.person.id as string;
    expect(body!.person.name).toBe('Grace Hopper');
    expect(
      (env.db.prepare('SELECT body FROM activity WHERE entity_id = ?').all(id) as { body: string }[]).map((note) => note.body),
    ).toEqual(['Captured from LinkedIn https://www.linkedin.com/in/grace-hopper.']);
    expect(
      (env.db.prepare('SELECT field FROM field_claim WHERE entity_id = ? ORDER BY field').all(id) as { field: string }[]).map((claim) => claim.field),
    ).toEqual(['linkedinUrl', 'name']);
    const row = env.db.prepare('SELECT email, title, location FROM person WHERE id = ?').get(id);
    expect(row).toEqual({ email: null, title: null, location: null });
  });

  it('treats empty optional strings as absent', async () => {
    const { status, body } = await capture({
      source: 'linkedin',
      url: 'https://www.linkedin.com/in/empty-fields',
      name: 'Empty Fields',
      headline: '',
      email: '',
      bio: '  ',
    });
    expect(status).toBe(201);
    expect(count("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ? AND field IN ('title', 'email')", body!.person.id)).toBe(0);
  });

  it('captures from X with a canonical xUrl claim and the handle case kept', async () => {
    const { status, body } = await capture({
      source: 'x',
      url: 'twitter.com/Jack_Dorsey/status/20?s=20',
      name: 'Jack',
      handle: '@Jack_Dorsey',
      bio: 'just setting up',
    });
    expect(status).toBe(201);
    const id = body!.person.id as string;
    const claim = env.db.prepare("SELECT value, source_url, extraction_method FROM field_claim WHERE entity_id = ? AND field = 'xUrl'").get(id);
    expect(claim).toEqual({ value: 'https://x.com/Jack_Dorsey', source_url: 'https://x.com/Jack_Dorsey', extraction_method: 'extension:x' });
    expect(JSON.parse((env.db.prepare('SELECT tags FROM person WHERE id = ?').get(id) as { tags: string }).tags)).toEqual(['captured', 'x']);
    expect((env.db.prepare('SELECT body FROM activity WHERE entity_id = ?').get(id) as { body: string }).body).toBe(
      'Captured from X https://x.com/Jack_Dorsey.\n\njust setting up',
    );
  });

  describe('dedupe', () => {
    const expectExisting = async (payload: unknown, id: string) => {
      const before = totals();
      const { status, body } = await capture(payload);
      expect(status).toBe(200);
      expect(body!.outcome).toBe('existing');
      expect(body!.person.id).toBe(id);
      expect(totals()).toEqual(before);
    };

    it('matches a saved linkedinUrl claim despite host case, query, and trailing slash', async () => {
      const first = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/dedupe-me', name: 'Dee Dupe' });
      const id = first.body!.person.id as string;
      expect(first.status).toBe(201);
      await expectExisting({ source: 'linkedin', url: 'HTTPS://WWW.LinkedIn.COM/in/dedupe-me/', name: 'Another Name' }, id);
      await expectExisting({ source: 'linkedin', url: 'https://uk.linkedin.com/in/dedupe-me?x=1', name: 'Other' }, id);
    });

    it('matches a linkedinUrl claim saved by an older import in another shape', async () => {
      const created = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/other-person', name: 'Old Import' });
      const id = created.body!.person.id as string;
      env.db.prepare("UPDATE field_claim SET value = 'linkedin.com/in/legacy-id/' WHERE entity_id = ? AND field = 'linkedinUrl'").run(id);
      await expectExisting({ source: 'linkedin', url: 'https://www.linkedin.com/in/legacy-id', name: 'Old Import' }, id);
    });

    it('does not treat a different LinkedIn id as a duplicate', async () => {
      const { status } = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/dedupe-me-too', name: 'Dee Dupe' });
      expect(status).toBe(201);
    });

    it('matches a saved xUrl claim with a different handle case', async () => {
      const first = await capture({ source: 'x', url: 'https://x.com/CaseMatters', name: 'Case Matters' });
      expect(first.status).toBe(201);
      const id = first.body!.person.id as string;
      await expectExisting({ source: 'x', url: 'https://twitter.com/casematters', name: 'Case Matters' }, id);
      await expectExisting({ source: 'x', url: 'https://mobile.x.com/CASEMATTERS/', name: 'Case Matters' }, id);
    });

    it('matches the email case folded, across sources', async () => {
      const first = await capture({ source: 'x', url: 'https://x.com/emailowner', name: 'Email Owner', email: 'owner@example.com' });
      const id = first.body!.person.id as string;
      await expectExisting({ source: 'linkedin', url: 'https://www.linkedin.com/in/new-id', name: 'Email Owner', email: 'OWNER@Example.COM' }, id);
    });

    it('returns the existing person name with first and last name joined', async () => {
      const { body } = await capture({ source: 'x', url: 'https://x.com/casematters', name: 'Whatever' });
      expect(body!.person.name).toBe('Case Matters');
    });

    it('does not match across workspaces', async () => {
      env.db
        .prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)')
        .run('wsp_bbbbbbbbbbbb', '2026-03-02T00:00:00.000Z', 'Other', 'startup-fundraising');
      env.db
        .prepare('INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, email, tags, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)')
        .run('per_otherworkspace', '2026-03-02T00:00:00.000Z', 'wsp_bbbbbbbbbbbb', 'Else', 'Where', 'else@example.com', '[]', '2026-03-02T00:00:00.000Z');
      const { status } = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/elsewhere', name: 'Else Where', email: 'else@example.com' });
      expect(status).toBe(201);
    });
  });

  describe('url canonicalization rejections', () => {
    const rejected: [string, string, string][] = [
      ['linkedin', 'https://www.linkedin.com/company/acme', 'not a profile path'],
      ['linkedin', 'https://www.linkedin.com/feed/', 'feed'],
      ['linkedin', 'https://example.com/in/ada', 'non linkedin host'],
      ['linkedin', 'https://x.com/ada', 'x host for linkedin source'],
      ['linkedin', 'not a url at all', 'garbage'],
      ['x', 'https://x.com/home', 'reserved path'],
      ['x', 'https://twitter.com/Settings', 'reserved path, any case'],
      ['x', 'https://x.com/i/status/1', 'reserved i'],
      ['x', 'https://x.com/bad-handle', 'bad characters'],
      ['x', 'https://x.com/abcdefghijklmnop', 'sixteen characters'],
      ['x', 'https://x.com/', 'no handle'],
      ['x', 'https://www.linkedin.com/in/ada', 'linkedin host for x source'],
      ['x', 'https://notx.com/ada', 'other host'],
    ];
    for (const [source, url, label] of rejected) {
      it(`rejects ${label} (${source})`, async () => {
        const before = totals();
        const { status, body } = await capture({ source, url, name: 'Nobody' });
        expect(status).toBe(400);
        expect(body!.error.code).toBe('validation');
        expect(body!.error.message).toMatch(/profile link/);
        expect(totals()).toEqual(before);
      });
    }
  });

  describe('validation rejections', () => {
    const base = { source: 'x', url: 'https://x.com/validname', name: 'Valid Name' };
    const bad: [string, Record<string, unknown>][] = [
      ['a missing name', { source: 'x', url: 'https://x.com/validname' }],
      ['a blank name', { ...base, name: '   ' }],
      ['a bio over 2000', { ...base, bio: 'a'.repeat(2001) }],
      ['a bad email', { ...base, email: 'not-an-email' }],
      ['an unknown source', { ...base, source: 'facebook' }],
      ['an unknown key', { ...base, extra: 'nope' }],
      ['a name over 200', { ...base, name: 'n'.repeat(201) }],
      ['a url over 500', { ...base, url: `https://x.com/validname?${'q'.repeat(500)}` }],
      ['a handle over 30', { ...base, handle: 'h'.repeat(31) }],
    ];
    for (const [label, payload] of bad) {
      it(`rejects ${label}`, async () => {
        const before = totals();
        const { status, body } = await capture(payload);
        expect(status).toBe(400);
        expect(body!.error.code).toBe('validation');
        expect(totals()).toEqual(before);
      });
    }

    it('accepts a bio of exactly 2000 characters', async () => {
      const { status } = await capture({ ...base, bio: 'b'.repeat(2000) });
      expect(status).toBe(201);
    });
  });
});

describe('normalizeXProfileUrl', () => {
  const accepted: [string, string][] = [
    ['https://x.com/jack', 'jack'],
    ['https://twitter.com/Jack', 'Jack'],
    ['https://www.x.com/jack/', 'jack'],
    ['https://mobile.twitter.com/jack?lang=en', 'jack'],
    ['http://www.twitter.com/Jack_1/with_replies', 'Jack_1'],
    ['x.com/jack', 'jack'],
    ['  https://x.com/jack  ', 'jack'],
    ['https://X.COM/jack', 'jack'],
    ['https://x.com/abcdefghijklmno', 'abcdefghijklmno'],
    ['https://x.com/jack/status/1234567890', 'jack'],
    ['https://x.com/homer', 'homer'],
  ];
  for (const [input, handle] of accepted) {
    it(`accepts ${input}`, () => {
      const result = normalizeXProfileUrl(input);
      expect(result).toEqual({ handle, key: handle.toLowerCase(), url: `https://x.com/${handle}` });
    });
  }

  const rejected: unknown[] = [
    '',
    '   ',
    null,
    undefined,
    42,
    'https://x.com',
    'https://x.com/',
    'https://x.com/home',
    'https://x.com/Explore',
    'https://x.com/notifications',
    'https://x.com/messages',
    'https://x.com/search?q=a',
    'https://x.com/settings',
    'https://x.com/i/flow/login',
    'https://x.com/compose/tweet',
    'https://x.com/intent/follow',
    'https://x.com/login',
    'https://x.com/signup',
    'https://x.com/about',
    'https://x.com/tos',
    'https://x.com/privacy',
    'https://x.com/jobs',
    'https://x.com/hashtag/news',
    'https://x.com/share',
    'https://x.com/download',
    'https://x.com/bad-handle',
    'https://x.com/@jack',
    'https://x.com/abcdefghijklmnop',
    'https://example.com/jack',
    'https://x.com.evil.com/jack',
    'https://evilx.com/jack',
    'https://user:pass@x.com/jack',
    'https://www.linkedin.com/in/jack',
    'ftp://x.com/jack',
    'http://[bad',
  ];
  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(normalizeXProfileUrl(input)).toBeNull();
    });
  }
});
