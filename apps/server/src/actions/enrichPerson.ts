import { z } from 'zod';
import {
  abortRun as abortApifyRun,
  ApifyError,
  getDatasetItems,
  getRun as getApifyRun,
  startRun as startApifyRun,
} from '../providers/apify.js';
import { apifyPollMilliseconds, apifyTimeoutMilliseconds } from '../config.js';
import { conflict, notFound, validationError } from '../errors.js';
import { getConnector, getConnectorSecret } from '../queries/connectors.js';
import { getPerson, requirePerson } from '../queries/people.js';
import { getRun, listRunSteps } from '../queries/runs.js';
import { markConnectorError } from './connectors.js';
import { type ActionContext, emitRecord, mutate, parseInput, type Tx, withTxActor } from './context.js';
import { createFieldClaimIn } from './crud.js';
import { type AdvanceResult, setCounts, startStep } from './demoResearch.js';
import { parseUpdate, updateEntityIn } from './entities.js';
import { completeStep, failImportRunIn, liveStep } from './importReview.js';
import { enqueueJobIn } from './jobs.js';
import { mapProfileItem } from './leadCaptureMapping.js';
import { scrubCapturedLine } from './capture.js';
import { normalizeProfileUrl } from './profileUrls.js';

export const enrichPersonKind = 'enrich_person';
export const enrichPersonJobKind = 'enrich_person_step';
export const enrichPersonActor = 'system:enrich_person';

export const enrichPersonStepTitles = [
  'Start the profile scrape',
  'Wait for the profile scrape to finish',
  'Read the profile and suggest fields',
] as const;

export const enrichFields = ['title', 'location', 'email'] as const;
export type EnrichField = (typeof enrichFields)[number];

export interface EnrichSuggestion {
  field: EnrichField;
  value: string;
  status: 'pending' | 'accepted' | 'dismissed';
}

interface EnrichScope {
  personId: string;
  // The profile scraper actor and the profile URL, both frozen at start so a settings or record edit mid run changes nothing.
  actorId: string;
  profileUrl: string;
  apifyRunId?: string;
  apifyDatasetId?: string;
  apifyStartedAt?: string;
  apifyFinished?: boolean;
  // Set in its own transaction right before the start request, so a lost response is never retried.
  startAttemptedAt?: string;
  abortRequested?: boolean;
  suggestions?: EnrichSuggestion[];
}

const openStatuses = "('queued', 'running', 'paused', 'waiting_approval')";
const terminalFailureStatuses = ['FAILED', 'ABORTED', 'TIMED-OUT'];
const notConnectedMessage = 'Apify is not connected. Connect Apify in Settings and start the run again.';
const tokenRejectedMessage = 'Apify rejected the saved API token. Update it in Settings and start the run again.';

export const enrichByAgentMessage =
  'Profile enrichment can only be started by a person in the app, because it spends the user\'s Apify credit on one profile scrape.';

function readScope(scope: Record<string, unknown>): EnrichScope {
  return scope as unknown as EnrichScope;
}

