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
import type { Row, RunCounts } from '../records.js';
import { mapItem, normalizeName, type MappedRow } from './apifyMapping.js';
import { markConnectorError } from './connectors.js';
import { type ActionContext, mutate, type Tx, withTxActor } from './context.js';
import { finishStep, hashPayload, setCounts, startStep, type AdvanceResult } from './demoResearch.js';
import { enqueueJobIn } from './jobs.js';
import { closeImportBatchForRun, writeBatchCounts } from './importReview.js';

export const apifyKind = 'apify_scrape';
export const apifyJobKind = 'apify_run_step';
export const apifyActor = 'system:apify';
export const defaultMaxItems = 100;
export const hardMaxItems = 1000;

export const apifyStepTitles = [
  'Validate connector, actor, and input',
  'Start the Apify actor run',
  'Wait for the Apify run to finish',
  'Fetch dataset items',
  'Stage and map rows',
  'Check for duplicates',
  'Request import review',
] as const;

const reviewSampleSize = 5;
const terminalFailureStatuses = ['FAILED', 'ABORTED', 'TIMED-OUT'];

export function scheduleApifyRun(tx: Tx, runId: string, runAt: string): void {
  enqueueJobIn(tx, apifyJobKind, { runId, workspaceId: tx.workspaceId }, runAt);
}

interface ApifyScope {
  actorId: string;
  input: Record<string, unknown>;
  maxItems: number;
  apifyRunId?: string;
  apifyDatasetId?: string;
  apifyStartedAt?: string;
  apifyFinished?: boolean;
  // Set in its own transaction right before the start request, so a lost response is never retried.
  startAttemptedAt?: string;
  abortRequested?: boolean;
  batchId?: string;
  fetchStoppedEarly?: string;
}

function readScope(scope: Record<string, unknown>): ApifyScope {
  return scope as unknown as ApifyScope;
}

function patchScope(tx: Tx, runId: string, patch: Record<string, unknown>): void {
  const row = tx.db.prepare('SELECT scope FROM run WHERE id = ?').get(runId) as { scope: string };
  const merged = { ...(JSON.parse(row.scope) as Record<string, unknown>), ...patch };
  tx.db.prepare('UPDATE run SET scope = ? WHERE id = ?').run(JSON.stringify(merged), runId);
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 120) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function importCountsOf(counts: ImportCounts, requested: number): RunCounts {
  return {
    processed: counts.fetched,
    found: counts.staged,
    flagged: counts.duplicates + counts.invalid,
    requested,
    fetched: counts.fetched,
    staged: counts.staged,
    duplicates: counts.duplicates,
    invalid: counts.invalid,
    accepted: counts.accepted,
  };
}

// The running step with this seq, only while the run itself is still running.
function liveStep(tx: Tx, runId: string, seq: number) {
  const run = getRun(tx.db, tx.workspaceId, runId);
  if (!run || run.status !== 'running') return null;
  const step = listRunSteps(tx.db, runId).find((candidate) => candidate.seq === seq && candidate.status === 'running');
  return step ? { run, step } : null;
}

function completeStep(tx: Tx, runId: string, step: { id: string; seq: number }, detail: string): void {
  finishStep(tx, runId, step, detail);
  const next = listRunSteps(tx.db, runId).find((candidate) => candidate.seq > step.seq && candidate.status === 'pending');
  if (next) startStep(tx, runId, next);
  tx.emit({ type: 'run_updated', runId });
}

