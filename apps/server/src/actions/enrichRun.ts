import {
  abortRun as abortApifyRun,
  ApifyError,
  getRun as getApifyRun,
  minimumCapItems,
  startRun as startApifyRun,
} from '../providers/apify.js';
import { apifyPollMilliseconds, apifyTimeoutMilliseconds } from '../config.js';
import { getConnector, getConnectorSecret } from '../queries/connectors.js';
import { getRun, listRunSteps } from '../queries/runs.js';
import { markConnectorError } from './connectors.js';
import { type ActionContext, emitRecord, mutate, type Tx, withTxActor } from './context.js';
import { type AdvanceResult, startStep } from './demoResearch.js';
import { completeStep, failImportRunIn, liveStep } from './importReview.js';
import { enqueueJobIn } from './jobs.js';

// The Apify side of the field enrichment runs: start one actor run under the money discipline, poll it, and abort it
// when the CRM run ends first. Person and organization enrichment share all of it. Each kind supplies only its actor
// input and the step that reads the item (see enrichPerson.ts and enrichOrganization.ts).

export const enrichPersonKind = 'enrich_person';
export const enrichPersonJobKind = 'enrich_person_step';
export const enrichPersonActor = 'system:enrich_person';
export const enrichOrganizationKind = 'enrich_organization';
export const enrichOrganizationJobKind = 'enrich_organization_step';
export const enrichOrganizationActor = 'system:enrich_organization';

export const isEnrichKind = (kind: string): boolean => kind === enrichPersonKind || kind === enrichOrganizationKind;

export interface StoredSuggestion {
  field: string;
  value: string;
  status: 'pending' | 'accepted' | 'dismissed';
}

// Scope keys every enrichment run keeps. The actor id is frozen at start so a settings edit mid run changes nothing.
export interface EnrichScopeBase {
  actorId: string;
  apifyRunId?: string;
  apifyDatasetId?: string;
  apifyStartedAt?: string;
  apifyFinished?: boolean;
  // Set in its own transaction right before the start request, so a lost response is never retried.
  startAttemptedAt?: string;
  abortRequested?: boolean;
  suggestions?: StoredSuggestion[];
}

export interface EnrichFlavor<S extends EnrichScopeBase = EnrichScopeBase> {
  kind: string;
  // The audit and event actor of the run's own steps.
  actor: string;
  // What the actor is sent for this run's frozen target.
  startInput(scope: S): Record<string, unknown>;
  // The last step: reads the first dataset item and writes the suggestions.
  read(ctx: ActionContext, runId: string, scope: S): Promise<AdvanceResult>;
}

export const openStatuses = "('queued', 'running', 'paused', 'waiting_approval')";
const terminalFailureStatuses = ['FAILED', 'ABORTED', 'TIMED-OUT'];
export const notConnectedMessage = 'Apify is not connected. Connect Apify in Settings and start the run again.';
export const tokenRejectedMessage = 'Apify rejected the saved API token. Update it in Settings and start the run again.';

export function readScope<S extends EnrichScopeBase>(scope: Record<string, unknown>): S {
  return scope as unknown as S;
}

export function scheduleEnrichRun(tx: Tx, jobKind: string, runId: string, runAt: string): void {
  enqueueJobIn(tx, jobKind, { runId, workspaceId: tx.workspaceId }, runAt);
}

export function patchScope(tx: Tx, runId: string, patch: Record<string, unknown>): void {
  const row = tx.db.prepare('SELECT scope FROM run WHERE id = ?').get(runId) as { scope: string };
  const merged = { ...(JSON.parse(row.scope) as Record<string, unknown>), ...patch };
  tx.db.prepare('UPDATE run SET scope = ? WHERE id = ?').run(JSON.stringify(merged), runId);
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 120) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function appendStepNote(tx: Tx, runId: string, seq: number, note: string): void {
  tx.db
    .prepare(
      "UPDATE run_step SET detail = CASE WHEN detail IS NULL OR detail = '' THEN ? ELSE detail || ' ' || ? END WHERE run_id = ? AND seq = ?",
    )
    .run(note, note, runId, seq);
}

export function startOutcomeUnknownMessage(actorId: string): string {
  return `The start request for "${actorId}" got no usable answer from Apify, so this app cannot tell whether a run was created. It did not retry, to avoid a second charge. Check your Apify console for the actor's recent runs before starting again.`;
}

// The Apify connector must be ready. Throws through the given validation error factory so start guards read alike.
export function readyApifyConnector(tx: Tx, fail: (message: string) => Error) {
  const connector = getConnector(tx.db, tx.workspaceId, 'apify');
  if (!connector) throw fail('Apify is not connected. Connect Apify in Settings first.');
  if (connector.status !== 'connected') throw fail('Apify rejected the saved API token. Update it in Settings.');
  return connector;
}

