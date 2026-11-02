import {
  abortRun as abortApifyRun,
  ApifyError,
  getDatasetItems,
  getRun as getApifyRun,
  startRun as startApifyRun,
} from '../providers/apify.js';
import { apifyPollMilliseconds, apifyTimeoutMilliseconds } from '../config.js';
import { getConnectorSecret } from '../queries/connectors.js';
import { type ImportCounts, emptyImportCounts, getImportBatchForRun } from '../queries/imports.js';
import { getRun, listRunSteps } from '../queries/runs.js';
import { normalizeName, type MappedRow } from './apifyMapping.js';
import { markConnectorError } from './connectors.js';
import { type ActionContext, mutate, type Tx, withTxActor } from './context.js';
import { type AdvanceResult, setCounts, startStep } from './demoResearch.js';
import { enqueueJobIn } from './jobs.js';
import {
  completeStep,
  dedupeImportBatch,
  failImportRunIn,
  importCountsOf,
  liveStep,
  requestImportReview,
  writeBatchCounts,
} from './importReview.js';
import {
  fillEmptyFields,
  isLinkedinPostUrl,
  mapEngagementItem,
  mapProfileItem,
  normalizeProfileUrl,
  postUrlShapesMessage,
  profileItemKeys,
} from './leadCaptureMapping.js';

export const leadCaptureKind = 'lead_capture';
export const leadCaptureJobKind = 'lead_capture_step';
export const leadCaptureActor = 'system:lead_capture';
export const defaultMaxPeople = 50;
export const hardMaxPeople = 500;
export const defaultEnrichLimit = 25;
export const hardEnrichLimit = 200;

export const sourceNames = ['reactions', 'comments'] as const;
export type SourceName = (typeof sourceNames)[number];

export const leadCaptureStepTitles = [
  'Validate connector, post URL, and limits',
  'Scrape reactions through Apify',
  'Scrape comments through Apify',
  'Stage people from the post',
  'Check for duplicates',
  'Enrich new profiles through Apify',
  'Merge enriched details',
  'Request import review',
] as const;

type CallKey = 'reactions' | 'comments' | 'enrich';
const callKeys: readonly CallKey[] = ['reactions', 'comments', 'enrich'];

interface CallSpec {
  seq: number;
  // The key of the actor id in scope.actors.
  role: 'reactions' | 'comments' | 'profile';
  label: string;
}

const callSpecs: Record<CallKey, CallSpec> = {
  reactions: { seq: 2, role: 'reactions', label: 'reactions' },
  comments: { seq: 3, role: 'comments', label: 'comments' },
  enrich: { seq: 6, role: 'profile', label: 'profile enrichment' },
};

export interface CallState {
  actorId: string;
  // Set in its own transaction right before the start request, so a lost response is never retried.
  startAttemptedAt?: string;
  apifyRunId?: string;
  datasetId?: string;
  startedAt?: string;
  finished?: boolean;
  abortRequested?: boolean;
  itemCount?: number;
  // Set when the enrichment call ended without usable data. The run goes on to review without it.
  failed?: boolean;
}

export interface LeadCaptureActors {
  reactions: string;
  comments: string;
  profile: string;
}

interface LeadScope {
  postUrl: string;
  sources: SourceName[];
  maxPeople: number;
  enrich: boolean;
  enrichLimit: number;
  actors: LeadCaptureActors;
  calls: Partial<Record<CallKey, CallState>>;
  batchId?: string;
  fetchStoppedEarly?: string;
}

function readScope(scope: Record<string, unknown>): LeadScope {
  const read = scope as unknown as LeadScope;
  return { ...read, calls: read.calls ?? {} };
}

export function scheduleLeadCaptureRun(tx: Tx, runId: string, runAt: string): void {
  enqueueJobIn(tx, leadCaptureJobKind, { runId, workspaceId: tx.workspaceId }, runAt);
}

function updateScope(tx: Tx, runId: string, change: (scope: Record<string, unknown>) => void): void {
  const row = tx.db.prepare('SELECT scope FROM run WHERE id = ?').get(runId) as { scope: string };
  const scope = JSON.parse(row.scope) as Record<string, unknown>;
  change(scope);
  tx.db.prepare('UPDATE run SET scope = ? WHERE id = ?').run(JSON.stringify(scope), runId);
}

function patchScope(tx: Tx, runId: string, patch: Record<string, unknown>): void {
  updateScope(tx, runId, (scope) => Object.assign(scope, patch));
}

function patchCall(tx: Tx, runId: string, key: CallKey, patch: Partial<CallState>, clear: (keyof CallState)[] = []): void {
  updateScope(tx, runId, (scope) => {
    const calls = (scope.calls ?? {}) as Record<string, Record<string, unknown>>;
    const next: Record<string, unknown> = { ...(calls[key] ?? {}), ...patch };
    for (const field of clear) delete next[field];
    calls[key] = next;
    scope.calls = calls;
  });
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 120) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const notConnectedMessage = 'Apify is not connected. Connect Apify in Settings and start the run again.';
const tokenRejectedMessage = 'Apify rejected the saved API token. Update it in Settings and start the run again.';

export function startOutcomeUnknownMessage(actorId: string, label: string): string {
  return `The start request for "${actorId}" (${label}) got no usable answer from Apify, so this app cannot tell whether a run was created. It did not retry, to avoid a second charge. Check your Apify console for the actor's recent runs before starting again.`;
}

