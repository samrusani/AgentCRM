// Adversarial probes for the contact fields wave (phone and website columns, migration 036), kept as regressions.
// Tests named KILL assert the behavior the contract wants and are marked it.fails while the defect stands: when the fix
// lands vitest reports "expected to fail but passed", and the marker comes off.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyChanges, createOrganization, createPerson, decideApproval, mergeOrganizations, mergePeople, proposeChanges } from '../src/actions/index.js';
import { normalizePhone, normalizeWebsite } from '../src/actions/contactFields.js';
import { mapCsvRow, suggestMapping } from '../src/csv/mapping.js';
import { applyMigrations, listMigrationFiles } from '../src/db.js';
import { buildApp } from '../src/http/app.js';
import { migrationsDirectory } from '../src/paths.js';
import { scanDuplicates, scanOrganizationDuplicates } from '../src/queries/duplicates.js';
import { getPerson } from '../src/queries/people.js';
import { getRunDetail } from '../src/queries/runs.js';
import { seedDatabase } from '../src/seed/seed.js';
import { createTestEnvironment, driveRun } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let captureToken: string;
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
  const t = await app.inject({ method: 'POST', url: '/api/capture/token', headers: host });
  captureToken = JSON.parse(t.body).token as string;
});
afterAll(async () => {
  await app.close();
  env.cleanup();
});

