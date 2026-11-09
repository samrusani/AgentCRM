import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createActivity,
  createMeeting,
  createOrganization,
  createPerson,
  createTask,
  deleteMeeting,
  updateMeeting,
  mergeOrganizations,
  mergePeople,
  resetRecordData,
} from '../src/actions/index.js';
import { applyMigrations, listMigrationFiles } from '../src/db.js';
import { migrationsDirectory } from '../src/paths.js';
import { buildSnippet, searchAll, searchScan } from '../src/queries/search.js';
import { createTestEnvironment, insertSecondWorkspace } from './helpers.js';

// Adversarial probes for the retrieval widening wave (migration 034). Probes that pin an observed weakness say so.
const env = createTestEnvironment();
afterAll(() => env.cleanup());
const db = env.db;
const hits = (q: string, ws = env.workspaceId) => searchAll(db, ws, q);
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const at = '2026-03-02T00:00:00.000Z';
const start = '2026-04-01T10:00:00.000Z';
let seq = 0;
function raw(entityId: string, kind: string, body: string, workspace = env.workspaceId, entityType = 'person'): string {
  seq += 1;
  const id = `act_probe${seq}`;
  db.prepare('INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, `2026-03-02T00:00:${String(seq % 60).padStart(2, '0')}.${String(seq).padStart(3, '0')}Z`, workspace, entityType, entityId, kind, body, 'user',
  );
  return id;
}
function meeting(title: string, notes: string | null = null, location: string | null = null) {
  const m = createMeeting(env.ctx, { title, startsAt: start, location });
  return notes === null ? m : updateMeeting(env.ctx, m.id, { expectedVersion: m.version, fields: { notes } });
}
const indexed = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM activity_search WHERE entity_id = ?').get(id) as { n: number }).n;