// Fails every lead capture run that is still being processed. Returns their ids so the caller can stop the remote runs.
export function failActiveLeadCaptureRuns(tx: Tx, detail: string): string[] {
  const ids = (
    tx.db
      .prepare("SELECT id FROM run WHERE workspace_id = ? AND kind = ? AND status IN ('queued', 'running', 'paused')")
      .all(tx.workspaceId, leadCaptureKind) as { id: string }[]
  ).map((row) => row.id);
  for (const id of ids) failImportRunIn(withTxActor(tx, leadCaptureActor), id, detail);
  return ids;
}

// True while some remote call has an Apify run id and nothing has stopped it or seen it finish.
export function hasUnfinishedCall(scope: Record<string, unknown>): boolean {
  return callKeys.some((key) => {
    const call = readScope(scope).calls[key];
    return Boolean(call?.apifyRunId) && !call?.finished && !call?.abortRequested;
  });
}

function failNow(ctx: ActionContext, runId: string, detail: string): AdvanceResult {
  mutate(ctx, (rawTx) => failImportRunIn(withTxActor(rawTx, leadCaptureActor), runId, detail));
  return { nextRunAt: null };
}

// Ends a call that cannot continue. The engagement calls fail the run. A failed enrichment call does not:
// the people already staged from the paid engagement results still go to review, without enrichment data.
async function failCall(ctx: ActionContext, runId: string, key: CallKey, detail: string): Promise<AdvanceResult> {
  if (key !== 'enrich') return failNow(ctx, runId, detail);
  const soon = ctx.now();
  const stopped = mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, leadCaptureActor);
    const live = liveStep(tx, runId, callSpecs.enrich.seq);
    if (!live) return false;
    patchCall(tx, runId, 'enrich', { failed: true });
    completeStep(tx, runId, live.step, `${detail} The people staged from the post still go to review, without enrichment data.`);
    return true;
  });
  if (!stopped) return { nextRunAt: null };
  // The run keeps going, so the stop request for a call that may still be billing is made here.
  await abortCall(ctx, runId, 'enrich');
  return { nextRunAt: soon };
}

// Permanent provider errors end the call with a clear sentence. Network trouble is thrown so the job retries.
async function providerFailure(ctx: ActionContext, runId: string, key: CallKey, actorId: string, token: string, error: unknown): Promise<AdvanceResult> {
  if (error instanceof ApifyError && error.permanent) {
    if (error.kind === 'unauthorized') {
      markConnectorError(ctx, token);
      return failCall(ctx, runId, key, tokenRejectedMessage);
    }
    if (error.kind === 'not_found') {
      return failCall(ctx, runId, key, `Apify could not find "${actorId}" or the run. Check the actor id.`);
    }
    return failCall(ctx, runId, key, error.message);
  }
  throw error;
}

function appendStepNote(tx: Tx, runId: string, seq: number, note: string): void {
  tx.db
    .prepare(
      "UPDATE run_step SET detail = CASE WHEN detail IS NULL OR detail = '' THEN ? ELSE detail || ' ' || ? END WHERE run_id = ? AND seq = ?",
    )
    .run(note, note, runId, seq);
}

// Best effort. Asks Apify to stop one call that may still be going, so the actor stops billing. The outcome is
// written to the step detail and never changes the run state.
async function abortCall(ctx: ActionContext, runId: string, key: CallKey): Promise<void> {
  const run = getRun(ctx.db, ctx.workspaceId, runId);
  if (!run || run.kind !== leadCaptureKind) return;
  const call = readScope(run.scope).calls[key];
  if (!call?.apifyRunId || call.finished || call.abortRequested) return;
  const remoteId = call.apifyRunId;
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  let requested = false;
  let note: string;
  if (!token) {
    note = `Could not ask Apify to stop run ${remoteId} because no API token is saved. Check your Apify console and stop it there if it is still running.`;
  } else {
    try {
      await abortApifyRun(token, remoteId);
      requested = true;
      note = `Asked Apify to stop run ${remoteId}.`;
    } catch (error) {
      const reason = error instanceof ApifyError ? error.message : 'Unexpected error.';
      note = `Could not ask Apify to stop run ${remoteId}: ${reason} Check your Apify console and stop it there if it is still running.`;
    }
  }
  mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, leadCaptureActor);
    patchCall(tx, runId, key, { abortRequested: true });
    appendStepNote(tx, runId, callSpecs[key].seq, note);
    tx.audit('run.apify_abort', 'run', runId, { call: key, apifyRunId: remoteId, requested });
    tx.emit({ type: 'run_updated', runId });
  });
}

// When a run ends as cancelled, failed, or partial while a remote call may still be going, ask Apify to stop
// every unfinished call.
export async function abortLeadCaptureCalls(ctx: ActionContext, runId: string): Promise<void> {
  const run = getRun(ctx.db, ctx.workspaceId, runId);
  if (!run || run.kind !== leadCaptureKind) return;
  if (run.status !== 'cancelled' && run.status !== 'failed' && run.status !== 'partial') return;
  for (const key of callKeys) await abortCall(ctx, runId, key);
}

// Moves one unit of work forward. Network calls happen outside transactions. A restart finds each
// Apify run id in the run scope and polls the existing run instead of starting another one.
export async function advanceLeadCaptureRun(ctx: ActionContext, runId: string): Promise<AdvanceResult> {
  const result = await advanceLeadCaptureStep(ctx, runId);
  // Any path above that ended the run as failed, and any cancel, stops every unfinished remote call too.
  await abortLeadCaptureCalls(ctx, runId);
  return result;
}

