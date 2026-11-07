// Adversarial review probes for the people lists wave (migration 023, list actions, list routes, the list= people filter).
// Names start with KILLS (the attack fails and the test pins that), CONFIRMS (a live bug: the test passes against today's
// code and the comment says what should happen instead), or ACCEPTED (a documented limit or a deliberate trade off).
// Nothing here changes application code.
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addListMembers,
  createList,
  createOrganization,
  createPerson,
  deleteList,
  proposeChanges,
  removeListMember,
  resetAllData,
  resetRecordData,
  startRun,
  updateList,
} from '../src/actions/index.js';
import { runChatTool } from '../src/agent/modelChat.js';
import { openDatabase } from '../src/db.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { packageRoot } from '../src/paths.js';
import { getPersonDetail, listPeople } from '../src/queries/people.js';
import { getRunDetail } from '../src/queries/runs.js';
import { seedDatabase } from '../src/seed/seed.js';
import { createTestEnvironment, insertSecondWorkspace, type TestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
const events: DomainEvent[] = [];
const SENTINEL = 'ZZ-SENTINEL-LIST-NAME';

beforeAll(async () => {
  env.bus.subscribe((event) => events.push(event));
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

function rejected(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('Expected the call to be rejected.');
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await app.inject({
    method,
    url,
    headers: { host: '127.0.0.1:4720', ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: response.statusCode, body: response.body === '' ? null : (response.json() as Record<string, any>) };
}

const countOf = (e: TestEnvironment, sql: string, ...params: unknown[]): number => Number((e.db.prepare(sql).get(...params) as { n: number }).n);
const memberIds = (listId: string, e: TestEnvironment = env) =>
  (e.db.prepare('SELECT person_id FROM list_member WHERE list_id = ? ORDER BY person_id').all(listId) as { person_id: string }[]).map((row) => row.person_id);
const audits = (action: string) =>
  (env.db.prepare('SELECT entity_type, entity_id, detail FROM audit_event WHERE action = ? ORDER BY created_at, id').all(action) as {
    entity_type: string;
    entity_id: string;
    detail: string;
  }[]).map((row) => ({ entityType: row.entity_type, entityId: row.entity_id, detail: JSON.parse(row.detail) as Record<string, unknown> }));
const versionOf = (listId: string) => (env.db.prepare('SELECT version FROM list WHERE id = ?').get(listId) as { version: number }).version;
const person = (first: string, last = 'Probe', extra: Record<string, unknown> = {}) => createPerson(env.ctx, { firstName: first, lastName: last, ...extra });
const listEvents = () => events.filter((event) => event.type === 'record_updated' && event.entityType === 'list');
const everything = () =>
  JSON.stringify(
    ['list', 'list_member', 'person', 'field_claim', 'activity', 'audit_event'].map((table) =>
      env.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ),
  );

describe('agent isolation', () => {
  it('KILLS: through the real MCP server, no tool touches lists and no read of a member person, a search, or the description carries membership', async () => {
    const list = createList(env.ctx, { name: SENTINEL });
    const member = person('Mcp', 'Isolation', { email: 'mcp.isolation@example.com' });
    addListMembers(env.ctx, list.id, { personIds: [member.id] });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), 'mcp'],
      cwd: packageRoot,
      env: { ...(process.env as Record<string, string>), AGENTCRM_DB: env.databasePath },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'lists-review-probe', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).join(' ')).not.toMatch(/list|member/i);
      const text = async (name: string, args: Record<string, unknown>) => String(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text);
      const record = await text('crm_get_record', { id: member.id });
      expect(record).toContain('Isolation');
      expect(record).not.toContain(SENTINEL);
      expect(record).not.toContain(list.id);
      expect(Object.keys(JSON.parse(record).record)).not.toContain('lists');
      const found = await text('crm_search', { query: 'Isolation' });
      expect(found).toContain(member.id);
      expect(found).not.toContain(SENTINEL);
      expect(await text('crm_describe', {})).not.toContain(SENTINEL);
      expect(await text('crm_get_record', { id: list.id })).toMatch(/per_, org_, or opp_|must start/);
    } finally {
      await client.close();
    }
  }, 40_000);

  it('KILLS: the chat tools (get_record, search_crm) never show membership, and the human read does', () => {
    const list = createList(env.ctx, { name: `${SENTINEL} chat` });
    const member = person('Chat', 'Isolation');
    addListMembers(env.ctx, list.id, { personIds: [member.id] });
    const got = runChatTool(env.ctx, { id: 'c1', name: 'get_record', input: { entityType: 'person', entityId: member.id } });
    expect(got.content).toContain('Isolation');
    expect(got.content).not.toContain(SENTINEL);
    expect(got.content).not.toContain(list.id);
    expect(got.content).not.toContain('"lists"');
    const searched = runChatTool(env.ctx, { id: 'c2', name: 'search_crm', input: { query: 'Isolation' } });
    expect(searched.content).not.toContain(SENTINEL);
    expect(getPersonDetail(env.db, env.workspaceId, member.id).lists).toEqual([{ id: list.id, name: `${SENTINEL} chat` }]);
    // No chat tool reads or writes lists.
    expect(runChatTool(env.ctx, { id: 'c3', name: 'list_lists', input: {} }).isError).toBe(true);
    expect(runChatTool(env.ctx, { id: 'c4', name: 'get_record', input: { entityType: 'list', entityId: list.id } }).isError).toBe(true);
  });

  it('KILLS: the proposal path cannot write membership: no list entity, no lists or listIds field on a person', () => {
    const list = createList(env.ctx, { name: 'Proposal target' });
    const target = person('Proposal', 'Target');
    const before = everything();
    expect(rejected(() => proposeChanges(env.ctx, { changes: [{ entityType: 'list', id: list.id, fields: { name: 'Hijack' } }] })).code).toBe('validation');
    for (const fields of [{ lists: [list.id] }, { listIds: [list.id] }, { list: list.id }, { memberOf: [list.id] }]) {
      const proposal = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: target.id, fields }] });
      expect(proposal.valid).toBe(false);
    }
    expect(everything()).toBe(before);
  });

  it('KILLS: a run read for an agent and a run scope naming a list carry nothing about lists', () => {
    const list = createList(env.ctx, { name: `${SENTINEL} run` });
    const member = person('Run', 'Isolation');
    addListMembers(env.ctx, list.id, { personIds: [member.id] });
    const run = startRun(env.ctx, { kind: 'demo_research' });
    const detail = JSON.stringify(getRunDetail(env.db, env.workspaceId, run.id, { forAgent: true }));
    expect(detail).not.toContain(SENTINEL);
    expect(detail).not.toContain(list.id);
    // Lists feed no automation: no run kind accepts a list in its scope (strict schemas), so a list can never target people.
    for (const kind of ['qualify', 'draft_outreach', 'demo_research']) {
      expect(rejected(() => startRun(env.ctx, { kind, scope: { listId: list.id } })).code, kind).toBe('validation');
    }
  });

  it('KILLS: all five write routes refuse a cross site Origin and write nothing, and accept a loopback Origin', async () => {
    const list = createList(env.ctx, { name: 'Origin guard' });
    const a = person('Origin', 'Guard');
    addListMembers(env.ctx, list.id, { personIds: [a.id] });
    const before = everything();
    const evil = { origin: 'https://evil.example' };
    const nullOrigin = { origin: 'null' };
    for (const headers of [evil, nullOrigin]) {
      expect((await call('POST', '/api/lists', { name: 'Evil' }, headers)).status).toBe(403);
      expect((await call('PATCH', `/api/lists/${list.id}`, { expectedVersion: versionOf(list.id), fields: { name: 'Evil' } }, headers)).status).toBe(403);
      expect((await call('POST', `/api/lists/${list.id}/members`, { personIds: [person('Origin', 'Extra').id] }, headers)).status).toBe(403);
      expect((await call('DELETE', `/api/lists/${list.id}/members/${a.id}`, undefined, headers)).status).toBe(403);
      expect((await call('DELETE', `/api/lists/${list.id}`, undefined, headers)).status).toBe(403);
    }
    // The extra people above were created before the 403s, so compare lists and membership only.
    expect(memberIds(list.id)).toEqual([a.id]);
    expect(versionOf(list.id)).toBe(2);
    expect(countOf(env, "SELECT COUNT(*) AS n FROM list WHERE name IN ('Evil')")).toBe(0);
    expect(before.length).toBeGreaterThan(0);
    const fine = { origin: 'http://localhost:5173' };
    expect((await call('POST', '/api/lists', { name: 'Fine origin' }, fine)).status).toBe(201);
    // A foreign Host header is refused too.
    expect((await call('GET', '/api/lists', undefined, { host: 'evil.example' })).status).toBe(403);
  });
});