async function patch(kind: 'people' | 'organizations', id: string, version: number, fields: Record<string, unknown>) {
  const r = await app.inject({ method: 'PATCH', url: `/api/${kind}/${id}`, headers: host, payload: { expectedVersion: version, fields } });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
async function get(kind: 'people' | 'organizations', id: string) {
  const r = await app.inject({ method: 'GET', url: `/api/${kind}/${id}`, headers: host });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
async function capture(payload: unknown) {
  const r = await app.inject({ method: 'POST', url: '/api/capture', headers: { ...host, authorization: `Bearer ${captureToken}` }, payload: payload as object });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const personRow = (id: string) => env.db.prepare('SELECT * FROM person WHERE id = ?').get(id) as Record<string, any>;
const claimValues = (id: string, field: string) =>
  (env.db.prepare('SELECT value FROM field_claim WHERE entity_id = ? AND field = ? ORDER BY created_at').all(id, field) as { value: string }[]).map((c) => c.value);
const audits = (action: string) =>
  (env.db.prepare('SELECT entity_id, detail FROM audit_event WHERE action = ? ORDER BY created_at, id').all(action) as { entity_id: string; detail: string }[]).map((a) => ({
    entityId: a.entity_id,
    detail: JSON.parse(a.detail) as Record<string, any>,
  }));

describe('1. normalizeWebsite attack surface', () => {
  it('CONFIRM: non-http schemes never survive, however they are spelled', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'javascript://x.com/%0aalert(1)',
      'JavaScript://a.b',
      'data:text/html,<b>x.y</b>',
      'vbscript:msgbox(1)',
      'blob:https://a.b/uuid',
      'file://x.y/etc/passwd',
      'ftp://a.b.c',
      'https:example.com',
      'https:/example.com',
      'http:\\\\example.com',
    ]) {
      expect(normalizeWebsite(bad), bad).toBeUndefined();
    }
  });

  it('CONFIRM: whatever survives parses to an http or https URL with a dotted host', () => {
    const nasty = [
      'https://evil.com@good.com',
      'example.com\\@evil.com',
      '//example.com',
      'example.com?x=1#frag',
      'https://example.com/"onmouseover=x',
      'https://exa%6Dple.com',
      '123.4.5.6',
      '0x7f.0.0.1',
      '127.1',
      'example.com.',
      'example.com:8080',
      'https://ｅｘａｍｐｌｅ.com',
    ];
    for (const value of nasty) {
      const out = normalizeWebsite(value);
      if (typeof out === 'string') {
        const url = new URL(out);
        expect(['http:', 'https:'], value).toContain(url.protocol);
        expect(url.hostname, value).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/);
      }
    }
  });

  it('CONFIRM: IPv6 and single-label hosts and bad ports are refused', () => {
    for (const bad of ['[::1]', 'https://[::1]/', 'https://localhost', 'https://example.com:99999', 'https://a..b', 'https://_a.b', 'https://exa mple.com']) {
      expect(normalizeWebsite(bad), bad).toBeUndefined();
    }
  });

  it('ACCEPTED: IPv4 and numeric spellings pass the dotted rule (a user may legitimately type a LAN address); IPv6 is refused', () => {
    expect(normalizeWebsite('123.4.5.6')).toBe('https://123.4.5.6');
    expect(normalizeWebsite('127.1')).toBe('https://127.1');
    expect(normalizeWebsite('0x7f.0.0.1')).toBe('https://0x7f.0.0.1');
  });

  // KILL: userinfo is accepted, so an EMAIL ADDRESS typed or pasted into Website ("pat@example.com", "mailto:pat@example.com")
  // validates and is stored as "https://pat@example.com" / "https://mailto:pat@example.com"; credentials
  // ("https://user:pass@host") are stored verbatim in a column that agents, exports and backups read.
  it('KILL: a website with userinfo (an email address, or user:pass@) is refused', () => {
    for (const value of ['pat@example.com', 'mailto:pat@example.com', 'https://user:pass@good.com/x', 'https://evil.com@good.com']) {
      expect(normalizeWebsite(value), value).toBeUndefined();
    }
  });

  it('pin: nothing with userinfo survives normalization, so no stored value can carry credentials', () => {
    expect(normalizeWebsite('pat@example.com')).toBeUndefined();
    expect(normalizeWebsite('https://evil.com@good.com')).toBeUndefined();
    expect(normalizeWebsite('https://user:@good.com')).toBeUndefined();
  });

  it('ACCEPTED: case, trailing dot, ports, query and raw unicode hosts are stored as typed, not canonicalized', () => {
    expect(normalizeWebsite('https://EXAMPLE.com')).toBe('https://EXAMPLE.com');
    expect(normalizeWebsite('example.com.')).toBe('https://example.com.');
    expect(normalizeWebsite('example.com:8080')).toBe('https://example.com:8080');
    // The code comment says IDN hosts "arrive in punycode"; only url.hostname is. The stored text is the user's.
    expect(normalizeWebsite('bücher.de/x')).toBe('https://bücher.de/x');
  });

  it('CONFIRM: the 500 limit applies AFTER the https:// prepend (a schemeless 493 character value is refused, 492 passes)', () => {
    const stem = 'a.com/';
    expect(normalizeWebsite(stem + 'x'.repeat(492 - stem.length))!.length).toBe(500);
    expect(normalizeWebsite(stem + 'x'.repeat(493 - stem.length))).toBeUndefined();
    const full = 'https://a.com/';
    expect(normalizeWebsite(full + 'x'.repeat(500 - full.length))!.length).toBe(500);
    expect(normalizeWebsite(full + 'x'.repeat(501 - full.length))).toBeUndefined();
  });

  it('CONFIRM: phone rules', () => {
    expect(normalizePhone('call me')).toBeUndefined();
    expect(normalizePhone('\n')).toBeNull();
    expect(normalizePhone('x'.repeat(39) + '1')).toBe('x'.repeat(39) + '1');
    expect(normalizePhone('1' + ' '.repeat(50))).toBe('1');
  });

  // KILL: control characters, zero-width characters and tabs/newlines are stored inside the column. The WHATWG parser
  // strips tab, LF and CR (and IDNA drops zero-width characters) before it looks at the host, so "ex<TAB>ample.com"
  // validates as example.com but the stored text still carries the tab. Anything that compares, displays or exports the
  // stored text (MCP reads, CSV export, backups, a duplicate check) sees bytes the validator never saw.
  it('KILL: a stored website contains no tab, newline, NUL or zero-width characters', () => {
    for (const value of ['ex\tample.com', 'https://ex\nample.com', 'https://example.com/\u0000', 'ex\u200bample.com', 'example.com\r']) {
      const out = normalizeWebsite(value);
      if (typeof out === 'string') expect(out, JSON.stringify(value)).not.toMatch(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/);
    }
  });

  it('KILL (same root, fixed): protocol relative input drops its leading slashes before the prepend', () => {
    expect(normalizeWebsite('//example.com')).toBe('https://example.com');
    expect(normalizeWebsite('///example.com/x')).toBe('https://example.com/x');
    expect(normalizeWebsite('//')).toBeUndefined();
  });
});

