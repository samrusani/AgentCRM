import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyChanges,
  createAttribute,
  createContext,
  createOrganization,
  createPerson,
  deleteAttribute,
  proposeChanges,
  updateAttribute,
  updateOrganization,
  updatePerson,
  withActor,
} from '../src/actions/index.js';
import { ensureWorkspace } from '../src/actions/workspace.js';
import { applyMigrations, listMigrationFiles } from '../src/db.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { migrationsDirectory, packageRoot } from '../src/paths.js';
import { getOrganizationDetail } from '../src/queries/organizations.js';
import { getPerson, getPersonDetail } from '../src/queries/people.js';
import { listAttributeDefs } from '../src/queries/attributes.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
const events: DomainEvent[] = [];
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  env.bus.subscribe((event) => events.push(event));
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, headers: host, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: response.statusCode, body: response.body ? (response.json() as Record<string, any>) : {} };
}

function rejected(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('Expected the call to be rejected.');
}

const audits = (action: string) =>
  (env.db.prepare('SELECT entity_id, detail FROM audit_event WHERE action = ? ORDER BY created_at, id').all(action) as { entity_id: string; detail: string }[]).map(
    (row) => ({ entityId: row.entity_id, detail: JSON.parse(row.detail) as Record<string, any> }),
  );
const defOf = (key: string, entityType: 'person' | 'organization' = 'person') =>
  listAttributeDefs(env.db, env.workspaceId, entityType).find((def) => def.key === key)!;
const person = (firstName: string, lastName = 'Attr') => createPerson(env.ctx, { firstName, lastName });
const attribute = (detail: ReturnType<typeof getPersonDetail>, key: string) => detail.attributes.find((entry) => entry.key === key)!;
const recordEvents = (entityId: string) => events.filter((event) => event.type === 'record_updated' && event.entityId === entityId);