export function scheduleEnrichPersonRun(tx: Tx, runId: string, runAt: string): void {
  enqueueJobIn(tx, enrichPersonJobKind, { runId, workspaceId: tx.workspaceId }, runAt);
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

// Start guards, checked inside the start transaction so two starts cannot both pass. Each failure is a validation
// error with a sentence a person can act on. Returns the scope the run is stored with.
export function enrichPersonStartScope(tx: Tx, personId: string): EnrichScope {
  const connector = getConnector(tx.db, tx.workspaceId, 'apify');
  if (!connector) throw validationError('Apify is not connected. Connect Apify in Settings first.');
  if (connector.status !== 'connected') throw validationError('Apify rejected the saved API token. Update it in Settings.');
  const person = getPerson(tx.db, tx.workspaceId, personId);
  if (!person) throw validationError('That person was not found, so there is nothing to enrich.');
  if (!person.linkedinUrl) throw validationError('Save a LinkedIn profile on this person before enriching them.');
  const open = tx.db
    .prepare(
      `SELECT 1 FROM run WHERE workspace_id = ? AND kind = ? AND json_extract(scope, '$.personId') = ? AND status IN ${openStatuses} LIMIT 1`,
    )
    .get(tx.workspaceId, enrichPersonKind, personId);
  if (open) throw validationError('An enrichment run for this person is already open. Wait for it to finish or cancel it first.');
  return { personId, actorId: connector.settings.leadCapture.profileActor, profileUrl: person.linkedinUrl };
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

// Fails every enrichment run that is still being processed. Returns their ids so the caller can stop the remote runs.
export function failActiveEnrichPersonRuns(tx: Tx, detail: string): string[] {
  const ids = (
    tx.db
      .prepare("SELECT id FROM run WHERE workspace_id = ? AND kind = ? AND status IN ('queued', 'running', 'paused')")
      .all(tx.workspaceId, enrichPersonKind) as { id: string }[]
  ).map((row) => row.id);
  for (const id of ids) failImportRunIn(withTxActor(tx, enrichPersonActor), id, detail);
  return ids;
}

function failNow(ctx: ActionContext, runId: string, detail: string): AdvanceResult {
  mutate(ctx, (rawTx) => failImportRunIn(withTxActor(rawTx, enrichPersonActor), runId, detail));
  return { nextRunAt: null };
}

// Permanent provider errors end the run with a clear sentence. Network trouble is thrown so the job retries.
function providerFailure(ctx: ActionContext, runId: string, scope: EnrichScope, token: string, error: unknown): AdvanceResult {
  if (error instanceof ApifyError && error.permanent) {
    if (error.kind === 'unauthorized') {
      markConnectorError(ctx, token);
      return failNow(ctx, runId, tokenRejectedMessage);
    }
    if (error.kind === 'not_found') {
      return failNow(ctx, runId, `Apify could not find "${scope.actorId}" or the run. Check the actor id.`);
    }
    return failNow(ctx, runId, error.message);
  }
  throw error;
}

// Best effort. When a run ends as cancelled or failed while its Apify run may still be going, ask Apify to stop it
// so the actor stops billing. The outcome goes to the step detail and never changes the run state.
export async function abortEnrichPersonRun(ctx: ActionContext, runId: string): Promise<void> {
  const run = getRun(ctx.db, ctx.workspaceId, runId);
  if (!run || run.kind !== enrichPersonKind || (run.status !== 'cancelled' && run.status !== 'failed')) return;
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
    const tx = withTxActor(rawTx, enrichPersonActor);
    patchScope(tx, runId, { abortRequested: true });
    appendStepNote(tx, runId, 2, note);
    tx.audit('run.apify_abort', 'run', runId, { apifyRunId: remoteId, requested });
    tx.emit({ type: 'run_updated', runId });
  });
}

export async function advanceEnrichPersonRun(ctx: ActionContext, runId: string): Promise<AdvanceResult> {
  const result = await advanceStep(ctx, runId);
  // Any path above that ended the run as failed, and any cancel, stops the remote run too.
  await abortEnrichPersonRun(ctx, runId);
  return result;
}

async function advanceStep(ctx: ActionContext, runId: string): Promise<AdvanceResult> {
  const run = getRun(ctx.db, ctx.workspaceId, runId);
  if (!run || run.kind !== enrichPersonKind) return { nextRunAt: null };
  const scope = readScope(run.scope);
  const soon = ctx.now();

  if (run.status === 'cancelled') return { nextRunAt: null };
  if (run.status === 'queued') {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, enrichPersonActor);
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
      const tx = withTxActor(rawTx, enrichPersonActor);
      startStep(tx, runId, pending);
      tx.emit({ type: 'run_updated', runId });
    });
    return { nextRunAt: soon };
  }
  switch (active.seq) {
    case 1:
      return startScrapeStep(ctx, runId, scope, soon);
    case 2:
      return pollStep(ctx, runId, scope);
    default:
      return readStep(ctx, runId, scope);
  }
}