// Ends the run as failed, or partial when rows were already staged. Never creates or keeps invented rows.
export function failApifyRunIn(tx: Tx, runId: string, detail: string): void {
  const run = getRun(tx.db, tx.workspaceId, runId);
  if (!run || ['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status)) return;
  const batch = getImportBatchForRun(tx.db, tx.workspaceId, runId);
  const staged = batch ? batch.counts.staged : 0;
  const status = staged > 0 ? 'partial' : 'failed';
  const now = tx.now();
  tx.db.prepare('UPDATE run SET status = ?, finished_at = ? WHERE id = ?').run(status, now, runId);
  for (const step of listRunSteps(tx.db, runId)) {
    if (step.status === 'running') {
      tx.db
        .prepare("UPDATE run_step SET status = 'failed', detail = ?, finished_at = ? WHERE id = ?")
        .run(detail, now, step.id);
    } else if (step.status === 'pending') {
      tx.db.prepare("UPDATE run_step SET status = 'skipped', finished_at = ? WHERE id = ?").run(now, step.id);
    }
  }
  closeImportBatchForRun(tx, runId, 'failed', detail);
  tx.audit(`run.${status}`, 'run', runId, { message: detail });
  tx.emit({ type: 'run_updated', runId });
}

// Fails every Apify run that is still being processed. Returns their ids so the caller can stop the remote runs.
export function failActiveApifyRuns(ctx: ActionContext, detail: string): string[] {
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, apifyActor);
    const ids = (
      tx.db
        .prepare("SELECT id FROM run WHERE workspace_id = ? AND kind = ? AND status IN ('queued', 'running', 'paused')")
        .all(tx.workspaceId, apifyKind) as { id: string }[]
    ).map((row) => row.id);
    for (const id of ids) failApifyRunIn(tx, id, detail);
    return ids;
  });
}

function failNow(ctx: ActionContext, runId: string, detail: string): AdvanceResult {
  mutate(ctx, (rawTx) => failApifyRunIn(withTxActor(rawTx, apifyActor), runId, detail));
  return { nextRunAt: null };
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

// Permanent provider errors end the run with a clear sentence. Network trouble is thrown so the job retries.
function providerFailure(ctx: ActionContext, runId: string, scope: ApifyScope, token: string, error: unknown): AdvanceResult {
  if (error instanceof ApifyError && error.permanent) {
    if (error.kind === 'unauthorized') {
      markConnectorError(ctx, token);
      return failNow(ctx, runId, 'Apify rejected the saved API token. Update it in Settings and start the run again.');
    }
    if (error.kind === 'not_found') {
      return failNow(ctx, runId, `Apify could not find "${scope.actorId}" or the run. Check the actor id.`);
    }
    return failNow(ctx, runId, error.message);
  }
  throw error;
}

export function startOutcomeUnknownMessage(actorId: string): string {
  return `The start request for "${actorId}" got no usable answer from Apify, so this app cannot tell whether a run was created. It did not retry, to avoid a second charge. Check your Apify console for the actor's recent runs before starting again.`;
}

function appendStepNote(tx: Tx, runId: string, seq: number, note: string): void {
  tx.db
    .prepare(
      "UPDATE run_step SET detail = CASE WHEN detail IS NULL OR detail = '' THEN ? ELSE detail || ' ' || ? END WHERE run_id = ? AND seq = ?",
    )
    .run(note, note, runId, seq);
}

// Best effort. When a run ends as cancelled or failed while the Apify run it started may still be
// going, ask Apify to stop it so the actor stops billing. Errors are written to the step detail and
// never change the run state.
export async function abortRemoteRunIfNeeded(ctx: ActionContext, runId: string): Promise<void> {
  const run = getRun(ctx.db, ctx.workspaceId, runId);
  if (!run || run.kind !== apifyKind || (run.status !== 'cancelled' && run.status !== 'failed')) return;
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
    const tx = withTxActor(rawTx, apifyActor);
    patchScope(tx, runId, { abortRequested: true });
    appendStepNote(tx, runId, 3, note);
    tx.audit('run.apify_abort', 'run', runId, { apifyRunId: remoteId, requested });
    tx.emit({ type: 'run_updated', runId });
  });
}

// Moves one unit of work forward. Network calls happen outside transactions. A restart finds the
// Apify run id in the run scope and polls the existing run instead of starting another one.
export async function advanceApifyRun(ctx: ActionContext, runId: string): Promise<AdvanceResult> {
  const result = await advanceApifyStep(ctx, runId);
  // Any path above that ended the run as failed, and any cancel, stops the remote run too.
  await abortRemoteRunIfNeeded(ctx, runId);
  return result;
}

