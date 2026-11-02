import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const stubAgentmailKey = 'am_testkey_abcd1234';
export const stubInboxId = 'crm@stub-mail.invalid';

export interface StubInbox {
  inbox_id: string;
  email: string;
  created_at: string;
}

export interface StubMessage {
  inbox_id: string;
  thread_id: string;
  message_id: string;
  labels: string[];
  timestamp: string;
  from: string;
  to: string[];
  subject: string;
  preview: string;
  in_reply_to: string | null;
  text: string;
  html: string | null;
  extracted_text: string | null;
}

export interface StubEvent {
  event_id: string;
  event_type: string;
  message_id: string;
  label: string;
  event_at: string;
  inbox_id: string;
}

// What the send endpoint does for one call. Entries are used once each, in order, before normal behavior.
export type SendBehavior =
  // Answers at once without processing anything, like a validation error or a server error before work began.
  | { type: 'respond'; status: number; body?: unknown }
  // Accepts the message (it counts as sent), then answers with an error status, like a gateway that lost the success.
  | { type: 'process_then_respond'; status: number; body?: unknown }
  // Accepts the message, then answers after a delay that is longer than the client timeout.
  | { type: 'process_then_delay'; delayMs: number }
  // Accepts the message, then answers with a 200 whose body is not JSON.
  | { type: 'process_then_garbage' };

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

interface StoredSend {
  payload: string;
  messageId: string;
  threadId: string;
}

export interface AgentmailStubState {
  apiKey: string;
  inboxes: StubInbox[];
  // Shape of the inbox list: the documented key, an alternative key, or a bare array.
  inboxListShape: 'inboxes' | 'items' | 'bare';
  clientIds: Record<string, string>;
  messages: StubMessage[];
  // Newest first, like the real feed.
  events: StubEvent[];
  sendScript: SendBehavior[];
  // One entry per distinct email the stub actually sent.
  sent: { key: string | null; inboxId: string; to: string[]; subject: string; text: string; messageId: string; threadId: string }[];
  sendsByKey: Record<string, StoredSend>;
  sendAttempts: { key: string | null; body: unknown }[];
  messageGets: string[];
  // When set, the message list and the events feed answer with this status.
  messageListStatus: number | null;
  eventsStatus: number | null;
  getMessageStatus: number | null;
  requests: RecordedRequest[];
  authHeaders: string[];
  paths: string[];
  nextId: number;
}

export interface AgentmailStub {
  url: string;
  base: string;
  state: AgentmailStubState;
  reset: () => void;
  addInbound: (message: Partial<StubMessage> & { from: string; timestamp: string }) => StubMessage;
  addEvent: (event: Partial<StubEvent> & { message_id: string; label: string }) => StubEvent;
  close: () => Promise<void>;
}