async function startScrapeStep(ctx: ActionContext, runId: string, scope: EnrichScope, soon: string): Promise<AdvanceResult> {
  if (scope.apifyRunId) {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, enrichPersonActor);
      const live = liveStep(tx, runId, 1);
      if (!live) return { nextRunAt: null };
      completeStep(tx, runId, live.step, `Found Apify run ${scope.apifyRunId} from before a restart. No second run was started.`);
      return { nextRunAt: soon };
    });
  }
  // A start was attempted but no run id was saved: the request may have created a billed run. Never post again.
  if (scope.startAttemptedAt) return failNow(ctx, runId, startOutcomeUnknownMessage(scope.actorId));

  const connector = getConnector(ctx.db, ctx.workspaceId, 'apify');
  if (!connector) return failNow(ctx, runId, notConnectedMessage);
  if (connector.status !== 'connected') return failNow(ctx, runId, tokenRejectedMessage);
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failNow(ctx, runId, notConnectedMessage);

  // Record the attempt in its own transaction before the request leaves this process. The scope is read
  // again inside the transaction, so a marker or run id written since this tick began is never overwritten.
  const marked = mutate(ctx, (rawTx): 'marked' | 'already' | 'gone' => {
    const tx = withTxActor(rawTx, enrichPersonActor);
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

  // The same input shape the lead capture profile enrichment sends, for one profile.
  const urls = [scope.profileUrl];
  let started;
  try {
    started = await startApifyRun(
      token,
      scope.actorId,
      { queries: urls, profileUrls: urls, usernames: urls },
      { maxItems: 1, timeoutSeconds: Math.max(1, Math.ceil(apifyTimeoutMilliseconds() / 1000)) },
    );
  } catch (error) {
    if (error instanceof ApifyError && error.permanent) return providerFailure(ctx, runId, scope, token, error);
    if (error instanceof ApifyError && error.kind === 'rate_limited') {
      // Apify refused before starting anything, so a retry cannot double charge. Clear the marker and let the job retry.
      mutate(ctx, (rawTx) => patchScope(withTxActor(rawTx, enrichPersonActor), runId, { startAttemptedAt: null }));
      throw error;
    }
    // Timeout, server error, unreadable answer, or anything else: the outcome is unknown.
    return failNow(ctx, runId, startOutcomeUnknownMessage(scope.actorId));
  }
  // Persist the Apify run id before anything else, even if the CRM run was paused or cancelled meanwhile.
  try {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, enrichPersonActor);
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
      runId,
      `Apify started run ${started.id}, but this app could not save it. ${stopped ? 'It was asked to stop.' : 'Check your Apify console and stop it there if it is still running.'}`,
    );
  }
}

async function pollStep(ctx: ActionContext, runId: string, scope: EnrichScope): Promise<AdvanceResult> {
  if (!scope.apifyRunId || !scope.apifyStartedAt) {
    return failNow(ctx, runId, 'The Apify run id was not saved, so the run cannot be polled.');
  }
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failNow(ctx, runId, notConnectedMessage);
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
    mutate(ctx, (rawTx) => patchScope(withTxActor(rawTx, enrichPersonActor), runId, { apifyFinished: true }));
    return failNow(ctx, runId, `Apify run ended with status ${providerStatus}${note}.`);
  }

  if (providerStatus === 'SUCCEEDED') {
    return mutate(ctx, (rawTx) => {
      const tx = withTxActor(rawTx, enrichPersonActor);
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
      runId,
      `Timed out after ${formatElapsed(elapsed)} waiting for the Apify run. Its last status was ${providerStatus}.`,
    );
  }

  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, enrichPersonActor);
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
const maxSuggestionCharacters = 200;

// Keys of a scraped item that name the profile the item is about. Keys that only repeat the request input, such as
// inputUrl, are left out on purpose: an item for another profile could echo what it was asked for.
const ownProfileKeys = ['linkedinUrl', 'linkedin_url', 'profileUrl', 'profile_url', 'url'] as const;

// True when one of the item's own profile keys names the target. Ids compare without regard to case, because
// scrapers fold case; this is the only place that does.
function itemNamesTarget(item: unknown, target: string): boolean {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
  const record = item as Record<string, unknown>;
  const wanted = target.toLowerCase();
  const candidates: unknown[] = ownProfileKeys.map((key) => record[key]);
  const identifier = record.publicIdentifier;
  if (typeof identifier === 'string' && identifier.trim() !== '') {
    candidates.push(`https://www.linkedin.com/in/${encodeURIComponent(identifier.trim().slice(0, 200))}`);
  }
  return candidates.some((candidate) => normalizeProfileUrl(candidate)?.toLowerCase() === wanted);
}