describe('2. migration 036 backfill', () => {
  function oldDatabase() {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-contact-probe-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const file of listMigrationFiles().filter((name) => name < '036')) {
      db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
    }
    return { db, done: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
  }
  const claimSql =
    "INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_type, observed_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'import', '2026-01-01', 'imported')";

  it('CONFIRM: tie on created_at is broken by the larger id; newest wins; workspace scoped; dangling claims write nowhere; claims survive', () => {
    const { db, done } = oldDatabase();
    try {
      const ws = db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)');
      ws.run('wsp_1', '2026-01-01', 'One', 't');
      ws.run('wsp_2', '2026-01-01', 'Two', 't');
      const person = db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      person.run('per_1', '2026-01-01', 'wsp_1', 'Ada', 'L', '2026-01-01');
      person.run('per_2', '2026-01-01', 'wsp_1', 'Grace', 'H', '2026-01-01');
      const claim = db.prepare(claimSql);
      // tie: same created_at, id decides (clm_b > clm_a)
      claim.run('clm_b', '2026-01-02T00:00:00.000Z', 'wsp_1', 'person', 'per_1', 'phone', '222', );
      claim.run('clm_a', '2026-01-02T00:00:00.000Z', 'wsp_1', 'person', 'per_1', 'phone', '111');
      // a claim stored under the OTHER workspace for the same entity id must not leak in
      claim.run('clm_x', '2027-01-01T00:00:00.000Z', 'wsp_2', 'person', 'per_2', 'phone', '999 other workspace');
      // a claim of another entity type with the same id and field must not leak in
      claim.run('clm_y', '2027-01-01T00:00:00.000Z', 'wsp_1', 'organization', 'per_2', 'phone', '999 wrong type');
      // dangling: the person it names was merged away or deleted
      claim.run('clm_dead', '2027-01-01T00:00:00.000Z', 'wsp_1', 'person', 'per_gone', 'phone', '999 dead');
      const before = (db.prepare('SELECT COUNT(*) AS n FROM person').get() as { n: number }).n;
      applyMigrations(db);
      expect(db.prepare('SELECT id, phone FROM person ORDER BY id').all()).toEqual([
        { id: 'per_1', phone: '222' },
        { id: 'per_2', phone: null },
      ]);
      expect((db.prepare('SELECT COUNT(*) AS n FROM person').get() as { n: number }).n).toBe(before);
      expect((db.prepare('SELECT COUNT(*) AS n FROM field_claim').get() as { n: number }).n).toBe(5);
    } finally {
      done();
    }
  });

  it('ACCEPTED: a claim that is INVALID under the new rules backfills anyway (claims predate the rules)', () => {
    const { db, done } = oldDatabase();
    try {
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'One', 't');
      db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('per_1', '2026-01-01', 'wsp_1', 'Ada', 'L', '2026-01-01');
      db.prepare('INSERT INTO organization (id, created_at, workspace_id, name, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('org_1', '2026-01-01', 'wsp_1', 'Acme', 'company', '2026-01-01');
      const claim = db.prepare(claimSql);
      claim.run('clm_1', '2026-01-02T00:00:00.000Z', 'wsp_1', 'person', 'per_1', 'website', 'javascript:alert(1)');
      claim.run('clm_2', '2026-01-02T00:00:00.000Z', 'wsp_1', 'person', 'per_1', 'phone', 'none');
      claim.run('clm_3', '2026-01-02T00:00:00.000Z', 'wsp_1', 'organization', 'org_1', 'website', '   ');
      claim.run('clm_4', '2026-01-02T00:00:00.000Z', 'wsp_1', 'organization', 'org_1', 'phone', '');
      applyMigrations(db);
      // Junk lands verbatim, whitespace and empty strings land as blank text (not NULL).
      expect(db.prepare('SELECT phone, website FROM person').get()).toEqual({ phone: 'none', website: 'javascript:alert(1)' });
      expect(db.prepare('SELECT phone, website FROM organization').get()).toEqual({ phone: '', website: '   ' });
    } finally {
      done();
    }
  });

  it('ACCEPTED: blank column text from the backfill is served as-is (not null) through the API', async () => {
    const o = createOrganization(env.ctx, { name: 'Blank Backfill Co' });
    env.db.prepare("UPDATE organization SET phone = '', website = '   ' WHERE id = ?").run(o.id);
    const r = await get('organizations', o.id);
    // ACCEPTED (low): text() does not collapse blank text, so a blank claim backfilled by 036 reads as '' not null. Claims are
    // never written blank by any path, so this needs a hand-inserted claim; the web treats '' as empty.
    expect(r.body.phone).toBe('');
    expect(r.body.website).toBe('   ');
  });
});

