import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configureAnthropicConnector,
  controlRun,
  createMeeting,
  createPerson,
  decideApproval,
  deleteMeeting,
  setImportSettings,
  startTranscriptCapture,
} from '../src/actions/index.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { processAllJobs } from '../src/jobs/worker.js';
import { getRunDetail } from '../src/queries/runs.js';
import { type AnthropicStub, jsonReply, startAnthropicStub, stubApiKey, useAnthropicStub } from './anthropicStub.js';
import { createTestEnvironment, driveRunAsync } from './helpers.js';

const env = createTestEnvironment();
let anthropic: AnthropicStub;
let restoreAnthropic: () => void;
const events: DomainEvent[] = [];

const noorLine = 'Noor Ellery leads product at Quillan Labs and she pitched us last week.';
const tomasLine = 'Tomas Reyes at Fenwick Capital suggested we talk.';
const marloweLine = 'I would also point you to Marlowe Ridge Partners, a family office that backs seed rounds.';
const transcript = ['Intro call.', 'Attendees: Noor Ellery <noor.ellery@example.com>, Tomas Reyes.', tomasLine, noorLine, marloweLine].join('\n');
const answer = {
  entries: [
    { kind: 'person', name: 'Noor Ellery', title: 'Product lead', company: 'Quillan Labs', email: 'noor.ellery@example.com', quote: noorLine },
    { kind: 'person', name: 'Tomas Reyes', company: 'Fenwick Capital', quote: tomasLine },
    { kind: 'organization', name: 'Marlowe Ridge Partners', orgKind: 'fund', quote: marloweLine },
  ],
};

beforeAll(async () => {
  env.bus.subscribe((event) => events.push(event));
  anthropic = await startAnthropicStub();
  restoreAnthropic = useAnthropicStub(anthropic);
  await configureAnthropicConnector(env.ctx, { token: stubApiKey });
});

afterAll(async () => {
  await anthropic.close();
  restoreAnthropic();
  env.cleanup();
});

beforeEach(async () => {
  for (const row of env.db.prepare("SELECT id FROM run WHERE status IN ('queued', 'running', 'paused', 'waiting_approval')").all() as { id: string }[]) {
    controlRun(env.ctx, row.id, { action: 'cancel' });
  }
  await processAllJobs(env.ctx);
  env.db.exec('DELETE FROM meeting_attendee; DELETE FROM meeting; DELETE FROM field_claim; DELETE FROM person; DELETE FROM organization; DELETE FROM model_call;');
  setImportSettings(env.ctx, { autoAccept: false });
  anthropic.reset();
  anthropic.state.fallback = () => jsonReply(answer);
  events.length = 0;
});

function failure(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'none';
}

const meeting = () => createMeeting(env.ctx, { title: 'Intro call', startsAt: '2026-04-01T10:00:00Z' });
const attendeeNames = (meetingId: string) =>
  (env.db
    .prepare("SELECT p.first_name AS name FROM meeting_attendee a JOIN person p ON p.id = a.person_id WHERE a.meeting_id = ? ORDER BY p.first_name")
    .all(meetingId) as { name: string }[]).map((row) => row.name);

async function capture(extra: Record<string, unknown> = {}) {
  const run = startTranscriptCapture(env.ctx, { transcriptText: transcript, ...extra });
  await driveRunAsync(env, run.id, ['waiting_approval', 'partial', 'failed']);
  return { run, detail: getRunDetail(env.db, env.workspaceId, run.id) };
}

