import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyChanges,
  createOrganization,
  createPerson,
  decideApproval,
  proposeChanges,
} from '../src/actions/index.js';
import { normalizePhone, normalizeWebsite } from '../src/actions/contactFields.js';
import { suggestMapping } from '../src/csv/mapping.js';
import { applyMigrations, listMigrationFiles } from '../src/db.js';
import { buildApp } from '../src/http/app.js';
import { migrationsDirectory } from '../src/paths.js';
import { getOrganization } from '../src/queries/organizations.js';
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

async function capture(payload: unknown) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/capture',
    headers: { ...host, authorization: `Bearer ${captureToken}` },
    payload: payload as object,
  });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

const personRow = (id: string) => env.db.prepare('SELECT * FROM person WHERE id = ?').get(id) as Record<string, any>;
const claimValues = (id: string, field: string) =>
  (env.db.prepare('SELECT value FROM field_claim WHERE entity_id = ? AND field = ? ORDER BY created_at').all(id, field) as { value: string }[]).map((c) => c.value);

describe('migration 036', () => {
  it('adds the columns and backfills empty ones from the newest claim, never overwriting a set column', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of listMigrationFiles().filter((name) => name < '036')) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'One', 't');
      const person = db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      person.run('per_1', '2026-01-01', 'wsp_1', 'Ada', 'Lovelace', '2026-01-01');
      person.run('per_2', '2026-01-01', 'wsp_1', 'Grace', 'Hopper', '2026-01-01');
      db.prepare('INSERT INTO organization (id, created_at, workspace_id, name, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('org_1', '2026-01-01', 'wsp_1', 'Acme', 'company', '2026-01-01');
      const claim = db.prepare(
        "INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_type, observed_at, status) VALUES (?, ?, 'wsp_1', ?, ?, ?, ?, 'import', '2026-01-01', 'imported')",
      );
      claim.run('clm_1', '2026-01-02T00:00:00.000Z', 'person', 'per_1', 'phone', '555 0100');
      claim.run('clm_2', '2026-01-03T00:00:00.000Z', 'person', 'per_1', 'phone', '555 0199');
      claim.run('clm_3', '2026-01-02T00:00:00.000Z', 'person', 'per_1', 'website', 'https://ada.example.com');
      claim.run('clm_4', '2026-01-02T00:00:00.000Z', 'person', 'per_2', 'phone', '555 0200');
      claim.run('clm_5', '2026-01-02T00:00:00.000Z', 'organization', 'org_1', 'website', 'https://acme.example.com');
      claim.run('clm_6', '2026-01-02T00:00:00.000Z', 'organization', 'org_1', 'location', 'Nowhere');
      expect(applyMigrations(db)).toEqual(['036_contact_fields.sql']);
      expect(db.prepare('SELECT id, phone, website FROM person ORDER BY id').all()).toEqual([
        { id: 'per_1', phone: '555 0199', website: 'https://ada.example.com' },
        { id: 'per_2', phone: '555 0200', website: null },
      ]);
      expect(db.prepare('SELECT phone, website FROM organization').get()).toEqual({ phone: null, website: 'https://acme.example.com' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM field_claim').get()).toEqual({ n: 6 });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not overwrite a column that already has a value when the backfill statements run again', () => {
    const sql = readFileSync(path.join(migrationsDirectory, '036_contact_fields.sql'), 'utf8');
    const backfill = sql.slice(sql.indexOf('UPDATE person SET phone'));
    const subject = createPerson(env.ctx, { firstName: 'Kept', lastName: 'Value', phone: '555 1111' });
    env.db
      .prepare(
        "INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_type, observed_at, status) VALUES ('clm_keep', '2030-01-01T00:00:00.000Z', ?, 'person', ?, 'phone', '999 9999', 'import', '2030-01-01', 'imported')",
      )
      .run(env.workspaceId, subject.id);
    env.db.exec(backfill);
    expect(personRow(subject.id).phone).toBe('555 1111');
  });
});

describe('contact field rules', () => {
  it('normalizes phones', () => {
    expect(normalizePhone('  +1 555 0100 ')).toBe('+1 555 0100');
    expect(normalizePhone('   ')).toBeNull();
    expect(normalizePhone('call me')).toBeUndefined();
    expect(normalizePhone('5'.repeat(40))).toBe('5'.repeat(40));
    expect(normalizePhone('5'.repeat(41))).toBeUndefined();
  });

  it('normalizes websites', () => {
    expect(normalizeWebsite(' acme.com/team ')).toBe('https://acme.com/team');
    expect(normalizeWebsite('http://acme.com')).toBe('http://acme.com');
    expect(normalizeWebsite('')).toBeNull();
    expect(normalizeWebsite('ftp://acme.com')).toBeUndefined();
    expect(normalizeWebsite('javascript:alert(1)')).toBeUndefined();
    expect(normalizeWebsite('not a url')).toBeUndefined();
  });
});

describe('PATCH people and organizations', () => {
  it('sets, trims, prepends the scheme, and clears phone and website on a person', async () => {
    const subject = createPerson(env.ctx, { firstName: 'Pat', lastName: 'Contact' });
    const set = await patch('people', subject.id, 1, { phone: '  +1 555 0100  ', website: ' pat.example.com/about ' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ phone: '+1 555 0100', website: 'https://pat.example.com/about', version: 2 });
    expect(getPerson(env.db, env.workspaceId, subject.id)).toMatchObject({ phone: '+1 555 0100', website: 'https://pat.example.com/about' });
    expect(claimValues(subject.id, 'phone')).toEqual([]);
    const cleared = await patch('people', subject.id, 2, { phone: '', website: '   ' });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ phone: null, website: null });
  });

  it('sets and clears phone and website on an organization', async () => {
    const subject = createOrganization(env.ctx, { name: 'Contact Co' });
    const set = await patch('organizations', subject.id, 1, { phone: '555 0123', website: 'http://contact.example.com' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ phone: '555 0123', website: 'http://contact.example.com' });
    expect(getOrganization(env.db, env.workspaceId, subject.id)).toMatchObject({ phone: '555 0123' });
    const cleared = await patch('organizations', subject.id, 2, { phone: null, website: null });
    expect(cleared.body).toMatchObject({ phone: null, website: null });
  });

  it.each([
    ['a phone with no digit', { phone: 'call me' }],
    ['a phone over 40 characters', { phone: '5'.repeat(41) }],
    ['a website that is not a URL', { website: 'not a url' }],
    ['a website with another scheme', { website: 'ftp://files.example.com' }],
    ['a website over 500 characters', { website: `https://example.com/${'a'.repeat(500)}` }],
  ])('refuses %s on both records', async (_label, fields) => {
    const p = createPerson(env.ctx, { firstName: 'Bad', lastName: 'Input' });
    const o = createOrganization(env.ctx, { name: `Bad Input ${Math.random()}` });
    const person = await patch('people', p.id, 1, fields);
    expect(person.status).toBe(400);
    const organization = await patch('organizations', o.id, 1, fields);
    expect(organization.status).toBe(400);
    expect(personRow(p.id).version).toBe(1);
  });

  it('flows through crm_propose_changes and crm_apply_changes', () => {
    const p = createPerson(env.ctx, { firstName: 'Agent', lastName: 'Fill' });
    const o = createOrganization(env.ctx, { name: 'Agent Fill Co' });
    const bad = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: p.id, fields: { phone: 'none' } }] });
    expect(bad.valid).toBe(false);
    const good = proposeChanges(env.ctx, {
      changes: [
        { entityType: 'person', id: p.id, fields: { phone: '555 0142', website: 'agent.example.com' } },
        { entityType: 'organization', id: o.id, fields: { phone: '555 0143', website: 'https://agentco.example.com' } },
      ],
    });
    expect(good.valid).toBe(true);
    expect(good.changes[0]!.diff).toEqual([
      { field: 'phone', from: null, to: '555 0142' },
      { field: 'website', from: null, to: 'https://agent.example.com' },
    ]);
    const result = applyChanges(env.ctx, {
      proposalHash: good.proposalHash,
      changes: good.changes.map(({ entityType, id, expectedVersion, fields }) => ({ entityType, id, expectedVersion, fields })),
    });
    expect(result.applied).toHaveLength(2);
    expect(getPerson(env.db, env.workspaceId, p.id)).toMatchObject({ phone: '555 0142', website: 'https://agent.example.com' });
    expect(getOrganization(env.db, env.workspaceId, o.id)).toMatchObject({ phone: '555 0143', website: 'https://agentco.example.com' });
  });
});

