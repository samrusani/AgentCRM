import { agentmailBaseUrl, agentmailRequestTimeoutMilliseconds } from '../config.js';

export type AgentmailErrorKind =
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'rejected'
  | 'unavailable'
  | 'timeout'
  | 'network'
  | 'bad_response'
  | 'unexpected_status';

// Messages are written in this file. Text that comes from AgentMail is scrubbed of the API key first.
export class AgentmailError extends Error {
  readonly kind: AgentmailErrorKind;
  readonly status: number | null;

  constructor(kind: AgentmailErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'AgentmailError';
    this.kind = kind;
    this.status = status;
  }

  // AgentMail answered with a definitive refusal (HTTP 400, 401, 403, 404, or 422), so the request did not
  // produce an email. Any other status that is not a success leaves the outcome unknown.
  get definitive(): boolean {
    return this.kind === 'unauthorized' || this.kind === 'rejected' || this.kind === 'not_found';
  }

  // The request may have been processed even though the answer was lost, late, or unreadable.
  // A send that fails this way has an unknown outcome and is never resolved by guessing.
  get outcomeUnknown(): boolean {
    return !this.definitive;
  }
}

export interface MailInbox {
  inboxId: string;
  email: string;
  displayName: string | null;
}

export interface MailInboxPage {
  inboxes: MailInbox[];
  nextPageToken: string | null;
}

export interface MailMessageSummary {
  messageId: string;
  threadId: string | null;
  inboxId: string | null;
  labels: string[];
  timestamp: string;
  from: string;
  to: string[];
  subject: string;
  preview: string;
  inReplyTo: string | null;
}

export interface MailMessageDetail extends MailMessageSummary {
  text: string | null;
  extractedText: string | null;
}

export interface MailMessagePage {
  messages: MailMessageSummary[];
  nextPageToken: string | null;
}

export interface MailEvent {
  eventId: string;
  eventType: string;
  messageId: string | null;
  label: string | null;
  eventAt: string | null;
}

export interface MailEventPage {
  events: MailEvent[];
  nextPageToken: string | null;
}

export interface SendRequest {
  inboxId: string;
  // The send intent id. AgentMail returns the original result for a repeated key and never sends twice.
  idempotencyKey: string;
  to: string;
  subject: string;
  text: string;
}

export interface SendResult {
  messageId: string;
  threadId: string | null;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function scrub(message: string, apiKey: string): string {
  return apiKey.length > 0 ? message.replaceAll(apiKey, '[removed]') : message;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  // For sends, 403 means the message itself was refused. Everywhere else it means the key lacks permission.
  forbiddenIsRejection?: boolean;
}

async function describeRejection(response: Response, apiKey: string): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    if (!isRecord(body)) return '';
    const parts = [text(body.message), text(body.fix)].filter((part): part is string => part !== null);
    const detail = parts.join(' ');
    return detail ? `: ${scrub(detail, apiKey).slice(0, 300)}` : '';
  } catch {
    return '';
  }
}