async function advanceLeadCaptureStep(ctx: ActionContext, runId: string): Promise<AdvanceResult> {
  const run = getRun(ctx.db, ctx.workspaceId, runId);
  if (!run || run.kind !== leadCaptureKind) return { nextRunAt: null };
  const scope = readScope(run.scope);
  const soon = ctx.now();

  if (run.status === 'cancelled') return { nextRunAt: null };
  if (run.status === 'queued') {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, leadCaptureActor);
      tx.db.prepare("UPDATE run SET status = 'running', started_at = ? WHERE id = ?").run(tx.now(), runId);
      const first = listRunSteps(tx.db, runId)[0];
      if (first) startStep(tx, runId, first);
      tx.audit('run.start', 'run', runId, { kind: run.kind });
      tx.emit({ type: 'run_updated', runId });
      return { nextRunAt: soon };
    });
  }
  if (run.status !== 'running') return { nextRunAt: null };

  const steps = listRunSteps(ctx.db, runId);
  const active = steps.find((step) => step.status === 'running');
  if (!active) {
    const pending = steps.find((step) => step.status === 'pending');
    if (!pending) return { nextRunAt: null };
    mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, leadCaptureActor);
      startStep(tx, runId, pending);
      tx.emit({ type: 'run_updated', runId });
    });
    return { nextRunAt: soon };
  }

  switch (active.seq) {
    case 1:
      return validateStep(ctx, runId, scope, soon);
    case 2:
      return callStep(ctx, runId, scope, 'reactions', soon);
    case 3:
      return callStep(ctx, runId, scope, 'comments', soon);
    case 4:
      return stageStep(ctx, runId, scope, soon);
    case 5:
      return dedupeStep(ctx, runId, soon);
    case 6:
      return callStep(ctx, runId, scope, 'enrich', soon);
    case 7:
      return mergeStep(ctx, runId, scope, soon);
    default:
      return reviewStep(ctx, runId, scope);
  }
}

function validateStep(ctx: ActionContext, runId: string, scope: LeadScope, soon: string): AdvanceResult {
  const connector = ctx.db
    .prepare("SELECT status FROM connector WHERE workspace_id = ? AND kind = 'apify'")
    .get(ctx.workspaceId) as { status: string } | undefined;
  const actorsOk = (['reactions', 'comments', 'profile'] as const).every(
    (role) => typeof scope.actors?.[role] === 'string' && scope.actors[role].trim() !== '',
  );
  const sourcesOk =
    Array.isArray(scope.sources) &&
    scope.sources.length > 0 &&
    scope.sources.every((source) => (sourceNames as readonly string[]).includes(source));
  const problem = !connector
    ? notConnectedMessage
    : connector.status !== 'connected'
      ? tokenRejectedMessage
      : !isLinkedinPostUrl(scope.postUrl)
        ? postUrlShapesMessage
        : !sourcesOk
          ? 'Choose reactions, comments, or both as sources.'
          : !Number.isInteger(scope.maxPeople) || scope.maxPeople < 1 || scope.maxPeople > hardMaxPeople
            ? `The people limit must be between 1 and ${hardMaxPeople}.`
            : typeof scope.enrich !== 'boolean'
              ? 'The enrich setting must be true or false.'
              : !Number.isInteger(scope.enrichLimit) || scope.enrichLimit < 1 || scope.enrichLimit > hardEnrichLimit
                ? `The enrichment limit must be between 1 and ${hardEnrichLimit}.`
                : !actorsOk
                  ? 'The run has no actor ids.'
                  : null;
  if (problem) return failNow(ctx, runId, problem);
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, leadCaptureActor);
    const live = liveStep(tx, runId, 1);
    if (!live) return { nextRunAt: null };
    completeStep(
      tx,
      runId,
      live.step,
      `Checked the Apify connection, the post URL, and the limits. Sources: ${scope.sources.join(' and ')}, up to ${scope.maxPeople} people each. ${
        scope.enrich ? `Enrichment is on for up to ${scope.enrichLimit} new people.` : 'Enrichment is off.'
      }`,
    );
    return { nextRunAt: soon };
  });
}

interface EnrichmentTargets {
  urls: string[];
  // Staged rows that have a profile URL, before the limit.
  eligible: number;
}

function enrichmentTargets(tx: { db: Tx['db'] }, batchId: string, limit: number): EnrichmentTargets {
  const rows = tx.db.prepare("SELECT mapped FROM import_row WHERE batch_id = ? AND status = 'staged' ORDER BY seq").all(batchId) as {
    mapped: string;
  }[];
  const urls: string[] = [];
  let eligible = 0;
  for (const row of rows) {
    const mapped = JSON.parse(row.mapped) as Partial<MappedRow>;
    if (typeof mapped.linkedinUrl !== 'string' || normalizeProfileUrl(mapped.linkedinUrl) === null) continue;
    eligible += 1;
    if (urls.length < limit) urls.push(mapped.linkedinUrl);
  }
  return { urls, eligible };
}

// Why a call is not needed, or null when it should run.
function skipReason(ctx: ActionContext, runId: string, scope: LeadScope, key: CallKey): string | null {
  if (key === 'reactions' || key === 'comments') {
    return scope.sources.includes(key) ? null : `Skipped. ${key === 'reactions' ? 'Reactions were' : 'Comments were'} not selected as a source.`;
  }
  if (!scope.enrich) return 'Skipped. Enrichment is off for this run.';
  const batch = getImportBatchForRun(ctx.db, ctx.workspaceId, runId);
  if (!batch) return 'Skipped. No people were staged, so there is nothing to enrich.';
  const targets = enrichmentTargets(ctx, batch.id, scope.enrichLimit);
  if (targets.urls.length === 0) {
    return 'Skipped. No new person with a profile URL is left to enrich, so no profile data was bought.';
  }
  return null;
}