// Run on cancel. If the start request was sent but no Apify run id was saved, a billed run may exist that this app
// cannot see, so the cancelled run's first step says so instead of reading like a clean cancel.
export function noteUnknownStartOnCancelIn(tx: Tx, runId: string, scope: Record<string, unknown>): void {
  const state = readScope(scope);
  if (!state.startAttemptedAt || state.apifyRunId) return;
  appendStepNote(
    tx,
    runId,
    1,
    `The start request for "${state.actorId}" may already have been sent before this cancel and no Apify run id was saved, so a run may have been started and billed and its outcome is unknown. Check your Apify console for the actor's recent runs.`,
  );
}

// Fails every enrichment run of the kind that is still being processed. Returns their ids so the caller can stop the remote runs.
export function failActiveEnrichRuns(tx: Tx, flavor: EnrichFlavor<never>, detail: string): string[] {
  const ids = (
    tx.db
      .prepare("SELECT id FROM run WHERE workspace_id = ? AND kind = ? AND status IN ('queued', 'running', 'paused')")
      .all(tx.workspaceId, flavor.kind) as { id: string }[]
  ).map((row) => row.id);
  for (const id of ids) failImportRunIn(withTxActor(tx, flavor.actor), id, detail);
  return ids;
}

export function failNow(ctx: ActionContext, flavor: EnrichFlavor<never>, runId: string, detail: string): AdvanceResult {
  mutate(ctx, (rawTx) => failImportRunIn(withTxActor(rawTx, flavor.actor), runId, detail));
  return { nextRunAt: null };
}

// Permanent provider errors end the run with a clear sentence. Network trouble is thrown so the job retries.
export function providerFailure(
  ctx: ActionContext,
  flavor: EnrichFlavor<never>,
  runId: string,
  scope: EnrichScopeBase,
  token: string,
  error: unknown,
): AdvanceResult {
  if (error instanceof ApifyError && error.permanent) {
    if (error.kind === 'unauthorized') {
      markConnectorError(ctx, token);
      return failNow(ctx, flavor, runId, tokenRejectedMessage);
    }
    if (error.kind === 'not_found') {
      return failNow(ctx, flavor, runId, `Apify could not find "${scope.actorId}" or the run. Check the actor id.`);
    }
    return failNow(ctx, flavor, runId, error.message);
  }
  throw error;
}

// Best effort. When a run ends as cancelled or failed while its Apify run may still be going, ask Apify to stop it
// so the actor stops billing. The outcome goes to the step detail and never changes the run state.
export async function abortEnrichRun(ctx: ActionContext, flavor: EnrichFlavor<never>, runId: string): Promise<void> {
  const run = getRun(ctx.db, ctx.workspaceId, runId);
  if (!run || run.kind !== flavor.kind || (run.status !== 'cancelled' && run.status !== 'failed')) return;
  const scope = readScope(run.scope);
  const remoteId = scope.apifyRunId;
  if (!remoteId || scope.apifyFinished || scope.abortRequested) return;
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
    const tx = withTxActor(rawTx, flavor.actor);
    patchScope(tx, runId, { abortRequested: true });
    appendStepNote(tx, runId, 2, note);
    tx.audit('run.apify_abort', 'run', runId, { apifyRunId: remoteId, requested });
    tx.emit({ type: 'run_updated', runId });
  });
}

export async function advanceEnrichRun<S extends EnrichScopeBase>(
  ctx: ActionContext,
  flavor: EnrichFlavor<S>,
  runId: string,
): Promise<AdvanceResult> {
  const result = await advanceStep(ctx, flavor, runId);
  // Any path above that ended the run as failed, and any cancel, stops the remote run too.
  await abortEnrichRun(ctx, flavor as EnrichFlavor<never>, runId);
  return result;
}

async function advanceStep<S extends EnrichScopeBase>(ctx: ActionContext, flavor: EnrichFlavor<S>, runId: string): Promise<AdvanceResult> {
  const run = getRun(ctx.db, ctx.workspaceId, runId);
  if (!run || run.kind !== flavor.kind) return { nextRunAt: null };
  const scope = readScope<S>(run.scope);
  const soon = ctx.now();

  if (run.status === 'cancelled') return { nextRunAt: null };
  if (run.status === 'queued') {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, flavor.actor);
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
      const tx = withTxActor(rawTx, flavor.actor);
      startStep(tx, runId, pending);
      tx.emit({ type: 'run_updated', runId });
    });
    return { nextRunAt: soon };
  }
  switch (active.seq) {
    case 1:
      return startScrapeStep(ctx, flavor, runId, scope, soon);
    case 2:
      return pollStep(ctx, flavor as EnrichFlavor<never>, runId, scope);
    default:
      return flavor.read(ctx, runId, scope);
  }
}