describe('seeds', () => {
  it('seeds exactly the five person attributes in order for a new workspace, none for organizations', () => {
    const defs = listAttributeDefs(env.db, env.workspaceId);
    expect(defs.map((def) => [def.entityType, def.key, def.label, def.kind, def.seq])).toEqual([
      ['person', 'message-angle', 'Message angle', 'text', 1],
      ['person', 'fit-notes', 'Fit notes', 'text', 2],
      ['person', 'research-notes', 'Research notes', 'text', 3],
      ['person', 'minimum-check-size', 'Minimum check size', 'money', 4],
      ['person', 'maximum-check-size', 'Maximum check size', 'money', 5],
    ]);
    expect(defs.every((def) => def.description && def.description.length > 0 && def.version === 1)).toBe(true);
  });

  it('migration 025 seeds five per existing workspace and leaves the tables empty of values', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of listMigrationFiles().filter((name) => name < '025')) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'One', 't');
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_2', '2026-01-01', 'Two', 't');
      expect(applyMigrations(db)).toEqual(['025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql', '030_transcript.sql', '031_duplicates.sql', '032_organization_duplicates.sql', '033_meetings.sql', '034_search_widening.sql', '035_backblaze.sql']);
      const rows = db.prepare('SELECT workspace_id, entity_type, key, kind, seq, id FROM attribute_def ORDER BY workspace_id, seq').all() as {
        workspace_id: string; entity_type: string; key: string; kind: string; seq: number; id: string;
      }[];
      expect(rows).toHaveLength(10);
      for (const workspace of ['wsp_1', 'wsp_2']) {
        expect(rows.filter((row) => row.workspace_id === workspace).map((row) => [row.entity_type, row.key, row.kind, row.seq])).toEqual([
          ['person', 'message-angle', 'text', 1],
          ['person', 'fit-notes', 'text', 2],
          ['person', 'research-notes', 'text', 3],
          ['person', 'minimum-check-size', 'money', 4],
          ['person', 'maximum-check-size', 'money', 5],
        ]);
      }
      expect(new Set(rows.map((row) => row.id)).size).toBe(10);
      expect(rows.every((row) => /^atd_[0-9a-f]{12}$/.test(row.id))).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS n FROM attribute_value').get()).toEqual({ n: 0 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('seeds a second workspace created through the bootstrap path', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-bootstrap-'));
    const db = new Database(path.join(directory, 'fresh.db'));
    try {
      applyMigrations(db);
      const workspace = ensureWorkspace(db);
      expect(listAttributeDefs(db, workspace.id)).toHaveLength(5);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('definitions', () => {
  it('slugifies the label, dedupes per workspace and entity type, and bounds the label', async () => {
    const first = createAttribute(env.ctx, { entityType: 'person', label: '  Warm  intro / Path!! ', kind: 'text' });
    expect(first).toMatchObject({ key: 'warm-intro-path', label: 'Warm  intro / Path!!', kind: 'text', description: null, seq: 6, version: 1 });
    expect(createAttribute(env.ctx, { entityType: 'person', label: 'Warm intro path', kind: 'text' }).key).toBe('warm-intro-path-2');
    expect(createAttribute(env.ctx, { entityType: 'person', label: 'warm intro path', kind: 'number' }).key).toBe('warm-intro-path-3');
    // The same label on organizations is a separate namespace.
    expect(createAttribute(env.ctx, { entityType: 'organization', label: 'Warm intro path', kind: 'text' })).toMatchObject({ key: 'warm-intro-path', seq: 1 });
    const long = createAttribute(env.ctx, { entityType: 'organization', label: 'x'.repeat(200), kind: 'text' });
    expect(long.key).toBe('x'.repeat(64));
    expect(createAttribute(env.ctx, { entityType: 'organization', label: 'x'.repeat(200), kind: 'text' }).key).toBe(`${'x'.repeat(62)}-2`);

    expect(rejected(() => createAttribute(env.ctx, { entityType: 'person', label: '   ', kind: 'text' })).code).toBe('validation');
    expect(rejected(() => createAttribute(env.ctx, { entityType: 'person', label: 'y'.repeat(201), kind: 'text' })).code).toBe('validation');
    expect(rejected(() => createAttribute(env.ctx, { entityType: 'person', label: '!!!', kind: 'text' })).message).toMatch(/letter or number/);
    expect(rejected(() => createAttribute(env.ctx, { entityType: 'person', label: 'Ok', kind: 'date' })).code).toBe('validation');
    expect(rejected(() => createAttribute(env.ctx, { entityType: 'opportunity', label: 'Ok', kind: 'text' })).code).toBe('validation');
    expect(rejected(() => createAttribute(env.ctx, { entityType: 'person', label: 'Ok', kind: 'text', description: 'd'.repeat(501) })).code).toBe('validation');
    expect(audits('attribute.create').map((entry) => entry.detail.key)).toContain('warm-intro-path-2');
    expect(events.some((event) => event.type === 'record_updated' && event.entityType === 'attribute_def' && event.entityId === first.id)).toBe(true);
  });

  it('serves the REST endpoints and keeps kind and key immutable', async () => {
    const created = await call('POST', '/api/attributes', { entityType: 'person', label: 'Source', kind: 'text', description: 'Where we found them.' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key: 'source', kind: 'text', description: 'Where we found them.' });
    const listed = await call('GET', '/api/attributes?entityType=person');
    expect(listed.status).toBe(200);
    expect(listed.body.items.slice(0, 5).map((item: any) => item.key)).toEqual([
      'message-angle', 'fit-notes', 'research-notes', 'minimum-check-size', 'maximum-check-size',
    ]);
    expect(listed.body.items.every((item: any) => item.entityType === 'person')).toBe(true);
    expect((await call('GET', '/api/attributes?entityType=bogus')).status).toBe(400);

    const id = created.body.id as string;
    for (const fields of [{ kind: 'number' }, { key: 'other' }, { entityType: 'organization' }]) {
      expect((await call('PATCH', `/api/attributes/${id}`, { expectedVersion: 1, fields })).status).toBe(400);
    }
    expect((await call('PATCH', `/api/attributes/${id}`, { expectedVersion: 1, fields: {} })).status).toBe(400);
    const renamed = await call('PATCH', `/api/attributes/${id}`, { expectedVersion: 1, fields: { label: 'Lead source', description: '' } });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ key: 'source', kind: 'text', label: 'Lead source', description: null, version: 2 });
    const stale = await call('PATCH', `/api/attributes/${id}`, { expectedVersion: 1, fields: { label: 'Stale' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(audits('attribute.update').at(-1)?.detail.to.label).toBe('Lead source');

    expect((await call('DELETE', `/api/attributes/${id}`)).status).toBe(204);
    expect((await call('DELETE', `/api/attributes/${id}`)).status).toBe(404);
    expect((await call('PATCH', `/api/attributes/${id}`, { expectedVersion: 2, fields: { label: 'Gone' } })).status).toBe(404);
  });

  it('delete cascades the values and audits the value count', () => {
    const def = createAttribute(env.ctx, { entityType: 'person', label: 'Cascade me', kind: 'number' });
    const a = person('Cas');
    const b = person('Cade');
    updatePerson(env.ctx, a.id, { expectedVersion: 1, fields: { 'attr:cascade-me': 4 } });
    updatePerson(env.ctx, b.id, { expectedVersion: 1, fields: { 'attr:cascade-me': 9 } });
    const count = () => (env.db.prepare('SELECT COUNT(*) AS n FROM attribute_value WHERE attribute_id = ?').get(def.id) as { n: number }).n;
    expect(count()).toBe(2);
    deleteAttribute(env.ctx, def.id);
    expect(count()).toBe(0);
    expect(audits('attribute.delete').at(-1)).toMatchObject({ entityId: def.id, detail: { key: 'cascade-me', valueCount: 2 } });
    expect(getPersonDetail(env.db, env.workspaceId, a.id).attributes.some((entry) => entry.key === 'cascade-me')).toBe(false);
    // The key is unknown for later writes.
    const error = rejected(() => updatePerson(env.ctx, a.id, { expectedVersion: 2, fields: { 'attr:cascade-me': 1 } }));
    expect(error.code).toBe('validation');
    expect(error.message).toContain('attr:cascade-me');
  });
});

describe('values as fields', () => {
  it('reads every definition in seq order with nulls, money as value and currency', () => {
    const subject = person('Reads');
    const detail = getPersonDetail(env.db, env.workspaceId, subject.id);
    expect(detail.attributes.slice(0, 5).map((entry) => entry.key)).toEqual([
      'message-angle', 'fit-notes', 'research-notes', 'minimum-check-size', 'maximum-check-size',
    ]);
    expect(attribute(detail, 'message-angle')).toMatchObject({ kind: 'text', value: null, currency: null, label: 'Message angle' });
    expect(attribute(detail, 'minimum-check-size')).toMatchObject({ kind: 'money', value: null, currency: 'USD' });
    expect(attribute(detail, 'message-angle').id).toMatch(/^atd_/);
    expect(typeof attribute(detail, 'fit-notes').description).toBe('string');
  });

  it('writes text, number, and money through PATCH, bumping the version and emitting record_updated', async () => {
    const number = createAttribute(env.ctx, { entityType: 'person', label: 'Funds managed', kind: 'number' });
    const subject = person('Writes');
    const before = recordEvents(subject.id).length;
    const response = await call('PATCH', `/api/people/${subject.id}`, {
      expectedVersion: 1,
      fields: {
        'attr:message-angle': '  Lead with the climate thesis.  ',
        'attr:funds-managed': 3.5,
        'attr:minimum-check-size': { amount: 250000, currency: 'gbp' },
        'attr:maximum-check-size': 1000000,
        title: 'Partner',
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.version).toBe(2);
    expect(recordEvents(subject.id).length).toBe(before + 1);
    const detail = getPersonDetail(env.db, env.workspaceId, subject.id);
    expect(attribute(detail, 'message-angle').value).toBe('Lead with the climate thesis.');
    expect(attribute(detail, 'funds-managed')).toMatchObject({ id: number.id, kind: 'number', value: 3.5, currency: null });
    expect(attribute(detail, 'minimum-check-size')).toMatchObject({ value: 250000, currency: 'GBP' });
    expect(attribute(detail, 'maximum-check-size')).toMatchObject({ value: 1000000, currency: 'USD' });
    expect(detail.title).toBe('Partner');
    const audit = audits('person.update').at(-1)!;
    expect(audit.detail.changes['attr:minimum-check-size']).toEqual({ from: null, to: { amount: 250000, currency: 'GBP' } });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ?").get(subject.id)).toEqual({ n: 0 });

    // An attribute only edit bumps the version too, and an identical value is a no-op.
    const second = updatePerson(env.ctx, subject.id, { expectedVersion: 2, fields: { 'attr:fit-notes': 'Writes small seed checks.' } });
    expect(second.version).toBe(3);
    const same = updatePerson(env.ctx, subject.id, { expectedVersion: 3, fields: { 'attr:fit-notes': 'Writes small seed checks.' } });
    expect(same.version).toBe(3);
    // Null clears, and clearing an unset value is a no-op.
    const cleared = updatePerson(env.ctx, subject.id, { expectedVersion: 3, fields: { 'attr:fit-notes': null, 'attr:research-notes': null } });
    expect(cleared.version).toBe(4);
    expect(attribute(getPersonDetail(env.db, env.workspaceId, subject.id), 'fit-notes').value).toBeNull();
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM attribute_value WHERE entity_id = ? AND attribute_id = ?').get(subject.id, defOf('fit-notes').id)).toEqual({ n: 0 });
    // A stale version is the usual conflict.
    expect(rejected(() => updatePerson(env.ctx, subject.id, { expectedVersion: 1, fields: { 'attr:fit-notes': 'x' } })).code).toBe('version_conflict');
  });

  it('enforces the per kind rules', () => {
    createAttribute(env.ctx, { entityType: 'person', label: 'Score', kind: 'number' });
    const subject = person('Rules');
    const write = (fields: Record<string, unknown>) => () =>
      updatePerson(env.ctx, subject.id, { expectedVersion: getPerson(env.db, env.workspaceId, subject.id)!.version, fields });
    // Text: trimmed, 2000 bound, strings only, blank clears.
    expect(rejected(write({ 'attr:fit-notes': 'a'.repeat(2001) })).message).toMatch(/2000/);
    expect(rejected(write({ 'attr:fit-notes': 5 })).code).toBe('validation');
    expect(updatePerson(env.ctx, subject.id, { expectedVersion: 1, fields: { 'attr:fit-notes': `  ${'a'.repeat(2000)}  ` } }).version).toBe(2);
    expect(updatePerson(env.ctx, subject.id, { expectedVersion: 2, fields: { 'attr:fit-notes': '   ' } }).version).toBe(3);
    // Number: finite only, numeric strings parse.
    expect(rejected(write({ 'attr:score': 'abc' })).code).toBe('validation');
    expect(rejected(write({ 'attr:score': Number.POSITIVE_INFINITY })).code).toBe('validation');
    expect(rejected(write({ 'attr:score': true })).code).toBe('validation');
    expect(updatePerson(env.ctx, subject.id, { expectedVersion: 3, fields: { 'attr:score': ' 12.5 ' } }).version).toBe(4);
    expect(attribute(getPersonDetail(env.db, env.workspaceId, subject.id), 'score').value).toBe(12.5);
    // Money: non negative integers, three letter currency, nothing else in the object.
    for (const bad of [-1, 1.5, '100', { amount: -5 }, { amount: 5, currency: 'US' }, { amount: 5, extra: 1 }, { currency: 'USD' }, { amount: 1e13 }]) {
      expect(rejected(write({ 'attr:minimum-check-size': bad })).code).toBe('validation');
    }
    expect(updatePerson(env.ctx, subject.id, { expectedVersion: 4, fields: { 'attr:minimum-check-size': 0 } }).version).toBe(5);
    expect(attribute(getPersonDetail(env.db, env.workspaceId, subject.id), 'minimum-check-size')).toMatchObject({ value: 0, currency: 'USD' });
    // A failed edit leaves the record untouched, built in fields included.
    expect(rejected(write({ title: 'Nope', 'attr:score': 'x' })).code).toBe('validation');
    expect(getPerson(env.db, env.workspaceId, subject.id)?.title).toBeNull();
  });

  it('refuses unknown keys naming the key, on people and organizations', () => {
    const subject = person('Unknown');
    const error = rejected(() => updatePerson(env.ctx, subject.id, { expectedVersion: 1, fields: { 'attr:nope': 'x' } }));
    expect(error.code).toBe('validation');
    expect(error.message).toContain('attr:nope');
    // Organization definitions are a separate namespace from person ones.
    const organization = createOrganization(env.ctx, { name: 'Unknown Capital', kind: 'fund' });
    expect(rejected(() => updateOrganization(env.ctx, organization.id, { expectedVersion: 1, fields: { 'attr:fit-notes': 'x' } })).message).toContain('attr:fit-notes');
    // Malformed spellings never reach the attribute path; they are unknown fields.
    expect(rejected(() => updatePerson(env.ctx, subject.id, { expectedVersion: 1, fields: { 'attr:Bad Key': 'x' } })).code).toBe('validation');
    expect(rejected(() => updatePerson(env.ctx, subject.id, { expectedVersion: 1, fields: { attr: 'x' } })).code).toBe('validation');
    expect(getPerson(env.db, env.workspaceId, subject.id)?.version).toBe(1);
  });

  it('writes organization attributes and reads them on the organization detail', async () => {
    createAttribute(env.ctx, { entityType: 'organization', label: 'Assets under management', kind: 'money', description: 'Reported AUM.' });
    createAttribute(env.ctx, { entityType: 'organization', label: 'Thesis', kind: 'text' });
    const organization = createOrganization(env.ctx, { name: 'Org Attr Fund', kind: 'fund' });
    const response = await call('PATCH', `/api/organizations/${organization.id}`, {
      expectedVersion: 1,
      fields: { 'attr:assets-under-management': { amount: 5000000000, currency: 'USD' }, 'attr:thesis': 'Climate infrastructure.' },
    });
    expect(response.status).toBe(200);
    expect(response.body.version).toBe(2);
    const detail = getOrganizationDetail(env.db, env.workspaceId, organization.id);
    expect(detail.attributes.map((entry) => [entry.key, entry.value, entry.currency])).toEqual(
      expect.arrayContaining([['assets-under-management', 5000000000, 'USD'], ['thesis', 'Climate infrastructure.', null]]),
    );
    const viaApi = await call('GET', `/api/organizations/${organization.id}`);
    expect(viaApi.body.attributes.find((entry: any) => entry.key === 'thesis').value).toBe('Climate infrastructure.');
  });

  it('shows a renamed definition in reads without touching the values', () => {
    const subject = person('Rename');
    updatePerson(env.ctx, subject.id, { expectedVersion: 1, fields: { 'attr:research-notes': 'Met at the summit.' } });
    const def = defOf('research-notes');
    const valueBefore = env.db.prepare('SELECT value, updated_at FROM attribute_value WHERE attribute_id = ? AND entity_id = ?').get(def.id, subject.id);
    const renamed = updateAttribute(env.ctx, def.id, { expectedVersion: def.version, fields: { label: 'Background' } });
    expect(renamed.key).toBe('research-notes');
    expect(env.db.prepare('SELECT value, updated_at FROM attribute_value WHERE attribute_id = ? AND entity_id = ?').get(def.id, subject.id)).toEqual(valueBefore);
    const detail = getPersonDetail(env.db, env.workspaceId, subject.id, { forModel: true });
    expect(attribute(detail, 'research-notes')).toMatchObject({ label: 'Background', value: 'Met at the summit.' });
    // The key still addresses the value after the rename.
    expect(updatePerson(env.ctx, subject.id, { expectedVersion: 2, fields: { 'attr:research-notes': 'Updated.' } }).version).toBe(3);
  });

  it('keeps definitions and values inside their workspace', () => {
    const other = env.db.prepare("INSERT INTO workspace (id, created_at, name, template) VALUES ('wsp_other', '2027-01-01', 'Other', 'startup-fundraising')").run();
    expect(other.changes).toBe(1);
    const otherCtx = createContext(env.db, 'wsp_other', { bus: env.bus, now: env.ctx.now });
    const created = createAttribute(otherCtx, { entityType: 'person', label: 'Other only', kind: 'text' });
    expect(listAttributeDefs(env.db, env.workspaceId).some((def) => def.id === created.id)).toBe(false);
    const subject = person('Isolated');
    expect(rejected(() => updatePerson(env.ctx, subject.id, { expectedVersion: 1, fields: { 'attr:other-only': 'x' } })).message).toContain('attr:other-only');
    expect(rejected(() => deleteAttribute(env.ctx, created.id)).code).toBe('not_found');
    expect(rejected(() => updateAttribute(env.ctx, created.id, { expectedVersion: 1, fields: { label: 'Mine' } })).code).toBe('not_found');
    expect(listAttributeDefs(env.db, 'wsp_other')).toHaveLength(1);
  });
});

describe('agent proposal path', () => {
  const envelope = (proposal: ReturnType<typeof proposeChanges>) => ({
    proposalHash: proposal.proposalHash,
    changes: proposal.changes.map(({ entityType, id, expectedVersion, fields }) => ({ entityType, id, expectedVersion, fields })),
  });

  it('flags unknown keys at propose time and previews valid attribute diffs without writing', () => {
    const subject = person('Propose');
    const proposal = proposeChanges(env.ctx, {
      changes: [
        { entityType: 'person', id: subject.id, fields: { 'attr:fit-notes': 'Strong fit for seed.', 'attr:minimum-check-size': 100000, title: 'Angel' } },
        { entityType: 'person', id: subject.id, fields: { 'attr:missing': 'x' } },
        { entityType: 'person', id: subject.id, fields: { 'attr:fit-notes': 'x'.repeat(2001) } },
        { entityType: 'opportunity', id: 'opp_nothing', fields: { 'attr:fit-notes': 'x' } },
      ],
    });
    expect(proposal.valid).toBe(false);
    expect(proposal.changes[0]!.valid).toBe(true);
    expect(proposal.changes[0]!.diff).toEqual([
      { field: 'title', from: null, to: 'Angel' },
      { field: 'attr:fit-notes', from: null, to: 'Strong fit for seed.' },
      { field: 'attr:minimum-check-size', from: null, to: { amount: 100000, currency: 'USD' } },
    ]);
    expect(proposal.changes[1]!.valid).toBe(false);
    expect(proposal.changes[1]!.errors[0]).toContain('attr:missing');
    expect(proposal.changes[2]!.valid).toBe(false);
    expect(proposal.changes[3]!.valid).toBe(false);
    expect(attribute(getPersonDetail(env.db, env.workspaceId, subject.id), 'fit-notes').value).toBeNull();
    expect(getPerson(env.db, env.workspaceId, subject.id)?.version).toBe(1);
  });

  it('applies valid attribute changes as the agent actor and records the audit', () => {
    const subject = person('Apply');
    const agent = withActor(env.ctx, 'agent:mcp');
    const proposal = proposeChanges(agent, { changes: [{ entityType: 'person', id: subject.id, fields: { 'attr:message-angle': 'Open with the portfolio overlap.' } }] });
    expect(proposal.valid).toBe(true);
    const result = applyChanges(agent, envelope(proposal));
    expect(result.applied).toHaveLength(1);
    const detail = getPersonDetail(env.db, env.workspaceId, subject.id, { forModel: true });
    expect(attribute(detail, 'message-angle').value).toBe('Open with the portfolio overlap.');
    expect(detail.version).toBe(2);
    expect(audits('changes.apply').length).toBeGreaterThan(0);
    const row = env.db.prepare("SELECT actor FROM audit_event WHERE action = 'person.update' AND entity_id = ? ORDER BY created_at DESC LIMIT 1").get(subject.id) as { actor: string };
    expect(row.actor).toBe('agent:mcp');
  });

  it('refuses at apply time when the definition was deleted after the proposal, writing nothing', () => {
    const def = createAttribute(env.ctx, { entityType: 'person', label: 'Short lived', kind: 'text' });
    const subject = person('Vanish');
    const other = person('Vanish', 'Sibling');
    const proposal = proposeChanges(env.ctx, {
      changes: [
        { entityType: 'person', id: other.id, fields: { title: 'Should not land' } },
        { entityType: 'person', id: subject.id, fields: { 'attr:short-lived': 'hello' } },
      ],
    });
    expect(proposal.valid).toBe(true);
    deleteAttribute(env.ctx, def.id);
    const error = rejected(() => applyChanges(env.ctx, envelope(proposal)));
    expect(error.code).toBe('validation');
    expect(error.message).toContain('attr:short-lived');
    expect(getPerson(env.db, env.workspaceId, other.id)).toMatchObject({ title: null, version: 1 });
    expect(getPerson(env.db, env.workspaceId, subject.id)?.version).toBe(1);
  });
});

describe('model facing reads', () => {
  it('includes attributes in forModel details and still omits lists and interaction', () => {
    const subject = person('Model');
    updatePerson(env.ctx, subject.id, { expectedVersion: 1, fields: { 'attr:minimum-check-size': { amount: 50000, currency: 'EUR' } } });
    const detail = getPersonDetail(env.db, env.workspaceId, subject.id, { forModel: true });
    expect(detail).not.toHaveProperty('lists');
    expect(attribute(detail, 'minimum-check-size')).toMatchObject({ value: 50000, currency: 'EUR' });
    expect(detail.attributes.map((entry) => entry.key).slice(0, 5)).toEqual([
      'message-angle', 'fit-notes', 'research-notes', 'minimum-check-size', 'maximum-check-size',
    ]);
    const organization = createOrganization(env.ctx, { name: 'Model Org', kind: 'company' });
    expect(getOrganizationDetail(env.db, env.workspaceId, organization.id, { forModel: true })).toHaveProperty('attributes');
  });

  it('carries attributes through the real MCP server, and proposes attr keys through it', async () => {
    const subject = person('Mcp');
    updatePerson(env.ctx, subject.id, { expectedVersion: 1, fields: { 'attr:fit-notes': 'Writes into climate funds.' } });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), 'mcp'],
      cwd: packageRoot,
      env: { ...(process.env as Record<string, string>), AGENTCRM_DB: env.databasePath },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'attributes-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
        expect.arrayContaining(['crm_get_record', 'crm_propose_changes', 'crm_apply_changes']),
      );
      const read = async () => {
        const result = await client.callTool({ name: 'crm_get_record', arguments: { id: subject.id } });
        return JSON.parse((result.content as { text: string }[])[0]!.text);
      };
      const got = await read();
      expect(got.entityType).toBe('person');
      const fit = got.record.attributes.find((entry: any) => entry.key === 'fit-notes');
      expect(fit).toMatchObject({ kind: 'text', label: 'Fit notes', value: 'Writes into climate funds.', currency: null });
      expect(got.record.attributes.find((entry: any) => entry.key === 'minimum-check-size')).toMatchObject({ value: null, currency: 'USD' });

      const proposed = await client.callTool({
        name: 'crm_propose_changes',
        arguments: { changes: [{ entityType: 'person', id: subject.id, fields: { 'attr:message-angle': 'Congratulate the fund close.', 'attr:ghost': 1 } }] },
      });
      const proposal = JSON.parse((proposed.content as { text: string }[])[0]!.text);
      expect(proposal.valid).toBe(false);
      expect(proposal.changes[0].errors[0]).toContain('attr:ghost');

      const good = await client.callTool({
        name: 'crm_propose_changes',
        arguments: { changes: [{ entityType: 'person', id: subject.id, fields: { 'attr:message-angle': 'Congratulate the fund close.' } }] },
      });
      const clean = JSON.parse((good.content as { text: string }[])[0]!.text);
      expect(clean.valid).toBe(true);
      const applied = await client.callTool({
        name: 'crm_apply_changes',
        arguments: {
          proposalHash: clean.proposalHash,
          changes: clean.changes.map((change: any) => ({ entityType: change.entityType, id: change.id, expectedVersion: change.expectedVersion, fields: change.fields })),
        },
      });
      expect(applied.isError).not.toBe(true);
      const after = await read();
      expect(after.record.attributes.find((entry: any) => entry.key === 'message-angle').value).toBe('Congratulate the fund close.');
    } finally {
      await client.close();
    }
  }, 60_000);
});
