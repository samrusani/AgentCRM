import { z } from 'zod';
import { getDatasetItems } from '../providers/apify.js';
import { conflict, notFound, validationError } from '../errors.js';
import { getConnectorSecret } from '../queries/connectors.js';
import { getOrganization, requireOrganization } from '../queries/organizations.js';
import { getRun } from '../queries/runs.js';
import { clean, hostnameOf } from './apifyMapping.js';
import { scrubCapturedLine } from './capture.js';
import { type ActionContext, emitRecord, mutate, parseInput, type Tx, withTxActor } from './context.js';
import { createFieldClaimIn } from './crud.js';
import { type AdvanceResult, setCounts } from './demoResearch.js';
import { parseUpdate, updateEntityIn } from './entities.js';
import {
  advanceEnrichRun,
  dismissSuggestionsIn,
  type EnrichFlavor,
  type EnrichmentState as BaseEnrichmentState,
  enrichmentState,
  type EnrichScopeBase,
  enrichOrganizationActor,
  enrichOrganizationJobKind,
  enrichOrganizationKind,
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
import { canonicalCompanyLinkedinUrl, encodeIdentifier, linkedinHost } from './profileUrls.js';

// Organization enrichment: one company lookup, suggestions a person accepts one by one. It mirrors person enrichment
// (enrichPerson.ts) and shares the Apify handling with it (enrichRun.ts). The difference is identity: with a saved
// LinkedIn link the item is checked against it, without one the lookup is a name search and a person judges the match.

export const enrichOrganizationStepTitles = [
  'Start the company lookup',
  'Wait for the company lookup to finish',
  'Read the company and suggest fields',
] as const;

export const enrichOrganizationFields = ['linkedinUrl', 'domain', 'location'] as const;
export type EnrichOrganizationField = (typeof enrichOrganizationFields)[number];

export interface EnrichOrganizationSuggestion {
  field: EnrichOrganizationField;
  value: string;
  status: 'pending' | 'accepted' | 'dismissed';
}

interface EnrichOrganizationScope extends EnrichScopeBase {
  organizationId: string;
  // Frozen at start: the LinkedIn company link in url mode, the organization's name in name mode.
  target: string;
  targetKind: 'url' | 'name';
  // The source of accepted claims: the frozen target in url mode, the item's own canonical page or null in name mode.
  sourceUrl?: string | null;
  suggestions?: EnrichOrganizationSuggestion[];
}

export const enrichOrganizationByAgentMessage =
  'Organization enrichment can only be started by a person in the app, because it spends the user\'s Apify credit on one company lookup.';

export function scheduleEnrichOrganizationRun(tx: Tx, runId: string, runAt: string): void {
  scheduleEnrichRun(tx, enrichOrganizationJobKind, runId, runAt);
}

// Start guards, checked inside the start transaction so two starts cannot both pass. Returns the scope the run is stored with.
export function enrichOrganizationStartScope(tx: Tx, organizationId: string): EnrichOrganizationScope {
  const connector = readyApifyConnector(tx, validationError);
  const organization = getOrganization(tx.db, tx.workspaceId, organizationId);
  if (!organization) throw validationError('That organization was not found, so there is nothing to enrich.');
  const open = tx.db
    .prepare(
      `SELECT 1 FROM run WHERE workspace_id = ? AND kind = ? AND json_extract(scope, '$.organizationId') = ? AND status IN ${openStatuses} LIMIT 1`,
    )
    .get(tx.workspaceId, enrichOrganizationKind, organizationId);
  if (open) throw validationError('An enrichment run for this organization is already open. Wait for it to finish or cancel it first.');
  const actorId = connector.settings.leadCapture.companyActor;
  return organization.linkedinUrl
    ? { organizationId, actorId, target: organization.linkedinUrl, targetKind: 'url' }
    : { organizationId, actorId, target: organization.name, targetKind: 'name' };
}

export const enrichOrganizationFlavor: EnrichFlavor<EnrichOrganizationScope> = {
  kind: enrichOrganizationKind,
  actor: enrichOrganizationActor,
  startInput: (scope) => (scope.targetKind === 'url' ? { companies: [scope.target] } : { searches: [scope.target] }),
  read: (ctx, runId, scope) => readStep(ctx, runId, scope),
};

export const advanceEnrichOrganizationRun = (ctx: ActionContext, runId: string) =>
  advanceEnrichRun(ctx, enrichOrganizationFlavor, runId);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Keys of a scraped item that name the company page the item is about. Keys that only repeat the request input, such
// as inputUrl, are left out on purpose: an item for another company could echo what it was asked for.
const ownCompanyKeys = ['linkedinUrl', 'linkedin_url', 'companyUrl', 'company_url', 'url'] as const;

// The canonical company page links an item names, best first.
function itemCompanyUrls(item: unknown): string[] {
  if (!isRecord(item)) return [];
  const urls = ownCompanyKeys.map((key) => canonicalCompanyLinkedinUrl(item[key]));
  const slug = clean(item.universalName, 200);
  const encoded = slug ? encodeIdentifier(slug) : null;
  if (encoded !== null) urls.push(canonicalCompanyLinkedinUrl(`https://www.linkedin.com/company/${encoded}`));
  return urls.filter((url): url is string => url !== null);
}

// True when the item names the target company page. Slugs compare without regard to case, because scrapers fold
// case; this is the only place that does.
function itemNamesCompany(item: unknown, target: string): boolean {
  const wanted = target.toLowerCase();
  return itemCompanyUrls(item).some((url) => url.toLowerCase() === wanted);
}

// The hostname of the item's website, which may carry a path and a query. A LinkedIn link is never the company's own site.
function itemDomain(item: Record<string, unknown>): string | null {
  const website = clean(item.website, 1000);
  if (!website) return null;
  const host = hostnameOf(website);
  // hostnameOf cuts at 200 characters; a cut hostname could read as a different valid one, so it is dropped.
  if (!host || host.length >= maxSuggestionCharacters || linkedinHost(host)) return null;
  return host;
}

// The headquarters entry, else the first one. Its parsed text, else its city. Anything of another shape yields nothing.
function itemLocation(item: Record<string, unknown>): string | null {
  const locations = Array.isArray(item.locations) ? item.locations : [];
  const entries = locations.filter(isRecord);
  const entry = entries.find((candidate) => candidate.headquarter === true) ?? entries[0];
  if (!entry) return null;
  const parsed = isRecord(entry.parsed) ? entry.parsed : {};
  return clean(parsed.text, 1000) ?? clean(parsed.city, 1000) ?? clean(entry.city, 1000);
}

// A scraped value becomes a suggestion only when it is clean text a manual edit of that field would take, and (for
// a domain) when no other organization already holds it.
function suggestionValue(tx: Tx, organizationId: string, field: EnrichOrganizationField, raw: string): string | null {
  const value = scrubCapturedLine(raw);
  if (value === '' || value.length > maxSuggestionCharacters) return null;
  let accepted: string;
  try {
    const parsed = parseUpdate('organization', { expectedVersion: 1, fields: { [field]: value } });
    accepted = String(parsed.fields[field]);
  } catch {
    return null;
  }
  if (field === 'domain') {
    const taken = tx.db
      .prepare('SELECT 1 FROM organization WHERE workspace_id = ? AND lower(domain) = ? AND id != ?')
      .get(tx.workspaceId, accepted.toLowerCase(), organizationId);
    if (taken) return null;
  }
  return accepted;
}

// The name of the company the lookup returned, for the step detail. Scraped text: scrubbed and bounded.
function foundCompanyLabel(item: Record<string, unknown>, url: string | null): string {
  const raw = clean(item.name, 200) ?? clean(item.universalName, 200);
  const name = raw ? scrubCapturedLine(raw).slice(0, 100) : '';
  if (name && url) return `${name} (${url})`;
  return name || url || 'a company with no name or LinkedIn link';
}

async function readStep(ctx: ActionContext, runId: string, scope: EnrichOrganizationScope): Promise<AdvanceResult> {
  const flavor = enrichOrganizationFlavor;
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failNow(ctx, flavor, runId, notConnectedMessage);
  if (!scope.apifyDatasetId || !scope.apifyRunId) return failNow(ctx, flavor, runId, 'Apify did not report a dataset for this run.');
  let result;
  try {
    result = await getDatasetItems(token, scope.apifyDatasetId, 1);
  } catch (error) {
    return providerFailure(ctx, flavor, runId, scope, token, error);
  }
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, enrichOrganizationActor);
    const live = liveStep(tx, runId, 3);
    if (!live) return { nextRunAt: null };
    const item = result.items[0];
    if (item === undefined) {
      failImportRunIn(tx, runId, 'The lookup returned no company, so nothing was suggested.');
      return { nextRunAt: null };
    }
    // With a saved link the item must name that page. A different company's website on this organization would be worse than none.
    if (scope.targetKind === 'url' && !itemNamesCompany(item, scope.target)) {
      failImportRunIn(tx, runId, `The lookup returned a different company than ${scope.target}, so nothing was suggested.`);
      return { nextRunAt: null };
    }
    const organization = getOrganization(tx.db, tx.workspaceId, scope.organizationId);
    if (!organization) {
      failImportRunIn(tx, runId, 'The organization was removed while the lookup ran, so nothing was suggested.');
      return { nextRunAt: null };
    }
    const record = isRecord(item) ? item : {};
    const foundUrl = itemCompanyUrls(item)[0] ?? null;
    const candidates: Record<EnrichOrganizationField, string | null> = {
      linkedinUrl: foundUrl,
      domain: itemDomain(record),
      location: itemLocation(record),
    };
    const offered = enrichOrganizationFields.filter((field) => !isEmpty(candidates[field]));
    const suggestions: EnrichOrganizationSuggestion[] = [];
    for (const field of offered) {
      if (!isEmpty(organization[field])) continue;
      const value = suggestionValue(tx, scope.organizationId, field, candidates[field]!);
      if (value !== null) suggestions.push({ field, value, status: 'pending' });
    }
    // Evidence is never guessed: the frozen target in url mode, the item's own canonical page (or null) in name mode.
    patchScope(tx, runId, { suggestions, sourceUrl: scope.targetKind === 'url' ? scope.target : foundUrl });
    setCounts(tx, runId, { processed: 1, found: suggestions.length, flagged: 0 });
    const outcome =
      suggestions.length > 0
        ? `Suggested ${suggestions.length} ${suggestions.length === 1 ? 'field' : 'fields'} to fill: ${suggestions.map((s) => s.field).join(', ')}.`
        : offered.length > 0
          ? 'Every field the company offered was already filled, so nothing is suggested.'
          : 'The company offered nothing new.';
    // A name search cannot be checked, so the detail names what came back and a person judges the match.
    const detail =
      scope.targetKind === 'name'
        ? `The lookup for "${scrubCapturedLine(scope.target).slice(0, 100)}" returned ${foundCompanyLabel(record, foundUrl)}. Check that this is the right company before accepting anything. ${outcome}`
        : outcome;
    completeStep(tx, runId, live.step, detail);
    tx.db.prepare("UPDATE run SET status = 'succeeded', finished_at = ? WHERE id = ?").run(tx.now(), runId);
    tx.audit('run.succeeded', 'run', runId, { organizationId: scope.organizationId, suggested: suggestions.length });
    emitRecord(tx, 'organization', scope.organizationId);
    tx.emit({ type: 'run_updated', runId });
    return { nextRunAt: null };
  });
}

