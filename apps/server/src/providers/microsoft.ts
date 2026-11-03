import { graphBaseUrl, graphRequestTimeoutMilliseconds, msLoginBaseUrl } from '../config.js';
import { createPkce, createState, htmlToText } from './gmail.js';
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
  type ReconcileOptions,
  type ReconcileResult,
  type SubmitHooks,
} from './mailTypes.js';

export { createPkce, createState };

// Microsoft 365 and Outlook.com through Microsoft Graph. A send is protected by saving the message as a draft first.
// Outlook keeps the draft under an immutable id, the app persists that id before anything is sent, and an unclear
// outcome is settled by reading the draft: a message that is no longer a draft and sits in Sent Items went out, a
// message that is still a draft did not.

export const microsoftScopes = ['offline_access', 'Mail.ReadWrite', 'Mail.Send', 'User.Read'] as const;
// What must be granted for the connector to work. User.Read is requested so GET /me can name the account; it is not
// needed to send or read mail.
export const requiredMicrosoftScopes = ['mail.readwrite', 'mail.send'] as const;

export const signInExpiredSentence = 'Microsoft no longer accepts this sign in. Sign in with Microsoft again.';
export const clientRejectedSentence =
  'Microsoft did not accept the saved application (client) id. Check it in Settings and sign in again.';
export const publicClientSentence =
  'Microsoft says this app registration is not a public client. In Entra, open Authentication and set Allow public client flows to Yes, then sign in again.';
export const readPermissionSentence = 'Microsoft did not allow reading or sending mail. Sign in with Microsoft again and allow both permissions.';

export const introHeaderName = 'x-agentcrm-intent';

export class MicrosoftError extends MailProviderError {
  // Set for a refused token request, so the connector can say which kind of sign in problem it was.
  readonly reason: 'invalid_grant' | 'invalid_client' | null;

