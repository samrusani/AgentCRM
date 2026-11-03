import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const stubGoogleClientId = 'stub-client-123.apps.googleusercontent.com';
export const stubGoogleClientSecret = 'GOCSPX-stubsecret9876';
export const stubGmailAddress = 'sender@gmail-stub.invalid';

const sendScope = 'https://www.googleapis.com/auth/gmail.send';
const readScope = 'https://www.googleapis.com/auth/gmail.readonly';

// What the send endpoint does for one call. Entries are used once each, in order, before normal behavior.
export type GmailSendBehavior =
  // Answers at once without processing anything, like a validation error, a 401 for a stale token, or a 5xx before work began.
  | { type: 'respond'; status: number; body?: unknown }
  // Accepts the message (it counts as sent), then answers with an error status, like a gateway that lost the success.
  | { type: 'process_then_respond'; status: number; body?: unknown }
  // Accepts the message, then answers after a delay that is longer than the client timeout.
  | { type: 'process_then_delay'; delayMs: number }
  // Accepts the message, then answers with a 200 whose body is not JSON.
  | { type: 'process_then_garbage' };

export interface GmailFixture {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  historyId: string;
  internalDate: string;
  payload: unknown;
  // Lowercased Message-ID header, used by the search endpoint.
  messageIdHeader: string | null;
}

export interface CapturedSend {
  order: number;
  id: string;
  threadId: string;
  raw: string;
  headers: Record<string, string>;
  messageIdHeader: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  requestedThreadId: string | null;
  accessToken: string;
}

export interface RecordedGoogleRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface HistoryRecord {
  id: string;
  messagesAdded: { message: { id: string; threadId: string; labelIds: string[] } }[];
}

export interface GoogleStubState {
  clientId: string;
  clientSecret: string;
  address: string;
  // Scopes the consent screen grants. Set to one scope to simulate a person unticking a permission.
  grantedScopes: string[];
  expiresInSeconds: number;
  // 'invalid_grant' makes every refresh fail like a revoked or expired consent. 'invalid_client' rejects the client.
  tokenMode: 'ok' | 'invalid_grant' | 'invalid_client' | 'unavailable';
  codes: Record<string, { challenge: string; redirectUri: string; clientId: string; used: boolean; scopes: string[] }>;
  refreshTokens: Set<string>;
  accessTokens: Set<string>;
  tokenRequests: { grantType: string; verifierMatched: boolean | null; form: Record<string, string> }[];
  sendScript: GmailSendBehavior[];
  // One entry per distinct email the stub actually sent.
  sent: CapturedSend[];
  // Every send request that reached the endpoint, processed or not.
  sendAttempts: { raw: string; accessToken: string }[];
  messages: Record<string, GmailFixture>;
  history: HistoryRecord[];
  historyId: number;
  // When set, history.list answers with this many records per page, whatever maxResults says.
  historyPageSize: number | null;
  // history.list first answers this many empty pages, each pointing at the next one, like a feed that filters a
  // long run of records out of the label it was asked for.
  emptyHistoryPages: number;
  // history.list answers 404, like a start position that is too old.
  historyNotFound: boolean;
  // Called when a refresh token request arrives, before the stub answers. Tests use it to change the database while
  // a refresh is on the wire.
  onRefresh: (() => void) | null;
  profileStatus: number | null;
  listStatus: number | null;
  // The search answers with ids only, like an older API response, so the app must fetch the thread id itself.
  omitThreadIdInList: boolean;
  // messages.get answers with this status for every message, or per id.
  getStatus: number | null;
  getStatusById: Record<string, number>;
  requests: RecordedGoogleRequest[];
  paths: string[];
  // Called when a send request arrives, before anything is processed. Tests use it to look at the database at that moment.
  onSend: ((request: { raw: string; headers: Record<string, string> }) => void) | null;
  nextId: number;
  order: number;
}

export interface InboundInput {
  from: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  threadId?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  internalDate?: string;
  labelIds?: string[];
  // Leave the message out of the history feed, like a message that was added before the saved position.
  skipHistory?: boolean;
}

export interface BounceInput {
  originalMessageId: string;
  to?: string;
  from?: string;
  where?: 'text' | 'headers' | 'references';
  threadId?: string;
  kind?: 'failure' | 'delay' | 'delivered';
  report?: boolean;
  subject?: string;
  explanation?: string;
}