async function advanceApifyStep(ctx: ActionContext, runId: string): Promise<AdvanceResult> {
  const run = getRun(ctx.db, ctx.workspaceId, runId);
  if (!run || run.kind !== apifyKind) return { nextRunAt: null };
  const scope = readScope(run.scope);
  const soon = ctx.now();

  if (run.status === 'cancelled') return { nextRunAt: null };
  if (run.status === 'queued') {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, apifyActor);
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
      const tx = withTxActor(rawTx, apifyActor);
      startStep(tx, runId, pending);
      tx.emit({ type: 'run_updated', runId });
    });
    return { nextRunAt: soon };
  }

  switch (active.seq) {
    case 1:
      return validateStep(ctx, runId, scope, soon);
    case 2:
      return startActorStep(ctx, runId, scope, soon);
    case 3:
      return pollStep(ctx, runId, scope);
    case 4:
      return fetchStep(ctx, runId, scope, soon);
    case 5:
      return stageStep(ctx, runId, scope, soon);
    case 6:
      return dedupeStep(ctx, runId, soon);
    default:
      return reviewStep(ctx, runId, scope);
  }
}

function validateStep(ctx: ActionContext, runId: string, scope: ApifyScope, soon: string): AdvanceResult {
  const connector = ctx.db
    .prepare("SELECT status FROM connector WHERE workspace_id = ? AND kind = 'apify'")
    .get(ctx.workspaceId) as { status: string } | undefined;
  const problem = !connector
    ? 'Apify is not connected. Connect Apify in Settings and start the run again.'
    : connector.status !== 'connected'
      ? 'Apify rejected the saved API token. Update it in Settings and start the run again.'
      : typeof scope.actorId !== 'string' || scope.actorId.trim() === ''
        ? 'The run has no actor id.'
        : typeof scope.input !== 'object' || scope.input === null || Array.isArray(scope.input)
          ? 'The actor input must be a JSON object.'
          : !Number.isInteger(scope.maxItems) || scope.maxItems < 1 || scope.maxItems > hardMaxItems
            ? `The item limit must be between 1 and ${hardMaxItems}.`
            : null;
  if (problem) return failNow(ctx, runId, problem);
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, apifyActor);
    const live = liveStep(tx, runId, 1);
    if (!live) return { nextRunAt: null };
    completeStep(
      tx,
      runId,
      live.step,
      `Checked the Apify connection, actor ${scope.actorId}, and the input. Up to ${scope.maxItems} items.`,
    );
    return { nextRunAt: soon };
  });
}

async function startActorStep(ctx: ActionContext, runId: string, scope: ApifyScope, soon: string): Promise<AdvanceResult> {
  if (scope.apifyRunId) {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, apifyActor);
      const live = liveStep(tx, runId, 2);
      if (!live) return { nextRunAt: null };
      completeStep(tx, runId, live.step, `Found Apify run ${scope.apifyRunId} from before a restart. No second run was started.`);
      return { nextRunAt: soon };
    });
  }
  // A start was attempted but no run id was saved: the request may have created a billed run. Never post again.
  if (scope.startAttemptedAt) return failNow(ctx, runId, startOutcomeUnknownMessage(scope.actorId));

  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failNow(ctx, runId, 'Apify is not connected. Connect Apify in Settings and start the run again.');

  // Record the attempt in its own transaction before the request leaves this process.
  const marked = mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, apifyActor);
    if (!liveStep(tx, runId, 2)) return false;
    patchScope(tx, runId, { startAttemptedAt: tx.now() });
    tx.audit('run.apify_start_attempt', 'run', runId, { actorId: scope.actorId });
    return true;
  });
  if (!marked) return { nextRunAt: null };

  let started;
  try {
    started = await startApifyRun(token, scope.actorId, scope.input, {
      maxItems: scope.maxItems,
      timeoutSeconds: Math.max(1, Math.ceil(apifyTimeoutMilliseconds() / 1000)),
    });
  } catch (error) {
    if (error instanceof ApifyError && error.permanent) return providerFailure(ctx, runId, scope, token, error);
    if (error instanceof ApifyError && error.kind === 'rate_limited') {
      // Apify refused before starting anything, so a retry cannot double charge. Clear the marker and let the job retry.
      mutate(ctx, (rawTx) => patchScope(withTxActor(rawTx, apifyActor), runId, { startAttemptedAt: null }));
      throw error;
    }
    // Timeout, server error, unreadable answer, or anything else: the outcome is unknown.
    return failNow(ctx, runId, startOutcomeUnknownMessage(scope.actorId));
  }
  // Persist the Apify run id before anything else, even if the CRM run was paused or cancelled meanwhile.
  try {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, apifyActor);
      patchScope(tx, runId, {
        apifyRunId: started.id,
        apifyDatasetId: started.datasetId,
        apifyStartedAt: tx.now(),
      });
      tx.audit('run.apify_started', 'run', runId, { apifyRunId: started.id });
      const live = liveStep(tx, runId, 2);
      if (!live) return { nextRunAt: null };
      completeStep(tx, runId, live.step, `Started Apify run ${started.id} with status ${started.status}.`);
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
      runId,
      `Apify started run ${started.id}, but this app could not save it. ${stopped ? 'It was asked to stop.' : 'Check your Apify console and stop it there if it is still running.'}`,
    );
  }
}