function requestFor(ctx: ActionContext, runId: string, scope: LeadScope, key: CallKey): { input: Record<string, unknown>; maxItems: number; note: string } | null {
  if (key !== 'enrich') {
    return { input: { posts: [scope.postUrl], maxItems: scope.maxPeople }, maxItems: scope.maxPeople, note: '' };
  }
  const batch = getImportBatchForRun(ctx.db, ctx.workspaceId, runId);
  if (!batch) return null;
  const targets = enrichmentTargets(ctx, batch.id, scope.enrichLimit);
  if (targets.urls.length === 0) return null;
  const left = targets.eligible - targets.urls.length;
  return {
    input: { queries: targets.urls, profileUrls: targets.urls, usernames: targets.urls },
    maxItems: targets.urls.length,
    note: left > 0 ? ` ${plural(left, 'more new person was', 'more new people were')} not sent because of the enrichment limit of ${scope.enrichLimit}.` : '',
  };
}

// One Apify actor run for steps 2, 3, and 6. The state lives in scope.calls[key]: the start attempt marker,
// the Apify run id, and the finish flag decide what a restart does next.
async function callStep(ctx: ActionContext, runId: string, scope: LeadScope, key: CallKey, soon: string): Promise<AdvanceResult> {
  const spec = callSpecs[key];
  const call = scope.calls[key];
  if (!call?.startAttemptedAt && !call?.apifyRunId) {
    const skipped = skipReason(ctx, runId, scope, key);
    if (skipped) {
      return mutate(ctx, (rawTx) => {
        const tx = withTxActor(rawTx, leadCaptureActor);
        const live = liveStep(tx, runId, spec.seq);
        if (!live) return { nextRunAt: null };
        completeStep(tx, runId, live.step, skipped);
        return { nextRunAt: soon };
      });
    }
  }
  if (call?.apifyRunId) {
    if (call.finished) {
      return mutate(ctx, (rawTx) => {
        const tx = withTxActor(rawTx, leadCaptureActor);
        const live = liveStep(tx, runId, spec.seq);
        if (!live) return { nextRunAt: null };
        completeStep(tx, runId, live.step, `Apify run ${call.apifyRunId} had already finished.`);
        return { nextRunAt: soon };
      });
    }
    return pollCall(ctx, runId, scope, key);
  }
  // A start was attempted but no run id was saved: the request may have created a billed run. Never post again.
  if (call?.startAttemptedAt) return failCall(ctx, runId, key, startOutcomeUnknownMessage(call.actorId, spec.label));
  return startCall(ctx, runId, scope, key, soon);
}

async function startCall(ctx: ActionContext, runId: string, scope: LeadScope, key: CallKey, soon: string): Promise<AdvanceResult> {
  const spec = callSpecs[key];
  const actorId = scope.actors[spec.role];
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failCall(ctx, runId, key, notConnectedMessage);
  const request = requestFor(ctx, runId, scope, key);
  if (!request) return failCall(ctx, runId, key, 'There is nothing to send to the actor.');

  // Record the attempt in its own transaction before the request leaves this process. The scope is read
  // again inside the transaction, so a marker or run id written since this tick began is never overwritten.
  const marked = mutate(ctx, (rawTx): 'marked' | 'already' | 'gone' => {
    const tx = withTxActor(rawTx, leadCaptureActor);
    if (!liveStep(tx, runId, spec.seq)) return 'gone';
    const current = readScope(JSON.parse((tx.db.prepare('SELECT scope FROM run WHERE id = ?').get(runId) as { scope: string }).scope)).calls[key];
    if (current?.startAttemptedAt || current?.apifyRunId) return 'already';
    patchCall(tx, runId, key, { actorId, startAttemptedAt: tx.now() });
    tx.audit('run.apify_start_attempt', 'run', runId, { call: key, actorId });
    return 'marked';
  });
  if (marked === 'gone') return { nextRunAt: null };
  // Another tick got there first. Send nothing; the next tick follows the marker or run id path.
  if (marked === 'already') return { nextRunAt: soon };

  let started;
  try {
    started = await startApifyRun(token, actorId, request.input, {
      maxItems: request.maxItems,
      timeoutSeconds: Math.max(1, Math.ceil(apifyTimeoutMilliseconds() / 1000)),
    });
  } catch (error) {
    if (error instanceof ApifyError && error.permanent) return providerFailure(ctx, runId, key, actorId, token, error);
    if (error instanceof ApifyError && error.kind === 'rate_limited') {
      // Apify refused before starting anything, so a retry cannot double charge. Clear the marker and let the job retry.
      mutate(ctx, (rawTx) => patchCall(withTxActor(rawTx, leadCaptureActor), runId, key, {}, ['startAttemptedAt']));
      throw error;
    }
    // Timeout, server error, unreadable answer, or anything else: the outcome is unknown.
    return failCall(ctx, runId, key, startOutcomeUnknownMessage(actorId, spec.label));
  }
  // Persist the Apify run id before anything else, even if the CRM run was paused or cancelled meanwhile.
  try {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, leadCaptureActor);
      patchCall(tx, runId, key, { apifyRunId: started.id, datasetId: started.datasetId ?? undefined, startedAt: tx.now() });
      tx.audit('run.apify_started', 'run', runId, { call: key, apifyRunId: started.id });
      const live = liveStep(tx, runId, spec.seq);
      if (!live) return { nextRunAt: null };
      tx.db
        .prepare('UPDATE run_step SET detail = ? WHERE id = ?')
        .run(`Started Apify run ${started.id} for ${actorId} with status ${started.status}.${request.note}`, live.step.id);
      tx.emit({ type: 'run_updated', runId });
      return { nextRunAt: soon };
    });
  } catch {
    // The run exists on Apify but its id was not saved. Stop it and say so. Do not retry the start.
    let stopped = false;
    try {
      await abortApifyRun(token, started.id);
      stopped = true;
    } catch {
      stopped = false;
    }
    return failCall(
      ctx,
      runId,
      key,
      `Apify started run ${started.id}, but this app could not save it. ${stopped ? 'It was asked to stop.' : 'Check your Apify console and stop it there if it is still running.'}`,
    );
  }
}

