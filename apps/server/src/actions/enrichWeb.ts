import { z } from 'zod';
import { getDatasetItems } from '../providers/apify.js';
import { ModelProviderError, type ModelCallReport } from '../providers/modelTypes.js';
import { providerLabels } from '../providers/presets.js';
import { getConnectorSecret, type ModelConnectorKind } from '../queries/connectors.js';
import { isActiveModelReady } from '../queries/modelProvider.js';
import { getRun, listRunSteps } from '../queries/runs.js';
import { scrubCapturedLine } from './capture.js';
import { markConnectorError, requireActiveModel } from './connectors.js';
import { type ActionContext, emitRecord, mutate, type Tx, withTxActor } from './context.js';
import { type AdvanceResult, setCounts } from './demoResearch.js';
import { parseUpdate, personHoldingLinkedin } from './entities.js';
import {
  type EnrichFlavor,
  type EnrichScopeBase,
  failNow,
  isEmpty,
  notConnectedMessage,
  patchScope,
  providerFailure,
  type StoredSuggestion,
} from './enrichRun.js';
import { completeStep, failImportRunIn, liveStep } from './importReview.js';
import { costText, sentence, syncModelCost } from './leadCapture.js';
import { hasPendingModelCall, markModelCallPending, settleModelCallReportsIn } from './modelCalls.js';
import {
  askForEntries,
  occurrenceChecks,
  type ParsedAnswer,
  type PastedSpec,
  pastedPrompt,
  pastedSystemPrompt,
  prepareSentText,
  sanitizePastedText,
} from './pastedExtraction.js';
import { normalizeXProfileUrl } from './profileUrls.js';

// Web mode of person enrichment: one Google search through the web search actor, then one model call that reads the
// organic results (titles, links, snippets) for the person's own links. The results are untrusted text and go through
// the same sanitize, fence, and verify pieces as a pasted post. Nothing is written to the person; suggestions are
// reviewed on the sheet. The results are never stored in the run scope: they are read from the dataset, sent, and dropped.

export const webModeFields = ['linkedinUrl', 'xUrl', 'website', 'calendarUrl'] as const;
export type WebField = (typeof webModeFields)[number];

// What the model is sent: at most this many characters of serialized results, measured after sanitizing.
export const maxSearchResultCharacters = 15_000;
const searchResultTag = 'search_results';
// The longest link kept, the bound manual edits of these fields use.
const maxLinkCharacters = 500;
// A search page holds about ten organic results. A few items are read so an actor that returns one item per result still works.
const maxDatasetItems = 10;
const readSeq = 3;
const suggestSeq = 4;

export const webNeedsProviderMessage =
  'Searching the web needs a ready model provider to read the results. Connect a provider in Settings, Model providers.';
export const webNoNameMessage = 'This person has no usable name, so there is nothing to search for. Add a name first.';

// The query: the full name, plus the organization's name when one is linked. Both as they are at start.
export function webSearchQuery(name: string, organizationName: string | null): string {
  const line = (value: string) => scrubCapturedLine(value).replace(/\s+/g, ' ');
  const organization = organizationName ? line(organizationName) : '';
  return [line(name), organization].filter((part) => part !== '').join(' ');
}

// One page of results for one query.
export function webSearchInput(scope: { query?: string }): Record<string, unknown> {
  return { queries: scope.query ?? '', maxPagesPerQuery: 1, resultsPerPage: 10 };
}

// The default actor is pay per event and declares minimalMaxTotalChargeUsd 0.50, which the platform enforces on the
// start: real runs proved that an item cap sent alongside still made Apify compute a maximum cost under $0.50 and
// refuse with HTTP 400, so the web start sends the dollar cap alone and the one page input bounds the actual work.
export const webSearchCapUsd = 0.5;

export interface WebScope extends EnrichScopeBase {
  personId: string;
  fullName?: string;
  query?: string;
  // The organization's name at start, part of the query and told to the model.
  organizationName?: string | null;
  provider?: ModelConnectorKind;
  model?: string;
  // Links the model named that passed the occurrence check, waiting for the suggest step.
  candidates?: Candidate[];
  // A pause that came during the model call keeps its outcome here, so resuming never asks again.
  readResult?: SavedRead;
}

interface Candidate {
  field: WebField;
  url: string;
  sourceUrl: string | null;
}

interface SavedRead {
  detail: string;
  candidates: Candidate[];
  fatal?: boolean;
}