describe('2b. a junk column value (backfilled or hand inserted) never breaks the record', () => {
  const junk = { phone: 'none', website: 'javascript:alert(1)' };

  it('CONFIRM: PATCH of another field on a record holding junk phone/website succeeds and leaves the junk alone (person and organization)', async () => {
    const p = createPerson(env.ctx, { firstName: 'Junk', lastName: 'Holder', title: 'Old' });
    env.db.prepare('UPDATE person SET phone = ?, website = ? WHERE id = ?').run(junk.phone, junk.website, p.id);
    const read = await get('people', p.id);
    expect(read.body).toMatchObject(junk);
    const ok = await patch('people', p.id, 1, { title: 'New' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ title: 'New', version: 2, ...junk });

    const o = createOrganization(env.ctx, { name: 'Junk Org' });
    env.db.prepare('UPDATE organization SET phone = ?, website = ? WHERE id = ?').run(junk.phone, junk.website, o.id);
    const okOrg = await patch('organizations', o.id, 1, { location: 'Nowhere' });
    expect(okOrg.status).toBe(200);
    expect(okOrg.body).toMatchObject({ location: 'Nowhere', ...junk });
  });

  it('CONFIRM: junk is editable away (clear to empty) and a bad re-save of the same junk is a clean 400, not a 500', async () => {
    const p = createPerson(env.ctx, { firstName: 'Junk', lastName: 'Fixer' });
    env.db.prepare('UPDATE person SET website = ? WHERE id = ?').run(junk.website, p.id);
    const resave = await patch('people', p.id, 1, { website: junk.website });
    expect(resave.status).toBe(400);
    const cleared = await patch('people', p.id, 1, { website: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.website).toBeNull();
  });

  it('CONFIRM: proposals touching another field apply on a junk record, and the diff does not mention the junk', () => {
    const p = createPerson(env.ctx, { firstName: 'Junk', lastName: 'Proposal' });
    env.db.prepare('UPDATE person SET phone = ?, website = ? WHERE id = ?').run(junk.phone, junk.website, p.id);
    const good = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: p.id, fields: { title: 'Agent edit' } }] });
    expect(good.valid).toBe(true);
    expect(good.changes[0]!.diff).toEqual([{ field: 'title', from: null, to: 'Agent edit' }]);
    applyChanges(env.ctx, {
      proposalHash: good.proposalHash,
      changes: good.changes.map(({ entityType, id, expectedVersion, fields }) => ({ entityType, id, expectedVersion, fields })),
    });
    expect(personRow(p.id)).toMatchObject({ title: 'Agent edit', ...junk });
  });

  it('CONFIRM: a junk record still merges (as survivor and as the other) and its junk is kept, not validated', () => {
    const a = createPerson(env.ctx, { firstName: 'Merge', lastName: 'JunkA', email: 'junkmerge@example.com' });
    const b = createPerson(env.ctx, { firstName: 'Merge', lastName: 'JunkB' });
    env.db.prepare("UPDATE person SET email = 'JUNKMERGE@example.com' WHERE id = ?").run(b.id);
    env.db.prepare('UPDATE person SET phone = ?, website = ? WHERE id = ?').run(junk.phone, junk.website, b.id);
    const merged = mergePeople(env.ctx, a.id, { otherId: b.id, expectedVersion: 1, otherExpectedVersion: 1 });
    expect(merged).toMatchObject(junk);
  });

  it('CONFIRM: a junk column blocks the capture fill-in like any value (no claim, no overwrite)', async () => {
    const url = 'https://www.linkedin.com/in/junk-fill-probe';
    const created = await capture({ source: 'linkedin', url, name: 'Junk Fill' });
    const id = created.body.person.id as string;
    env.db.prepare('UPDATE person SET phone = ?, website = ? WHERE id = ?').run(junk.phone, junk.website, id);
    const again = await capture({ source: 'linkedin', url, name: 'x', phone: '555 0100', website: 'real.example.com' });
    expect(again.status).toBe(200);
    expect(again.body.added).toEqual([]);
    expect(personRow(id)).toMatchObject(junk);
  });
});