async function pollStep(ctx: ActionContext, runId: string, scope: ApifyScope): Promise<AdvanceResult> {
  if (!scope.apifyRunId || !scope.apifyStartedAt) {
    return failNow(ctx, runId, 'The Apify run id was not saved, so the run cannot be polled.');
  }
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failNow(ctx, runId, 'Apify is not connected. Connect Apify in Settings and start the run again.');
  let remote;
  try {
    remote = await getApifyRun(token, scope.apifyRunId);
  } catch (error) {
    return providerFailure(ctx, runId, scope, token, error);
  }
  const elapsed = Date.parse(ctx.now()) - Date.parse(scope.apifyStartedAt);
  const providerStatus = remote.status.toUpperCase();

  if (terminalFailureStatuses.includes(providerStatus)) {
    const note = remote.statusMessage ? `: ${remote.statusMessage.slice(0, 300)}` : '';
    mutate(ctx, (rawTx) => patchScope(withTxActor(rawTx, apifyActor), runId, { apifyFinished: true }));
    return failNow(ctx, runId, `Apify run ended with status ${providerStatus}${note}.`);
  }

  if (providerStatus === 'SUCCEEDED') {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, apifyActor);
      const live = liveStep(tx, runId, 3);
      if (!live) return { nextRunAt: null };
      if (!remote.datasetId && !scope.apifyDatasetId) {
        patchScope(tx, runId, { apifyFinished: true });
        failApifyRunIn(tx, runId, 'Apify finished the run but did not report a dataset.');
        return { nextRunAt: null };
      }
      patchScope(tx, runId, {
        apifyFinished: true,
        apifyDatasetId: remote.datasetId ?? scope.apifyDatasetId,
      });
      completeStep(tx, runId, live.step, `Apify run ${providerStatus} after ${formatElapsed(elapsed)}.`);
      return { nextRunAt: tx.now() };
    });
  }

  if (elapsed >= apifyTimeoutMilliseconds()) {
    // The failed state is written first. The stop request follows from the abort step in advanceApifyRun.
    return failNow(
      ctx,
      runId,
      `Timed out after ${formatElapsed(elapsed)} waiting for the Apify run. Its last status was ${providerStatus}.`,
    );
  }

  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, apifyActor);
    const live = liveStep(tx, runId, 3);
    if (!live) return { nextRunAt: null };
    tx.db
      .prepare('UPDATE run_step SET detail = ? WHERE id = ?')
      .run(`Apify run status ${providerStatus}. Elapsed ${formatElapsed(elapsed)}.`, live.step.id);
    tx.audit('run.step_progress', 'run', runId, { seq: 3 });
    tx.emit({ type: 'run_updated', runId });
    return { nextRunAt: addMilliseconds(tx.now(), apifyPollMilliseconds()) };
  });
}