  constructor(
    kind: MailErrorKind,
    message: string,
    status: number | null = null,
    options: { sentNothing?: boolean; retryAfterMilliseconds?: number | null; reason?: 'invalid_grant' | 'invalid_client' } = {},
  ) {
    super(kind, message, status, options);
    this.name = 'MicrosoftError';
    this.reason = options.reason ?? null;
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

// ---------------------------------------------------------------------------------------------------------------
// OAuth

export function buildMicrosoftAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL(`${msLoginBaseUrl()}/common/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', microsoftScopes.join(' '));
  // Lets the person choose the account, so a browser that is signed in to another Microsoft account is not used silently.
  url.searchParams.set('prompt', 'select_account');
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

interface RawResponse {
  status: number;
  json: unknown;
  rawText: string;
  // True when the status line arrived but the body could not be read as JSON.
  unreadable: boolean;
  timedOutReading: boolean;
  retryAfterMilliseconds: number | null;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.trunc(seconds * 1000), 3_600_000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), 3_600_000);
  return null;
}

async function graphFetch(url: URL, init: RequestInit): Promise<RawResponse> {
  let response: Response;
  try {
    // A redirect is never followed, so a token in the headers cannot be sent to another host.
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(graphRequestTimeoutMilliseconds()) });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new MicrosoftError('timeout', 'Microsoft did not answer in time.');
    throw new MicrosoftError('network', 'Could not reach Microsoft.');
  }
  const retryAfterMilliseconds = parseRetryAfter(response.headers.get('retry-after'));
  try {
    const raw = await response.text();
    if (raw === '') return { status: response.status, json: null, rawText: '', unreadable: false, timedOutReading: false, retryAfterMilliseconds };
    try {
      return { status: response.status, json: JSON.parse(raw) as unknown, rawText: raw, unreadable: false, timedOutReading: false, retryAfterMilliseconds };
    } catch {
      return { status: response.status, json: null, rawText: raw, unreadable: true, timedOutReading: false, retryAfterMilliseconds };
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { status: response.status, json: null, rawText: '', unreadable: true, timedOutReading: name === 'TimeoutError' || name === 'AbortError', retryAfterMilliseconds };
  }
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scopes: string[] | null;
}

function oauthField(json: unknown, key: string): string | null {
  return isRecord(json) ? text(json[key]) : null;
}

async function tokenRequest(form: Record<string, string>, secrets: readonly string[]): Promise<TokenResponse> {
  const response = await graphFetch(new URL(`${msLoginBaseUrl()}/common/oauth2/v2.0/token`), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  if (response.status === 200 && isRecord(response.json)) {
    const accessToken = text(response.json.access_token);
    const expires = typeof response.json.expires_in === 'number' ? response.json.expires_in : Number(response.json.expires_in);
    if (!accessToken) throw new MicrosoftError('bad_response', 'Microsoft answered the sign in without an access token.', 200);
    return {
      accessToken,
      refreshToken: text(response.json.refresh_token),
      expiresInSeconds: Number.isFinite(expires) && expires > 0 ? expires : 3600,
      scopes: typeof response.json.scope === 'string' ? response.json.scope.split(/\s+/).filter(Boolean) : null,
    };
  }
  const code = oauthField(response.json, 'error');
  const description = oauthField(response.json, 'error_description') ?? '';
  if (response.status === 400 || response.status === 401) {
    if (code === 'invalid_grant' || code === 'interaction_required' || code === 'consent_required' || code === 'login_required') {
      throw new MicrosoftError('unauthorized', signInExpiredSentence, response.status, { reason: 'invalid_grant' });
    }
    if (code === 'invalid_client' || code === 'unauthorized_client' || /AADSTS700016/.test(description)) {
      // AADSTS7000218 is what Entra answers when public client flows are off and no client secret was sent.
      const publicClient = /AADSTS7000218|client_assertion|client_secret/.test(description);
      throw new MicrosoftError('unauthorized', publicClient ? publicClientSentence : clientRejectedSentence, response.status, { reason: 'invalid_client' });
    }
  }
  if (response.status === 429) {
    throw new MicrosoftError('rate_limited', 'Microsoft is rate limiting sign in requests.', 429, { retryAfterMilliseconds: response.retryAfterMilliseconds });
  }
  if (response.status >= 500) throw new MicrosoftError('unavailable', `Microsoft had a server problem (HTTP ${response.status}).`, response.status);
  if (response.status >= 400) {
    const firstLine = description.split(/\r?\n/)[0] ?? '';
    const detail = firstLine ? `: ${scrub(firstLine, secrets).slice(0, 300)}` : '';
    throw new MicrosoftError('rejected', `Microsoft did not accept the sign in (HTTP ${response.status})${detail}`, response.status);
  }
  throw new MicrosoftError('bad_response', 'Microsoft sent a sign in response this app could not read.', response.status);
}

export interface ExchangedMicrosoftTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes: string[] | null;
}

// Public client with PKCE: there is no client secret.
export async function exchangeMicrosoftCode(input: {
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  now: () => number;
}): Promise<ExchangedMicrosoftTokens> {
  const tokens = await tokenRequest(
    {
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
      scope: microsoftScopes.join(' '),
    },
    [input.code, input.verifier],
  );
  if (!tokens.refreshToken) {
    throw new MicrosoftError('bad_response', 'Microsoft did not return a refresh token. Sign in again and allow offline access.');
  }
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(input.now() + tokens.expiresInSeconds * 1000).toISOString(),
    scopes: tokens.scopes,
  };
}

// The short names of granted permissions, lowercased, without the Graph resource prefix.
export function grantedScopeNames(scopes: string[]): string[] {
  return scopes.map((scope) => scope.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, ''));
}

export interface MicrosoftProfile {
  address: string;
}

function parseProfile(json: unknown): MicrosoftProfile {
  const mail = isRecord(json) ? text(json.mail) : null;
  const principal = isRecord(json) ? text(json.userPrincipalName) : null;
  const address = mail?.includes('@') ? mail : principal?.includes('@') ? principal : null;
  if (!address) throw new MicrosoftError('bad_response', 'Microsoft sent a profile without a mail address.');
  return { address: address.toLowerCase() };
}

// ---------------------------------------------------------------------------------------------------------------
// Errors

function graphDetail(json: unknown, secrets: readonly string[]): { code: string; message: string } {
  if (!isRecord(json) || !isRecord(json.error)) return { code: '', message: '' };
  const code = text(json.error.code) ?? '';
  const message = text(json.error.message);
  return { code, message: message ? scrub(message, secrets).slice(0, 300) : '' };
}

const resyncCodes = new Set(['syncstatenotfound', 'resyncrequired', 'syncstateinvalid']);

function isResync(response: RawResponse): boolean {
  const code = graphDetail(response.json, []).code.toLowerCase();
  return response.status === 410 || resyncCodes.has(code);
}

// Maps a non-success answer. Returns null for a success.
function statusError(response: RawResponse, operation: 'send' | 'read', secrets: readonly string[]): MicrosoftError | null {
  const { status } = response;
  if (status >= 200 && status < 300) return null;
  const detail = graphDetail(response.json, secrets);
  const suffix = detail.message ? `: ${detail.message}` : '';
  const retry = { retryAfterMilliseconds: response.retryAfterMilliseconds };
  if (status === 401) return new MicrosoftError('unauthorized', 'Microsoft did not accept the saved sign in.', status);
  if (status === 403) {
    if (operation === 'read' && /accessdenied|authorization_requestdenied|forbidden/i.test(detail.code)) {
      return new MicrosoftError('unauthorized', readPermissionSentence, status);
    }
    // For a send, 403 means Microsoft refused this message (for example a sending limit), so nothing was sent.
    return new MicrosoftError('rejected', `Microsoft rejected the request (HTTP 403)${suffix}`, status);
  }
  if (status === 404) {
    if (/mailboxnotenabled|mailboxnotsupported/i.test(detail.code)) {
      return new MicrosoftError('rejected', `This Microsoft account has no mailbox that Graph can use${suffix}`, status);
    }
    return new MicrosoftError('not_found', 'Microsoft could not find that resource.', status);
  }
  if (status === 410) return new MicrosoftError('gone', 'Microsoft no longer has that sync position.', status);
  if (status === 429) return new MicrosoftError('rate_limited', 'Microsoft is rate limiting requests.', status, retry);
  if (status >= 500) return new MicrosoftError('unavailable', `Microsoft had a server problem (HTTP ${status}).`, status, retry);
  if (status === 400 || status === 413 || status === 422) return new MicrosoftError('rejected', `Microsoft rejected the request (HTTP ${status})${suffix}`, status);
  return new MicrosoftError('unexpected_status', `Microsoft answered with an unexpected status (HTTP ${status}).`, status);
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens

export interface MicrosoftSession {
  clientId: string;
  accessToken: string | null;
  refreshToken: string;
  // ISO time.
  expiresAt: string | null;
  // The address this sign in belongs to, lowercase.
  address: string | null;
}

export interface MicrosoftTokenStore {
  // Identifies the connector, so concurrent refreshes of one connector share a single request.
  key: string;
  read(): MicrosoftSession;
  // Compare and set. `startedFromRefreshToken` is the refresh token the refresh began with. Microsoft rotates the
  // refresh token on every use, so the replacement is stored with the new access token in the same write. The store
  // writes nothing and returns false when the stored refresh token is different, which means a sign in finished in
  // the meantime.
  save(update: { accessToken: string; refreshToken?: string; expiresAt: string; startedFromRefreshToken: string }): boolean;
  // Microsoft refused the refresh. The store marks the connector as needing a new sign in, unless the stored refresh
  // token is no longer the one that was refused.
  invalid(reason: 'invalid_grant' | 'invalid_client', startedFromRefreshToken: string): void;
}

export const refreshAheadMilliseconds = 2 * 60 * 1000;

const refreshesInFlight = new Map<string, Promise<string>>();

function tokenIsFresh(session: MicrosoftSession, nowMilliseconds: number): boolean {
  return (
    Boolean(session.accessToken) &&
    session.expiresAt !== null &&
    Date.parse(session.expiresAt) - nowMilliseconds > refreshAheadMilliseconds
  );
}

// One refresh at a time per connector. A sign in can finish while a refresh is on the wire. The refresh then belongs
// to the old account, so its tokens are not saved and never used; the work reads the saved sign in again and tries
// once more with the new credentials.
function refreshAccessToken(store: MicrosoftTokenStore, now: () => number): Promise<string> {
  const running = refreshesInFlight.get(store.key);
  if (running) return running;
  const work = (async (): Promise<string> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = store.read();
      if (attempt > 0 && session.accessToken && tokenIsFresh(session, now())) return session.accessToken;
      try {
        const tokens = await tokenRequest(
          {
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
            client_id: session.clientId,
            scope: microsoftScopes.join(' '),
          },
          [session.refreshToken, session.accessToken ?? ''],
        );
        const saved = store.save({
          accessToken: tokens.accessToken,
          // Every response carries the replacement refresh token. The old one is no longer the one to keep.
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          expiresAt: new Date(now() + tokens.expiresInSeconds * 1000).toISOString(),
          startedFromRefreshToken: session.refreshToken,
        });
        if (saved) return tokens.accessToken;
      } catch (error) {
        if (error instanceof MicrosoftError && error.kind === 'unauthorized') {
          store.invalid(error.reason ?? 'invalid_grant', session.refreshToken);
        }
        throw error;
      }
    }
    throw new MicrosoftError('unavailable', 'The Microsoft sign in changed while its access was being renewed. Try again.');
  })().finally(() => {
    refreshesInFlight.delete(store.key);
  });
  refreshesInFlight.set(store.key, work);
  return work;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a message

const maxStoredTextLength = 100_000;
const maxEvidenceCharacters = 300_000;
const maxEvidenceAttachments = 6;

function clipText(value: string): string {
  return value.length > maxStoredTextLength ? value.slice(0, maxStoredTextLength) : value;
}

function addressOf(entry: unknown): { name: string; address: string } | null {
  if (!isRecord(entry) || !isRecord(entry.emailAddress)) return null;
  const address = text(entry.emailAddress.address);
  if (!address) return null;
  return { name: text(entry.emailAddress.name) ?? '', address };
}

function formatAddress(entry: { name: string; address: string }): string {
  return entry.name && entry.name.toLowerCase() !== entry.address.toLowerCase() ? `"${entry.name.replace(/["\\]/g, '')}" <${entry.address}>` : entry.address;
}

