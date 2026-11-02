import { afterAll, describe, expect, it } from 'vitest';
import {
  controlRun,
  decideApproval,
  demoCandidateEmails,
  createPerson,
  startRun,
} from '../src/actions/index.js';
import { AppError } from '../src/errors.js';
import { listActivities } from '../src/queries/activities.js';
import { listPeople } from '../src/queries/people.js';
import { getRunDetail, listApprovals } from '../src/queries/runs.js';
import { processJobs } from '../src/jobs/worker.js';
import { createTestEnvironment, driveRun } from './helpers.js';

const env = createTestEnvironment();
afterAll(() => env.cleanup());

function conflictCode(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return 'none';
}

function draftCount(): number {
  return (
    env.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'email_draft'").get() as { n: number }
  ).n;
}

describe('simulated demo run', () => {
  it('queues immediately, reaches waiting_approval, and finishes after approval', () => {
    const queued = startRun(env.ctx, { kind: 'demo_research' });
    expect(queued.status).toBe('queued');
    expect(queued.simulated).toBe(true);
    expect(queued.steps).toHaveLength(4);
    expect(queued.steps.every((step) => step.status === 'pending')).toBe(true);

    expect(driveRun(env, queued.id, ['waiting_approval'])).toBe('waiting_approval');
    const waiting = getRunDetail(env.db, env.workspaceId, queued.id);
    expect(waiting.steps.every((step) => step.status === 'done')).toBe(true);
    expect(waiting.counts.found).toBe(5);
    expect(waiting.counts.flagged).toBe(1);
    expect(waiting.approvals).toHaveLength(1);
    expect(waiting.approvals[0]!.status).toBe('pending');
    expect(waiting.approvals[0]!.kind).toBe('shortlist');
    expect(waiting.finishedAt).toBeNull();

    const candidates = listPeople(env.db, env.workspaceId, { q: 'demo-candidates.example.com' }).items;
    expect(candidates).toHaveLength(5);
    expect(candidates.every((person) => person.tags.includes('demo-candidate'))).toBe(true);
    expect(draftCount()).toBe(0);

    const approvalId = waiting.approvals[0]!.id;
    const decided = decideApproval(env.ctx, approvalId, { decision: 'approve', note: 'Fine.' });
    expect(decided.approval.status).toBe('approved');
    expect(decided.run.status).toBe('succeeded');
    expect(decided.alreadyDecided).toBe(false);
    expect(draftCount()).toBe(4);
    const drafts = listActivities(env.db, env.workspaceId, { limit: 50 }).items.filter((item) => item.kind === 'email_draft');
    expect(drafts.every((item) => item.body.startsWith('Demo draft (simulated, not sent)'))).toBe(true);
    expect(getRunDetail(env.db, env.workspaceId, queued.id).finishedAt).not.toBeNull();
  });

  it('treats a repeated decision as a no-op and refuses the opposite decision', () => {
    const run = startRun(env.ctx, { kind: 'demo_research', scope: { targetCount: 3 } });
    driveRun(env, run.id, ['waiting_approval']);
    const approvalId = getRunDetail(env.db, env.workspaceId, run.id).approvals[0]!.id;
    const before = draftCount();

    const first = decideApproval(env.ctx, approvalId, { decision: 'approve' });
    const second = decideApproval(env.ctx, approvalId, { decision: 'approve' });
    expect(first.alreadyDecided).toBe(false);
    expect(second.alreadyDecided).toBe(true);
    expect(second.approval.decidedAt).toBe(first.approval.decidedAt);
    expect(draftCount()).toBe(before + 3);
    expect(conflictCode(() => decideApproval(env.ctx, approvalId, { decision: 'reject' }))).toBe('conflict');
    expect(getRunDetail(env.db, env.workspaceId, run.id).status).toBe('succeeded');
  });

  it('cancels the run and creates no drafts when the shortlist is rejected', () => {
    const run = startRun(env.ctx, { kind: 'demo_research', scope: { targetCount: 2 } });
    driveRun(env, run.id, ['waiting_approval']);
    const approvalId = getRunDetail(env.db, env.workspaceId, run.id).approvals[0]!.id;
    const before = draftCount();
    const decided = decideApproval(env.ctx, approvalId, { decision: 'reject', note: 'Not now.' });
    expect(decided.approval.status).toBe('rejected');
    expect(decided.run.status).toBe('cancelled');
    expect(draftCount()).toBe(before);
    expect(decideApproval(env.ctx, approvalId, { decision: 'reject' }).alreadyDecided).toBe(true);
  });

  it('rejects a payload that no longer matches its hash', () => {
    const run = startRun(env.ctx, { kind: 'demo_research', scope: { targetCount: 1 } });
    driveRun(env, run.id, ['waiting_approval']);
    const approvalId = getRunDetail(env.db, env.workspaceId, run.id).approvals[0]!.id;
    env.db.prepare("UPDATE approval SET payload = replace(payload, 'shortlist', 'shortlisT') WHERE id = ?").run(approvalId);
    expect(conflictCode(() => decideApproval(env.ctx, approvalId, { decision: 'approve' }))).toBe('conflict');
    expect(getRunDetail(env.db, env.workspaceId, run.id).status).toBe('waiting_approval');
  });

  it('pauses, resumes, and cancels without stepping twice', () => {
    const run = startRun(env.ctx, { kind: 'demo_research', scope: { targetCount: 2 } });
    env.advance(1000);
    processJobs(env.ctx);
    expect(controlRun(env.ctx, run.id, { action: 'pause' }).status).toBe('paused');
    const stepsBefore = getRunDetail(env.db, env.workspaceId, run.id).steps.map((step) => step.status);
    for (let tick = 0; tick < 3; tick += 1) {
      env.advance(1000);
      processJobs(env.ctx);
    }
    expect(getRunDetail(env.db, env.workspaceId, run.id).steps.map((step) => step.status)).toEqual(stepsBefore);

    controlRun(env.ctx, run.id, { action: 'resume' });
    controlRun(env.ctx, run.id, { action: 'pause' });
    controlRun(env.ctx, run.id, { action: 'resume' });
    const jobs = env.db
      .prepare("SELECT COUNT(*) AS n FROM job WHERE status IN ('queued', 'running') AND json_extract(payload, '$.runId') = ?")
      .get(run.id) as { n: number };
    expect(jobs.n).toBe(1);
    expect(driveRun(env, run.id, ['waiting_approval'])).toBe('waiting_approval');

    const cancelled = controlRun(env.ctx, run.id, { action: 'cancel' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.approvals.map((approval) => approval.status)).toEqual(['rejected']);
    expect(conflictCode(() => controlRun(env.ctx, run.id, { action: 'resume' }))).toBe('conflict');
    expect(conflictCode(() => controlRun(env.ctx, run.id, { action: 'cancel' }))).toBe('conflict');
    expect(listApprovals(env.db, env.workspaceId, { status: 'pending' }).items.filter((approval) => approval.runId === run.id)).toHaveLength(0);
  });

  it('finishes as partial with honest counts when the name pool runs short', () => {
    const emails = demoCandidateEmails();
    const taken = emails.filter((email) => !(env.db.prepare('SELECT 1 FROM person WHERE lower(email) = ?').get(email)));
    for (const email of taken.slice(0, taken.length - 2)) {
      createPerson(env.ctx, { firstName: 'Placeholder', lastName: 'Taken', email });
    }
    const run = startRun(env.ctx, { kind: 'demo_research', scope: { targetCount: 5 } });
    driveRun(env, run.id, ['waiting_approval']);
    const waiting = getRunDetail(env.db, env.workspaceId, run.id);
    expect(waiting.counts.found).toBe(2);
    expect(waiting.steps[2]!.detail).toContain('Created 2 of 5');
    decideApproval(env.ctx, waiting.approvals[0]!.id, { decision: 'approve' });
    expect(getRunDetail(env.db, env.workspaceId, run.id).status).toBe('partial');
  });

  it('finishes as partial without an approval when nothing can be created', () => {
    const run = startRun(env.ctx, { kind: 'demo_research', scope: { targetCount: 3 } });
    expect(driveRun(env, run.id, ['partial'])).toBe('partial');
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    expect(detail.counts.found).toBe(0);
    expect(detail.approvals).toHaveLength(0);
  });

  it('emits run and approval events after commit', () => {
    const types: string[] = [];
    const stop = env.bus.subscribe((event) => types.push(event.type));
    const run = startRun(env.ctx, { kind: 'demo_research', scope: { targetCount: 1 } });
    expect(types).toContain('run_updated');
    stop();
    expect(run.id).toMatch(/^run_[0-9a-f]{12}$/);
  });
});
