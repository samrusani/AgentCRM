import { createHash, randomBytes } from 'node:crypto';
import { gmailBaseUrl, gmailRequestTimeoutMilliseconds, googleAuthBaseUrl, googleTokenBaseUrl } from '../config.js';
import {
  clearFetchFailure,
  type InboundBatch,
  type ListInboundOptions,
  type MailErrorKind,
  type MailIntent,
  type MailProvider,
  MailProviderError,
  type NormalizedInbound,
  noteFetchFailure,
  type ReconcileResult,
} from './mailTypes.js';

// Gmail has no idempotency key. A send is protected by a Message-ID the app generates and saves before the request
// leaves the process; after an unclear outcome the app searches Gmail for that header (read only) and never sends again.

export const gmailScopes = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'] as const;

export const consentExpiredSentence =
  'Google no longer accepts this sign in. Consents for a Google Cloud client in Testing status expire after seven days, so sign in with Google again.';
export const clientRejectedSentence = 'Google did not accept the saved client id and client secret. Check them in Settings and sign in again.';
export const readPermissionSentence = 'Gmail did not allow reading mail. Sign in with Google again and allow both permissions.';

export class GmailError extends MailProviderError {
  constructor(kind: MailErrorKind, message: string, status: number | null = null, options: { sentNothing?: boolean } = {}) {
    super(kind, message, status, options);
    this.name = 'GmailError';
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function scrub(message: string, secrets: readonly string[]): string {
  let result = message;
  for (const secret of secrets) if (secret.length > 0) result = result.replaceAll(secret, '[removed]');
  return result;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

// ---------------------------------------------------------------------------------------------------------------
// OAuth

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  return { verifier, challenge: base64Url(createHash('sha256').update(verifier).digest()) };
}

export function createState(): string {
  return base64Url(randomBytes(24));
}

export function buildAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL(`${googleAuthBaseUrl()}/o/oauth2/v2/auth`);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', gmailScopes.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

interface RawResponse {
  status: number;
  json: unknown;
  // True when the status line arrived but the body could not be read as JSON.
  unreadable: boolean;
  timedOutReading: boolean;
}

async function gmailFetch(url: URL, init: RequestInit): Promise<RawResponse> {
  let response: Response;
  try {
    // A redirect is never followed, so a token in the headers cannot be sent to another host.
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(gmailRequestTimeoutMilliseconds()) });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new GmailError('timeout', 'Google did not answer in time.');
    throw new GmailError('network', 'Could not reach Google.');
  }
  try {
    const raw = await response.text();
    if (raw === '') return { status: response.status, json: null, unreadable: false, timedOutReading: false };
    try {
      return { status: response.status, json: JSON.parse(raw) as unknown, unreadable: false, timedOutReading: false };
    } catch {
      return { status: response.status, json: null, unreadable: true, timedOutReading: false };
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return { status: response.status, json: null, unreadable: true, timedOutReading: true };
    return { status: response.status, json: null, unreadable: true, timedOutReading: false };
  }
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  // The scopes Google granted, when it says.
  scopes: string[] | null;
}

function oauthErrorCode(json: unknown): string | null {
  return isRecord(json) ? text(json.error) : null;
}

async function tokenRequest(form: Record<string, string>, secrets: readonly string[]): Promise<TokenResponse> {
  const response = await gmailFetch(new URL(`${googleTokenBaseUrl()}/token`), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  if (response.status === 200 && isRecord(response.json)) {
    const accessToken = text(response.json.access_token);
    const expires = typeof response.json.expires_in === 'number' ? response.json.expires_in : Number(response.json.expires_in);
    if (!accessToken) throw new GmailError('bad_response', 'Google answered the sign in without an access token.', 200);
    return {
      accessToken,
      refreshToken: text(response.json.refresh_token),
      expiresInSeconds: Number.isFinite(expires) && expires > 0 ? expires : 3600,
      scopes: typeof response.json.scope === 'string' ? response.json.scope.split(/\s+/).filter(Boolean) : null,
    };
  }
  const code = oauthErrorCode(response.json);
  const description = isRecord(response.json) ? text(response.json.error_description) : null;
  if (response.status === 400 && code === 'invalid_grant') {
    throw new GmailError('unauthorized', consentExpiredSentence, 400);
  }
  if ((response.status === 400 || response.status === 401) && code === 'invalid_client') {
    throw new GmailError('unauthorized', clientRejectedSentence, response.status);
  }
  if (response.status === 429) throw new GmailError('rate_limited', 'Google is rate limiting sign in requests.', 429);
  if (response.status >= 500) throw new GmailError('unavailable', `Google had a server problem (HTTP ${response.status}).`, response.status);
  if (response.status >= 400) {
    const detail = description ? `: ${scrub(description, secrets).slice(0, 200)}` : '';
    throw new GmailError('rejected', `Google did not accept the sign in (HTTP ${response.status})${detail}`, response.status);
  }
  throw new GmailError('bad_response', 'Google sent a sign in response this app could not read.', response.status);
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes: string[] | null;
}

export async function exchangeAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  redirectUri: string;
  now: () => number;
}): Promise<ExchangedTokens> {
  const tokens = await tokenRequest(
    {
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    },
    [input.clientSecret, input.code, input.verifier],
  );
  if (!tokens.refreshToken) {
    throw new GmailError('bad_response', 'Google did not return a refresh token. Sign in again and allow offline access.');
  }
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(input.now() + tokens.expiresInSeconds * 1000).toISOString(),
    scopes: tokens.scopes,
  };
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

