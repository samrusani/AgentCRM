import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { capturePerson, createOrganization, createPerson, lookupCapture, updateOrganization, updatePerson } from '../src/actions/index.js';
import {
  canonicalCompanyLinkedinUrl,
  canonicalPersonLinkedinUrl,
  canonicalXUrl,
} from '../src/actions/profileUrls.js';
import { applyMigrations, listMigrationFiles } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { migrationsDirectory } from '../src/paths.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
afterAll(() => env.cleanup());

function failure(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'none';
}

describe('canonical company links', () => {
  it('accepts company pages on linkedin.com and its subdomains and strips everything after the slug', () => {
    const wanted = 'https://www.linkedin.com/company/acme-labs';
    for (const input of [
      'https://www.linkedin.com/company/acme-labs',
      'http://linkedin.com/company/acme-labs/',
      'https://uk.linkedin.com/company/acme-labs?trk=public',
      'https://www.linkedin.com/company/acme-labs/about/?x=1#top',
      'HTTPS://WWW.LINKEDIN.COM/company/acme-labs',
      '  linkedin.com/company/acme-labs  ',
    ]) {
      expect(canonicalCompanyLinkedinUrl(input), input).toBe(wanted);
    }
  });

  it('keeps the slug as written, percent encoding included', () => {
    expect(canonicalCompanyLinkedinUrl('https://www.linkedin.com/company/Acme_Labs-42')).toBe('https://www.linkedin.com/company/Acme_Labs-42');
    expect(canonicalCompanyLinkedinUrl('https://www.linkedin.com/company/caf%C3%A9-co/')).toBe('https://www.linkedin.com/company/caf%C3%A9-co');
  });

  it('rejects anything that is not a company page', () => {
    for (const input of [
      'https://www.linkedin.com/in/ada-quill',
      'https://www.linkedin.com/company/',
      'https://www.linkedin.com/company',
      'https://www.linkedin.com/school/acme',
      'https://www.linkedin.com/showcase/acme',
      'https://example.com/company/acme',
      'https://notlinkedin.com/company/acme',
      'https://linkedin.com.example.com/company/acme',
      'ftp://www.linkedin.com/company/acme',
      'https://user:pass@www.linkedin.com/company/acme',
      '',
      'not a url',
      null,
      42,
    ]) {
      expect(canonicalCompanyLinkedinUrl(input), String(input)).toBeNull();
    }
  });

  it('shares the person and X rules with capture', () => {
    expect(canonicalPersonLinkedinUrl('linkedin.com/in/ada-quill/?trk=1')).toBe('https://www.linkedin.com/in/ada-quill');
    expect(canonicalPersonLinkedinUrl('https://www.linkedin.com/company/acme')).toBeNull();
    expect(canonicalXUrl('https://twitter.com/Ada_Quill?s=1')).toBe('https://x.com/Ada_Quill');
    expect(canonicalXUrl('https://x.com/home')).toBeNull();
  });
});

