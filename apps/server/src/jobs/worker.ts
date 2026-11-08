import {
  abortRemoteRunIfNeeded,
  type ActionContext,
  advanceApifyRun,
  advanceCsvImportRun,
  advanceDemoRun,
  advanceDraftRun,
  advanceEnrichOrganizationRun,
  advanceEnrichPersonRun,
  advanceLeadCaptureRun,
  advanceMailboxCaptureRun,
  advanceQualifyRun,
  advanceTranscriptCaptureRun,
  apifyJobKind,
  claimDueJobs,
  csvImportJobKind,
  completeJob,
  draftJobKind,
  enrichOrganizationJobKind,
  enrichPersonJobKind,
  failJob,
  failRun,
  type JobRecord,
  leadCaptureJobKind,
  mailboxCaptureJobKind,
  mailReconcileJobKind,
  maxJobAttempts,
  newWorkerLeaseIdentity,
  processQueuedIntents,
  qualifyJobKind,
  reconcileIntent,
  recoverStaleJobs,
  recoverSubmittingIntents,
  releaseWorkerLease,
  rescheduleJob,
  settleWorkerLease,
  type SettleWorkerLeaseOptions,
  syncMailIfDue,
  transcriptCaptureJobKind,
  tickFollowupRulesIfDue,
  type WorkerLeaseIdentity,
  type WorkerLeaseKind,
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
        : job.kind === mailboxCaptureJobKind
          ? advanceMailboxCaptureRun
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
    const advance =
      job.kind === leadCaptureJobKind
        ? advanceLeadCaptureRun
        : job.kind === transcriptCaptureJobKind
          ? advanceTranscriptCaptureRun
          : job.kind === enrichPersonJobKind
          ? advanceEnrichPersonRun
          : job.kind === enrichOrganizationJobKind
            ? advanceEnrichOrganizationRun
            : advanceApifyRun;
    const result = await advance(jobContext, runId);
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
  const jobs = claimDueJobs(ctx, 10, { excludeKinds: [apifyJobKind, enrichPersonJobKind, enrichOrganizationJobKind, leadCaptureJobKind, transcriptCaptureJobKind, draftJobKind, mailReconcileJobKind] });
  for (const job of jobs) runJob(ctx, job);
  return jobs.length;
}

// Apify imports and field enrichment runs share a lane of their own: polling runs and reading datasets, which never waits on a model call.
export async function processApifyJobs(ctx: ActionContext): Promise<number> {
  const jobs = claimDueJobs(ctx, 10, { kinds: [apifyJobKind, enrichPersonJobKind, enrichOrganizationJobKind] });
  for (const job of jobs) await runApifyJob(ctx, job);
  return jobs.length;
}

// Lead capture has its own lane too. Its extraction step (step 5) makes one model call that can take up to two
// minutes, and while it runs this lane waits, but the Apify lane keeps polling its runs. A job has one kind for the
// whole run, so moving step 5 to the draft lane would need a second job kind, routing in scheduleRunJob, pause and
// resume, and cancel handling for both kinds. The tradeoff is accepted: lead captures queue behind each other, and
// behind nothing else.
export async function processLeadCaptureJobs(ctx: ActionContext): Promise<number> {
  const jobs = claimDueJobs(ctx, 10, { kinds: [leadCaptureJobKind, transcriptCaptureJobKind] });
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
  return processJobs(ctx) + (await processApifyJobs(ctx)) + (await processLeadCaptureJobs(ctx)) + (await processDraftJobs(ctx)) + (await processMailJobs(ctx));
}

export interface Worker {
  stop: () => void;
}

export interface WorkerTickOptions {
  mail?: boolean;
  // Tests pass these to fake pid liveness and a short timeout. Production uses the defaults.
  lease?: SettleWorkerLeaseOptions;
}

// One worker tick as a function, so tests can drive it without timers. The lease is settled first, and a tick that
// does not hold it does nothing at all: no lanes, no mail, no follow-ups, no sync.
export function createWorkerTick(
  ctx: ActionContext,
  identity: WorkerLeaseIdentity,
  onError: (error: unknown) => void,
  options: WorkerTickOptions = {},
): () => void {
  const mail = options.mail ?? true;
  let apifyBusy = false;
  let leadCaptureBusy = false;
  let draftBusy = false;
  let mailBusy = false;
  let syncBusy = false;
  return () => {
    try {
      if (!settleWorkerLease(ctx, identity, options.lease)) return;
    } catch (error) {
      onError(error);
      return;
    }
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
    // A lead capture model call can take up to two minutes, so lead capture has its own lane and never blocks Apify polling.
    if (!leadCaptureBusy) {
      leadCaptureBusy = true;
      processLeadCaptureJobs(ctx)
        .catch(onError)
        .finally(() => {
          leadCaptureBusy = false;
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
    // The follow-up lane is plain database work, so it runs inline. It keeps its own pace, which follows the mail poll.
    if (mail) {
      try {
        tickFollowupRulesIfDue({ ...ctx, actor: 'system' }, onError);
      } catch (error) {
        onError(error);
      }
    }
    if (mail && !syncBusy) {
      syncBusy = true;
      syncMailIfDue({ ...ctx, actor: 'system' })
        .catch(onError)
        .finally(() => {
          syncBusy = false;
        });
    }
  };
}

// Only the main server process recovers jobs left in "running" by a crash. Other processes must not.
export function startWorker(
  ctx: ActionContext,
  onError: (error: unknown) => void,
  // Only the API server sends and syncs mail. The MCP process never does, so an agent session cannot submit a message.
  // leaseKind says which kind of process this is for the worker lease; the API server is the preferred worker.
  options: { recover?: boolean; mail?: boolean; leaseKind?: WorkerLeaseKind; guard?: { check(): void } } = {},
): Worker {
  const mail = options.mail ?? true;
  if (options.recover ?? true) {
    recoverStaleJobs(ctx);
    // A message that was on the wire when the process stopped has an unknown outcome.
    if (mail) recoverSubmittingIntents(ctx);
  }
  const identity = newWorkerLeaseIdentity(options.leaseKind ?? 'server');
  const tick = createWorkerTick(ctx, identity, onError, { mail });
  let tripped = false;
  const release = (): void => {
    try {
      releaseWorkerLease(ctx, identity);
    } catch {
      // Best effort. The lease expires on its own timeout.
    }
  };
  const timer = setInterval(() => {
    if (options.guard) {
      try {
        options.guard.check();
      } catch {
        // A stale process stops for good and hands the lease to a current one.
        tripped = true;
        clearInterval(timer);
        release();
        return;
      }
    }
    tick();
  }, workerTickMilliseconds);
  return {
    stop: () => {
      clearInterval(timer);
      if (tripped) release();
      else releaseWorkerLease(ctx, identity);
    },
  };
}
