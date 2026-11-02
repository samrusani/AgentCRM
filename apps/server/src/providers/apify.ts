import { apifyBaseUrl, apifyRequestTimeoutMilliseconds } from '../config.js';

export type ApifyErrorKind =
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'rejected'
  | 'unavailable'
  | 'timeout'
  | 'bad_response';

// Messages are written in this file and never include the token.
export class ApifyError extends Error {
  readonly kind: ApifyErrorKind;
  readonly status: number | null;

  constructor(kind: ApifyErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'ApifyError';
    this.kind = kind;
    this.status = status;
  }

  // Retrying cannot fix these. Network trouble and rate limits can pass.
  get permanent(): boolean {
    return this.kind === 'unauthorized' || this.kind === 'not_found' || this.kind === 'rejected';
  }
}

export interface ApifyActorSummary {
  id: string;
  name: string;
  title: string | null;
  username: string | null;
  description: string | null;
  stats: { totalRuns: number | null };
  pricingHint: string | null;
}

export interface ApifyActorDetail extends ApifyActorSummary {
  // The actor's own input, parsed from Apify's example body when possible. Otherwise Apify's wrapper, unchanged.
  exampleRunInput: unknown;
}

export interface ApifyRunInfo {
  id: string;
  status: string;
  statusMessage: string | null;
  datasetId: string | null;
}

export interface ApifyRequestOptions {
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Apify accepts "username/name" in the console but "username~name" in API paths.
export function actorPathId(actorId: string): string {
  return encodeURIComponent(actorId.trim().replace('/', '~'));
}

// "." and ".." as a whole segment would change the request path, so they are never valid in an actor id.
export function hasDotSegment(actorId: string): boolean {
  return actorId
    .trim()
    .split(/[/~]/)
    .some((segment) => segment === '.' || segment === '..');
}

export const dotSegmentMessage = 'Use an actor id like username/actor-name, without "." or ".." parts';

export function normalizeActorId(actorId: string): string {
  return actorId.trim().replace('/', '~').toLowerCase();
}

async function request(
  token: string,
  method: 'GET' | 'POST',
  pathname: string,
  options: ApifyRequestOptions & { query?: Record<string, string | number>; body?: unknown } = {},
): Promise<unknown> {
  const url = new URL(`${apifyBaseUrl()}${pathname}`);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? apifyRequestTimeoutMilliseconds),
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ApifyError('timeout', 'Apify did not answer in time.');
    }
    throw new ApifyError('unavailable', 'Could not reach Apify.');
  }

  if (response.status === 401 || response.status === 403) {
    throw new ApifyError('unauthorized', 'Apify did not accept the API token.', response.status);
  }
  if (response.status === 404) throw new ApifyError('not_found', 'Apify could not find that resource.', 404);
  if (response.status === 429) throw new ApifyError('rate_limited', 'Apify is rate limiting requests.', 429);
  if (response.status >= 500) {
    throw new ApifyError('unavailable', `Apify had a server problem (HTTP ${response.status}).`, response.status);
  }
  if (!response.ok) {
    let reason = '';
    try {
      const body = (await response.json()) as unknown;
      const message = isRecord(body) && isRecord(body.error) ? text(body.error.message) : null;
      if (message) reason = `: ${message.replaceAll(token, '[removed]').slice(0, 300)}`;
    } catch {
      reason = '';
    }
    throw new ApifyError('rejected', `Apify rejected the request (HTTP ${response.status})${reason}`, response.status);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ApifyError('bad_response', 'Apify sent a response that is not valid JSON.', response.status);
  }
}

function dataOf(body: unknown): Json {
  if (isRecord(body) && isRecord(body.data)) return body.data;
  throw new ApifyError('bad_response', 'Apify sent a response in an unexpected shape.');
}

export async function validateToken(token: string, options: ApifyRequestOptions = {}): Promise<{ username: string | null }> {
  const data = dataOf(await request(token, 'GET', '/v2/users/me', options));
  return { username: text(data.username) };
}

const pricingLabels: Record<string, string> = {
  FREE: 'Free',
  PRICE_PER_DATASET_ITEM: 'Pay per result',
  PAY_PER_EVENT: 'Pay per event',
  FLAT_PRICE_PER_MONTH: 'Monthly rental',
};

function pricingHint(actor: Json): string | null {
  const infos = Array.isArray(actor.pricingInfos) ? actor.pricingInfos : [];
  const info = [actor.currentPricingInfo, infos[infos.length - 1]].find(isRecord);
  if (!info) return null;
  const model = text(info.pricingModel);
  if (!model) return null;
  const label = pricingLabels[model] ?? model.toLowerCase().replaceAll('_', ' ');
  const price = number(info.pricePerUnitUsd);
  if (price === null || model === 'FREE') return label;
  if (model === 'FLAT_PRICE_PER_MONTH') return `${label}, $${price} per month`;
  const unit = text(info.unitName) ?? (model === 'PRICE_PER_DATASET_ITEM' ? 'result' : 'unit');
  return `${label}, $${price} per ${unit}`;
}

