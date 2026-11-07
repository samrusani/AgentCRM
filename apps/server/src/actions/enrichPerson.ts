import { z } from 'zod';
import { getDatasetItems, minimumCapItems } from '../providers/apify.js';
import { conflict, notFound, validationError } from '../errors.js';
import { getConnectorSecret } from '../queries/connectors.js';
import { getPerson, requirePerson } from '../queries/people.js';
import { getRun } from '../queries/runs.js';
import { type ActionContext, emitRecord, mutate, parseInput, type Tx, withTxActor } from './context.js';
import { createFieldClaimIn } from './crud.js';
import { type AdvanceResult, setCounts } from './demoResearch.js';
import { assertLinkedinAvailable, parseUpdate, personHoldingLinkedin, updateEntityIn } from './entities.js';
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
import { canonicalPersonLinkedinUrl, encodeIdentifier, normalizeProfileUrl } from './profileUrls.js';
import { clean, fieldAliases, pick, pickLocation } from './apifyMapping.js';

// Person enrichment: one Apify call, suggestions a person accepts one by one. The mode is decided at start by the
// saved LinkedIn link and frozen into the run scope. Profile mode scrapes that profile and checks the item against
// it. Name mode searches LinkedIn by the person's name: the first result is the candidate, no identity check is
// possible, and the step detail names who was found so a person judges the match before accepting anything.

export const enrichPersonStepTitles = [
  'Start the profile scrape',
  'Wait for the profile scrape to finish',
  'Read the profile and suggest fields',
] as const;

// A name run buys a people search, not a profile scrape, so its steps say so. Same count as the profile titles.
export const enrichPersonNameStepTitles = [
  'Start the people search',
  'Wait for the people search to finish',
  'Read the search result and suggest fields',
] as const;

export const enrichFields = ['title', 'location', 'email', 'linkedinUrl'] as const;
export type EnrichField = (typeof enrichFields)[number];

// Profile mode suggests these. Email is out of scope in name mode: the short search result carries none.
const profileModeFields: readonly EnrichField[] = ['title', 'location', 'email'];
// The link comes last: saving it invalidates the other suggestions, so the list never offers it first.
const nameModeFields: readonly EnrichField[] = ['title', 'location', 'linkedinUrl'];

// The longest profile link kept, the same bound the extraction schema puts on URLs.
const maxProfileUrlLength = 500;

export interface EnrichSuggestion {
  field: EnrichField;
  value: string;
  status: 'pending' | 'accepted' | 'dismissed';
}

export type EnrichMode = 'profile' | 'name';

interface EnrichScope extends EnrichScopeBase {
  personId: string;
  // Decided at start by whether the person had a LinkedIn link. A run stored before name mode existed has none: profile.
  mode?: EnrichMode;
  // Profile mode: the profile URL, frozen at start so a record edit mid run changes nothing.
  profileUrl?: string;
  // Name mode: the frozen target is the full name, and the actor is sent the two parts it was split into.
  fullName?: string;
  firstName?: string;
  lastName?: string;
  // Name mode: the source of accepted claims, the item's own canonical profile page or null. Never the name.
  sourceUrl?: string | null;
  suggestions?: EnrichSuggestion[];
}

const modeOf = (scope: EnrichScope): EnrichMode => scope.mode ?? 'profile';

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
  const open = tx.db
    .prepare(
      `SELECT 1 FROM run WHERE workspace_id = ? AND kind = ? AND json_extract(scope, '$.personId') = ? AND status IN ${openStatuses} LIMIT 1`,
    )
    .get(tx.workspaceId, enrichPersonKind, personId);
  if (open) throw validationError('An enrichment run for this person is already open. Wait for it to finish or cancel it first.');
  const { leadCapture } = connector.settings;
  if (person.linkedinUrl) return { personId, actorId: leadCapture.profileActor, mode: 'profile', profileUrl: person.linkedinUrl };
  // An invisible only name scrubs to nothing, and a search for nothing would still be billed.
  if (scrubCapturedLine(person.name) === '') {
    throw validationError('This person has no usable name, so there is nothing to search for. Add a name or a LinkedIn profile first.');
  }
  return {
    personId,
    actorId: leadCapture.personSearchActor,
    mode: 'name',
    fullName: person.name,
    firstName: person.firstName,
    lastName: person.lastName,
  };
}

