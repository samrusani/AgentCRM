import { z } from 'zod';
import { getDatasetItems } from '../providers/apify.js';
import { conflict, notFound, validationError } from '../errors.js';
import { getConnectorSecret } from '../queries/connectors.js';
import { getPerson, requirePerson } from '../queries/people.js';
import { getRun } from '../queries/runs.js';
import { type ActionContext, emitRecord, mutate, parseInput, type Tx, withTxActor } from './context.js';
import { createFieldClaimIn } from './crud.js';
import { type AdvanceResult, setCounts } from './demoResearch.js';
import { parseUpdate, updateEntityIn } from './entities.js';
import {
  advanceEnrichRun,
  dismissSuggestionsIn,
  type EnrichFlavor,
  type EnrichmentState as BaseEnrichmentState,
  type EnrichScopeBase,
  enrichmentState,
  enrichPersonActor,
  enrichPersonJobKind,
  enrichPersonKind,
  failNow,
  isEmpty,
  maxSuggestionCharacters,
  newestEnrichRun,
  notConnectedMessage,
  openStatuses,
  patchScope,
  providerFailure,
  readScope,
  readyApifyConnector,
  scheduleEnrichRun,
} from './enrichRun.js';
import { completeStep, failImportRunIn, liveStep } from './importReview.js';
import { mapProfileItem } from './leadCaptureMapping.js';
import { scrubCapturedLine } from './capture.js';
import { encodeIdentifier, normalizeProfileUrl } from './profileUrls.js';

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

interface EnrichScope extends EnrichScopeBase {
  personId: string;
  // The profile URL, frozen at start so a record edit mid run changes nothing.
  profileUrl: string;
  suggestions?: EnrichSuggestion[];
}

export const enrichByAgentMessage =
  'Profile enrichment can only be started by a person in the app, because it spends the user\'s Apify credit on one profile scrape.';

export function scheduleEnrichPersonRun(tx: Tx, runId: string, runAt: string): void {
  scheduleEnrichRun(tx, enrichPersonJobKind, runId, runAt);
}

// Start guards, checked inside the start transaction so two starts cannot both pass. Each failure is a validation
// error with a sentence a person can act on. Returns the scope the run is stored with.
export function enrichPersonStartScope(tx: Tx, personId: string): EnrichScope {
  const connector = readyApifyConnector(tx, validationError);
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

export const enrichPersonFlavor: EnrichFlavor<EnrichScope> = {
  kind: enrichPersonKind,
  actor: enrichPersonActor,
  // The same input shape the lead capture profile enrichment sends, for one profile.
  startInput: (scope) => ({ queries: [scope.profileUrl], profileUrls: [scope.profileUrl], usernames: [scope.profileUrl] }),
  read: (ctx, runId, scope) => readStep(ctx, runId, scope),
};

export const advanceEnrichPersonRun = (ctx: ActionContext, runId: string) => advanceEnrichRun(ctx, enrichPersonFlavor, runId);

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
    const encoded = encodeIdentifier(identifier.trim().slice(0, 200));
    if (encoded !== null) candidates.push(`https://www.linkedin.com/in/${encoded}`);
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


async function readStep(ctx: ActionContext, runId: string, scope: EnrichScope): Promise<AdvanceResult> {
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failNow(ctx, enrichPersonFlavor, runId, notConnectedMessage);
  if (!scope.apifyDatasetId || !scope.apifyRunId) return failNow(ctx, enrichPersonFlavor, runId, 'Apify did not report a dataset for this run.');
  let result;
  try {
    result = await getDatasetItems(token, scope.apifyDatasetId, 1);
  } catch (error) {
    return providerFailure(ctx, enrichPersonFlavor, runId, scope, token, error);
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

export type EnrichmentState = BaseEnrichmentState<EnrichField>;

// The newest enrichment run for a person, with its pending suggestions. Read only.
export function getEnrichment(ctx: Pick<ActionContext, 'db' | 'workspaceId'>, personId: string): EnrichmentState {
  requirePerson(ctx.db, ctx.workspaceId, personId);
  return enrichmentState<EnrichField>(ctx, newestEnrichRun(ctx.db, ctx.workspaceId, enrichPersonKind, 'personId', personId));
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
  if (!run || run.kind !== enrichPersonKind || readScope<EnrichScope>(run.scope).personId !== personId) throw notFound('Enrichment run');
  return run;
}

// Accepts one suggestion: writes the field through the normal update path with a claim, in one transaction.
export function acceptEnrichmentSuggestion(ctx: ActionContext, personId: string, input: unknown) {
  const data = parseInput(acceptSchema, input);
  return mutate(ctx, (tx) => {
    const person = requirePerson(tx.db, tx.workspaceId, personId);
    const run = loadRunFor(tx, personId, data.runId);
    if (run.status !== 'succeeded') throw conflict('That enrichment run did not finish successfully, so it has nothing to accept.');
    const scope = readScope<EnrichScope>(run.scope);
    const suggestions = scope.suggestions ?? [];
    const suggestion = suggestions.find((candidate) => candidate.field === data.field);
    if (!suggestion || suggestion.status !== 'pending') throw conflict('That suggestion was already accepted or dismissed.');
    const newest = newestEnrichRun(tx.db, tx.workspaceId, enrichPersonKind, 'personId', personId);
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
    dismissSuggestionsIn(tx, run, 'person', personId);
  });
}