// Results

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string') return '';
  // Every C0 and C1 control collapses with the whitespace: \s misses NEL, ESC, and NUL, and a control character
  // surviving into the fenced list could forge the list's own line structure.
  const line = value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return line.length > max ? line.slice(0, max) : line;
};

const resultFrom = (raw: unknown): SearchResult | null => {
  if (!isRecord(raw)) return null;
  const url = text(raw.url ?? raw.link, 2000);
  if (!/^https?:\/\//i.test(url)) return null;
  return { title: text(raw.title, 300), url, snippet: text(raw.description ?? raw.snippet, 600) };
};

// The organic results of the dataset items. The Google search actor puts them under `organicResults` of each page
// item; an item that is itself a result (title and url) counts too. Ads and related queries are not read.
export function readSearchResults(items: unknown[]): SearchResult[] {
  const results: SearchResult[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const organic = Array.isArray(item.organicResults) ? item.organicResults : Array.isArray(item.results) ? item.results : null;
    if (organic) {
      for (const raw of organic) {
        const result = resultFrom(raw);
        if (result) results.push(result);
      }
    } else {
      const result = resultFrom(item);
      if (result) results.push(result);
    }
  }
  return results;
}

// One list: a number, the title, the link, the snippet. Each result is plain lines, so nothing in a title can pass
// for the list's own structure beyond what the fence already treats as data.
export function serializeResults(results: SearchResult[]): string {
  return results
    .map((result, index) => [`${index + 1}. ${result.title}`, `URL: ${result.url}`, `Snippet: ${result.snippet}`].join('\n'))
    .join('\n\n');
}

// Model call

function webSpec(name: string, organizationName: string | null): PastedSpec {
  const who = organizationName ? `${name}, linked to ${organizationName}` : name;
  return {
    tag: searchResultTag,
    textNoun: 'search results',
    sourceNoun: 'search results',
    systemTask: 'You read web search results for one person and pick out the links that belong to that same person.',
    untrusted: 'a list of web search results (titles, links, and snippets) taken from the open web',
    promptIntro: 'These are the search results for one person.',
    taskLines: [
      `The person is: ${who}.`,
      'Return the links that belong to this person and appear in the results: a LinkedIn profile (linkedinUrl), an X or Twitter profile (xUrl), a personal or fund website (website), or a booking or calendar page (calendarUrl).',
      'Give each link exactly as written in the results. For sourceUrl give the address of the result that shows the link, copied exactly from that result.',
      'Leave out a link when you are not sure it belongs to this person. Return an empty list when there is none.',
    ],
    email: false,
  };
}

export const webLinksJsonSchema = {
  type: 'object',
  properties: {
    links: {
      type: 'array',
      description: 'Links that belong to the person and appear in the search results, at most one per field.',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: [...webModeFields], description: 'What kind of link it is.' },
          url: { type: 'string', description: 'The link exactly as written in the search results.' },
          sourceUrl: { type: 'string', description: 'The address of the search result that shows the link, copied exactly.' },
        },
        required: ['field', 'url'],
        additionalProperties: false,
      },
    },
  },
  required: ['links'],
  additionalProperties: false,
} as const;

const linkSchema = z.object({
  field: z.enum(webModeFields),
  url: z
    .string()
    .transform((value) => value.replace(/[​-‍﻿⁠]/g, '').trim())
    .pipe(z.string().min(1).max(2000)),
  sourceUrl: z.string().nullish(),
});
type Link = z.output<typeof linkSchema>;

const linksContainer = z.object({ links: z.array(z.unknown()) });

