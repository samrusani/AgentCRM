import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMeetingAttendee,
  createMeeting,
  createOpportunity,
  createOrganization,
  createPerson,
  deleteMeeting,
  mergeOrganizations,
  mergePeople,
  removeMeetingAttendee,
  resetRecordData,
  updateMeeting,
} from '../src/actions/index.js';
import { applyMigrations, listMigrationFiles } from '../src/db.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { migrationsDirectory } from '../src/paths.js';
import { getMeeting, listMeetings } from '../src/queries/meetings.js';
import { createTestEnvironment, insertSecondWorkspace } from './helpers.js';

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

beforeEach(() => {
  resetRecordData(env.db);
  events.length = 0;
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
const person = (firstName: string, lastName = 'Meeter') => createPerson(env.ctx, { firstName, lastName });
const org = (name: string) => createOrganization(env.ctx, { name, kind: 'company' } as never);
const attendeeIds = (meetingId: string) =>
  (env.db.prepare('SELECT person_id FROM meeting_attendee WHERE meeting_id = ? ORDER BY person_id').all(meetingId) as { person_id: string }[]).map((row) => row.person_id);
const meetingEvents = (type: string) => events.filter((event) => event.type === type && (event as { entityType: string }).entityType === 'meeting');
const start = '2026-04-01T10:00:00.000Z';
const meet = (extra: Record<string, unknown> = {}) => createMeeting(env.ctx, { title: 'Intro call', startsAt: start, ...extra });

describe('migration 033', () => {
  it('creates both tables and the indexes, and cascades from both sides', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of listMigrationFiles().filter((name) => name < '033')) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'One', 't');
      db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('per_1', '2026-01-01', 'wsp_1', 'Ada', 'Lovelace', '2026-01-01');
      expect(applyMigrations(db)).toEqual(['033_meetings.sql', '034_search_widening.sql', '035_backblaze.sql', '036_contact_fields.sql', '037_crunchbase.sql']);
      db.prepare('INSERT INTO meeting (id, created_at, workspace_id, title, starts_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('mtg_1', '2026-01-02', 'wsp_1', 'Call', '2026-02-01T00:00:00.000Z', '2026-01-02');
      expect(db.prepare('SELECT version, ends_at, notes, organization_id FROM meeting').get()).toEqual({ version: 1, ends_at: null, notes: null, organization_id: null });
      db.prepare('INSERT INTO meeting_attendee (meeting_id, person_id, created_at) VALUES (?, ?, ?)').run('mtg_1', 'per_1', '2026-01-02');
      expect(() => db.prepare('INSERT INTO meeting_attendee (meeting_id, person_id, created_at) VALUES (?, ?, ?)').run('mtg_1', 'per_1', '2026-01-03')).toThrow(/UNIQUE|PRIMARY/);
      expect(() => db.prepare('INSERT INTO meeting_attendee (meeting_id, person_id, created_at) VALUES (?, ?, ?)').run('mtg_1', 'per_nope', '2026-01-03')).toThrow(/FOREIGN KEY/);
      expect(() => db.prepare('INSERT INTO meeting (id, created_at, workspace_id, title, starts_at, organization_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('mtg_2', '2026-01-02', 'wsp_1', 'X', '2026-02-01', 'org_nope', '2026-01-02')).toThrow(/FOREIGN KEY/);
      const columns = (name: string) => (db.pragma(`index_info(${name})`) as { name: string }[]).map((column) => column.name);
      expect(columns('idx_meeting_starts')).toEqual(['workspace_id', 'starts_at']);
      expect(columns('idx_meeting_attendee_person')).toEqual(['person_id']);

      db.prepare('DELETE FROM person WHERE id = ?').run('per_1');
      expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_attendee').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM meeting').get()).toEqual({ n: 1 });
      db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('per_2', '2026-01-01', 'wsp_1', 'Grace', 'Hopper', '2026-01-01');
      db.prepare('INSERT INTO meeting_attendee (meeting_id, person_id, created_at) VALUES (?, ?, ?)').run('mtg_1', 'per_2', '2026-01-02');
      db.prepare('DELETE FROM meeting WHERE id = ?').run('mtg_1');
      expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_attendee').get()).toEqual({ n: 0 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('createMeeting', () => {
  it('creates with a trimmed title, audits, and emits for the meeting', () => {
    const p = person('Ada');
    const o = org('Quillan');
    const opp = createOpportunity(env.ctx, { name: 'Seed round', organizationId: o.id });
    const meeting = createMeeting(env.ctx, {
      title: '  Intro call  ',
      startsAt: '2026-04-01T10:00:00Z',
      endsAt: '2026-04-01T11:00:00Z',
      location: ' Zoom ',
      organizationId: o.id,
      opportunityId: opp.id,
      attendeeIds: [p.id, p.id],
    });
    expect(meeting.id).toMatch(/^mtg_[0-9a-f]{12}$/);
    expect(meeting).toMatchObject({
      title: 'Intro call',
      startsAt: '2026-04-01T10:00:00.000Z',
      endsAt: '2026-04-01T11:00:00.000Z',
      location: 'Zoom',
      organizationId: o.id,
      organizationName: 'Quillan',
      opportunityId: opp.id,
      opportunityName: 'Seed round',
      notes: null,
      version: 1,
      attendeeCount: 1,
    });
    expect(meeting.attendees).toEqual([{ id: p.id, name: 'Ada Meeter' }]);
    expect(audits('meeting.create')).toEqual([{ entityId: meeting.id, detail: { title: 'Intro call', startsAt: '2026-04-01T10:00:00.000Z', attendees: 1 } }]);
    expect(meetingEvents('record_updated')).toEqual([{ type: 'record_updated', entityType: 'meeting', entityId: meeting.id }]);
  });

  it('needs only a title and a start', () => {
    expect(meet()).toMatchObject({ endsAt: null, location: null, organizationId: null, opportunityId: null, attendeeCount: 0, attendees: [] });
  });

  it('validates the shapes', () => {
    const bad = (input: unknown) => rejected(() => createMeeting(env.ctx, input));
    expect(bad({ startsAt: start }).code).toBe('validation');
    expect(bad({ title: '   ', startsAt: start }).code).toBe('validation');
    expect(bad({ title: 'x'.repeat(201), startsAt: start }).code).toBe('validation');
    expect(meet({ title: 'y'.repeat(200) }).title).toHaveLength(200);
    expect(bad({ title: 'A' }).code).toBe('validation');
    expect(bad({ title: 'A', startsAt: 'next tuesday' }).code).toBe('validation');
    expect(bad({ title: 'A', startsAt: start, location: 'x'.repeat(201) }).code).toBe('validation');
    expect(bad({ title: 'A', startsAt: start, extra: 1 }).code).toBe('validation');
    expect(bad({ title: 'A', startsAt: start, notes: 'no notes on create' }).code).toBe('validation');
  });

  it('refuses an end that is not after the start, with a plain sentence', () => {
    const bad = (endsAt: string) => rejected(() => meet({ endsAt }));
    expect(bad('2026-04-01T09:00:00.000Z')).toMatchObject({ code: 'validation', message: 'endsAt: The end must be after the start.' });
    expect(bad(start).code).toBe('validation');
    expect(meet({ endsAt: '2026-04-01T10:00:00.001Z' }).endsAt).toBe('2026-04-01T10:00:00.001Z');
  });

  it('refuses unknown and cross workspace references and writes nothing', () => {
    const other = insertSecondWorkspace(env.db);
    env.db.prepare("INSERT INTO organization (id, created_at, workspace_id, name, kind, updated_at) VALUES ('org_000000000099', '2026-03-02', ?, 'Foreign', 'company', '2026-03-02')").run(other);
    env.db.prepare("INSERT INTO person (id, created_at, workspace_id, first_name, last_name, updated_at) VALUES ('per_000000000099', '2026-03-02', ?, 'Far', 'Away', '2026-03-02')").run(other);
    const p = person('Near');
    const before = (env.db.prepare('SELECT COUNT(*) AS n FROM meeting').get() as { n: number }).n;
    expect(rejected(() => meet({ organizationId: 'org_000000000099' })).code).toBe('not_found');
    expect(rejected(() => meet({ organizationId: 'org_000000000000' })).code).toBe('not_found');
    expect(rejected(() => meet({ opportunityId: 'opp_000000000000' })).code).toBe('not_found');
    expect(rejected(() => meet({ attendeeIds: [p.id, 'per_000000000099'] })).code).toBe('not_found');
    expect((env.db.prepare('SELECT COUNT(*) AS n FROM meeting').get() as { n: number }).n).toBe(before);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM meeting_attendee').get()).toEqual({ n: 0 });
  });
});

describe('updateMeeting', () => {
  it('updates fields, bumps the version once, audits changes, and emits', () => {
    const o = org('Acme');
    const m = meet();
    events.length = 0;
    const updated = updateMeeting(env.ctx, m.id, {
      expectedVersion: 1,
      fields: { title: ' Follow up ', startsAt: '2026-04-02T10:00:00Z', endsAt: '2026-04-02T10:30:00Z', location: 'Office', organizationId: o.id, notes: ' Went well ' },
    });
    expect(updated).toMatchObject({ title: 'Follow up', startsAt: '2026-04-02T10:00:00.000Z', endsAt: '2026-04-02T10:30:00.000Z', location: 'Office', organizationId: o.id, notes: 'Went well', version: 2 });
    const detail = audits('meeting.update')[0]!.detail;
    expect(detail.changes.title).toEqual({ from: 'Intro call', to: 'Follow up' });
    expect(detail.changes.notes).toEqual({ changed: true, characters: 9 });
    expect(JSON.stringify(detail)).not.toContain('Went well');
    expect(meetingEvents('record_updated')).toEqual([{ type: 'record_updated', entityType: 'meeting', entityId: m.id }]);
  });

  it('clears nullable fields and treats empty notes as none', () => {
    const m = meet({ endsAt: '2026-04-01T11:00:00Z', location: 'Zoom' });
    updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { notes: 'abc' } });
    const cleared = updateMeeting(env.ctx, m.id, { expectedVersion: 2, fields: { endsAt: null, location: '', notes: '   ' } });
    expect(cleared).toMatchObject({ endsAt: null, location: null, notes: null, version: 3 });
  });

  it('writes nothing when nothing changes', () => {
    const m = meet();
    events.length = 0;
    const same = updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { title: 'Intro call' } });
    expect(same.version).toBe(1);
    expect(audits('meeting.update')).toEqual([]);
    expect(events).toEqual([]);
  });

  it('answers 409 with the current record on a stale version', () => {
    const m = meet();
    updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { title: 'Newer' } });
    const stale = rejected(() => updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { title: 'Late' } }));
    expect(stale.code).toBe('version_conflict');
    expect(stale.current).toMatchObject({ title: 'Newer', version: 2 });
  });

  it('caps notes at 10000 characters', () => {
    const m = meet();
    expect(rejected(() => updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { notes: 'n'.repeat(10001) } })).code).toBe('validation');
    expect(updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { notes: 'n'.repeat(10000) } }).notes).toHaveLength(10000);
  });

  it('validates fields, an empty change, and unknown keys, and 404s an unknown meeting', () => {
    const m = meet();
    const bad = (fields: unknown) => rejected(() => updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields }));
    expect(bad({}).code).toBe('validation');
    expect(bad({ title: '' }).code).toBe('validation');
    expect(bad({ startsAt: null }).code).toBe('validation');
    expect(bad({ attendeeIds: [] }).code).toBe('validation');
    expect(rejected(() => updateMeeting(env.ctx, m.id, { expectedVersion: 0, fields: { title: 'x' } })).code).toBe('validation');
    expect(rejected(() => updateMeeting(env.ctx, 'mtg_000000000000', { expectedVersion: 1, fields: { title: 'x' } })).code).toBe('not_found');
  });

  it('checks end after start against the resulting pair, whichever side moved', () => {
    const m = meet({ endsAt: '2026-04-01T11:00:00Z' });
    const moveStart = rejected(() => updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { startsAt: '2026-04-01T12:00:00Z' } }));
    expect(moveStart).toMatchObject({ code: 'validation', message: 'endsAt: The end must be after the start.' });
    expect(rejected(() => updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { endsAt: '2026-04-01T09:00:00Z' } })).code).toBe('validation');
    const both = updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { startsAt: '2026-04-01T12:00:00Z', endsAt: '2026-04-01T13:00:00Z' } });
    expect(both.version).toBe(2);
    const open = meet();
    expect(updateMeeting(env.ctx, open.id, { expectedVersion: 1, fields: { startsAt: '2030-01-01T00:00:00Z' } }).version).toBe(2);
  });

  it('refuses unknown and cross workspace links and leaves the meeting alone', () => {
    const other = insertSecondWorkspace(env.db);
    env.db.prepare("INSERT INTO organization (id, created_at, workspace_id, name, kind, updated_at) VALUES ('org_000000000098', '2026-03-02', ?, 'Foreign', 'company', '2026-03-02')").run(other);
    const m = meet();
    expect(rejected(() => updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { organizationId: 'org_000000000098' } })).code).toBe('not_found');
    expect(rejected(() => updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { opportunityId: 'opp_000000000000' } })).code).toBe('not_found');
    expect(getMeeting(env.db, env.workspaceId, m.id)!.version).toBe(1);
  });
});