function parseProfile(json: unknown): GmailProfile {
  const emailAddress = isRecord(json) ? text(json.emailAddress) : null;
  const historyId = isRecord(json) ? (text(json.historyId) ?? (typeof json.historyId === 'number' ? String(json.historyId) : null)) : null;
  if (!emailAddress || !historyId) throw new GmailError('bad_response', 'Gmail sent a profile this app could not read.');
  return { emailAddress: emailAddress.toLowerCase(), historyId };
}

// Used by the OAuth callback, before the tokens are saved.
export async function fetchProfileWithToken(accessToken: string): Promise<GmailProfile> {
  const response = await gmailFetch(new URL(`${gmailBaseUrl()}/gmail/v1/users/me/profile`), {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const failure = statusError(response, 'read', [accessToken]);
  if (failure) throw failure;
  return parseProfile(response.json);
}

// ---------------------------------------------------------------------------------------------------------------
// Errors

function googleDetail(json: unknown, secrets: readonly string[]): { reason: string | null; message: string } {
  if (!isRecord(json) || !isRecord(json.error)) return { reason: null, message: '' };
  const error = json.error;
  const first = Array.isArray(error.errors) && isRecord(error.errors[0]) ? error.errors[0] : null;
  const reason = (first ? text(first.reason) : null) ?? text(error.status);
  const message = text(error.message);
  return { reason, message: message ? scrub(message, secrets).slice(0, 300) : '' };
}

// Maps a non-success answer. Returns null for a success.
function statusError(response: RawResponse, operation: 'send' | 'read', secrets: readonly string[]): GmailError | null {
  const { status } = response;
  if (status >= 200 && status < 300) return null;
  const detail = googleDetail(response.json, secrets);
  const suffix = detail.message ? `: ${detail.message}` : '';
  if (status === 401) return new GmailError('unauthorized', 'Gmail did not accept the saved sign in.', status);
  if (status === 403) {
    if (operation === 'read' && (detail.reason === 'insufficientPermissions' || detail.reason === 'PERMISSION_DENIED' || detail.reason === 'forbidden')) {
      return new GmailError('unauthorized', readPermissionSentence, status);
    }
    if (operation === 'read' && (detail.reason === 'rateLimitExceeded' || detail.reason === 'userRateLimitExceeded')) {
      return new GmailError('rate_limited', 'Gmail is rate limiting requests.', status);
    }
    // For a send, 403 means Google refused this message (for example a sending limit), so nothing was sent.
    return new GmailError('rejected', `Gmail rejected the request (HTTP 403)${suffix}`, status);
  }
  if (status === 404) return new GmailError('not_found', 'Gmail could not find that resource.', status);
  if (status === 429) return new GmailError('rate_limited', 'Gmail is rate limiting requests.', status);
  if (status >= 500) return new GmailError('unavailable', `Gmail had a server problem (HTTP ${status}).`, status);
  if (status === 400 || status === 413 || status === 422) return new GmailError('rejected', `Gmail rejected the request (HTTP ${status})${suffix}`, status);
  return new GmailError('unexpected_status', `Gmail answered with an unexpected status (HTTP ${status}).`, status);
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens

export interface GmailSession {
  clientId: string;
  clientSecret: string;
  accessToken: string | null;
  refreshToken: string;
  // ISO time.
  expiresAt: string | null;
}

export interface GmailTokenStore {
  // Identifies the connector, so concurrent refreshes of one connector share a single request.
  key: string;
  read(): GmailSession;
  // Compare and set. `startedFromRefreshToken` is the refresh token the refresh began with. The store writes nothing
  // and returns false when the stored refresh token is different, which means a sign in finished in the meantime.
  save(update: { accessToken: string; refreshToken?: string; expiresAt: string; startedFromRefreshToken: string }): boolean;
  // Google refused the refresh. The store marks the connector as needing a new sign in, unless the stored refresh
  // token is no longer the one that was refused.
  invalid(reason: 'invalid_grant' | 'invalid_client', startedFromRefreshToken: string): void;
}

export const refreshAheadMilliseconds = 2 * 60 * 1000;

const refreshesInFlight = new Map<string, Promise<string>>();

function tokenIsFresh(session: GmailSession, nowMilliseconds: number): boolean {
  return (
    Boolean(session.accessToken) &&
    session.expiresAt !== null &&
    Date.parse(session.expiresAt) - nowMilliseconds > refreshAheadMilliseconds
  );
}

// One refresh at a time per connector: callers that arrive while one is running wait for its result.
// A sign in can finish while a refresh is on the wire. The refresh then belongs to the old account, so its tokens are
// not saved and never used. The work reads the saved sign in again and tries once more with the new credentials.
function refreshAccessToken(store: GmailTokenStore, now: () => number): Promise<string> {
  const running = refreshesInFlight.get(store.key);
  if (running) return running;
  const work = (async (): Promise<string> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = store.read();
      // On the retry the new sign in may already hold a fresh token.
      if (attempt > 0 && session.accessToken && tokenIsFresh(session, now())) return session.accessToken;
      try {
        const tokens = await tokenRequest(
          {
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
            client_id: session.clientId,
            client_secret: session.clientSecret,
          },
          [session.clientSecret, session.refreshToken, session.accessToken ?? ''],
        );
        const saved = store.save({
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          expiresAt: new Date(now() + tokens.expiresInSeconds * 1000).toISOString(),
          startedFromRefreshToken: session.refreshToken,
        });
        if (saved) return tokens.accessToken;
      } catch (error) {
        if (error instanceof GmailError && error.kind === 'unauthorized') {
          store.invalid(error.message === consentExpiredSentence ? 'invalid_grant' : 'invalid_client', session.refreshToken);
        }
        throw error;
      }
    }
    throw new GmailError('unavailable', 'The Gmail sign in changed while its access was being renewed. Try again.');
  })().finally(() => {
    refreshesInFlight.delete(store.key);
  });
  refreshesInFlight.set(store.key, work);
  return work;
}

// ---------------------------------------------------------------------------------------------------------------
// Composing a message

const headerForbidden = /[\r\n\0]/;

function assertHeader(name: string, value: string): void {
  if (headerForbidden.test(value)) {
    throw new GmailError('rejected', `The ${name} of this message contains a line break, so it was not sent.`, null, { sentNothing: true });
  }
}

// Subjects with anything outside printable ASCII become RFC 2047 encoded words, split so no line is too long.
export function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words: string[] = [];
  let chunk = '';
  for (const character of subject) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 42) {
      words.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join('\r\n ');
}