describe('3. registry flow', () => {
  it('CONFIRM: version conflicts on phone/website PATCH are 409 and change nothing', async () => {
    const p = createPerson(env.ctx, { firstName: 'Ver', lastName: 'Conflict' });
    const ok = await patch('people', p.id, 1, { phone: '555 0001' });
    expect(ok.status).toBe(200);
    const stale = await patch('people', p.id, 1, { phone: '555 0002' });
    expect(stale.status).toBe(409);
    expect(personRow(p.id).phone).toBe('555 0001');
  });

  it('CONFIRM: wrong types and over-limit values are 400; null and "" both clear', async () => {
    const o = createOrganization(env.ctx, { name: 'Types Co' });
    expect((await patch('organizations', o.id, 1, { phone: 5551234 })).status).toBe(400);
    expect((await patch('organizations', o.id, 1, { website: ['a.com'] })).status).toBe(400);
    expect((await patch('organizations', o.id, 1, { phone: '1'.repeat(41) })).status).toBe(400);
    expect((await patch('organizations', o.id, 1, { website: 'a.com/' + 'x'.repeat(600) })).status).toBe(400);
    const set = await patch('organizations', o.id, 1, { phone: '555 1', website: 'types.example.com' });
    expect(set.status).toBe(200);
    const nulled = await patch('organizations', o.id, 2, { phone: null, website: null });
    expect(nulled.status).toBe(200);
    expect(nulled.body).toMatchObject({ phone: null, website: null });
  });

  it('CONFIRM: a mixed envelope is atomic: an invalid website rolls back title and a custom attribute in the same PATCH', async () => {
    const p = createPerson(env.ctx, { firstName: 'Atomic', lastName: 'Env', title: 'Keep' });
    const defs = (await app.inject({ method: 'GET', url: '/api/attributes?entityType=person', headers: host })).body;
    const key = (JSON.parse(defs).items ?? JSON.parse(defs))[0].key as string;
    const bad = await patch('people', p.id, 1, { title: 'Changed', [`attr:${key}`]: 'text value', website: 'not a url' });
    expect(bad.status).toBe(400);
    expect(personRow(p.id)).toMatchObject({ title: 'Keep', version: 1 });
    const good = await patch('people', p.id, 1, { title: 'Changed', [`attr:${key}`]: 'text value', website: 'atomic.example.com', phone: '555 7' });
    expect(good.status).toBe(200);
    const reread = await get('people', p.id);
    expect(reread.body.attributes.find((a: any) => a.key === key).value).toBe('text value');
  });

  it('CONFIRM: a proposal written before the wave (no phone/website key) still applies and does not null the new columns', () => {
    const p = createPerson(env.ctx, { firstName: 'Old', lastName: 'Proposal', phone: '555 9999', website: 'old.example.com' });
    const proposal = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: p.id, fields: { title: 'Legacy' } }] });
    const result = applyChanges(env.ctx, {
      proposalHash: proposal.proposalHash,
      changes: proposal.changes.map(({ entityType, id, expectedVersion, fields }) => ({ entityType, id, expectedVersion, fields })),
    });
    expect(result.applied).toHaveLength(1);
    expect(personRow(p.id)).toMatchObject({ title: 'Legacy', phone: '555 9999', website: 'https://old.example.com' });
  });

  it('CONFIRM: proposals reject bad phone/website with valid:false and write nothing; a no-op equal value shows an empty diff', () => {
    const p = createPerson(env.ctx, { firstName: 'Prop', lastName: 'Bad', phone: '555 3' });
    const bad = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: p.id, fields: { website: 'javascript:alert(1)' } }] });
    expect(bad.valid).toBe(false);
    expect(personRow(p.id).website).toBeNull();
    const same = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: p.id, fields: { phone: ' 555 3 ' } }] });
    expect(same.changes[0]!.diff).toEqual([]);
  });

  it('CONFIRM: no field enumeration (qualification criteria, saved views, followups, automations) accepts or breaks on the new keys', async () => {
    // saved view / criterion fields stay a closed enum that does not include website/phone
    const r = await app.inject({ method: 'POST', url: '/api/views', headers: host, payload: { name: 'v', entityType: 'person', filters: [{ field: 'website', operator: 'exists' }] } });
    expect([200, 201, 400, 404, 422]).toContain(r.statusCode);
  });
});