const terminalFailureStatuses = ['FAILED', 'ABORTED', 'TIMED-OUT'];

async function pollCall(ctx: ActionContext, runId: string, scope: LeadScope, key: CallKey): Promise<AdvanceResult> {
  const spec = callSpecs[key];
  const call = scope.calls[key]!;
  if (!call.apifyRunId || !call.startedAt) {
    return failCall(ctx, runId, key, 'The Apify run id was not saved, so the run cannot be polled.');
  }
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failCall(ctx, runId, key, notConnectedMessage);
  let remote;
  try {
    remote = await getApifyRun(token, call.apifyRunId);
  } catch (error) {
    return providerFailure(ctx, runId, key, call.actorId, token, error);
  }
  const elapsed = Date.parse(ctx.now()) - Date.parse(call.startedAt);
  const providerStatus = remote.status.toUpperCase();

  if (terminalFailureStatuses.includes(providerStatus)) {
    const note = remote.statusMessage ? `: ${remote.statusMessage.slice(0, 300)}` : '';
    mutate(ctx, (rawTx) => patchCall(withTxActor(rawTx, leadCaptureActor), runId, key, { finished: true }));
    return failCall(ctx, runId, key, `Apify run for ${spec.label} ended with status ${providerStatus}${note}.`);
  }

  if (providerStatus === 'SUCCEEDED') {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, leadCaptureActor);
      const live = liveStep(tx, runId, spec.seq);
      if (!live) return { nextRunAt: null };
      const datasetId = remote.datasetId ?? call.datasetId;
      if (!datasetId) {
        patchCall(tx, runId, key, key === 'enrich' ? { finished: true, failed: true } : { finished: true });
        const missing = 'Apify finished the run but did not report a dataset.';
        if (key !== 'enrich') {
          failImportRunIn(tx, runId, missing);
          return { nextRunAt: null };
        }
        completeStep(tx, runId, live.step, `${missing} The people staged from the post still go to review, without enrichment data.`);
        return { nextRunAt: tx.now() };
      }
      patchCall(tx, runId, key, { finished: true, datasetId });
      completeStep(tx, runId, live.step, `Apify run ${call.apifyRunId} ${providerStatus} after ${formatElapsed(elapsed)}.`);
      return { nextRunAt: tx.now() };
    });
  }

  if (elapsed >= apifyTimeoutMilliseconds()) {
    // The failed state is written first. The stop request follows from the abort step in advanceLeadCaptureRun.
    return failCall(
      ctx,
      runId,
      key,
      `Timed out after ${formatElapsed(elapsed)} waiting for the Apify run for ${spec.label}. Its last status was ${providerStatus}.`,
    );
  }

  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, leadCaptureActor);
    const live = liveStep(tx, runId, spec.seq);
    if (!live) return { nextRunAt: null };
    tx.db
      .prepare('UPDATE run_step SET detail = ? WHERE id = ?')
      .run(`Apify run status ${providerStatus}. Elapsed ${formatElapsed(elapsed)}.`, live.step.id);
    tx.audit('run.step_progress', 'run', runId, { seq: spec.seq });
    tx.emit({ type: 'run_updated', runId });
    return { nextRunAt: addMilliseconds(tx.now(), apifyPollMilliseconds()) };
  });
}

type Fetched =
  | { ok: true; items: unknown[]; stoppedEarly: string | null; failure: string | null }
  | { ok: false; result: AdvanceResult };

// Dataset reads are repeatable, so each consuming step reads the dataset again after a restart.
// With `soft` set, a permanent failure comes back as `failure` instead of ending the run.
async function fetchCallItems(
  ctx: ActionContext,
  runId: string,
  token: string,
  call: CallState,
  limit: number,
  key: CallKey,
  soft = false,
): Promise<Fetched> {
  if (!call.datasetId || !call.apifyRunId) {
    const message = 'Apify did not report a dataset for this run.';
    return soft ? { ok: true, items: [], stoppedEarly: null, failure: message } : { ok: false, result: failNow(ctx, runId, message) };
  }
  try {
    const result = await getDatasetItems(token, call.datasetId, limit);
    return { ok: true, items: result.items, stoppedEarly: result.stoppedEarly, failure: null };
  } catch (error) {
    if (soft && error instanceof ApifyError && error.permanent) {
      if (error.kind === 'unauthorized') markConnectorError(ctx, token);
      return { ok: true, items: [], stoppedEarly: null, failure: error.kind === 'unauthorized' ? tokenRejectedMessage : error.message };
    }
    return { ok: false, result: await providerFailure(ctx, runId, key, call.actorId, token, error) };
  }
}

