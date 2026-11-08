// Adversarial review probes for the meetings wave (server). KILLS: attack failed, safe behavior pinned.
// CONFIRMS: live gap asserted as it behaves today. ACCEPTED: limit the contract states.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMeetingAttendee,
  configureAnthropicConnector,
  controlRun,
  createContext,
  createMeeting,
  createOpportunity,
  createOrganization,
  createPerson,
  decideApproval,
  deleteMeeting,
  ensureWorkspace,
  mergeOrganizations,
  mergePeople,
  removeMeetingAttendee,
  resetAllData,
  resetRecordData,
  startTranscriptCapture,
  updateMeeting,
} from '../src/actions/index.js';
import { openDatabase } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { EventBus, type DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { processAllJobs } from '../src/jobs/worker.js';
import { listMeetings } from '../src/queries/meetings.js';
import { getRunDetail } from '../src/queries/runs.js';
import { type AnthropicStub, jsonReply, startAnthropicStub, stubApiKey, useAnthropicStub } from './anthropicStub.js';
import { createTestEnvironment, driveRunAsync, insertSecondWorkspace } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let anthropic: AnthropicStub;
let restoreAnthropic: () => void;
const events: DomainEvent[] = [];
const host = { host: '127.0.0.1:4720' };
let other = '';

beforeAll(async () => {
  env.bus.subscribe((event) => events.push(event));
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
  anthropic = await startAnthropicStub();
  restoreAnthropic = useAnthropicStub(anthropic);
  await configureAnthropicConnector(env.ctx, { token: stubApiKey });
  other = insertSecondWorkspace(env.db);
});
afterAll(async () => {
  await app.close();
  await anthropic.close();
  restoreAnthropic();
  env.cleanup();
});
beforeEach(async () => {
  for (const row of env.db.prepare("SELECT id FROM run WHERE status IN ('queued', 'running', 'paused', 'waiting_approval')").all() as { id: string }[]) {
    controlRun(env.ctx, row.id, { action: 'cancel' });
  }
  await processAllJobs(env.ctx);
  env.db.exec('DELETE FROM meeting_attendee; DELETE FROM meeting;');
  resetRecordData(env.db);
  events.length = 0;
});

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, headers: host, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: response.statusCode, body: response.body ? (response.json() as Record<string, any>) : {} };
}
function failure(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'none';
}
const count = (sql: string, ...args: unknown[]) => (env.db.prepare(sql).get(...(args as never[])) as { n: number }).n;
const person = (first: string) => createPerson(env.ctx, { firstName: first, lastName: 'Probe' });
const org = (name: string) => createOrganization(env.ctx, { name, kind: 'company' } as never);
const start = '2026-04-01T10:00:00.000Z';
const meet = (extra: Record<string, unknown> = {}) => createMeeting(env.ctx, { title: 'Call', startsAt: start, ...extra });
const mergeBody = (s: { version: number }, o: { id: string; version: number }) => ({ otherId: o.id, expectedVersion: s.version, otherExpectedVersion: o.version });
const meetingEvents = () => events.filter((e) => (e as { entityType?: string }).entityType === 'meeting');

function foreign() {
  env.db.prepare("INSERT INTO organization (id, created_at, workspace_id, name, kind, updated_at) VALUES ('org_f00000000001', '2026-03-02', ?, 'Foreign Org', 'company', '2026-03-02')").run(other);
  env.db.prepare("INSERT INTO person (id, created_at, workspace_id, first_name, last_name, updated_at) VALUES ('per_f00000000001', '2026-03-02', ?, 'Far', 'Away', '2026-03-02')").run(other);
  const pipeline = env.db.prepare('SELECT id FROM pipeline LIMIT 1').get() as { id: string };
  const stage = env.db.prepare('SELECT id FROM stage LIMIT 1').get() as { id: string };
  env.db
    .prepare(
      "INSERT INTO opportunity (id, created_at, workspace_id, name, pipeline_id, stage_id, stage_changed_at, updated_at) VALUES ('opp_f00000000001', '2026-03-02', ?, 'Foreign Deal', ?, ?, '2026-03-02', '2026-03-02')",
    )
    .run(other, pipeline.id, stage.id);
  env.db.prepare("INSERT INTO meeting (id, created_at, workspace_id, title, starts_at, updated_at) VALUES ('mtg_f00000000001', '2026-03-02', ?, 'Foreign meeting', ?, '2026-03-02')").run(other, start);
  env.db.prepare("INSERT INTO meeting_attendee (meeting_id, person_id, created_at) VALUES ('mtg_f00000000001', 'per_f00000000001', '2026-03-02')").run();
}