export interface GoogleStub {
  url: string;
  state: GoogleStubState;
  reset: () => void;
  // Registers a received message and adds it to the history feed. Returns the fixture.
  addInbound: (input: InboundInput) => GmailFixture;
  // A delivery failure report from a mailer daemon that names the original message.
  // `kind: 'delay'` is a still-trying notice (Action: delayed) and `kind: 'delivered'` a success notice (Action: delivered).
  // `report: false` leaves out the attached delivery status part, so only the wording can say what happened.
  addBounce: (input: BounceInput) => GmailFixture;
  // Follows the consent screen "Allow" for an authorization URL and returns the callback URL with a code.
  approve: (authorizationUrl: string, outcome?: 'allow' | 'deny') => string;
  // Invalidates every access token so the next call gets a 401.
  revokeAccessTokens: () => void;
  sendCount: () => number;
  close: () => Promise<void>;
}

function freshState(): GoogleStubState {
  return {
    clientId: stubGoogleClientId,
    clientSecret: stubGoogleClientSecret,
    address: stubGmailAddress,
    grantedScopes: [sendScope, readScope],
    expiresInSeconds: 3600,
    tokenMode: 'ok',
    codes: {},
    refreshTokens: new Set(),
    accessTokens: new Set(),
    tokenRequests: [],
    sendScript: [],
    sent: [],
    sendAttempts: [],
    messages: {},
    history: [],
    historyId: 1000,
    historyPageSize: null,
    emptyHistoryPages: 0,
    historyNotFound: false,
    onRefresh: null,
    profileStatus: null,
    listStatus: null,
    omitThreadIdInList: false,
    getStatus: null,
    getStatusById: {},
    requests: [],
    paths: [],
    onSend: null,
    nextId: 1,
    order: 0,
  };
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function googleError(status: number, message: string, reason = 'badRequest'): unknown {
  return { error: { code: status, message, errors: [{ message, domain: 'global', reason }], status: 'STUB' } };
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

// Parses the message the app sent: unfolded headers, then the body decoded from its transfer encoding.
export function parseRawMessage(raw: string): { headers: Record<string, string>; text: string } {
  const split = raw.indexOf('\r\n\r\n');
  const head = split >= 0 ? raw.slice(0, split) : raw;
  const body = split >= 0 ? raw.slice(split + 4) : '';
  const headers: Record<string, string> = {};
  let last = '';
  for (const line of head.split('\r\n')) {
    if (/^[ \t]/.test(line) && last) {
      headers[last] = `${headers[last]}${line}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    last = line.slice(0, colon).toLowerCase();
    headers[last] = line.slice(colon + 1).trim();
  }
  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  const text = encoding === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') : body;
  return { headers, text };
}

export function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_match, data: string) => Buffer.from(data, 'base64').toString('utf8'));
}

function pageOf<T>(items: T[], size: number, token: string | undefined): { slice: T[]; next: string | null } {
  const offset = token ? Number(token.replace('off:', '')) : 0;
  return { slice: items.slice(offset, offset + size), next: offset + size < items.length ? `off:${offset + size}` : null };
}

export async function startGoogleStub(options: { port?: number } = {}): Promise<GoogleStub> {
  const state = freshState();
  let baseUrl = '';

  function register(fixture: GmailFixture): GmailFixture {
    state.messages[fixture.id] = fixture;
    return fixture;
  }

  function addInbound(input: InboundInput): GmailFixture {
    const number = state.nextId;
    state.nextId += 1;
    state.historyId += 1;
    const text = input.text ?? 'Thanks for reaching out.';
    const id = `gm_in_${number}`;
    const threadId = input.threadId ?? `gth_in_${number}`;
    const messageId = input.messageId ?? `<in-${number}@mail.stub.invalid>`;
    const headers = [
      { name: 'From', value: input.from },
      { name: 'To', value: input.to ?? state.address },
      { name: 'Subject', value: input.subject ?? 'Re: hello' },
      { name: 'Date', value: 'Tue, 03 Nov 2026 10:00:00 +0000' },
      { name: 'Message-ID', value: messageId },
      ...(input.inReplyTo ? [{ name: 'In-Reply-To', value: input.inReplyTo }] : []),
      ...(input.references ? [{ name: 'References', value: input.references }] : []),
    ];
    const parts = [
      ...(input.html === undefined || input.text !== undefined
        ? [{ partId: '0', mimeType: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { size: text.length, data: base64Url(text) } }]
        : []),
      ...(input.html !== undefined
        ? [{ partId: '1', mimeType: 'text/html', filename: '', headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }], body: { size: input.html.length, data: base64Url(input.html) } }]
        : []),
    ];
    const labelIds = input.labelIds ?? ['INBOX', 'UNREAD'];
    const fixture = register({
      id,
      threadId,
      labelIds,
      snippet: text.slice(0, 80),
      historyId: String(state.historyId),
      internalDate: input.internalDate ?? String(Date.parse('2026-11-03T10:00:00.000Z') + number),
      payload: { partId: '', mimeType: 'multipart/alternative', filename: '', headers, body: { size: 0 }, parts },
      messageIdHeader: messageId.toLowerCase(),
    });
    if (!input.skipHistory) {
      state.history.push({ id: String(state.historyId), messagesAdded: [{ message: { id, threadId, labelIds } }] });
    }
    return fixture;
  }

  function addBounce(input: BounceInput): GmailFixture {
    const number = state.nextId;
    state.nextId += 1;
    state.historyId += 1;
    const where = input.where ?? 'headers';
    const kind = input.kind ?? 'failure';
    const recipient = input.to ?? 'nobody@gone.invalid';
    const wording =
      kind === 'delay'
        ? `Delivery incomplete\n\nThere was a temporary problem delivering your message to ${recipient}. Gmail will retry for 47 hours.`
        : kind === 'delivered'
          ? `Your message to ${recipient} was successfully delivered.`
          : `Delivery to the following recipient failed permanently:\n\n    ${recipient}\n\nThe address was not found.`;
    const explanation = `${input.explanation ?? wording}${where === 'text' ? `\n\nOriginal Message-ID: ${input.originalMessageId}` : ''}`;
    const action = kind === 'delay' ? 'delayed' : kind === 'delivered' ? 'delivered' : 'failed';
    const subject = input.subject ?? (kind === 'delay' ? 'Delivery Status Notification (Delay)' : kind === 'delivered' ? 'Delivery Status Notification (Success)' : 'Delivery Status Notification (Failure)');
    const id = `gm_bounce_${number}`;
    const threadId = input.threadId ?? `gth_bounce_${number}`;
    const part = (partId: string, mimeType: string, content: string, extra: { name: string; value: string }[] = []) => ({
      partId,
      mimeType,
      filename: '',
      headers: [{ name: 'Content-Type', value: mimeType }, ...extra],
      body: { size: content.length, data: base64Url(content) },
    });
    const parts = [
      part('0', 'text/plain', explanation),
      ...(input.report === false ? [] : [part('1', 'message/delivery-status', `Reporting-MTA: dns; googlemail.com\nFinal-Recipient: rfc822; ${recipient}\nAction: ${action}\nStatus: ${action === 'failed' ? '5.1.1' : '4.0.0'}\n`)]),
      ...(where === 'headers'
        ? [part('2', 'text/rfc822-headers', `Message-ID: ${input.originalMessageId}\nSubject: original\nTo: ${recipient}\n`)]
        : []),
    ];
    const from = input.from ?? 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>';
    const references = where === 'references' ? input.originalMessageId : undefined;
    const fixture = register({
      id,
      threadId,
      labelIds: ['INBOX', 'UNREAD'],
      snippet: explanation.slice(0, 80),
      historyId: String(state.historyId),
      internalDate: String(Date.parse('2026-11-03T10:05:00.000Z') + number),
      payload: {
        partId: '',
        mimeType: 'multipart/report',
        filename: '',
        headers: [
          { name: 'From', value: from },
          { name: 'To', value: state.address },
          { name: 'Subject', value: subject },
          { name: 'Message-ID', value: `<dsn-${number}@googlemail.com>` },
          ...(references ? [{ name: 'References', value: references }, { name: 'In-Reply-To', value: references }] : []),
        ],
        body: { size: 0 },
        parts,
      },
      messageIdHeader: `<dsn-${number}@googlemail.com>`,
    });
    state.history.push({ id: String(state.historyId), messagesAdded: [{ message: { id, threadId, labelIds: ['INBOX', 'UNREAD'] } }] });
    return fixture;
  }

  function processSend(raw: string, requestedThreadId: string | null, accessToken: string): CapturedSend {
    const parsed = parseRawMessage(raw);
    const number = state.nextId;
    state.nextId += 1;
    state.order += 1;
    const id = `gm_sent_${number}`;
    const threadId = requestedThreadId ?? `gth_sent_${number}`;
    const captured: CapturedSend = {
      order: state.order,
      id,
      threadId,
      raw,
      headers: parsed.headers,
      messageIdHeader: parsed.headers['message-id'] ?? '',
      from: parsed.headers.from ?? '',
      to: parsed.headers.to ?? '',
      subject: decodeWords(parsed.headers.subject ?? ''),
      text: parsed.text,
      requestedThreadId,
      accessToken,
    };
    state.sent.push(captured);
    state.historyId += 1;
    register({
      id,
      threadId,
      labelIds: ['SENT'],
      snippet: parsed.text.slice(0, 80),
      historyId: String(state.historyId),
      internalDate: String(Date.parse('2026-11-03T09:00:00.000Z') + number),
      payload: { partId: '', mimeType: 'text/plain', headers: Object.entries(parsed.headers).map(([name, value]) => ({ name, value })), body: { size: 0 } },
      messageIdHeader: captured.messageIdHeader.toLowerCase(),
    });
    return captured;
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub.local');
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const contentType = request.headers['content-type'] ?? '';
      let body: unknown = null;
      if (rawBody) {
        if (contentType.includes('application/json')) {
          try {
            body = JSON.parse(rawBody) as unknown;
          } catch {
            body = rawBody;
          }
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
          body = Object.fromEntries(new URLSearchParams(rawBody).entries());
        } else {
          body = rawBody;
        }
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const path = url.pathname;
      state.paths.push(`${request.method} ${path}`);
      state.requests.push({ method: request.method ?? 'GET', path, query, headers: request.headers, body });

      // ---- Admin routes for a manual browser check. Tests use the state object instead.
      if (path === '/__stub/inbound' && request.method === 'POST') {
        const input = (body ?? {}) as Partial<InboundInput>;
        const fixture = addInbound({ from: input.from ?? 'someone@elsewhere.invalid', ...input });
        return sendJson(response, 200, { id: fixture.id, threadId: fixture.threadId });
      }
      if (path === '/__stub/bounce' && request.method === 'POST') {
        const input = (body ?? {}) as { originalMessageId?: string };
        const fixture = addBounce({ originalMessageId: input.originalMessageId ?? state.sent.at(-1)?.messageIdHeader ?? '<none@none>' });
        return sendJson(response, 200, { id: fixture.id });
      }
      if (path === '/__stub/sent' && request.method === 'GET') {
        return sendJson(response, 200, { sent: state.sent.map((item) => ({ id: item.id, threadId: item.threadId, to: item.to, subject: item.subject, messageId: item.messageIdHeader, text: item.text })) });
      }

      // ---- OAuth
      if (path === '/o/oauth2/v2/auth' && request.method === 'GET') {
        if (query.client_id !== state.clientId || query.response_type !== 'code' || !query.redirect_uri || !query.state) {
          response.writeHead(400, { 'content-type': 'text/plain' });
          return response.end('Error 400: invalid_request (stub). Check the client id and the request.');
        }
        if (query.code_challenge_method !== 'S256' || !query.code_challenge) {
          response.writeHead(400, { 'content-type': 'text/plain' });
          return response.end('Error 400: invalid_request (stub). PKCE with S256 is required.');
        }
        const allow = approveUrl(query.client_id, query.redirect_uri, query.state, query.code_challenge, query.scope ?? '', 'allow');
        const deny = approveUrl(query.client_id, query.redirect_uri, query.state, query.code_challenge, query.scope ?? '', 'deny');
        if (query.auto === '1') {
          response.writeHead(302, { location: allow });
          return response.end();
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return response.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>Stub Google sign in</title></head><body style="font-family:system-ui;max-width:32rem;margin:3rem auto">` +
            `<h1>Stub Google sign in</h1><p>This is a local stand-in for Google's consent screen. It asks for:</p><pre>${(query.scope ?? '').split(' ').join('\n')}</pre>` +
            `<p><a href="${allow}">Allow</a> &nbsp; <a href="${deny}">Cancel</a></p></body></html>`,
        );
      }
      if (path === '/token' && request.method === 'POST') {
        const form = (body ?? {}) as Record<string, string>;
        const grantType = form.grant_type ?? '';
        const record = { grantType, verifierMatched: null as boolean | null, form };
        state.tokenRequests.push(record);
        if (state.tokenMode === 'unavailable') return sendJson(response, 503, { error: 'temporarily_unavailable' });
        if (form.client_id !== state.clientId || form.client_secret !== state.clientSecret || state.tokenMode === 'invalid_client') {
          return sendJson(response, 401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
        }
        if (grantType === 'authorization_code') {
          const issued = state.codes[form.code ?? ''];
          if (!issued || issued.used || issued.redirectUri !== form.redirect_uri || !form.code_verifier) {
            return sendJson(response, 400, { error: 'invalid_grant', error_description: 'Bad Request' });
          }
          const matched = createHash('sha256').update(form.code_verifier).digest('base64url') === issued.challenge;
          record.verifierMatched = matched;
          if (!matched) return sendJson(response, 400, { error: 'invalid_grant', error_description: 'Invalid code verifier.' });
          issued.used = true;
          const accessToken = `ya29.stub-${state.nextId}`;
          const refreshToken = `1//stub-refresh-${state.nextId}`;
          state.nextId += 1;
          state.accessTokens.add(accessToken);
          state.refreshTokens.add(refreshToken);
          return sendJson(response, 200, {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: state.expiresInSeconds,
            scope: issued.scopes.join(' '),
            token_type: 'Bearer',
          });
        }
        if (grantType === 'refresh_token') {
          state.onRefresh?.();
          if (state.tokenMode === 'invalid_grant' || !state.refreshTokens.has(form.refresh_token ?? '')) {
            return sendJson(response, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
          }
          const accessToken = `ya29.stub-${state.nextId}`;
          state.nextId += 1;
          state.accessTokens.add(accessToken);
          return sendJson(response, 200, { access_token: accessToken, expires_in: state.expiresInSeconds, scope: state.grantedScopes.join(' '), token_type: 'Bearer' });
        }
        return sendJson(response, 400, { error: 'unsupported_grant_type' });
      }

      // ---- Gmail
      const gmail = /^\/gmail\/v1\/users\/me(\/.*)$/.exec(path);
      if (!gmail) return sendJson(response, 404, googleError(404, 'No such route.', 'notFound'));
      const authorization = request.headers.authorization ?? '';
      const accessToken = authorization.replace(/^Bearer /, '');
      const route = gmail[1]!;
      if (!state.accessTokens.has(accessToken)) {
        if (route === '/messages/send') state.sendAttempts.push({ raw: String((body as { raw?: string } | null)?.raw ?? ''), accessToken });
        return sendJson(response, 401, googleError(401, 'Request had invalid authentication credentials.', 'authError'));
      }

      if (route === '/profile' && request.method === 'GET') {
        if (state.profileStatus) return sendJson(response, state.profileStatus, googleError(state.profileStatus, 'Stub failure.', 'backendError'));
        return sendJson(response, 200, { emailAddress: state.address, messagesTotal: 10, threadsTotal: 5, historyId: String(state.historyId) });
      }

      if (route === '/messages/send' && request.method === 'POST') {
        const input = (body ?? {}) as { raw?: string; threadId?: string };
        const raw = input.raw ? Buffer.from(input.raw, 'base64url').toString('utf8') : '';
        state.sendAttempts.push({ raw, accessToken });
        state.onSend?.({ raw, headers: parseRawMessage(raw).headers });
        const behavior = state.sendScript.shift();
        if (behavior?.type === 'respond') {
          return sendJson(response, behavior.status, behavior.body ?? googleError(behavior.status, 'Stub failure.', 'backendError'));
        }
        const captured = processSend(raw, input.threadId ?? null, accessToken);
        const answer = { id: captured.id, threadId: captured.threadId, labelIds: ['SENT'] };
        if (behavior?.type === 'process_then_respond') {
          return sendJson(response, behavior.status, behavior.body ?? googleError(behavior.status, 'Stub failure.', 'backendError'));
        }
        if (behavior?.type === 'process_then_delay') {
          setTimeout(() => sendJson(response, 200, answer), behavior.delayMs);
          return undefined;
        }
        if (behavior?.type === 'process_then_garbage') {
          response.writeHead(200, { 'content-type': 'application/json' });
          return response.end('not json');
        }
        return sendJson(response, 200, answer);
      }

      if (route === '/messages' && request.method === 'GET') {
        if (state.listStatus) return sendJson(response, state.listStatus, googleError(state.listStatus, 'Stub failure.', 'backendError'));
        const wanted = /^rfc822msgid:(.+)$/.exec(query.q ?? '');
        if (!wanted) return sendJson(response, 400, googleError(400, 'The stub only supports rfc822msgid searches.'));
        const needle = wanted[1]!.trim().toLowerCase();
        const matches = Object.values(state.messages).filter((message) => message.messageIdHeader === needle);
        if (matches.length === 0) return sendJson(response, 200, { resultSizeEstimate: 0 });
        return sendJson(response, 200, { messages: matches.map((message) => (state.omitThreadIdInList ? { id: message.id } : { id: message.id, threadId: message.threadId })), resultSizeEstimate: matches.length });
      }

      const one = /^\/messages\/([^/]+)$/.exec(route);
      if (one && request.method === 'GET') {
        const id = decodeURIComponent(one[1]!);
        const status = state.getStatusById[id] ?? state.getStatus;
        if (status) return sendJson(response, status, googleError(status, 'Stub failure.', 'backendError'));
        const message = state.messages[id];
        if (!message) return sendJson(response, 404, googleError(404, 'Requested entity was not found.', 'notFound'));
        if (query.format === 'minimal') return sendJson(response, 200, { id: message.id, threadId: message.threadId, labelIds: message.labelIds, historyId: message.historyId });
        const { messageIdHeader: _header, ...visible } = message;
        return sendJson(response, 200, { ...visible, sizeEstimate: 1000 });
      }

      if (route === '/history' && request.method === 'GET') {
        if (state.historyNotFound) return sendJson(response, 404, googleError(404, 'Requested entity was not found.', 'notFound'));
        const emptyToken = /^empty:(\d+)$/.exec(query.pageToken ?? '');
        const emptyServed = emptyToken ? Number(emptyToken[1]) : query.pageToken ? state.emptyHistoryPages : 0;
        if (emptyServed < state.emptyHistoryPages) {
          return sendJson(response, 200, { nextPageToken: `empty:${emptyServed + 1}`, historyId: String(state.historyId) });
        }
        const pageToken = query.pageToken && !emptyToken ? query.pageToken : undefined;
        const start = Number(query.startHistoryId ?? '0');
        const matching = state.history.filter((record) => Number(record.id) > start && record.messagesAdded.some((entry) => entry.message.labelIds.includes(query.labelId ?? 'INBOX')));
        const size = state.historyPageSize ?? Math.max(1, Number(query.maxResults ?? 100));
        const page = pageOf(matching, size, pageToken);
        return sendJson(response, 200, {
          ...(page.slice.length > 0 ? { history: page.slice } : {}),
          ...(page.next ? { nextPageToken: page.next } : {}),
          historyId: String(state.historyId),
        });
      }
      return sendJson(response, 404, googleError(404, 'No such route.', 'notFound'));
    });
  });

  function approveUrl(clientId: string, redirectUri: string, stateValue: string, challenge: string, scope: string, outcome: 'allow' | 'deny'): string {
    const target = new URL(redirectUri);
    if (outcome === 'deny') {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('state', stateValue);
      return target.toString();
    }
    const code = `4/stub-code-${state.nextId}`;
    state.nextId += 1;
    const asked = scope.split(/\s+/).filter(Boolean);
    state.codes[code] = {
      challenge,
      redirectUri,
      clientId,
      used: false,
      scopes: asked.filter((item) => state.grantedScopes.includes(item)),
    };
    target.searchParams.set('code', code);
    target.searchParams.set('state', stateValue);
    target.searchParams.set('scope', state.codes[code]!.scopes.join(' '));
    return target.toString();
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    url: baseUrl,
    state,
    reset: () => Object.assign(state, freshState()),
    addInbound,
    addBounce,
    approve: (authorizationUrl, outcome = 'allow') => {
      const params = new URL(authorizationUrl).searchParams;
      return approveUrl(
        params.get('client_id') ?? '',
        params.get('redirect_uri') ?? '',
        params.get('state') ?? '',
        params.get('code_challenge') ?? '',
        params.get('scope') ?? '',
        outcome,
      );
    },
    revokeAccessTokens: () => state.accessTokens.clear(),
    sendCount: () => state.sent.length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Points the Gmail provider at the stub, shortens the request timeout, and makes reconciliation immediate.
// Returns a function that restores the environment.
export function useGoogleStub(stub: GoogleStub, extra: Record<string, string> = {}): () => void {
  const defaults: Record<string, string> = {
    AGENTCRM_GOOGLE_AUTH_BASE: stub.url,
    AGENTCRM_GOOGLE_TOKEN_BASE: stub.url,
    AGENTCRM_GMAIL_BASE: stub.url,
    AGENTCRM_GMAIL_TIMEOUT_MS: '400',
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