function summarizeActor(actor: Json): ApifyActorSummary | null {
  const username = text(actor.username);
  const name = text(actor.name);
  const internalId = text(actor.id);
  const id = username && name ? `${username}~${name}` : internalId;
  if (!id) return null;
  const stats = isRecord(actor.stats) ? actor.stats : {};
  return {
    id,
    name: name ?? id,
    title: text(actor.title),
    username,
    description: text(actor.description),
    stats: { totalRuns: number(stats.totalRuns) },
    pricingHint: pricingHint(actor),
  };
}

export async function searchActors(
  token: string,
  query: string,
  limit = 20,
  options: ApifyRequestOptions = {},
): Promise<ApifyActorSummary[]> {
  const data = dataOf(
    await request(token, 'GET', '/v2/store', { ...options, query: { search: query, limit } }),
  );
  const items = Array.isArray(data.items) ? data.items : [];
  return items.filter(isRecord).flatMap((item) => {
    const summary = summarizeActor(item);
    return summary ? [summary] : [];
  });
}

function parseExampleInput(actor: Json): unknown {
  const example = actor.exampleRunInput;
  if (!isRecord(example)) return null;
  const body = example.body;
  if (isRecord(body)) return body;
  if (typeof body !== 'string') return example;
  try {
    const parsed = JSON.parse(body) as unknown;
    return isRecord(parsed) ? parsed : example;
  } catch {
    return example;
  }
}

export async function getActor(token: string, actorId: string, options: ApifyRequestOptions = {}): Promise<ApifyActorDetail> {
  const data = dataOf(await request(token, 'GET', `/v2/acts/${actorPathId(actorId)}`, options));
  const summary = summarizeActor(data);
  if (!summary) throw new ApifyError('bad_response', 'Apify sent an actor without an id.');
  return { ...summary, exampleRunInput: parseExampleInput(data) };
}

function runInfo(data: Json): ApifyRunInfo {
  const id = text(data.id);
  const status = text(data.status);
  if (!id || !status) throw new ApifyError('bad_response', 'Apify sent a run without an id or status.');
  return { id, status, statusMessage: text(data.statusMessage), datasetId: text(data.defaultDatasetId) };
}

// maxItems and timeoutSeconds are Apify's own caps, so the user's account is not charged past them.
export async function startRun(
  token: string,
  actorId: string,
  input: Record<string, unknown>,
  caps: { maxItems: number; timeoutSeconds: number },
  options: ApifyRequestOptions = {},
): Promise<ApifyRunInfo> {
  const data = dataOf(
    await request(token, 'POST', `/v2/acts/${actorPathId(actorId)}/runs`, {
      ...options,
      query: { maxItems: caps.maxItems, timeout: caps.timeoutSeconds },
      body: input,
    }),
  );
  return runInfo(data);
}

export async function getRun(token: string, runId: string, options: ApifyRequestOptions = {}): Promise<ApifyRunInfo> {
  return runInfo(dataOf(await request(token, 'GET', `/v2/actor-runs/${encodeURIComponent(runId)}`, options)));
}

export async function abortRun(token: string, runId: string, options: ApifyRequestOptions = {}): Promise<void> {
  await request(token, 'POST', `/v2/actor-runs/${encodeURIComponent(runId)}/abort`, options);
}

export interface DatasetResult {
  items: unknown[];
  // Set when a later page failed. The items already read are still returned.
  stoppedEarly: string | null;
}

export async function getDatasetItems(
  token: string,
  datasetId: string,
  maxItems: number,
  options: ApifyRequestOptions & { pageSize?: number } = {},
): Promise<DatasetResult> {
  const pageSize = options.pageSize ?? 100;
  const items: unknown[] = [];
  let offset = 0;
  while (items.length < maxItems) {
    const limit = Math.min(pageSize, maxItems - items.length);
    let body: unknown;
    try {
      body = await request(token, 'GET', `/v2/datasets/${encodeURIComponent(datasetId)}/items`, {
        ...options,
        query: { format: 'json', limit, offset },
      });
    } catch (error) {
      if (items.length > 0 && error instanceof ApifyError) return { items, stoppedEarly: error.message };
      throw error;
    }
    if (!Array.isArray(body)) {
      if (items.length > 0) return { items, stoppedEarly: 'Apify sent a dataset page in an unexpected shape.' };
      throw new ApifyError('bad_response', 'Apify sent dataset items in an unexpected shape.');
    }
    items.push(...body);
    offset += body.length;
    if (body.length < limit) break;
  }
  return { items: items.slice(0, maxItems), stoppedEarly: null };
}
