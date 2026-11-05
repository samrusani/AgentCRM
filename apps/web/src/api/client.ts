import { normalizeCounts } from '../lib/imports';
import { DEFAULT_LEAD_ACTORS } from '../lib/leads';
import { DAILY_SEND_CAP, parseExcluded } from '../lib/mail';
import type {
  Activity,
  AgentMessageInput,
  AgentReply,
  AgentUsage,
  ApifyActorDetail,
  ApifyActorSummary,
  ApifyConnectorInput,
  ApifyRunInput,
  Approval,
  CaptureSettings,
  CaptureToken,
  Claim,
  Connector,
  Criterion,
  CriterionOperator,
  CriterionOutcome,
  CriterionResult,
  CriterionTarget,
  CriterionField,
  CsvImportInput,
  CsvPreview,
  EnrichmentState,
  DraftOutreachInput,
  Health,
  LeadCaptureInput,
  LeadCaptureSettings,
  GmailCredentialsInput,
  MicrosoftCredentialsInput,
  ImapConnectorInput,
  ImapPreset,
  ImapSettings,
  MailInbox,
  FollowupRule,
  MailProviderKind,
  MailProviderSelection,
  MailReply,
  ModelProviderInput,
  ModelProviderKind,
  ModelProviderSelection,
  OllamaModel,
  MailSummary,
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
  QualificationConfig,
  QualificationResult,
  QualificationSummary,
  Run,
  RunCounts,
  SearchResults,
  SendIntent,
  StageSendInput,
  StageSendResult,
  Suppression,
  Task,
  TodayData,
  TemplateSwitchInput,
  Workspace,
  WorkspaceTemplate,
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
  return { ...raw, tags: toArray<string>(raw.tags), qualification: normalizeSummary(raw.qualification) };
}

function normalizeOrganization(raw: Organization): Organization {
  return { ...raw, tags: toArray<string>(raw.tags) };
}