function parseLinks(output: unknown): ParsedAnswer<Link> {
  const container = linksContainer.safeParse(output);
  if (!container.success) {
    return { ok: false, problem: container.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || 'reply'}: ${issue.message}`).join('; ') };
  }
  const entries: Link[] = [];
  let dropped = 0;
  for (const raw of container.data.links) {
    const parsed = linkSchema.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
    else dropped += 1;
  }
  return { ok: true, entries, dropped };
}

// Verification: the link must occur in the sent text as a whole token, and a source must be exactly one of the
// result links that were sent. Evidence is never guessed.
export function verifyLinks(
  links: Link[],
  sent: string,
  resultUrls: string[],
): { kept: Candidate[]; dropped: number } {
  const { occursLink } = occurrenceChecks(sent);
  const sentUrls = new Set(resultUrls.map((url) => sanitizePastedText(url, searchResultTag)).filter((url) => sent.includes(url)));
  const kept: Candidate[] = [];
  let dropped = 0;
  for (const link of links) {
    if (!occursLink(link.url)) {
      dropped += 1;
      continue;
    }
    const source = typeof link.sourceUrl === 'string' ? link.sourceUrl.trim() : '';
    kept.push({ field: link.field, url: link.url, sourceUrl: source !== '' && sentUrls.has(source) ? source : null });
  }
  return { kept, dropped };
}

// The step: read (3) and suggest (4)

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export async function webReadStep(
  ctx: ActionContext,
  flavor: EnrichFlavor<never>,
  actor: string,
  runId: string,
  scope: WebScope,
  seq: number,
): Promise<AdvanceResult> {
  if (seq === suggestSeq) return suggestStep(ctx, flavor, actor, runId, scope);
  return readStep(ctx, flavor, actor, runId, scope);
}

async function readStep(ctx: ActionContext, flavor: EnrichFlavor<never>, actor: string, runId: string, scope: WebScope): Promise<AdvanceResult> {
  const soon = ctx.now();
  // A pause came during the model call and its outcome was saved. Use it. The call is never made twice.
  if (scope.readResult) return applySaved(ctx, actor, runId, scope.readResult, soon);

  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!token) return failNow(ctx, flavor, runId, notConnectedMessage);
  if (!scope.apifyDatasetId || !scope.apifyRunId) return failNow(ctx, flavor, runId, 'Apify did not report a dataset for this run.');
  // A start marker with no result means an earlier process died during the call. It may have been billed, so it is not repeated.
  if (hasPendingModelCall({ db: ctx.db, workspaceId: ctx.workspaceId }, runId, runId)) {
    return failNow(
      ctx,
      flavor,
      runId,
      'The model call for these search results was started earlier and its outcome is unknown, so it may have been billed. It was not repeated, and nothing was suggested.',
    );
  }
  let fetched;
  try {
    fetched = await getDatasetItems(token, scope.apifyDatasetId, maxDatasetItems);
  } catch (error) {
    return providerFailure(ctx, flavor, runId, scope, token, error);
  }
  const results = readSearchResults(fetched.items);
  if (results.length === 0) {
    return failNow(ctx, flavor, runId, 'The search actor returned no organic results, so there was nothing to read and nothing was suggested.');
  }

  let active;
  try {
    if (!isActiveModelReady(ctx.db, ctx.workspaceId)) throw new Error('not ready');
    active = requireActiveModel(ctx);
  } catch {
    return failNow(ctx, flavor, runId, `${webNeedsProviderMessage} Nothing was read, so nothing was suggested.`);
  }
  const kind = active.kind;
  const model = active.model;
  const label = providerLabels[kind];
  const baseUrl = active.baseUrl;
  mutate(ctx, (rawTx) => patchScope(withTxActor(rawTx, actor), runId, { provider: kind, model }));

  // What the model gets, and what its answer is checked against.
  const { sent, cut } = prepareSentText(serializeResults(results), searchResultTag, maxSearchResultCharacters);
  const spec = webSpec(scrubCapturedLine(scope.fullName ?? ''), scope.organizationName ? scrubCapturedLine(scope.organizationName) : null);
  const prompt = pastedPrompt(spec, sent);
  const reports: ModelCallReport[] = [];
  const pendingId = markModelCallPending(ctx, { purpose: 'draft', runId, provider: kind, model, subjectId: runId });
  const cutNote = cut ? ` The results were cut at ${maxSearchResultCharacters.toLocaleString('en-US')} characters before they were sent to the model.` : '';
  const settle = (detail: string, candidates: Candidate[], fatal = false): AdvanceResult =>
    finishRead(ctx, actor, runId, soon, { detail, candidates, fatal }, pendingId, reports);

  try {
    const { result, parsed } = await askForEntries({
      kind,
      apiKey: active.apiKey,
      baseUrl,
      model,
      system: pastedSystemPrompt(spec),
      prompt,
      schema: webLinksJsonSchema as unknown as Record<string, unknown>,
      parse: parseLinks,
      reports,
      listName: 'links',
    });
    if (result.status === 'refused') {
      const category = result.refusal.category ? ` (${result.refusal.category.replaceAll('_', ' ')})` : '';
      const explanation = result.refusal.explanation ? ` ${result.refusal.explanation.trim().slice(0, 200)}` : '';
      return settle(`The model declined to read the search results${category}.${explanation}${cutNote} Nothing was suggested.`.replace('..', '.'), [], true);
    }
    if (!parsed || !parsed.ok) {
      return settle(`The model's answer did not match the required format, so nothing was suggested.${cutNote}`, [], true);
    }
    const verified = verifyLinks(parsed.entries, sent, results.map((entry) => entry.url));
    let detail =
      verified.kept.length === 0
        ? `The model found no links in ${plural(results.length, 'search result', 'search results')}.`
        : `The model named ${plural(verified.kept.length, 'link', 'links')} in ${plural(results.length, 'search result', 'search results')}.`;
    if (parsed.dropped > 0) detail += ` ${plural(parsed.dropped, 'entry was', 'entries were')} dropped because ${parsed.dropped === 1 ? 'it' : 'they'} did not match the required format.`;
    if (verified.dropped > 0) {
      detail += ` ${plural(verified.dropped, 'link did', 'links did')} not appear in the results and ${verified.dropped === 1 ? 'was' : 'were'} dropped.`;
    }
    return settle(`${detail}${cutNote}`, verified.kept);
  } catch (error) {
    if (!(error instanceof ModelProviderError)) throw error;
    if (error.kind === 'unauthorized') {
      markConnectorError(ctx, active.apiKey, kind);
      return settle(`${label} rejected the saved API key, so nothing was suggested. Update it in Settings and search again.${cutNote}`, [], true);
    }
    return settle(`${sentence(error.message)} Nothing was suggested.${cutNote}`, [], true);
  }
}