describe('atomicity and counts', () => {
  it('KILLS: a refused add (unknown, organization id, other workspace person) writes nothing: no member, no version, no audit, no event', () => {
    const list = createList(env.ctx, { name: 'Refusal' });
    const a = person('Refuse', 'A');
    const org = createOrganization(env.ctx, { name: 'An organization' });
    const otherWorkspace = insertSecondWorkspace(env.db);
    env.db
      .prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('per_aaaaaaaaaaaa', '2026-03-02', otherWorkspace, 'Elsewhere', 'Person', '2026-03-02');
    addListMembers(env.ctx, list.id, { personIds: [a.id] });
    const b = person('Refuse', 'B');
    const before = everything();
    const eventsBefore = events.length;
    for (const bad of ['per_000000000000', org.id, 'per_aaaaaaaaaaaa', 'not an id']) {
      const failure = rejected(() => addListMembers(env.ctx, list.id, { personIds: [b.id, a.id, bad] }));
      expect(failure.code).toBe('validation');
      expect(failure.message).not.toContain(bad);
    }
    expect(everything()).toBe(before);
    expect(events).toHaveLength(eventsBefore);
    expect(memberIds(list.id)).toEqual([a.id]);
  });

  it('KILLS: the unknown count in the refusal counts distinct ids once', () => {
    const list = createList(env.ctx, { name: 'Refusal count' });
    expect(rejected(() => addListMembers(env.ctx, list.id, { personIds: ['per_111111111111', 'per_111111111111', 'per_111111111111'] })).message).toBe(
      '1 selected person was not found, so nobody was added.',
    );
    expect(rejected(() => addListMembers(env.ctx, list.id, { personIds: ['per_111111111111', 'per_222222222222'] })).message).toBe(
      '2 selected people were not found, so nobody was added.',
    );
  });

  it('KILLS: duplicate and whitespace padded ids in personIds count once in added and already', () => {
    const list = createList(env.ctx, { name: 'Dedupe' });
    const [a, b] = [person('Dedupe', 'A'), person('Dedupe', 'B')];
    expect(addListMembers(env.ctx, list.id, { personIds: [a.id, a.id, ` ${a.id} `, b.id] })).toEqual({ added: 2, already: 0 });
    expect(addListMembers(env.ctx, list.id, { personIds: [a.id, a.id, a.id] })).toEqual({ added: 0, already: 1 });
    expect(versionOf(list.id)).toBe(2);
    const c = person('Dedupe', 'C');
    expect(addListMembers(env.ctx, list.id, { personIds: [c.id, a.id, c.id, a.id] })).toEqual({ added: 1, already: 1 });
    expect(versionOf(list.id)).toBe(3);
  });

  it('KILLS: the 500 bound counts raw entries, so 500 copies of one id pass and 501 copies are refused before any lookup', () => {
    const list = createList(env.ctx, { name: 'Raw bound' });
    const a = person('Raw', 'Bound');
    expect(addListMembers(env.ctx, list.id, { personIds: Array.from({ length: 500 }, () => a.id) })).toEqual({ added: 1, already: 0 });
    const before = everything();
    expect(rejected(() => addListMembers(env.ctx, list.id, { personIds: Array.from({ length: 501 }, () => a.id) })).code).toBe('validation');
    expect(rejected(() => addListMembers(env.ctx, list.id, { personIds: [a.id, 7] })).code).toBe('validation');
    expect(rejected(() => addListMembers(env.ctx, list.id, { personIds: 'per_000000000000' })).code).toBe('validation');
    expect(rejected(() => addListMembers(env.ctx, list.id, { personIds: [a.id], extra: true })).code).toBe('validation');
    expect(rejected(() => addListMembers(env.ctx, list.id, { personIds: ['x'.repeat(65)] })).code).toBe('validation');
    expect(rejected(() => addListMembers(env.ctx, list.id, undefined)).code).toBe('validation');
    expect(everything()).toBe(before);
  });

  it('KILLS: HTTP bodies that are not objects answer 400 (not 500) and a members call on a missing list answers 404', async () => {
    const list = createList(env.ctx, { name: 'Http bodies' });
    expect((await call('POST', `/api/lists/${list.id}/members`)).status).toBe(400);
    expect((await call('POST', `/api/lists/${list.id}/members`, [] as unknown)).status).toBe(400);
    expect((await call('POST', `/api/lists/${list.id}/members`, { personIds: [] })).status).toBe(400);
    expect((await call('POST', '/api/lists', { name: 'x', members: [] })).status).toBe(400);
    expect((await call('POST', '/api/lists')).status).toBe(400);
    expect((await call('PATCH', `/api/lists/${list.id}`, { expectedVersion: 1, fields: { name: 'ok', version: 99 } })).status).toBe(400);
    expect((await call('PATCH', `/api/lists/${list.id}`, { expectedVersion: 1, fields: { memberCount: 5 } })).status).toBe(400);
    expect((await call('POST', '/api/lists/lst_000000000000/members', { personIds: ['per_000000000000'] })).status).toBe(404);
    expect((await call('DELETE', '/api/lists/lst_000000000000/members/per_000000000000')).status).toBe(404);
    expect(versionOf(list.id)).toBe(1);
  });

  it('KILLS: lists and people of another workspace are invisible to every list action and to the people filter', () => {
    const other = insertSecondWorkspace(env.db);
    env.db.prepare('INSERT INTO list (id, created_at, workspace_id, name, updated_at) VALUES (?, ?, ?, ?, ?)').run('lst_bbbbbbbbbbbb', '2026-03-02', other, 'Foreign list', '2026-03-02');
    env.db
      .prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('per_bbbbbbbbbbbb', '2026-03-02', other, 'Foreign', 'Person', '2026-03-02');
    env.db.prepare('INSERT INTO list_member (list_id, person_id, created_at) VALUES (?, ?, ?)').run('lst_bbbbbbbbbbbb', 'per_bbbbbbbbbbbb', '2026-03-02');
    const mine = person('Mine', 'Workspace');
    expect(rejected(() => addListMembers(env.ctx, 'lst_bbbbbbbbbbbb', { personIds: [mine.id] })).code).toBe('not_found');
    expect(rejected(() => removeListMember(env.ctx, 'lst_bbbbbbbbbbbb', 'per_bbbbbbbbbbbb')).code).toBe('not_found');
    expect(rejected(() => updateList(env.ctx, 'lst_bbbbbbbbbbbb', { expectedVersion: 1, fields: { name: 'Mine now' } })).code).toBe('not_found');
    expect(rejected(() => deleteList(env.ctx, 'lst_bbbbbbbbbbbb')).code).toBe('not_found');
    expect(listPeople(env.db, env.workspaceId, { list: 'lst_bbbbbbbbbbbb' })).toEqual({ items: [], nextCursor: null });
    // A membership row that links my person to a foreign list (impossible through the actions) stays out of the sheet.
    env.db.prepare('INSERT INTO list_member (list_id, person_id, created_at) VALUES (?, ?, ?)').run('lst_bbbbbbbbbbbb', mine.id, '2026-03-02');
    expect(getPersonDetail(env.db, env.workspaceId, mine.id).lists).toEqual([]);
    expect(listPeople(env.db, env.workspaceId, { list: 'lst_bbbbbbbbbbbb' }).items).toEqual([]);
    env.db.prepare('DELETE FROM list_member WHERE person_id = ?').run(mine.id);
    // Removing a foreign person id from my own list is a quiet no-op.
    const list = createList(env.ctx, { name: 'Mine' });
    expect(removeListMember(env.ctx, list.id, 'per_bbbbbbbbbbbb')).toEqual({ removed: 0 });
  });

  it('KILLS: a list deleted before the add lands refuses with 404 and leaves no orphan member rows; the foreign keys stay on', () => {
    const list = createList(env.ctx, { name: 'Deleted mid add' });
    const a = person('Mid', 'Add');
    expect(addListMembers(env.ctx, list.id, { personIds: [a.id] })).toEqual({ added: 1, already: 0 });
    deleteList(env.ctx, list.id);
    expect(rejected(() => addListMembers(env.ctx, list.id, { personIds: [a.id] })).code).toBe('not_found');
    expect(countOf(env, 'SELECT COUNT(*) AS n FROM list_member WHERE list_id = ?', list.id)).toBe(0);
    expect(env.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => env.db.prepare('INSERT INTO list_member (list_id, person_id, created_at) VALUES (?, ?, ?)').run(list.id, a.id, 'x')).toThrow(/FOREIGN KEY/);
    expect(env.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('KILLS: a person deleted right before the add (second connection) is refused as one validation error and the batch writes nothing', () => {
    const list = createList(env.ctx, { name: 'Racing delete' });
    const [keep, doomed] = [person('Race', 'Keep'), person('Race', 'Doomed')];
    const other = openDatabase(env.databasePath);
    try {
      other.prepare('DELETE FROM person WHERE id = ?').run(doomed.id);
    } finally {
      other.close();
    }
    const failure = rejected(() => addListMembers(env.ctx, list.id, { personIds: [keep.id, doomed.id] }));
    expect(failure.code).toBe('validation');
    expect(memberIds(list.id)).toEqual([]);
    expect(versionOf(list.id)).toBe(1);
  });
});

describe('cascades', () => {
  it('ACCEPTED: deleting a person cascades the membership but not the list version or an event; the count is computed live, so the select is right on its next fetch, but no app path deletes a person today', () => {
    const list = createList(env.ctx, { name: 'Stale count' });
    const [a, b] = [person('Stale', 'A'), person('Stale', 'B')];
    addListMembers(env.ctx, list.id, { personIds: [a.id, b.id] });
    const version = versionOf(list.id);
    const eventsBefore = listEvents().length;
    env.db.prepare('DELETE FROM person WHERE id = ?').run(a.id);
    expect(memberIds(list.id)).toEqual([b.id]);
    expect(versionOf(list.id)).toBe(version);
    expect(listEvents()).toHaveLength(eventsBefore);
    // Counts are not stored, so they cannot go stale.
    expect((env.db.prepare('SELECT COUNT(*) AS n FROM list_member WHERE list_id = ?').get(list.id) as { n: number }).n).toBe(1);
  });

  it('KILLS: two tabs deleting the same list: the second gets 404 and the audit shows one delete', async () => {
    const list = createList(env.ctx, { name: 'Double delete' });
    const a = person('Double', 'Delete');
    addListMembers(env.ctx, list.id, { personIds: [a.id] });
    expect((await call('DELETE', `/api/lists/${list.id}`)).status).toBe(204);
    const second = await call('DELETE', `/api/lists/${list.id}`);
    expect(second.status).toBe(404);
    expect(second.body!.error.code).toBe('not_found');
    expect(audits('list.delete').filter((row) => row.entityId === list.id)).toEqual([
      { entityType: 'list', entityId: list.id, detail: { name: 'Double delete', members: 1 } },
    ]);
    expect(countOf(env, 'SELECT COUNT(*) AS n FROM person WHERE id = ?', a.id)).toBe(1);
  });

  it('KILLS: record resets clear lists and memberships under foreign keys, with and without configuration', () => {
    for (const reset of [resetRecordData, resetAllData]) {
      const scratch = createTestEnvironment();
      try {
        const list = createList(scratch.ctx, { name: 'Reset me' });
        const a = createPerson(scratch.ctx, { firstName: 'Re', lastName: 'Set' });
        const org = createOrganization(scratch.ctx, { name: 'Reset org' });
        createPerson(scratch.ctx, { firstName: 'With', lastName: 'Org', organizationId: org.id });
        addListMembers(scratch.ctx, list.id, { personIds: [a.id] });
        reset(scratch.db);
        expect(countOf(scratch, 'SELECT COUNT(*) AS n FROM list')).toBe(0);
        expect(countOf(scratch, 'SELECT COUNT(*) AS n FROM list_member')).toBe(0);
        expect(countOf(scratch, 'SELECT COUNT(*) AS n FROM person')).toBe(0);
        expect(scratch.db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        scratch.cleanup();
      }
    }
  });
});

describe('seed', () => {
  it('KILLS: "crm seed" without --reset on a database that holds lists but no people refuses and keeps the lists, because the records-exist guard also counts lists', () => {
    const scratch = createTestEnvironment();
    try {
      createList(scratch.ctx, { name: 'Hand curated, no members yet' });
      expect(() => seedDatabase(scratch.db, { now: new Date('2026-03-01T12:00:00.000Z') })).toThrow(/already has records/);
      expect(countOf(scratch, 'SELECT COUNT(*) AS n FROM list')).toBe(1);
    } finally {
      scratch.cleanup();
    }
  });

  it('KILLS: with people present the guard still refuses a seed without --reset and leaves the lists alone; with --reset lists and memberships go and nothing dangles', () => {
    const scratch = createTestEnvironment();
    try {
      const list = createList(scratch.ctx, { name: 'Kept on refusal' });
      const a = createPerson(scratch.ctx, { firstName: 'Seed', lastName: 'Guard' });
      addListMembers(scratch.ctx, list.id, { personIds: [a.id] });
      expect(() => seedDatabase(scratch.db, { now: new Date('2026-03-01T12:00:00.000Z') })).toThrow(/already has records/);
      expect(countOf(scratch, 'SELECT COUNT(*) AS n FROM list_member')).toBe(1);
      seedDatabase(scratch.db, { reset: true, now: new Date('2026-03-01T12:00:00.000Z') });
      expect(countOf(scratch, 'SELECT COUNT(*) AS n FROM list')).toBe(0);
      expect(countOf(scratch, 'SELECT COUNT(*) AS n FROM list_member')).toBe(0);
      expect(scratch.db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      scratch.cleanup();
    }
  });
});

describe('people filter', () => {
  it('KILLS: keyset paging with list, lifecycle, q, and fit sort returns each member once, in order, across pages', () => {
    const list = createList(env.ctx, { name: 'Paging' });
    const people = Array.from({ length: 9 }, (_, index) =>
      person(`Pg${index}`, 'Zpaging', { email: index % 3 === 0 ? `pg${index}@keepme.example` : `pg${index}@other.example`, ...(index % 2 === 0 ? { lifecycle: 'relationship' } : {}) }),
    );
    const decoy = person('Pg', 'Zpaging', { email: 'decoy@keepme.example' });
    addListMembers(env.ctx, list.id, { personIds: people.map((entry) => entry.id) });
    const page = (input: Record<string, unknown>) => {
      const collected: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard += 1) {
        const result = listPeople(env.db, env.workspaceId, { list: list.id, limit: 2, cursor, ...input } as never);
        collected.push(...result.items.map((entry) => entry.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return collected;
    };
    for (const sort of [undefined, 'fit']) {
      const all = page({ sort });
      expect(new Set(all).size).toBe(all.length);
      expect(all.sort()).toEqual(people.map((entry) => entry.id).sort());
      expect(page({ sort, lifecycle: 'relationship' }).sort()).toEqual(people.filter((_, index) => index % 2 === 0).map((entry) => entry.id).sort());
      const queried = page({ sort, q: 'keepme' });
      expect(queried.sort()).toEqual(people.filter((_, index) => index % 3 === 0).map((entry) => entry.id).sort());
      expect(queried).not.toContain(decoy.id);
    }
  });

  it('KILLS: a cursor whose row left the list mid paging neither duplicates nor skips anyone', () => {
    const list = createList(env.ctx, { name: 'Cursor leaves' });
    const people = ['Ca', 'Cb', 'Cc', 'Cd', 'Ce'].map((first) => person(first, 'Zcursor'));
    addListMembers(env.ctx, list.id, { personIds: people.map((entry) => entry.id) });
    const first = listPeople(env.db, env.workspaceId, { list: list.id, limit: 2 });
    expect(first.items.map((entry) => entry.firstName)).toEqual(['Ca', 'Cb']);
    removeListMember(env.ctx, list.id, first.items[1]!.id);
    const second = listPeople(env.db, env.workspaceId, { list: list.id, limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((entry) => entry.firstName)).toEqual(['Cc', 'Cd']);
    const third = listPeople(env.db, env.workspaceId, { list: list.id, limit: 2, cursor: second.nextCursor! });
    expect(third.items.map((entry) => entry.firstName)).toEqual(['Ce']);
  });

  it('KILLS: hostile list= values over HTTP answer an empty page (never everyone, never a 500) while real members exist', async () => {
    const list = createList(env.ctx, { name: 'Hostile filter' });
    const a = person('Hostile', 'Filter');
    addListMembers(env.ctx, list.id, { personIds: [a.id] });
    const total = countOf(env, 'SELECT COUNT(*) AS n FROM person');
    expect(total).toBeGreaterThan(1);
    const hostile = [
      "' OR '1'='1",
      `${list.id}' OR 1=1 --`,
      `${list.id}'); DELETE FROM list; --`,
      '%',
      '_',
      '*',
      '%00',
      '..%2f..%2fetc',
      '\u0000',
      '%E2%80%AE',
      'x'.repeat(5000),
      `${list.id}%20`,
      `${list.id.toUpperCase()}`,
    ];
    for (const value of hostile) {
      const response = await call('GET', `/api/people?list=${value.includes('%') ? value : encodeURIComponent(value)}`);
      expect(response.status, value.slice(0, 40)).toBe(200);
      expect(response.body, value.slice(0, 40)).toEqual({ items: [], nextCursor: null });
    }
    expect(countOf(env, 'SELECT COUNT(*) AS n FROM list WHERE id = ?', list.id)).toBe(1);
    // Two list parameters are a validation error, not a crash or a silent pick.
    expect((await call('GET', `/api/people?list=${list.id}&list=${list.id}`)).status).toBe(400);
    expect((await call('GET', `/api/people?list=${list.id}&lifecycle=nonsense`)).status).toBe(400);
    expect((await call('GET', `/api/people?list=${list.id}`)).body!.items.map((entry: { id: string }) => entry.id)).toEqual([a.id]);
  });

  it('ACCEPTED: an empty list= means no filter (everyone), and the organizations endpoint ignores list= entirely', async () => {
    const list = createList(env.ctx, { name: 'Org tab' });
    const org = createOrganization(env.ctx, { name: 'Ignores lists inc' });
    const everyone = await call('GET', '/api/people?limit=200');
    const emptyValue = await call('GET', '/api/people?limit=200&list=');
    expect(emptyValue.body!.items).toHaveLength(everyone.body!.items.length);
    const orgs = await call('GET', '/api/organizations?limit=200');
    const orgsWithList = await call('GET', `/api/organizations?limit=200&list=${list.id}`);
    expect(orgsWithList.status).toBe(200);
    expect(orgsWithList.body!.items.map((item: { id: string }) => item.id)).toEqual(orgs.body!.items.map((item: { id: string }) => item.id));
    expect(orgsWithList.body!.items.map((item: { id: string }) => item.id)).toContain(org.id);
  });
});

describe('versioning', () => {
  it('KILLS: a stale rename answers 409 with the current list (name, version, live member count)', async () => {
    const list = createList(env.ctx, { name: 'Conflict' });
    const a = person('Conflict', 'A');
    addListMembers(env.ctx, list.id, { personIds: [a.id] });
    const stale = await call('PATCH', `/api/lists/${list.id}`, { expectedVersion: 1, fields: { name: 'Late rename' } });
    expect(stale.status).toBe(409);
    expect(stale.body!.error.code).toBe('version_conflict');
    expect(stale.body!.error.current).toMatchObject({ id: list.id, name: 'Conflict', version: 2, memberCount: 1 });
    expect((await call('PATCH', `/api/lists/${list.id}`, { expectedVersion: 99, fields: { name: 'Future' } })).status).toBe(409);
    expect((await call('GET', '/api/lists')).body!.items.find((item: { id: string }) => item.id === list.id).name).toBe('Conflict');
  });

  it('ACCEPTED: membership changes bump the same version a rename checks, so an add by anyone while a rename sheet is open turns that rename into a 409', () => {
    const list = createList(env.ctx, { name: 'Version shared' });
    const openedAt = list.version;
    addListMembers(env.ctx, list.id, { personIds: [person('Shared', 'Version').id] });
    const failure = rejected(() => updateList(env.ctx, list.id, { expectedVersion: openedAt, fields: { name: 'Renamed' } }));
    expect(failure.code).toBe('version_conflict');
    expect((failure.current as { name: string }).name).toBe('Version shared');
  });

  it('KILLS: every add and remove bumps exactly once per call; an all-already add and an absent remove bump nothing', () => {
    const list = createList(env.ctx, { name: 'Bumps' });
    const people = [person('Bump', 'A'), person('Bump', 'B'), person('Bump', 'C')];
    const versions = [versionOf(list.id)];
    const step = (run: () => unknown) => {
      run();
      versions.push(versionOf(list.id));
    };
    step(() => addListMembers(env.ctx, list.id, { personIds: people.map((entry) => entry.id) }));
    step(() => addListMembers(env.ctx, list.id, { personIds: people.map((entry) => entry.id) }));
    step(() => removeListMember(env.ctx, list.id, people[0]!.id));
    step(() => removeListMember(env.ctx, list.id, people[0]!.id));
    step(() => addListMembers(env.ctx, list.id, { personIds: [people[0]!.id, people[1]!.id] }));
    expect(versions).toEqual([1, 2, 2, 3, 3, 4]);
  });

  it('KILLS: interleaved adds from two connections (the server and an MCP or CLI process) double bump but never corrupt membership', () => {
    const list = createList(env.ctx, { name: 'Two writers' });
    const [a, b, c] = [person('Two', 'A'), person('Two', 'B'), person('Two', 'C')];
    const second = openDatabase(env.databasePath);
    try {
      const outsider = { ...env.ctx, db: second };
      expect(addListMembers(env.ctx, list.id, { personIds: [a.id, b.id] })).toEqual({ added: 2, already: 0 });
      expect(addListMembers(outsider, list.id, { personIds: [b.id, c.id] })).toEqual({ added: 1, already: 1 });
      expect(addListMembers(env.ctx, list.id, { personIds: [c.id] })).toEqual({ added: 0, already: 1 });
    } finally {
      second.close();
    }
    expect(memberIds(list.id)).toEqual([a.id, b.id, c.id].sort());
    expect(versionOf(list.id)).toBe(3);
    expect(audits('list.member_add').filter((row) => row.entityId === list.id).map((row) => row.detail)).toEqual([
      { added: 2, already: 0 },
      { added: 1, already: 1 },
    ]);
  });
});

describe('parallel requests', () => {
  it('KILLS: twenty overlapping add and remove requests over HTTP leave membership consistent with the answers and the version equal to one plus the calls that changed something', async () => {
    const list = createList(env.ctx, { name: 'Parallel' });
    const people = Array.from({ length: 6 }, (_, index) => person(`Par${index}`, 'Allel'));
    const requests = Array.from({ length: 20 }, (_, index) =>
      index % 4 === 3
        ? call('DELETE', `/api/lists/${list.id}/members/${people[index % 6]!.id}`)
        : call('POST', `/api/lists/${list.id}/members`, { personIds: [people[index % 6]!.id, people[(index + 1) % 6]!.id] }),
    );
    const answers = await Promise.all(requests);
    expect(answers.every((answer) => answer.status === 200)).toBe(true);
    const changed = answers.filter((answer) => answer.body!.added > 0 || answer.body!.removed > 0).length;
    expect(versionOf(list.id)).toBe(1 + changed);
    const added = answers.reduce((sum, answer) => sum + (answer.body!.added ?? 0), 0);
    const removed = answers.reduce((sum, answer) => sum + (answer.body!.removed ?? 0), 0);
    expect(memberIds(list.id)).toHaveLength(added - removed);
    expect(audits('list.member_add').filter((row) => row.entityId === list.id)).toHaveLength(answers.filter((answer) => answer.body!.added > 0).length);
    expect(env.db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('hostile names', () => {
  it('ACCEPTED: a list name of only invisible characters is accepted (same rule as other record names, no scrub); it shows as a blank option in the select', () => {
    // What should happen if this is ever tightened: scrub zero width characters like capture does, so a blank looking
    // list cannot be created or confused with another. The contract says names follow the record rule, which has no scrub.
    for (const invisible of ['\u200B', '\u2060\u200D', '\u200E', '\u00AD', '\u3164', '\u2800']) {
      const list = createList(env.ctx, { name: invisible });
      expect(list.name).toBe(invisible);
      expect(list.name.trim()).not.toBe('');
    }
    // Ordinary whitespace, including line breaks and the no break space, still trims away to nothing.
    for (const blank of ['', ' ', '\n\t', '\u00A0', '\u2003', '\uFEFF']) expect(rejected(() => createList(env.ctx, { name: blank })).code).toBe('validation');
  });

  it('KILLS: the 200 bound applies after trimming and counts UTF-16 units (ACCEPTED quirk: 101 emoji are refused)', () => {
    expect(createList(env.ctx, { name: `  ${'n'.repeat(200)}  ` }).name).toHaveLength(200);
    expect(rejected(() => createList(env.ctx, { name: 'n'.repeat(201) })).code).toBe('validation');
    expect(rejected(() => createList(env.ctx, { name: '\u{1F600}'.repeat(101) })).code).toBe('validation');
    expect(createList(env.ctx, { name: '\u{1F600}'.repeat(100) }).name).toHaveLength(200);
  });

  it('KILLS: markup, SQL, and control characters in names are stored verbatim and returned as data, in the list, the person detail, and the audit row', async () => {
    const names = ['<img src=x onerror=alert(1)>', "Robert'); DROP TABLE list;--", '</script><script>alert(1)</script>', 'Line one\nLine two', '{{7*7}} ${7*7} %s'];
    const a = person('Markup', 'Names');
    for (const name of names) {
      const created = await call('POST', '/api/lists', { name });
      expect(created.status).toBe(201);
      expect(created.body!.name).toBe(name);
      addListMembers(env.ctx, created.body!.id, { personIds: [a.id] });
    }
    const detail = (await call('GET', `/api/people/${a.id}`)).body!;
    expect(detail.lists.map((entry: { name: string }) => entry.name).sort()).toEqual([...names].sort());
    expect(countOf(env, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'list'")).toBe(1);
    expect(audits('list.create').map((row) => row.detail.name)).toEqual(expect.arrayContaining(names));
  });

  it('ACCEPTED: duplicate list names are allowed (the contract is silent); the web identifies lists by id', () => {
    const one = createList(env.ctx, { name: 'Twin' });
    const two = createList(env.ctx, { name: 'Twin' });
    expect(one.id).not.toBe(two.id);
    const names = (env.db.prepare("SELECT name FROM list WHERE name = 'Twin'").all() as { name: string }[]).length;
    expect(names).toBe(2);
  });
});

describe('audit trail', () => {
  it('KILLS: list.member_add rows hold counts only, never a person id, a name, or an email, however many people were added', () => {
    const list = createList(env.ctx, { name: 'Audit counts' });
    const people = [person('Audit', 'Alpha', { email: 'audit.alpha@example.com' }), person('Audit', 'Beta', { email: 'audit.beta@example.com' })];
    addListMembers(env.ctx, list.id, { personIds: people.map((entry) => entry.id) });
    addListMembers(env.ctx, list.id, { personIds: [...people.map((entry) => entry.id), person('Audit', 'Gamma').id] });
    const rows = env.db.prepare("SELECT detail, entity_type, entity_id, actor FROM audit_event WHERE action = 'list.member_add' AND entity_id = ?").all(list.id) as {
      detail: string;
      entity_type: string;
      entity_id: string;
      actor: string;
    }[];
    expect(rows.map((row) => JSON.parse(row.detail))).toEqual([{ added: 2, already: 0 }, { added: 1, already: 2 }]);
    for (const row of rows) {
      expect(row.entity_type).toBe('list');
      expect(row.detail).not.toMatch(/per_|Audit|Alpha|@example/);
    }
  });

  it('KILLS: list.member_remove rows carry counts only ({ removed: 1 }), like member_add, so no audit row ties a person to a list, even after the person is deleted', () => {
    const list = createList(env.ctx, { name: 'Audit remove' });
    const a = person('Audit', 'Remove');
    addListMembers(env.ctx, list.id, { personIds: [a.id] });
    removeListMember(env.ctx, list.id, a.id);
    const rows = audits('list.member_remove').filter((row) => row.entityId === list.id);
    expect(rows).toEqual([{ entityType: 'list', entityId: list.id, detail: { removed: 1 } }]);
    // Counts only: nothing about the person stays in the audit log once the person is deleted.
    env.db.prepare('DELETE FROM person WHERE id = ?').run(a.id);
    expect(audits('list.member_remove').filter((row) => row.entityId === list.id)[0]!.detail).toEqual({ removed: 1 });
  });

  it('ACCEPTED: list.create, list.update, and list.delete audit rows carry the list name (a user typed label, not a person field)', () => {
    const list = createList(env.ctx, { name: 'Named in audit' });
    updateList(env.ctx, list.id, { expectedVersion: 1, fields: { name: 'Renamed in audit' } });
    deleteList(env.ctx, list.id);
    const mine = (action: string) => audits(action).filter((row) => row.entityId === list.id).map((row) => row.detail);
    expect(mine('list.create')).toEqual([{ name: 'Named in audit' }]);
    expect(mine('list.update')).toEqual([{ from: 'Named in audit', to: 'Renamed in audit' }]);
    expect(mine('list.delete')).toEqual([{ name: 'Renamed in audit', members: 0 }]);
  });

  it('KILLS: a full add, remove, rename, delete workflow touches no person row, claim, activity, or person event', () => {
    const list = createList(env.ctx, { name: 'Untouched' });
    const people = [person('Untouched', 'A'), person('Untouched', 'B')];
    const tables = ['person', 'field_claim', 'activity', 'task', 'opportunity', 'qualification_result'];
    const snapshot = () => JSON.stringify(tables.map((table) => env.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    const before = snapshot();
    const eventsBefore = events.length;
    addListMembers(env.ctx, list.id, { personIds: people.map((entry) => entry.id) });
    removeListMember(env.ctx, list.id, people[0]!.id);
    updateList(env.ctx, list.id, { expectedVersion: versionOf(list.id), fields: { name: 'Untouched renamed' } });
    deleteList(env.ctx, list.id);
    expect(snapshot()).toBe(before);
    const fresh = events.slice(eventsBefore);
    expect(fresh.length).toBe(4);
    expect(fresh.every((event) => event.type === 'record_updated' && event.entityType === 'list' && event.entityId === list.id)).toBe(true);
  });
});