function normalizeRun(raw: Run): Run {
  const counts = (parseMaybeJson(raw.counts) ?? {}) as Partial<RunCounts>;
  const scope = parseMaybeJson(raw.scope);
  const excluded = counts.excluded === undefined || counts.excluded === null ? undefined : Number(counts.excluded);
  const estimatedUsd =
    counts.estimatedUsd === undefined || counts.estimatedUsd === null ? undefined : Number(counts.estimatedUsd);
  return {
    ...raw,
    counts: {
      processed: Number(counts.processed ?? 0),
      found: Number(counts.found ?? 0),
      flagged: Number(counts.flagged ?? 0),
      ...(excluded !== undefined && Number.isFinite(excluded) ? { excluded } : {}),
      ...(estimatedUsd !== undefined && Number.isFinite(estimatedUsd) ? { estimatedUsd } : {}),
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
    ...normalizePerson(flat as unknown as Person),
    qualification: normalizeQualificationResult((record.qualification ?? flat.qualification) as unknown),
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

// Apify connectors always carry the five actors. An older server that omits them gets the documented defaults.
function normalizeLeadCapture(kind: unknown, raw: unknown): LeadCaptureSettings | null {
  if (textOrNull(kind) !== 'apify') return null;
  const record = objectOrEmpty(raw);
  return {
    postActor: textOrNull(record.postActor) ?? DEFAULT_LEAD_ACTORS.postActor,
    reactionsActor: textOrNull(record.reactionsActor) ?? DEFAULT_LEAD_ACTORS.reactionsActor,
    commentsActor: textOrNull(record.commentsActor) ?? DEFAULT_LEAD_ACTORS.commentsActor,
    profileActor: textOrNull(record.profileActor) ?? DEFAULT_LEAD_ACTORS.profileActor,
    companyActor: textOrNull(record.companyActor) ?? DEFAULT_LEAD_ACTORS.companyActor,
  };
}

// Only the IMAP and SMTP connector carries these. The server may nest the servers and the verified flags or send them flat.
function normalizeImap(kind: unknown, settings: Record<string, unknown>): ImapSettings | null {
  if (kind !== 'imap') return null;
  const servers = objectOrEmpty(settings.servers);
  const verified = objectOrEmpty(settings.verified);
  const pick = (key: string) => servers[key] ?? settings[key];
  const preset = textOrNull(settings.preset);
  return {
    preset: preset === 'icloud' || preset === 'fastmail' || preset === 'custom' ? (preset as ImapPreset) : null,
    servers: {
      imapHost: textOrNull(pick('imapHost')),
      imapPort: numberOrNull(pick('imapPort')),
      smtpHost: textOrNull(pick('smtpHost')),
      smtpPort: numberOrNull(pick('smtpPort')),
      smtpTls: textOrNull(pick('smtpTls')),
    },
    sentMailbox: textOrNull(settings.sentMailbox),
    imapOk: (verified.imapOk ?? settings.imapOk) === true,
    smtpOk: (verified.smtpOk ?? settings.smtpOk) === true,
  };
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
    leadCapture: normalizeLeadCapture(record.kind, settings.leadCapture),
    model: textOrNull(settings.model ?? record.model),
    baseUrl: textOrNull(settings.baseUrl ?? record.baseUrl),
    inboxId: textOrNull(settings.inboxId ?? record.inboxId),
    inboxEmail: textOrNull(settings.inboxEmail ?? settings.email ?? record.inboxEmail),
    clientId: textOrNull(settings.clientId ?? settings.clientIdMasked ?? record.clientId ?? record.clientIdMasked),
    emailAddress: textOrNull(settings.emailAddress ?? settings.address ?? record.emailAddress),
    oauthCompletedAt: textOrNull(settings.oauthCompletedAt),
    lastSyncAt: textOrNull(settings.lastSyncAt ?? record.lastSyncAt),
    tokenMasked: textOrNull(record.tokenMasked ?? settings.tokenMasked),
    updatedAt: textOrNull(record.updatedAt),
    imap: normalizeImap(textOrNull(record.kind), settings),
  };
}

// Accepts a bare array, { models }, or { items }, with entries as strings or objects carrying name or model.
function normalizeOllamaModels(data: unknown): OllamaModel[] {
  const source = objectOrEmpty(data);
  const list = Array.isArray(data) ? data : source.models ?? source.items ?? source.data;
  const names: string[] = [];
  for (const entry of asPage<unknown>(list).items) {
    const name =
      typeof entry === 'string' ? textOrNull(entry) : textOrNull(objectOrEmpty(entry).name ?? objectOrEmpty(entry).model);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.map((name) => ({ name }));
}

// Null when no provider is configured. Also tolerates the selection nested under a key.
function normalizeModelProvider(data: unknown): ModelProviderSelection | null {
  const record = objectOrEmpty(data);
  const nested = objectOrEmpty(record.modelProvider ?? record.provider);
  const source = textOrNull(record.kind) ? record : nested;
  const kind = textOrNull(source.kind);
  if (!kind) return null;
  const model = textOrNull(source.model);
  const status = textOrNull(source.status) === 'error' ? 'error' : 'connected';
  // An older server sends neither field, so readiness falls back to the same rule the server applies.
  const ready = typeof source.ready === 'boolean' ? source.ready : status === 'connected' && (kind !== 'ollama' || model !== null);
  return { kind, model, status, statusMessage: textOrNull(source.statusMessage), ready };
}

// Null when no mail connector is in use.
function normalizeMailProvider(data: unknown): MailProviderSelection | null {
  const record = objectOrEmpty(data);
  const kind = textOrNull(record.kind);
  if (!kind) return null;
  const address = textOrNull(record.address);
  return {
    kind,
    address,
    ready: typeof record.ready === 'boolean' ? record.ready : address !== null,
    lastSyncAt: textOrNull(record.lastSyncAt),
  };
}

function normalizeInbox(raw: unknown): MailInbox | null {
  const record = objectOrEmpty(raw);
  const id = textOrNull(record.id ?? record.inboxId);
  if (!id) return null;
  // The provider uses the address as the inbox id, so either field can stand in for the other.
  const email = textOrNull(record.email ?? record.inboxEmail ?? record.address) ?? id;
  return { id, email };
}

function normalizeInboxList(data: unknown): MailInbox[] {
  const source = objectOrEmpty(data);
  const list = Array.isArray(data) ? data : source.items ?? source.inboxes ?? source.data;
  return asPage<unknown>(list)
    .items.map(normalizeInbox)
    .filter((inbox): inbox is MailInbox => inbox !== null);
}

function normalizeIntent(raw: unknown): SendIntent {
  const record = objectOrEmpty(raw);
  return {
    id: textOrNull(record.id) ?? '',
    personId: textOrNull(record.personId),
    personName: textOrNull(record.personName),
    toEmail: textOrNull(record.toEmail ?? record.to) ?? '',
    subject: textOrNull(record.subject) ?? '',
    status: textOrNull(record.status) ?? 'unknown',
    error: messageFrom(record.error, record.reason, record.statusMessage),
    providerMessageId: textOrNull(record.providerMessageId),
    provider: textOrNull(record.provider),
    address: textOrNull(record.address),
    submittedAt: textOrNull(record.submittedAt),
    updatedAt: textOrNull(record.updatedAt),
    followupRuleId: textOrNull(record.followupRuleId),
    followupStep: positiveIntOrNull(record.followupStep),
  };
}

function positiveIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
}

function normalizeFollowupRule(raw: unknown): FollowupRule {
  const record = objectOrEmpty(raw);
  const steps = toArray<unknown>(record.steps).map((entry) => {
    const step = objectOrEmpty(entry);
    return { waitDays: Number(step.waitDays) || 0, body: typeof step.body === 'string' ? step.body : '' };
  });
  return {
    id: textOrNull(record.id) ?? '',
    personId: textOrNull(record.personId),
    personName: textOrNull(record.personName),
    status: textOrNull(record.status) ?? 'waiting',
    steps,
    nextStep: positiveIntOrNull(record.nextStep) ?? 1,
    nextDueAt: textOrNull(record.nextDueAt),
    stoppedReason: textOrNull(record.stoppedReason),
    provider: textOrNull(record.provider),
    anchorIntentId: textOrNull(record.anchorIntentId),
    anchorSubject: textOrNull(record.anchorSubject),
    lastIntentId: textOrNull(record.lastIntentId),
    createdAt: textOrNull(record.createdAt),
    updatedAt: textOrNull(record.updatedAt),
  };
}

function normalizeSuppression(raw: unknown): Suppression {
  const record = objectOrEmpty(raw);
  return {
    id: textOrNull(record.id) ?? '',
    email: textOrNull(record.email) ?? '',
    reason: textOrNull(record.reason) ?? 'manual',
    createdAt: textOrNull(record.createdAt),
    matchedWording: textOrNull(record.matchedWording ?? record.matchedText ?? record.matched),
  };
}

function normalizeReply(raw: unknown, index: number): MailReply {
  const record = objectOrEmpty(raw);
  const optOutField = record.optOut ?? record.optedOut;
  const optOutRecord = objectOrEmpty(optOutField);
  const suppression = objectOrEmpty(record.suppression);
  const kind = textOrNull(record.kind ?? record.type ?? record.reason);
  const matched = textOrNull(
    record.matchedWording ??
      record.matchedText ??
      record.matchedPhrase ??
      record.matched ??
      optOutRecord.matchedWording ??
      optOutRecord.matched ??
      optOutRecord.wording ??
      suppression.matchedWording,
  );
  const suppressionId = textOrNull(record.suppressionId ?? optOutRecord.suppressionId ?? suppression.id);
  return {
    id: textOrNull(record.id ?? record.messageId) ?? `reply-${index}`,
    personId: textOrNull(record.personId),
    personName: textOrNull(record.personName),
    fromEmail: textOrNull(record.fromEmail ?? record.from ?? record.email),
    subject: textOrNull(record.subject),
    preview: textOrNull(record.body ?? record.text ?? record.snippet ?? record.preview),
    receivedAt: textOrNull(record.receivedAt ?? record.createdAt ?? record.at),
    taskId: textOrNull(record.taskId),
    taskTitle: textOrNull(record.taskTitle),
    optOut:
      optOutField === true ||
      Object.keys(optOutRecord).length > 0 ||
      kind === 'opt_out' ||
      suppressionId !== null ||
      matched !== null,
    matchedWording: matched,
    suppressionId,
  };
}

function normalizeMailSummary(data: unknown): MailSummary {
  const record = objectOrEmpty(data);
  const counts: Record<string, number> = {};
  for (const [status, value] of Object.entries(objectOrEmpty(record.counts))) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) counts[status] = Math.max(0, Math.floor(parsed));
  }
  const remaining = numberOrNull(record.remainingDailyCap);
  const cap = numberOrNull(record.dailyCap);
  const attention = record.repliesNeedingAttention;
  const attentionRecord = objectOrEmpty(attention);
  const list = Array.isArray(attention) ? attention : toArray<unknown>(attentionRecord.items ?? record.replies);
  const replies = list.map(normalizeReply);
  const reported = typeof attention === 'number' ? attention : numberOrNull(attentionRecord.count);
  return {
    counts,
    remainingDailyCap: remaining === null ? null : Math.max(0, Math.floor(remaining)),
    dailyCap: cap !== null && cap > 0 ? Math.floor(cap) : DAILY_SEND_CAP,
    lastSyncAt: textOrNull(record.lastSyncAt),
    replies,
    repliesNeedingAttention: Math.max(replies.length, reported === null ? 0 : Math.floor(reported)),
  };
}

