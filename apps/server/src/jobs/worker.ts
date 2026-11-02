import {
  abortRemoteRunIfNeeded,
  type ActionContext,
  advanceApifyRun,
  advanceCsvImportRun,
  advanceDemoRun,
  advanceQualifyRun,
  apifyJobKind,
  claimDueJobs,
  csvImportJobKind,
  completeJob,
  failJob,
  failRun,
  type JobRecord,
  maxJobAttempts,
  qualifyJobKind,
  recoverStaleJobs,
  rescheduleJob,
} from '../actions/index.js';
import { workerTickMilliseconds } from '../config.js';

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function runJob(ctx: ActionContext, job: JobRecord): void {
  const advance =
    job.kind === 'demo_run_step'
      ? advanceDemoRun
      : job.kind === csvImportJobKind
        ? advanceCsvImportRun
        : job.kind === qualifyJobKind
          ? advanceQualifyRun
          : null;
  if (!advance) {
    failJob(ctx, job.id);
    return;
  }
  const runId = String(job.payload.runId);
  const jobContext: ActionContext = { ...ctx, workspaceId: String(job.payload.workspaceId), actor: 'system' };
  try {
    const result = advance(jobContext, runId);
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

// Apify steps call the network, so they run on the async path below.
async function runApifyJob(ctx: ActionContext, job: JobRecord): Promise<void> {
  const runId = String(job.payload.runId);
  const jobContext: ActionContext = { ...ctx, workspaceId: String(job.payload.workspaceId), actor: 'system' };
  try {
    const result = await advanceApifyRun(jobContext, runId);
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
    // The run is failed. If it had started an Apify run, ask Apify to stop it so it stops billing.
    try {
      await abortRemoteRunIfNeeded(jobContext, runId);
    } catch {
      // Best effort. The failed state is already saved.
    }
  }
}

// Processes every simulated job that is due. Single writer: this runs on the server's event loop, one job at a time.
export function processJobs(ctx: ActionContext): number {
  const jobs = claimDueJobs(ctx, 10, { excludeKinds: [apifyJobKind] });
  for (const job of jobs) runJob(ctx, job);
  return jobs.length;
}

export async function processApifyJobs(ctx: ActionContext): Promise<number> {
  const jobs = claimDueJobs(ctx, 10, { kinds: [apifyJobKind] });
  for (const job of jobs) await runApifyJob(ctx, job);
  return jobs.length;
}

export async function processAllJobs(ctx: ActionContext): Promise<number> {
  return processJobs(ctx) + (await processApifyJobs(ctx));
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
  let apifyBusy = false;
  const timer = setInterval(() => {
    try {
      processJobs(ctx);
    } catch (error) {
      onError(error);
    }
    if (apifyBusy) return;
    apifyBusy = true;
    processApifyJobs(ctx)
      .catch(onError)
      .finally(() => {
        apifyBusy = false;
      });
  }, workerTickMilliseconds);
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