function usedActors(scope: LeadScope): Partial<LeadCaptureActors> {
  const used: Partial<LeadCaptureActors> = {};
  if (scope.calls.reactions?.apifyRunId) used.reactions = scope.actors.reactions;
  if (scope.calls.comments?.apifyRunId) used.comments = scope.actors.comments;
  if (scope.calls.enrich?.apifyRunId) used.profile = scope.actors.profile;
  return used;
}

function apifyRunIdsOf(scope: LeadScope): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const key of callKeys) {
    const id = scope.calls[key]?.apifyRunId;
    if (id) ids[key] = id;
  }
  return ids;
}

function writeSourceRef(tx: Tx, batchId: string, scope: LeadScope): void {
  const sourceRef = { postUrl: scope.postUrl, actors: usedActors(scope), apifyRunIds: apifyRunIdsOf(scope) };
  tx.db.prepare('UPDATE import_batch SET source_ref = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(sourceRef), tx.now(), batchId);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Person {
  mapped: MappedRow;
  engagement: { source: SourceName; item: unknown }[];
  sources: unknown[];
  fieldSources: Record<string, string>;
  invalid: boolean;
}

function emptyMapped(): MappedRow {
  return { name: null, firstName: null, lastName: null, email: null, company: null, domain: null, title: null, location: null, linkedinUrl: null };
}

function sourceEntry(source: SourceName, item: Record<string, unknown>): unknown {
  if (source === 'reactions') return { kind: 'reaction', reactionType: typeof item.reactionType === 'string' ? item.reactionType : null };
  return { kind: 'comment', commentary: typeof item.commentary === 'string' ? item.commentary.slice(0, 200) : '' };
}

// One person per normalized profile URL across both sources. An item without a profile URL never merges
// with anything, so two people with the same name stay two rows and the reviewer sees both.
function buildPeople(results: { source: SourceName; items: unknown[] }[]): { people: Person[]; ignored: number } {
  const byProfile = new Map<string, Person>();
  const people: Person[] = [];
  let ignored = 0;
  for (const { source, items } of results) {
    for (const item of items) {
      if (!isObject(item)) {
        ignored += 1;
        continue;
      }
      const mapped = mapEngagementItem(item);
      const profile = normalizeProfileUrl(mapped.linkedinUrl);
      let person = profile ? byProfile.get(profile) : undefined;
      if (!person) {
        person = { mapped: emptyMapped(), engagement: [], sources: [], fieldSources: {}, invalid: profile === null && !mapped.name };
        people.push(person);
        if (profile) byProfile.set(profile, person);
      }
      person.engagement.push({ source, item });
      person.sources.push(sourceEntry(source, item));
      for (const field of fillEmptyFields(person.mapped, mapped)) person.fieldSources[field] = source;
    }
  }
  return { people, ignored };
}

async function stageStep(ctx: ActionContext, runId: string, scope: LeadScope, soon: string): Promise<AdvanceResult> {
  const existing = getImportBatchForRun(ctx.db, ctx.workspaceId, runId);
  if (existing) {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, leadCaptureActor);
      const live = liveStep(tx, runId, 4);
      if (!live) return { nextRunAt: null };
      completeStep(tx, runId, live.step, `People were already staged in import ${existing.id}.`);
      return { nextRunAt: soon };
    });
  }
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failNow(ctx, runId, notConnectedMessage);

  const results: { source: SourceName; items: unknown[] }[] = [];
  const stopped: string[] = [];
  for (const source of sourceNames) {
    if (!scope.sources.includes(source)) continue;
    const call = scope.calls[source];
    if (!call) return failNow(ctx, runId, `The ${source} run was not saved, so its results cannot be read.`);
    const fetched = await fetchCallItems(ctx, runId, token, call, scope.maxPeople, source);
    if (!fetched.ok) return fetched.result;
    results.push({ source, items: fetched.items });
    if (fetched.stoppedEarly) stopped.push(`${source}: ${fetched.stoppedEarly}`);
  }

  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, leadCaptureActor);
    const live = liveStep(tx, runId, 4);
    if (!live) return { nextRunAt: null };
    const { people, ignored } = buildPeople(results);
    const invalid = people.filter((person) => person.invalid).length;
    const counts: ImportCounts = { ...emptyImportCounts, fetched: people.length, staged: people.length - invalid, invalid };
    const batchId = tx.newId('imp');
    const now = tx.now();
    tx.db
      .prepare(
        `INSERT INTO import_batch (id, created_at, workspace_id, run_id, source_kind, source_ref, status, counts, updated_at)
         VALUES (?, ?, ?, ?, 'lead_capture', '{}', 'staging', ?, ?)`,
      )
      .run(batchId, now, tx.workspaceId, runId, JSON.stringify(counts), now);
    const insert = tx.db.prepare(
      'INSERT INTO import_row (id, created_at, batch_id, seq, raw, mapped, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    people.forEach((person, index) => {
      insert.run(
        tx.newId('row'),
        now,
        batchId,
        index + 1,
        JSON.stringify({ engagement: person.engagement, sources: person.sources, fieldSources: person.fieldSources }),
        JSON.stringify(person.mapped),
        person.invalid ? 'invalid' : 'staged',
        person.invalid ? 'No name or profile URL found in this item.' : null,
      );
    });
    updateScope(tx, runId, (stored) => {
      stored.batchId = batchId;
      if (stopped.length > 0) stored.fetchStoppedEarly = stopped.join(' ');
      const calls = (stored.calls ?? {}) as Record<string, Record<string, unknown>>;
      for (const { source, items } of results) calls[source] = { ...(calls[source] ?? {}), itemCount: items.length };
      stored.calls = calls;
    });
    const fresh = readScope(JSON.parse((tx.db.prepare('SELECT scope FROM run WHERE id = ?').get(runId) as { scope: string }).scope));
    writeSourceRef(tx, batchId, fresh);
    setCounts(tx, runId, importCountsOf(counts, scope.maxPeople * scope.sources.length));
    tx.audit('import.create', 'import_batch', batchId, { runId, fetched: counts.fetched });
    const totals = results.map(({ source, items }) => plural(items.length, source === 'reactions' ? 'reaction' : 'comment', source));
    const sentence =
      people.length === 0
        ? `Fetched ${totals.join(' and ')}. No people to stage.`
        : `Fetched ${totals.join(' and ')}. Staged ${plural(counts.staged, 'unique person', 'unique people')}${invalid > 0 ? `, ${invalid} invalid` : ''}.`;
    const ignoredNote =
      ignored === 0 ? '' : ignored === 1 ? ' 1 item was not an object and was ignored.' : ` ${ignored} items were not objects and were ignored.`;
    const capNote = results.some(({ items }) => items.length >= scope.maxPeople)
      ? ' The per source cap was reached, so more engagement may exist.'
      : '';
    const extra = `${ignoredNote}${capNote}${stopped.length > 0 ? ` Fetching stopped early: ${stopped.join(' ')}` : ''}`;
    completeStep(tx, runId, live.step, `${sentence}${extra}`);
    return { nextRunAt: soon };
  });
}

