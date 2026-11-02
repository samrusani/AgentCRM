import {
  type ActionContext,
  advanceDemoRun,
  claimDueJobs,
  completeJob,
  failJob,
  failRun,
  type JobRecord,
  maxJobAttempts,
  recoverStaleJobs,
  rescheduleJob,
} from '../actions/index.js';
import { workerTickMilliseconds } from '../config.js';

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function runJob(ctx: ActionContext, job: JobRecord): void {
  if (job.kind !== 'demo_run_step') {
    failJob(ctx, job.id);
    return;
  }
  const runId = String(job.payload.runId);
  const jobContext: ActionContext = { ...ctx, workspaceId: String(job.payload.workspaceId), actor: 'system' };
  try {
    const result = advanceDemoRun(jobContext, runId);
    if (result.nextRunAt) rescheduleJob(ctx, job.id, result.nextRunAt, true);
    else completeJob(ctx, job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The step failed.';
    if (job.attempts < maxJobAttempts) {
      rescheduleJob(ctx, job.id, addMilliseconds(ctx.now(), 1000 * job.attempts), false);
      return;
    }
    failJob(ctx, job.id);
    failRun(jobContext, runId, `The run stopped after ${job.attempts} attempts: ${message}`);
  }
}

// Processes every job that is due. Single writer: this runs on the server's event loop, one job at a time.
export function processJobs(ctx: ActionContext): number {
  const jobs = claimDueJobs(ctx);
  for (const job of jobs) runJob(ctx, job);
  return jobs.length;
}

export interface Worker {
  stop: () => void;
}

// Only the main server process recovers jobs left in "running" by a crash. Other processes must not.
export function startWorker(
  ctx: ActionContext,
  onError: (error: unknown) => void,
  options: { recover?: boolean } = {},
): Worker {
  if (options.recover ?? true) recoverStaleJobs(ctx);
  const timer = setInterval(() => {
    try {
      processJobs(ctx);
    } catch (error) {
      onError(error);
    }
  }, workerTickMilliseconds);
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
