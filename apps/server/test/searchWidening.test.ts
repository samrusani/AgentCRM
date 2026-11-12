import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createActivity,
  createMeeting,
  createOpportunity,
  createOrganization,
  createPerson,
  createTask,
  mergePeople,
  resetAllData,
  updateMeeting,
  updatePerson,
  updateTask,
} from '../src/actions/index.js';
import { applyMigrations, listMigrationFiles } from '../src/db.js';
import { migrationsDirectory, packageRoot } from '../src/paths.js';
import { buildSnippet, searchAll, searchScan } from '../src/queries/search.js';
import { createTestEnvironment, insertSecondWorkspace } from './helpers.js';

const env = createTestEnvironment();
afterAll(() => env.cleanup());

const count = (table: string) => (env.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const hits = (query: string, workspaceId = env.workspaceId) => searchAll(env.db, workspaceId, query);
const note = (entityType: string, entityId: string, body: string, kind = 'note') => {
  const activity = createActivity(env.ctx, { entityType, entityId, body, kind });
  return activity.id;
};
const start = '2026-04-01T10:00:00.000Z';

describe('migration 034 backfill', () => {
  it('indexes pre-existing notes (not other kinds), tasks, and meetings, and reseeds person_search with title', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of listMigrationFiles().filter((name) => name < '034')) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      const at = '2026-01-01';
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', at, 'One', 't');
      db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, title, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('per_1', at, 'wsp_1', 'Ada', 'Lovelace', 'Managing Partner', at);
      const insertActivity = db.prepare('INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insertActivity.run('act_1', at, 'wsp_1', 'person', 'per_1', 'note', 'Discussed the zeppelin budget', 'user');
      insertActivity.run('act_2', at, 'wsp_1', 'person', 'per_1', 'email_draft', 'Draft about zeppelin budget', 'agent');
      db.prepare('INSERT INTO task (id, created_at, workspace_id, title, updated_at) VALUES (?, ?, ?, ?, ?)').run('tsk_1', at, 'wsp_1', 'Send the quokka deck', at);
      db.prepare('INSERT INTO meeting (id, created_at, workspace_id, title, starts_at, location, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('mtg_1', at, 'wsp_1', 'Board sync', start, 'Lisbon office', 'Talk about narwhals', at);
      expect(applyMigrations(db)).toEqual(['034_search_widening.sql', '035_backblaze.sql', '036_contact_fields.sql', '037_crunchbase.sql']);

      const ids = (table: string, column: string, phrase: string) =>
        (db.prepare(`SELECT entity_id FROM ${table} WHERE ${table} MATCH ?`).all(`${column} : "${phrase}"`) as { entity_id: string }[]).map((row) => row.entity_id);
      expect(ids('activity_search', 'body', 'zeppelin')).toEqual(['act_1']);
      expect((db.prepare('SELECT COUNT(*) AS n FROM activity_search').get() as { n: number }).n).toBe(1);
      expect(ids('task_search', 'title', 'quokka')).toEqual(['tsk_1']);
      expect(ids('meeting_search', 'title', 'board')).toEqual(['mtg_1']);
      expect(ids('meeting_search', 'location', 'lisbon')).toEqual(['mtg_1']);
      expect(ids('meeting_search', 'notes', 'narwhal')).toEqual(['mtg_1']);
      expect(ids('person_search', 'title', 'partner')).toEqual(['per_1']);
      expect(ids('person_search', 'name', 'lovelace')).toEqual(['per_1']);
      const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_search_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
      expect(triggers).toEqual([
        'activity_search_delete', 'activity_search_insert', 'activity_search_update',
        'meeting_search_delete', 'meeting_search_insert', 'meeting_search_update',
        'opportunity_search_delete', 'opportunity_search_insert', 'opportunity_search_update',
        'organization_search_delete', 'organization_search_insert', 'organization_search_update',
        'person_search_delete', 'person_search_insert', 'person_search_update',
        'task_search_delete', 'task_search_insert', 'task_search_update',
      ]);
      const sql = (name: string) => (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string }).sql;
      expect(sql('person_search')).toContain('title');
      expect(sql('person_search_update')).toContain('first_name, last_name, email, title');
      expect(sql('activity_search_insert')).toContain("new.kind = 'note'");
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('triggers', () => {
  const idsOf = (table: string) => (env.db.prepare(`SELECT entity_id FROM ${table}`).all() as { entity_id: string }[]).map((row) => row.entity_id);
  const match = (table: string, column: string, phrase: string) =>
    (env.db.prepare(`SELECT entity_id FROM ${table} WHERE ${table} MATCH ?`).all(`${column} : "${phrase}"`) as { entity_id: string }[]).map((row) => row.entity_id);

  it('activity_search: note insert indexes, other kinds never, body update re-indexes, delete removes', () => {
    const person = createPerson(env.ctx, { firstName: 'Nora', lastName: 'Trigger' });
    const before = count('activity_search');
    const noteId = note('person', person.id, 'alpacas graze quietly');
    const draftId = note('person', person.id, 'alpacas in a draft', 'email_draft');
    note('person', person.id, 'alpacas by the agent', 'agent');
    env.db.prepare("INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES ('act_stage', '2026-03-01', ?, 'person', ?, 'stage_change', 'alpacas moved', 'user')").run(env.workspaceId, person.id);
    expect(count('activity_search')).toBe(before + 1);
    expect(match('activity_search', 'body', 'alpacas')).toEqual([noteId]);
    expect(idsOf('activity_search')).not.toContain(draftId);

    env.db.prepare('UPDATE activity SET body = ? WHERE id = ?').run('llamas graze quietly', noteId);
    expect(match('activity_search', 'body', 'alpacas')).toEqual([]);
    expect(match('activity_search', 'body', 'llamas')).toEqual([noteId]);
    expect(count('activity_search')).toBe(before + 1);

    // An update of another column does not touch the index.
    const rowid = (env.db.prepare('SELECT rowid AS r FROM activity WHERE id = ?').get(noteId) as { r: number }).r;
    env.db.prepare('UPDATE activity SET actor = ? WHERE id = ?').run('someone', noteId);
    expect(match('activity_search', 'body', 'llamas')).toEqual([noteId]);
    expect((env.db.prepare('SELECT rowid AS r FROM activity_search WHERE entity_id = ?').get(noteId) as { r: number }).r).toBe(rowid);

    // A draft body edit never lands in the index.
    env.db.prepare('UPDATE activity SET body = ? WHERE id = ?').run('vicunas', draftId);
    expect(match('activity_search', 'body', 'vicunas')).toEqual([]);

    env.db.prepare('DELETE FROM activity WHERE id = ?').run(noteId);
    env.db.prepare('DELETE FROM activity WHERE id = ?').run(draftId);
    expect(match('activity_search', 'body', 'llamas')).toEqual([]);
    expect(count('activity_search')).toBe(before);
  });

  it('task_search: insert, title update, other-column update, delete', () => {
    const before = count('task_search');
    const task = createTask(env.ctx, { title: 'Order wombat food' });
    expect(match('task_search', 'title', 'wombat')).toEqual([task.id]);
    updateTask(env.ctx, task.id, { expectedVersion: 1, fields: { title: 'Order platypus food' } });
    expect(match('task_search', 'title', 'wombat')).toEqual([]);
    expect(match('task_search', 'title', 'platypus')).toEqual([task.id]);
    updateTask(env.ctx, task.id, { expectedVersion: 2, fields: { status: 'done' } });
    expect(match('task_search', 'title', 'platypus')).toEqual([task.id]);
    expect(count('task_search')).toBe(before + 1);
    env.db.prepare('DELETE FROM task WHERE id = ?').run(task.id);
    expect(match('task_search', 'title', 'platypus')).toEqual([]);
    expect(count('task_search')).toBe(before);
  });

  it('meeting_search: insert, each indexed column, other-column update, delete', () => {
    const before = count('meeting_search');
    const meeting = createMeeting(env.ctx, { title: 'Ocelot review', startsAt: start, location: 'Harbour room' });
    expect(match('meeting_search', 'title', 'ocelot')).toEqual([meeting.id]);
    expect(match('meeting_search', 'location', 'harbour')).toEqual([meeting.id]);
    updateMeeting(env.ctx, meeting.id, { expectedVersion: 1, fields: { notes: 'bring the manatee report' } });
    expect(match('meeting_search', 'notes', 'manatee')).toEqual([meeting.id]);
    updateMeeting(env.ctx, meeting.id, { expectedVersion: 2, fields: { title: 'Lynx review', location: 'Dock room' } });
    expect(match('meeting_search', 'title', 'ocelot')).toEqual([]);
    expect(match('meeting_search', 'location', 'harbour')).toEqual([]);
    expect(match('meeting_search', 'title', 'lynx')).toEqual([meeting.id]);
    expect(match('meeting_search', 'notes', 'manatee')).toEqual([meeting.id]);
    env.db.prepare('UPDATE meeting SET ends_at = ? WHERE id = ?').run('2026-04-01T11:00:00.000Z', meeting.id);
    expect(match('meeting_search', 'title', 'lynx')).toEqual([meeting.id]);
    expect(count('meeting_search')).toBe(before + 1);
    env.db.prepare('DELETE FROM meeting WHERE id = ?').run(meeting.id);
    expect(count('meeting_search')).toBe(before);
  });

  it('person_search: title is indexed, updated, and the old name and email answers are unchanged', () => {
    const person = createPerson(env.ctx, { firstName: 'Tess', lastName: 'Titleson', email: 'tess@titles.example', title: 'Chief Gardener' });
    expect(match('person_search', 'title', 'gardener')).toEqual([person.id]);
    expect(hits('gardener').people.map((row) => row.id)).toEqual([person.id]);
    expect(hits('titleson').people.map((row) => row.id)).toEqual([person.id]);
    expect(hits('tess@titles').people.map((row) => row.id)).toEqual([person.id]);
    updatePerson(env.ctx, person.id, { expectedVersion: 1, fields: { title: 'Head Beekeeper' } });
    expect(hits('gardener').people).toEqual([]);
    expect(hits('beekeeper').people.map((row) => row.id)).toEqual([person.id]);
    // Both paths agree for a title match.
    expect(hits('bee').people.map((row) => row.id)).toEqual(searchScan(env.db, env.workspaceId, 'bee', 8).people.map((row) => row.id));
    expect(searchScan(env.db, env.workspaceId, 'be', 8).people.map((row) => row.id)).toContain(person.id);
  });
});

describe('notes, tasks, and meetings in search', () => {
  it('returns notes with a live parent name, newest first, and the unmatched kinds are absent', () => {
    const person = createPerson(env.ctx, { firstName: 'Una', lastName: 'Notely' });
    const org = createOrganization(env.ctx, { name: 'Notely Holdings' });
    const opp = createOpportunity(env.ctx, { name: 'Notely Deal', organizationId: org.id });
    const first = note('person', person.id, 'The capybara memo is ready');
    const second = note('organization', org.id, 'Another capybara memo');
    const third = note('opportunity', opp.id, 'Capybara pricing');
    note('person', person.id, 'capybara in a draft', 'email_draft');
    const found = hits('capybara').notes;
    expect(found.map((row) => row.id)).toEqual([third, second, first]);
    expect(found[0]).toEqual({ id: third, snippet: 'Capybara pricing', entityType: 'opportunity', entityId: opp.id, entityName: 'Notely Deal' });
    expect(found[1]).toMatchObject({ entityType: 'organization', entityName: 'Notely Holdings' });
    expect(found[2]).toMatchObject({ entityType: 'person', entityName: 'Una Notely' });
    // Scan path answers the same notes.
    expect(searchScan(env.db, env.workspaceId, 'capybara', 8).notes.map((row) => row.id)).toEqual([third, second, first]);
  });

  it('a re-pointed activity (person merge) answers with the survivor name; a deleted parent is skipped', () => {
    const survivor = createPerson(env.ctx, { firstName: 'Sam', lastName: 'Survivor' });
    const other = createPerson(env.ctx, { firstName: 'Sammy', lastName: 'Duplicate' });
    const id = note('person', other.id, 'the wolverine contract');
    expect(hits('wolverine').notes[0]).toMatchObject({ id, entityName: 'Sammy Duplicate' });
    mergePeople(env.ctx, survivor.id, { otherId: other.id, expectedVersion: survivor.version, otherExpectedVersion: other.version });
    expect(hits('wolverine').notes[0]).toMatchObject({ id, entityId: survivor.id, entityName: 'Sam Survivor' });

    const doomed = createPerson(env.ctx, { firstName: 'Del', lastName: 'Eted' });
    note('person', doomed.id, 'the pangolin proposal');
    env.db.pragma('foreign_keys = OFF');
    env.db.prepare('DELETE FROM person WHERE id = ?').run(doomed.id);
    env.db.pragma('foreign_keys = ON');
    expect(hits('pangolin').notes).toEqual([]);
    expect(searchScan(env.db, env.workspaceId, 'pangolin', 8).notes).toEqual([]);
  });

  it('tasks carry the parent name, or null fields when unlinked or the parent is gone', () => {
    const person = createPerson(env.ctx, { firstName: 'Tara', lastName: 'Tasker' });
    const linked = createTask(env.ctx, { title: 'Call the axolotl vet', entityType: 'person', entityId: person.id });
    const free = createTask(env.ctx, { title: 'Water the axolotl tank' });
    const found = hits('axolotl').tasks;
    expect(found).toEqual([
      { id: linked.id, title: 'Call the axolotl vet', entityType: 'person', entityId: person.id, entityName: 'Tara Tasker' },
      { id: free.id, title: 'Water the axolotl tank', entityType: null, entityId: null, entityName: null },
    ].sort((a, b) => a.title.localeCompare(b.title)));
    expect(searchScan(env.db, env.workspaceId, 'axolotl', 8).tasks).toEqual(found);
    // Prefix first.
    const prefixed = createTask(env.ctx, { title: 'Axolotl census' });
    expect(hits('axolotl').tasks[0]!.id).toBe(prefixed.id);
  });

  it('meetings answer id, title, startsAt only; match by title, location, or notes', () => {
    const meeting = createMeeting(env.ctx, { title: 'Gala planning', startsAt: start, location: 'Zanzibar hall' });
    updateMeeting(env.ctx, meeting.id, { expectedVersion: 1, fields: { notes: 'invite the flamingo caterer' } });
    for (const query of ['gala', 'zanzibar', 'flamingo']) {
      expect(hits(query).meetings).toEqual([{ id: meeting.id, title: 'Gala planning', startsAt: start }]);
    }
  });

  it('the 2 character scan path answers all three new groups', () => {
    const person = createPerson(env.ctx, { firstName: 'Xy', lastName: 'Short' });
    note('person', person.id, 'qz note text');
    createTask(env.ctx, { title: 'qz task' });
    createMeeting(env.ctx, { title: 'qz meeting', startsAt: start });
    const found = hits('qz');
    expect(found.notes).toHaveLength(1);
    expect(found.tasks).toHaveLength(1);
    expect(found.meetings).toHaveLength(1);
  });

  it('caps each group at 8', () => {
    const person = createPerson(env.ctx, { firstName: 'Max', lastName: 'Limits' });
    for (let n = 0; n < 12; n += 1) {
      note('person', person.id, `okapi note ${n}`);
      createTask(env.ctx, { title: `okapi task ${n}` });
      createMeeting(env.ctx, { title: `okapi meeting ${n}`, startsAt: start });
    }
    const found = hits('okapi');
    expect([found.notes.length, found.tasks.length, found.meetings.length]).toEqual([8, 8, 8]);
    const scan = searchScan(env.db, env.workspaceId, 'okapi', 8);
    expect(scan.notes.map((row) => row.id)).toEqual(found.notes.map((row) => row.id));
  });

  it('filters every group by workspace', () => {
    const other = insertSecondWorkspace(env.db);
    const at = '2026-03-02T00:00:00.000Z';
    env.db.prepare("INSERT INTO person (id, created_at, workspace_id, first_name, last_name, updated_at) VALUES ('per_other', ?, ?, 'Oz', 'Other', ?)").run(at, other, at);
    env.db.prepare("INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES ('act_other', ?, ?, 'person', 'per_other', 'note', 'tapir secret', 'user')").run(at, other);
    env.db.prepare("INSERT INTO task (id, created_at, workspace_id, title, updated_at) VALUES ('tsk_other', ?, ?, 'tapir task', ?)").run(at, other, at);
    env.db.prepare("INSERT INTO meeting (id, created_at, workspace_id, title, starts_at, updated_at) VALUES ('mtg_other', ?, ?, 'tapir meeting', ?, ?)").run(at, other, start, at);
    for (const query of ['tapir', 'ta']) {
      const mine = hits(query);
      expect(JSON.stringify([mine.notes, mine.tasks, mine.meetings])).not.toContain('tapir secret');
      expect(mine.tasks.map((row) => row.id)).not.toContain('tsk_other');
      expect(mine.meetings.map((row) => row.id)).not.toContain('mtg_other');
    }
    const theirs = hits('tapir', other);
    expect([theirs.notes.length, theirs.tasks.length, theirs.meetings.length]).toEqual([1, 1, 1]);
  });

  it('NUL and 257 character queries return every group empty', () => {
    for (const query of ['okapi\0', 'x'.repeat(257)]) {
      expect(hits(query)).toEqual({ people: [], organizations: [], opportunities: [], notes: [], tasks: [], meetings: [] });
    }
    expect(hits('   ')).toEqual({ people: [], organizations: [], opportunities: [], notes: [], tasks: [], meetings: [] });
    expect(hits('x'.repeat(256)).notes).toEqual([]);
  });
});

describe('buildSnippet', () => {
  it('cuts at most 120 characters around a match in the middle of a 5000 character note', () => {
    const body = `${'lorem ipsum '.repeat(200)}NEEDLEWORD${' dolor sit '.repeat(200)}`;
    const snippet = buildSnippet(body, 'needleword');
    expect(snippet.length).toBeLessThanOrEqual(120);
    expect(snippet).toContain('NEEDLEWORD');
  });

  it('strips zero width characters, collapses newlines, and keeps short bodies whole', () => {
    expect(buildSnippet('one​\ntwo\r\n\r\nthree﻿', 'two')).toBe('one two three');
    const long = `${'a\nb '.repeat(80)}target${' c\nd'.repeat(80)}`;
    const snippet = buildSnippet(long, 'target');
    expect(snippet).not.toMatch(/[\r\n]/);
    expect(snippet.length).toBeLessThanOrEqual(120);
    expect(snippet).toContain('target');
  });

  it('never splits an emoji at either edge, for every offset', () => {
    for (let pad = 0; pad < 6; pad += 1) {
      const body = `${'😀'.repeat(150 + pad)}needle${'😀'.repeat(150 + pad)}`;
      const snippet = buildSnippet(body, 'needle');
      expect(snippet).toContain('needle');
      expect(snippet.length).toBeLessThanOrEqual(120);
      expect(snippet).not.toMatch(/(^|[^\ud800-\udbff])[\udc00-\udfff]/);
      expect(snippet).not.toMatch(/[\ud800-\udbff]($|[^\udc00-\udfff])/);
    }
  });

  it('is plain text: hostile markup passes through unchanged', () => {
    expect(buildSnippet('<img src=x onerror=alert(1)> kangaroo', 'kangaroo')).toBe('<img src=x onerror=alert(1)> kangaroo');
  });
});

describe('reset', () => {
  it('leaves every search index empty after resetAllData', () => {
    const person = createPerson(env.ctx, { firstName: 'Rae', lastName: 'Setter', title: 'Reset Lead' });
    note('person', person.id, 'a note to wipe');
    createTask(env.ctx, { title: 'a task to wipe' });
    createMeeting(env.ctx, { title: 'a meeting to wipe', startsAt: start });
    for (const table of ['person_search', 'activity_search', 'task_search', 'meeting_search']) expect(count(table)).toBeGreaterThan(0);
    resetAllData(env.db);
    for (const table of ['person_search', 'organization_search', 'opportunity_search', 'activity_search', 'task_search', 'meeting_search']) {
      expect(count(table)).toBe(0);
    }
  });
});

describe('crm_search over MCP', () => {
  it('returns the new groups and names them in the description; read only', async () => {
    const e = createTestEnvironment();
    try {
      const person = createPerson(e.ctx, { firstName: 'Mia', lastName: 'Mcp' });
      createActivity(e.ctx, { entityType: 'person', entityId: person.id, body: 'the mongoose agenda' });
      createTask(e.ctx, { title: 'Feed the mongoose' });
      createMeeting(e.ctx, { title: 'Mongoose sync', startsAt: start });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), 'mcp'],
        cwd: packageRoot,
        env: { ...(process.env as Record<string, string>), AGENTCRM_DB: e.databasePath },
        stderr: 'ignore',
      });
      const client = new Client({ name: 'widening-test', version: '1.0.0' });
      await client.connect(transport);
      try {
        const tool = (await client.listTools()).tools.find((entry) => entry.name === 'crm_search')!;
        expect(tool.description).toContain('people, organizations, opportunities, meetings, tasks, and notes');
        expect(tool.annotations?.readOnlyHint).toBe(true);
        const result = await client.callTool({ name: 'crm_search', arguments: { query: 'mongoose' } });
        const parsed = JSON.parse((result.content as { text: string }[])[0]!.text);
        expect(Object.keys(parsed).sort()).toEqual(['meetings', 'notes', 'opportunities', 'organizations', 'people', 'tasks']);
        expect(parsed.notes[0]).toMatchObject({ snippet: 'the mongoose agenda', entityType: 'person', entityName: 'Mia Mcp' });
        expect(parsed.tasks[0]).toMatchObject({ title: 'Feed the mongoose' });
        expect(parsed.meetings[0]).toMatchObject({ title: 'Mongoose sync', startsAt: start });
        const only = await client.callTool({ name: 'crm_search', arguments: { query: 'mongoose', type: 'notes' } });
        expect(Object.keys(JSON.parse((only.content as { text: string }[])[0]!.text))).toEqual(['notes']);
      } finally {
        await client.close();
      }
    } finally {
      e.cleanup();
    }
  }, 40_000);
});