function dedupeStep(ctx: ActionContext, runId: string, soon: string): AdvanceResult {
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, leadCaptureActor);
    const live = liveStep(tx, runId, 5);
    if (!live) return { nextRunAt: null };
    const batch = getImportBatchForRun(tx.db, tx.workspaceId, runId);
    if (!batch) {
      failImportRunIn(tx, runId, 'The import batch is missing.');
      return { nextRunAt: null };
    }
    const duplicates = dedupeImportBatch(tx, batch.id, { linkedin: true, pendingBatches: true });
    const counts: ImportCounts = { ...batch.counts, duplicates, staged: batch.counts.fetched - batch.counts.invalid - duplicates };
    writeBatchCounts(tx, batch.id, counts);
    const scope = readScope(live.run.scope);
    setCounts(tx, runId, importCountsOf(counts, scope.maxPeople * scope.sources.length));
    completeStep(
      tx,
      runId,
      live.step,
      `Found ${plural(duplicates, 'person who is', 'people who are')} already known. ${plural(counts.staged, 'new person is', 'new people are')} left, so known people are not enriched.`,
    );
    return { nextRunAt: soon };
  });
}

function rowCount(tx: Tx, batchId: string, status: string): number {
  return Number((tx.db.prepare('SELECT COUNT(*) AS n FROM import_row WHERE batch_id = ? AND status = ?').get(batchId, status) as { n: number }).n);
}