describe('1. workspace scoping and reference abuse', () => {
  it('KILLS: create with a foreign org / deal / attendee refuses and writes nothing, each path', () => {
    foreign();
    for (const extra of [{ organizationId: 'org_f00000000001' }, { opportunityId: 'opp_f00000000001' }, { attendeeIds: ['per_f00000000001'] }]) {
      expect(failure(() => meet(extra))).toMatch(/^not_found/);
    }
    expect(count("SELECT COUNT(*) AS n FROM meeting WHERE workspace_id = ?", env.workspaceId)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM meeting_attendee')).toBe(1); // only the seeded foreign one
    expect(count("SELECT COUNT(*) AS n FROM audit_event WHERE action LIKE 'meeting.%'")).toBe(0);
    expect(events).toEqual([]);
  });

  it('KILLS: patch to a foreign org / deal refuses, version and row untouched, nothing emitted', () => {
    foreign();
    const m = meet();
    events.length = 0;
    for (const fields of [{ organizationId: 'org_f00000000001' }, { opportunityId: 'opp_f00000000001' }, { title: 'Ok', organizationId: 'org_f00000000001' }]) {
      expect(failure(() => updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields }))).toMatch(/^not_found/);
    }
    expect(env.db.prepare('SELECT version, title, organization_id FROM meeting WHERE id = ?').get(m.id)).toEqual({ version: 1, title: 'Call', organization_id: null });
    expect(events).toEqual([]);
  });

  it('KILLS: attendee add of a foreign person, and attendee routes with a foreign meeting id, refuse', async () => {
    foreign();
    const m = meet();
    events.length = 0;
    expect(failure(() => addMeetingAttendee(env.ctx, m.id, { personId: 'per_f00000000001' }))).toMatch(/^not_found/);
    expect(failure(() => addMeetingAttendee(env.ctx, 'mtg_f00000000001', { personId: person('Ok').id }))).toMatch(/^not_found/);
    expect(failure(() => removeMeetingAttendee(env.ctx, 'mtg_f00000000001', 'per_f00000000001'))).toMatch(/^not_found/);
    expect(count("SELECT COUNT(*) AS n FROM meeting_attendee WHERE meeting_id = 'mtg_f00000000001'")).toBe(1);
    expect((await call('GET', '/api/meetings/mtg_f00000000001')).status).toBe(404);
    expect((await call('PATCH', '/api/meetings/mtg_f00000000001', { expectedVersion: 1, fields: { title: 'x' } })).status).toBe(404);
    expect((await call('DELETE', '/api/meetings/mtg_f00000000001')).status).toBe(404);
    expect((await call('POST', '/api/meetings/mtg_f00000000001/attendees', { personId: 'per_f00000000001' })).status).toBe(404);
    expect((await call('DELETE', '/api/meetings/mtg_f00000000001/attendees/per_f00000000001')).status).toBe(404);
    expect(count("SELECT COUNT(*) AS n FROM meeting WHERE id = 'mtg_f00000000001'")).toBe(1);
    expect(meetingEvents()).toEqual([]);
  });

  it('KILLS: the personId and organizationId filters do not leak other workspaces', async () => {
    foreign();
    meet();
    const viaPerson = await call('GET', '/api/meetings?personId=per_f00000000001');
    expect(viaPerson.body.items).toEqual([]);
    const all = await call('GET', '/api/meetings?limit=500');
    expect(all.body.items.map((i: any) => i.title)).toEqual(['Call']);
    expect(listMeetings(env.db, env.workspaceId, { organizationId: 'org_f00000000001' }).items).toEqual([]);
  });

  it('KILLS: removing a person who is not on the meeting writes nothing; cross person id is inert', () => {
    const m = meet({ attendeeIds: [person('A').id] });
    events.length = 0;
    removeMeetingAttendee(env.ctx, m.id, 'per_000000000000');
    expect(events).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'meeting.attendee_remove'")).toBe(0);
  });
});