export const enrichPersonFlavor: EnrichFlavor<EnrichScope> = {
  kind: enrichPersonKind,
  actor: enrichPersonActor,
  startInput: (scope) =>
    modeOf(scope) === 'name'
      ? // Short results are one search page. maxItems is the app's floor for a charge cap, and the last name is
        // left out when the person has none.
        {
          profileScraperMode: 'Short',
          firstName: scope.firstName ?? '',
          ...(scope.lastName ? { lastName: scope.lastName } : {}),
          maxItems: minimumCapItems,
        }
      : // The same input shape the lead capture profile enrichment sends, for one profile.
        { queries: [scope.profileUrl], profileUrls: [scope.profileUrl], usernames: [scope.profileUrl] },
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
// an email) when no other person already holds the address. A profile link held by another person is checked by the
// caller, which reports it.
function suggestionValue(tx: Tx, personId: string, field: EnrichField, raw: string): string | null {
  const value = scrubCapturedLine(raw);
  if (value === '' || value.length > maxSuggestionCharacters) return null;
  let accepted = value;
  try {
    const parsed = parseUpdate('person', { expectedVersion: 1, fields: { [field]: value } });
    // A profile link is stored in its canonical form, so that is the form suggested.
    if (field === 'linkedinUrl') accepted = String(parsed.fields.linkedinUrl);
  } catch {
    return null;
  }
  if (field === 'email') {
    const taken = tx.db
      .prepare('SELECT 1 FROM person WHERE workspace_id = ? AND lower(email) = ? AND id != ?')
      .get(tx.workspaceId, value.toLowerCase(), personId);
    if (taken) return null;
  }
  return accepted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Keys a name search item may carry its profile link under. Unlike profile mode there is no input URL to echo.
const searchProfileKeys = ['linkedinUrl', 'linkedin_url', 'publicProfileUrl', 'public_profile_url', 'profileUrl', 'profile_url', 'url'] as const;

// The canonical /in/ profile page an item names, best key first, or null. A link over the bound counts as absent.
function itemProfileUrl(item: Record<string, unknown>): string | null {
  const candidates: unknown[] = searchProfileKeys.map((key) => item[key]);
  const identifier = clean(item.publicIdentifier, 200) ?? clean(item.public_identifier, 200);
  const encoded = identifier ? encodeIdentifier(identifier) : null;
  if (encoded !== null) candidates.push(`https://www.linkedin.com/in/${encoded}`);
  for (const candidate of candidates) {
    const url = canonicalPersonLinkedinUrl(candidate);
    if (url !== null && url.length <= maxProfileUrlLength) return url;
  }
  return null;
}

// Who the search returned, for the step detail. Scraped text: scrubbed and bounded.
function foundPersonLabel(name: string | null, headline: string | null): string {
  const shownName = name ? scrubCapturedLine(name).slice(0, 100) : '';
  const shownHeadline = headline ? scrubCapturedLine(headline).slice(0, 150) : '';
  if (shownName && shownHeadline) return `${shownName} (${shownHeadline})`;
  return shownName || shownHeadline || 'a profile with no name or headline';
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
    const mode = modeOf(scope);
    if (item === undefined) {
      failImportRunIn(
        tx,
        runId,
        mode === 'name' ? 'The search found nobody by this name, so nothing was suggested.' : 'The scrape returned no profile, so nothing was suggested.',
      );
      return { nextRunAt: null };
    }
    // In profile mode the item must name the profile that was asked for. A different profile's email on this person
    // would be worse than none. A name search has nothing to check against, so a person judges the match.
    if (mode === 'profile') {
      const target = normalizeProfileUrl(scope.profileUrl);
      if (!target || !itemNamesTarget(item, target)) {
        failImportRunIn(tx, runId, `The scraped item named a different profile than ${scope.profileUrl}, so nothing was suggested.`);
        return { nextRunAt: null };
      }
    }
    const person = getPerson(tx.db, tx.workspaceId, scope.personId);
    if (!person) {
      failImportRunIn(
        tx,
        runId,
        mode === 'name' ? 'The person was removed while the search ran, so nothing was suggested.' : 'The person was removed while the scrape ran, so nothing was suggested.',
      );
      return { nextRunAt: null };
    }
    const record = isRecord(item) ? item : {};
    const mapped = mapProfileItem(item);
    const foundUrl = mode === 'name' ? itemProfileUrl(record) : null;
    // Read wider than the 200 character limit so an over long headline is dropped by the suggestion rules, never cut.
    // The same wide read for title and location in both modes: mapProfileItem cuts at 200, which would turn an over
    // long value into a different valid one. Read to 1000 so the suggestion rules see the real length and drop it.
    const headline = clean(record.headline, 1000);
    const wideTitle = pick(record, fieldAliases.title, 1000);
    const wideLocation = pickLocation(record, 1000) ?? clean(isRecord(record.location) ? record.location.linkedinText : null, 1000);
    const candidates: Partial<Record<EnrichField, string | null>> =
      mode === 'name'
        ? { title: headline ?? wideTitle, location: wideLocation, linkedinUrl: foundUrl }
        : { title: wideTitle ?? headline, location: wideLocation, email: mapped.email };
    const fields = mode === 'name' ? nameModeFields : profileModeFields;
    const offered = fields.filter((field) => !isEmpty(candidates[field]));
    const suggestions: EnrichSuggestion[] = [];
    let linkHeld = false;
    for (const field of offered) {
      if (!isEmpty(person[field])) continue;
      const value = suggestionValue(tx, scope.personId, field, candidates[field]!);
      if (value === null) continue;
      if (field === 'linkedinUrl' && personHoldingLinkedin(tx, value, scope.personId)) {
        linkHeld = true;
        continue;
      }
      suggestions.push({ field, value, status: 'pending' });
    }
    // Evidence is never guessed: in name mode the item's own canonical page, or null when it named none.
    patchScope(tx, runId, mode === 'name' ? { suggestions, sourceUrl: foundUrl } : { suggestions });
    setCounts(tx, runId, { processed: 1, found: suggestions.length, flagged: 0 });
    const outcome =
      suggestions.length > 0
        ? `Suggested ${suggestions.length} ${suggestions.length === 1 ? 'field' : 'fields'} to fill: ${suggestions.map((s) => s.field).join(', ')}.`
        : offered.length > 0
          ? `Every field the ${mode === 'name' ? 'result' : 'profile'} offered was already filled${mode === 'name' ? ' or already on another person' : ''}, so nothing is suggested.`
          : mode === 'name'
            ? 'The result offered nothing new.'
            : 'The profile offered nothing new.';
    // A name search cannot be checked, so the detail names who came back and a person judges the match.
    const detail =
      mode === 'name'
        ? `The search for "${scrubCapturedLine(scope.fullName ?? '').slice(0, 100)}" returned ${foundPersonLabel(mapped.name, headline ?? mapped.title)}. Check that this is the right person before accepting anything. ${outcome}${linkHeld ? ' The profile link is already on another person.' : ''}`
        : outcome;
    completeStep(tx, runId, live.step, detail);
    tx.db.prepare("UPDATE run SET status = 'succeeded', finished_at = ? WHERE id = ?").run(tx.now(), runId);
    tx.audit('run.succeeded', 'run', runId, { personId: scope.personId, suggested: suggestions.length });
    emitRecord(tx, 'person', scope.personId);
    tx.emit({ type: 'run_updated', runId });
    return { nextRunAt: null };
  });
}