async function mergeStep(ctx: ActionContext, runId: string, scope: LeadScope, soon: string): Promise<AdvanceResult> {
  const call = scope.calls.enrich;
  let items: unknown[] = [];
  let stoppedEarly: string | null = null;
  let readFailure: string | null = null;
  // A call that failed, timed out, or has an unknown outcome has no data to merge.
  const usable = Boolean(call?.apifyRunId) && !call?.failed;
  if (call && usable) {
    const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
    if (token) {
      const fetched = await fetchCallItems(ctx, runId, token, call, scope.enrichLimit, 'enrich', true);
      if (!fetched.ok) return fetched.result;
      items = fetched.items;
      stoppedEarly = fetched.stoppedEarly;
      readFailure = fetched.failure;
    } else {
      readFailure = notConnectedMessage;
    }
  }
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, leadCaptureActor);
    const live = liveStep(tx, runId, 7);
    if (!live) return { nextRunAt: null };
    const batch = getImportBatchForRun(tx.db, tx.workspaceId, runId);
    if (!batch) {
      failImportRunIn(tx, runId, 'The import batch is missing.');
      return { nextRunAt: null };
    }
    const requested = scope.maxPeople * scope.sources.length;
    const finish = (counts: ImportCounts, detail: string): AdvanceResult => {
      writeBatchCounts(tx, batch.id, counts);
      setCounts(tx, runId, importCountsOf(counts, requested));
      writeSourceRef(tx, batch.id, readScope(JSON.parse((tx.db.prepare('SELECT scope FROM run WHERE id = ?').get(runId) as { scope: string }).scope)));
      completeStep(tx, runId, live.step, detail);
      return { nextRunAt: soon };
    };

    let detail = call?.failed
      ? 'No enrichment data to merge.'
      : 'Skipped. No enrichment run was made, so there is nothing to merge.';
    if (readFailure) detail = `No enrichment data to merge. The results could not be read: ${readFailure}`;
    let merged = 0;
    let newDuplicates = 0;
    if (usable && !readFailure) {
      const rows = (
        tx.db.prepare("SELECT id, raw, mapped FROM import_row WHERE batch_id = ? AND status = 'staged' ORDER BY seq").all(batch.id) as {
          id: string;
          raw: string;
          mapped: string;
        }[]
      ).map((row) => ({ id: row.id, raw: JSON.parse(row.raw) as Record<string, unknown>, mapped: JSON.parse(row.mapped) as MappedRow }));
      const byProfile = new Map<string, number[]>();
      const byName = new Map<string, number[]>();
      rows.forEach((row, index) => {
        const profile = normalizeProfileUrl(row.mapped.linkedinUrl);
        if (profile) byProfile.set(profile, [...(byProfile.get(profile) ?? []), index]);
        if (row.mapped.name) {
          const name = normalizeName(row.mapped.name);
          if (name !== '') byName.set(name, [...(byName.get(name) ?? []), index]);
        }
      });
      const used = new Set<number>();
      let unmatched = 0;
      let filledFields = 0;
      const update = tx.db.prepare('UPDATE import_row SET mapped = ?, raw = ? WHERE id = ?');
      for (const item of items) {
        if (!isObject(item)) {
          unmatched += 1;
          continue;
        }
        const keys = profileItemKeys(item);
        let target: number | undefined;
        for (const profile of keys.profiles) {
          const hit = byProfile.get(profile);
          if (hit && hit.length === 1) {
            target = hit[0];
            break;
          }
        }
        // An item that carries its own profile key matches only by that key. The name is a fallback for items with none.
        if (target === undefined && keys.profiles.length === 0 && keys.name) {
          const named = byName.get(keys.name);
          if (named && named.length === 1) target = named[0];
        }
        if (target === undefined || used.has(target)) {
          unmatched += 1;
          continue;
        }
        used.add(target);
        const row = rows[target]!;
        const filled = fillEmptyFields(row.mapped, mapProfileItem(item));
        const fieldSources = isObject(row.raw.fieldSources) ? (row.raw.fieldSources as Record<string, string>) : {};
        for (const field of filled) fieldSources[field] = 'enrich';
        row.raw.fieldSources = fieldSources;
        row.raw.enrichment = item;
        filledFields += filled.length;
        update.run(JSON.stringify(row.mapped), JSON.stringify(row.raw), row.id);
        merged += 1;
      }
      const targets = enrichmentTargets(tx, batch.id, scope.enrichLimit);
      const sent = targets.urls.length;
      const notSent = targets.eligible - sent;
      // An enriched email can reveal a person who is already in the CRM.
      newDuplicates = dedupeImportBatch(tx, batch.id, { linkedin: true, pendingBatches: true });
      detail = `Matched ${merged} of ${plural(items.length, 'enrichment item', 'enrichment items')} to staged people and filled ${plural(filledFields, 'empty field', 'empty fields')}.`;
      if (unmatched > 0) detail += ` ${plural(unmatched, 'item matched', 'items matched')} no staged person and ${unmatched === 1 ? 'was' : 'were'} dropped.`;
      if (notSent > 0) {
        detail += ` ${plural(notSent, 'more new person was', 'more new people were')} not sent because of the enrichment limit of ${scope.enrichLimit}.`;
      }
      if (sent > merged) detail += ` ${plural(sent - merged, 'sent profile', 'sent profiles')} got no usable item back.`;
      if (newDuplicates > 0) detail += ` ${plural(newDuplicates, 'person turned out to be', 'people turned out to be')} already known after enrichment.`;
      if (stoppedEarly) detail += ` Fetching stopped early: ${stoppedEarly}`;
      updateScope(tx, runId, (stored) => {
        const calls = (stored.calls ?? {}) as Record<string, Record<string, unknown>>;
        calls.enrich = { ...(calls.enrich ?? {}), itemCount: items.length };
        stored.calls = calls;
        if (stoppedEarly) stored.fetchStoppedEarly = [stored.fetchStoppedEarly, `enrich: ${stoppedEarly}`].filter(Boolean).join(' ');
      });
    }

    // A person still without a name and an email cannot become a record, so say so instead of importing "Unknown".
    const nameless = (
      tx.db.prepare("SELECT id, mapped FROM import_row WHERE batch_id = ? AND status = 'staged'").all(batch.id) as { id: string; mapped: string }[]
    ).filter((row) => {
      const mapped = JSON.parse(row.mapped) as MappedRow;
      return !mapped.name && !mapped.email;
    });
    for (const row of nameless) {
      tx.db
        .prepare("UPDATE import_row SET status = 'invalid', reason = ? WHERE id = ?")
        .run('No name or email was found for this profile, even after enrichment.', row.id);
    }
    if (nameless.length > 0) {
      detail += ` ${plural(nameless.length, 'profile has', 'profiles have')} no name or email and ${nameless.length === 1 ? 'was' : 'were'} marked invalid.`;
    }

    const counts: ImportCounts = {
      ...batch.counts,
      staged: rowCount(tx, batch.id, 'staged'),
      duplicates: rowCount(tx, batch.id, 'duplicate'),
      invalid: rowCount(tx, batch.id, 'invalid'),
    };
    return finish(counts, detail);
  });
}

function reviewStep(ctx: ActionContext, runId: string, scope: LeadScope): AdvanceResult {
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, leadCaptureActor);
    const fresh = readScope((getRun(tx.db, tx.workspaceId, runId)?.scope ?? scope) as unknown as Record<string, unknown>);
    requestImportReview(
      tx,
      runId,
      8,
      {
        emptyDetail: (counts) =>
          counts.fetched === 0
            ? 'The post has no reactions or comments from the selected sources, so there is nothing to review.'
            : `All ${plural(counts.fetched, 'person was', 'people were')} already known or could not be used, so there is nothing to review.`,
        title: (staged) => `Review ${plural(staged, 'person', 'people')} from a LinkedIn post`,
        payloadSource: { postUrl: fresh.postUrl, actors: usedActors(fresh) },
      },
      (detail) => failImportRunIn(tx, runId, detail),
    );
    return { nextRunAt: null };
  });
}