async function startScrapeStep<S extends EnrichScopeBase>(
  ctx: ActionContext,
  flavor: EnrichFlavor<S>,
  runId: string,
  scope: S,
  soon: string,
): Promise<AdvanceResult> {
  const never = flavor as EnrichFlavor<never>;
  if (scope.apifyRunId) {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, flavor.actor);
      const live = liveStep(tx, runId, 1);
      if (!live) return { nextRunAt: null };
      completeStep(tx, runId, live.step, `Found Apify run ${scope.apifyRunId} from before a restart. No second run was started.`);
      return { nextRunAt: soon };
    });
  }
  // A start was attempted but no run id was saved: the request may have created a billed run. Never post again.
  if (scope.startAttemptedAt) return failNow(ctx, never, runId, startOutcomeUnknownMessage(scope.actorId));

  const connector = getConnector(ctx.db, ctx.workspaceId, 'apify');
  if (!connector) return failNow(ctx, never, runId, notConnectedMessage);
  if (connector.status !== 'connected') return failNow(ctx, never, runId, tokenRejectedMessage);
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failNow(ctx, never, runId, notConnectedMessage);

  // Record the attempt in its own transaction before the request leaves this process. The scope is read
  // again inside the transaction, so a marker or run id written since this tick began is never overwritten.
  const marked = mutate(ctx, (rawTx): 'marked' | 'already' | 'gone' => {
    const tx = withTxActor(rawTx, flavor.actor);
    if (!liveStep(tx, runId, 1)) return 'gone';
    const current = readScope(JSON.parse((tx.db.prepare('SELECT scope FROM run WHERE id = ?').get(runId) as { scope: string }).scope));
    if (current.startAttemptedAt || current.apifyRunId) return 'already';
    patchScope(tx, runId, { startAttemptedAt: tx.now() });
    tx.audit('run.apify_start_attempt', 'run', runId, { actorId: scope.actorId });
    return 'marked';
  });
  if (marked === 'gone') return { nextRunAt: null };
  // Another tick got there first. Send nothing; the next tick follows the marker or run id path.
  if (marked === 'already') return { nextRunAt: soon };

  let started;
  try {
    started = await startApifyRun(token, scope.actorId, flavor.startInput(scope), {
      // One target in the input bounds the work; the floor only clears Apify's minimum charge cap.
      maxItems: minimumCapItems,
      timeoutSeconds: Math.max(1, Math.ceil(apifyTimeoutMilliseconds() / 1000)),
    });
  } catch (error) {
    if (error instanceof ApifyError && error.permanent) return providerFailure(ctx, never, runId, scope, token, error);
    if (error instanceof ApifyError && error.kind === 'rate_limited') {
      // Apify refused before starting anything, so a retry cannot double charge. Clear the marker and let the job retry.
      mutate(ctx, (rawTx) => patchScope(withTxActor(rawTx, flavor.actor), runId, { startAttemptedAt: null }));
      throw error;
    }
    // Timeout, server error, unreadable answer, or anything else: the outcome is unknown.
    return failNow(ctx, never, runId, startOutcomeUnknownMessage(scope.actorId));
  }
  // Persist the Apify run id before anything else, even if the CRM run was paused or cancelled meanwhile.
  try {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, flavor.actor);
      patchScope(tx, runId, { apifyRunId: started.id, apifyDatasetId: started.datasetId, apifyStartedAt: tx.now() });
      tx.audit('run.apify_started', 'run', runId, { apifyRunId: started.id });
      const live = liveStep(tx, runId, 1);
      if (!live) return { nextRunAt: null };
      completeStep(tx, runId, live.step, `Started Apify run ${started.id} for ${scope.actorId} with status ${started.status}.`);
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
    return failNow(
      ctx,
      never,
      runId,
      `Apify started run ${started.id}, but this app could not save it. ${stopped ? 'It was asked to stop.' : 'Check your Apify console and stop it there if it is still running.'}`,
    );
  }
}