// Suggestions: read, accept, dismiss

export type EnrichmentState = Omit<BaseEnrichmentState<EnrichField>, 'run'> & {
  run: (NonNullable<BaseEnrichmentState['run']> & { mode: EnrichMode }) | null;
};

// The newest enrichment run for a person, with its pending suggestions. Read only.
export function getEnrichment(ctx: Pick<ActionContext, 'db' | 'workspaceId'>, personId: string): EnrichmentState {
  requirePerson(ctx.db, ctx.workspaceId, personId);
  const run = newestEnrichRun(ctx.db, ctx.workspaceId, enrichPersonKind, 'personId', personId);
  const state = enrichmentState<EnrichField>(ctx, run);
  // The sheet shows a name lookup's detail above the suggestions, so it needs the mode of the run it is reading.
  if (!state.run || !run) return { ...state, run: null };
  return { ...state, run: { ...state.run, mode: modeOf(readScope<EnrichScope>(run.scope)) } };
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
    const scope = readScope<EnrichScope>(run.scope);
    // A field the run's mode never offers (email from a name search, a profile link from a profile scrape) is a bad request.
    if (!(modeOf(scope) === 'name' ? nameModeFields : profileModeFields).includes(data.field)) {
      throw validationError(`That enrichment run does not suggest ${data.field}.`);
    }
    if (run.status !== 'succeeded') throw conflict('That enrichment run did not finish successfully, so it has nothing to accept.');
    const suggestions = scope.suggestions ?? [];
    const suggestion = suggestions.find((candidate) => candidate.field === data.field);
    if (!suggestion || suggestion.status !== 'pending') throw conflict('That suggestion was already accepted or dismissed.');
    const newest = newestEnrichRun(tx.db, tx.workspaceId, enrichPersonKind, 'personId', personId);
    if (!newest || newest.id !== run.id) throw conflict('A newer enrichment run exists for this person, so this older one cannot be accepted.');
    // The record must still match what the run was started for: the frozen profile in profile mode, the frozen name
    // with no profile saved since in name mode.
    if (modeOf(scope) === 'name') {
      if (person.name.toLowerCase() !== (scope.fullName ?? '').toLowerCase()) {
        throw conflict('This person\'s name changed after the search, so its suggestions may describe someone else and were not applied.');
      }
      if (!isEmpty(person.linkedinUrl)) {
        throw conflict('A LinkedIn link was saved on this person after the search, so its suggestions were not applied.');
      }
    } else if (person.linkedinUrl !== scope.profileUrl) {
      throw conflict('This person\'s LinkedIn link changed after the scrape, so its suggestions describe a different profile and were not applied.');
    }
    if (!isEmpty(person[data.field])) throw conflict(`This person already has a ${data.field}, so the suggestion was not applied.`);
    // A link another person saved after the run is refused the way a duplicate email is.
    if (data.field === 'linkedinUrl') assertLinkedinAvailable(tx, suggestion.value, personId);

    const parsed = parseUpdate('person', { expectedVersion: data.expectedVersion, fields: { [data.field]: suggestion.value } });
    const updated = updateEntityIn(tx, 'person', personId, parsed);
    createFieldClaimIn(tx, {
      entityType: 'person',
      entityId: personId,
      field: data.field,
      value: suggestion.value.slice(0, 2000),
      // Evidence is never guessed: the profile that was scraped, or the search item's own page (null when it named none).
      sourceUrl: modeOf(scope) === 'name' ? (scope.sourceUrl ?? null) : (person.linkedinUrl ?? scope.profileUrl ?? null),
      sourceType: 'apify',
      observedAt: tx.now(),
      status: 'imported',
      extractionMethod: `enrich:${scope.actorId}`.slice(0, 200),
    });
    // Saving the link invalidates the rest of the run (the next accept would be refused as a changed record), so the
    // remaining pending suggestions are dismissed in the same transaction, the way a dismiss marks them.
    const dismissing = data.field === 'linkedinUrl' ? suggestions.filter((s) => s !== suggestion && s.status === 'pending').length : 0;
    patchScope(tx, run.id, {
      suggestions: suggestions.map((s) =>
        s === suggestion ? { ...s, status: 'accepted' } : dismissing > 0 && s.status === 'pending' ? { ...s, status: 'dismissed' } : s,
      ),
    });
    tx.audit('enrichment.accept', 'person', personId, { runId: run.id, field: data.field });
    if (dismissing > 0) tx.audit('enrichment.dismiss', 'person', personId, { runId: run.id, dismissed: dismissing });
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

