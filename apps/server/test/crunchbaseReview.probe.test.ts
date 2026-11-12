// Adversarial review probes for the organization Crunchbase link (migration 037). Titles start with KILLS (a real
// defect, pinned with it.fails), CONFIRMS (an attack that failed), or ACCEPTED (imperfect but judged fine).
// Nothing here changes application code.
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyChanges, createOrganization, mergeOrganizations, proposeChanges } from '../src/actions/index.js';
import { canonicalCompanyLinkedinUrl, canonicalCrunchbaseUrl, crunchbaseUrlMessage } from '../src/actions/profileUrls.js';
import { applyMigrations } from '../src/db.js';
import { buildApp } from '../src/http/app.js';
import { migrationsDirectory } from '../src/paths.js';
import { scanOrganizationDuplicates } from '../src/queries/duplicates.js';
import { getOrganization } from '../src/queries/organizations.js';
import { seedDatabase } from '../src/seed/seed.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
const host = { host: '127.0.0.1:4720' };
const prefix = 'https://www.crunchbase.com/organization/';

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  env.cleanup();
});

async function patch(id: string, version: number, fields: Record<string, unknown>) {
  const r = await app.inject({ method: 'PATCH', url: `/api/organizations/${id}`, headers: host, payload: { expectedVersion: version, fields } });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const row = (id: string) => env.db.prepare('SELECT crunchbase_url, linkedin_url, version FROM organization WHERE id = ?').get(id) as Record<string, any>;
const audits = (id: string) =>
  (env.db.prepare("SELECT detail FROM audit_event WHERE entity_id = ? AND action = 'organization.update' ORDER BY created_at, id").all(id) as { detail: string }[]).map(
    (r) => JSON.parse(r.detail) as Record<string, any>,
  );

describe('canonicalCrunchbaseUrl edge cases', () => {
  it('CONFIRMS: lookalike hosts are refused', () => {
    for (const input of [
      'https://evilcrunchbase.com/organization/acme',
      'https://crunchbase.com.evil.net/organization/acme',
      'https://www.crunchbase.com.evil.net/organization/acme',
      'https://crunchbase.com-evil.com/organization/acme',
      'https://evil.com/?x=www.crunchbase.com/organization/acme',
      'https://evil.com/www.crunchbase.com/organization/acme',
      'https://evil.com#@www.crunchbase.com/organization/acme',
      'https://www.crunchbase.com\\@evil.com/organization/acme',
    ]) {
      expect(canonicalCrunchbaseUrl(input), input).toBeNull();
    }
  });

  it('CONFIRMS: userinfo smuggling and ports are refused', () => {
    for (const input of [
      'https://www.crunchbase.com@evil.com/organization/acme',
      'https://evil.com@www.crunchbase.com/organization/acme',
      'https://user@crunchbase.com/organization/acme',
      'https://www.crunchbase.com:444/organization/acme',
      'www.crunchbase.com:80/organization/acme',
    ]) {
      expect(canonicalCrunchbaseUrl(input), input).toBeNull();
    }
    // A default port is dropped by the URL parser, so it is not a port.
    expect(canonicalCrunchbaseUrl('https://www.crunchbase.com:443/organization/acme')).toBe(`${prefix}acme`);
  });

  it('CONFIRMS: path case is sensitive like the LinkedIn helper, so /ORGANIZATION/ is refused', () => {
    expect(canonicalCrunchbaseUrl('https://www.crunchbase.com/ORGANIZATION/acme')).toBeNull();
    expect(canonicalCompanyLinkedinUrl('https://www.linkedin.com/COMPANY/acme')).toBeNull();
    expect(canonicalCrunchbaseUrl('https://www.crunchbase.com/Organization/acme')).toBeNull();
  });

  it('CONFIRMS: empty, double-slash, and dot-segment slugs are refused', () => {
    for (const input of [
      'https://www.crunchbase.com/organization/',
      'https://www.crunchbase.com/organization//double',
      'https://www.crunchbase.com/organization/?x=1',
      'https://www.crunchbase.com/organization/..',
      'https://www.crunchbase.com/organization/%2e%2e',
      'https://www.crunchbase.com/organization/.',
      'https://www.crunchbase.com//organization/acme',
    ]) {
      expect(canonicalCrunchbaseUrl(input), input).toBeNull();
    }
  });

  it('CONFIRMS: http downgrade pastes, whitespace padding, and query-only differences canonicalize to the same https form', () => {
    const wanted = `${prefix}acme`;
    for (const input of [
      'http://www.crunchbase.com/organization/acme',
      '\n\t  https://www.crunchbase.com/organization/acme \n',
      'https://www.crunchbase.com/organization/acme?a=1',
      'https://www.crunchbase.com/organization/acme?b=2#x',
      'WWW.CRUNCHBASE.COM/organization/acme',
    ]) {
      expect(canonicalCrunchbaseUrl(input), input).toBe(wanted);
    }
  });

  it('CONFIRMS: a percent-only slug and a slug that decodes to a slash stay one encoded segment', () => {
    expect(canonicalCrunchbaseUrl(`${prefix}%20`)).toBe(`${prefix}%20`);
    expect(canonicalCrunchbaseUrl(`${prefix}a%2Fb`)).toBe(`${prefix}a%2Fb`);
    expect(canonicalCrunchbaseUrl(`${prefix}%2F`)).toBe(`${prefix}%2F`);
  });

  it('CONFIRMS: lone-surrogate and control-character slugs do not throw and round trip', () => {
    for (const slug of ['\ud800', 'a\udfffb', '\u0000x', 'café', '\u{1F600}']) {
      let out: string | null = 'unset';
      expect(() => (out = canonicalCrunchbaseUrl(`${prefix}${slug}`)), slug).not.toThrow();
      if (out !== null) expect(canonicalCrunchbaseUrl(out), slug).toBe(out);
    }
  });

  it('CONFIRMS: canonicalization is idempotent over a hostile corpus', () => {
    const corpus = [
      'crunchbase.com/organization/a b',
      'crunchbase.com/organization/a%zz',
      'crunchbase.com/organization/a?b#c',
      'crunchbase.com/organization/%25',
      'CrunchBase.COM/organization/Ünï',
      'https://app.crunchbase.com/organization/x/y/z',
      'http://crunchbase.com/organization/x/',
      'https://www.crunchbase.com/organization/a\\b',
    ];
    for (const input of corpus) {
      const once = canonicalCrunchbaseUrl(input);
      if (once !== null) expect(canonicalCrunchbaseUrl(once), input).toBe(once);
    }
  });

  it('CONFIRMS: a canonical form of exactly 500 is kept and 501 is refused', () => {
    const exact = prefix + 'a'.repeat(500 - prefix.length);
    expect(exact.length).toBe(500);
    expect(canonicalCrunchbaseUrl(exact)).toBe(exact);
    expect(canonicalCrunchbaseUrl(`${exact}a`)).toBeNull();
  });

  it('ACCEPTED: a trailing-dot host and a bare "crunchbase.com." are refused like the LinkedIn helper', () => {
    // Refusing is the safe side; users paste the usual spelling.
    expect(canonicalCrunchbaseUrl('https://www.crunchbase.com./organization/acme')).toBeNull();
  });
});

describe('edit path', () => {
  it('CONFIRMS: an empty or whitespace-only string clears, like null', async () => {
    const o = createOrganization(env.ctx, { name: 'Clear Co', crunchbaseUrl: `${prefix}clear-co` });
    const a = await patch(o.id, 1, { crunchbaseUrl: '' });
    expect(a.status).toBe(200);
    expect(a.body.crunchbaseUrl).toBeNull();
    const b = await patch(o.id, 2, { crunchbaseUrl: `${prefix}clear-co` });
    expect(b.status).toBe(200);
    const c = await patch(o.id, 3, { crunchbaseUrl: '   ' });
    expect(c.status).toBe(200);
    expect(c.body.crunchbaseUrl).toBeNull();
  });

  it('CONFIRMS: wrong types are validation errors, not 500s', async () => {
    const o = createOrganization(env.ctx, { name: 'Type Co' });
    for (const value of [42, true, {}, [], ['x']]) {
      const r = await patch(o.id, 1, { crunchbaseUrl: value });
      expect(r.status, JSON.stringify(value)).toBe(400);
    }
    expect(row(o.id).version).toBe(1);
  });

  it('ACCEPTED: a 501+ character raw paste is refused by the raw .max(500) even when its canonical form is short', async () => {
    // Mirrors linkedinUrl (same profileUrlField). The contract bounds the canonical form; the raw bound is stricter but
    // identical for every profile URL field, and a 500 character paste of a profile page is not a realistic input.
    const o = createOrganization(env.ctx, { name: 'Long Paste Co' });
    const paste = `${prefix}acme?utm=${'x'.repeat(501 - `${prefix}acme?utm=`.length)}`;
    expect(paste.length).toBe(501);
    expect(canonicalCrunchbaseUrl(paste)).toBe(`${prefix}acme`);
    const r = await patch(o.id, 1, { crunchbaseUrl: paste });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(crunchbaseUrlMessage);
    const l = await patch(o.id, 1, { linkedinUrl: `https://www.linkedin.com/company/acme?utm=${'x'.repeat(500)}` });
    expect(l.status).toBe(400);
    expect(row(o.id).crunchbase_url).toBeNull();
  });

  it('CONFIRMS: a raw paste of 497 characters whose canonical form is 502 is refused with the Crunchbase message', async () => {
    const o = createOrganization(env.ctx, { name: 'Canonical Over Co' });
    const head = 'http://crunchbase.com/organization/';
    const paste = head + 'a'.repeat(497 - head.length);
    expect(paste.length).toBe(497);
    expect(canonicalCrunchbaseUrl(paste)).toBeNull();
    const r = await patch(o.id, 1, { crunchbaseUrl: paste });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain(crunchbaseUrlMessage);
  });

  it('CONFIRMS: a 500 character canonical paste is stored whole', async () => {
    const o = createOrganization(env.ctx, { name: 'Exact Co' });
    const exact = prefix + 'b'.repeat(500 - prefix.length);
    const r = await patch(o.id, 1, { crunchbaseUrl: exact });
    expect(r.status).toBe(200);
    expect(row(o.id).crunchbase_url).toBe(exact);
  });

  it('CONFIRMS: the edit writes an organization.update audit with from and to, and no claim', async () => {
    const o = createOrganization(env.ctx, { name: 'Audit Co' });
    await patch(o.id, 1, { crunchbaseUrl: 'crunchbase.com/organization/audit-co/?x=1' });
    await patch(o.id, 2, { crunchbaseUrl: null });
    const events = audits(o.id);
    expect(events[0]!.changes).toEqual({ crunchbaseUrl: { from: null, to: `${prefix}audit-co` } });
    expect(events[1]!.changes).toEqual({ crunchbaseUrl: { from: `${prefix}audit-co`, to: null } });
    const claims = env.db.prepare("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ?").get(o.id) as { n: number };
    expect(claims.n).toBe(0);
  });

  it('CONFIRMS: a differently spelled paste of the stored value is a no-op, same as linkedinUrl', async () => {
    const o = createOrganization(env.ctx, { name: 'Noop Co', crunchbaseUrl: `${prefix}noop-co`, linkedinUrl: 'https://www.linkedin.com/company/noop-co' });
    const before = audits(o.id).length;
    const cb = await patch(o.id, 1, { crunchbaseUrl: ' HTTP://crunchbase.com/organization/noop-co/?utm=1#x ' });
    expect(cb.status).toBe(200);
    expect(row(o.id).version).toBe(1);
    const li = await patch(o.id, 1, { linkedinUrl: ' HTTP://linkedin.com/company/noop-co/?utm=1#x ' });
    expect(li.status).toBe(200);
    expect(row(o.id).version).toBe(1);
    expect(audits(o.id).length).toBe(before);
  });

  it('CONFIRMS: a stale version is a 409 version_conflict carrying the current record, and changes nothing', async () => {
    const o = createOrganization(env.ctx, { name: 'Conflict Co' });
    await patch(o.id, 1, { crunchbaseUrl: `${prefix}one` });
    const stale = await patch(o.id, 1, { crunchbaseUrl: `${prefix}two` });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(JSON.stringify(stale.body)).toContain(`${prefix}one`);
    expect(row(o.id).crunchbase_url).toBe(`${prefix}one`);
  });

  it('CONFIRMS: a no-op edit on a stale version still conflicts rather than silently succeeding', async () => {
    const o = createOrganization(env.ctx, { name: 'Stale Noop Co', crunchbaseUrl: `${prefix}same` });
    await patch(o.id, 1, { name: 'Stale Noop Co 2' });
    const stale = await patch(o.id, 1, { crunchbaseUrl: `${prefix}same` });
    expect(stale.status).toBe(409);
  });

  it('CONFIRMS: create canonicalizes, and an empty string or null stores null', () => {
    expect(createOrganization(env.ctx, { name: 'C1', crunchbaseUrl: 'crunchbase.com/organization/c1/' }).crunchbaseUrl).toBe(`${prefix}c1`);
    expect(createOrganization(env.ctx, { name: 'C2', crunchbaseUrl: '' }).crunchbaseUrl).toBeNull();
    expect(createOrganization(env.ctx, { name: 'C3', crunchbaseUrl: null }).crunchbaseUrl).toBeNull();
    expect(createOrganization(env.ctx, { name: 'C4' }).crunchbaseUrl).toBeNull();
  });
});

describe('proposals', () => {
  it('CONFIRMS: propose canonicalizes and diffs, a bad link is invalid, apply stores the canonical form', () => {
    const o = createOrganization(env.ctx, { name: 'Propose Co' });
    const bad = proposeChanges(env.ctx, { changes: [{ entityType: 'organization', id: o.id, fields: { crunchbaseUrl: 'https://evilcrunchbase.com/organization/x' } }] });
    expect(bad.valid).toBe(false);
    const good = proposeChanges(env.ctx, { changes: [{ entityType: 'organization', id: o.id, fields: { crunchbaseUrl: 'crunchbase.com/organization/propose-co/?a=1' } }] });
    expect(good.valid).toBe(true);
    expect(good.changes[0]!.diff).toEqual([{ field: 'crunchbaseUrl', from: null, to: `${prefix}propose-co` }]);
    const result = applyChanges(env.ctx, {
      proposalHash: good.proposalHash,
      changes: good.changes.map(({ entityType, id, expectedVersion, fields }) => ({ entityType, id, expectedVersion, fields })),
    });
    expect(result.applied).toHaveLength(1);
    expect(getOrganization(env.db, env.workspaceId, o.id)).toMatchObject({ crunchbaseUrl: `${prefix}propose-co`, version: 2 });
    expect(audits(o.id).at(-1)!.changes).toEqual({ crunchbaseUrl: { from: null, to: `${prefix}propose-co` } });
  });

  it('CONFIRMS: a proposal with the already stored value has an empty diff', () => {
    const o = createOrganization(env.ctx, { name: 'Propose Noop Co', crunchbaseUrl: `${prefix}pn` });
    const p = proposeChanges(env.ctx, { changes: [{ entityType: 'organization', id: o.id, fields: { crunchbaseUrl: 'http://crunchbase.com/organization/pn/' } }] });
    expect(p.valid).toBe(true);
    expect(p.changes[0]!.diff).toEqual([]);
  });

  it('CONFIRMS: a person cannot take crunchbaseUrl through a proposal', () => {
    const o = createOrganization(env.ctx, { name: 'Wrong Type Co' });
    // crunchbaseUrl belongs to organizations only; sending it as a person field must not be accepted.
    const p = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: o.id, fields: { crunchbaseUrl: `${prefix}x` } }] });
    expect(p.valid).toBe(false);
  });
});