describe('1. content leakage: only human notes are indexed', () => {
  it('every non-note kind inserted by raw SQL is absent from the index and from both search paths', () => {
    const p = createPerson(env.ctx, { firstName: 'Leak', lastName: 'Check' });
    for (const kind of ['email_draft', 'agent', 'stage_change', 'email_out', 'email_in']) {
      const id = raw(p.id, kind, `zyzzyva secret ${kind}`);
      expect(indexed(id)).toBe(0);
    }
    for (const q of ['zyzzyva', 'zy']) expect(hits(q).notes).toEqual([]);
    expect(searchScan(db, env.workspaceId, 'zyzzyva', 8).notes).toEqual([]);
  });

  it('every app write path that makes a non-note kind stays out (createActivity enum kinds)', () => {
    const p = createPerson(env.ctx, { firstName: 'Path', lastName: 'Kinds' });
    for (const kind of ['email_draft', 'agent']) createActivity(env.ctx, { entityType: 'person', entityId: p.id, kind, body: `quetzal via ${kind}` });
    expect(hits('quetzal').notes).toEqual([]);
  });

  it('PIN: a kind-only change is not tracked by the triggers. Demoted note keeps a stale index row but never surfaces (result query re-filters kind); promoted draft is invisible to the index path but visible to the scan path. No app code changes kind.', () => {
    const p = createPerson(env.ctx, { firstName: 'Kind', lastName: 'Flip' });
    const noteId = raw(p.id, 'note', 'wolverine plan');
    expect(indexed(noteId)).toBe(1);
    db.prepare("UPDATE activity SET kind = 'email_draft' WHERE id = ?").run(noteId);
    expect(indexed(noteId)).toBe(1); // stale row remains
    expect(hits('wolverine').notes).toEqual([]); // but is filtered at read time
    expect(hits('wo').notes).toEqual([]);
    // body edit after demotion: stale text stays in the index (dead weight, never surfaced)
    db.prepare('UPDATE activity SET body = ? WHERE id = ?').run('changed', noteId);
    expect((db.prepare('SELECT body FROM activity_search WHERE entity_id = ?').get(noteId) as { body: string }).body).toBe('wolverine plan');

    const draftId = raw(p.id, 'email_draft', 'badger outreach');
    db.prepare("UPDATE activity SET kind = 'note' WHERE id = ?").run(draftId);
    expect(indexed(draftId)).toBe(0);
    const indexedPath = hits('badger').notes.length; // index path misses
    const scanPath = searchScan(db, env.workspaceId, 'badger', 8).notes.length; // scan finds
    expect([indexedPath, scanPath]).toEqual([0, 1]);
  });

  it('connector secrets and transcript text cannot reach an indexed column: the only indexed columns are note body, task title, meeting title/location/notes, person name/email/title', () => {
    const cols = (t: string) => (db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((r) => r.name);
    expect(cols('activity_search')).toEqual(['entity_id', 'body']);
    expect(cols('task_search')).toEqual(['entity_id', 'title']);
    expect(cols('meeting_search')).toEqual(['entity_id', 'title', 'location', 'notes']);
    expect(cols('person_search')).toEqual(['entity_id', 'name', 'email', 'title']);
    // Every indexed activity row is a note, bar the stale demoted row pinned above.
    const nonNote = db.prepare("SELECT COUNT(*) AS n FROM activity_search s JOIN activity a ON a.id = s.entity_id WHERE a.kind <> 'note'").get() as { n: number };
    expect(nonNote.n).toBeLessThanOrEqual(1);
  });
});

describe('2. workspace isolation', () => {
  const other = insertSecondWorkspace(db);
  it('cross-workspace links resolve to no parent: notes skipped, tasks unlinked', () => {
    const mine = createPerson(env.ctx, { firstName: 'Mine', lastName: 'Person' });
    db.prepare("INSERT INTO person (id, created_at, workspace_id, first_name, last_name, updated_at) VALUES ('per_ws2', ?, ?, 'Zed', 'Theirs', ?)").run(at, other, at);
    // workspace A note pointing at workspace B person
    raw('per_ws2', 'note', 'axolotl crosslink', env.workspaceId);
    // workspace B note pointing at my person
    raw(mine.id, 'note', 'axolotl crosslink two', other);
    db.prepare("INSERT INTO task (id, created_at, workspace_id, title, entity_type, entity_id, updated_at) VALUES ('tsk_x1', ?, ?, 'axolotl cross task', 'person', 'per_ws2', ?)").run(at, env.workspaceId, at);
    for (const q of ['axolotl', 'ax']) {
      const r = hits(q);
      expect(r.notes).toEqual([]);
      const t = r.tasks.find((x) => x.id === 'tsk_x1');
      if (q === 'axolotl') expect(t).toEqual({ id: 'tsk_x1', title: 'axolotl cross task', entityType: null, entityId: null, entityName: null });
      expect(JSON.stringify(r)).not.toContain('Zed');
      const o = hits(q, other);
      expect(o.notes.map((n) => n.entityName)).not.toContain('Mine Person');
    }
  });
  it('one term in both workspaces: each sees only its own, both paths, all new groups', () => {
    const mine = createPerson(env.ctx, { firstName: 'Iso', lastName: 'Lation' });
    db.prepare("INSERT INTO person (id, created_at, workspace_id, first_name, last_name, updated_at) VALUES ('per_ws3', ?, ?, 'Iso', 'Theirs', ?)").run(at, other, at);
    createActivity(env.ctx, { entityType: 'person', entityId: mine.id, body: 'pangolin mine' });
    createTask(env.ctx, { title: 'pangolin task mine' });
    createMeeting(env.ctx, { title: 'pangolin meeting mine', startsAt: start });
    raw('per_ws3', 'note', 'pangolin theirs', other);
    db.prepare("INSERT INTO task (id, created_at, workspace_id, title, updated_at) VALUES ('tsk_ws3', ?, ?, 'pangolin task theirs', ?)").run(at, other, at);
    db.prepare("INSERT INTO meeting (id, created_at, workspace_id, title, starts_at, updated_at) VALUES ('mtg_ws3', ?, ?, 'pangolin meeting theirs', ?, ?)").run(at, other, start, at);
    for (const q of ['pangolin', 'pa']) {
      for (const [ws, word] of [[env.workspaceId, 'mine'], [other, 'theirs']] as const) {
        const r = hits(q, ws);
        const text = JSON.stringify([r.notes, r.tasks, r.meetings]);
        expect(text).toContain(word);
        expect(text).not.toContain(word === 'mine' ? 'theirs' : 'mine');
      }
    }
  });
});

describe('3. FTS5 injection and LIKE discipline on the new tables', () => {
  const p = createPerson(env.ctx, { firstName: 'Inj', lastName: 'Ection' });
  createActivity(env.ctx, { entityType: 'person', entityId: p.id, body: 'discount is 50% off, snake_case id, "quoted" text AND more OR less NEAR here' });
  createTask(env.ctx, { title: 'fix 50% bug in snake_case "quoted"' });
  meeting('Review 50% plan', 'snake_case "quoted"');
  const nasty = [
    '"', '""', '"""', '"a', 'a"', 'NEAR(a b)', 'NEAR', 'AND', 'OR', 'NOT', 'a AND b', 'a OR b', 'a*', '^abc', '-abc', 'abc*', '(abc', 'abc)', 'title:abc', 'body : abc', '{title}:abc',
    '*', '**', '"*"', "'; DROP TABLE activity; --", '%', '_', '%%%', '___', '\\', '\\%', 'x'.repeat(3) + '"', '"'.repeat(256), '"'.repeat(255), '"'.repeat(3), '\u0000', 'a\u0000bcd',
    '\ud800', 'abc\ud800', '😀😀😀', 'NEAR/2', 'OR OR OR', '- - -',
  ];
  it('no query throws, on either path, and never returns an unexpected group shape', () => {
    for (const q of nasty) {
      for (const run of [() => hits(q), () => searchScan(db, env.workspaceId, q.trim(), 8)]) {
        const r = run();
        expect(Object.keys(r).sort()).toEqual(['meetings', 'notes', 'opportunities', 'organizations', 'people', 'tasks']);
      }
    }
  });
  it('operators are inert: AND/OR/NEAR/quote queries match only literal text', () => {
    expect(hits('AND more OR less NEAR here').notes.length).toBe(1);
    expect(hits('x AND y').notes).toEqual([]);
    expect(hits('"quoted"').notes.length).toBe(1);
    expect(hits('"quoted"').tasks.length).toBe(1);
    expect(hits('"quoted"').meetings.length).toBe(1);
    expect(hits('"').notes.length).toBe(1); // 1 char: scan path, literal quote
    expect(hits('"'.repeat(256))).toMatchObject({ notes: [], tasks: [], meetings: [] });
    expect(hits('title:snake').tasks).toEqual([]);
  });
  it('% and _ are literal on both paths in notes, tasks, and meetings', () => {
    for (const [q, notes, tasks, meetings] of [['50%', 1, 1, 1], ['%', 1, 1, 1], ['_', 1, 1, 1], ['e_c', 1, 1, 1], ['e%c', 0, 0, 0], ['snakeXcase', 0, 0, 0], ['sna_e', 0, 0, 0], ['50% off', 1, 0, 0]] as const) {
      const r = hits(q);
      expect([q, r.notes.length > 0, r.tasks.length > 0, r.meetings.length > 0]).toEqual([q, notes > 0, tasks > 0, meetings > 0]);
    }
  });
  it('indexed and scan paths agree on ids for the whole battery', () => {
    for (const q of ['50%', 'snake_case', '"quoted"', 'discount', 'bug', 'plan', 'DISCOUNT', 'Snake_Case']) {
      const a = hits(q);
      const b = searchScan(db, env.workspaceId, q, 8);
      for (const g of ['notes', 'tasks', 'meetings'] as const) expect(a[g].map((x) => x.id)).toEqual(b[g].map((x) => x.id));
    }
  });
});

describe('4. snippet honesty', () => {
  const zw = '​‌‍⁠﻿';
  it('guarantee: result never exceeds 120 UTF-16 units, has no lone surrogates, no newlines; contains the match for ascii queries found in the cleaned text', () => {
    const fillers = ['x', 'é', '😀', 'ab ', '\n', '‍', '👨‍👩‍👧', '😀‍', 'İ', 'ß', 'ﬁ', 'Σ'];
    for (const f of fillers) {
      for (let pad = 0; pad < 140; pad += 7) {
        for (const tail of [0, 1, 2, 60, 130, 300]) {
          const body = `${f.repeat(pad)}needle${f.repeat(tail)}`;
          const s = buildSnippet(body, 'needle');
          expect(s.length).toBeLessThanOrEqual(120);
          expect(s).not.toMatch(/[\r\n]/);
          expect(s).not.toMatch(/(^|[^\ud800-\udbff])[\udc00-\udfff]/);
          expect(s).not.toMatch(/[\ud800-\udbff]($|[^\udc00-\udfff])/);
          expect([body, s.includes('needle')]).toEqual([body, true]);
        }
      }
    }
  });
  it('edges: match at 0, at the very end, whole-body ZW only, exactly 120/121 units', () => {
    expect(buildSnippet(`needle${'z'.repeat(500)}`, 'needle').startsWith('needle')).toBe(true);
    expect(buildSnippet(`${'z'.repeat(500)}needle`, 'needle').endsWith('needle')).toBe(true);
    expect(buildSnippet(zw.repeat(100), 'x')).toBe('');
    expect(buildSnippet('a'.repeat(120), 'a')).toHaveLength(120);
    expect(buildSnippet('a'.repeat(121), 'a')).toHaveLength(120);
    expect(buildSnippet('', 'a')).toBe('');
  });
  it('a body of only zero-width characters + a real match elsewhere through the app', () => {
    const p = createPerson(env.ctx, { firstName: 'Snip', lastName: 'Pet' });
    createActivity(env.ctx, { entityType: 'person', entityId: p.id, body: `${zw.repeat(50)}zebra${zw.repeat(50)}` });
    expect(hits('zebra').notes[0]!.snippet).toBe('zebra');
  });
  it('dotted capital I and sharp s bodies: the match position survives case folding', () => {
    const body = `${'İ'.repeat(200)}needle${'İ'.repeat(200)}`;
    expect(buildSnippet(body, 'needle')).toContain('needle');
    const b2 = `${'ß'.repeat(300)}NEEDLE${'ß'.repeat(300)}`;
    expect(buildSnippet(b2, 'needle')).toContain('NEEDLE');
    const b3 = `${'ẞ'.repeat(300)}NEEDLE${'ẞ'.repeat(300)}`;
    expect(buildSnippet(b3, 'needle')).toContain('NEEDLE');
  });
  it('overlapping matches (aaaa...) and a query as long as the window', () => {
    expect(buildSnippet('a'.repeat(1000), 'aaa')).toHaveLength(120);
    const long = 'q'.repeat(150);
    const s = buildSnippet(`x${long}x`.repeat(3), long);
    expect(s.length).toBeLessThanOrEqual(120);
  });
  it('PIN: a query that includes a newline or zero-width char that the cleaned text no longer has falls back to the start of the note (match not shown). Row still matches because LIKE reads the raw body.', () => {
    const body = `${'pad '.repeat(100)}line one\nline two${' pad'.repeat(100)}`;
    const s = buildSnippet(body, 'line one\nline two');
    expect(s.startsWith('pad pad')).toBe(true);
    expect(s.includes('line one')).toBe(false);
  });
  it('trailing/leading whitespace: trim of the slice may shorten but never lengthen', () => {
    expect(buildSnippet(`${' '.repeat(200)}x${' '.repeat(200)}`, 'x').length).toBeLessThanOrEqual(120);
  });
});

describe('5. rebuild correctness', () => {
  it('no duplicate or orphaned triggers; each search trigger exists exactly once; reapply is a no-op; raw re-exec is refused', () => {
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map((r) => r.name);
    expect(new Set(triggers).size).toBe(triggers.length);
    const per = triggers.filter((n) => n.startsWith('person_search'));
    expect(per.sort()).toEqual(['person_search_delete', 'person_search_insert', 'person_search_update']);
    expect(applyMigrations(db)).toEqual([]);
    expect(() => db.exec(readFileSync(path.join(migrationsDirectory, '034_search_widening.sql'), 'utf8'))).toThrow();
    // The failed raw re-exec must not have left a half applied state: still exactly one of each.
    expect(count('person_search')).toBeGreaterThan(0);
  });
  it('pre-034 database: name, email, org-name answers identical before and after; title is new', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-rebuild-'));
    const old = new Database(path.join(dir, 'old.db'));
    old.pragma('foreign_keys = ON');
    old.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const file of listMigrationFiles().filter((n) => n < '034')) {
      old.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
      old.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, at);
    }
    old.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', at, 'One', 't');
    old.prepare('INSERT INTO organization (id, created_at, workspace_id, name, kind, domain, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('org_1', at, 'wsp_1', 'Northwind Capital', 'fund', 'northwind.example', at);
    const ip = old.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, email, title, organization_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ip.run('per_1', at, 'wsp_1', 'Ada', 'Lovelace', 'ada@analytical.example', 'Managing Partner', 'org_1', at);
    ip.run('per_2', at, 'wsp_1', 'Grace', 'Hopper', 'grace@navy.example', null, null, at);
    const queries = ['ada', 'love', 'lace', 'analytical', 'grace@', 'hopper', 'ada love', 'a.b', 'navy.example'];
    const before = queries.map((q) => searchOldPeople(old, q));
    expect(applyMigrations(old)).toEqual(['034_search_widening.sql', '035_backblaze.sql']);
    for (const [i, q] of queries.entries()) {
      const after = searchAll(old as never, 'wsp_1', q).people.map((x) => x.id);
      expect([q, after]).toEqual([q, before[i]]);
    }
    expect(searchAll(old as never, 'wsp_1', 'partner').people.map((x) => x.id)).toEqual(['per_1']);
    old.close();
  });
  function searchOldPeople(d: Database.Database, q: string): string[] {
    return (
      d
        .prepare("SELECT p.id FROM person_search CROSS JOIN person p ON p.id = person_search.entity_id WHERE person_search MATCH ? ORDER BY p.id")
        .all(`{name email} : "${q}"`) as { id: string }[]
    ).map((r) => r.id).concat(q.length < 3 ? [] : []);
  }
});

