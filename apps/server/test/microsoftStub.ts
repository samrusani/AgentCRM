import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const stubMicrosoftClientId = '3b1f6d2e-5c9a-4e71-9a0b-7d2c4f8e1a55';
export const stubMicrosoftAddress = 'sender@outlook-stub.invalid';

const defaultScopes = ['Mail.ReadWrite', 'Mail.Send', 'User.Read', 'profile', 'openid', 'email'];

// What the draft create or the send endpoint does for one call. Entries are used once each, in order, before normal
// behavior.
export type StubBehavior =
  // Answers at once without processing anything, like a validation error, a stale token, or a 5xx before work began.
  | { type: 'respond'; status: number; body?: unknown; headers?: Record<string, string> }
  // Does the work (creates the draft, or sends it), then answers with an error status, like a gateway that lost the success.
  | { type: 'process_then_respond'; status: number; body?: unknown }
  // Does the work, then answers after a delay that is longer than the client timeout.
  | { type: 'process_then_delay'; delayMs: number }
  // Does the work, then answers 200 or 201 with a body that is not JSON.
  | { type: 'process_then_garbage' };

export type Folder = 'inbox' | 'drafts' | 'sentitems' | 'deleteditems' | 'outbox';

export interface StubAttachment {
  id: string;
  // A file attachment carries its bytes in the list. An item attachment is read from its $value route.
  kind: 'file' | 'item';
  name: string;
  contentType: string;
  text: string;
}