const automatedSender = /^(mailer-daemon|postmaster)@/i;

export function normalizeGraphMessage(raw: unknown, fallbackReceivedAt: string): NormalizedInbound | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id);
  if (!id) return null;
  if ('@removed' in raw || raw.isDraft === true) return null;
  const body = isRecord(raw.body) ? raw.body : null;
  const content = body && typeof body.content === 'string' ? body.content : null;
  const isHtml = body ? String(body.contentType ?? '').toLowerCase() === 'html' : false;
  const plain = content === null ? null : isHtml ? htmlToText(content) : content.replace(/\r\n/g, '\n').trim();
  const preview = typeof raw.bodyPreview === 'string' ? raw.bodyPreview : '';
  const stored = plain === null ? null : clipText(plain);
  const from = addressOf(raw.from);
  const recipients = [raw.toRecipients, raw.ccRecipients].flatMap((list) => (Array.isArray(list) ? list : [])).flatMap((entry) => {
    const parsed = addressOf(entry);
    return parsed ? [formatAddress(parsed)] : [];
  });
  const received = typeof raw.receivedDateTime === 'string' ? Date.parse(raw.receivedDateTime) : NaN;
  return {
    providerMessageId: id,
    threadId: text(raw.conversationId),
    direction: 'in',
    from: from ? formatAddress(from) : '',
    to: recipients,
    subject: typeof raw.subject === 'string' ? raw.subject : '',
    preview,
    labels: [],
    text: stored,
    replyText: stored ?? preview,
    messageIdHeader: text(raw.internetMessageId),
    // Header values are read only for delivery reports, which are fetched whole. See bounceEvidence.
    inReplyTo: null,
    references: [],
    evidenceText: '',
    deliveryAction: null,
    receivedAt: Number.isFinite(received) ? new Date(received).toISOString() : fallbackReceivedAt,
    unreadable: false,
  };
}

const actionLine = /^\s*action:\s*([a-z-]+)/gim;

function deliveryActionOf(actions: string[]): string | null {
  return actions.includes('failed') ? 'failed' : (actions[0] ?? null);
}

function headerList(value: unknown): { name: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (isRecord(entry) && typeof entry.name === 'string' && typeof entry.value === 'string' ? [{ name: entry.name, value: entry.value }] : []));
}

// ---------------------------------------------------------------------------------------------------------------
// The adapter

export interface MicrosoftAdapterOptions {
  address: string;
  store: MicrosoftTokenStore;
  now: () => number;
}

// Graph pages followed inside one call. A longer feed continues from its next link on the following call.
export const maxDeltaPages = 20;
const deltaPageSize = 25;
const messageSelect = 'id,from,toRecipients,ccRecipients,subject,body,bodyPreview,internetMessageId,conversationId,receivedDateTime,isDraft';
// What must still match the approved message before a draft is adopted or sent again.
const draftContentSelect = 'toRecipients,ccRecipients,bccRecipients,subject,body';
const immutableIds = 'IdType="ImmutableId"';

interface DraftRef {
  id: string;
  internetMessageId: string | null;
  conversationId: string | null;
}

function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseDraft(json: unknown): DraftRef | null {
  if (!isRecord(json)) return null;
  const id = text(json.id);
  if (!id) return null;
  return { id, internetMessageId: text(json.internetMessageId), conversationId: text(json.conversationId) };
}