function normalizeUsage(raw: unknown): AgentUsage | null {
  const record = objectOrEmpty(raw);
  const input = Number(record.inputTokens);
  const output = Number(record.outputTokens);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const usd = Number(record.estimatedUsd);
  return {
    inputTokens: Math.max(0, Math.round(input)),
    outputTokens: Math.max(0, Math.round(output)),
    estimatedUsd: Number.isFinite(usd) && usd >= 0 ? usd : 0,
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
    postUrl: textOrNull(sourceRef.postUrl),
    apifyRunId: textOrNull(sourceRef.apifyRunId ?? sourceRef.runId),
    datasetId: textOrNull(sourceRef.datasetId),
    status: textOrNull(raw.status) ?? 'staging',
    counts: normalizeCounts(raw.counts),
    updatedAt: textOrNull(raw.updatedAt),
  };
}

// A row that was named in a post text keeps the snippet in raw.sources as { kind: 'post', quote }.
function postQuoteOf(raw: unknown): string | null {
  const sources = objectOrEmpty(raw).sources;
  if (!Array.isArray(sources)) return null;
  for (const entry of sources) {
    const record = objectOrEmpty(entry);
    if (record.kind === 'post') {
      const quote = textOrNull(record.quote);
      if (quote) return quote;
    }
  }
  return null;
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
    postQuote: postQuoteOf(record.raw),
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

function wholeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function normalizeSummary(raw: unknown): QualificationSummary | null {
  const parsed = parseMaybeJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  return {
    matched: wholeNumber(record.matched),
    total: wholeNumber(record.total),
    unknown: wholeNumber(record.unknown),
    excluded: record.excluded === true || record.excluded === 1,
    computedAt: textOrNull(record.computedAt),
  };
}

const OUTCOMES: CriterionOutcome[] = ['matched', 'not_matched', 'unknown'];

function reasonText(value: unknown): string | null {
  if (typeof value === 'string') return textOrNull(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return textOrNull(record.reason) ?? textOrNull(record.label) ?? textOrNull(record.message);
  }
  return null;
}

function normalizeCriterionResult(raw: unknown): CriterionResult {
  const record = objectOrEmpty(raw);
  const outcome = textOrNull(record.outcome) as CriterionOutcome | null;
  return {
    id: textOrNull(record.id) ?? '',
    label: textOrNull(record.label) ?? 'Criterion',
    // Anything the UI does not recognize is shown as unknown, never as a match.
    outcome: outcome && OUTCOMES.includes(outcome) ? outcome : 'unknown',
    reason: textOrNull(record.reason),
    evidence: record.evidence ?? null,
  };
}

function normalizeQualificationResult(raw: unknown): QualificationResult | null {
  const summary = normalizeSummary(raw);
  if (!summary) return null;
  const record = objectOrEmpty(raw);
  const reasons = toArray<unknown>(record.excludedReasons)
    .map(reasonText)
    .filter((entry): entry is string => entry !== null);
  return {
    ...summary,
    excludedReasons: reasons,
    criteria: toArray<unknown>(record.criteria).map(normalizeCriterionResult),
  };
}

function normalizeCriterion(raw: unknown): Criterion {
  const record = objectOrEmpty(raw);
  return {
    id: textOrNull(record.id) ?? '',
    label: textOrNull(record.label) ?? '',
    target: (textOrNull(record.target) ?? 'person') as CriterionTarget,
    field: (textOrNull(record.field) ?? 'title') as CriterionField,
    operator: (textOrNull(record.operator) ?? 'contains') as CriterionOperator,
    values: toArray<unknown>(record.values).filter((entry): entry is string => typeof entry === 'string'),
    enabled: record.enabled !== false,
  };
}

function normalizeQualificationConfig(raw: unknown): QualificationConfig {
  const record = objectOrEmpty(raw);
  return {
    exclusions: toArray<unknown>(record.exclusions).map(normalizeCriterion),
    criteria: toArray<unknown>(record.criteria).map(normalizeCriterion),
    defaulted: record.defaulted === true,
  };
}

function normalizeCsvPreview(raw: unknown): CsvPreview {
  const record = objectOrEmpty(raw);
  const headers = toArray<unknown>(record.headers).map((entry) => String(entry ?? ''));
  const mappingSource = objectOrEmpty(record.suggestedMapping);
  const suggestedMapping: Record<string, string> = {};
  for (const [header, target] of Object.entries(mappingSource)) {
    if (typeof target === 'string') suggestedMapping[header] = target;
  }
  // Sample rows may be arrays in header order or objects keyed by header.
  const sample = toArray<unknown>(record.sample).map((entry): string[] => {
    if (Array.isArray(entry)) return entry.map((cell) => (cell === null || cell === undefined ? '' : String(cell)));
    const row = objectOrEmpty(entry);
    return headers.map((header) => {
      const cell = row[header];
      return cell === null || cell === undefined ? '' : String(cell);
    });
  });
  const rowCount = Number(record.rowCount);
  return {
    headers,
    delimiter: typeof record.delimiter === 'string' ? record.delimiter : ',',
    rowCount: Number.isFinite(rowCount) && rowCount >= 0 ? Math.floor(rowCount) : 0,
    suggestedMapping,
    sample,
  };
}

export interface ListParams {
  q?: string;
  sort?: string;
  cursor?: string | null;
  limit?: number;
}

export const api = {
  health: () => request<Health>('GET', '/health'),
  workspace: () => request<Workspace>('GET', '/workspace'),
  templates: async () => asPage<WorkspaceTemplate>(await request<unknown>('GET', '/templates')).items,
  switchTemplate: (input: TemplateSwitchInput) =>
    request<Workspace>('POST', '/workspace/template', { body: input }),

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
    // The person's newest enrich run and the suggestions still waiting for a decision.
    enrichment: async (id: string): Promise<EnrichmentState> => {
      const data = objectOrEmpty(await request<unknown>('GET', `/people/${id}/enrichment`));
      const run = data.run && typeof data.run === 'object' ? (data.run as EnrichmentState['run']) : null;
      return { run, suggestions: Array.isArray(data.suggestions) ? (data.suggestions as EnrichmentState['suggestions']) : [] };
    },
    acceptEnrichment: (id: string, input: { runId: string; field: string; expectedVersion: number }) =>
      request<unknown>('POST', `/people/${id}/enrichment`, { body: input }),
    dismissEnrichment: (id: string, runId: string) =>
      request<unknown>('DELETE', `/people/${id}/enrichment`, { query: { runId } }),
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
    // The organization's newest enrich run and the suggestions still waiting for a decision.
    enrichment: async (id: string): Promise<EnrichmentState> => {
      const data = objectOrEmpty(await request<unknown>('GET', `/organizations/${id}/enrichment`));
      const run = data.run && typeof data.run === 'object' ? (data.run as EnrichmentState['run']) : null;
      return { run, suggestions: Array.isArray(data.suggestions) ? (data.suggestions as EnrichmentState['suggestions']) : [] };
    },
    acceptEnrichment: (id: string, input: { runId: string; field: string; expectedVersion: number }) =>
      request<unknown>('POST', `/organizations/${id}/enrichment`, { body: input }),
    dismissEnrichment: (id: string, runId: string) =>
      request<unknown>('DELETE', `/organizations/${id}/enrichment`, { query: { runId } }),
  },

  pipelines: async () => asPage<Pipeline>(await request<unknown>('GET', '/pipelines')).items.map((pipeline) => ({
    ...pipeline,
    stages: [...(pipeline.stages ?? [])].sort((a, b) => a.seq - b.seq),
  })),

  opportunities: {
    list: async (params: { pipelineId?: string; stageId?: string; status?: string }) =>
      asPage<Opportunity>(await request<unknown>('GET', '/opportunities', { query: { ...params, limit: 200 } })).items,
    // Counts every opportunity of a pipeline by stage, any status, following the paging cursor.
    countByStage: async (pipelineId: string): Promise<Record<string, number>> => {
      const counts: Record<string, number> = {};
      let cursor: string | null = null;
      for (let guard = 0; guard < 500; guard += 1) {
        const page: Page<Opportunity> = asPage<Opportunity>(
          await request<unknown>('GET', '/opportunities', { query: { pipelineId, limit: 200, cursor } }),
        );
        for (const item of page.items) counts[item.stageId] = (counts[item.stageId] ?? 0) + 1;
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return counts;
    },
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
    startLeadCapture: async (input: LeadCaptureInput) => {
      const { title, ...scope } = input;
      return normalizeRun(await request<Run>('POST', '/runs', { body: { kind: 'lead_capture', title, scope } }));
    },
    startDraftOutreach: async (input: DraftOutreachInput) => {
      const { title, ...scope } = input;
      return normalizeRun(await request<Run>('POST', '/runs', { body: { kind: 'draft_outreach', title, scope } }));
    },
    startEnrichPerson: async (personId: string) =>
      normalizeRun(await request<Run>('POST', '/runs', { body: { kind: 'enrich_person', scope: { personId } } })),
    startEnrichOrganization: async (organizationId: string) =>
      normalizeRun(await request<Run>('POST', '/runs', { body: { kind: 'enrich_organization', scope: { organizationId } } })),
    startQualify: async (scope: { tag?: string } = {}) =>
      normalizeRun(await request<Run>('POST', '/runs', { body: { kind: 'qualify', scope } })),
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
    saveApify: async (input: ApifyConnectorInput) =>
      normalizeConnector(await request<unknown>('PUT', '/connectors/apify', { body: input })),
    removeApify: () => request<unknown>('DELETE', '/connectors/apify'),
    // Model providers share one shape. A token (or an Ollama base URL) connects or reconnects.
    // Model alone switches models on an existing connector.
    saveModelProvider: async (kind: ModelProviderKind, input: ModelProviderInput) =>
      normalizeConnector(await request<unknown>('PUT', `/connectors/${kind}`, { body: input })),
    removeModelProvider: (kind: ModelProviderKind) => request<unknown>('DELETE', `/connectors/${kind}`),
    ollamaModels: async (): Promise<OllamaModel[]> =>
      normalizeOllamaModels(await request<unknown>('GET', '/connectors/ollama/models')),
    // Token connects or reconnects. Inbox fields select the sending inbox on an existing connector.
    saveAgentMail: async (input: { token?: string; inboxId?: string; inboxEmail?: string }) =>
      normalizeConnector(await request<unknown>('PUT', '/connectors/agentmail', { body: input })),
    removeAgentMail: () => request<unknown>('DELETE', '/connectors/agentmail'),
    // Saving credentials does no network check. Signing in is a separate step.
    saveGmail: async (input: GmailCredentialsInput) =>
      normalizeConnector(await request<unknown>('PUT', '/connectors/gmail', { body: input })),
    // Returns the Google authorization address. The browser opens it in a new tab.
    startGmailOAuth: async (): Promise<string> => {
      const data = objectOrEmpty(await request<unknown>('POST', '/connectors/gmail/oauth/start'));
      const url = textOrNull(data.url);
      if (!url || !/^https?:\/\//i.test(url)) {
        throw new ApiError(500, 'internal', 'The server did not return a Google sign in address. Nothing was opened.');
      }
      return url;
    },
    removeGmail: () => request<unknown>('DELETE', '/connectors/gmail'),
    // Saving the client id does no network check. Signing in is a separate step.
    saveMicrosoft: async (input: MicrosoftCredentialsInput) =>
      normalizeConnector(await request<unknown>('PUT', '/connectors/microsoft', { body: input })),
    // Returns the Microsoft authorization address. The browser opens it in a new tab.
    startMicrosoftOAuth: async (): Promise<string> => {
      const data = objectOrEmpty(await request<unknown>('POST', '/connectors/microsoft/oauth/start'));
      const url = textOrNull(data.url);
      if (!url || !/^https?:\/\//i.test(url)) {
        throw new ApiError(500, 'internal', 'The server did not return a Microsoft sign in address. Nothing was opened.');
      }
      return url;
    },
    removeMicrosoft: () => request<unknown>('DELETE', '/connectors/microsoft'),

    // Saving connects: the server verifies IMAP, finds the Sent mailbox, and verifies SMTP. A failed check comes back as a
    // connector with status error and a sentence per step, not as an HTTP error.
    saveImap: async (input: ImapConnectorInput) =>
      normalizeConnector(await request<unknown>('PUT', '/connectors/imap', { body: input })),
    removeImap: () => request<unknown>('DELETE', '/connectors/imap'),
  },

  mail: {
    inboxes: async (): Promise<MailInbox[]> => normalizeInboxList(await request<unknown>('GET', '/connectors/agentmail/inboxes')),
    createInbox: async (username?: string): Promise<MailInbox | null> => {
      const data = await request<unknown>('POST', '/connectors/agentmail/inboxes', {
        body: username ? { username } : {},
      });
      const record = objectOrEmpty(data);
      return normalizeInbox(record.inbox ?? data);
    },
    stage: async (input: StageSendInput): Promise<StageSendResult> => {
      const data = objectOrEmpty(await request<unknown>('POST', '/send-intents', { body: input }));
      const approval = data.approval && typeof data.approval === 'object' ? normalizeApproval(data.approval as Approval) : null;
      return { approval, excluded: parseExcluded(data.excluded) };
    },
    intents: async (status?: string): Promise<SendIntent[]> =>
      asPage<unknown>(await request<unknown>('GET', '/send-intents', { query: { status, limit: 200 } })).items.map(
        normalizeIntent,
      ),
    control: (id: string, action: 'cancel' | 'acknowledge') =>
      request<unknown>('POST', `/send-intents/${encodeURIComponent(id)}/control`, { body: { action } }),
    suppressions: async (): Promise<Suppression[]> =>
      asPage<unknown>(await request<unknown>('GET', '/suppressions', { query: { limit: 200 } })).items.map(
        normalizeSuppression,
      ),
    addSuppression: (email: string) =>
      request<unknown>('POST', '/suppressions', { body: { email, reason: 'manual' } }),
    liftSuppression: (id: string) => request<unknown>('DELETE', `/suppressions/${encodeURIComponent(id)}`),
    summary: async (): Promise<MailSummary> => normalizeMailSummary(await request<unknown>('GET', '/mail/summary', { preserve: ['counts'] })),
  },

  followups: {
    // status is "active" (waiting, armed, sending) or one status. Omitted, every rule comes back, newest first.
    list: async (params: { status?: string; personId?: string } = {}): Promise<FollowupRule[]> =>
      asPage<unknown>(
        await request<unknown>('GET', '/followup-rules', { query: { ...params, limit: 200 } }),
      ).items.map(normalizeFollowupRule),
    stop: async (id: string): Promise<FollowupRule> => {
      const data = objectOrEmpty(await request<unknown>('POST', `/followup-rules/${encodeURIComponent(id)}/stop`));
      return normalizeFollowupRule(data.rule ?? data);
    },
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
    // Header names are data, so they keep their spelling in both response and request.
    csvPreview: async (input: { fileName: string; content: string }): Promise<CsvPreview> =>
      normalizeCsvPreview(
        await request<unknown>('POST', '/imports/csv/preview', {
          body: input,
          preserve: ['suggestedMapping', 'suggested_mapping', 'sample'],
        }),
      ),
    csvStage: async (input: CsvImportInput) =>
      normalizeRun(await request<Run>('POST', '/imports/csv', { body: input })),
    // The rows come with their raw source so a row named in a post can show the quote that names it.
    get: async (id: string, params: { cursor?: string | null; limit?: number; status?: string }) =>
      normalizeImportPage(
        await request<unknown>('GET', `/imports/${encodeURIComponent(id)}`, { query: { ...params, withRaw: 'true' } }),
      ),
  },

  qualification: {
    get: async (): Promise<QualificationConfig> =>
      normalizeQualificationConfig(await request<unknown>('GET', '/qualification')),
    // The server replaces the whole config. If it echoes nothing usable, keep what was sent.
    put: async (config: QualificationConfig): Promise<QualificationConfig> => {
      const data = await request<unknown>('PUT', '/qualification', { body: config });
      const record = objectOrEmpty(data);
      return 'exclusions' in record || 'criteria' in record ? normalizeQualificationConfig(data) : { ...config, defaulted: false };
    },
  },

  search: async (q: string, signal?: AbortSignal): Promise<SearchResults> => {
    const data = await request<Partial<SearchResults>>('GET', '/search', { query: { q }, signal });
    return {
      people: toArray<Person>(data.people),
      organizations: toArray<Organization>(data.organizations),
      opportunities: toArray<Opportunity>(data.opportunities),
    };
  },

  mailProvider: {
    get: async (): Promise<MailProviderSelection | null> =>
      normalizeMailProvider(await request<unknown>('GET', '/mail-provider')),
    set: async (kind: MailProviderKind): Promise<MailProviderSelection | null> =>
      normalizeMailProvider(await request<unknown>('POST', '/mail-provider', { body: { kind } })),
  },
  modelProvider: {
    get: async (): Promise<ModelProviderSelection | null> =>
      normalizeModelProvider(await request<unknown>('GET', '/model-provider')),
    set: async (kind: ModelProviderKind): Promise<ModelProviderSelection | null> =>
      normalizeModelProvider(await request<unknown>('PUT', '/model-provider', { body: { kind } })),
  },
  capture: {
    settings: () => request<CaptureSettings>('GET', '/capture/settings'),
    // The plaintext token exists only in this response. The server stores a hash.
    generateToken: () => request<CaptureToken>('POST', '/capture/token'),
    removeToken: () => request<unknown>('DELETE', '/capture/token'),
  },
  agentMessage: async (input: AgentMessageInput): Promise<AgentReply> => {
    const body: AgentMessageInput = { text: input.text };
    if (input.history && input.history.length > 0) body.history = input.history;
    if (input.context) body.context = input.context;
    const data = await request<Partial<AgentReply>>('POST', '/agent/message', { body });
    const usage = normalizeUsage(data.usage);
    return {
      reply: data.reply ?? '',
      actions: toArray(data.actions),
      modelConnected: data.modelConnected === true,
      ...(usage ? { usage } : {}),
      ...(typeof data.provider === 'string' ? { provider: data.provider } : {}),
      ...(typeof data.model === 'string' ? { model: data.model } : {}),
    };
  },
};