describe('serializers', () => {
  it('carry phone and website in lists and details, null when unset', async () => {
    const p = createPerson(env.ctx, { firstName: 'Listed', lastName: 'Contact' });
    await patch('people', p.id, 1, { phone: '555 0177', website: 'listed.example.com' });
    const detail = JSON.parse((await app.inject({ method: 'GET', url: `/api/people/${p.id}`, headers: host })).body);
    expect(detail).toMatchObject({ phone: '555 0177', website: 'https://listed.example.com' });
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/api/people?q=Listed', headers: host })).body);
    expect(list.items[0]).toMatchObject({ phone: '555 0177', website: 'https://listed.example.com' });
    const o = createOrganization(env.ctx, { name: 'Bare Org Contact' });
    const orgList = JSON.parse((await app.inject({ method: 'GET', url: '/api/organizations?q=Bare Org Contact', headers: host })).body);
    expect(orgList.items[0]).toMatchObject({ id: o.id, phone: null, website: null });
  });
});

describe('capture', () => {
  it('writes phone and website to the columns on create, validated, as well as the claims', async () => {
    const reply = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/contact-create', name: 'Contact Create', phone: ' +1 555 0150 ', website: 'create.example.com' });
    expect(reply.status).toBe(201);
    const id = reply.body.person.id as string;
    expect(personRow(id)).toMatchObject({ phone: '+1 555 0150', website: 'https://create.example.com' });
    expect(claimValues(id, 'phone')).toEqual(['+1 555 0150']);
    expect(claimValues(id, 'website')).toEqual(['https://create.example.com']);
  });

  it('drops a website that is not an http or https link instead of failing the capture', async () => {
    const reply = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/contact-badsite', name: 'Bad Site', website: 'My Blog' });
    expect(reply.status).toBe(201);
    const id = reply.body.person.id as string;
    expect(personRow(id).website).toBeNull();
    expect(claimValues(id, 'website')).toEqual([]);
  });

  it('treats phone and website as column backed: a typed value without a claim blocks the fill', async () => {
    const url = 'https://www.linkedin.com/in/contact-fill';
    const created = await capture({ source: 'linkedin', url, name: 'Contact Fill' });
    const id = created.body.person.id as string;
    env.db.prepare("UPDATE person SET phone = '555 typed', website = 'https://typed.example.com' WHERE id = ?").run(id);
    const again = await capture({ source: 'linkedin', url, name: 'x', phone: '555 0160', website: 'https://other.example.com', headline: 'Head' });
    expect(again.body.added).toEqual(['title']);
    expect(personRow(id)).toMatchObject({ phone: '555 typed', website: 'https://typed.example.com' });
    expect(claimValues(id, 'phone')).toEqual([]);
  });

  it('fills empty columns on an existing person and writes the claims', async () => {
    const url = 'https://www.linkedin.com/in/contact-fill-empty';
    const created = await capture({ source: 'linkedin', url, name: 'Contact Fill Empty' });
    const id = created.body.person.id as string;
    const again = await capture({ source: 'linkedin', url, name: 'x', phone: '555 0161', website: 'fill.example.com' });
    expect(again.body.added).toEqual(['website', 'phone']);
    expect(personRow(id)).toMatchObject({ phone: '555 0161', website: 'https://fill.example.com' });
    expect(claimValues(id, 'website')).toEqual(['https://fill.example.com']);
  });
});

