import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apifyJobKind, leadCaptureJobKind } from '../src/actions/index.js';
import { processApifyJobs, processLeadCaptureJobs, startWorker } from '../src/jobs/worker.js';
import { workerTickMilliseconds } from '../src/config.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';

// The model call of a lead capture can take minutes. These tests replace the two run steps so the lead capture step
// can be held open on purpose, and check that Apify polling does not wait for it.
const held = vi.hoisted(() => ({ release: null as null | (() => void), leadSteps: 0, apifySteps: 0 }));

vi.mock('../src/actions/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/actions/index.js')>();
  return {
    ...original,
    advanceLeadCaptureRun: vi.fn(
      () =>
        new Promise((resolve) => {
          held.leadSteps += 1;
          held.release = () => resolve({ nextRunAt: null });
        }),
    ),
    advanceApifyRun: vi.fn(async () => {
      held.apifySteps += 1;
      return { nextRunAt: null };
    }),
  };
});

let env: TestEnvironment;

beforeEach(() => {
  env = createTestEnvironment();
  held.release = null;
  held.leadSteps = 0;
  held.apifySteps = 0;
});

afterEach(() => {
  vi.useRealTimers();
  env.cleanup();
});

function addJob(kind: string, id: string): void {
  const now = env.ctx.now();
  env.db
    .prepare('INSERT INTO job (id, created_at, kind, payload, run_at, attempts, status, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
    .run(id, now, kind, JSON.stringify({ runId: `run_${id}`, workspaceId: env.workspaceId }), now, 'queued', now);
}

function statusOf(id: string): string {
  return (env.db.prepare('SELECT status FROM job WHERE id = ?').get(id) as { status: string }).status;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('worker lanes for Apify imports and lead capture', () => {
  it('claims only its own kind in each lane', async () => {
    addJob(apifyJobKind, 'job_apify000001');
    addJob(leadCaptureJobKind, 'job_lead00000001');
    env.advance(10);
    const apify = processApifyJobs(env.ctx);
    // The Apify lane claimed its job and left the lead capture job queued.
    expect(statusOf('job_apify000001')).toBe('running');
    expect(statusOf('job_lead00000001')).toBe('queued');
    expect(await apify).toBe(1);
    expect(statusOf('job_apify000001')).toBe('done');

    const lead = processLeadCaptureJobs(env.ctx);
    expect(statusOf('job_lead00000001')).toBe('running');
    addJob(apifyJobKind, 'job_apify000002');
    await settle();
    // The lead capture lane never touches an Apify job, even while its own step is open.
    expect(statusOf('job_apify000002')).toBe('queued');
    held.release!();
    expect(await lead).toBe(1);
    expect(statusOf('job_lead00000001')).toBe('done');
    expect(held.apifySteps).toBe(1);
    expect(held.leadSteps).toBe(1);
  });

  it('claims a lead capture job and an Apify job due at once in the same worker interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // The lead capture job is first in line, so a shared lane would hold the Apify job behind its open step.
    addJob(leadCaptureJobKind, 'job_lead00000001');
    addJob(apifyJobKind, 'job_apify000001');
    env.advance(10);
    const errors: unknown[] = [];
    const worker = startWorker(env.ctx, (error) => errors.push(error), { recover: false, mail: false });
    try {
      await vi.advanceTimersByTimeAsync(workerTickMilliseconds);
      // The lead capture step is still open (it is holding the model call), and the Apify job already finished.
      expect(held.leadSteps).toBe(1);
      expect(statusOf('job_lead00000001')).toBe('running');
      expect(statusOf('job_apify000001')).toBe('done');
      expect(errors).toEqual([]);
    } finally {
      worker.stop();
      held.release?.();
      await settle();
    }
  });

  it('keeps polling Apify runs while a lead capture step is open, and runs one lead capture at a time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    addJob(leadCaptureJobKind, 'job_lead00000001');
    env.advance(10);
    const errors: unknown[] = [];
    const worker = startWorker(env.ctx, (error) => errors.push(error), { recover: false, mail: false });
    try {
      await vi.advanceTimersByTimeAsync(workerTickMilliseconds);
      expect(statusOf('job_lead00000001')).toBe('running');
      // A second lead capture queues behind the first. An Apify job due later is picked up on the next interval.
      addJob(leadCaptureJobKind, 'job_lead00000002');
      addJob(apifyJobKind, 'job_apify000001');
      env.advance(10);
      await vi.advanceTimersByTimeAsync(workerTickMilliseconds * 3);
      expect(statusOf('job_apify000001')).toBe('done');
      expect(statusOf('job_lead00000002')).toBe('queued');
      expect(held.leadSteps).toBe(1);
      // Releasing the first lets the lane take the second on its next interval.
      held.release!();
      await vi.advanceTimersByTimeAsync(workerTickMilliseconds * 2);
      expect(statusOf('job_lead00000001')).toBe('done');
      expect(statusOf('job_lead00000002')).toBe('running');
      expect(held.leadSteps).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      worker.stop();
      held.release?.();
      await settle();
    }
  });
});