describe('attendees', () => {
  it('adds idempotently: the second add writes no audit and no event', () => {
    const p = person('Ada');
    const m = meet();
    events.length = 0;
    const first = addMeetingAttendee(env.ctx, m.id, { personId: p.id });
    expect(first.attendees).toEqual([{ id: p.id, name: 'Ada Meeter' }]);
    expect(first.version).toBe(1);
    expect(meetingEvents('record_updated')).toHaveLength(1);
    const again = addMeetingAttendee(env.ctx, m.id, { personId: p.id });
    expect(again.attendeeCount).toBe(1);
    expect(audits('meeting.attendee_add')).toEqual([{ entityId: m.id, detail: { personId: p.id } }]);
    expect(meetingEvents('record_updated')).toHaveLength(1);
  });

  it('removes one attendee, and removing someone absent writes nothing', () => {
    const a = person('A');
    const b = person('B');
    const m = meet({ attendeeIds: [a.id, b.id] });
    events.length = 0;
    expect(removeMeetingAttendee(env.ctx, m.id, a.id).attendees.map((x) => x.id)).toEqual([b.id]);
    expect(meetingEvents('record_updated')).toHaveLength(1);
    removeMeetingAttendee(env.ctx, m.id, a.id);
    expect(audits('meeting.attendee_remove')).toEqual([{ entityId: m.id, detail: { personId: a.id } }]);
    expect(meetingEvents('record_updated')).toHaveLength(1);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM person WHERE id = ?').get(a.id)).toEqual({ n: 1 });
  });

  it('refuses an unknown person, an unknown meeting, and a bad body', () => {
    const m = meet();
    expect(rejected(() => addMeetingAttendee(env.ctx, m.id, { personId: 'per_000000000000' })).code).toBe('not_found');
    expect(rejected(() => addMeetingAttendee(env.ctx, 'mtg_000000000000', { personId: 'per_000000000000' })).code).toBe('not_found');
    expect(rejected(() => addMeetingAttendee(env.ctx, m.id, {})).code).toBe('validation');
    expect(rejected(() => addMeetingAttendee(env.ctx, m.id, { personId: 'x', extra: 1 })).code).toBe('validation');
    expect(rejected(() => removeMeetingAttendee(env.ctx, 'mtg_000000000000', 'per_000000000000')).code).toBe('not_found');
  });

  it('drops the attendee row when the person row is deleted', () => {
    const p = person('Gone');
    const m = meet({ attendeeIds: [p.id] });
    env.db.prepare('DELETE FROM person WHERE id = ?').run(p.id);
    expect(attendeeIds(m.id)).toEqual([]);
    expect(getMeeting(env.db, env.workspaceId, m.id)!.attendeeCount).toBe(0);
  });
});