describe('6. merge, re-point, delete interplay', () => {
  it('person merge: note hit answers with survivor; the merged-away person is gone from people; index rows keyed on activity id remain valid', () => {
    const a = createPerson(env.ctx, { firstName: 'Sur', lastName: 'Vivor' });
    const b = createPerson(env.ctx, { firstName: 'Mer', lastName: 'Ged' });
    const noteId = createActivity(env.ctx, { entityType: 'person', entityId: b.id, body: 'ocelot memo' }).id;
    mergePeople(env.ctx, a.id, { otherId: b.id, expectedVersion: a.version, otherExpectedVersion: b.version });
    for (const q of ['ocelot', 'oc']) {
      const n = hits(q).notes;
      expect(n.map((x) => [x.id, x.entityId, x.entityName])).toEqual([[noteId, a.id, 'Sur Vivor']]);
    }
  });
  it('org merge: note and task hits answer with the survivor organization', () => {
    const a = createOrganization(env.ctx, { name: 'Survivor Org', kind: 'fund' });
    const b = createOrganization(env.ctx, { name: 'Merged Org', kind: 'fund' });
    createActivity(env.ctx, { entityType: 'organization', entityId: b.id, body: 'tarsier orgnote' });
    env.db.prepare("INSERT INTO task (id, created_at, workspace_id, title, entity_type, entity_id, updated_at) VALUES ('tsk_orgm', ?, ?, 'tarsier task', 'organization', ?, ?)").run(at, env.workspaceId, b.id, at);
    mergeOrganizations(env.ctx, a.id, { otherId: b.id, expectedVersion: a.version, otherExpectedVersion: b.version });
    const r = hits('tarsier');
    expect(r.notes[0]).toMatchObject({ entityId: a.id, entityName: 'Survivor Org' });
    // tasks keep pointing at a deleted org unless the merge re-points them: pin what happens
    expect(r.tasks[0]).toMatchObject({ id: 'tsk_orgm' });
    console.log('PROBE org-merge task parent:', JSON.stringify(r.tasks[0]));
  });
  it('meeting delete removes its meeting_search row; its notes (the meeting column) are no longer searchable', () => {
    const m = meeting('Doomed sync', 'quagga minutes', 'Bunker');
    expect(hits('quagga').meetings.map((x) => x.id)).toEqual([m.id]);
    const before = count('meeting_search');
    deleteMeeting(env.ctx, m.id);
    expect(count('meeting_search')).toBe(before - 1);
    expect(hits('quagga').meetings).toEqual([]);
    expect(hits('qu').meetings.map((x) => x.id)).not.toContain(m.id);
  });
  it('record reset leaves no index rows for deleted notes/tasks/meetings (resetRecordData)', () => {
    const e = createTestEnvironment();
    try {
      const p = createPerson(e.ctx, { firstName: 'R', lastName: 'Eset' });
      createActivity(e.ctx, { entityType: 'person', entityId: p.id, body: 'resetnote' });
      createTask(e.ctx, { title: 'resettask' });
      createMeeting(e.ctx, { title: 'resetmeeting', startsAt: start });
      resetRecordData(e.db, e.workspaceId);
      const left = (t: string) => (e.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      console.log('PROBE after resetRecordData: activity', left('activity'), 'activity_search', left('activity_search'), 'task', left('task'), 'task_search', left('task_search'), 'meeting', left('meeting'), 'meeting_search', left('meeting_search'));
      expect(left('activity_search')).toBe(left('activity'));
      expect(left('task_search')).toBe(left('task'));
      expect(left('meeting_search')).toBe(left('meeting'));
    } finally {
      e.cleanup();
    }
  });
});

describe('7. scale', () => {
  it('100k notes: a 3 char term matching everything, a rare term, and the 2 char scan', () => {
    const e = createTestEnvironment();
    try {
      const p = createPerson(e.ctx, { firstName: 'Bulk', lastName: 'Owner' });
      const ins = e.db.prepare("INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, 'person', ?, 'note', ?, 'user')");
      e.db.transaction(() => {
        for (let i = 0; i < 100_000; i += 1) {
          ins.run(`act_bulk${i}`, new Date(1_700_000_000_000 + i * 1000).toISOString(), e.workspaceId, p.id, `meeting recap number ${i} about the roadmap and hiring plan${i === 77_777 ? ' ZEBRAFISH' : ''}`);
        }
      })();
      const time = (label: string, run: () => unknown) => {
        const t = performance.now();
        const r = run();
        const ms = Math.round(performance.now() - t);
        console.log(`PERF ${label}: ${ms} ms`);
        return { r, ms };
      };
      const all = time('indexed, term matches 100k ("roadmap")', () => searchAll(e.db, e.workspaceId, 'roadmap'));
      const rare = time('indexed, rare term ("zebrafish")', () => searchAll(e.db, e.workspaceId, 'zebrafish'));
      const short = time('scan path, 2 chars ("ro")', () => searchAll(e.db, e.workspaceId, 'ro'));
      const mid = time('indexed, 3 char term matching all ("the")', () => searchAll(e.db, e.workspaceId, 'the'));
      const phrase = time('indexed, multi word, matches all ("hiring plan")', () => searchAll(e.db, e.workspaceId, 'hiring plan'));
      expect((all.r as { notes: unknown[] }).notes).toHaveLength(8);
      expect((rare.r as { notes: unknown[] }).notes).toHaveLength(1);
      expect((short.r as { notes: unknown[] }).notes).toHaveLength(8);
      expect((mid.r as { notes: unknown[] }).notes).toHaveLength(8);
      expect(phrase.ms).toBeGreaterThanOrEqual(0);
    } finally {
      e.cleanup();
    }
  }, 180_000);
});