// Settles the call first and whatever the run state is, so what was paid for is on record even when the run was
// paused or cancelled meanwhile. A paused run keeps the outcome in its scope, so resuming never asks the model again.
function finishRead(
  ctx: ActionContext,
  actor: string,
  runId: string,
  soon: string,
  saved: SavedRead,
  pendingId: string | null,
  reports: ModelCallReport[],
): AdvanceResult {
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, actor);
    settleModelCallReportsIn(tx, { purpose: 'draft', runId, pendingId, reports });
    const run = getRun(tx.db, tx.workspaceId, runId);
    if (!run) return { nextRunAt: null };
    let detail = saved.detail;
    if (reports.length > 0) {
      const estimatedUsd = syncModelCost(tx, runId);
      detail += ` ${costText((run.scope as unknown as WebScope).provider ?? 'unknown', estimatedUsd)}`;
    }
    const outcome: SavedRead = { ...saved, detail };
    const live = liveStep(tx, runId, readSeq);
    if (live) return applyRead(tx, runId, live.step, outcome, soon);
    const stepThree = listRunSteps(tx.db, runId).find((candidate) => candidate.seq === readSeq);
    if (run.status === 'paused' && stepThree?.status === 'running') patchScope(tx, runId, { readResult: outcome });
    return { nextRunAt: null };
  });
}

function applySaved(ctx: ActionContext, actor: string, runId: string, saved: SavedRead, soon: string): AdvanceResult {
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, actor);
    const live = liveStep(tx, runId, readSeq);
    if (!live) return { nextRunAt: null };
    return applyRead(tx, runId, live.step, saved, soon);
  });
}

function applyRead(tx: Tx, runId: string, step: { id: string; seq: number }, saved: SavedRead, soon: string): AdvanceResult {
  if (saved.fatal) {
    failImportRunIn(tx, runId, saved.detail);
    return { nextRunAt: null };
  }
  tx.db.prepare("UPDATE run SET scope = json_remove(scope, '$.readResult', '$.results') WHERE id = ?").run(runId);
  patchScope(tx, runId, { candidates: saved.candidates });
  completeStep(tx, runId, step, saved.detail);
  return { nextRunAt: soon };
}

// The id of another person holding this X profile, or null. Handles compare lowercased.
export function personHoldingX(tx: Tx, xUrl: string, ignoreId?: string): string | null {
  const wanted = normalizeXProfileUrl(xUrl)?.key;
  if (!wanted) return null;
  const rows = tx.db
    .prepare('SELECT id, x_url FROM person WHERE workspace_id = ? AND x_url IS NOT NULL AND id != ?')
    .all(tx.workspaceId, ignoreId ?? '') as { id: string; x_url: string }[];
  const held = rows.find((row) => normalizeXProfileUrl(row.x_url)?.key === wanted);
  return held ? held.id : null;
}