describe('migration 018', () => {
  it('backfills each column from the newest parseable claim and skips claims that do not parse', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of listMigrationFiles().filter((name) => name < '018')) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      for (const workspace of ['wsp_1']) {
        db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run(workspace, '2026-01-01', workspace, 't');
      }
      const person = (id: string, workspace = 'wsp_1') =>
        db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, '2026-01-01', workspace, id, '2026-01-01');
      const organization = (id: string) =>
        db.prepare('INSERT INTO organization (id, created_at, workspace_id, name, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, '2026-01-01', 'wsp_1', id, 'company', '2026-01-01');
      let claimNumber = 0;
      const claim = (entityType: string, entityId: string, field: string, value: string, observedAt: string, createdAt = '2026-01-01') => {
        claimNumber += 1;
        db.prepare(
          `INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_type, observed_at, status)
           VALUES (?, ?, 'wsp_1', ?, ?, ?, ?, 'import', ?, 'imported')`,
        ).run(`clm_${claimNumber}`, createdAt, entityType, entityId, field, value, observedAt);
      };
      for (const id of ['per_newest', 'per_skip', 'per_none', 'per_tie', 'per_x', 'per_bad']) person(id);
      organization('org_1');
      organization('org_2');

      // The newest claim wins, and its URL is canonicalized.
      claim('person', 'per_newest', 'linkedinUrl', 'https://www.linkedin.com/in/old-id', '2026-01-01T00:00:00.000Z');
      claim('person', 'per_newest', 'linkedinUrl', 'linkedin.com/in/new-id/?trk=1', '2026-02-01T00:00:00.000Z');
      // The newest claim does not parse, so it is skipped and the older one that parses is used.
      claim('person', 'per_skip', 'linkedinUrl', 'https://www.linkedin.com/in/kept-id', '2026-01-01T00:00:00.000Z');
      claim('person', 'per_skip', 'linkedinUrl', 'https://www.linkedin.com/company/not-a-person', '2026-03-01T00:00:00.000Z');
      claim('person', 'per_skip', 'linkedinUrl', 'not a link at all', '2026-04-01T00:00:00.000Z');
      // Only unparseable claims leave the column empty.
      claim('person', 'per_bad', 'linkedinUrl', 'https://example.com/in/someone', '2026-01-01T00:00:00.000Z');
      // The same observed time falls back to the creation time.
      claim('person', 'per_tie', 'linkedinUrl', 'https://www.linkedin.com/in/tie-early', '2026-01-01T00:00:00.000Z', '2026-01-02');
      claim('person', 'per_tie', 'linkedinUrl', 'https://www.linkedin.com/in/tie-late', '2026-01-01T00:00:00.000Z', '2026-01-03');
      // X claims and organization claims.
      claim('person', 'per_x', 'xUrl', 'https://twitter.com/Old_Handle', '2026-01-01T00:00:00.000Z');
      claim('person', 'per_x', 'xUrl', 'https://x.com/New_Handle?s=20', '2026-02-01T00:00:00.000Z');
      claim('person', 'per_x', 'linkedinUrl', 'https://x.com/not_linkedin', '2026-02-01T00:00:00.000Z');
      claim('organization', 'org_1', 'linkedinUrl', 'https://www.linkedin.com/company/acme-labs/about', '2026-01-01T00:00:00.000Z');
      claim('organization', 'org_2', 'linkedinUrl', 'https://www.linkedin.com/in/not-a-company', '2026-01-01T00:00:00.000Z');

      expect(applyMigrations(db)).toEqual(['018_profile_urls.sql']);

      const people = Object.fromEntries(
        (db.prepare('SELECT id, linkedin_url, x_url FROM person').all() as { id: string; linkedin_url: string | null; x_url: string | null }[]).map((row) => [
          row.id,
          [row.linkedin_url, row.x_url],
        ]),
      );
      expect(people).toEqual({
        per_newest: ['https://www.linkedin.com/in/new-id', null],
        per_skip: ['https://www.linkedin.com/in/kept-id', null],
        per_bad: [null, null],
        per_none: [null, null],
        per_tie: ['https://www.linkedin.com/in/tie-late', null],
        per_x: [null, 'https://x.com/New_Handle'],
      });
      expect(db.prepare('SELECT id, linkedin_url FROM organization ORDER BY id').all()).toEqual([
        { id: 'org_1', linkedin_url: 'https://www.linkedin.com/company/acme-labs' },
        { id: 'org_2', linkedin_url: null },
      ]);
      // Claims are left alone, and the indexes exist.
      expect(db.prepare('SELECT COUNT(*) AS n FROM field_claim').get()).toEqual({ n: claimNumber });
      const indexed = (name: string) => (db.pragma(`index_info(${name})`) as { name: string }[]).map((column) => column.name);
      expect(indexed('idx_person_linkedin_url')).toEqual(['workspace_id', 'linkedin_url']);
      expect(indexed('idx_person_x_url')).toEqual(['workspace_id', 'x_url']);
      expect(indexed('idx_organization_linkedin_url')).toEqual(['workspace_id', 'linkedin_url']);
      const plan = (db.prepare('EXPLAIN QUERY PLAN SELECT id FROM person WHERE workspace_id = ? AND linkedin_url = ?').all('wsp_1', 'x') as { detail: string }[])
        .map((step) => step.detail)
        .join(' ');
      expect(plan).toContain('idx_person_linkedin_url');
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('capture and lookup match the columns', () => {
  const column = (id: string, name: string) =>
    (env.db.prepare(`SELECT ${name} AS value FROM person WHERE id = ?`).get(id) as { value: string | null }).value;

  it('fills the column on create, with the same value as the claim', () => {
    const linkedin = capturePerson(env.ctx, { source: 'linkedin', url: 'https://UK.linkedin.com/in/col-create/?trk=1', name: 'Col Create' });
    expect(linkedin.outcome).toBe('created');
    expect(column(linkedin.person.id, 'linkedin_url')).toBe('https://www.linkedin.com/in/col-create');
    expect(column(linkedin.person.id, 'x_url')).toBeNull();
    const claim = env.db.prepare("SELECT value FROM field_claim WHERE entity_id = ? AND field = 'linkedinUrl'").get(linkedin.person.id) as { value: string };
    expect(claim.value).toBe('https://www.linkedin.com/in/col-create');

    const x = capturePerson(env.ctx, { source: 'x', url: 'https://twitter.com/Col_Create?s=9', name: 'Col X' });
    expect(column(x.person.id, 'x_url')).toBe('https://x.com/Col_Create');
    expect(column(x.person.id, 'linkedin_url')).toBeNull();
  });

  it('matches by column for capture and lookup, and ignores a claim with no column', () => {
    const first = capturePerson(env.ctx, { source: 'linkedin', url: 'https://www.linkedin.com/in/col-dedupe', name: 'Col Dedupe' });
    const again = capturePerson(env.ctx, { source: 'linkedin', url: 'http://linkedin.com/in/col-dedupe/', name: 'Other Name' });
    expect(again).toEqual({ outcome: 'existing', person: first.person });
    expect(lookupCapture(env.ctx, { source: 'linkedin', url: 'linkedin.com/in/col-dedupe?x=1' })).toEqual({ exists: true });
    // X handles compare without regard to case.
    const x = capturePerson(env.ctx, { source: 'x', url: 'https://x.com/Col_Dedupe', name: 'Col X Dedupe' });
    expect(capturePerson(env.ctx, { source: 'x', url: 'https://mobile.twitter.com/COL_DEDUPE', name: 'Anyone' })).toEqual({ outcome: 'existing', person: x.person });
    expect(lookupCapture(env.ctx, { source: 'x', url: 'https://x.com/col_dedupe' })).toEqual({ exists: true });

    // Clearing the column makes the profile unknown again, though the claim is still there.
    env.db.prepare('UPDATE person SET linkedin_url = NULL WHERE id = ?').run(first.person.id);
    expect(lookupCapture(env.ctx, { source: 'linkedin', url: 'https://www.linkedin.com/in/col-dedupe' })).toEqual({ exists: false });
    // A claim alone, with no column, does not match either.
    const claimOnly = createPerson(env.ctx, { firstName: 'Claim', lastName: 'Only' });
    env.db
      .prepare(
        "INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_type, observed_at, status) VALUES ('clm_claim_only', '2026-03-01', ?, 'person', ?, 'linkedinUrl', 'https://www.linkedin.com/in/claim-only', 'import', '2026-03-01', 'imported')",
      )
      .run(env.workspaceId, claimOnly.id);
    expect(lookupCapture(env.ctx, { source: 'linkedin', url: 'https://www.linkedin.com/in/claim-only' })).toEqual({ exists: false });
  });

  it('writes the column together with the claim on an email hit, once', () => {
    const owner = createPerson(env.ctx, { firstName: 'Mail', lastName: 'Owner', email: 'col-mail@example.com' });
    const before = Number((env.db.prepare('SELECT version FROM person WHERE id = ?').get(owner.id) as { version: number }).version);
    const hit = capturePerson(env.ctx, { source: 'linkedin', url: 'https://www.linkedin.com/in/col-mail', name: 'Mail Owner', email: 'COL-MAIL@example.com' });
    expect(hit).toEqual({ outcome: 'existing', person: { id: owner.id, name: 'Mail Owner' } });
    expect(column(owner.id, 'linkedin_url')).toBe('https://www.linkedin.com/in/col-mail');
    expect(Number((env.db.prepare('SELECT version FROM person WHERE id = ?').get(owner.id) as { version: number }).version)).toBe(before + 1);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ? AND field = 'linkedinUrl'").get(owner.id)).toEqual({ n: 1 });
    expect(lookupCapture(env.ctx, { source: 'linkedin', url: 'https://www.linkedin.com/in/col-mail' })).toEqual({ exists: true });

    // A second profile with the same email leaves the saved one alone.
    capturePerson(env.ctx, { source: 'linkedin', url: 'https://www.linkedin.com/in/col-mail-other', name: 'Mail Owner', email: 'col-mail@example.com' });
    expect(column(owner.id, 'linkedin_url')).toBe('https://www.linkedin.com/in/col-mail');
  });
});

describe('editing profile URL fields', () => {
  it('canonicalizes a good person LinkedIn and X link and clears with null', () => {
    const person = createPerson(env.ctx, { firstName: 'Edit', lastName: 'Links' });
    expect(person.linkedinUrl).toBeNull();
    const updated = updatePerson(env.ctx, person.id, {
      expectedVersion: person.version,
      fields: { linkedinUrl: 'linkedin.com/in/edit-links/?trk=1', xUrl: 'https://twitter.com/Edit_Links' },
    });
    expect(updated.linkedinUrl).toBe('https://www.linkedin.com/in/edit-links');
    expect(updated.xUrl).toBe('https://x.com/Edit_Links');
    expect(updated.version).toBe(person.version + 1);
    const cleared = updatePerson(env.ctx, person.id, { expectedVersion: updated.version, fields: { linkedinUrl: null, xUrl: '' } });
    expect(cleared.linkedinUrl).toBeNull();
    expect(cleared.xUrl).toBeNull();
  });

  it('refuses a person link that does not canonicalize with an honest message', () => {
    const person = createPerson(env.ctx, { firstName: 'Bad', lastName: 'Links' });
    const bad = failure(() => updatePerson(env.ctx, person.id, { expectedVersion: person.version, fields: { linkedinUrl: 'https://www.linkedin.com/company/acme' } }));
    expect(bad).toMatch(/^validation: fields\.linkedinUrl: The LinkedIn link must be a profile link/);
    expect(bad).not.toContain('..');
    const badX = failure(() => updatePerson(env.ctx, person.id, { expectedVersion: person.version, fields: { xUrl: 'https://x.com/home' } }));
    expect(badX).toMatch(/^validation: fields\.xUrl: The X link must be a profile link/);
    expect(failure(() => createPerson(env.ctx, { firstName: 'Bad', linkedinUrl: 'nonsense' }))).toMatch(/^validation: /);
    // Nothing changed.
    expect(env.db.prepare('SELECT linkedin_url, x_url, version FROM person WHERE id = ?').get(person.id)).toEqual({
      linkedin_url: null,
      x_url: null,
      version: person.version,
    });
  });

  it('edits and clears an organization company link, and refuses a person link', () => {
    const organization = createOrganization(env.ctx, { name: 'Edit Org', linkedinUrl: 'https://www.linkedin.com/company/edit-org/?trk=1' });
    expect(organization.linkedinUrl).toBe('https://www.linkedin.com/company/edit-org');
    const bad = failure(() => updateOrganization(env.ctx, organization.id, { expectedVersion: organization.version, fields: { linkedinUrl: 'https://www.linkedin.com/in/someone' } }));
    expect(bad).toMatch(/^validation: fields\.linkedinUrl: The LinkedIn link must be a company page/);
    const cleared = updateOrganization(env.ctx, organization.id, { expectedVersion: organization.version, fields: { linkedinUrl: null } });
    expect(cleared.linkedinUrl).toBeNull();
  });
});