const noLineBreak = /[\r\n\0]/;

// The parts of a draft that decide who receives what.
interface DraftContent {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

function recipientAddresses(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const parsed = addressOf(entry);
    return parsed ? [parsed.address.trim().toLowerCase()] : [];
  });
}

function normalizeBodyText(value: string): string {
  return value.replace(/\r\n/g, '\n').trimEnd();
}

// Null when the answer does not carry every part, because then nothing can be proven about the draft.
function readDraftContent(json: unknown): DraftContent | null {
  if (!isRecord(json)) return null;
  const to = recipientAddresses(json.toRecipients);
  const cc = recipientAddresses(json.ccRecipients);
  const bcc = recipientAddresses(json.bccRecipients);
  const body = isRecord(json.body) ? json.body : null;
  if (!to || !cc || !bcc || typeof json.subject !== 'string' || !body || typeof body.content !== 'string') return null;
  const html = String(body.contentType ?? '').toLowerCase() === 'html';
  return { to, cc, bcc, subject: json.subject, body: normalizeBodyText(html ? htmlToText(body.content) : body.content) };
}

// True only when the draft would send exactly the approved message: the one recipient, no copies, the same subject,
// and the same text once line endings and trailing whitespace are ignored.
function draftMatchesIntent(content: DraftContent | null, intent: MailIntent): boolean {
  if (!content) return false;
  const recipient = intent.to.trim().toLowerCase();
  const to = new Set(content.to);
  if (to.size !== 1 || !to.has(recipient)) return false;
  if (content.cc.length > 0 || content.bcc.length > 0) return false;
  return content.subject === intent.subject && content.body === normalizeBodyText(intent.body);
}

export const draftChangedSentence = 'The draft in Outlook changed after approval, so it was not sent. Delete the draft and stage the message again.';
export const notInSentItemsSentence =
  'The message is no longer a draft, but it is not in Sent Items. Look in Sent Items and Deleted Items of the Microsoft account before sending again.';

type Cursor = { kind: 'start'; at: string } | { kind: 'next' | 'delta'; link: string };

function parseCursor(cursor: string): Cursor | null {
  const colon = cursor.indexOf(':');
  if (colon < 0) return null;
  const kind = cursor.slice(0, colon);
  const rest = cursor.slice(colon + 1);
  if (kind === 'start' && Number.isFinite(Date.parse(rest))) return { kind, at: rest };
  if ((kind === 'next' || kind === 'delta') && rest !== '') return { kind, link: rest };
  return null;
}

export function startCursor(atIso: string): string {
  return `start:${atIso}`;
}