async function pollStep(ctx: ActionContext, flavor: EnrichFlavor<never>, runId: string, scope: EnrichScopeBase): Promise<AdvanceResult> {
  if (!scope.apifyRunId || !scope.apifyStartedAt) {
    return failNow(ctx, flavor, runId, 'The Apify run id was not saved, so the run cannot be polled.');
  }
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failNow(ctx, flavor, runId, notConnectedMessage);
  let remote;
  try {
    remote = await getApifyRun(token, scope.apifyRunId);
  } catch (error) {
    return providerFailure(ctx, flavor, runId, scope, token, error);
  }
  const elapsed = Date.parse(ctx.now()) - Date.parse(scope.apifyStartedAt);
  const providerStatus = remote.status.toUpperCase();

  if (terminalFailureStatuses.includes(providerStatus)) {
    const note = remote.statusMessage ? `: ${remote.statusMessage.slice(0, 300)}` : '';
    mutate(ctx, (rawTx) => patchScope(withTxActor(rawTx, flavor.actor), runId, { apifyFinished: true }));
    return failNow(ctx, flavor, runId, `Apify run ended with status ${providerStatus}${note}.`);
  }

  if (providerStatus === 'SUCCEEDED') {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, flavor.actor);
      const live = liveStep(tx, runId, 2);
      if (!live) return { nextRunAt: null };
      if (!remote.datasetId && !scope.apifyDatasetId) {
        patchScope(tx, runId, { apifyFinished: true });
        failImportRunIn(tx, runId, 'Apify finished the run but did not report a dataset.');
        return { nextRunAt: null };
      }
      patchScope(tx, runId, { apifyFinished: true, apifyDatasetId: remote.datasetId ?? scope.apifyDatasetId });
      completeStep(tx, runId, live.step, `Apify run ${providerStatus} after ${formatElapsed(elapsed)}.`);
      return { nextRunAt: tx.now() };
    });
  }

  if (elapsed >= apifyTimeoutMilliseconds()) {
    return failNow(
      ctx,
      flavor,
      runId,
      `Timed out after ${formatElapsed(elapsed)} waiting for the Apify run. Its last status was ${providerStatus}.`,
    );
  }

  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, flavor.actor);
    const live = liveStep(tx, runId, 2);
    if (!live) return { nextRunAt: null };
    tx.db
      .prepare('UPDATE run_step SET detail = ? WHERE id = ?')
      .run(`Apify run status ${providerStatus}. Elapsed ${formatElapsed(elapsed)}.`, live.step.id);
    tx.audit('run.step_progress', 'run', runId, { seq: 2 });
    tx.emit({ type: 'run_updated', runId });
    return { nextRunAt: addMilliseconds(tx.now(), apifyPollMilliseconds()) };
  });
}

// The longest suggestion value kept. Scraped text is untrusted and a profile field never needs more.
export const maxSuggestionCharacters = 200;

export const isEmpty = (value: string | null | undefined): boolean => value === null || value === undefined || value.trim() === '';

// Suggestions: read and dismiss, the same for every enrichment kind

export interface EnrichmentState<F extends string = string> {
  run: { id: string; status: string; startedAt: string | null; detail: string | null; suggestedCount: number } | null;
  suggestions: { field: F; value: string }[];
}

export function newestEnrichRun(db: ActionContext['db'], workspaceId: string, kind: string, scopeKey: string, entityId: string) {
  const row = db
    .prepare(
      `SELECT id FROM run WHERE workspace_id = ? AND kind = ? AND json_extract(scope, '$.${scopeKey}') = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(workspaceId, kind, entityId) as { id: string } | undefined;
  return row ? getRun(db, workspaceId, row.id) : null;
}

// The newest run's state with its pending suggestions. The caller has already checked the entity exists.
export function enrichmentState<F extends string>(
  ctx: Pick<ActionContext, 'db' | 'workspaceId'>,
  run: ReturnType<typeof getRun>,
): EnrichmentState<F> {
  if (!run) return { run: null, suggestions: [] };
  const all = readScope(run.scope).suggestions ?? [];
  const terminal = ['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status);
  // The final step's detail on success, the failing step's detail on failure, null while the run is open.
  const steps = listRunSteps(ctx.db, run.id);
  const last =
    run.status === 'succeeded'
      ? steps[steps.length - 1]
      : steps.find((step) => step.status === 'failed') ?? [...steps].reverse().find((step) => step.detail);
  return {
    run: {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      detail: terminal ? (last?.detail ?? null) : null,
      suggestedCount: all.length,
    },
    suggestions: all.filter((s) => s.status === 'pending').map((s) => ({ field: s.field as F, value: s.value })),
  };
}

// Dismisses a run's remaining pending suggestions. Accepting and dismissing cost nothing.
export function dismissSuggestionsIn(
  tx: Tx,
  run: NonNullable<ReturnType<typeof getRun>>,
  entityType: 'person' | 'organization',
  entityId: string,
): void {
  const suggestions = readScope(run.scope).suggestions ?? [];
  const pending = suggestions.filter((s) => s.status === 'pending').length;
  if (pending === 0) return;
  patchScope(tx, run.id, { suggestions: suggestions.map((s) => (s.status === 'pending' ? { ...s, status: 'dismissed' } : s)) });
  tx.audit('enrichment.dismiss', entityType, entityId, { runId: run.id, dismissed: pending });
  emitRecord(tx, entityType, entityId);
}
