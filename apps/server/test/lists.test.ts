import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addListMembers,
  createList,
  createPerson,
  deleteList,
  removeListMember,
  resetRecordData,
  updateList,
} from '../src/actions/index.js';
import { applyMigrations, listMigrationFiles } from '../src/db.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { migrationsDirectory } from '../src/paths.js';
import { getPersonDetail, listPeople } from '../src/queries/people.js';
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
    (row) => ({ entityId: row.entity_id, detail: JSON.parse(row.detail) as Record<string, unknown> }),
  );
const memberIds = (listId: string) =>
  (env.db.prepare('SELECT person_id FROM list_member WHERE list_id = ? ORDER BY person_id').all(listId) as { person_id: string }[]).map((row) => row.person_id);
const person = (firstName: string, lastName = 'Lister', extra: Record<string, unknown> = {}) => createPerson(env.ctx, { firstName, lastName, ...extra });
const listEvents = () => events.filter((event) => event.type === 'record_updated' && event.entityType === 'list');

describe('migration 023', () => {
  it('creates the tables, the index, and cascades from both sides', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of listMigrationFiles().filter((name) => name < '023')) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'One', 't');
      db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('per_1', '2026-01-01', 'wsp_1', 'Ada', 'Lovelace', '2026-01-01');

      expect(applyMigrations(db)).toEqual(['023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql', '030_transcript.sql', '031_duplicates.sql', '032_organization_duplicates.sql', '033_meetings.sql']);
      db.prepare('INSERT INTO list (id, created_at, workspace_id, name, updated_at) VALUES (?, ?, ?, ?, ?)').run('lst_1', '2026-01-02', 'wsp_1', 'UK Angels', '2026-01-02');
      expect(db.prepare('SELECT version FROM list').get()).toEqual({ version: 1 });
      db.prepare('INSERT INTO list_member (list_id, person_id, created_at) VALUES (?, ?, ?)').run('lst_1', 'per_1', '2026-01-02');
      expect(() => db.prepare('INSERT INTO list_member (list_id, person_id, created_at) VALUES (?, ?, ?)').run('lst_1', 'per_1', '2026-01-03')).toThrow(/UNIQUE|PRIMARY/);
      expect(() => db.prepare('INSERT INTO list_member (list_id, person_id, created_at) VALUES (?, ?, ?)').run('lst_1', 'per_nope', '2026-01-03')).toThrow(/FOREIGN KEY/);
      expect((db.pragma('index_info(idx_list_member_person)') as { name: string }[]).map((column) => column.name)).toEqual(['person_id']);

      db.prepare('DELETE FROM person WHERE id = ?').run('per_1');
      expect(db.prepare('SELECT COUNT(*) AS n FROM list_member').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM list').get()).toEqual({ n: 1 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('list create, rename, delete', () => {
  it('creates a list with a trimmed name, audits it, and emits for the list', () => {
    const before = listEvents().length;
    const list = createList(env.ctx, { name: '  UK Angels  ' });
    expect(list).toMatchObject({ name: 'UK Angels', version: 1, memberCount: 0 });
    expect(list.id).toMatch(/^lst_[0-9a-f]{12}$/);
    expect(audits('list.create')).toContainEqual({ entityId: list.id, detail: { name: 'UK Angels' } });
    expect(listEvents().slice(before)).toEqual([{ type: 'record_updated', entityType: 'list', entityId: list.id }]);
  });

  it('validates the name: empty after trimming, over 200 characters, unknown keys', () => {
    expect(rejected(() => createList(env.ctx, { name: '   ' })).code).toBe('validation');
    expect(rejected(() => createList(env.ctx, { name: 'x'.repeat(201) })).code).toBe('validation');
    expect(createList(env.ctx, { name: 'y'.repeat(200) }).name).toHaveLength(200);
    expect(rejected(() => createList(env.ctx, { name: 'Fine', extra: 1 })).code).toBe('validation');
  });

  it('renames with the expected version and answers 409 on a stale one', () => {
    const list = createList(env.ctx, { name: 'Energy' });
    const renamed = updateList(env.ctx, list.id, { expectedVersion: 1, fields: { name: ' Energy investors ' } });
    expect(renamed).toMatchObject({ name: 'Energy investors', version: 2 });
    const stale = rejected(() => updateList(env.ctx, list.id, { expectedVersion: 1, fields: { name: 'Late' } }));
    expect(stale.code).toBe('version_conflict');
    expect(stale.current).toMatchObject({ name: 'Energy investors', version: 2 });
    expect(rejected(() => updateList(env.ctx, list.id, { expectedVersion: 2, fields: { name: '' } })).code).toBe('validation');
    expect(rejected(() => updateList(env.ctx, 'lst_000000000000', { expectedVersion: 1, fields: { name: 'X' } })).code).toBe('not_found');
    expect(audits('list.update').at(-1)).toEqual({ entityId: list.id, detail: { from: 'Energy', to: 'Energy investors' } });
  });

  it('deletes a list with members, keeps the people, and audits the member count', () => {
    const list = createList(env.ctx, { name: 'Doomed' });
    const a = person('Del', 'A');
    const b = person('Del', 'B');
    addListMembers(env.ctx, list.id, { personIds: [a.id, b.id] });
    deleteList(env.ctx, list.id);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM list WHERE id = ?').get(list.id)).toEqual({ n: 0 });
    expect(memberIds(list.id)).toEqual([]);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM person WHERE id IN (?, ?)').get(a.id, b.id)).toEqual({ n: 2 });
    expect(audits('list.delete').at(-1)).toEqual({ entityId: list.id, detail: { name: 'Doomed', members: 2 } });
    expect(rejected(() => deleteList(env.ctx, list.id)).code).toBe('not_found');
  });
});