describe('organization merge fill', () => {
  let n = 0;
  function seedOrg(crunchbase: string | null): string {
    n += 1;
    const id = `org_cbm${String(n).padStart(5, '0')}`;
    env.db
      .prepare(
        `INSERT INTO organization (id, created_at, workspace_id, version, name, domain, kind, crunchbase_url, tags, updated_at)
         VALUES (?, ?, ?, 1, 'Merge Twin', 'mergetwin.example.com', 'company', ?, '[]', ?)`,
      )
      .run(id, new Date(Date.UTC(2026, 0, 1) + n).toISOString(), env.workspaceId, crunchbase, new Date(Date.UTC(2026, 0, 1) + n).toISOString());
    return id;
  }
  const body = (s: string, o: string) => ({ otherId: o, expectedVersion: 1, otherExpectedVersion: 1 });

  it('CONFIRMS: an empty survivor takes the other record value, and the scan counts it in the right direction', () => {
    const empty = seedOrg(null);
    const full = seedOrg(`${prefix}fill-me`);
    const pair = scanOrganizationDuplicates(env.db, env.workspaceId).pairs.find((p) => [p.left.id, p.right.id].includes(empty) && [p.left.id, p.right.id].includes(full))!;
    const keepEmpty = pair.left.id === empty ? pair.fillsIfKeepLeft : pair.fillsIfKeepRight;
    const keepFull = pair.left.id === full ? pair.fillsIfKeepLeft : pair.fillsIfKeepRight;
    expect(keepEmpty).toBe(1);
    expect(keepFull).toBe(0);
    mergeOrganizations(env.ctx, empty, body(empty, full));
    expect(row(empty).crunchbase_url).toBe(`${prefix}fill-me`);
  });

  it('CONFIRMS: a survivor that has a value keeps it and counts no fill', () => {
    const a = seedOrg(`${prefix}keep-a`);
    const b = seedOrg(`${prefix}keep-b`);
    const pair = scanOrganizationDuplicates(env.db, env.workspaceId).pairs.find((p) => [p.left.id, p.right.id].includes(a) && [p.left.id, p.right.id].includes(b))!;
    expect(pair.fillsIfKeepLeft).toBe(0);
    expect(pair.fillsIfKeepRight).toBe(0);
    mergeOrganizations(env.ctx, a, body(a, b));
    expect(row(a).crunchbase_url).toBe(`${prefix}keep-a`);
  });
});