export interface StubMessage {
  id: string;
  folder: Folder;
  isDraft: boolean;
  from: { name: string; address: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyType: 'text' | 'html';
  body: string;
  preview: string;
  internetMessageId: string;
  conversationId: string;
  receivedDateTime: string;
  lastModifiedDateTime: string;
  headers: { name: string; value: string }[];
  attachments: StubAttachment[];
  // Position in the change log, for the delta feed.
  seq: number;
  removedSeq: number | null;
  order: number;
}

export interface SentCapture {
  order: number;
  id: string;
  internetMessageId: string;
  conversationId: string;
  to: string;
  subject: string;
  text: string;
  intentHeader: string | null;
  accessToken: string;
}

export interface RecordedGraphRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface MicrosoftStubState {
  clientId: string;
  address: string;
  grantedScopes: string[];
  expiresInSeconds: number;
  // 'invalid_grant' makes every refresh fail like a revoked sign in. 'invalid_client' rejects the application id.
  // 'public_client' answers like an app registration with public client flows off.
  tokenMode: 'ok' | 'invalid_grant' | 'invalid_client' | 'public_client' | 'unavailable';
  // When set, the consent screen answers Allow with this error instead of a code, like an admin consent block.
  consentError: { error: string; description: string } | null;
  // Refresh tokens rotate: each refresh retires the old token and issues a new one. Set false to keep them.
  rotateRefreshTokens: boolean;
  codes: Record<string, { challenge: string; redirectUri: string; clientId: string; used: boolean; scopes: string[] }>;
  refreshTokens: Set<string>;
  accessTokens: Set<string>;
  tokenRequests: { grantType: string; verifierMatched: boolean | null; form: Record<string, string> }[];
  createScript: StubBehavior[];
  sendScript: StubBehavior[];
  messages: Record<string, StubMessage>;
  // One entry per distinct email the stub actually sent.
  sent: SentCapture[];
  // Every send request that reached the endpoint, processed or not.
  sendAttempts: { id: string; accessToken: string; processed: boolean }[];
  createAttempts: { body: unknown; accessToken: string }[];
  seq: number;
  // The delta feed answers this many messages per page, whatever the Prefer header says.
  deltaPageSize: number | null;
  // The next delta request that carries a saved position answers 410 with SyncStateNotFound.
  deltaGone: boolean;
  // Delta answers, used once each in order before normal behavior.
  deltaScript: { status: number; headers?: Record<string, string>; body?: unknown }[];
  // Answer for GET /me/messages/{id} when set, per id.
  getStatusById: Record<string, number>;
  profileStatus: number | null;
  // GET /me answers with this body instead of the address, for example a profile without a mail address.
  profileBody: unknown;
  // Called when a refresh token request arrives, before the stub answers.
  onRefresh: (() => void) | null;
  // Called when a send request arrives, before anything is processed.
  onSend: ((request: { id: string }) => void) | null;
  // Called when a draft create request arrives, before anything is processed.
  onCreate: (() => void) | null;
  // Called for every Graph request that carries a valid token, before it is handled. A test can use it to change the
  // world at an exact point, for example to land an opt out between two requests of one reconcile.
  onRequest: ((request: { method: string; path: string; query: Record<string, string> }) => void) | null;
  // The draft create answers with the id only, no internetMessageId.
  omitInternetMessageId: boolean;
  requests: RecordedGraphRequest[];
  paths: string[];
  nextId: number;
  order: number;
}

export interface InboundInput {
  from: string;
  fromName?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  conversationId?: string;
  internetMessageId?: string;
  receivedDateTime?: string;
}

export interface BounceInput {
  originalInternetMessageId?: string;
  intentId?: string;
  to?: string;
  from?: string;
  kind?: 'failure' | 'delay' | 'delivered';
  // false leaves out the delivery status report, so only the wording can say what happened.
  report?: boolean;
  // How the original message is attached.
  original?: 'file' | 'item' | 'none';
  subject?: string;
  explanation?: string;
}

export interface MicrosoftStub {
  url: string;
  state: MicrosoftStubState;
  reset: () => void;
  addInbound: (input: InboundInput) => StubMessage;
  addBounce: (input: BounceInput) => StubMessage;
  // Takes a message out of the inbox, like a delete or a move.
  removeInbound: (id: string) => void;
  // Puts a draft of our own in the drafts folder without going through the app, like a leftover from an earlier attempt.
  addStrayDraft: (input: { intentId: string; to?: string; subject?: string; body?: string }) => StubMessage;
  // Changes a draft the way a person editing it in Outlook would. Setting html makes the body an html body, which is
  // what Outlook does once a draft is edited.
  editDraft: (id: string, changes: { to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; text?: string; html?: string; lastModifiedDateTime?: string }) => StubMessage;
  // Moves a message to another folder, like a person dragging it. A message outside Drafts is no longer a draft.
  moveMessage: (id: string, folder: Folder) => StubMessage;
  // Follows the consent screen "Allow" for an authorization URL and returns the callback URL with a code.
  approve: (authorizationUrl: string, outcome?: 'allow' | 'deny') => string;
  revokeAccessTokens: () => void;
  drafts: () => StubMessage[];
  sendCount: () => number;
  close: () => Promise<void>;
}

function freshState(): MicrosoftStubState {
  return {
    clientId: stubMicrosoftClientId,
    address: stubMicrosoftAddress,
    grantedScopes: [...defaultScopes],
    expiresInSeconds: 3600,
    tokenMode: 'ok',
    consentError: null,
    rotateRefreshTokens: true,
    codes: {},
    refreshTokens: new Set(),
    accessTokens: new Set(),
    tokenRequests: [],
    createScript: [],
    sendScript: [],
    messages: {},
    sent: [],
    sendAttempts: [],
    createAttempts: [],
    seq: 0,
    deltaPageSize: null,
    deltaGone: false,
    deltaScript: [],
    getStatusById: {},
    profileStatus: null,
    profileBody: null,
    onRefresh: null,
    onSend: null,
    onCreate: null,
    onRequest: null,
    omitInternetMessageId: false,
    requests: [],
    paths: [],
    nextId: 1,
    order: 0,
  };
}

function sendJson(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function graphError(status: number, code: string, message: string): unknown {
  return { error: { code, message, innerError: { date: '2026-11-03T10:00:00' } } };
}

const folderIds: Record<string, Folder> = { inbox: 'inbox', drafts: 'drafts', sentitems: 'sentitems', deleteditems: 'deleteditems', outbox: 'outbox' };
const folderIdOf = (folder: Folder): string => `AAMkFolder-${folder}`;
const oldDate = '2026-01-01T00:00:00.000Z';

function nameAndAddress(raw: string, name?: string): { name: string; address: string } {
  const angle = /^(.*)<([^<>]+)>\s*$/.exec(raw);
  if (angle) return { name: angle[1]!.replace(/["]/g, '').trim(), address: angle[2]!.trim() };
  return { name: name ?? '', address: raw.trim() };
}

export async function startMicrosoftStub(options: { port?: number } = {}): Promise<MicrosoftStub> {
  const state = freshState();
  let baseUrl = '';

  function register(message: StubMessage): StubMessage {
    state.messages[message.id] = message;
    return message;
  }

  function nextSeq(): number {
    state.seq += 1;
    return state.seq;
  }

  function addInbound(input: InboundInput): StubMessage {
    const number = state.nextId;
    state.nextId += 1;
    state.order += 1;
    const text = input.text ?? 'Thanks for reaching out.';
    return register({
      id: `AAMk-in-${number}`,
      folder: 'inbox',
      isDraft: false,
      from: nameAndAddress(input.from, input.fromName),
      to: [input.to ?? state.address],
      cc: [],
      bcc: [],
      subject: input.subject ?? 'Re: hello',
      bodyType: input.html !== undefined && input.text === undefined ? 'html' : 'text',
      body: input.html !== undefined && input.text === undefined ? input.html : text,
      preview: (input.html !== undefined && input.text === undefined ? input.html.replace(/<[^>]*>/g, '') : text).slice(0, 80),
      internetMessageId: input.internetMessageId ?? `<in-${number}@mail.stub.invalid>`,
      conversationId: input.conversationId ?? `conv-in-${number}`,
      receivedDateTime: input.receivedDateTime ?? '2026-11-03T10:00:00.000Z',
      lastModifiedDateTime: oldDate,
      headers: [],
      attachments: [],
      seq: nextSeq(),
      removedSeq: null,
      order: state.order,
    });
  }

  function addBounce(input: BounceInput): StubMessage {
    const kind = input.kind ?? 'failure';
    const recipient = input.to ?? 'nobody@gone.invalid';
    const wording =
      kind === 'delay'
        ? `Delivery incomplete\n\nThere was a temporary problem delivering your message to ${recipient}. The server will retry for 47 hours.`
        : kind === 'delivered'
          ? `Your message to ${recipient} was successfully delivered.`
          : `Your message to ${recipient} couldn't be delivered.\n\nThe address was not found.`;
    const action = kind === 'delay' ? 'delayed' : kind === 'delivered' ? 'delivered' : 'failed';
    const subject = input.subject ?? (kind === 'delay' ? 'Delivery Status Notification (Delay)' : kind === 'delivered' ? 'Delivery Status Notification (Success)' : 'Undeliverable: Hello');
    const message = addInbound({
      from: input.from ?? 'Microsoft Outlook <postmaster@outlook.com>',
      to: state.address,
      subject,
      text: input.explanation ?? wording,
    });
    const originalHeaders = [
      input.originalInternetMessageId ? `Message-ID: ${input.originalInternetMessageId}` : null,
      input.intentId ? `x-agentcrm-intent: ${input.intentId}` : null,
      `To: ${recipient}`,
      'Subject: original',
    ]
      .filter((line): line is string => line !== null)
      .join('\r\n');
    const attachments: StubAttachment[] = [];
    if (input.report !== false) {
      attachments.push({
        id: `att-status-${message.id}`,
        kind: 'file',
        name: 'details.dsn',
        contentType: 'message/delivery-status',
        text: `Reporting-MTA: dns; outlook.com\r\nFinal-Recipient: rfc822; ${recipient}\r\nAction: ${action}\r\nStatus: ${action === 'failed' ? '5.1.1' : '4.0.0'}\r\n`,
      });
    }
    if (input.original !== 'none' && (input.originalInternetMessageId || input.intentId)) {
      attachments.push({
        id: `att-original-${message.id}`,
        kind: input.original === 'item' ? 'item' : 'file',
        name: 'original.eml',
        contentType: input.original === 'item' ? 'application/octet-stream' : 'message/rfc822',
        text: `${originalHeaders}\r\n\r\nHello.\r\n`,
      });
    }
    message.attachments = attachments;
    return message;
  }

  function addStrayDraft(input: { intentId: string; to?: string; subject?: string; body?: string }): StubMessage {
    return createDraft({
      subject: input.subject ?? 'stray',
      body: { contentType: 'text', content: input.body ?? 'stray' },
      toRecipients: [{ emailAddress: { address: input.to ?? 'stray@lanternrow.invalid' } }],
      internetMessageHeaders: [{ name: 'x-agentcrm-intent', value: input.intentId }],
    });
  }

  function createDraft(body: any): StubMessage {
    const number = state.nextId;
    state.nextId += 1;
    state.order += 1;
    return register({
      id: `AAMk-draft-${number}`,
      folder: 'drafts',
      isDraft: true,
      from: { name: '', address: state.address },
      to: Array.isArray(body?.toRecipients) ? body.toRecipients.map((entry: any) => String(entry?.emailAddress?.address ?? '')) : [],
      cc: Array.isArray(body?.ccRecipients) ? body.ccRecipients.map((entry: any) => String(entry?.emailAddress?.address ?? '')) : [],
      bcc: Array.isArray(body?.bccRecipients) ? body.bccRecipients.map((entry: any) => String(entry?.emailAddress?.address ?? '')) : [],
      subject: String(body?.subject ?? ''),
      bodyType: String(body?.body?.contentType ?? 'text').toLowerCase() === 'html' ? 'html' : 'text',
      body: String(body?.body?.content ?? ''),
      preview: String(body?.body?.content ?? '').slice(0, 80),
      internetMessageId: `<draft-${number}@outlook.stub.invalid>`,
      conversationId: `conv-draft-${number}`,
      receivedDateTime: '2026-11-03T09:00:00.000Z',
      lastModifiedDateTime: oldDate,
      headers: Array.isArray(body?.internetMessageHeaders) ? body.internetMessageHeaders.map((entry: any) => ({ name: String(entry.name), value: String(entry.value) })) : [],
      attachments: [],
      seq: nextSeq(),
      removedSeq: null,
      order: state.order,
    });
  }

  function editDraft(id: string, changes: { to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; text?: string; html?: string; lastModifiedDateTime?: string }): StubMessage {
    const message = state.messages[id];
    if (!message) throw new Error(`No stub message ${id}.`);
    if (changes.to) message.to = changes.to;
    if (changes.cc) message.cc = changes.cc;
    if (changes.bcc) message.bcc = changes.bcc;
    if (changes.subject !== undefined) message.subject = changes.subject;
    if (changes.text !== undefined) {
      message.bodyType = 'text';
      message.body = changes.text;
    }
    if (changes.html !== undefined) {
      message.bodyType = 'html';
      message.body = changes.html;
    }
    message.preview = message.body.replace(/<[^>]*>/g, '').slice(0, 80);
    message.lastModifiedDateTime = changes.lastModifiedDateTime ?? new Date().toISOString();
    return message;
  }

  function moveMessage(id: string, folder: Folder): StubMessage {
    const message = state.messages[id];
    if (!message) throw new Error(`No stub message ${id}.`);
    message.folder = folder;
    message.isDraft = folder === 'drafts';
    message.seq = nextSeq();
    return message;
  }

  function sendDraft(message: StubMessage, accessToken: string): SentCapture {
    state.order += 1;
    message.folder = 'sentitems';
    message.isDraft = false;
    message.seq = nextSeq();
    const captured: SentCapture = {
      order: state.order,
      id: message.id,
      internetMessageId: message.internetMessageId,
      conversationId: message.conversationId,
      to: message.to.join(', '),
      subject: message.subject,
      text: message.body,
      intentHeader: message.headers.find((header) => header.name.toLowerCase() === 'x-agentcrm-intent')?.value ?? null,
      accessToken,
    };
    state.sent.push(captured);
    return captured;
  }

  function visible(message: StubMessage, select: string | undefined): Record<string, unknown> {
    const full: Record<string, unknown> = {
      id: message.id,
      isDraft: message.isDraft,
      parentFolderId: folderIdOf(message.folder),
      internetMessageId: message.internetMessageId,
      conversationId: message.conversationId,
      lastModifiedDateTime: message.lastModifiedDateTime,
      receivedDateTime: message.receivedDateTime,
      subject: message.subject,
      from: { emailAddress: message.from },
      toRecipients: message.to.map((address) => ({ emailAddress: { address, name: '' } })),
      ccRecipients: message.cc.map((address) => ({ emailAddress: { address, name: '' } })),
      bccRecipients: message.bcc.map((address) => ({ emailAddress: { address, name: '' } })),
      body: { contentType: message.bodyType, content: message.body },
      bodyPreview: message.preview,
      internetMessageHeaders: message.headers,
    };
    if (!select) {
      const { internetMessageHeaders: _headers, ...rest } = full;
      return rest;
    }
    const wanted = new Set(select.split(',').map((field) => field.trim()));
    wanted.add('id');
    return Object.fromEntries(Object.entries(full).filter(([key]) => wanted.has(key)));
  }

  function parseCreate(response: http.ServerResponse, message: StubMessage): void {
    const answer = {
      ...visible(message, 'id,isDraft,parentFolderId,conversationId,internetMessageId,subject'),
      ...(state.omitInternetMessageId ? { internetMessageId: undefined } : {}),
    };
    sendJson(response, 201, answer);
  }

  function deltaPage(query: Record<string, string>, maxPageSize: number): { value: unknown[]; nextToken: string | null; snapshot: number; mode: 'i' | 'd'; selectEcho: string } {
    const select = query.$select ?? '';
    const size = state.deltaPageSize ?? maxPageSize;
    let mode: 'i' | 'd' = 'i';
    let base = 0;
    let snapshot = state.seq;
    let filterIso = '';
    let offset = 0;
    if (query.$skiptoken) {
      const [m, a, b, c, d] = query.$skiptoken.split('|');
      mode = m === 'd' ? 'd' : 'i';
      if (mode === 'd') {
        base = Number(a);
        snapshot = Number(b);
        offset = Number(c);
      } else {
        snapshot = Number(a);
        filterIso = b ?? '';
        offset = Number(c);
      }
      void d;
    } else if (query.$deltatoken) {
      mode = 'd';
      base = Number(query.$deltatoken);
    } else {
      const filter = /receivedDateTime ge (\S+)/.exec(query.$filter ?? '');
      filterIso = filter ? filter[1]! : '';
    }
    const all = Object.values(state.messages).sort((a, b) => a.seq - b.seq);
    let items: unknown[];
    if (mode === 'i') {
      items = all
        .filter((message) => message.folder === 'inbox' && message.removedSeq === null && message.seq <= snapshot)
        .filter((message) => !filterIso || Date.parse(message.receivedDateTime) >= Date.parse(filterIso))
        .map((message) => visible(message, select));
    } else {
      items = all
        .filter((message) => message.seq > base && message.seq <= snapshot)
        .flatMap((message) =>
          message.removedSeq !== null && message.removedSeq > base
            ? [{ id: message.id, '@removed': { reason: 'deleted' } }]
            : message.folder === 'inbox'
              ? [visible(message, select)]
              : [],
        );
    }
    const slice = items.slice(offset, offset + size);
    const more = offset + size < items.length;
    const token = more ? (mode === 'd' ? `d|${base}|${snapshot}|${offset + size}` : `i|${snapshot}|${filterIso}|${offset + size}`) : null;
    return { value: slice, nextToken: token, snapshot, mode, selectEcho: select };
  }

  function removeInbound(id: string): void {
    const message = state.messages[id];
    if (!message) return;
    message.removedSeq = nextSeq();
    message.seq = message.removedSeq;
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
        const message = addInbound({ from: input.from ?? 'someone@elsewhere.invalid', ...input });
        return sendJson(response, 200, { id: message.id, conversationId: message.conversationId });
      }
      if (path === '/__stub/bounce' && request.method === 'POST') {
        const input = (body ?? {}) as BounceInput;
        const last = state.sent.at(-1);
        const message = addBounce({ originalInternetMessageId: last?.internetMessageId, ...(last?.intentHeader ? { intentId: last.intentHeader } : {}), ...input });
        return sendJson(response, 200, { id: message.id });
      }
      if (path === '/__stub/sent' && request.method === 'GET') {
        return sendJson(response, 200, { sent: state.sent.map((item) => ({ id: item.id, conversationId: item.conversationId, to: item.to, subject: item.subject, internetMessageId: item.internetMessageId, text: item.text })) });
      }
      // Makes the next draft create or the next send fail with a status. `processed: true` does the work first, like a
      // gateway that lost the success. `{ "target": "send", "status": 503 }` leaves the draft unsent.
      if (path === '/__stub/fail' && request.method === 'POST') {
        const input = (body ?? {}) as { target?: 'send' | 'create'; status?: number; processed?: boolean };
        const behavior: StubBehavior = input.processed
          ? { type: 'process_then_respond', status: input.status ?? 502 }
          : { type: 'respond', status: input.status ?? 503 };
        (input.target === 'create' ? state.createScript : state.sendScript).push(behavior);
        return sendJson(response, 200, { queued: behavior.type });
      }

      // ---- OAuth
      if (path === '/common/oauth2/v2.0/authorize' && request.method === 'GET') {
        if (query.client_id !== state.clientId || query.response_type !== 'code' || !query.redirect_uri || !query.state) {
          response.writeHead(400, { 'content-type': 'text/plain' });
          return response.end('AADSTS700016 (stub): Application not found. Check the application id and the request.');
        }
        if (!/^http:\/\/localhost(:\d+)?\//.test(query.redirect_uri)) {
          response.writeHead(400, { 'content-type': 'text/plain' });
          return response.end('AADSTS50011 (stub): The redirect URI must be http://localhost for a desktop application.');
        }
        if (query.code_challenge_method !== 'S256' || !query.code_challenge) {
          response.writeHead(400, { 'content-type': 'text/plain' });
          return response.end('AADSTS9000411 (stub): PKCE with S256 is required.');
        }
        const allow = approveUrl(query.client_id, query.redirect_uri, query.state, query.code_challenge, query.scope ?? '', 'allow');
        const deny = approveUrl(query.client_id, query.redirect_uri, query.state, query.code_challenge, query.scope ?? '', 'deny');
        if (query.auto === '1') {
          response.writeHead(302, { location: allow });
          return response.end();
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return response.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>Stub Microsoft sign in</title></head><body style="font-family:system-ui;max-width:32rem;margin:3rem auto">` +
            `<h1>Stub Microsoft sign in</h1><p>This is a local stand-in for Microsoft's consent screen. It asks for:</p><pre>${(query.scope ?? '').split(' ').join('\n')}</pre>` +
            `<p><a href="${allow}">Allow</a> &nbsp; <a href="${deny}">Cancel</a></p></body></html>`,
        );
      }
      if (path === '/common/oauth2/v2.0/token' && request.method === 'POST') {
        const form = (body ?? {}) as Record<string, string>;
        const grantType = form.grant_type ?? '';
        const record = { grantType, verifierMatched: null as boolean | null, form };
        state.tokenRequests.push(record);
        if (state.tokenMode === 'unavailable') return sendJson(response, 503, { error: 'temporarily_unavailable' });
        if (state.tokenMode === 'public_client') {
          return sendJson(response, 401, { error: 'invalid_client', error_description: 'AADSTS7000218: The request body must contain the following parameter: client_assertion or client_secret.\r\nTrace ID: stub' });
        }
        if (form.client_id !== state.clientId || state.tokenMode === 'invalid_client') {
          return sendJson(response, 400, { error: 'invalid_request', error_description: 'AADSTS700016: Application with identifier was not found in the directory.\r\nTrace ID: stub' });
        }
        if (grantType === 'authorization_code') {
          const issued = state.codes[form.code ?? ''];
          if (!issued || issued.used || issued.redirectUri !== form.redirect_uri || !form.code_verifier) {
            return sendJson(response, 400, { error: 'invalid_grant', error_description: 'AADSTS70000: The provided value for the code is not valid.' });
          }
          const matched = createHash('sha256').update(form.code_verifier).digest('base64url') === issued.challenge;
          record.verifierMatched = matched;
          if (!matched) return sendJson(response, 400, { error: 'invalid_grant', error_description: 'AADSTS501481: The Code_Verifier does not match the code_challenge.' });
          issued.used = true;
          const accessToken = `eyJ.stub-access-${state.nextId}`;
          const refreshToken = `M.C500.stub-refresh-${state.nextId}`;
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
            return sendJson(response, 400, { error: 'invalid_grant', error_description: 'AADSTS70008: The refresh token has expired due to inactivity.' });
          }
          const accessToken = `eyJ.stub-access-${state.nextId}`;
          let refreshToken = form.refresh_token!;
          if (state.rotateRefreshTokens) {
            state.refreshTokens.delete(form.refresh_token!);
            refreshToken = `M.C500.stub-refresh-${state.nextId}`;
            state.refreshTokens.add(refreshToken);
          }
          state.nextId += 1;
          state.accessTokens.add(accessToken);
          return sendJson(response, 200, {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: state.expiresInSeconds,
            scope: state.grantedScopes.join(' '),
            token_type: 'Bearer',
          });
        }
        return sendJson(response, 400, { error: 'unsupported_grant_type' });
      }

      // ---- Graph
      const graph = /^\/v1\.0(\/.*)$/.exec(path);
      if (!graph) return sendJson(response, 404, graphError(404, 'ResourceNotFound', 'No such route.'));
      const authorization = request.headers.authorization ?? '';
      const accessToken = authorization.replace(/^Bearer /, '');
      const route = graph[1]!;
      if (!state.accessTokens.has(accessToken)) {
        if (/^\/me\/messages\/[^/]+\/send$/.test(route)) {
          state.sendAttempts.push({ id: decodeURIComponent(route.split('/')[3]!), accessToken, processed: false });
        }
        if (route === '/me/messages' && request.method === 'POST') state.createAttempts.push({ body, accessToken });
        return sendJson(response, 401, graphError(401, 'InvalidAuthenticationToken', 'Access token is empty or invalid.'));
      }

      state.onRequest?.({ method: request.method ?? 'GET', path: route, query });

      if (route === '/me' && request.method === 'GET') {
        if (state.profileStatus) return sendJson(response, state.profileStatus, graphError(state.profileStatus, 'Authorization_RequestDenied', 'Stub failure.'));
        if (state.profileBody) return sendJson(response, 200, state.profileBody);
        return sendJson(response, 200, { displayName: 'Stub Sender', mail: state.address, userPrincipalName: state.address });
      }

      // Create a draft.
      if (route === '/me/messages' && request.method === 'POST') {
        state.createAttempts.push({ body, accessToken });
        state.onCreate?.();
        const behavior = state.createScript.shift();
        if (behavior?.type === 'respond') return sendJson(response, behavior.status, behavior.body ?? graphError(behavior.status, 'ErrorStub', 'Stub failure.'), behavior.headers);
        const message = createDraft(body);
        if (behavior?.type === 'process_then_respond') return sendJson(response, behavior.status, behavior.body ?? graphError(behavior.status, 'ErrorStub', 'Stub failure.'));
        if (behavior?.type === 'process_then_delay') {
          setTimeout(() => parseCreate(response, message), behavior.delayMs);
          return undefined;
        }
        if (behavior?.type === 'process_then_garbage') {
          response.writeHead(201, { 'content-type': 'application/json' });
          return response.end('not json');
        }
        return parseCreate(response, message);
      }

      // Send a draft.
      const send = /^\/me\/messages\/([^/]+)\/send$/.exec(route);
      if (send && request.method === 'POST') {
        const id = decodeURIComponent(send[1]!);
        state.onSend?.({ id });
        const message = state.messages[id];
        const attempt = { id, accessToken, processed: false };
        state.sendAttempts.push(attempt);
        const behavior = state.sendScript.shift();
        if (behavior?.type === 'respond') {
          return sendJson(response, behavior.status, behavior.body ?? graphError(behavior.status, 'ErrorStub', 'Stub failure.'), behavior.headers);
        }
        // A message that is not a draft cannot be sent again.
        if (!message || !message.isDraft) return sendJson(response, 404, graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.'));
        sendDraft(message, accessToken);
        attempt.processed = true;
        if (behavior?.type === 'process_then_respond') return sendJson(response, behavior.status, behavior.body ?? graphError(behavior.status, 'ErrorStub', 'Stub failure.'));
        if (behavior?.type === 'process_then_delay') {
          setTimeout(() => {
            if (!response.writableEnded && !response.destroyed) {
              response.writeHead(202);
              response.end();
            }
          }, behavior.delayMs);
          return undefined;
        }
        response.writeHead(202);
        return response.end();
      }

      // Folder names and ids.
      const folderOnly = /^\/me\/mailFolders\/([^/]+)$/.exec(route);
      if (folderOnly && request.method === 'GET') {
        const folder = folderIds[folderOnly[1]!.toLowerCase()];
        if (!folder) return sendJson(response, 404, graphError(404, 'ErrorInvalidIdMalformed', 'Unknown folder.'));
        return sendJson(response, 200, { id: folderIdOf(folder), displayName: folder });
      }

      // Drafts and sent items listings.
      const listing = /^\/me\/mailFolders\/(drafts|sentitems)\/messages$/.exec(route);
      if (listing && request.method === 'GET') {
        const folder = folderIds[listing[1]!]!;
        let items = Object.values(state.messages).filter((message) => message.folder === folder);
        const filter = /^internetMessageId eq '((?:[^']|'')*)'$/.exec(query.$filter ?? '');
        if (query.$filter) {
          if (!filter) return sendJson(response, 400, graphError(400, 'ErrorInvalidProperty', 'The stub only supports internetMessageId eq filters.'));
          const wanted = filter[1]!.replace(/''/g, "'");
          items = items.filter((message) => message.internetMessageId === wanted);
        }
        items.sort((a, b) => b.order - a.order);
        const top = Number(query.$top ?? 10);
        return sendJson(response, 200, { value: items.slice(0, top).map((message) => visible(message, query.$select)) });
      }

      // The delta feed of the inbox.
      if (route === '/me/mailFolders/inbox/messages/delta' && request.method === 'GET') {
        const scripted = state.deltaScript.shift();
        if (scripted) return sendJson(response, scripted.status, scripted.body ?? graphError(scripted.status, 'ErrorStub', 'Stub failure.'), scripted.headers);
        if (state.deltaGone && (query.$deltatoken || query.$skiptoken)) {
          state.deltaGone = false;
          return sendJson(response, 410, graphError(410, 'SyncStateNotFound', 'The sync state generation is not found.'));
        }
        const prefer = String(request.headers.prefer ?? '');
        const asked = /odata\.maxpagesize=(\d+)/.exec(prefer);
        const page = deltaPage(query, asked ? Number(asked[1]) : 100);
        const link = (params: Record<string, string>): string => {
          const next = new URL(`${baseUrl}/v1.0/me/mailFolders/inbox/messages/delta`);
          if (page.selectEcho) next.searchParams.set('$select', page.selectEcho);
          for (const [key, value] of Object.entries(params)) next.searchParams.set(key, value);
          return next.toString();
        };
        return sendJson(response, 200, {
          value: page.value,
          ...(page.nextToken ? { '@odata.nextLink': link({ $skiptoken: page.nextToken }) } : { '@odata.deltaLink': link({ $deltatoken: String(page.snapshot) }) }),
        });
      }

      // Attachments of a message.
      const attachmentValue = /^\/me\/messages\/([^/]+)\/attachments\/([^/]+)\/\$value$/.exec(route);
      if (attachmentValue && request.method === 'GET') {
        const message = state.messages[decodeURIComponent(attachmentValue[1]!)];
        const attachment = message?.attachments.find((item) => item.id === decodeURIComponent(attachmentValue[2]!));
        if (!attachment) return sendJson(response, 404, graphError(404, 'ErrorItemNotFound', 'Attachment not found.'));
        response.writeHead(200, { 'content-type': 'text/plain' });
        return response.end(attachment.text);
      }
      const attachments = /^\/me\/messages\/([^/]+)\/attachments$/.exec(route);
      if (attachments && request.method === 'GET') {
        const message = state.messages[decodeURIComponent(attachments[1]!)];
        if (!message) return sendJson(response, 404, graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.'));
        return sendJson(response, 200, {
          value: message.attachments.map((attachment) =>
            attachment.kind === 'file'
              ? { '@odata.type': '#microsoft.graph.fileAttachment', id: attachment.id, name: attachment.name, contentType: attachment.contentType, size: attachment.text.length, contentBytes: Buffer.from(attachment.text, 'utf8').toString('base64') }
              : { '@odata.type': '#microsoft.graph.itemAttachment', id: attachment.id, name: attachment.name, contentType: attachment.contentType, size: attachment.text.length },
          ),
        });
      }

      // One message.
      const one = /^\/me\/messages\/([^/]+)$/.exec(route);
      if (one && request.method === 'GET') {
        const id = decodeURIComponent(one[1]!);
        const status = state.getStatusById[id];
        if (status) return sendJson(response, status, graphError(status, 'ErrorStub', 'Stub failure.'));
        const message = state.messages[id];
        if (!message) return sendJson(response, 404, graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.'));
        return sendJson(response, 200, visible(message, query.$select));
      }
      return sendJson(response, 404, graphError(404, 'ResourceNotFound', 'No such route.'));
    });
  });