// A scraped value becomes a suggestion only when it is clean text a manual edit of that field would take, and (for
// an email) when no other person already holds the address.
function suggestionValue(tx: Tx, personId: string, field: EnrichField, raw: string): string | null {
  const value = scrubCapturedLine(raw);
  if (value === '' || value.length > maxSuggestionCharacters) return null;
  try {
    parseUpdate('person', { expectedVersion: 1, fields: { [field]: value } });
  } catch {
    return null;
  }
  if (field === 'email') {
    const taken = tx.db
      .prepare('SELECT 1 FROM person WHERE workspace_id = ? AND lower(email) = ? AND id != ?')
      .get(tx.workspaceId, value.toLowerCase(), personId);
    if (taken) return null;
  }
  return value;
}

const isEmpty = (value: string | null | undefined): boolean => value === null || value === undefined || value.trim() === '';

async function readStep(ctx: ActionContext, runId: string, scope: EnrichScope): Promise<AdvanceResult> {
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failNow(ctx, runId, notConnectedMessage);
  if (!scope.apifyDatasetId || !scope.apifyRunId) return failNow(ctx, runId, 'Apify did not report a dataset for this run.');
  let result;
  try {
    result = await getDatasetItems(token, scope.apifyDatasetId, 1);
  } catch (error) {
    return providerFailure(ctx, runId, scope, token, error);
  }
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, enrichPersonActor);
    const live = liveStep(tx, runId, 3);
    if (!live) return { nextRunAt: null };
    const item = result.items[0];
    if (item === undefined) {
      failImportRunIn(tx, runId, 'The scrape returned no profile, so nothing was suggested.');
      return { nextRunAt: null };
    }
    // The item must name the profile that was asked for. A different profile's email on this person would be worse than none.
    const target = normalizeProfileUrl(scope.profileUrl);
    if (!target || !itemNamesTarget(item, target)) {
      failImportRunIn(tx, runId, `The scraped item named a different profile than ${scope.profileUrl}, so nothing was suggested.`);
      return { nextRunAt: null };
    }
    const person = getPerson(tx.db, tx.workspaceId, scope.personId);
    if (!person) {
      failImportRunIn(tx, runId, 'The person was removed while the scrape ran, so nothing was suggested.');
      return { nextRunAt: null };
    }
    const mapped = mapProfileItem(item);
    const offered = enrichFields.filter((field) => !isEmpty(mapped[field]));
    const suggestions: EnrichSuggestion[] = [];
    for (const field of offered) {
      if (!isEmpty(person[field])) continue;
      const value = suggestionValue(tx, scope.personId, field, mapped[field]!);
      if (value !== null) suggestions.push({ field, value, status: 'pending' });
    }
    patchScope(tx, runId, { suggestions });
    setCounts(tx, runId, { processed: 1, found: suggestions.length, flagged: 0 });
    const detail =
      suggestions.length > 0
        ? `Suggested ${suggestions.length} ${suggestions.length === 1 ? 'field' : 'fields'} to fill: ${suggestions.map((s) => s.field).join(', ')}.`
        : offered.length > 0
          ? 'Every field the profile offered was already filled, so nothing is suggested.'
          : 'The profile offered nothing new.';
    completeStep(tx, runId, live.step, detail);
    tx.db.prepare("UPDATE run SET status = 'succeeded', finished_at = ? WHERE id = ?").run(tx.now(), runId);
    tx.audit('run.succeeded', 'run', runId, { personId: scope.personId, suggested: suggestions.length });
    emitRecord(tx, 'person', scope.personId);
    tx.emit({ type: 'run_updated', runId });
    return { nextRunAt: null };
  });
}

// Suggestions: read, accept, dismiss

export interface EnrichmentState {
  run: { id: string; status: string; startedAt: string | null; detail: string | null; suggestedCount: number } | null;
  suggestions: { field: EnrichField; value: string }[];
}