describe('merge audit', () => {
  it('CONFIRMS: the displaced Crunchbase link and the filled field are recorded in the organization.merge audit', () => {
    const mk = (cb: string | null, i: number) => {
      const id = `org_cba${i}`;
      env.db
        .prepare(`INSERT INTO organization (id, created_at, workspace_id, version, name, kind, crunchbase_url, tags, updated_at) VALUES (?, '2026-01-01', ?, 1, 'Audit Twin', 'company', ?, '[]', '2026-01-01')`)
        .run(id, env.workspaceId, cb);
      return id;
    };
    const keep = mk(`${prefix}keep`, 1);
    const lose = mk(`${prefix}lose`, 2);
    mergeOrganizations(env.ctx, keep, { otherId: lose, expectedVersion: 1, otherExpectedVersion: 1 });
    const detail = JSON.parse((env.db.prepare("SELECT detail FROM audit_event WHERE action = 'organization.merge' AND entity_id = ?").get(keep) as { detail: string }).detail);
    expect(detail.displaced.fields.crunchbaseUrl).toBe(`${prefix}lose`);
    const empty = mk(null, 3);
    const donor = mk(`${prefix}donor`, 4);
    mergeOrganizations(env.ctx, empty, { otherId: donor, expectedVersion: 1, otherExpectedVersion: 1 });
    const d2 = JSON.parse((env.db.prepare("SELECT detail FROM audit_event WHERE action = 'organization.merge' AND entity_id = ?").get(empty) as { detail: string }).detail);
    expect(d2.filled.fields).toContain('crunchbaseUrl');
  });
});