async function fetchStep(ctx: ActionContext, runId: string, scope: ApifyScope, soon: string): Promise<AdvanceResult> {
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failNow(ctx, runId, 'Apify is not connected. Connect Apify in Settings and start the run again.');
  if (!scope.apifyDatasetId || !scope.apifyRunId) {
    return failNow(ctx, runId, 'Apify did not report a dataset for this run.');
  }
  let result;
  try {
    result = await getDatasetItems(token, scope.apifyDatasetId, scope.maxItems);
  } catch (error) {
    return providerFailure(ctx, runId, scope, token, error);
  }
  const datasetId = scope.apifyDatasetId;
  const apifyRunId = scope.apifyRunId;
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, apifyActor);
    const live = liveStep(tx, runId, 4);
    if (!live) return { nextRunAt: null };
    const existing = getImportBatchForRun(tx.db, tx.workspaceId, runId);
    if (existing) {
      completeStep(tx, runId, live.step, `Items were already fetched into import ${existing.id}.`);
      return { nextRunAt: soon };
    }
    const batchId = tx.newId('imp');
    const now = tx.now();
    const counts: ImportCounts = { ...emptyImportCounts, fetched: result.items.length, staged: result.items.length };
    tx.db
      .prepare(
        `INSERT INTO import_batch (id, created_at, workspace_id, run_id, source_kind, source_ref, status, counts, updated_at)
         VALUES (?, ?, ?, ?, 'apify', ?, 'staging', ?, ?)`,
      )
      .run(batchId, now, tx.workspaceId, runId, JSON.stringify({ actorId: scope.actorId, apifyRunId, datasetId }), JSON.stringify(counts), now);
    const insert = tx.db.prepare(
      "INSERT INTO import_row (id, created_at, batch_id, seq, raw, mapped, status) VALUES (?, ?, ?, ?, ?, '{}', 'staged')",
    );
    result.items.forEach((item, index) => {
      const raw = typeof item === 'object' && item !== null && !Array.isArray(item) ? item : { value: item };
      insert.run(tx.newId('row'), now, batchId, index + 1, JSON.stringify(raw));
    });
    patchScope(tx, runId, {
      batchId,
      ...(result.stoppedEarly ? { fetchStoppedEarly: result.stoppedEarly } : {}),
    });
    setCounts(tx, runId, importCountsOf(counts, scope.maxItems));
    tx.audit('import.create', 'import_batch', batchId, { runId, fetched: counts.fetched });
    const stopped = result.stoppedEarly ? ` Fetching stopped early: ${result.stoppedEarly}` : '';
    completeStep(
      tx,
      runId,
      live.step,
      result.items.length === 0
        ? 'The dataset has no items.'
        : `Fetched ${result.items.length} items from the dataset (limit ${scope.maxItems}).${stopped}`,
    );
    return { nextRunAt: soon };
  });
}

function stageStep(ctx: ActionContext, runId: string, scope: ApifyScope, soon: string): AdvanceResult {
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, apifyActor);
    const live = liveStep(tx, runId, 5);
    if (!live) return { nextRunAt: null };
    const batch = getImportBatchForRun(tx.db, tx.workspaceId, runId);
    if (!batch) {
      failApifyRunIn(tx, runId, 'The import batch is missing.');
      return { nextRunAt: null };
    }
    const rows = tx.db.prepare('SELECT id, raw FROM import_row WHERE batch_id = ? ORDER BY seq').all(batch.id) as {
      id: string;
      raw: string;
    }[];
    let invalid = 0;
    const update = tx.db.prepare('UPDATE import_row SET mapped = ?, status = ?, reason = ? WHERE id = ?');
    for (const row of rows) {
      const mapped = mapItem(JSON.parse(row.raw));
      const isInvalid = mapped.name === null && mapped.email === null;
      if (isInvalid) invalid += 1;
      update.run(
        JSON.stringify(mapped),
        isInvalid ? 'invalid' : 'staged',
        isInvalid ? 'No name or email found in this item.' : null,
        row.id,
      );
    }
    const counts: ImportCounts = { ...batch.counts, invalid, staged: rows.length - invalid };
    writeBatchCounts(tx, batch.id, counts);
    setCounts(tx, runId, importCountsOf(counts, scope.maxItems));
    completeStep(
      tx,
      runId,
      live.step,
      `Mapped ${rows.length} rows. ${invalid} had no name or email and were marked invalid.`,
    );
    return { nextRunAt: soon };
  });
}