describe('members', () => {
  it('splits added from already, bumps the version once, and writes one audit row', () => {
    const list = createList(env.ctx, { name: 'Split' });
    const [a, b, c] = [person('Split', 'A'), person('Split', 'B'), person('Split', 'C')];
    expect(addListMembers(env.ctx, list.id, { personIds: [a.id] })).toEqual({ added: 1, already: 0 });
    const eventsBefore = listEvents().length;
    const auditsBefore = audits('list.member_add').length;
    expect(addListMembers(env.ctx, list.id, { personIds: [a.id, b.id, c.id, b.id] })).toEqual({ added: 2, already: 1 });
    expect(memberIds(list.id)).toEqual([a.id, b.id, c.id].sort());
    expect(env.db.prepare('SELECT version FROM list WHERE id = ?').get(list.id)).toEqual({ version: 3 });
    expect(audits('list.member_add')).toHaveLength(auditsBefore + 1);
    expect(audits('list.member_add').at(-1)).toEqual({ entityId: list.id, detail: { added: 2, already: 1 } });
    expect(listEvents().length).toBe(eventsBefore + 1);
  });

  it('writes nothing when every person is already a member', () => {
    const list = createList(env.ctx, { name: 'Noop' });
    const a = person('Noop');
    addListMembers(env.ctx, list.id, { personIds: [a.id] });
    const auditsBefore = audits('list.member_add').length;
    const eventsBefore = listEvents().length;
    expect(addListMembers(env.ctx, list.id, { personIds: [a.id] })).toEqual({ added: 0, already: 1 });
    expect(audits('list.member_add')).toHaveLength(auditsBefore);
    expect(listEvents()).toHaveLength(eventsBefore);
    expect(env.db.prepare('SELECT version FROM list WHERE id = ?').get(list.id)).toEqual({ version: 2 });
  });

  it('accepts 500 people and refuses 0 or 501', () => {
    const list = createList(env.ctx, { name: 'Bounds' });
    const ids = Array.from({ length: 500 }, (_, index) => person(`Bulk${index}`, 'Bound').id);
    expect(rejected(() => addListMembers(env.ctx, list.id, { personIds: [] })).code).toBe('validation');
    expect(rejected(() => addListMembers(env.ctx, list.id, { personIds: [...ids, ids[0]!] })).code).toBe('validation');
    expect(addListMembers(env.ctx, list.id, { personIds: ids })).toEqual({ added: 500, already: 0 });
  });

  it('refuses the whole call when one person is unknown and writes nothing', () => {
    const list = createList(env.ctx, { name: 'Atomic' });
    const a = person('Atomic');
    const auditsBefore = audits('list.member_add').length;
    const failure = rejected(() => addListMembers(env.ctx, list.id, { personIds: [a.id, 'per_000000000000'] }));
    expect(failure.code).toBe('validation');
    expect(failure.message).toMatch(/not found/);
    expect(memberIds(list.id)).toEqual([]);
    expect(env.db.prepare('SELECT version FROM list WHERE id = ?').get(list.id)).toEqual({ version: 1 });
    expect(audits('list.member_add')).toHaveLength(auditsBefore);
    expect(rejected(() => addListMembers(env.ctx, 'lst_000000000000', { personIds: [a.id] })).code).toBe('not_found');
  });

  it('never touches the person: no version bump, no claim, no person event', () => {
    const list = createList(env.ctx, { name: 'Quiet' });
    const a = person('Quiet');
    const claimsBefore = env.db.prepare('SELECT COUNT(*) AS n FROM field_claim').get();
    const eventsBefore = events.length;
    addListMembers(env.ctx, list.id, { personIds: [a.id] });
    removeListMember(env.ctx, list.id, a.id);
    expect(getPersonDetail(env.db, env.workspaceId, a.id).version).toBe(a.version);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM field_claim').get()).toEqual(claimsBefore);
    expect(events.slice(eventsBefore).every((event) => event.type === 'record_updated' && event.entityType === 'list')).toBe(true);
    expect(events.slice(eventsBefore)).toHaveLength(2);
  });

  it('removes one membership, bumps the version, and answers the same shape for an absent one', () => {
    const list = createList(env.ctx, { name: 'Remove' });
    const [a, b] = [person('Rem', 'A'), person('Rem', 'B')];
    addListMembers(env.ctx, list.id, { personIds: [a.id, b.id] });
    expect(removeListMember(env.ctx, list.id, a.id)).toEqual({ removed: 1 });
    expect(memberIds(list.id)).toEqual([b.id]);
    expect(env.db.prepare('SELECT version FROM list WHERE id = ?').get(list.id)).toEqual({ version: 3 });
    // Contract: member_remove audit detail is counts only, never a person id.
    expect(audits('list.member_remove').at(-1)).toEqual({ entityId: list.id, detail: { removed: 1 } });

    const auditsBefore = audits('list.member_remove').length;
    const eventsBefore = listEvents().length;
    expect(removeListMember(env.ctx, list.id, a.id)).toEqual({ removed: 0 });
    expect(removeListMember(env.ctx, list.id, 'per_000000000000')).toEqual({ removed: 0 });
    expect(audits('list.member_remove')).toHaveLength(auditsBefore);
    expect(listEvents()).toHaveLength(eventsBefore);
    expect(env.db.prepare('SELECT version FROM list WHERE id = ?').get(list.id)).toEqual({ version: 3 });
    expect(rejected(() => removeListMember(env.ctx, 'lst_000000000000', a.id)).code).toBe('not_found');
  });

  it('cascades a person delete through their memberships', () => {
    const list = createList(env.ctx, { name: 'Cascade' });
    const a = person('Cascade', 'A');
    const b = person('Cascade', 'B');
    addListMembers(env.ctx, list.id, { personIds: [a.id, b.id] });
    env.db.prepare('DELETE FROM person WHERE id = ?').run(a.id);
    expect(memberIds(list.id)).toEqual([b.id]);
  });

  it('is cleared by a record reset, lists included', () => {
    const scratch = createTestEnvironment();
    try {
      const list = createList(scratch.ctx, { name: 'Reset' });
      const a = createPerson(scratch.ctx, { firstName: 'Re', lastName: 'Set' });
      addListMembers(scratch.ctx, list.id, { personIds: [a.id] });
      resetRecordData(scratch.db);
      expect(scratch.db.prepare('SELECT COUNT(*) AS n FROM list').get()).toEqual({ n: 0 });
      expect(scratch.db.prepare('SELECT COUNT(*) AS n FROM list_member').get()).toEqual({ n: 0 });
    } finally {
      scratch.cleanup();
    }
  });
});