function newestEnrichRun(db: ActionContext['db'], workspaceId: string, personId: string) {
  const row = db
    .prepare(
      `SELECT id FROM run WHERE workspace_id = ? AND kind = ? AND json_extract(scope, '$.personId') = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(workspaceId, enrichPersonKind, personId) as { id: string } | undefined;
  return row ? getRun(db, workspaceId, row.id) : null;
}

// The newest enrichment run for a person, with its pending suggestions. Read only.
export function getEnrichment(ctx: Pick<ActionContext, 'db' | 'workspaceId'>, personId: string): EnrichmentState {
  requirePerson(ctx.db, ctx.workspaceId, personId);
  const run = newestEnrichRun(ctx.db, ctx.workspaceId, personId);
  if (!run) return { run: null, suggestions: [] };
  const scope = readScope(run.scope);
  const all = scope.suggestions ?? [];
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
    suggestions: all.filter((s) => s.status === 'pending').map((s) => ({ field: s.field, value: s.value })),
  };
}

const acceptSchema = z
  .object({
    runId: z.string().trim().min(1).max(64),
    field: z.enum(enrichFields),
    expectedVersion: z.number().int().min(1),
  })
  .strict();

function loadRunFor(tx: Tx, personId: string, runId: string) {
  const run = getRun(tx.db, tx.workspaceId, runId);
  if (!run || run.kind !== enrichPersonKind || readScope(run.scope).personId !== personId) throw notFound('Enrichment run');
  return run;
}

// Accepts one suggestion: writes the field through the normal update path with a claim, in one transaction.
export function acceptEnrichmentSuggestion(ctx: ActionContext, personId: string, input: unknown) {
  const data = parseInput(acceptSchema, input);
  return mutate(ctx, (tx) => {
    const person = requirePerson(tx.db, tx.workspaceId, personId);
    const run = loadRunFor(tx, personId, data.runId);
    if (run.status !== 'succeeded') throw conflict('That enrichment run did not finish successfully, so it has nothing to accept.');
    const scope = readScope(run.scope);
    const suggestions = scope.suggestions ?? [];
    const suggestion = suggestions.find((candidate) => candidate.field === data.field);
    if (!suggestion || suggestion.status !== 'pending') throw conflict('That suggestion was already accepted or dismissed.');
    const newest = newestEnrichRun(tx.db, tx.workspaceId, personId);
    if (!newest || newest.id !== run.id) throw conflict('A newer enrichment run exists for this person, so this older one cannot be accepted.');
    if (person.linkedinUrl !== scope.profileUrl) {
      throw conflict('This person\'s LinkedIn link changed after the scrape, so its suggestions describe a different profile and were not applied.');
    }
    if (!isEmpty(person[data.field])) throw conflict(`This person already has a ${data.field}, so the suggestion was not applied.`);

    const parsed = parseUpdate('person', { expectedVersion: data.expectedVersion, fields: { [data.field]: suggestion.value } });
    const updated = updateEntityIn(tx, 'person', personId, parsed);
    createFieldClaimIn(tx, {
      entityType: 'person',
      entityId: personId,
      field: data.field,
      value: suggestion.value.slice(0, 2000),
      sourceUrl: person.linkedinUrl ?? scope.profileUrl,
      sourceType: 'apify',
      observedAt: tx.now(),
      status: 'imported',
      extractionMethod: `enrich:${scope.actorId}`.slice(0, 200),
    });
    patchScope(tx, run.id, { suggestions: suggestions.map((s) => (s === suggestion ? { ...s, status: 'accepted' } : s)) });
    tx.audit('enrichment.accept', 'person', personId, { runId: run.id, field: data.field });
    emitRecord(tx, 'person', personId);
    return updated as ReturnType<typeof requirePerson>;
  });
}

// Dismisses the run's remaining pending suggestions. Accepting and dismissing cost nothing.
export function dismissEnrichment(ctx: ActionContext, personId: string, runId: unknown): void {
  const id = parseInput(z.string().trim().min(1).max(64), runId);
  mutate(ctx, (tx) => {
    requirePerson(tx.db, tx.workspaceId, personId);
    const run = loadRunFor(tx, personId, id);
    const suggestions = readScope(run.scope).suggestions ?? [];
    const pending = suggestions.filter((s) => s.status === 'pending').length;
    if (pending === 0) return;
    patchScope(tx, run.id, { suggestions: suggestions.map((s) => (s.status === 'pending' ? { ...s, status: 'dismissed' } : s)) });
    tx.audit('enrichment.dismiss', 'person', personId, { runId: run.id, dismissed: pending });
    emitRecord(tx, 'person', personId);
  });
}
