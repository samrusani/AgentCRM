import { agentmailBaseUrl, agentmailRequestTimeoutMilliseconds } from '../config.js';
import {
  clearFetchFailure,
  type InboundBatch,
  type ListInboundOptions,
  type MailErrorKind,
  type MailEventBatch,
  type MailIntent,
  type MailProvider,
  MailProviderError,
  type NormalizedInbound,
  noteFetchFailure,
  type ReconcileResult,
} from './mailTypes.js';
import { parseAddress } from '../mail/rules.js';

export type AgentmailErrorKind = MailErrorKind;

// Messages are written in this file. Text that comes from AgentMail is scrubbed of the API key first.
// A 400, 401, 403, 404, or 422 is a definitive refusal (see MailProviderError.definitive), so the request did not
// produce an email. Any other status that is not a success leaves the outcome unknown.
export class AgentmailError extends MailProviderError {
  constructor(kind: AgentmailErrorKind, message: string, status: number | null = null) {
    super(kind, message, status);
    this.name = 'AgentmailError';
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

// The adapter behind the mail provider interface. Everything above this line is the AgentMail wire protocol, unchanged.
// AgentMail remembers an idempotency key for about a day, so a retry of the same request with the same key cannot send
// a second email. That is how reconcileUnknown works for this provider.

const messagePageSize = 25;
const overlapMilliseconds = 1000;
const maxEventPages = 5;

function later(left: string | null, right: string): string {
  if (!left) return right;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

// The cursor never moves past the current time. A message dated in the future would otherwise hide every later
// message from the sync.
function notAfter(timestamp: string, limit: string): string {
  return Date.parse(timestamp) > Date.parse(limit) ? limit : timestamp;
}

function directionOf(summary: MailMessageSummary, inboxEmail: string): 'in' | 'out' | null {
  const labels = summary.labels.map((label) => label.toLowerCase());
  if (labels.includes('draft')) return null;
  if (labels.includes('received')) return 'in';
  if (labels.includes('sent')) return 'out';
  return parseAddress(summary.from) === inboxEmail ? 'out' : 'in';
}

export interface AgentmailAdapterOptions {
  apiKey: string;
  inboxId: string;
  inboxEmail: string;
  workspaceId: string;
  now: () => string;
}

export function createAgentmailMailProvider(options: AgentmailAdapterOptions): MailProvider {
  const { apiKey, inboxId, inboxEmail, workspaceId, now } = options;
  // Paging state for one poll. The query stays the same across pages, because a page token belongs to the query
  // that produced it.
  let started = false;
  let after: string | undefined;
  let pageToken: string | undefined;
  let current: string | null = null;

  const sendRequest = (intent: MailIntent) => ({
    inboxId: intent.accountId,
    idempotencyKey: intent.intentId,
    to: intent.to,
    subject: intent.subject,
    text: intent.body,
  });

  // Full text is fetched once, only for inbound messages that are new. A busy or slow provider stops the poll and
  // leaves the cursor where it was, so the same messages are tried again next time. A message AgentMail cannot
  // return (for example one that was deleted) is stored with its preview only.
  // Messages fetched before a failure are left in `fetched`, so the caller can still store them.
  async function fetchNew(page: MailMessageSummary[], known: (id: string) => boolean, fetched: NormalizedInbound[]): Promise<void> {
    for (const summary of page) {
      const direction = directionOf(summary, inboxEmail);
      if (!direction) continue;
      if (known(summary.messageId)) continue;
      let detail: MailMessageDetail | null = null;
      let unreadable = false;
      if (direction === 'in') {
        const failureKey = `${workspaceId}:${summary.messageId}`;
        try {
          detail = await getMessage(apiKey, inboxId, summary.messageId);
          clearFetchFailure(failureKey);
        } catch (error) {
          const permanent = error instanceof AgentmailError && (error.kind === 'not_found' || error.kind === 'rejected' || error.kind === 'bad_response');
          if (!permanent) {
            if (noteFetchFailure(failureKey)) throw error;
            unreadable = true;
          }
        }
      }
      fetched.push({
        providerMessageId: summary.messageId,
        threadId: summary.threadId,
        direction,
        from: summary.from,
        to: summary.to,
        subject: summary.subject,
        preview: summary.preview,
        labels: summary.labels,
        text: direction === 'in' ? (detail?.text ?? detail?.extractedText ?? null) : null,
        replyText: detail?.extractedText ?? detail?.text ?? summary.preview,
        messageIdHeader: null,
        inReplyTo: summary.inReplyTo,
        references: [],
        evidenceText: '',
        deliveryAction: null,
        receivedAt: summary.timestamp,
        unreadable,
      });
    }
  }

  return {
    kind: 'agentmail',
    label: 'AgentMail',
    duplicateProtection: 'idempotency_key',

    async submit(intent) {
      return sendMessage(apiKey, sendRequest(intent));
    },

    // Retries the same request with the same key. The provider's duplicate protection makes that safe inside its
    // window, and the caller never calls this outside it.
    async reconcileUnknown(intent): Promise<ReconcileResult> {
      try {
        const result = await sendMessage(apiKey, sendRequest(intent));
        return { outcome: 'accepted', messageId: result.messageId, threadId: result.threadId };
      } catch (error) {
        if (error instanceof MailProviderError) return { outcome: 'unavailable', error };
        return { outcome: 'unavailable', error: new MailProviderError('unavailable', 'The request failed in an unexpected way.') };
      }
    },

    async listInbound(cursor: string | null, listOptions: ListInboundOptions): Promise<InboundBatch> {
      if (!started) {
        started = true;
        current = cursor ? notAfter(cursor, now()) : null;
        after = current ? new Date(Date.parse(current) - overlapMilliseconds).toISOString() : undefined;
      }
      const page = await listMessages(apiKey, inboxId, {
        ...(after ? { after } : {}),
        ascending: true,
        limit: messagePageSize,
        ...(pageToken ? { pageToken } : {}),
      });
      const fetched: NormalizedInbound[] = [];
      try {
        await fetchNew(page.messages, listOptions.isKnown, fetched);
      } catch (error) {
        // What was fetched before the failure is kept, but the cursor stays where it was, so the failing message
        // and everything after it are tried again on the next poll.
        return { messages: fetched, nextCursor: null, more: false, failure: error };
      }
      const pageEnd = page.messages.reduce<string | null>((latest, message) => later(latest, message.timestamp), null);
      if (pageEnd) current = later(current, notAfter(pageEnd, now()));
      pageToken = page.nextPageToken ?? undefined;
      return { messages: fetched, nextCursor: current, more: Boolean(page.nextPageToken) };
    },

    async checkAccount() {
      const found = (await listInboxes(apiKey, { limit: 100 })).inboxes.find((inbox) => inbox.inboxId === inboxId);
      if (!found) throw new AgentmailError('not_found', 'AgentMail could not find that inbox.');
      return { address: found.email };
    },

    // Pages the newest-first feed until it meets an event it has already seen. Only a label.added event for the
    // bounced label is evidence of a failed delivery. Opened labels and everything else are ignored.
    async pollEvents(seenEventId: string | null): Promise<MailEventBatch> {
      const collected: MailEvent[] = [];
      let newest: string | null = null;
      let token: string | undefined;
      for (let pages = 0; pages < maxEventPages; pages += 1) {
        const page = await listEvents(apiKey, inboxId, { limit: 100, ...(token ? { pageToken: token } : {}) });
        if (pages === 0) newest = page.events[0]?.eventId ?? null;
        let metSeen = false;
        for (const event of page.events) {
          if (event.eventId === seenEventId) {
            metSeen = true;
            break;
          }
          collected.push(event);
        }
        if (metSeen || !page.nextPageToken) break;
        token = page.nextPageToken;
      }
      const bounces = collected
        .reverse()
        .filter((event) => event.eventType.toLowerCase() === 'label.added' && event.label?.toLowerCase() === 'bounced' && event.messageId)
        .map((event) => ({ eventId: event.eventId, providerMessageId: event.messageId! }));
      return { bounces, newestEventId: newest };
    },
  };
}