describe('deleteMeeting', () => {
  it('deletes, cascades attendees, keeps people, audits, and emits record_deleted only', () => {
    const p = person('Stay');
    const m = meet({ title: 'Doomed', attendeeIds: [p.id] });
    events.length = 0;
    const seen: DomainEvent[] = [];
    const stop = env.bus.subscribe((event) => seen.push(event));
    deleteMeeting(env.ctx, m.id);
    stop();
    expect(getMeeting(env.db, env.workspaceId, m.id)).toBeNull();
    expect(attendeeIds(m.id)).toEqual([]);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM person WHERE id = ?').get(p.id)).toEqual({ n: 1 });
    expect(audits('meeting.delete')).toEqual([{ entityId: m.id, detail: { title: 'Doomed', attendees: 1 } }]);
    expect(seen).toEqual([{ type: 'record_deleted', entityType: 'meeting', entityId: m.id }]);
    expect(rejected(() => deleteMeeting(env.ctx, m.id)).code).toBe('not_found');
  });

  it('is rolled back with no event when the audit write fails', () => {
    const m = meet();
    events.length = 0;
    env.db.exec("CREATE TRIGGER meeting_abort BEFORE INSERT ON audit_event WHEN NEW.action = 'meeting.delete' BEGIN SELECT RAISE(ABORT, 'late'); END;");
    try {
      expect(() => deleteMeeting(env.ctx, m.id)).toThrow();
    } finally {
      env.db.exec('DROP TRIGGER meeting_abort');
    }
    expect(getMeeting(env.db, env.workspaceId, m.id)).not.toBeNull();
    expect(events).toEqual([]);
  });

  it('resets with the other record data without tripping a foreign key', () => {
    const o = org('Reset org');
    meet({ organizationId: o.id });
    resetRecordData(env.db);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM meeting').get()).toEqual({ n: 0 });
  });
});