export function createMicrosoftMailProvider(options: MicrosoftAdapterOptions): MailProvider {
  const { store, now } = options;
  const address = options.address.toLowerCase();

  const secretsOf = (): string[] => {
    const session = store.read();
    return [session.refreshToken, session.accessToken ?? ''];
  };

  async function accessToken(): Promise<string> {
    const session = store.read();
    if (tokenIsFresh(session, now()) && session.accessToken) return session.accessToken;
    return refreshAccessToken(store, now);
  }

  // Replaces a token that Microsoft just refused. If another caller already refreshed it, that token is used instead.
  async function replacementToken(refused: string): Promise<string> {
    const session = store.read();
    if (session.accessToken && session.accessToken !== refused && tokenIsFresh(session, now())) return session.accessToken;
    return refreshAccessToken(store, now);
  }

  // The tokens in the database must still belong to the account this adapter was built for. A sign in as another
  // account can finish at any moment, and mail must never leave from, or be read as, a different account.
  function assertSameAccount(): void {
    const session = store.read();
    if ((session.address ?? '') !== address) {
      throw new MicrosoftError('rejected', 'The Microsoft account that is signed in changed, so this request was stopped.');
    }
  }

  interface CallOptions {
    query?: Record<string, string>;
    body?: unknown;
    immutable?: boolean;
    // A complete Prefer header, for requests that need more than immutable ids.
    prefer?: string;
    // The request may send mail. A failure to get a token or to confirm the account happens before anything left the
    // process, so the error says nothing was sent.
    sending?: boolean;
    // Runs immediately before the request leaves, after the token and the account were confirmed. Returns the reason to
    // stop, which sends nothing. It runs again before the repeat that follows a 401.
    beforeRequest?: () => string | null;
    // A complete URL taken from a nextLink or deltaLink, checked to be on the Graph host.
    absolute?: URL;
    readOnly?: boolean;
  }

  function trustedLink(link: string): URL {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new MicrosoftError('bad_response', 'Microsoft sent a link this app could not read.');
    }
    if (url.origin !== new URL(graphBaseUrl()).origin) {
      throw new MicrosoftError('bad_response', 'Microsoft sent a link to another host, so it was not followed.');
    }
    return url;
  }

  // 401 handling: Microsoft rejects a stale token before the request reaches any handler, so no mail was accepted. The
  // token is refreshed once and the identical request is sent again. A second 401 is final.
  async function call(method: 'GET' | 'POST', path: string, opts: CallOptions = {}): Promise<RawResponse> {
    if (opts.readOnly && (method !== 'GET' || /\/send$/.test(path))) {
      throw new Error('A read only Graph call must not reach a send endpoint.');
    }
    let url: URL;
    if (opts.absolute) url = opts.absolute;
    else {
      url = new URL(`${graphBaseUrl()}/v1.0${path}`);
      for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
    }
    const send = async (token: string): Promise<RawResponse> =>
      graphFetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(opts.prefer ? { prefer: opts.prefer } : opts.immutable ? { prefer: immutableIds } : {}),
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    const beforeSend = <T>(work: () => Promise<T>): Promise<T> =>
      opts.sending
        ? work().catch((error: unknown) => {
            if (error instanceof MailProviderError) {
              throw new MicrosoftError(error.kind, `${error.message} The message was not sent.`, error.status, { sentNothing: true });
            }
            throw error;
          })
        : work();
    // Getting a token can take a refresh round trip, and a sign in as another account can finish inside it. The
    // expected address is therefore checked before the token is requested and again once it is in hand, and the
    // request goes out only if the stored account is still the one this adapter was built for.
    const tokenFor = (work: () => Promise<string>): Promise<string> =>
      beforeSend(async () => {
        assertSameAccount();
        const resolved = await work();
        assertSameAccount();
        return resolved;
      });
    const leave = async (usedToken: string): Promise<RawResponse> => {
      const refusal = opts.beforeRequest?.() ?? null;
      if (refusal) throw new MicrosoftError('rejected', `${refusal} The message was not sent.`, null, { sentNothing: true });
      return send(usedToken);
    };
    let token = await tokenFor(accessToken);
    let response = await leave(token);
    if (response.status === 401) {
      const refused = token;
      token = await tokenFor(() => replacementToken(refused));
      response = await leave(token);
    }
    return response;
  }

  const readJson = async (path: string, query?: Record<string, string>, immutable = false): Promise<unknown> => {
    const response = await call('GET', path, { readOnly: true, immutable, ...(query ? { query } : {}) });
    const failure = statusError(response, 'read', secretsOf());
    if (failure) throw failure;
    if (response.unreadable) {
      throw new MicrosoftError(response.timedOutReading ? 'timeout' : 'bad_response', 'Microsoft sent a response this app could not read.', response.status);
    }
    return response.json;
  };

  // -------------------------------------------------------------------------------------------------------------
  // Submit

  function composeDraft(intent: MailIntent): unknown {
    for (const [name, value] of [
      ['recipient', intent.to],
      ['subject', intent.subject],
      ['intent id', intent.intentId],
    ] as const) {
      if (noLineBreak.test(value)) {
        throw new MicrosoftError('rejected', `The ${name} of this message contains a line break, so it was not sent.`, null, { sentNothing: true });
      }
    }
    return {
      subject: intent.subject,
      body: { contentType: 'text', content: intent.body },
      toRecipients: [{ emailAddress: { address: intent.to } }],
      // "from" is left out on purpose: the account sends as itself, so a message cannot be sent as someone else.
      internetMessageHeaders: [{ name: introHeaderName, value: intent.intentId }],
    };
  }

  // Looks for the drafts this intent created, by the header they carry, newest first, with what each would send.
  // Read only.
  async function findDraftsByIntent(intentId: string): Promise<{ draft: DraftRef; content: DraftContent | null }[]> {
    const json = await readJson(
      '/me/mailFolders/drafts/messages',
      { $top: '50', $select: `id,internetMessageId,conversationId,internetMessageHeaders,${draftContentSelect}`, $orderby: 'createdDateTime desc' },
      true,
    );
    const items = isRecord(json) && Array.isArray(json.value) ? json.value.filter(isRecord) : [];
    const found: { draft: DraftRef; content: DraftContent | null }[] = [];
    for (const item of items) {
      const mine = headerList(item.internetMessageHeaders).some((header) => header.name.toLowerCase() === introHeaderName && header.value.trim() === intentId);
      const draft = mine ? parseDraft(item) : null;
      if (draft) found.push({ draft, content: readDraftContent(item) });
    }
    return found;
  }

  function persist(draft: DraftRef, hooks: SubmitHooks | undefined): void {
    let saved = false;
    try {
      saved = hooks?.saveDraft?.({ draftId: draft.id, internetMessageId: draft.internetMessageId }) ?? false;
    } catch {
      saved = false;
    }
    if (!saved) {
      // The draft exists in Outlook but its id could not be saved, so nothing is sent. The draft is left behind.
      throw new MicrosoftError('rejected', 'The draft id could not be saved, so the message was not sent. A draft may remain in Outlook drafts.', null, { sentNothing: true });
    }
  }

  // Step one: make sure a draft exists and its id is saved. Creating a draft never sends anything, so every failure
  // here ends the intent as failed with nothing sent. A lost answer is settled by scanning the drafts folder for our
  // header: a draft that carries it AND still holds exactly the approved message is adopted. A draft that carries it
  // but was edited is never adopted: it is left alone and noted. Nothing adopted allows ONE more create. A stray draft
  // left by a lost answer is harmless: only the draft whose id is saved on the intent is ever sent, and an unsent
  // draft emails nobody.
  async function ensureDraft(intent: MailIntent, hooks: SubmitHooks | undefined): Promise<DraftRef> {
    if (intent.providerDraftId) {
      return { id: intent.providerDraftId, internetMessageId: intent.messageIdHeader, conversationId: null };
    }
    const body = composeDraft(intent);
    let lastError: MicrosoftError | null = null;
    let strayEdited = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let created: DraftRef | null = null;
      let failure: MicrosoftError | null = null;
      try {
        const response = await call('POST', '/me/messages', { sending: true, immutable: true, body });
        failure = statusError(response, 'send', secretsOf());
        if (!failure) {
          created = response.unreadable ? null : parseDraft(response.json);
          if (!created) failure = new MicrosoftError('bad_response', 'Outlook answered the draft request without a draft id.', response.status);
        }
      } catch (error) {
        if (!(error instanceof MailProviderError)) throw error;
        failure = error instanceof MicrosoftError ? error : new MicrosoftError(error.kind, error.message, error.status);
      }
      if (created) {
        persist(created, hooks);
        return created;
      }
      lastError = failure;
      // A definitive refusal means no draft was made. Anything else may have made one.
      if (failure && (failure.kind === 'unauthorized' || failure.kind === 'rejected')) break;
      let candidates: { draft: DraftRef; content: DraftContent | null }[] = [];
      try {
        candidates = await findDraftsByIntent(intent.intentId);
      } catch (scanError) {
        if (scanError instanceof MailProviderError) {
          lastError = new MicrosoftError(scanError.kind, scanError.message, scanError.status);
          break;
        }
        throw scanError;
      }
      const adoptable = candidates.find((candidate) => draftMatchesIntent(candidate.content, intent));
      if (adoptable) {
        persist(adoptable.draft, hooks);
        return adoptable.draft;
      }
      if (candidates.length > 0 && !strayEdited) {
        strayEdited = true;
        try {
          hooks?.noteStrayDraft?.({ draftId: candidates[0]!.draft.id });
        } catch {
          // The note is only a record. It never decides whether a message is sent.
        }
      }
    }
    const reason = lastError ? lastError.message : 'The draft could not be created.';
    const stray = strayEdited ? ' A draft in Outlook was edited after approval and was left alone.' : '';
    throw new MicrosoftError(lastError?.kind ?? 'unavailable', `${reason} The message was not sent. A draft may remain in Outlook drafts.${stray}`, lastError?.status ?? null, {
      sentNothing: true,
      retryAfterMilliseconds: lastError?.retryAfterMilliseconds ?? null,
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reconcile helpers

  // The id of a well known folder, read once per adapter and kept.
  const folderIds = new Map<string, string>();
  async function folderId(name: 'drafts' | 'sentitems' | 'outbox'): Promise<string> {
    const known = folderIds.get(name);
    if (known) return known;
    const json = await readJson(`/me/mailFolders/${name}`, { $select: 'id' }, true);
    const id = isRecord(json) ? text(json.id) : null;
    if (!id) throw new MicrosoftError('bad_response', 'Microsoft sent a folder without an id.');
    folderIds.set(name, id);
    return id;
  }

  async function findInSentItems(internetMessageId: string): Promise<DraftRef | null> {
    const json = await readJson(
      '/me/mailFolders/sentitems/messages',
      { $filter: `internetMessageId eq ${odataString(internetMessageId)}`, $top: '1', $select: 'id,internetMessageId,conversationId' },
      true,
    );
    const first = isRecord(json) && Array.isArray(json.value) ? json.value.find(isRecord) : undefined;
    return first ? parseDraft(first) : null;
  }

  function unavailable(error: unknown): ReconcileResult {
    if (error instanceof MailProviderError) return { outcome: 'unavailable', error };
    return { outcome: 'unavailable', error: new MailProviderError('unavailable', 'The check failed in an unexpected way.') };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Inbound

  async function bounceEvidence(id: string): Promise<{ evidence: string; action: string | null; references: string[]; inReplyTo: string | null }> {
    const pieces: string[] = [];
    const actions: string[] = [];
    const headersJson = await readJson(`/me/messages/${encodeURIComponent(id)}`, { $select: 'internetMessageHeaders' }, true);
    const headers = isRecord(headersJson) ? headerList(headersJson.internetMessageHeaders) : [];
    const referencesHeader = headers.find((header) => header.name.toLowerCase() === 'references')?.value ?? '';
    const inReplyTo = headers.find((header) => header.name.toLowerCase() === 'in-reply-to')?.value ?? null;
    const list = await readJson(`/me/messages/${encodeURIComponent(id)}/attachments`, { $top: String(maxEvidenceAttachments) }, true);
    const attachments = isRecord(list) && Array.isArray(list.value) ? list.value.filter(isRecord).slice(0, maxEvidenceAttachments) : [];
    for (const attachment of attachments) {
      const type = String(attachment.contentType ?? '').toLowerCase();
      const size = typeof attachment.size === 'number' ? attachment.size : 0;
      if (size > maxEvidenceCharacters) continue;
      let content: string | null = null;
      if (typeof attachment.contentBytes === 'string') {
        content = Buffer.from(attachment.contentBytes, 'base64').toString('utf8');
        if (type === 'message/delivery-status') for (const match of content.matchAll(actionLine)) actions.push(match[1]!.toLowerCase());
      } else if (text(attachment.id) && String(attachment['@odata.type'] ?? '').toLowerCase().includes('itemattachment')) {
        // An attached message: its whole MIME text holds the original headers.
        const raw = await call('GET', `/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(String(attachment.id))}/$value`, { readOnly: true, immutable: true });
        const failure = statusError(raw, 'read', secretsOf());
        if (failure) throw failure;
        content = raw.rawText.slice(0, maxEvidenceCharacters);
        const status = /content-type:\s*message\/delivery-status/i.exec(content);
        if (status) for (const match of content.slice(status.index).matchAll(actionLine)) actions.push(match[1]!.toLowerCase());
      }
      if (content) pieces.push(content);
    }
    return {
      evidence: clipText(pieces.join('\n')),
      action: deliveryActionOf(actions),
      references: referencesHeader.split(/\s+/).filter(Boolean),
      inReplyTo,
    };
  }

  function startUrl(atIso: string): URL {
    const url = new URL(`${graphBaseUrl()}/v1.0/me/mailFolders/inbox/messages/delta`);
    url.searchParams.set('$select', messageSelect);
    url.searchParams.set('$filter', `receivedDateTime ge ${atIso}`);
    return url;
  }

  const gapNote =
    'Outlook could not continue the inbox sync from the saved position, so it started again from now. Replies that arrived in between may not be shown here.';

  async function listFrom(cursor: string | null, listOptions: ListInboundOptions, restarted = false): Promise<InboundBatch> {
    const parsed = cursor ? parseCursor(cursor) : null;
    let url: URL =
      parsed && parsed.kind !== 'start' ? trustedLink(parsed.link) : startUrl(parsed && parsed.kind === 'start' ? parsed.at : new Date(now()).toISOString());
    const collected: NormalizedInbound[] = [];
    for (let page = 1; ; page += 1) {
      let response: RawResponse;
      try {
        // Every page carries the preferences again, because a next link or delta link does not remember them.
        response = await call('GET', '', { readOnly: true, absolute: url, prefer: `${immutableIds}, odata.maxpagesize=${deltaPageSize}` });
      } catch (error) {
        if (collected.length > 0) return { messages: collected, nextCursor: null, more: false, failure: error };
        throw error;
      }
      if (isResync(response) && !restarted) {
        // The saved position is gone. Start again from now, keep what this call already collected, and say so.
        const again = await listFrom(startCursor(new Date(now()).toISOString()), listOptions, true);
        return { ...again, messages: [...collected, ...again.messages], reset: { note: gapNote } };
      }
      const failure = statusError(response, 'read', secretsOf());
      const failed = failure ?? (response.unreadable ? new MicrosoftError(response.timedOutReading ? 'timeout' : 'bad_response', 'Microsoft sent a response this app could not read.', response.status) : null);
      if (failed) {
        if (collected.length > 0) return { messages: collected, nextCursor: null, more: false, failure: failed };
        throw failed;
      }
      const json = isRecord(response.json) ? response.json : {};
      const records = Array.isArray(json.value) ? json.value : [];
      for (const raw of records) {
        const normalized = normalizeGraphMessage(raw, new Date(now()).toISOString());
        if (!normalized) continue;
        if (listOptions.isKnown(normalized.providerMessageId)) continue;
        const senderAddress = (/<([^<>]+)>/.exec(normalized.from)?.[1] ?? normalized.from).trim();
        if (automatedSender.test(senderAddress)) {
          const budget = listOptions.evidenceBudget;
          if (budget && budget.remaining <= 0) {
            // This poll has fetched enough reports. The rest are not stored yet, so the next poll reads them again.
            return { messages: collected, nextCursor: null, more: false, deferred: true };
          }
          if (budget) budget.remaining -= 1;
          const failureKey = `microsoft:${address}:${normalized.providerMessageId}`;
          try {
            const found = await bounceEvidence(normalized.providerMessageId);
            clearFetchFailure(failureKey);
            normalized.evidenceText = found.evidence;
            normalized.deliveryAction = found.action;
            normalized.references = found.references;
            normalized.inReplyTo = found.inReplyTo;
          } catch (error) {
            const gone = error instanceof MicrosoftError && error.kind === 'not_found';
            if (gone) {
              clearFetchFailure(failureKey);
              continue;
            }
            const transient = !(error instanceof MicrosoftError) || error.kind !== 'unauthorized';
            if (!transient || noteFetchFailure(failureKey)) {
              return { messages: collected, nextCursor: null, more: false, failure: error };
            }
            // Tried on several polls in a row: the report is stored without its attachments. Without them it cannot
            // match a message the app sent, so it stays an ordinary inbound message.
          }
        }
        collected.push(normalized);
      }
      const delta = text(json['@odata.deltaLink']);
      const next = text(json['@odata.nextLink']);
      if (delta) {
        trustedLink(delta);
        return { messages: collected, nextCursor: `delta:${delta}`, more: false };
      }
      if (!next) throw new MicrosoftError('bad_response', 'Microsoft ended the inbox feed without a next link or a delta link.', response.status);
      url = trustedLink(next);
      if (page >= maxDeltaPages) {
        // Enough requests for one call. What was read is stored by the caller, and the next call continues from here.
        return { messages: collected, nextCursor: `next:${url.toString()}`, more: true };
      }
    }
  }

  // Step two: send the draft whose id is saved. A 2xx (Graph answers 202) is the only success. A refusal before
  // processing (a 4xx) is definitive; a timeout, 5xx or 429 may or may not have taken effect and is settled by
  // reconcileUnknown.
  async function sendDraft(draft: DraftRef, hooks: SubmitHooks | undefined): Promise<{ messageId: string; threadId: string | null }> {
    const beforeSend = hooks?.beforeSend;
    // Without the caller's last check nothing is sent.
    if (!beforeSend) throw new MicrosoftError('rejected', 'The message could not be checked once more before sending, so it was not sent.', null, { sentNothing: true });
    const response = await call('POST', `/me/messages/${encodeURIComponent(draft.id)}/send`, { sending: true, immutable: true, beforeRequest: beforeSend });
    if (response.status >= 200 && response.status < 300) {
      return { messageId: draft.internetMessageId ?? draft.id, threadId: draft.conversationId };
    }
    if (response.status === 404) {
      // The draft is gone. It may have been sent by an earlier attempt, so this is not a refusal.
      throw new MicrosoftError('unavailable', 'Outlook could not find the draft when sending it. It may already have gone out.', 404);
    }
    const failure = statusError(response, 'send', secretsOf());
    throw failure ?? new MicrosoftError('unexpected_status', `Microsoft answered the send with an unexpected status (HTTP ${response.status}).`, response.status);
  }

  return {
    kind: 'microsoft',
    label: 'Microsoft',
    duplicateProtection: 'draft_first',

    async submit(intent: MailIntent, hooks?: SubmitHooks) {
      const draft = await ensureDraft(intent, hooks);
      try {
        return await sendDraft(draft, hooks);
      } catch (error) {
        // A refusal after the draft exists leaves the draft behind. Say so, because nothing was sent.
        if (error instanceof MicrosoftError && error.definitive && !error.message.includes('draft may remain')) {
          throw new MicrosoftError(error.kind, `${error.message} A draft may remain in Outlook drafts.`, error.status, { sentNothing: error.sentNothing });
        }
        throw error;
      }
    },

    // Reads the draft whose id was saved before the send.
    //  - No longer a draft: accepted only when it sits in Sent Items (or Outbox, while Outlook hands it over). Anywhere
    //    else (Deleted Items, an archive) Sent Items is searched by the saved internetMessageId, and a message found
    //    nowhere there keeps the intent unknown for a person to look at.
    //  - Still a draft: the send never took effect. THIS IS THE ONE PLACE A RECONCILE CAN SEND. Sending the same draft
    //    again cannot produce a second email: a draft that was already sent is no longer a draft and cannot be sent
    //    again, and the draft id is the only thing ever sent. It is done only when options.mayResend says every guard
    //    of a first send still passes and enough time has passed since the last attempt, the draft is in the Drafts
    //    folder, what it would send is still exactly the approved message, and options.beforeResend, called right
    //    before the request, agrees. An edited draft is never sent.
    //  - 404 on the draft id: checks Sent Items for the saved internetMessageId before giving up.
    //  - No saved draft id: the send step was never reached (the id is saved before it), so there is nothing to check.
    async reconcileUnknown(intent: MailIntent, reconcileOptions?: ReconcileOptions): Promise<ReconcileResult> {
      if (!intent.providerDraftId) return { outcome: 'not_found' };
      const draftId = intent.providerDraftId;
      const path = `/me/messages/${encodeURIComponent(draftId)}`;
      // Set when the caller's last check, or the account check, stopped the request. Nothing was sent then.
      let stoppedBeforeSending = false;
      const missingFromDraftId = async (): Promise<ReconcileResult> => {
        const stored = intent.messageIdHeader;
        if (!stored) return { outcome: 'not_found' };
        const sent = await findInSentItems(stored);
        return sent ? { outcome: 'accepted', messageId: sent.internetMessageId ?? stored, threadId: sent.conversationId } : { outcome: 'not_found' };
      };
      try {
        const response = await call('GET', path, {
          readOnly: true,
          immutable: true,
          query: { $select: 'id,isDraft,parentFolderId,internetMessageId,conversationId' },
        });
        if (response.status === 404) return await missingFromDraftId();
        const failure = statusError(response, 'read', secretsOf());
        if (failure) throw failure;
        if (response.unreadable || !isRecord(response.json) || typeof response.json.isDraft !== 'boolean') {
          throw new MicrosoftError('bad_response', 'Microsoft sent a draft status this app could not read.', response.status);
        }
        const json = response.json;
        const messageId = text(json.internetMessageId) ?? intent.messageIdHeader ?? draftId;
        const threadId = text(json.conversationId);
        const parentFolderId = text(json.parentFolderId);
        if (json.isDraft === false) {
          // No longer being a draft does not by itself mean it went out: a draft can be moved or deleted.
          const sentItemsId = await folderId('sentitems');
          const outboxId = await folderId('outbox');
          if (parentFolderId && (parentFolderId === sentItemsId || parentFolderId === outboxId)) return { outcome: 'accepted', messageId, threadId };
          const lookup = text(json.internetMessageId) ?? intent.messageIdHeader;
          const sent = lookup ? await findInSentItems(lookup) : null;
          if (sent) return { outcome: 'accepted', messageId: sent.internetMessageId ?? lookup ?? messageId, threadId: sent.conversationId ?? threadId };
          return { outcome: 'needs_person', reason: 'not_in_sent_items', sentence: notInSentItemsSentence };
        }

        // Still a draft.
        if (!reconcileOptions?.mayResend || !reconcileOptions.beforeResend) return { outcome: 'not_found' };
        const draftsFolderId = await folderId('drafts');
        if (!parentFolderId || parentFolderId !== draftsFolderId) return { outcome: 'not_found' };
        // Read what would be sent as late as possible, and compare it with the approved message.
        const fresh = await call('GET', path, {
          readOnly: true,
          immutable: true,
          query: { $select: `id,isDraft,parentFolderId,${draftContentSelect}` },
        });
        if (fresh.status === 404) return await missingFromDraftId();
        const freshFailure = statusError(fresh, 'read', secretsOf());
        if (freshFailure) throw freshFailure;
        if (fresh.unreadable || !isRecord(fresh.json) || typeof fresh.json.isDraft !== 'boolean') {
          throw new MicrosoftError('bad_response', 'Microsoft sent a draft this app could not read.', fresh.status);
        }
        if (fresh.json.isDraft !== true || text(fresh.json.parentFolderId) !== draftsFolderId) return { outcome: 'not_found' };
        if (!draftMatchesIntent(readDraftContent(fresh.json), intent)) {
          return { outcome: 'needs_person', reason: 'draft_changed', sentence: draftChangedSentence };
        }
        // Not marked as "sending": a failure to get a token here is a failed check that can be tried again, not a
        // refusal. The read just above already proved the token works.
        const beforeResend = reconcileOptions.beforeResend;
        const resend = await call('POST', `${path}/send`, {
          immutable: true,
          beforeRequest: () => {
            const reason = beforeResend();
            if (reason) stoppedBeforeSending = true;
            return reason;
          },
        });
        if (resend.status >= 200 && resend.status < 300) return { outcome: 'accepted', messageId, threadId };
        if (resend.status === 404) {
          // Gone between the read and the send: it may have just been sent. Check Sent Items again.
          const sent = await findInSentItems(messageId);
          return sent ? { outcome: 'accepted', messageId: sent.internetMessageId ?? messageId, threadId: sent.conversationId ?? threadId } : { outcome: 'not_found' };
        }
        const resendFailure = statusError(resend, 'send', secretsOf());
        throw resendFailure ?? new MicrosoftError('unexpected_status', `Microsoft answered the send with an unexpected status (HTTP ${resend.status}).`, resend.status);
      } catch (error) {
        if (stoppedBeforeSending) return { outcome: 'not_found' };
        return unavailable(error);
      }
    },

    async listInbound(cursor: string | null, listOptions: ListInboundOptions): Promise<InboundBatch> {
      return listFrom(cursor, listOptions);
    },

    async checkAccount() {
      assertSameAccount();
      const token = await accessToken();
      assertSameAccount();
      return { address: (await fetchMicrosoftProfile(token)).address };
    },
  };
}

// Used by the OAuth callback, before the tokens are saved.
export async function fetchMicrosoftProfile(accessTokenValue: string): Promise<MicrosoftProfile> {
  const url = new URL(`${graphBaseUrl()}/v1.0/me`);
  url.searchParams.set('$select', 'mail,userPrincipalName,displayName');
  const response = await graphFetch(url, { method: 'GET', headers: { authorization: `Bearer ${accessTokenValue}`, accept: 'application/json' } });
  const failure = statusError(response, 'read', [accessTokenValue]);
  if (failure) throw failure;
  return parseProfile(response.json);
}