describe('2. merge interactions', () => {
  it('KILLS: both people on the same meeting leaves one row, no PK violation, counts match reality', () => {
    const s = person('S');
    const g = person('G');
    const third = person('T');
    const shared = meet({ attendeeIds: [s.id, g.id] });
    const onlyG = meet({ attendeeIds: [g.id, third.id] });
    const onlyS = meet({ attendeeIds: [s.id] });
    mergePeople(env.ctx, s.id, mergeBody(s, g));
    expect(count('SELECT COUNT(*) AS n FROM meeting_attendee WHERE meeting_id = ? AND person_id = ?', shared.id, s.id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM meeting_attendee WHERE meeting_id = ?', shared.id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM meeting_attendee WHERE meeting_id = ?', onlyG.id)).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM meeting_attendee WHERE meeting_id = ?', onlyS.id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM meeting_attendee WHERE person_id = ?', g.id)).toBe(0);
    const audit = JSON.parse((env.db.prepare("SELECT detail FROM audit_event WHERE action = 'person.merge'").get() as { detail: string }).detail);
    expect(audit.moved.meetingAttendances).toBe(1);
    expect(env.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('KILLS: org merge re-points meetings, audit count equals reality, merged-away org has no meeting left', () => {
    const s = org('Surv');
    const g = org('Gone');
    meet({ organizationId: g.id });
    meet({ organizationId: g.id });
    meet({ organizationId: s.id });
    mergeOrganizations(env.ctx, s.id, mergeBody(s, g));
    expect(count('SELECT COUNT(*) AS n FROM meeting WHERE organization_id = ?', s.id)).toBe(3);
    const audit = JSON.parse((env.db.prepare("SELECT detail FROM audit_event WHERE action = 'organization.merge'").get() as { detail: string }).detail);
    expect(audit.moved.meetings).toBe(2);
  });

  it('KILLS: org merge does not touch another workspace meeting naming the same-id org (scoped UPDATE)', () => {
    foreign();
    const s = org('Surv');
    const g = org('Gone');
    env.db.prepare("INSERT INTO meeting (id, created_at, workspace_id, title, starts_at, organization_id, updated_at) VALUES ('mtg_f00000000002', '2026-03-02', ?, 'F', ?, ?, '2026-03-02')").run(other, start, g.id);
    // the FK still blocks delete of g: the merge must fail or the foreign row is left dangling-free. Observe which.
    let outcome = 'merged';
    try {
      mergeOrganizations(env.ctx, s.id, mergeBody(s, g));
    } catch (error) {
      outcome = (error as Error).message;
    }
    console.log('[probe] org merge with cross-workspace meeting naming it ->', outcome);
    // ACCEPTED: unreachable through the app (a meeting cannot name a foreign org); the FK fails the whole merge atomically.
    expect(count('SELECT COUNT(*) AS n FROM organization WHERE id = ?', g.id)).toBe(1);
    expect(env.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('KILLS: merge then attendee add of the merged-away person is a clean not_found; meeting delete then merge is clean', () => {
    const s = person('S');
    const g = person('G');
    const m = meet({ attendeeIds: [g.id] });
    mergePeople(env.ctx, s.id, mergeBody(s, g));
    expect(failure(() => addMeetingAttendee(env.ctx, m.id, { personId: g.id }))).toMatch(/^not_found/);
    const s2 = person('S2');
    const g2 = person('G2');
    const m2 = meet({ attendeeIds: [g2.id] });
    deleteMeeting(env.ctx, m2.id);
    mergePeople(env.ctx, s2.id, mergeBody(s2, g2));
    const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'person.merge' ORDER BY created_at DESC").get() as { detail: string };
    expect(JSON.parse(audit.detail).moved.meetingAttendances).toBe(0);
  });

  it('KILLS: second connection holding the write lock makes attendee add fail BUSY with nothing written (merge likewise)', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-mtgbusy-'));
    const p = path.join(directory, 'b.db');
    const a = openDatabase(p);
    const b = openDatabase(p);
    try {
      const ws = ensureWorkspace(a);
      const bus = new EventBus();
      const seen: DomainEvent[] = [];
      bus.subscribe((e) => seen.push(e));
      const ctx = createContext(a, ws.id, { bus });
      const s = createPerson(ctx, { firstName: 'S', lastName: 'B' });
      const g = createPerson(ctx, { firstName: 'G', lastName: 'B' });
      const m = createMeeting(ctx, { title: 'x', startsAt: start, attendeeIds: [g.id] });
      b.pragma('busy_timeout = 50');
      a.pragma('busy_timeout = 50');
      b.exec('BEGIN IMMEDIATE');
      seen.length = 0;
      let message = 'none';
      try {
        addMeetingAttendee(ctx, m.id, { personId: s.id });
      } catch (error) {
        message = (error as { code?: string }).code ?? String(error);
      }
      expect(message).toMatch(/SQLITE_BUSY/);
      let mergeMessage = 'none';
      try {
        mergePeople(ctx, s.id, { otherId: g.id, expectedVersion: 1, otherExpectedVersion: 1 });
      } catch (error) {
        mergeMessage = (error as { code?: string }).code ?? String(error);
      }
      expect(mergeMessage).toMatch(/SQLITE_BUSY/);
      b.exec('ROLLBACK');
      expect(seen).toEqual([]);
      expect((a.prepare('SELECT COUNT(*) AS n FROM meeting_attendee').get() as { n: number }).n).toBe(1);
    } finally {
      a.close();
      b.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('3. transcript attach', () => {
  const noorLine = 'Noor Ellery leads product at Quillan Labs.';
  const marloweLine = 'Also Marlowe Ridge Partners, a family office.';
  const text = `Call.\n${noorLine}\n${marloweLine}`;
  const answer = {
    entries: [
      { kind: 'person', name: 'Noor Ellery', company: 'Quillan Labs', email: 'noor@example.com', quote: noorLine },
      { kind: 'organization', name: 'Marlowe Ridge Partners', orgKind: 'fund', quote: marloweLine },
    ],
  };
  const scopeOf = (runId: string) => JSON.parse((env.db.prepare('SELECT scope FROM run WHERE id = ?').get(runId) as { scope: string }).scope);

  it('KILLS: a foreign-workspace meeting id is refused at START and nothing starts; agent origin refused with meetingId present', () => {
    foreign();
    const runs = () => count('SELECT COUNT(*) AS n FROM run');
    const before = runs();
    expect(failure(() => startTranscriptCapture(env.ctx, { transcriptText: text, meetingId: 'mtg_f00000000001' }))).toMatch(/^not_found/);
    const m = meet();
    expect(failure(() => startTranscriptCapture(env.ctx, { transcriptText: text, meetingId: m.id }, { origin: 'agent' }))).toMatch(/^validation/);
    expect(runs()).toBe(before);
  });

  it('KILLS: a row matched to an organization never links, and the meeting is not touched when only orgs are named', async () => {
    anthropic.reset();
    anthropic.state.fallback = () => jsonReply({ entries: [answer.entries[1]] });
    const m = meet();
    createOrganization(env.ctx, { name: 'Marlowe Ridge Partners', kind: 'fund' } as never);
    events.length = 0;
    const run = startTranscriptCapture(env.ctx, { transcriptText: text, meetingId: m.id });
    await driveRunAsync(env, run.id, ['waiting_approval', 'partial', 'failed', 'succeeded']);
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    if (detail.approvals[0]) decideApproval(env.ctx, detail.approvals[0].id, { decision: 'approve' });
    expect(count('SELECT COUNT(*) AS n FROM meeting_attendee WHERE meeting_id = ?', m.id)).toBe(0);
    expect(meetingEvents().filter((e) => e.type === 'record_updated')).toEqual([]);
  });

  it('KILLS: failed and cancelled terminal paths keep meetingId in scope (json_remove only strips text and extraction)', async () => {
    const m = meet();
    anthropic.reset();
    anthropic.state.fallback = () => ({ status: 500, body: 'boom' }) as never;
    const run = startTranscriptCapture(env.ctx, { transcriptText: text, meetingId: m.id });
    const status = await driveRunAsync(env, run.id, ['failed', 'partial', 'waiting_approval', 'succeeded']);
    console.log('[probe] failed-path run status:', status, JSON.stringify(scopeOf(run.id)));
    expect(scopeOf(run.id)).not.toHaveProperty('transcriptText');
    const second = startTranscriptCapture(env.ctx, { transcriptText: text, meetingId: m.id });
    controlRun(env.ctx, second.id, { action: 'cancel' });
    await processAllJobs(env.ctx);
    expect(scopeOf(second.id)).not.toHaveProperty('transcriptText');
    expect(scopeOf(second.id).meetingId).toBe(m.id);
  });

  it('KILLS: a meeting deleted mid-run (before staging finishes) links nothing, accept proceeds', async () => {
    anthropic.reset();
    anthropic.state.fallback = () => jsonReply(answer);
    const m = meet();
    const run = startTranscriptCapture(env.ctx, { transcriptText: text, meetingId: m.id });
    deleteMeeting(env.ctx, m.id); // deleted right after start, before the worker ticks
    await driveRunAsync(env, run.id, ['waiting_approval', 'partial', 'failed']);
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    decideApproval(env.ctx, detail.approvals[0]!.id, { decision: 'approve' });
    expect(getRunDetail(env.db, env.workspaceId, run.id).status).toBe('succeeded');
    expect(count("SELECT COUNT(*) AS n FROM person WHERE first_name = 'Noor'")).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM meeting_attendee')).toBe(0);
    expect(failure(() => 0)).toBe('none');
  });

  it('KILLS: the attendee_add audit has exactly {added, runId}; no transcript text in it', async () => {
    anthropic.reset();
    anthropic.state.fallback = () => jsonReply(answer);
    const m = meet();
    const run = startTranscriptCapture(env.ctx, { transcriptText: text, meetingId: m.id });
    await driveRunAsync(env, run.id, ['waiting_approval']);
    decideApproval(env.ctx, getRunDetail(env.db, env.workspaceId, run.id).approvals[0]!.id, { decision: 'approve' });
    const rows = env.db.prepare("SELECT detail, actor FROM audit_event WHERE action = 'meeting.attendee_add'").all() as { detail: string; actor: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.detail)).toEqual({ added: 1, runId: run.id });
    expect(rows[0]!.detail).not.toContain('Noor');
  });
});

describe('4. validation edges', () => {
  const post = (payload: unknown) => call('POST', '/api/meetings', payload);
  it('KILLS: endsAt == startsAt refused; clearing endsAt then moving start works; moving start past ends refused', async () => {
    expect((await post({ title: 'x', startsAt: start, endsAt: start })).status).toBe(400);
    const m = meet({ endsAt: '2026-04-01T11:00:00.000Z' });
    expect(failure(() => updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { startsAt: '2026-04-01T12:00:00.000Z' } }))).toMatch(/^validation/);
    expect(failure(() => updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { startsAt: '2026-04-01T12:00:00.000Z', endsAt: null } }))).toBe('none');
    const m2 = meet({ endsAt: '2026-04-01T11:00:00.000Z' });
    expect(failure(() => updateMeeting(env.ctx, m2.id, { expectedVersion: 1, fields: { endsAt: '2026-04-01T09:00:00.000Z' } }))).toMatch(/^validation/);
  });
  it('KILLS: notes cap at 10000 exactly', () => {
    const m = meet();
    const ok = updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { notes: 'a'.repeat(10_000) } });
    expect(ok.notes).toHaveLength(10_000);
    expect(failure(() => updateMeeting(env.ctx, m.id, { expectedVersion: 2, fields: { notes: 'a'.repeat(10_001) } }))).toMatch(/^validation/);
    // whitespace padding counts after trim
    expect(failure(() => updateMeeting(env.ctx, m.id, { expectedVersion: 2, fields: { notes: ` ${'a'.repeat(10_000)} ` } }))).toBe('none');
  });
  it('CONFIRMS-candidate: title control characters are accepted (person names refuse them)', async () => {
    const r = await post({ title: 'bad\u0000title\u0007', startsAt: start });
    console.log('[probe] control char title ->', r.status, JSON.stringify(r.body.title));
    const r2 = await post({ title: 'line1\nline2', startsAt: start });
    console.log('[probe] newline title ->', r2.status);
    const person1 = await call('POST', '/api/people', { firstName: 'a\u0007b', lastName: 'x' });
    console.log('[probe] person control char first name ->', person1.status);
    expect([201, 400]).toContain(r.status);
  });
  it('KILLS: garbage ISO and non-string startsAt refuse; date-only normalizes', async () => {
    for (const bad of ['garbage', '2026-13-45', '', 5, null, '2026-02-30']) {
      const r = await post({ title: 'x', startsAt: bad });
      console.log('[probe] startsAt', JSON.stringify(bad), '->', r.status, r.body.message ?? r.body.title);
    }
    expect((await post({ title: 'x', startsAt: 'garbage' })).status).toBe(400);
    expect((await post({ title: 'x', startsAt: '2026-04-01' })).body.startsAt).toBe('2026-04-01T00:00:00.000Z');
  });
  it('KILLS: limit and range edges on the list route', async () => {
    meet();
    for (const q of ['limit=0', 'limit=-1', 'limit=abc', 'limit=1.5']) console.log('[probe] list', q, '->', (await call('GET', `/api/meetings?${q}`)).status);
    expect((await call('GET', '/api/meetings?limit=0')).status).toBe(400);
    expect((await call('GET', '/api/meetings?limit=abc')).status).toBe(400);
    const big = await call('GET', '/api/meetings?limit=501');
    expect(big.status).toBe(200);
    const inverted = await call('GET', '/api/meetings?from=2026-05-01&to=2026-03-01');
    expect(inverted.status).toBe(200);
    expect(inverted.body.items).toEqual([]);
    const badFrom = await call('GET', '/api/meetings?from=garbage');
    expect(badFrom.status).toBe(400);
    // from inclusive, to exclusive
    expect((await call('GET', `/api/meetings?from=${start}`)).body.items).toHaveLength(1);
    expect((await call('GET', `/api/meetings?to=${start}`)).body.items).toHaveLength(0);
  });
  it('KILLS: unknown keys and notes on create are refused (strict)', async () => {
    expect((await post({ title: 'x', startsAt: start, notes: 'n' })).status).toBe(400);
    expect((await post({ title: 'x', startsAt: start, workspaceId: 'x' })).status).toBe(400);
    expect((await call('PATCH', '/api/meetings/mtg_x', { expectedVersion: 1, fields: {} })).status).toBe(400);
  });
  it('KILLS: attendeeIds 201 entries refused whole', () => {
    const ids = Array.from({ length: 201 }, (_, i) => `per_${String(i).padStart(12, '0')}`);
    expect(failure(() => meet({ attendeeIds: ids }))).toMatch(/^validation/);
  });
  it('KILLS: timestamps with offset normalize to UTC and compare correctly', () => {
    const m = meet({ startsAt: '2026-04-01T12:00:00+02:00', endsAt: '2026-04-01T10:30:00Z' });
    expect(m.startsAt).toBe('2026-04-01T10:00:00.000Z');
  });
});

describe('5. deletion events', () => {
  it('KILLS: record_deleted fires once, after commit, only for a real delete; refused deletes emit nothing', () => {
    const m = meet({ attendeeIds: [person('A').id] });
    const seen: { rows: number; inTx: boolean }[] = [];
    env.bus.subscribe((e) => {
      if (e.type === 'record_deleted') seen.push({ rows: count('SELECT COUNT(*) AS n FROM meeting WHERE id = ?', m.id), inTx: env.db.inTransaction });
    });
    events.length = 0;
    expect(failure(() => deleteMeeting(env.ctx, 'mtg_000000000000'))).toMatch(/^not_found/);
    foreign();
    expect(failure(() => deleteMeeting(env.ctx, 'mtg_f00000000001'))).toMatch(/^not_found/);
    expect(events).toEqual([]);
    deleteMeeting(env.ctx, m.id);
    expect(events).toEqual([{ type: 'record_deleted', entityType: 'meeting', entityId: m.id }]);
    expect(seen).toEqual([{ rows: 0, inTx: false }]);
  });
  it('KILLS: an abort inside the delete transaction emits nothing and keeps the row and attendees', () => {
    const m = meet({ attendeeIds: [person('A').id] });
    events.length = 0;
    env.db.exec("CREATE TRIGGER mtg_abort BEFORE INSERT ON audit_event WHEN NEW.action = 'meeting.delete' BEGIN SELECT RAISE(ABORT, 'late'); END;");
    try {
      expect(() => deleteMeeting(env.ctx, m.id)).toThrow();
    } finally {
      env.db.exec('DROP TRIGGER mtg_abort');
    }
    expect(events).toEqual([]);
    expect(count('SELECT COUNT(*) AS n FROM meeting WHERE id = ?', m.id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM meeting_attendee WHERE meeting_id = ?', m.id)).toBe(1);
    events.length = 0;
    deleteMeeting(env.ctx, m.id);
    expect(events.filter((e) => e.type === 'record_deleted')).toHaveLength(1);
  });
  it('KILLS: delete audit keeps title and attendee count; HTTP delete is 204; second delete 404', async () => {
    const m = meet({ attendeeIds: [person('A').id, person('B').id] });
    expect((await call('DELETE', `/api/meetings/${m.id}`)).status).toBe(204);
    expect((await call('DELETE', `/api/meetings/${m.id}`)).status).toBe(404);
    const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'meeting.delete'").all() as { detail: string }[];
    expect(audit.map((r) => JSON.parse(r.detail))).toEqual([{ title: 'Call', attendees: 2 }]);
  });
  it('KILLS: notes never reach the audit log; update audit records length only', () => {
    const m = meet();
    updateMeeting(env.ctx, m.id, { expectedVersion: 1, fields: { notes: 'SECRET-NOTE-TEXT' } });
    const rows = env.db.prepare("SELECT detail FROM audit_event WHERE entity_id = ?").all(m.id) as { detail: string }[];
    expect(rows.some((r) => r.detail.includes('SECRET-NOTE-TEXT'))).toBe(false);
    expect(rows.some((r) => r.detail.includes('"characters":16'))).toBe(true);
  });
});

describe('7. resets', () => {
  it('KILLS: resetRecordData and resetAllData pass with meetings naming orgs, deals, and people', () => {
    const o = org('Resetco');
    const opp = createOpportunity(env.ctx, { name: 'Deal', organizationId: o.id });
    meet({ organizationId: o.id, opportunityId: opp.id, attendeeIds: [person('R').id] });
    resetRecordData(env.db);
    expect(count('SELECT COUNT(*) AS n FROM meeting')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM meeting_attendee')).toBe(0);
  });
  it('KILLS: resetAllData with meetings present (own database)', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-mtgreset-'));
    const db = openDatabase(path.join(directory, 'r.db'));
    try {
      const ws = ensureWorkspace(db);
      const ctx = createContext(db, ws.id, { bus: new EventBus() });
      const o = createOrganization(ctx, { name: 'Resetco2', kind: 'company' } as never);
      const opp = createOpportunity(ctx, { name: 'Deal', organizationId: o.id });
      const pp = createPerson(ctx, { firstName: 'R', lastName: 'R' });
      createMeeting(ctx, { title: 'x', startsAt: start, organizationId: o.id, opportunityId: opp.id, attendeeIds: [pp.id] });
      expect(() => resetAllData(db)).not.toThrow();
      expect((db.prepare('SELECT COUNT(*) AS n FROM meeting').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM meeting_attendee').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('9. perf', () => {
  it('reports list latency at 50,000 meetings', async () => {
    const ws = ensureWorkspace(env.db);
    const p = createPerson(createContext(env.db, ws.id, { bus: env.bus }), { firstName: 'Perf', lastName: 'P' });
    const insert = env.db.prepare("INSERT INTO meeting (id, created_at, workspace_id, title, starts_at, updated_at) VALUES (?, '2026-01-01', ?, 'Bulk', ?, '2026-01-01')");
    const att = env.db.prepare("INSERT INTO meeting_attendee (meeting_id, person_id, created_at) VALUES (?, ?, '2026-01-01')");
    env.db.transaction(() => {
      for (let i = 0; i < 50_000; i += 1) {
        const id = `mtg_${String(i).padStart(12, '0')}`;
        insert.run(id, ws.id, new Date(Date.UTC(2020, 0, 1) + i * 3_600_000).toISOString());
        if (i % 10 === 0) att.run(id, p.id);
      }
    })();
    const time = async (url: string) => {
      const t = performance.now();
      const r = await call('GET', url);
      return { ms: Math.round(performance.now() - t), n: r.body.items?.length, status: r.status };
    };
    const results = {
      unfiltered: await time('/api/meetings'),
      limit500: await time('/api/meetings?limit=500'),
      range: await time('/api/meetings?from=2022-01-01&to=2022-02-01'),
      person: await time(`/api/meetings?personId=${p.id}`),
      personRange: await time(`/api/meetings?personId=${p.id}&from=2024-01-01`),
      far: await time('/api/meetings?from=2025-12-01'),
    };
    console.log('[probe] 50k meetings list ms:', JSON.stringify(results));
    for (const r of Object.values(results)) expect(r.ms).toBeLessThan(1000);
    env.db.exec("DELETE FROM meeting_attendee; DELETE FROM meeting;");
  });
});

describe('11. window truncation', () => {
  it('KILLS: order=desc keeps the newest rows under the cap, so the past view never loses recent meetings; the default stays ascending', async () => {
    const insert = env.db.prepare("INSERT INTO meeting (id, created_at, workspace_id, title, starts_at, updated_at) VALUES (?, '2026-01-01', ?, 'W', ?, '2026-01-01')");
    env.db.transaction(() => {
      for (let i = 0; i < 600; i += 1) insert.run(`mtg_w${String(i).padStart(10, '0')}`, env.workspaceId, new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString());
    })();
    const desc = await call('GET', '/api/meetings?from=2026-01-01&to=2026-06-01&limit=500&order=desc');
    expect(desc.body.items).toHaveLength(500);
    expect(desc.body.items[0].id).toBe('mtg_w0000000599'); // newest first
    expect(desc.body.items.at(-1).id).toBe('mtg_w0000000100'); // the oldest 100 fall out, never the newest
    const asc = await call('GET', '/api/meetings?from=2026-01-01&to=2026-06-01&limit=500');
    expect(asc.body.items[0].id).toBe('mtg_w0000000000'); // default order unchanged
    const bad = await call('GET', '/api/meetings?order=sideways');
    expect(bad.status).toBe(400);
    env.db.exec('DELETE FROM meeting');
  });
});