function freshState(): AgentmailStubState {
  return {
    apiKey: stubAgentmailKey,
    inboxes: [{ inbox_id: stubInboxId, email: stubInboxId, created_at: '2026-01-01T00:00:00.000Z' }],
    inboxListShape: 'inboxes',
    clientIds: {},
    messages: [],
    events: [],
    sendScript: [],
    sent: [],
    sendsByKey: {},
    sendAttempts: [],
    messageGets: [],
    messageListStatus: null,
    eventsStatus: null,
    getMessageStatus: null,
    requests: [],
    authHeaders: [],
    paths: [],
    nextId: 1,
  };
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function page<T>(items: T[], query: Record<string, string>): { items: T[]; limit: number; next: string | null } {
  const limit = Math.max(1, Number(query.limit ?? 50));
  const offset = query.page_token ? Number(query.page_token.replace('off:', '')) : 0;
  const slice = items.slice(offset, offset + limit);
  return { items: slice, limit, next: offset + limit < items.length ? `off:${offset + limit}` : null };
}

export async function startAgentmailStub(): Promise<AgentmailStub> {
  const state = freshState();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub.local');
    const authorization = request.headers.authorization ?? '';
    state.authHeaders.push(authorization);
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        body = raw;
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const path = url.pathname.replace(/^\/v0/, '');
      state.paths.push(`${request.method} ${path}`);
      state.requests.push({ method: request.method ?? 'GET', path, query, headers: request.headers, body });
      if (authorization !== `Bearer ${state.apiKey}`) {
        return send(response, 401, { name: 'AuthenticationError', message: 'Key is not valid.' });
      }

      if (path === '/inboxes' && request.method === 'GET') {
        const result = page(state.inboxes, query);
        const base = { count: result.items.length, limit: result.limit, next_page_token: result.next };
        if (state.inboxListShape === 'bare') return send(response, 200, result.items);
        return send(response, 200, { ...base, [state.inboxListShape]: result.items });
      }
      if (path === '/inboxes' && request.method === 'POST') {
        const input = (body ?? {}) as { client_id?: string; username?: string };
        if (input.client_id && input.client_id.includes('@')) {
          return send(response, 400, { name: 'ValidationError', message: 'client_id must not contain @' });
        }
        const known = input.client_id ? state.clientIds[input.client_id] : undefined;
        const existing = known ? state.inboxes.find((inbox) => inbox.inbox_id === known) : undefined;
        if (existing) return send(response, 200, existing);
        const email = `${input.username ?? `inbox${state.nextId}`}@stub-mail.invalid`;
        state.nextId += 1;
        const inbox: StubInbox = { inbox_id: email, email, created_at: '2026-02-01T00:00:00.000Z' };
        state.inboxes.push(inbox);
        if (input.client_id) state.clientIds[input.client_id] = inbox.inbox_id;
        return send(response, 200, inbox);
      }

      const sendMatch = /^\/inboxes\/([^/]+)\/messages\/send$/.exec(path);
      if (sendMatch && request.method === 'POST') {
        const inboxId = decodeURIComponent(sendMatch[1]!);
        const input = (body ?? {}) as { to?: string | string[]; subject?: string; text?: string };
        const keyHeader = request.headers['idempotency-key'];
        const key = typeof keyHeader === 'string' ? keyHeader : null;
        state.sendAttempts.push({ key, body });
        if (key === '') return send(response, 400, { name: 'ValidationError', message: 'Idempotency-Key must not be empty.' });

        const behavior = state.sendScript.shift();
        if (behavior?.type === 'respond') {
          return send(response, behavior.status, behavior.body ?? { name: 'Error', message: 'Stub failure.', fix: 'Try again.' });
        }
        const to = Array.isArray(input.to) ? input.to : input.to ? [input.to] : [];
        const payload = JSON.stringify({ inboxId, to, subject: input.subject, text: input.text });
        let result: StoredSend | undefined = key ? state.sendsByKey[key] : undefined;
        if (result) {
          if (result.payload !== payload) {
            return send(response, 409, { name: 'ConflictError', message: 'Idempotency key was used with a different payload.' });
          }
        } else {
          const id = state.nextId;
          state.nextId += 1;
          result = { payload, messageId: `msg_stub_${id}`, threadId: `thr_stub_${id}` };
          if (key) state.sendsByKey[key] = result;
          state.sent.push({
            key,
            inboxId,
            to,
            subject: input.subject ?? '',
            text: input.text ?? '',
            messageId: result.messageId,
            threadId: result.threadId,
          });
        }
        const answer = { message_id: result.messageId, thread_id: result.threadId };
        if (behavior?.type === 'process_then_respond') {
          return send(response, behavior.status, behavior.body ?? { name: 'Error', message: 'Stub failure.' });
        }
        if (behavior?.type === 'process_then_delay') {
          setTimeout(() => send(response, 200, answer), behavior.delayMs);
          return undefined;
        }
        if (behavior?.type === 'process_then_garbage') {
          response.writeHead(200, { 'content-type': 'application/json' });
          return response.end('not json');
        }
        return send(response, 200, answer);
      }

      const listMatch = /^\/inboxes\/([^/]+)\/messages$/.exec(path);
      if (listMatch && request.method === 'GET') {
        if (state.messageListStatus) return send(response, state.messageListStatus, { name: 'Error', message: 'Stub failure.' });
        const inboxId = decodeURIComponent(listMatch[1]!);
        let items = state.messages.filter((message) => message.inbox_id === inboxId);
        if (query.after) items = items.filter((message) => Date.parse(message.timestamp) > Date.parse(query.after!));
        items = [...items].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
        if (query.ascending !== 'true') items.reverse();
        const result = page(items, query);
        const messages = result.items.map(({ text: _text, html: _html, extracted_text: _extracted, ...item }) => item);
        return send(response, 200, { count: messages.length, messages, limit: result.limit, next_page_token: result.next });
      }

      const getMatch = /^\/inboxes\/([^/]+)\/messages\/([^/]+)$/.exec(path);
      if (getMatch && request.method === 'GET') {
        const messageId = decodeURIComponent(getMatch[2]!);
        state.messageGets.push(messageId);
        if (state.getMessageStatus) return send(response, state.getMessageStatus, { name: 'Error', message: 'Stub failure.' });
        const message = state.messages.find((item) => item.message_id === messageId);
        if (!message) return send(response, 404, { name: 'NotFoundError', message: 'Message not found.' });
        return send(response, 200, message);
      }

      const eventsMatch = /^\/inboxes\/([^/]+)\/events$/.exec(path);
      if (eventsMatch && request.method === 'GET') {
        if (state.eventsStatus) return send(response, state.eventsStatus, { name: 'Error', message: 'Stub failure.' });
        const inboxId = decodeURIComponent(eventsMatch[1]!);
        const result = page(
          state.events.filter((event) => event.inbox_id === inboxId),
          query,
        );
        const events = result.items.map(({ inbox_id: _inbox, ...event }) => event);
        return send(response, 200, { count: events.length, events, limit: result.limit, next_page_token: result.next });
      }
      return send(response, 404, { name: 'NotFoundError', message: 'No such route.' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    base: `${url}/v0`,
    state,
    reset: () => Object.assign(state, freshState()),
    addInbound: (partial) => {
      const id = state.nextId;
      state.nextId += 1;
      const text = partial.text ?? 'Thanks for reaching out.';
      const message: StubMessage = {
        inbox_id: stubInboxId,
        thread_id: `thr_in_${id}`,
        message_id: `msg_in_${id}`,
        labels: ['received'],
        subject: 'Re: hello',
        to: [stubInboxId],
        preview: text.slice(0, 80),
        in_reply_to: null,
        text,
        html: null,
        extracted_text: text,
        ...partial,
      };
      state.messages.push(message);
      return message;
    },
    addEvent: (partial) => {
      const id = state.nextId;
      state.nextId += 1;
      const event: StubEvent = {
        event_id: `evt_${id}`,
        event_type: 'label.added',
        event_at: '2026-03-01T10:00:00.000Z',
        inbox_id: stubInboxId,
        ...partial,
      };
      state.events.unshift(event);
      return event;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Points the provider at the stub, shortens the request timeout, and makes reconciliation immediate.
// Returns a function that restores the environment.
export function useAgentmailStub(stub: AgentmailStub, extra: Record<string, string> = {}): () => void {
  const defaults: Record<string, string> = {
    AGENTCRM_AGENTMAIL_BASE: stub.base,
    AGENTCRM_AGENTMAIL_TIMEOUT_MS: '400',
    AGENTCRM_MAIL_RECONCILE_MS: '1000',
    ...extra,
  };
  const names = Object.keys(defaults);
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, defaults);
  return () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  };
}