describe('listMeetings', () => {
  it('orders by start time and filters by from, to, organization, and person', () => {
    const p = person('Filter');
    const o = org('Filter org');
    const a = meet({ title: 'A', startsAt: '2026-04-01T10:00:00Z' });
    const b = meet({ title: 'B', startsAt: '2026-04-03T10:00:00Z', organizationId: o.id, attendeeIds: [p.id] });
    const c = meet({ title: 'C', startsAt: '2026-04-02T10:00:00Z', attendeeIds: [p.id] });
    const ids = (input: Record<string, unknown> = {}) => listMeetings(env.db, env.workspaceId, input).items.map((m) => m.id);
    expect(ids()).toEqual([a.id, c.id, b.id]);
    expect(ids({ from: '2026-04-02T10:00:00.000Z' })).toEqual([c.id, b.id]);
    expect(ids({ to: '2026-04-02T10:00:00.000Z' })).toEqual([a.id]);
    expect(ids({ from: '2026-04-01T11:00:00.000Z', to: '2026-04-03T10:00:00.000Z' })).toEqual([c.id]);
    expect(ids({ organizationId: o.id })).toEqual([b.id]);
    expect(ids({ personId: p.id })).toEqual([c.id, b.id]);
    expect(ids({ personId: p.id, organizationId: o.id })).toEqual([b.id]);
    expect(listMeetings(env.db, env.workspaceId).items.find((m) => m.id === b.id)).toMatchObject({ attendeeCount: 1, organizationName: o.name });
    expect(ids({ limit: 2 })).toEqual([a.id, c.id]);
  });

  it('defaults to 200, caps at 500, and stays inside the workspace', () => {
    const insert = env.db.prepare("INSERT INTO meeting (id, created_at, workspace_id, title, starts_at, updated_at) VALUES (?, '2026-01-01', ?, 'Bulk', ?, '2026-01-01')");
    const other = insertSecondWorkspace(env.db);
    for (let index = 0; index < 520; index += 1) insert.run(`mtg_${String(index).padStart(12, '0')}`, env.workspaceId, `2026-05-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`);
    insert.run('mtg_ffffffffffff', other, '2026-05-01T00:00:00.000Z');
    expect(listMeetings(env.db, env.workspaceId).items).toHaveLength(200);
    expect(listMeetings(env.db, env.workspaceId, { limit: 9999 }).items).toHaveLength(500);
    expect(listMeetings(env.db, env.workspaceId, { limit: 520 }).items.every((m) => m.workspaceId === env.workspaceId)).toBe(true);
    expect(getMeeting(env.db, env.workspaceId, 'mtg_ffffffffffff')).toBeNull();
  });
});