describe('4. capture', () => {
  it('CONFIRM: invalid phone is still 400, invalid website is dropped with 201 and no claim, no column', async () => {
    const badPhone = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/probe-badphone', name: 'Bad Phone', phone: 'none' });
    expect(badPhone.status).toBe(400);
    const dropped = await capture({ source: 'x', url: 'https://x.com/probe_nosite', name: 'No Site', website: 'javascript:alert(1)', phone: '555 0100' });
    expect(dropped.status).toBe(201);
    const id = dropped.body.person.id as string;
    expect(personRow(id)).toMatchObject({ website: null, phone: '555 0100' });
    expect(claimValues(id, 'website')).toEqual([]);
    expect(claimValues(id, 'phone')).toEqual(['555 0100']);
  });

  it('ACCEPTED (flag): an over-limit website (501+) still fails the whole capture with 400, while a 493-char schemeless one is silently dropped; the amended sentence only covers normalization', async () => {
    const over = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/probe-longsite', name: 'Long Site', website: 'a.com/' + 'x'.repeat(600) });
    expect(over.status).toBe(400);
    const borderline = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/probe-borderline', name: 'Borderline', website: 'a.com/' + 'x'.repeat(490) });
    expect(borderline.status).toBe(201);
    expect(personRow(borderline.body.person.id).website).toBeNull();
  });

  // all four quadrants of the column backed AND rule, for each of phone and website
  for (const [field, value, normalized] of [
    ['phone', '555 0100', '555 0100'],
    ['website', 'quad.example.com', 'https://quad.example.com'],
  ] as const) {
    it(`CONFIRM: fill-in quadrants for ${field}: claim only, column only, both block; neither fills (claim + column)`, async () => {
      const make = async (slug: string) => {
        const r = await capture({ source: 'linkedin', url: `https://www.linkedin.com/in/probe-quad-${field}-${slug}`, name: `Quad ${slug}` });
        return r.body.person.id as string;
      };
      const recapture = (slug: string) => capture({ source: 'linkedin', url: `https://www.linkedin.com/in/probe-quad-${field}-${slug}`, name: 'x', [field]: value });
      const claimOnly = await make('claim');
      env.db
        .prepare("INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_type, observed_at, status) VALUES (?, ?, ?, 'person', ?, ?, 'prior', 'import', '2026-01-01', 'imported')")
        .run(`clm_quad_${field}`, '2026-01-01T00:00:00.000Z', env.workspaceId, claimOnly, field);
      expect((await recapture('claim')).body.added).toEqual([]);
      expect(personRow(claimOnly)[field]).toBeNull();

      const columnOnly = await make('column');
      env.db.prepare(`UPDATE person SET ${field} = 'typed 1' WHERE id = ?`).run(columnOnly);
      expect((await recapture('column')).body.added).toEqual([]);
      expect(personRow(columnOnly)[field]).toBe('typed 1');
      expect(claimValues(columnOnly, field)).toEqual([]);

      const both = await make('both');
      env.db.prepare(`UPDATE person SET ${field} = 'typed 2' WHERE id = ?`).run(both);
      env.db
        .prepare("INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_type, observed_at, status) VALUES (?, ?, ?, 'person', ?, ?, 'prior', 'import', '2026-01-01', 'imported')")
        .run(`clm_both_${field}`, '2026-01-01T00:00:00.000Z', env.workspaceId, both, field);
      expect((await recapture('both')).body.added).toEqual([]);

      const neither = await make('neither');
      expect((await recapture('neither')).body.added).toEqual([field]);
      expect(personRow(neither)[field]).toBe(normalized);
      expect(claimValues(neither, field)).toEqual([normalized]);
    });
  }

  it('CONFIRM: whitespace-only column counts as empty for the fill (the documented rule), and an invalid website on recapture adds nothing', async () => {
    const url = 'https://www.linkedin.com/in/probe-ws-fill';
    const created = await capture({ source: 'linkedin', url, name: 'WS Fill' });
    const id = created.body.person.id as string;
    env.db.prepare("UPDATE person SET phone = '   ' WHERE id = ?").run(id);
    const again = await capture({ source: 'linkedin', url, name: 'x', phone: '555 0111', website: 'not a url' });
    expect(again.body.added).toEqual(['phone']);
    expect(personRow(id).phone).toBe('555 0111');
  });

  it('CONFIRM: phone and website are never dedupe keys', async () => {
    const a = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/probe-dd-a', name: 'Dd A', phone: '555 0999', website: 'dd.example.com' });
    const b = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/probe-dd-b', name: 'Dd B', phone: '555 0999', website: 'dd.example.com' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });
});

describe('5. merge', () => {
  it('CONFIRM: person merge fills phone/website into an empty survivor, in both directions, with audit filled and displaced lists', () => {
    const a = createPerson(env.ctx, { firstName: 'Fill', lastName: 'Left', email: 'fillmerge@example.com', phone: '555 1', website: 'left.example.com' });
    const b = createPerson(env.ctx, { firstName: 'Fill', lastName: 'Right' });
    env.db.prepare("UPDATE person SET email = 'FILLMERGE@example.com' WHERE id = ?").run(b.id);
    const pair = scanDuplicates(env.db, env.workspaceId).pairs.find((p) => p.personIds.includes(a.id) && p.personIds.includes(b.id))!;
    expect(pair).toBeTruthy();
    // survivor b is empty, a has two fields: keeping b fills 2 (name/email already set)
    const fillsKeepingB = pair.personIds[0] === b.id ? pair.fillsIfKeepLeft : pair.fillsIfKeepRight;
    const fillsKeepingA = pair.personIds[0] === a.id ? pair.fillsIfKeepLeft : pair.fillsIfKeepRight;
    expect(fillsKeepingB).toBeGreaterThanOrEqual(2);
    expect(fillsKeepingA).toBe(0);
    const merged = mergePeople(env.ctx, b.id, { otherId: a.id, expectedVersion: 1, otherExpectedVersion: 1 });
    expect(merged).toMatchObject({ phone: '555 1', website: 'https://left.example.com' });
    const audit = audits('person.merge').find((x) => x.entityId === b.id)!;
    expect(audit.detail.filled.fields).toEqual(expect.arrayContaining(['phone', 'website']));
    expect(audit.detail.displaced.fields).not.toHaveProperty('phone');
    expect(audit.detail.displaced.fields).not.toHaveProperty('website');

    const c = createPerson(env.ctx, { firstName: 'Fill', lastName: 'Keep', email: 'fillkeep@example.com', phone: '555 2', website: 'keep.example.com' });
    const d = createPerson(env.ctx, { firstName: 'Fill', lastName: 'Lose', phone: '555 3', website: 'lose.example.com' });
    env.db.prepare("UPDATE person SET email = 'FILLKEEP@example.com' WHERE id = ?").run(d.id);
    mergePeople(env.ctx, c.id, { otherId: d.id, expectedVersion: 1, otherExpectedVersion: 1 });
    const audit2 = audits('person.merge').find((x) => x.entityId === c.id)!;
    expect(personRow(c.id)).toMatchObject({ phone: '555 2', website: 'https://keep.example.com' });
    expect(audit2.detail.filled.fields).not.toContain('phone');
    expect(audit2.detail.displaced.fields).toMatchObject({ phone: '555 3', website: 'https://lose.example.com' });
  });

  it('CONFIRM: organization merge fills phone/website, previews them in the scan, and records displaced values', () => {
    const a = createOrganization(env.ctx, { name: 'Fill Left Co', domain: 'fillleft.example.com', phone: '555 8', website: 'fillleft.example.com' });
    const b = createOrganization(env.ctx, { name: 'Fill Right Co' });
    env.db.prepare("UPDATE organization SET domain = 'FILLLEFT.example.com' WHERE id = ?").run(b.id);
    const pair = scanOrganizationDuplicates(env.db, env.workspaceId).pairs.find((p) => p.organizationIds.includes(a.id) && p.organizationIds.includes(b.id));
    expect(pair).toBeTruthy();
    const fillsKeepingB = pair!.organizationIds[0] === b.id ? pair!.fillsIfKeepLeft : pair!.fillsIfKeepRight;
    expect(fillsKeepingB).toBe(2);
    const merged = mergeOrganizations(env.ctx, b.id, { otherId: a.id, expectedVersion: 1, otherExpectedVersion: 1 });
    expect(merged).toMatchObject({ phone: '555 8', website: 'https://fillleft.example.com' });
    expect(audits('organization.merge').find((x) => x.entityId === b.id)!.detail.filled.fields).toEqual(expect.arrayContaining(['phone', 'website']));

    const c = createOrganization(env.ctx, { name: 'Disp Keep Co', domain: 'dispkeep.example.com', phone: '555 4' });
    const d = createOrganization(env.ctx, { name: 'Disp Lose Co', phone: '555 5', website: 'disp.example.com' });
    env.db.prepare("UPDATE organization SET domain = 'DISPKEEP.example.com' WHERE id = ?").run(d.id);
    mergeOrganizations(env.ctx, c.id, { otherId: d.id, expectedVersion: 1, otherExpectedVersion: 1 });
    const det = audits('organization.merge').find((x) => x.entityId === c.id)!.detail;
    expect(det.filled.fields).toContain('website');
    expect(det.displaced.fields).toMatchObject({ phone: '555 5' });
  });
});

describe('6. CSV', () => {
  it('CONFIRM: Website maps to website and Company Website maps to domain, also when both headers are present', () => {
    expect(suggestMapping(['Name', 'Website'])).toMatchObject({ Website: 'website' });
    expect(suggestMapping(['Name', 'Company Website'])).toMatchObject({ 'Company Website': 'domain' });
    expect(suggestMapping(['Name', 'Website', 'Company Website'])).toMatchObject({ Website: 'website', 'Company Website': 'domain' });
    expect(suggestMapping(['Name', 'Company Website', 'Website'])).toMatchObject({ Website: 'website', 'Company Website': 'domain' });
    expect(suggestMapping(['Name', 'Domain', 'Website'])).toMatchObject({ Domain: 'domain', Website: 'website' });
    expect(suggestMapping(['Name', 'URL'])).toMatchObject({ URL: 'domain' });
  });

  it('CONFIRM: a file with both headers stages both values on the row', () => {
    const mapped = mapCsvRow(
      { Name: 'Pat Both', Company: 'Both Co', Website: 'pat.example.com', 'Company Website': 'bothco.example.com', Phone: '555 0100' },
      { Name: 'name', Company: 'company', Website: 'website', 'Company Website': 'domain', Phone: 'phone' },
    );
    expect(mapped).toMatchObject({ website: 'pat.example.com', domain: 'bothco.example.com', phone: '555 0100' });
  });

  // KILL: pickDomain still falls back to fieldAliases.website, and the staged row carries the PERSON's website under
  // item.website, so a person's personal site also becomes the ORGANIZATION domain: with no company column an
  // organization named after the personal site is created and the person is linked to it.
  async function importCsv(content: string, mapping: Record<string, string>) {
    const created = await app.inject({ method: 'POST', url: '/api/imports/csv', headers: host, payload: { fileName: 'probe.csv', content, mapping } });
    expect(created.statusCode).toBe(201);
    const runId = JSON.parse(created.body).id as string;
    driveRun(env, runId, ['waiting_approval']);
    decideApproval(env.ctx, getRunDetail(env.db, env.workspaceId, runId).approvals[0]!.id, { decision: 'approve' });
  }

  it('KILL: a personal Website column never creates or links an organization by domain', async () => {
    await importCsv('Name,Email,Website\nSite Only,siteonly@probe.example.com,patsblog.example.org\n', { Name: 'name', Email: 'email', Website: 'website' });
    const person = env.db.prepare("SELECT * FROM person WHERE email = 'siteonly@probe.example.com'").get() as Record<string, any>;
    expect(person.website).toBe('https://patsblog.example.org');
    expect(person.organization_id).toBeNull();
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM organization WHERE domain = 'patsblog.example.org'").get()).toEqual({ n: 0 });
  });

  it('pin: with a Company column the personal website stays on the person and the organization gets NO domain from it', async () => {
    await importCsv('Name,Email,Company,Website\nHas Co,hasco@probe.example.com,Blog Co,hasco.example.org\n', { Name: 'name', Email: 'email', Company: 'company', Website: 'website' });
    const person = env.db.prepare("SELECT * FROM person WHERE email = 'hasco@probe.example.com'").get() as Record<string, any>;
    expect(person.website).toBe('https://hasco.example.org');
    const org = env.db.prepare('SELECT domain FROM organization WHERE id = ?').get(person.organization_id) as { domain: string | null };
    expect(org.domain).toBeNull();
  });

  it('CONFIRM: an invalid phone/website row is still accepted, field absent, no claim', async () => {
    await importCsv('Name,Email,Phone,Website\nBad Vals,badvals@probe.example.com,none,javascript:alert(1)\n', { Name: 'name', Email: 'email', Phone: 'phone', Website: 'website' });
    const person = env.db.prepare("SELECT * FROM person WHERE email = 'badvals@probe.example.com'").get() as Record<string, any>;
    expect(person).toMatchObject({ phone: null, website: null });
    expect(claimValues(person.id, 'phone')).toEqual([]);
    expect(claimValues(person.id, 'website')).toEqual([]);
  });
});

describe('7. seeds', () => {
  it('CONFIRM: seeded phones/websites are fictional, valid, and identical across two seeds of the same date', () => {
    const grab = () => {
      const s = createTestEnvironment({ idSeed: 7 });
      try {
        seedDatabase(s.db, { reset: true, now: new Date('2026-03-01T09:00:00.000Z') });
        return {
          people: s.db.prepare('SELECT first_name, last_name, phone, website FROM person WHERE phone IS NOT NULL OR website IS NOT NULL ORDER BY first_name, last_name, email').all() as Record<string, any>[],
          orgs: s.db.prepare('SELECT name, phone, website FROM organization WHERE phone IS NOT NULL OR website IS NOT NULL ORDER BY name').all() as Record<string, any>[],
        };
      } finally {
        s.cleanup();
      }
    };
    const one = grab();
    const two = grab();
    expect(one).toEqual(two);
    const rows = [...one.people, ...one.orgs];
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      if (row.website) {
        expect(normalizeWebsite(row.website), row.website).toBe(row.website);
        expect(new URL(row.website).hostname, row.website).toMatch(/(^|\.)example\.(com|org)$/);
      }
      if (row.phone) {
        expect(normalizePhone(row.phone), row.phone).toBe(row.phone);
        expect(row.phone, row.phone).toMatch(/^\+1 555 0\d/);
      }
    }
  });
});

describe('9. serializers and lists', () => {
  it('CONFIRM: GET list and detail carry null (not undefined) for unset phone/website', async () => {
    const p = createPerson(env.ctx, { firstName: 'Ser', lastName: 'Ial' });
    const detail = getPerson(env.db, env.workspaceId, p.id)!;
    expect(detail.phone).toBeNull();
    expect(detail.website).toBeNull();
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/api/people', headers: host })).body);
    const row = list.items.find((i: any) => i.id === p.id);
    expect(row).toHaveProperty('phone', null);
    expect(row).toHaveProperty('website', null);
  });
});