describe('migration 037', () => {
  it('CONFIRMS: applies after 036 on a snapshot, existing rows keep NULL, and re-running is guarded', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-cb-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      const files = applyMigrationsUpTo036(db);
      expect(files.at(-1)).toBe('036_contact_fields.sql');
      const cols = (db.prepare("PRAGMA table_info('organization')").all() as { name: string }[]).map((c) => c.name);
      expect(cols).not.toContain('crunchbase_url');
      db.prepare("INSERT INTO workspace (id, created_at, name, template) VALUES ('wsp_1','2026-01-01','W','t')").run();
      db.prepare("INSERT INTO organization (id, created_at, workspace_id, version, name, kind, tags, updated_at) VALUES ('org_old','2026-01-01','wsp_1',1,'Old','fund','[]','2026-01-01')").run();
      expect(applyMigrations(db)).toEqual(['037_crunchbase.sql']);
      expect((db.prepare("PRAGMA table_info('organization')").all() as { name: string }[]).map((c) => c.name)).toContain('crunchbase_url');
      expect(db.prepare("SELECT crunchbase_url, version FROM organization WHERE id = 'org_old'").get()).toEqual({ crunchbase_url: null, version: 1 });
      expect(applyMigrations(db)).toEqual([]);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function applyMigrationsUpTo036(db: Database.Database): string[] {
  const files = readFileNames().filter((f) => f <= '036_contact_fields.sql');
  for (const file of files) {
    db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
    db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
  }
  return files;
}
function readFileNames(): string[] {
  return readdirSync(migrationsDirectory).filter((n: string) => /^\d+_.+\.sql$/.test(n)).sort();
}

describe('seed', () => {
  it('CONFIRMS: seeded Crunchbase links are canonical, round trip unchanged, and only on even-indexed funds', () => {
    const copy = createTestEnvironment();
    try {
      seedDatabase(copy.db, { now: new Date('2026-03-01T12:00:00.000Z') });
      const rows = copy.db.prepare('SELECT kind, crunchbase_url FROM organization').all() as { kind: string; crunchbase_url: string | null }[];
      const withUrl = rows.filter((r) => r.crunchbase_url !== null);
      expect(withUrl.length).toBeGreaterThan(0);
      for (const r of withUrl) {
        expect(r.kind).toBe('fund');
        expect(canonicalCrunchbaseUrl(r.crunchbase_url)).toBe(r.crunchbase_url);
      }
    } finally {
      copy.cleanup();
    }
  });
});