describe('merges', () => {
  const mergeBody = (s: { version: number }, o: { id: string; version: number }) => ({ otherId: o.id, expectedVersion: s.version, otherExpectedVersion: o.version });

  it('moves attendances to the surviving person and drops a duplicate when both attended', () => {
    const survivor = person('Keep');
    const other = person('Lose');
    const onlyOther = meet({ title: 'Only other', attendeeIds: [other.id] });
    const both = meet({ title: 'Both', attendeeIds: [survivor.id, other.id] });
    const onlySurvivor = meet({ title: 'Only survivor', attendeeIds: [survivor.id] });
    mergePeople(env.ctx, survivor.id, mergeBody(survivor, other));
    expect(attendeeIds(onlyOther.id)).toEqual([survivor.id]);
    expect(attendeeIds(both.id)).toEqual([survivor.id]);
    expect(attendeeIds(onlySurvivor.id)).toEqual([survivor.id]);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM meeting_attendee WHERE person_id = ?').get(other.id)).toEqual({ n: 0 });
    // The pair row that would have duplicated is dropped, so only the other-only attendance counts as moved.
    expect(audits('person.merge')[0]!.detail.moved.meetingAttendances).toBe(1);
  });

  it('re-points meetings to the surviving organization and counts them', () => {
    const survivor = org('Survivor org');
    const other = org('Other org');
    const m = meet({ organizationId: other.id });
    const keep = meet({ organizationId: survivor.id });
    mergeOrganizations(env.ctx, survivor.id, mergeBody(survivor, other));
    expect(getMeeting(env.db, env.workspaceId, m.id)).toMatchObject({ organizationId: survivor.id, organizationName: 'Survivor org', version: 1 });
    expect(getMeeting(env.db, env.workspaceId, keep.id)!.organizationId).toBe(survivor.id);
    expect(audits('organization.merge')[0]!.detail.moved.meetings).toBe(1);
    expect(env.db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('meeting routes', () => {
  it('creates with 201, reads one and the list, and filters', async () => {
    const p = person('Route');
    const created = await call('POST', '/api/meetings', { title: 'Route call', startsAt: start, attendeeIds: [p.id] });
    expect(created.status).toBe(201);
    expect(created.body.attendees).toEqual([{ id: p.id, name: 'Route Meeter' }]);
    const one = await call('GET', `/api/meetings/${created.body.id}`);
    expect(one.body).toMatchObject({ id: created.body.id, attendees: [{ id: p.id }] });
    const list = await call('GET', `/api/meetings?personId=${p.id}&from=${encodeURIComponent('2026-04-01T00:00:00Z')}&to=${encodeURIComponent('2026-04-02T00:00:00Z')}`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ items: [{ id: created.body.id, attendeeCount: 1 }], nextCursor: null });
    expect((await call('GET', '/api/meetings?to=never')).status).toBe(400);
    expect((await call('GET', '/api/meetings?limit=0')).status).toBe(400);
  });

  it('patches with a version check, answers 409 and 404 and 400', async () => {
    const m = meet();
    const patched = await call('PATCH', `/api/meetings/${m.id}`, { expectedVersion: 1, fields: { notes: 'Agreed to meet again' } });
    expect(patched.body).toMatchObject({ notes: 'Agreed to meet again', version: 2 });
    const stale = await call('PATCH', `/api/meetings/${m.id}`, { expectedVersion: 1, fields: { title: 'x' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.error.current).toMatchObject({ version: 2 });
    expect((await call('PATCH', `/api/meetings/${m.id}`, { expectedVersion: 2, fields: { endsAt: '2020-01-01T00:00:00Z' } })).status).toBe(400);
    expect((await call('PATCH', '/api/meetings/mtg_000000000000', { expectedVersion: 1, fields: { title: 'x' } })).status).toBe(404);
    expect((await call('GET', '/api/meetings/mtg_000000000000')).status).toBe(404);
  });

  it('adds and removes attendees and deletes with 204', async () => {
    const p = person('Att');
    const m = meet();
    const added = await call('POST', `/api/meetings/${m.id}/attendees`, { personId: p.id });
    expect(added.status).toBe(200);
    expect(added.body.attendees).toEqual([{ id: p.id, name: 'Att Meeter' }]);
    expect((await call('POST', `/api/meetings/${m.id}/attendees`, { personId: p.id })).body.attendeeCount).toBe(1);
    expect((await call('DELETE', `/api/meetings/${m.id}/attendees/${p.id}`)).body.attendeeCount).toBe(0);
    expect((await call('DELETE', `/api/meetings/${m.id}`)).status).toBe(204);
    expect((await call('DELETE', `/api/meetings/${m.id}`)).status).toBe(404);
    expect((await call('GET', `/api/meetings/${m.id}`)).body.error.code).toBe('not_found');
  });

  it('refuses writes from a foreign Origin like the other write routes', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/meetings', headers: { ...host, origin: 'http://evil.example.com' }, payload: { title: 'x', startsAt: start } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM meeting').get()).toEqual({ n: 0 });
  });

  it('streams record_deleted for a meeting on the event bus the SSE route reads', async () => {
    const m = meet();
    const seen: DomainEvent[] = [];
    const stop = env.bus.subscribe((event) => seen.push(event));
    await call('DELETE', `/api/meetings/${m.id}`);
    stop();
    expect(seen).toEqual([{ type: 'record_deleted', entityType: 'meeting', entityId: m.id }]);
  });
});
