import { normalizeCounts } from '../lib/imports';
import type {
  Activity,
  AgentReply,
  ApifyActorDetail,
  ApifyActorSummary,
  ApifyRunInput,
  Approval,
  Claim,
  Connector,
  Health,
  ImportBatch,
  ImportBatchPage,
  ImportRow,
  Opportunity,
  Organization,
  OrganizationDetail,
  Page,
  Person,
  PersonDetail,
  Pipeline,
  Run,
  RunCounts,
  SearchResults,
  Task,
  TodayData,
  Workspace,
} from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  current?: unknown;

  constructor(status: number, code: string, message: string, current?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.current = current;
  }
}

export function isVersionConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === 'version_conflict';
}

type Query = Record<string, string | number | undefined | null>;

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

// The contract names request fields in camelCase and columns in snake_case.
// Accept either on the way in so the UI does not depend on that choice.
function camelizeKeys(value: unknown, preserve: string[] = []): unknown {
  if (preserve.length > 0 && value && typeof value === 'object' && !Array.isArray(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      result[snakeToCamel(key)] = preserve.includes(key) ? inner : camelizeKeys(inner);
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((entry) => camelizeKeys(entry));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      result[snakeToCamel(key)] = camelizeKeys(inner);
    }
    return result;
  }
  return value;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toArray<T>(value: unknown): T[] {
  const parsed = parseMaybeJson(value);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: {
    query?: Query;
    body?: unknown;
    signal?: AbortSignal;
    // Top level response keys whose values keep their original key spelling.
    preserve?: string[];
  } = {},
): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const queryString = params.toString();
  const url = `/api${path}${queryString ? `?${queryString}` : ''}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      0,
      'network',
      'Cannot reach the AgentCRM server. Start it with npm run dev from the repository root, then retry.',
    );
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  let unreadable = false;
  if (text) {
    try {
      parsed = camelizeKeys(JSON.parse(text), options.preserve);
    } catch {
      unreadable = true;
    }
  }
  if (response.ok && unreadable) {
    throw new ApiError(
      response.status,
      'internal',
      'The server answered with something that is not JSON. Check that the API is running on port 4720, then retry.',
    );
  }

  if (!response.ok) {
    const envelope = (parsed as { error?: { code?: string; message?: string; current?: unknown } } | undefined)
      ?.error;
    throw new ApiError(
      response.status,
      envelope?.code ?? (response.status === 404 ? 'not_found' : 'internal'),
      envelope?.message ??
        `The server returned status ${response.status}. Check the server log, then retry.`,
      envelope?.current,
    );
  }
  return parsed as T;
}

function asPage<T>(data: unknown): Page<T> {
  if (Array.isArray(data)) return { items: data as T[], nextCursor: null };
  const record = (data ?? {}) as { items?: unknown; nextCursor?: unknown };
  return {
    items: Array.isArray(record.items) ? (record.items as T[]) : [],
    nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : null,
  };
}

function normalizePerson(raw: Person): Person {
  return { ...raw, tags: toArray<string>(raw.tags) };
}

function normalizeOrganization(raw: Organization): Organization {
  return { ...raw, tags: toArray<string>(raw.tags) };
}

function normalizeRun(raw: Run): Run {
  const counts = (parseMaybeJson(raw.counts) ?? {}) as Partial<RunCounts>;
  const scope = parseMaybeJson(raw.scope);
  return {
    ...raw,
    counts: {
      processed: Number(counts.processed ?? 0),
      found: Number(counts.found ?? 0),
      flagged: Number(counts.flagged ?? 0),
    },
    scope: scope && typeof scope === 'object' ? (scope as Record<string, unknown>) : {},
    steps: raw.steps ? [...raw.steps].sort((a, b) => a.seq - b.seq) : raw.steps,
    approvals: raw.approvals ? raw.approvals.map(normalizeApproval) : raw.approvals,
  };
}

function normalizeApproval(raw: Approval): Approval {
  return { ...raw, payload: parseMaybeJson(raw.payload) };
}

function normalizePersonDetail(data: unknown): PersonDetail {
  const record = data as Record<string, unknown>;
  const flat = (record.person && typeof record.person === 'object'
    ? { ...(record.person as object), ...record, person: undefined }
    : record) as unknown as PersonDetail;
  return {
    ...normalizePerson(flat),
    organization: flat.organization ? normalizeOrganization(flat.organization) : null,
    affiliationsSummary: flat.affiliationsSummary ?? null,
    claims: toArray<Claim>(flat.claims),
    activities: toArray<Activity>(flat.activities),
    tasks: toArray<Task>(flat.tasks),
    opportunities: toArray<Opportunity>(flat.opportunities),
  };
}

function normalizeOrganizationDetail(data: unknown): OrganizationDetail {
  const record = data as Record<string, unknown>;
  const flat = (record.organization && typeof record.organization === 'object'
    ? { ...(record.organization as object), ...record, organization: undefined }
    : record) as unknown as OrganizationDetail;
  return {
    ...normalizeOrganization(flat),
    people: toArray<Person>(flat.people).map(normalizePerson),
    claims: toArray<Claim>(flat.claims),
    activities: toArray<Activity>(flat.activities),
    opportunities: toArray<Opportunity>(flat.opportunities),
  };
}

function textOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  const parsed = parseMaybeJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

// The server may report why a connector is in error as a string or as an error envelope.
function messageFrom(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const direct = textOrNull(candidate);
    if (direct) return direct;
    if (candidate && typeof candidate === 'object') {
      const nested = textOrNull((candidate as { message?: unknown }).message);
      if (nested) return nested;
    }
  }
  return null;
}

function normalizeConnector(raw: unknown): Connector {
  const record = objectOrEmpty(raw);
  const settings = objectOrEmpty(record.settings);
  const allowlistSource = settings.allowlist ?? record.allowlist;
  return {
    id: textOrNull(record.id),
    kind: textOrNull(record.kind) ?? 'apify',
    status: textOrNull(record.status) ?? 'connected',
    statusMessage: messageFrom(
      record.statusMessage,
      record.error,
      record.message,
      record.lastError,
      settings.statusMessage,
      settings.lastError,
      settings.error,
    ),
    allowlist: toArray<unknown>(allowlistSource).filter((entry): entry is string => typeof entry === 'string'),
    tokenMasked: textOrNull(record.tokenMasked ?? settings.tokenMasked),
    updatedAt: textOrNull(record.updatedAt),
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function describePricing(raw: Record<string, unknown>): string | null {
  const hint = textOrNull(raw.pricingHint);
  if (hint) return hint;
  const pricing = raw.pricing ?? raw.pricingInfo;
  const direct = textOrNull(pricing);
  if (direct) return direct;
  const info = objectOrEmpty(pricing);
  const model = textOrNull(info.pricingModel ?? info.model);
  if (!model) return null;
  const label = model.toLowerCase().replace(/_/g, ' ');
  const sentence = label.charAt(0).toUpperCase() + label.slice(1);
  const price = numberOrNull(info.pricePerUnitUsd ?? info.price);
  return price !== null && price > 0 ? `${sentence}, $${price} per unit` : sentence;
}

function normalizeActorSummary(raw: unknown): ApifyActorSummary | null {
  const record = objectOrEmpty(raw);
  const name = textOrNull(record.name);
  const username = textOrNull(record.username);
  const id = textOrNull(record.id) ?? (username && name ? `${username}~${name}` : null);
  if (!id) return null;
  const stats = objectOrEmpty(record.stats);
  return {
    id,
    name,
    title: textOrNull(record.title),
    username,
    description: textOrNull(record.description),
    totalRuns: numberOrNull(stats.totalRuns ?? stats.runs ?? record.totalRuns),
    pricingHint: describePricing(record),
  };
}

// Apify returns example input either as an object or as { body, contentType } with a JSON string body.
function normalizeExampleInput(value: unknown): Record<string, unknown> | null {
  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  if (typeof record.body === 'string' && 'contentType' in record) return normalizeExampleInput(record.body);
  return Object.keys(record).length > 0 ? record : null;
}

function normalizeActorDetail(raw: unknown): ApifyActorDetail | null {
  const record = objectOrEmpty(raw);
  const summary = normalizeActorSummary(record);
  if (!summary) return null;
  return { ...summary, exampleInput: normalizeExampleInput(record.exampleRunInput) };
}

function normalizeImportBatch(raw: Record<string, unknown>): ImportBatch {
  const sourceRef = objectOrEmpty(raw.sourceRef);
  return {
    id: textOrNull(raw.id) ?? '',
    runId: textOrNull(raw.runId),
    sourceKind: textOrNull(raw.sourceKind) ?? 'apify',
    actorId: textOrNull(sourceRef.actorId),
    apifyRunId: textOrNull(sourceRef.apifyRunId ?? sourceRef.runId),
    datasetId: textOrNull(sourceRef.datasetId),
    status: textOrNull(raw.status) ?? 'staging',
    counts: normalizeCounts(raw.counts),
    updatedAt: textOrNull(raw.updatedAt),
  };
}

function normalizeImportRow(raw: unknown): ImportRow {
  const record = objectOrEmpty(raw);
  return {
    seq: Number(record.seq ?? 0),
    status: textOrNull(record.status) ?? 'staged',
    reason: textOrNull(record.reason),
    mapped: objectOrEmpty(record.mapped),
    matchEntityType: textOrNull(record.matchEntityType),
    matchEntityId: textOrNull(record.matchEntityId),
  };
}

// The batch and its rows may arrive as { batch, rows } or as the batch with items beside it.
function normalizeImportPage(data: unknown): ImportBatchPage {
  const record = objectOrEmpty(data);
  const nested = record.batch && typeof record.batch === 'object' ? objectOrEmpty(record.batch) : null;
  const batchRecord = nested ?? record;
  const rowsPage = asPage<unknown>(record.rows ?? record.items ?? batchRecord.rows);
  return {
    batch: normalizeImportBatch(batchRecord),
    items: rowsPage.items.map(normalizeImportRow),
    nextCursor: rowsPage.nextCursor ?? (typeof record.nextCursor === 'string' ? record.nextCursor : null),
  };
}

export interface ListParams {
  q?: string;
  cursor?: string | null;
  limit?: number;
}

export const api = {
  health: () => request<Health>('GET', '/health'),
  workspace: () => request<Workspace>('GET', '/workspace'),

  today: async (): Promise<TodayData> => {
    const data = await request<Partial<TodayData>>('GET', '/today');
    return {
      tasksDue: asPage<Task>(data.tasksDue).items,
      approvalsPending: asPage<Approval>(data.approvalsPending).items.map(normalizeApproval),
      runsActive: asPage<Run>(data.runsActive).items.map(normalizeRun),
      counts: (data.counts ?? {}) as Record<string, number>,
    };
  },

  people: {
    list: async (params: ListParams) => {
      const page = asPage<Person>(
        await request<unknown>('GET', '/people', { query: { ...params } }),
      );
      return { ...page, items: page.items.map(normalizePerson) };
    },
    get: async (id: string) => normalizePersonDetail(await request<unknown>('GET', `/people/${id}`)),
    patch: (id: string, expectedVersion: number, fields: Record<string, unknown>) =>
      request<Person>('PATCH', `/people/${id}`, { body: { expectedVersion, fields } }),
  },

  organizations: {
    list: async (params: ListParams) => {
      const page = asPage<Organization>(
        await request<unknown>('GET', '/organizations', { query: { ...params } }),
      );
      return { ...page, items: page.items.map(normalizeOrganization) };
    },
    get: async (id: string) =>
      normalizeOrganizationDetail(await request<unknown>('GET', `/organizations/${id}`)),
    patch: (id: string, expectedVersion: number, fields: Record<string, unknown>) =>
      request<Organization>('PATCH', `/organizations/${id}`, { body: { expectedVersion, fields } }),
  },

  pipelines: async () => asPage<Pipeline>(await request<unknown>('GET', '/pipelines')).items.map((pipeline) => ({
    ...pipeline,
    stages: [...(pipeline.stages ?? [])].sort((a, b) => a.seq - b.seq),
  })),

  opportunities: {
    list: async (params: { pipelineId?: string; stageId?: string; status?: string }) =>
      asPage<Opportunity>(await request<unknown>('GET', '/opportunities', { query: { ...params, limit: 200 } })).items,
    moveStage: (id: string, stageId: string, expectedVersion: number) =>
      request<Opportunity>('POST', `/opportunities/${id}/stage`, { body: { stageId, expectedVersion } }),
    patch: (id: string, expectedVersion: number, fields: Record<string, unknown>) =>
      request<Opportunity>('PATCH', `/opportunities/${id}`, { body: { expectedVersion, fields } }),
  },

  tasks: {
    list: async (filter: 'today' | 'overdue' | 'open' | 'done') =>
      asPage<Task>(await request<unknown>('GET', '/tasks', { query: { filter } })).items,
    patch: (id: string, expectedVersion: number, fields: Record<string, unknown>) =>
      request<Task>('PATCH', `/tasks/${id}`, { body: { expectedVersion, fields } }),
  },

  activities: {
    list: async (entityType: string, entityId: string) =>
      asPage<Activity>(await request<unknown>('GET', '/activities', { query: { entityType, entityId } })).items,
    createNote: (entityType: string, entityId: string, body: string) =>
      request<Activity>('POST', '/activities', { body: { entityType, entityId, kind: 'note', body } }),
  },

  runs: {
    list: async (status?: string) =>
      asPage<Run>(await request<unknown>('GET', '/runs', { query: { status } })).items.map(normalizeRun),
    start: async (title?: string) =>
      normalizeRun(await request<Run>('POST', '/runs', { body: { kind: 'demo_research', title } })),
    startApify: async (input: ApifyRunInput) =>
      normalizeRun(
        await request<Run>('POST', '/runs', {
          body: {
            kind: 'apify_scrape',
            title: input.title,
            scope: { actorId: input.actorId, input: input.input, maxItems: input.maxItems },
          },
        }),
      ),
    get: async (id: string) => normalizeRun(await request<Run>('GET', `/runs/${id}`)),
    control: (id: string, action: 'pause' | 'resume' | 'cancel') =>
      request<unknown>('POST', `/runs/${id}/control`, { body: { action } }),
  },

  approvals: {
    list: async (status?: string) =>
      asPage<Approval>(await request<unknown>('GET', '/approvals', { query: { status } })).items.map(
        normalizeApproval,
      ),
    decide: (id: string, decision: 'approve' | 'reject', note?: string) =>
      request<unknown>('POST', `/approvals/${id}/decision`, { body: { decision, note } }),
  },

  connectors: {
    list: async (): Promise<Connector[]> => {
      const data = await request<unknown>('GET', '/connectors');
      const source = data && typeof data === 'object' && !Array.isArray(data) && 'connectors' in data
        ? (data as { connectors: unknown }).connectors
        : data;
      return asPage<unknown>(source).items.map(normalizeConnector);
    },
    // The token is optional so the allowlist can be edited while connected.
    saveApify: async (input: { token?: string; allowlist?: string[] }) =>
      normalizeConnector(await request<unknown>('PUT', '/connectors/apify', { body: input })),
    removeApify: () => request<unknown>('DELETE', '/connectors/apify'),
  },

  apify: {
    searchActors: async (q: string, signal?: AbortSignal): Promise<ApifyActorSummary[]> => {
      const data = await request<unknown>('GET', '/connectors/apify/actors', { query: { q }, signal });
      return asPage<unknown>(data)
        .items.map(normalizeActorSummary)
        .filter((actor): actor is ApifyActorSummary => actor !== null);
    },
    actor: async (id: string, signal?: AbortSignal): Promise<ApifyActorDetail> => {
      const data = await request<unknown>('GET', `/connectors/apify/actors/${encodeURIComponent(id)}`, {
        signal,
        preserve: ['exampleRunInput', 'example_run_input'],
      });
      const detail = normalizeActorDetail(data);
      if (!detail) {
        throw new ApiError(0, 'internal', 'Apify returned details for this actor that could not be read. Choose another actor.');
      }
      return detail;
    },
  },

  imports: {
    get: async (id: string, params: { cursor?: string | null; limit?: number; status?: string }) =>
      normalizeImportPage(
        await request<unknown>('GET', `/imports/${encodeURIComponent(id)}`, { query: { ...params } }),
      ),
  },

  search: async (q: string, signal?: AbortSignal): Promise<SearchResults> => {
    const data = await request<Partial<SearchResults>>('GET', '/search', { query: { q }, signal });
    return {
      people: toArray<Person>(data.people),
      organizations: toArray<Organization>(data.organizations),
      opportunities: toArray<Opportunity>(data.opportunities),
    };
  },

  agentMessage: async (text: string): Promise<AgentReply> => {
    const data = await request<Partial<AgentReply>>('POST', '/agent/message', { body: { text } });
    return { reply: data.reply ?? '', actions: toArray(data.actions), modelConnected: data.modelConnected };
  },
};