function dedupeStep(ctx: ActionContext, runId: string, soon: string): AdvanceResult {
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, apifyActor);
    const live = liveStep(tx, runId, 6);
    if (!live) return { nextRunAt: null };
    const batch = getImportBatchForRun(tx.db, tx.workspaceId, runId);
    if (!batch) {
      failApifyRunIn(tx, runId, 'The import batch is missing.');
      return { nextRunAt: null };
    }

    const peopleByEmail = new Map<string, string>();
    const peopleByNameAndOrganization = new Map<string, string>();
    for (const person of tx.db
      .prepare('SELECT id, first_name, last_name, email, organization_id FROM person WHERE workspace_id = ?')
      .all(tx.workspaceId) as Row[]) {
      if (person.email) peopleByEmail.set(String(person.email).toLowerCase(), String(person.id));
      if (person.organization_id) {
        const name = normalizeName(`${String(person.first_name)} ${String(person.last_name ?? '')}`);
        peopleByNameAndOrganization.set(`${name}|${String(person.organization_id)}`, String(person.id));
      }
    }
    const organizationsByDomain = new Map<string, string>();
    const organizationsByName = new Map<string, string>();
    for (const organization of tx.db
      .prepare('SELECT id, name, domain FROM organization WHERE workspace_id = ?')
      .all(tx.workspaceId) as Row[]) {
      if (organization.domain) organizationsByDomain.set(String(organization.domain).toLowerCase(), String(organization.id));
      organizationsByName.set(normalizeName(String(organization.name)), String(organization.id));
    }

    const rows = tx.db
      .prepare("SELECT id, seq, mapped FROM import_row WHERE batch_id = ? AND status = 'staged' ORDER BY seq")
      .all(batch.id) as { id: string; seq: number; mapped: string }[];
    const seenEmail = new Map<string, number>();
    const seenNameAndCompany = new Map<string, number>();
    let duplicates = 0;
    const markDuplicate = tx.db.prepare(
      "UPDATE import_row SET status = 'duplicate', match_entity_type = ?, match_entity_id = ?, reason = ? WHERE id = ?",
    );
    const markLink = tx.db.prepare(
      "UPDATE import_row SET match_entity_type = 'organization', match_entity_id = ?, reason = ? WHERE id = ?",
    );

    for (const row of rows) {
      const mapped = JSON.parse(row.mapped) as MappedRow;
      const organizationId =
        (mapped.domain ? organizationsByDomain.get(mapped.domain) : undefined) ??
        (mapped.company ? organizationsByName.get(normalizeName(mapped.company)) : undefined) ??
        null;
      const normalizedName = mapped.name ? normalizeName(mapped.name) : null;
      const companyKey = mapped.domain ?? (mapped.company ? normalizeName(mapped.company) : null);

      const emailMatch = mapped.email ? peopleByEmail.get(mapped.email) : undefined;
      const nameMatch =
        normalizedName && organizationId ? peopleByNameAndOrganization.get(`${normalizedName}|${organizationId}`) : undefined;
      const earlierEmail = mapped.email ? seenEmail.get(mapped.email) : undefined;
      const earlierName = normalizedName && companyKey ? seenNameAndCompany.get(`${normalizedName}|${companyKey}`) : undefined;

      if (emailMatch) {
        markDuplicate.run('person', emailMatch, 'Email matches an existing person.', row.id);
        duplicates += 1;
      } else if (nameMatch) {
        markDuplicate.run('person', nameMatch, 'Name and organization match an existing person.', row.id);
        duplicates += 1;
      } else if (earlierEmail !== undefined) {
        markDuplicate.run(null, null, `Same email as row ${earlierEmail} in this import.`, row.id);
        duplicates += 1;
      } else if (earlierName !== undefined) {
        markDuplicate.run(null, null, `Same name and organization as row ${earlierName} in this import.`, row.id);
        duplicates += 1;
      } else {
        if (mapped.email) seenEmail.set(mapped.email, row.seq);
        if (normalizedName && companyKey) seenNameAndCompany.set(`${normalizedName}|${companyKey}`, row.seq);
        if (organizationId) markLink.run(organizationId, 'The organization already exists, so the person will link to it.', row.id);
      }
    }

    const counts: ImportCounts = { ...batch.counts, duplicates, staged: batch.counts.fetched - batch.counts.invalid - duplicates };
    writeBatchCounts(tx, batch.id, counts);
    const run = live.run;
    setCounts(tx, runId, importCountsOf(counts, Number((run.scope as unknown as ApifyScope).maxItems)));
    completeStep(tx, runId, live.step, `Found ${duplicates} duplicates of existing records or earlier rows. ${counts.staged} rows are ready for review.`);
    return { nextRunAt: soon };
  });
}