describe('people filter and detail', () => {
  it('filters to members, combines with lifecycle, pages by keyset, and treats an unknown id as empty', () => {
    const list = createList(env.ctx, { name: 'Filter' });
    const other = createList(env.ctx, { name: 'Other filter' });
    const people = ['Fa', 'Fb', 'Fc', 'Fd', 'Fe'].map((first, index) =>
      person(first, 'Zfilter', index % 2 === 0 ? { lifecycle: 'relationship' } : {}),
    );
    const outsider = person('Fz', 'Zfilter');
    addListMembers(env.ctx, list.id, { personIds: people.map((entry) => entry.id) });
    addListMembers(env.ctx, other.id, { personIds: [outsider.id] });

    const members = listPeople(env.db, env.workspaceId, { list: list.id });
    expect(members.items.map((entry) => entry.id).sort()).toEqual(people.map((entry) => entry.id).sort());

    const firstPage = listPeople(env.db, env.workspaceId, { list: list.id, limit: 2 });
    const secondPage = listPeople(env.db, env.workspaceId, { list: list.id, limit: 2, cursor: firstPage.nextCursor! });
    const thirdPage = listPeople(env.db, env.workspaceId, { list: list.id, limit: 2, cursor: secondPage.nextCursor! });
    expect([...firstPage.items, ...secondPage.items, ...thirdPage.items].map((entry) => entry.firstName)).toEqual(['Fa', 'Fb', 'Fc', 'Fd', 'Fe']);
    expect(thirdPage.nextCursor).toBeNull();

    const relationships = listPeople(env.db, env.workspaceId, { list: list.id, lifecycle: 'relationship' });
    expect(relationships.items.map((entry) => entry.firstName)).toEqual(['Fa', 'Fc', 'Fe']);
    const leads = listPeople(env.db, env.workspaceId, { list: list.id, lifecycle: 'lead' });
    expect(leads.items.map((entry) => entry.firstName)).toEqual(['Fb', 'Fd']);

    expect(listPeople(env.db, env.workspaceId, { list: 'lst_000000000000' })).toEqual({ items: [], nextCursor: null });
  });

  it('serves the filter over HTTP, and an unknown list id answers 200 with an empty page', async () => {
    const list = createList(env.ctx, { name: 'Http filter' });
    const a = person('Http', 'Zfilter');
    addListMembers(env.ctx, list.id, { personIds: [a.id] });
    const found = await call('GET', `/api/people?list=${list.id}&lifecycle=lead`);
    expect(found.status).toBe(200);
    expect(found.body.items.map((entry: { id: string }) => entry.id)).toEqual([a.id]);
    const none = await call('GET', '/api/people?list=lst_000000000000');
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ items: [], nextCursor: null });
  });

  it('puts lists on the person detail, newest membership first, and keeps them out of agent reads', () => {
    const first = createList(env.ctx, { name: 'First joined' });
    const second = createList(env.ctx, { name: 'Second joined' });
    const a = person('Detail');
    addListMembers(env.ctx, first.id, { personIds: [a.id] });
    addListMembers(env.ctx, second.id, { personIds: [a.id] });
    expect(getPersonDetail(env.db, env.workspaceId, a.id).lists).toEqual([
      { id: second.id, name: 'Second joined' },
      { id: first.id, name: 'First joined' },
    ]);
    expect(getPersonDetail(env.db, env.workspaceId, a.id, { forModel: true })).not.toHaveProperty('lists');
    removeListMember(env.ctx, second.id, a.id);
    expect(getPersonDetail(env.db, env.workspaceId, a.id).lists).toEqual([{ id: first.id, name: 'First joined' }]);
    // A list rename shows on the next read.
    updateList(env.ctx, first.id, { expectedVersion: 2, fields: { name: 'Renamed' } });
    expect(getPersonDetail(env.db, env.workspaceId, a.id).lists).toEqual([{ id: first.id, name: 'Renamed' }]);
  });
});