async function request(apiKey: string, method: 'GET' | 'POST', pathname: string, options: RequestOptions = {}): Promise<unknown> {
  const url = new URL(`${agentmailBaseUrl()}${pathname}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
    ...(options.headers ?? {}),
  };
  // A redirect is never followed, so the API key in the headers cannot be sent to another host.
  const init: RequestInit = { method, headers, redirect: 'error', signal: AbortSignal.timeout(agentmailRequestTimeoutMilliseconds()) };
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
      throw new AgentmailError('timeout', 'AgentMail did not answer in time.');
    }
    throw new AgentmailError('network', 'Could not reach AgentMail.');
  }

  const status = response.status;
  if (status === 401) throw new AgentmailError('unauthorized', 'AgentMail did not accept the API key.', status);
  if (status === 403) {
    if (options.forbiddenIsRejection) {
      throw new AgentmailError('rejected', `AgentMail rejected the message (HTTP 403)${await describeRejection(response, apiKey)}`, status);
    }
    throw new AgentmailError('unauthorized', 'AgentMail did not accept the API key.', status);
  }
  if (status === 404) throw new AgentmailError('not_found', 'AgentMail could not find that resource.', status);
  if (status === 409) {
    throw new AgentmailError('conflict', 'AgentMail reported a conflict with an earlier request that used the same key.', status);
  }
  if (status === 429) throw new AgentmailError('rate_limited', 'AgentMail is rate limiting requests.', status);
  if (status >= 500) throw new AgentmailError('unavailable', `AgentMail had a server problem (HTTP ${status}).`, status);
  if (status === 400 || status === 422) {
    throw new AgentmailError('rejected', `AgentMail rejected the request (HTTP ${status})${await describeRejection(response, apiKey)}`, status);
  }
  if (!response.ok) {
    throw new AgentmailError('unexpected_status', `AgentMail answered with an unexpected status (HTTP ${status}).`, status);
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new AgentmailError('timeout', 'AgentMail did not finish answering in time.');
    }
    throw new AgentmailError('bad_response', 'AgentMail sent a response that is not valid JSON.', status);
  }
}

// List responses are not fully documented. Accept the named key, a few likely alternatives, or a bare array.
function listOf(body: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(body)) return body;
  if (isRecord(body)) {
    for (const key of keys) {
      const value = body[key];
      if (Array.isArray(value)) return value;
    }
  }
  throw new AgentmailError('bad_response', 'AgentMail sent a list in an unexpected shape.');
}

function pageToken(body: unknown): string | null {
  return isRecord(body) ? text(body.next_page_token ?? body.nextPageToken) : null;
}

function toInbox(item: unknown): MailInbox | null {
  if (!isRecord(item)) return null;
  const inboxId = text(item.inbox_id) ?? text(item.id) ?? text(item.inboxId);
  const email = text(item.email) ?? (inboxId && inboxId.includes('@') ? inboxId : null);
  if (!inboxId || !email) return null;
  return { inboxId, email, displayName: text(item.display_name) ?? text(item.displayName) };
}

export async function validateKey(apiKey: string): Promise<void> {
  await request(apiKey, 'GET', '/inboxes', { query: { limit: 1 } });
}

export async function listInboxes(apiKey: string, options: { limit?: number; pageToken?: string } = {}): Promise<MailInboxPage> {
  const body = await request(apiKey, 'GET', '/inboxes', { query: { limit: options.limit ?? 100, page_token: options.pageToken } });
  const inboxes = listOf(body, ['inboxes', 'items', 'data']).flatMap((item) => {
    const inbox = toInbox(item);
    return inbox ? [inbox] : [];
  });
  return { inboxes, nextPageToken: pageToken(body) };
}

// clientId makes creation idempotent: the same client id returns the original inbox. It must not contain "@".
export async function createInbox(apiKey: string, options: { clientId: string; username?: string }): Promise<MailInbox> {
  const body = await request(apiKey, 'POST', '/inboxes', {
    body: { client_id: options.clientId, ...(options.username ? { username: options.username } : {}) },
  });
  const inbox = toInbox(body) ?? (isRecord(body) ? toInbox(body.inbox) : null);
  if (!inbox) throw new AgentmailError('bad_response', 'AgentMail created an inbox but sent it in an unexpected shape.');
  return inbox;
}

// A 400, 401, 403, 404, or 422 is a definitive refusal. A timeout, network failure, 5xx, 409, or unreadable answer leaves
// the outcome unknown, because AgentMail may have accepted the message before the answer was lost.
export async function sendMessage(apiKey: string, send: SendRequest): Promise<SendResult> {
  const body = await request(apiKey, 'POST', `/inboxes/${encodeURIComponent(send.inboxId)}/messages/send`, {
    headers: { 'idempotency-key': send.idempotencyKey },
    body: { to: [send.to], subject: send.subject, text: send.text },
    forbiddenIsRejection: true,
  });
  const messageId = isRecord(body) ? text(body.message_id ?? body.messageId) : null;
  if (!messageId) throw new AgentmailError('bad_response', 'AgentMail answered the send without a message id.');
  return { messageId, threadId: isRecord(body) ? text(body.thread_id ?? body.threadId) : null };
}

function toTimestamp(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function toAddressList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function toSummary(item: unknown): MailMessageSummary | null {
  if (!isRecord(item)) return null;
  const messageId = text(item.message_id) ?? text(item.id);
  const timestamp = toTimestamp(item.timestamp ?? item.created_at);
  const from = text(item.from);
  if (!messageId || !timestamp || !from) return null;
  return {
    messageId,
    threadId: text(item.thread_id),
    inboxId: text(item.inbox_id),
    labels: Array.isArray(item.labels) ? item.labels.filter((label): label is string => typeof label === 'string') : [],
    timestamp,
    from,
    to: toAddressList(item.to),
    subject: typeof item.subject === 'string' ? item.subject : '',
    preview: typeof item.preview === 'string' ? item.preview : '',
    inReplyTo: text(item.in_reply_to),
  };
}

export async function listMessages(
  apiKey: string,
  inboxId: string,
  options: { after?: string; ascending?: boolean; limit?: number; pageToken?: string } = {},
): Promise<MailMessagePage> {
  const body = await request(apiKey, 'GET', `/inboxes/${encodeURIComponent(inboxId)}/messages`, {
    query: {
      after: options.after,
      ascending: options.ascending ? 'true' : undefined,
      limit: options.limit ?? 100,
      page_token: options.pageToken,
    },
  });
  const messages = listOf(body, ['messages', 'items', 'data']).flatMap((item) => {
    const summary = toSummary(item);
    return summary ? [summary] : [];
  });
  return { messages, nextPageToken: pageToken(body) };
}

export async function getMessage(apiKey: string, inboxId: string, messageId: string): Promise<MailMessageDetail> {
  const body = await request(
    apiKey,
    'GET',
    `/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`,
  );
  const summary = toSummary(body);
  if (!summary || !isRecord(body)) throw new AgentmailError('bad_response', 'AgentMail sent a message in an unexpected shape.');
  return {
    ...summary,
    text: typeof body.text === 'string' ? body.text : null,
    extractedText: typeof body.extracted_text === 'string' ? body.extracted_text : null,
  };
}

function toEvent(item: unknown): MailEvent | null {
  if (!isRecord(item)) return null;
  const eventId = text(item.event_id) ?? text(item.id);
  const eventType = text(item.event_type) ?? text(item.type);
  if (!eventId || !eventType) return null;
  return {
    eventId,
    eventType,
    messageId: text(item.message_id),
    label: text(item.label),
    eventAt: toTimestamp(item.event_at ?? item.timestamp),
  };
}

// Newest first. The feed has no "after" filter, so callers page until they meet an event id they have seen.
export async function listEvents(
  apiKey: string,
  inboxId: string,
  options: { limit?: number; pageToken?: string } = {},
): Promise<MailEventPage> {
  const body = await request(apiKey, 'GET', `/inboxes/${encodeURIComponent(inboxId)}/events`, {
    query: { limit: options.limit ?? 100, page_token: options.pageToken },
  });
  const events = listOf(body, ['events', 'items', 'data']).flatMap((item) => {
    const event = toEvent(item);
    return event ? [event] : [];
  });
  return { events, nextPageToken: pageToken(body) };
}