// A link becomes a suggestion only when it is clean text the manual edit of that field would take. The stored form is
// the validated one: canonical profile links, a website or calendar link with its scheme. A url that changes under
// scrubbing beyond trimming held a control, zero width, or bidirectional character, so its scrubbed spelling never
// occurred in the results; it is dropped rather than scrubbed, because a stored suggestion is always text that occurred.
function linkValue(field: WebField, raw: string): string | null {
  const value = scrubCapturedLine(raw);
  if (value !== raw.trim()) return null;
  if (value === '' || value.length > maxLinkCharacters) return null;
  try {
    const parsed = parseUpdate('person', { expectedVersion: 1, fields: { [field]: value } });
    const accepted = parsed.fields[field];
    return typeof accepted === 'string' && accepted !== '' && accepted.length <= maxLinkCharacters ? accepted : null;
  } catch {
    return null;
  }
}

// Step 4. Turns the verified links into suggestions: only empty fields, one per field, the first valid link wins.
async function suggestStep(ctx: ActionContext, _flavor: EnrichFlavor<never>, actor: string, runId: string, scope: WebScope): Promise<AdvanceResult> {
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, actor);
    const live = liveStep(tx, runId, suggestSeq);
    if (!live) return { nextRunAt: null };
    const person = tx.db
      .prepare('SELECT linkedin_url, x_url, website, calendar_url FROM person WHERE workspace_id = ? AND id = ?')
      .get(tx.workspaceId, scope.personId) as { linkedin_url: string | null; x_url: string | null; website: string | null; calendar_url: string | null } | undefined;
    if (!person) {
      failImportRunIn(tx, runId, 'The person was removed while the search ran, so nothing was suggested.');
      return { nextRunAt: null };
    }
    const current: Record<WebField, string | null> = {
      linkedinUrl: person.linkedin_url,
      xUrl: person.x_url,
      website: person.website,
      calendarUrl: person.calendar_url,
    };
    const suggestions: (StoredSuggestion & { field: WebField })[] = [];
    let held = false;
    let offered = 0;
    for (const candidate of scope.candidates ?? []) {
      offered += 1;
      if (!isEmpty(current[candidate.field])) continue;
      if (suggestions.some((suggestion) => suggestion.field === candidate.field)) continue;
      const value = linkValue(candidate.field, candidate.url);
      if (value === null) continue;
      if (candidate.field === 'linkedinUrl' && personHoldingLinkedin(tx, value, scope.personId)) {
        held = true;
        continue;
      }
      if (candidate.field === 'xUrl' && personHoldingX(tx, value, scope.personId)) {
        held = true;
        continue;
      }
      suggestions.push({ field: candidate.field, value, sourceUrl: candidate.sourceUrl, status: 'pending' });
    }
    // The list reads in the field order, whatever order the model named the links in.
    suggestions.sort((left, right) => webModeFields.indexOf(left.field) - webModeFields.indexOf(right.field));
    tx.db.prepare("UPDATE run SET scope = json_remove(scope, '$.candidates', '$.readResult', '$.results') WHERE id = ?").run(runId);
    patchScope(tx, runId, { suggestions });
    setCounts(tx, runId, { ...(getRun(tx.db, tx.workspaceId, runId)?.counts ?? { processed: 0, found: 0, flagged: 0 }), processed: 1, found: suggestions.length, flagged: 0 });
    const searched = `Searched the web for "${(scope.query ?? '').slice(0, 200)}".`;
    const outcome =
      suggestions.length > 0
        ? `Suggested ${plural(suggestions.length, 'field', 'fields')} to fill: ${suggestions.map((s) => s.field).join(', ')}.`
        : offered > 0
          ? 'Every link the results named was already filled, already on another person, or not a link this app accepts, so nothing is suggested.'
          : 'The results offered no links for this person.';
    const detail = `${searched} Check that the results are about the right person before accepting anything. ${outcome}${held ? ' A profile link it found is already on another person.' : ''}`;
    completeStep(tx, runId, live.step, detail);
    tx.db.prepare("UPDATE run SET status = 'succeeded', finished_at = ? WHERE id = ?").run(tx.now(), runId);
    tx.audit('run.succeeded', 'run', runId, { personId: scope.personId, suggested: suggestions.length });
    emitRecord(tx, 'person', scope.personId);
    tx.emit({ type: 'run_updated', runId });
    return { nextRunAt: null };
  });
}