// Suggestions: read, accept, dismiss

export type EnrichOrganizationState = BaseEnrichmentState<EnrichOrganizationField>;

// The newest enrichment run for an organization, with its pending suggestions. Read only.
export function getOrganizationEnrichment(ctx: Pick<ActionContext, 'db' | 'workspaceId'>, organizationId: string): EnrichOrganizationState {
  requireOrganization(ctx.db, ctx.workspaceId, organizationId);
  return enrichmentState<EnrichOrganizationField>(
    ctx,
    newestEnrichRun(ctx.db, ctx.workspaceId, enrichOrganizationKind, 'organizationId', organizationId),
  );
}

const acceptSchema = z
  .object({
    runId: z.string().trim().min(1).max(64),
    field: z.enum(enrichOrganizationFields),
    expectedVersion: z.number().int().min(1),
  })
  .strict();

function loadRunFor(tx: Tx, organizationId: string, runId: string) {
  const run = getRun(tx.db, tx.workspaceId, runId);
  if (!run || run.kind !== enrichOrganizationKind || readScope<EnrichOrganizationScope>(run.scope).organizationId !== organizationId) {
    throw notFound('Enrichment run');
  }
  return run;
}

// Accepts one suggestion: writes the field through the normal update path with a claim, in one transaction.
export function acceptOrganizationEnrichmentSuggestion(ctx: ActionContext, organizationId: string, input: unknown) {
  const data = parseInput(acceptSchema, input);
  return mutate(ctx, (tx) => {
    const organization = requireOrganization(tx.db, tx.workspaceId, organizationId);
    const run = loadRunFor(tx, organizationId, data.runId);
    if (run.status !== 'succeeded') throw conflict('That enrichment run did not finish successfully, so it has nothing to accept.');
    const scope = readScope<EnrichOrganizationScope>(run.scope);
    const suggestions = scope.suggestions ?? [];
    const suggestion = suggestions.find((candidate) => candidate.field === data.field);
    if (!suggestion || suggestion.status !== 'pending') throw conflict('That suggestion was already accepted or dismissed.');
    const newest = newestEnrichRun(tx.db, tx.workspaceId, enrichOrganizationKind, 'organizationId', organizationId);
    if (!newest || newest.id !== run.id) {
      throw conflict('A newer enrichment run exists for this organization, so this older one cannot be accepted.');
    }
    if (scope.targetKind === 'url' && organization.linkedinUrl !== scope.target) {
      throw conflict('This organization\'s LinkedIn link changed after the lookup, so its suggestions describe a different company and were not applied.');
    }
    if (scope.targetKind === 'name' && organization.name !== scope.target) {
      throw conflict('This organization\'s name changed after the lookup, so its suggestions may describe a different company and were not applied.');
    }
    if (!isEmpty(organization[data.field])) {
      throw conflict(`This organization already has a ${data.field}, so the suggestion was not applied.`);
    }

    const parsed = parseUpdate('organization', { expectedVersion: data.expectedVersion, fields: { [data.field]: suggestion.value } });
    const updated = updateEntityIn(tx, 'organization', organizationId, parsed);
    createFieldClaimIn(tx, {
      entityType: 'organization',
      entityId: organizationId,
      field: data.field,
      value: suggestion.value.slice(0, 2000),
      sourceUrl: scope.sourceUrl ?? null,
      sourceType: 'apify',
      observedAt: tx.now(),
      status: 'imported',
      extractionMethod: `enrich:${scope.actorId}`.slice(0, 200),
    });
    patchScope(tx, run.id, { suggestions: suggestions.map((s) => (s === suggestion ? { ...s, status: 'accepted' } : s)) });
    tx.audit('enrichment.accept', 'organization', organizationId, { runId: run.id, field: data.field });
    emitRecord(tx, 'organization', organizationId);
    return updated as ReturnType<typeof requireOrganization>;
  });
}

// Dismisses the run's remaining pending suggestions. Accepting and dismissing cost nothing.
export function dismissOrganizationEnrichment(ctx: ActionContext, organizationId: string, runId: unknown): void {
  const id = parseInput(z.string().trim().min(1).max(64), runId);
  mutate(ctx, (tx) => {
    requireOrganization(tx.db, tx.workspaceId, organizationId);
    dismissSuggestionsIn(tx, loadRunFor(tx, organizationId, id), 'organization', organizationId);
  });
}