describe('list endpoints', () => {
  it('runs the whole life cycle over HTTP', async () => {
    const created = await call('POST', '/api/lists', { name: 'Over http' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const a = person('Wire');

    const added = await call('POST', `/api/lists/${id}/members`, { personIds: [a.id] });
    expect(added).toEqual({ status: 200, body: { added: 1, already: 0 } });
    expect((await call('POST', `/api/lists/${id}/members`, { personIds: [a.id, 'per_000000000000'] })).status).toBe(400);

    const listing = await call('GET', '/api/lists');
    expect(listing.status).toBe(200);
    expect(listing.body.nextCursor).toBeNull();
    const row = listing.body.items.find((item: { id: string }) => item.id === id);
    expect(row).toMatchObject({ name: 'Over http', memberCount: 1, version: 2 });
    // Newest first.
    expect(listing.body.items[0].createdAt >= listing.body.items.at(-1).createdAt).toBe(true);

    const renamed = await call('PATCH', `/api/lists/${id}`, { expectedVersion: 2, fields: { name: 'Renamed over http' } });
    expect(renamed.body).toMatchObject({ name: 'Renamed over http', version: 3, memberCount: 1 });
    expect((await call('PATCH', `/api/lists/${id}`, { expectedVersion: 2, fields: { name: 'Stale' } })).status).toBe(409);

    expect(await call('DELETE', `/api/lists/${id}/members/${a.id}`)).toEqual({ status: 200, body: { removed: 1 } });
    expect(await call('DELETE', `/api/lists/${id}/members/${a.id}`)).toEqual({ status: 200, body: { removed: 0 } });
    expect((await call('DELETE', `/api/lists/${id}`)).status).toBe(204);
    expect((await call('DELETE', `/api/lists/${id}`)).status).toBe(404);
    expect((await call('GET', `/api/people/${a.id}`)).body.lists).toEqual([]);
  });
});
