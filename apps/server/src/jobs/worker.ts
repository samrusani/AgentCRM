import {
  abortRemoteRunIfNeeded,
  type ActionContext,
  advanceApifyRun,
  advanceCsvImportRun,
  advanceDemoRun,
  advanceDraftRun,
  advanceLeadCaptureRun,
  advanceQualifyRun,
  apifyJobKind,
  claimDueJobs,
  csvImportJobKind,
  completeJob,
  draftJobKind,
  failJob,
  failRun,
  type JobRecord,
  leadCaptureJobKind,
  mailReconcileJobKind,
  maxJobAttempts,
  processQueuedIntents,
  qualifyJobKind,
  reconcileIntent,
  recoverStaleJobs,
  recoverSubmittingIntents,
  rescheduleJob,
  syncMailIfDue,
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

// Apify and draft steps call the network, so they run on the async paths below.
async function runApifyJob(ctx: ActionContext, job: JobRecord): Promise<void> {
  const runId = String(job.payload.runId);
  const jobContext: ActionContext = { ...ctx, workspaceId: String(job.payload.workspaceId), actor: 'system' };
  try {
    const result = await (job.kind === leadCaptureJobKind ? advanceLeadCaptureRun : advanceApifyRun)(jobContext, runId);
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

async function runDraftJob(ctx: ActionContext, job: JobRecord): Promise<void> {
  const runId = String(job.payload.runId);
  const jobContext: ActionContext = { ...ctx, workspaceId: String(job.payload.workspaceId), actor: 'system' };
  try {
    const result = await advanceDraftRun(jobContext, runId);
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

// Processes every simulated job that is due. Single writer: this runs on the server's event loop, one job at a time.
export function processJobs(ctx: ActionContext): number {
  const jobs = claimDueJobs(ctx, 10, { excludeKinds: [apifyJobKind, leadCaptureJobKind, draftJobKind, mailReconcileJobKind] });
  for (const job of jobs) runJob(ctx, job);
  return jobs.length;
}

export async function processApifyJobs(ctx: ActionContext): Promise<number> {
  const jobs = claimDueJobs(ctx, 10, { kinds: [apifyJobKind, leadCaptureJobKind] });
  for (const job of jobs) await runApifyJob(ctx, job);
  return jobs.length;
}

export async function processDraftJobs(ctx: ActionContext): Promise<number> {
  const jobs = claimDueJobs(ctx, 10, { kinds: [draftJobKind] });
  for (const job of jobs) await runDraftJob(ctx, job);
  return jobs.length;
}

// Mail sending is its own lane: queued messages one at a time, then reconciliation of sends with an unknown outcome.
// The poll of the inbox is a separate lane (syncMailIfDue) because it can take several seconds.
export async function processMailJobs(ctx: ActionContext): Promise<number> {
  let handled = await processQueuedIntents(ctx);
  const jobs = claimDueJobs(ctx, 10, { kinds: [mailReconcileJobKind] });
  for (const job of jobs) {
    const jobContext: ActionContext = { ...ctx, workspaceId: String(job.payload.workspaceId), actor: 'system' };
    try {
      await reconcileIntent(jobContext, job.payload);
      completeJob(ctx, job.id);
    } catch {
      if (job.attempts < maxJobAttempts) rescheduleJob(ctx, job.id, addMilliseconds(ctx.now(), 1000 * job.attempts), false);
      else failJob(ctx, job.id);
    }
    handled += 1;
  }
  return handled;
}

export async function processAllJobs(ctx: ActionContext): Promise<number> {
  return processJobs(ctx) + (await processApifyJobs(ctx)) + (await processDraftJobs(ctx)) + (await processMailJobs(ctx));
}

export interface Worker {
  stop: () => void;
}

// Only the main server process recovers jobs left in "running" by a crash. Other processes must not.
export function startWorker(
  ctx: ActionContext,
  onError: (error: unknown) => void,
  // Only the API server sends and syncs mail. The MCP process never does, so an agent session cannot submit a message.
  options: { recover?: boolean; mail?: boolean } = {},
): Worker {
  const mail = options.mail ?? true;
  if (options.recover ?? true) {
    recoverStaleJobs(ctx);
    // A message that was on the wire when the process stopped has an unknown outcome.
    if (mail) recoverSubmittingIntents(ctx);
  }
  let apifyBusy = false;
  let draftBusy = false;
  let mailBusy = false;
  let syncBusy = false;
  const timer = setInterval(() => {
    try {
      processJobs(ctx);
    } catch (error) {
      onError(error);
    }
    if (!apifyBusy) {
      apifyBusy = true;
      processApifyJobs(ctx)
        .catch(onError)
        .finally(() => {
          apifyBusy = false;
        });
    }
    // A draft call can take up to a minute, so drafting has its own lane and never blocks Apify polling.
    if (!draftBusy) {
      draftBusy = true;
      processDraftJobs(ctx)
        .catch(onError)
        .finally(() => {
          draftBusy = false;
        });
    }
    if (mail && !mailBusy) {
      mailBusy = true;
      processMailJobs({ ...ctx, actor: 'system' })
        .catch(onError)
        .finally(() => {
          mailBusy = false;
        });
    }
    if (mail && !syncBusy) {
      syncBusy = true;
      syncMailIfDue({ ...ctx, actor: 'system' })
        .catch(onError)
        .finally(() => {
          syncBusy = false;
        });
    }
  }, workerTickMilliseconds);
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