export interface ComposeInput {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  date: Date;
  replyTo?: { inReplyTo: string; references: string[] } | null;
}

// A plain text RFC 2822 message with CRLF line ends. The body is base64 so any character survives transport.
export function composeRawMessage(input: ComposeInput): string {
  for (const [name, value] of [
    ['sender', input.from],
    ['recipient', input.to],
    ['subject', input.subject],
    ['message id', input.messageId],
  ] as const) {
    assertHeader(name, value);
  }
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodeSubject(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    `Message-ID: ${input.messageId}`,
  ];
  if (input.replyTo) {
    assertHeader('reply reference', input.replyTo.inReplyTo);
    for (const reference of input.replyTo.references) assertHeader('reply reference', reference);
    lines.push(`In-Reply-To: ${input.replyTo.inReplyTo}`);
    lines.push(`References: ${[...input.replyTo.references, input.replyTo.inReplyTo].filter((value, index, all) => all.indexOf(value) === index).join(' ')}`);
  }
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '');
  const encoded = Buffer.from(input.body.replace(/\r\n|\r|\n/g, '\r\n'), 'utf8').toString('base64');
  const wrapped = encoded.match(/.{1,76}/g) ?? [];
  return `${lines.join('\r\n')}\r\n${wrapped.join('\r\n')}\r\n`;
}