  function approveUrl(clientId: string, redirectUri: string, stateValue: string, challenge: string, scope: string, outcome: 'allow' | 'deny'): string {
    const target = new URL(redirectUri);
    if (outcome === 'deny') {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('error_description', 'AADSTS65004: User declined to consent to access the app.\r\nTrace ID: stub');
      target.searchParams.set('state', stateValue);
      return target.toString();
    }
    if (state.consentError) {
      target.searchParams.set('error', state.consentError.error);
      target.searchParams.set('error_description', state.consentError.description);
      target.searchParams.set('state', stateValue);
      return target.toString();
    }
    const code = `M.C500.stub-code-${state.nextId}`;
    state.nextId += 1;
    const asked = scope.split(/\s+/).filter(Boolean).filter((item) => item !== 'offline_access');
    state.codes[code] = {
      challenge,
      redirectUri,
      clientId,
      used: false,
      scopes: asked.filter((item) => state.grantedScopes.some((granted) => granted.toLowerCase() === item.toLowerCase())),
    };
    target.searchParams.set('code', code);
    target.searchParams.set('state', stateValue);
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
    removeInbound,
    addStrayDraft,
    editDraft,
    moveMessage,
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
    drafts: () => Object.values(state.messages).filter((message) => message.folder === 'drafts'),
    sendCount: () => state.sent.length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Points the Microsoft provider at the stub, shortens the request timeout, and makes reconciliation immediate.
// Returns a function that restores the environment.
export function useMicrosoftStub(stub: MicrosoftStub, extra: Record<string, string> = {}): () => void {
  const defaults: Record<string, string> = {
    AGENTCRM_MS_LOGIN_BASE: stub.url,
    AGENTCRM_GRAPH_BASE: stub.url,
    AGENTCRM_MS_TIMEOUT_MS: '400',
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