describe('CSV import', () => {
  it('suggests phone and website headers', () => {
    expect(suggestMapping(['Name', 'Email', 'Phone Number', 'Website', 'Mobile'])).toEqual({
      Name: 'name',
      Email: 'email',
      'Phone Number': 'phone',
      Website: 'website',
      Mobile: 'ignore',
    });
  });

  it('writes phone and website to the person columns and claims, and drops invalid values', async () => {
    const content = 'Name,Email,Phone,Website\nCsv Good,csv.good@contact.example.com,+1 555 0170,csvgood.example.com\nCsv Bad,csv.bad@contact.example.com,none,not a url\n';
    const created = await app.inject({
      method: 'POST',
      url: '/api/imports/csv',
      headers: host,
      payload: { fileName: 'contact.csv', content, mapping: { Name: 'name', Email: 'email', Phone: 'phone', Website: 'website' } },
    });
    expect(created.statusCode).toBe(201);
    const runId = JSON.parse(created.body).id as string;
    driveRun(env, runId, ['waiting_approval']);
    const approval = getRunDetail(env.db, env.workspaceId, runId).approvals[0]!;
    decideApproval(env.ctx, approval.id, { decision: 'approve' });
    const good = env.db.prepare("SELECT * FROM person WHERE email = 'csv.good@contact.example.com'").get() as Record<string, any>;
    expect(good).toMatchObject({ phone: '+1 555 0170', website: 'https://csvgood.example.com' });
    expect(claimValues(good.id, 'phone')).toEqual(['+1 555 0170']);
    expect(claimValues(good.id, 'website')).toEqual(['https://csvgood.example.com']);
    const bad = env.db.prepare("SELECT * FROM person WHERE email = 'csv.bad@contact.example.com'").get() as Record<string, any>;
    expect(bad).toMatchObject({ phone: null, website: null });
    expect(claimValues(bad.id, 'phone')).toEqual([]);
  });
});

describe('seed', () => {
  it('gives some seeded people and organizations a phone and a website', () => {
    const seeded = createTestEnvironment();
    try {
      seedDatabase(seeded.db, { reset: true, now: new Date('2026-03-01T09:00:00.000Z') });
      const n = (sql: string) => Number((seeded.db.prepare(sql).get() as { n: number }).n);
      expect(n('SELECT COUNT(*) AS n FROM person WHERE phone IS NOT NULL')).toBeGreaterThan(0);
      expect(n('SELECT COUNT(*) AS n FROM person WHERE website IS NOT NULL')).toBeGreaterThan(0);
      expect(n('SELECT COUNT(*) AS n FROM organization WHERE phone IS NOT NULL')).toBeGreaterThan(0);
      expect(n('SELECT COUNT(*) AS n FROM organization WHERE website LIKE \'https://%.example.%\'')).toBeGreaterThan(0);
    } finally {
      seeded.cleanup();
    }
  });
});