describe('transcript attach to a meeting', () => {
  it('validates meetingId at start: unknown, wrong shape, and cross workspace refuse and start nothing', () => {
    const runs = () => (env.db.prepare('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n;
    const before = runs();
    expect(failure(() => startTranscriptCapture(env.ctx, { transcriptText: 'x', meetingId: 'mtg_000000000000' }))).toMatch(/^not_found: /);
    expect(failure(() => startTranscriptCapture(env.ctx, { transcriptText: 'x', meetingId: '' }))).toMatch(/^validation: meetingId: /);
    expect(failure(() => startTranscriptCapture(env.ctx, { transcriptText: 'x', meetingId: 5 }))).toMatch(/^validation: meetingId: /);
    expect(runs()).toBe(before);
  });

  it('carries meetingId in the scope and keeps it after the transcript is scrubbed', async () => {
    const m = meeting();
    const { run } = await capture({ meetingId: m.id });
    const scope = JSON.parse((env.db.prepare('SELECT scope FROM run WHERE id = ?').get(run.id) as { scope: string }).scope);
    expect(scope.meetingId).toBe(m.id);
    expect(scope).not.toHaveProperty('transcriptText');
    expect(scope).not.toHaveProperty('extraction');
    expect(scope).not.toHaveProperty('extractionResult');
  });

  it('keeps meetingId when the run is rejected, and leaves the meeting alone', async () => {
    const m = meeting();
    const { run, detail } = await capture({ meetingId: m.id });
    decideApproval(env.ctx, detail.approvals[0]!.id, { decision: 'reject' });
    const scope = JSON.parse((env.db.prepare('SELECT scope FROM run WHERE id = ?').get(run.id) as { scope: string }).scope);
    expect(scope.meetingId).toBe(m.id);
    expect(attendeeNames(m.id)).toEqual([]);
  });

  it('adds the accepted people as attendees, links no organization, and emits for the meeting', async () => {
    const m = meeting();
    const { detail } = await capture({ meetingId: m.id });
    expect(attendeeNames(m.id)).toEqual([]);
    events.length = 0;
    decideApproval(env.ctx, detail.approvals[0]!.id, { decision: 'approve' });
    expect(attendeeNames(m.id)).toEqual(['Noor', 'Tomas']);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM organization WHERE name = 'Marlowe Ridge Partners'").get()).toEqual({ n: 1 });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM meeting_attendee').get()).toEqual({ n: 2 });
    expect(events.filter((event) => event.type === 'record_updated' && event.entityType === 'meeting')).toEqual([
      { type: 'record_updated', entityType: 'meeting', entityId: m.id },
    ]);
    const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'meeting.attendee_add' AND entity_id = ?").all(m.id) as { detail: string }[];
    expect(audit.map((row) => JSON.parse(row.detail).added)).toEqual([2]);
  });

  it('also links a person who was already known, and does not add twice', async () => {
    const m = meeting();
    const known = createPerson(env.ctx, { firstName: 'Noor', lastName: 'Ellery', email: 'noor.ellery@example.com' });
    env.db.prepare('INSERT INTO meeting_attendee (meeting_id, person_id, created_at) VALUES (?, ?, ?)').run(m.id, known.id, env.ctx.now());
    const { detail } = await capture({ meetingId: m.id });
    expect(detail.counts).toMatchObject({ duplicates: 1, staged: 2 });
    decideApproval(env.ctx, detail.approvals[0]!.id, { decision: 'approve' });
    expect(attendeeNames(m.id)).toEqual(['Noor', 'Tomas']);
    const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'meeting.attendee_add' AND entity_id = ?").all(m.id) as { detail: string }[];
    expect(audit.map((row) => JSON.parse(row.detail).added)).toEqual([1]);
  });

  it('links a known person matched at staging when only they are new on the meeting', async () => {
    const m = meeting();
    createPerson(env.ctx, { firstName: 'Noor', lastName: 'Ellery', email: 'noor.ellery@example.com' });
    const { detail } = await capture({ meetingId: m.id });
    decideApproval(env.ctx, detail.approvals[0]!.id, { decision: 'approve' });
    expect(attendeeNames(m.id)).toEqual(['Noor', 'Tomas']);
  });

  it('links nothing when the meeting was deleted after staging, and the accept goes on unchanged', async () => {
    const m = meeting();
    const { run, detail } = await capture({ meetingId: m.id });
    deleteMeeting(env.ctx, m.id);
    events.length = 0;
    decideApproval(env.ctx, detail.approvals[0]!.id, { decision: 'approve' });
    expect(getRunDetail(env.db, env.workspaceId, run.id).status).toBe('succeeded');
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM person WHERE first_name IN ('Noor', 'Tomas')").get()).toEqual({ n: 2 });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM meeting_attendee').get()).toEqual({ n: 0 });
    expect(events.filter((event) => event.type === 'record_updated' && event.entityType === 'meeting')).toEqual([]);
  });

  it('behaves exactly as before for a run without a meeting', async () => {
    const m = meeting();
    const { run, detail } = await capture();
    decideApproval(env.ctx, detail.approvals[0]!.id, { decision: 'approve' });
    expect(getRunDetail(env.db, env.workspaceId, run.id).status).toBe('succeeded');
    expect(attendeeNames(m.id)).toEqual([]);
    expect(JSON.parse((env.db.prepare('SELECT scope FROM run WHERE id = ?').get(run.id) as { scope: string }).scope)).not.toHaveProperty('meetingId');
  });
});