function reviewStep(ctx: ActionContext, runId: string, scope: ApifyScope): AdvanceResult {
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, apifyActor);
    const live = liveStep(tx, runId, 7);
    if (!live) return { nextRunAt: null };
    const batch = getImportBatchForRun(tx.db, tx.workspaceId, runId);
    if (!batch) {
      failApifyRunIn(tx, runId, 'The import batch is missing.');
      return { nextRunAt: null };
    }
    const counts = batch.counts;
    if (counts.staged === 0) {
      const detail =
        counts.fetched === 0
          ? 'The actor returned no items, so there is nothing to review.'
          : `All ${counts.fetched} fetched rows were duplicates or invalid, so there is nothing to review.`;
      finishStep(tx, runId, live.step, detail);
      closeImportBatchForRun(tx, runId, 'failed', detail);
      tx.db.prepare("UPDATE run SET status = 'partial', finished_at = ? WHERE id = ?").run(tx.now(), runId);
      tx.audit('run.partial', 'run', runId, { reason: 'nothing_to_import' });
      tx.emit({ type: 'run_updated', runId });
      return { nextRunAt: null };
    }

    const sample = (
      tx.db
        .prepare("SELECT mapped FROM import_row WHERE batch_id = ? AND status = 'staged' ORDER BY seq LIMIT ?")
        .all(batch.id, reviewSampleSize) as { mapped: string }[]
    ).map((row) => {
      const mapped = JSON.parse(row.mapped) as MappedRow;
      return { name: mapped.name, email: mapped.email, company: mapped.company };
    });
    const payload = {
      batchId: batch.id,
      actorId: scope.actorId,
      counts: {
        fetched: counts.fetched,
        staged: counts.staged,
        duplicates: counts.duplicates,
        invalid: counts.invalid,
      },
      sample,
    };
    const serialized = JSON.stringify(payload);
    const approvalId = tx.newId('apr');
    tx.db
      .prepare(
        `INSERT INTO approval (id, created_at, workspace_id, run_id, kind, title, payload, payload_hash, status)
         VALUES (?, ?, ?, ?, 'import_review', ?, ?, ?, 'pending')`,
      )
      .run(
        approvalId,
        tx.now(),
        tx.workspaceId,
        runId,
        `Review ${counts.staged} imported ${counts.staged === 1 ? 'row' : 'rows'} from ${scope.actorId}`,
        serialized,
        hashPayload(serialized),
      );
    tx.audit('approval.create', 'approval', approvalId, { runId, kind: 'import_review' });
    tx.emit({ type: 'approval_updated', approvalId, runId });
    tx.db.prepare("UPDATE import_batch SET status = 'awaiting_review', updated_at = ? WHERE id = ?").run(tx.now(), batch.id);
    finishStep(
      tx,
      runId,
      live.step,
      `Waiting for review: ${counts.staged} to import, ${counts.duplicates} duplicates, ${counts.invalid} invalid.`,
    );
    tx.db.prepare("UPDATE run SET status = 'waiting_approval' WHERE id = ?").run(runId);
    tx.audit('run.waiting_approval', 'run', runId);
    tx.emit({ type: 'run_updated', runId });
    return { nextRunAt: null };
  });
}