export function generateMessageIdHeader(intentId: string, address: string): string {
  const domain = address.split('@').pop() ?? 'localhost';
  return `<ac-${intentId}-${randomBytes(6).toString('hex')}@${domain}>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a message

interface GmailHeader {
  name?: unknown;
  value?: unknown;
}

interface GmailPart {
  mimeType?: unknown;
  filename?: unknown;
  headers?: unknown;
  body?: unknown;
  parts?: unknown;
}

function headersOf(part: GmailPart | null): { name: string; value: string }[] {
  if (!part || !Array.isArray(part.headers)) return [];
  return (part.headers as GmailHeader[]).flatMap((entry) =>
    isRecord(entry) && typeof entry.name === 'string' && typeof entry.value === 'string' ? [{ name: entry.name, value: entry.value }] : [],
  );
}

function headerValue(part: GmailPart | null, name: string): string | null {
  const found = headersOf(part).find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : null;
}

function childParts(part: GmailPart): GmailPart[] {
  return Array.isArray(part.parts) ? (part.parts as unknown[]).filter(isRecord) : [];
}

function decodeBody(part: GmailPart): string | null {
  const body = isRecord(part.body) ? part.body : null;
  const data = body && typeof body.data === 'string' ? body.data : null;
  if (data === null) return null;
  const buffer = Buffer.from(data, 'base64url');
  const contentType = headerValue(part, 'content-type') ?? '';
  const charset = /charset="?([A-Za-z0-9_.:-]+)"?/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

const namedEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return safeCodePoint(Number.parseInt(entity.slice(2), 16), match);
    if (entity.startsWith('#')) return safeCodePoint(Number.parseInt(entity.slice(1), 10), match);
    return namedEntities[entity.toLowerCase()] ?? match;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

// A stripped version of an HTML body for messages that have no plain text part.
export function htmlToText(html: string): string {
  const withoutBlocks = html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ');
  const withBreaks = withoutBlocks
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(withBreaks)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// RFC 2047 encoded words in a header value, such as "=?UTF-8?B?...?=" and "=?UTF-8?Q?...?=".
export function decodeMimeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (match, charset: string, encoding: string, data: string) => {
      try {
        const bytes =
          encoding.toLowerCase() === 'b'
            ? Buffer.from(data, 'base64')
            : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_pair, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1');
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return match;
      }
    });
}

// Splits an address list on commas that are outside quotes and angle brackets.
export function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === '<') angle += 1;
    else if (!quoted && character === '>') angle = Math.max(0, angle - 1);
    if (character === ',' && !quoted && angle === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const messageIdToken = /<[^<>\s]+@[^<>\s]+>/g;

export function messageIdTokens(value: string): string[] {
  return [...value.matchAll(messageIdToken)].map((match) => match[0]);
}

const maxStoredTextLength = 100_000;
const evidenceMimeTypes = (type: string): boolean => type.startsWith('message/') || type === 'text/rfc822-headers';

interface Extracted {
  plain: string | null;
  html: string | null;
  evidence: string[];
  // Every Action line of the delivery status report, lowercased.
  actions: string[];
}

const actionLine = /^\s*action:\s*([a-z-]+)/gim;

// "failed" wins when a report names several recipients. Otherwise the first action is the answer.
function deliveryActionOf(actions: string[]): string | null {
  return actions.includes('failed') ? 'failed' : (actions[0] ?? null);
}

function extract(part: GmailPart, top: boolean, found: Extracted, inStatus = false): void {
  const type = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
  const attachment = typeof part.filename === 'string' && part.filename !== '';
  if (!top) {
    for (const header of headersOf(part)) {
      const name = header.name.toLowerCase();
      if (name === 'message-id' || name === 'references' || name === 'in-reply-to') found.evidence.push(header.value);
      // The report's per recipient groups can arrive as message parts whose headers hold the fields.
      if (inStatus && name === 'action') found.actions.push(header.value.trim().toLowerCase());
    }
  }
  if (type === 'message/delivery-status') {
    const body = decodeBody(part);
    if (body) for (const match of body.matchAll(actionLine)) found.actions.push(match[1]!.toLowerCase());
  }
  if (!attachment) {
    if (type === 'text/plain' && found.plain === null) found.plain = decodeBody(part);
    else if (type === 'text/html' && found.html === null) found.html = decodeBody(part);
    else if (evidenceMimeTypes(type)) {
      const body = decodeBody(part);
      if (body) found.evidence.push(body);
    }
  }
  for (const child of childParts(part)) extract(child, false, found, inStatus || type === 'message/delivery-status');
}

function clipText(value: string): string {
  return value.length > maxStoredTextLength ? value.slice(0, maxStoredTextLength) : value;
}

export function normalizeGmailMessage(raw: unknown, address: string, fallbackReceivedAt: string): NormalizedInbound | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id);
  if (!id) return null;
  const payload: GmailPart | null = isRecord(raw.payload) ? (raw.payload as GmailPart) : null;
  const labels = Array.isArray(raw.labelIds) ? raw.labelIds.filter((label): label is string => typeof label === 'string') : [];
  if (labels.includes('DRAFT')) return null;
  const found: Extracted = { plain: null, html: null, evidence: [], actions: [] };
  if (payload) extract(payload, true, found);
  const body = found.plain ?? (found.html !== null ? htmlToText(found.html) : null);
  const references = (headerValue(payload, 'references') ?? '').split(/\s+/).filter(Boolean);
  const internal = typeof raw.internalDate === 'string' ? Number(raw.internalDate) : typeof raw.internalDate === 'number' ? raw.internalDate : NaN;
  const dateHeader = headerValue(payload, 'date');
  const parsedDate = dateHeader ? Date.parse(dateHeader) : NaN;
  const receivedAt = Number.isFinite(internal) ? new Date(internal).toISOString() : Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : fallbackReceivedAt;
  const from = decodeMimeWords(headerValue(payload, 'from') ?? '');
  const toHeader = [headerValue(payload, 'to'), headerValue(payload, 'cc')].filter((value): value is string => Boolean(value));
  const sentByUs = labels.includes('SENT') && !labels.includes('INBOX');
  const snippet = typeof raw.snippet === 'string' ? decodeEntities(raw.snippet) : '';
  const stored = body === null ? null : clipText(body);
  return {
    providerMessageId: id,
    threadId: text(raw.threadId),
    direction: sentByUs ? 'out' : 'in',
    from,
    to: toHeader.flatMap((value) => splitAddressList(decodeMimeWords(value))),
    subject: decodeMimeWords(headerValue(payload, 'subject') ?? ''),
    preview: snippet,
    labels,
    text: stored,
    replyText: stored ?? snippet,
    messageIdHeader: text(headerValue(payload, 'message-id')),
    inReplyTo: text(headerValue(payload, 'in-reply-to')),
    references,
    evidenceText: clipText(found.evidence.join('\n')),
    deliveryAction: deliveryActionOf(found.actions),
    receivedAt,
    unreadable: false,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The adapter

export interface GmailAdapterOptions {
  address: string;
  store: GmailTokenStore;
  now: () => number;
}

const historyPageSize = 25;

// History pages that come back empty but name a next page are followed, at most this many per poll.
export const maxEmptyHistoryPages = 20;

// The saved position is a history id. While empty pages are being followed across polls it also holds the page token.
const cursorSeparator = '~';

function parseHistoryCursor(cursor: string): { startHistoryId: string; pageToken: string | null } {
  const at = cursor.indexOf(cursorSeparator);
  return at < 0 ? { startHistoryId: cursor, pageToken: null } : { startHistoryId: cursor.slice(0, at), pageToken: cursor.slice(at + 1) || null };
}

function formatHistoryCursor(startHistoryId: string, pageToken: string): string {
  return `${startHistoryId}${cursorSeparator}${pageToken}`;
}

export function createGmailMailProvider(options: GmailAdapterOptions): MailProvider {
  const { address, store, now } = options;

  const secretsOf = (): string[] => {
    const session = store.read();
    return [session.clientSecret, session.refreshToken, session.accessToken ?? ''];
  };

  async function accessToken(): Promise<string> {
    const session = store.read();
    if (tokenIsFresh(session, now()) && session.accessToken) return session.accessToken;
    return refreshAccessToken(store, now);
  }

  // Replaces a token that Google just refused. If another caller already refreshed it, that token is used instead.
  async function replacementToken(refused: string): Promise<string> {
    const session = store.read();
    if (session.accessToken && session.accessToken !== refused && tokenIsFresh(session, now())) return session.accessToken;
    return refreshAccessToken(store, now);
  }

  interface CallOptions {
    query?: Record<string, string>;
    body?: unknown;
    // Reads may never reach a mutating endpoint. The check is by construction and again here.
    readOnly?: boolean;
    // For the send request: a failure to get a token happens before anything left the process.
    sending?: boolean;
  }

  // 401 handling: Google answers 401 when it rejects the credential, which happens before the request is routed to
  // any handler, so no mail was accepted. The token is refreshed once and the identical request is sent again. A
  // second 401 is final. This retry is the only retry in the send path, and it cannot produce two emails because the
  // first request was refused at authentication.
  async function call(method: 'GET' | 'POST', path: string, opts: CallOptions = {}): Promise<RawResponse> {
    if (opts.readOnly && (method !== 'GET' || /\/messages\/send$/.test(path))) {
      throw new Error('A read only Gmail call must not reach the send endpoint.');
    }
    const url = new URL(`${gmailBaseUrl()}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
    const send = async (token: string): Promise<RawResponse> =>
      gmailFetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    const beforeSend = <T>(work: Promise<T>): Promise<T> =>
      opts.sending
        ? work.catch((error: unknown) => {
            if (error instanceof MailProviderError) {
              throw new GmailError(error.kind, `${error.message} The message was not sent.`, error.status, { sentNothing: true });
            }
            throw error;
          })
        : work;
    let token = await beforeSend(accessToken());
    let response = await send(token);
    if (response.status === 401) {
      token = await beforeSend(replacementToken(token));
      response = await send(token);
    }
    return response;
  }

  const readJson = async (method: 'GET', path: string, query?: Record<string, string>): Promise<unknown> => {
    const response = await call(method, path, { readOnly: true, ...(query ? { query } : {}) });
    const failure = statusError(response, 'read', secretsOf());
    if (failure) throw failure;
    if (response.unreadable) {
      throw new GmailError(response.timedOutReading ? 'timeout' : 'bad_response', 'Gmail sent a response this app could not read.', response.status);
    }
    return response.json;
  };

  const fetchProfile = async (): Promise<GmailProfile> => parseProfile(await readJson('GET', '/gmail/v1/users/me/profile'));

  async function fetchFullMessage(id: string): Promise<unknown> {
    return readJson('GET', `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, { format: 'full' });
  }

  return {
    kind: 'gmail',
    label: 'Gmail',
    duplicateProtection: 'message_id_search',

    async submit(intent: MailIntent) {
      if (!intent.messageIdHeader) {
        throw new GmailError('rejected', 'This message has no saved Message-ID, so it was not sent.', null, { sentNothing: true });
      }
      const raw = composeRawMessage({
        from: intent.fromAddress,
        to: intent.to,
        subject: intent.subject,
        body: intent.body,
        messageId: intent.messageIdHeader,
        date: new Date(now()),
        ...(intent.replyTo ? { replyTo: { inReplyTo: intent.replyTo.inReplyTo, references: intent.replyTo.references } } : {}),
      });
      const response = await call('POST', '/gmail/v1/users/me/messages/send', {
        sending: true,
        body: { raw: Buffer.from(raw, 'utf8').toString('base64url'), ...(intent.replyTo ? { threadId: intent.replyTo.threadId } : {}) },
      });
      const failure = statusError(response, 'send', secretsOf());
      if (failure) throw failure;
      const messageId = isRecord(response.json) ? text(response.json.id) : null;
      if (response.unreadable) {
        throw new GmailError(response.timedOutReading ? 'timeout' : 'bad_response', 'Gmail answered the send in a way this app could not read.', response.status);
      }
      if (!messageId) throw new GmailError('bad_response', 'Gmail answered the send without a message id.', response.status);
      return { messageId, threadId: isRecord(response.json) ? text(response.json.threadId) : null };
    },

    // READ ONLY. This searches Gmail for the Message-ID saved before the send and never calls the send endpoint.
    async reconcileUnknown(intent: MailIntent): Promise<ReconcileResult> {
      if (!intent.messageIdHeader) return { outcome: 'not_found' };
      try {
        const list = await readJson('GET', '/gmail/v1/users/me/messages', {
          q: `rfc822msgid:${intent.messageIdHeader}`,
          includeSpamTrash: 'true',
          maxResults: '5',
        });
        const first = isRecord(list) && Array.isArray(list.messages) ? list.messages.find(isRecord) : undefined;
        const messageId = first ? text(first.id) : null;
        if (!first || !messageId) return { outcome: 'not_found' };
        let threadId = text(first.threadId);
        if (!threadId) {
          try {
            const minimal = await readJson('GET', `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`, { format: 'minimal' });
            threadId = isRecord(minimal) ? text(minimal.threadId) : null;
          } catch {
            // The message is found, which is what matters. The thread id can stay empty.
          }
        }
        return { outcome: 'accepted', messageId, threadId };
      } catch (error) {
        if (error instanceof MailProviderError) return { outcome: 'unavailable', error };
        return { outcome: 'unavailable', error: new MailProviderError('unavailable', 'The check failed in an unexpected way.') };
      }
    },

    async listInbound(cursor: string | null, listOptions: ListInboundOptions): Promise<InboundBatch> {
      if (!cursor) {
        // No saved position: start from now. Nothing before this was ever seen, so nothing can be skipped.
        const profile = await fetchProfile();
        return { messages: [], nextCursor: profile.historyId, more: false };
      }
      const position = parseHistoryCursor(cursor);
      let history: unknown;
      let records: Json[] = [];
      let nextPage: string | null = null;
      let pageToken = position.pageToken;
      try {
        for (let page = 1; ; page += 1) {
          try {
            history = await readJson('GET', '/gmail/v1/users/me/history', {
              startHistoryId: position.startHistoryId,
              historyTypes: 'messageAdded',
              labelId: 'INBOX',
              maxResults: String(historyPageSize),
              ...(pageToken ? { pageToken } : {}),
            });
          } catch (error) {
            // A saved page token that Google no longer accepts is dropped, and the same position is read again.
            if (pageToken && error instanceof GmailError && error.kind === 'rejected') {
              pageToken = null;
              history = await readJson('GET', '/gmail/v1/users/me/history', {
                startHistoryId: position.startHistoryId,
                historyTypes: 'messageAdded',
                labelId: 'INBOX',
                maxResults: String(historyPageSize),
              });
            } else {
              throw error;
            }
          }
          records = isRecord(history) && Array.isArray(history.history) ? history.history.filter(isRecord) : [];
          nextPage = isRecord(history) ? text(history.nextPageToken) : null;
          // A page can be empty and still point to the next one. It is followed by its token, never read again from
          // the same position, which would return the same empty page for ever.
          if (records.length > 0 || !nextPage) break;
          if (page >= maxEmptyHistoryPages) {
            // Enough requests for one poll. Nothing was fetched, so there is nothing to store; the page token is kept
            // with the position and the next poll carries on from it.
            return { messages: [], nextCursor: formatHistoryCursor(position.startHistoryId, nextPage), more: false };
          }
          pageToken = nextPage;
        }
      } catch (error) {
        if (error instanceof GmailError && error.kind === 'not_found') {
          // The saved position is too old for Gmail to replay. Start from the present and say so.
          const profile = await fetchProfile();
          return {
            messages: [],
            nextCursor: profile.historyId,
            more: false,
            reset: {
              note: 'Gmail could not replay mail from the saved position, so the sync started again from now. Replies that arrived in between may not be shown here.',
            },
          };
        }
        throw error;
      }
      const mailboxHistoryId = isRecord(history) ? (text(history.historyId) ?? (typeof history.historyId === 'number' ? String(history.historyId) : null)) : null;
      const lastRecordId = records.length > 0 ? (text(records[records.length - 1]!.id) ?? String(records[records.length - 1]!.id ?? '')) : null;
      const added: { id: string; labelIds: string[] }[] = [];
      const seen = new Set<string>();
      for (const record of records) {
        const entries = Array.isArray(record.messagesAdded) ? record.messagesAdded.filter(isRecord) : [];
        for (const entry of entries) {
          const message = isRecord(entry.message) ? entry.message : null;
          const id = message ? text(message.id) : null;
          if (!message || !id || seen.has(id)) continue;
          seen.add(id);
          const labelIds = Array.isArray(message.labelIds) ? message.labelIds.filter((label): label is string => typeof label === 'string') : [];
          if (labelIds.length > 0 && !labelIds.includes('INBOX')) continue;
          added.push({ id, labelIds });
        }
      }

      const fetched: NormalizedInbound[] = [];
      for (const entry of added) {
        if (listOptions.isKnown(entry.id)) continue;
        const failureKey = `gmail:${address}:${entry.id}`;
        try {
          const full = await fetchFullMessage(entry.id);
          clearFetchFailure(failureKey);
          const normalized = normalizeGmailMessage(full, address, new Date(now()).toISOString());
          if (normalized) fetched.push(normalized);
        } catch (error) {
          // Only a 404 means the message is gone. Any other failure, a 403 quota refusal included, can heal.
          const gone = error instanceof GmailError && error.kind === 'not_found';
          if (gone) {
            clearFetchFailure(failureKey);
            continue;
          }
          const transient = !(error instanceof GmailError) || error.kind !== 'unauthorized';
          if (!transient || noteFetchFailure(failureKey)) {
            // What was fetched before the failure is kept, and the cursor stays where it was.
            return { messages: fetched, nextCursor: null, more: false, failure: error };
          }
          fetched.push({
            providerMessageId: entry.id,
            threadId: null,
            direction: 'in',
            from: '',
            to: [],
            subject: '',
            preview: '',
            labels: entry.labelIds,
            text: null,
            replyText: '',
            messageIdHeader: null,
            inReplyTo: null,
            references: [],
            evidenceText: '',
            deliveryAction: null,
            receivedAt: new Date(now()).toISOString(),
            unreadable: true,
          });
        }
      }
      // More pages: resume from the last record of this one. The final page moves to the mailbox's current position.
      const nextCursor = nextPage ? (lastRecordId ?? position.startHistoryId) : (mailboxHistoryId ?? lastRecordId ?? position.startHistoryId);
      return { messages: fetched, nextCursor, more: Boolean(nextPage) };
    },

    async checkAccount() {
      return { address: (await fetchProfile()).emailAddress };
    },
  };
}
