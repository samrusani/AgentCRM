import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { apiPort } from '../config.js';
import { AppError, notFound } from '../errors.js';
import { reasonCodes } from '../mail/rules.js';
import { MailProviderError } from '../providers/mailTypes.js';
import {
  buildMicrosoftAuthorizationUrl,
  clientRejectedSentence,
  createPkce,
  createState,
  exchangeMicrosoftCode,
  fetchMicrosoftProfile,
  grantedScopeNames,
  type MicrosoftSession,
  type MicrosoftTokenStore,
  microsoftScopes,
  publicClientSentence,
  readPermissionSentence,
  requiredMicrosoftScopes,
  signInExpiredSentence,
  startCursor,
} from '../providers/microsoft.js';
import { getConnector, getMicrosoftInternals, type MicrosoftConnector, readGmailPending } from '../queries/connectors.js';
import { getActiveMailConnector } from '../queries/mailProvider.js';
import { type ActionContext, mutate, parseInput, type Tx } from './context.js';
import { type OAuthCallbackQuery, type OAuthOutcome, oauthPendingMaxAgeMilliseconds } from './gmailConnector.js';
import { activateMailProviderIfUnsetIn, reassignMailProviderAfterRemovalIn } from './mailProvider.js';
import { stopRulesForProviderIn } from './followupRules.js';
import { blockWaitingIntentsIn, resumeReconcilesIn, transitionIntentIn } from './sendIntentState.js';

export const microsoftNotSignedInMessage = 'Microsoft is not signed in. Sign in with Microsoft in Settings first.';
export const microsoftSignInMessageFor: Record<string, string> = {
  state_mismatch: 'That Microsoft sign in could not be matched to a request made here, so it was refused. Start the sign in again.',
  expired: 'The Microsoft sign in took more than 15 minutes, so it was refused. Start the sign in again.',
  access_denied: 'Microsoft sign in was cancelled. Start the sign in again when you are ready.',
  microsoft_error: 'Microsoft ended the sign in with an error. Start the sign in again.',
  missing_code: 'Microsoft did not send a sign in code. Start the sign in again.',
  exchange_failed: 'Microsoft did not accept the sign in. Check the application (client) id, then start the sign in again.',
  missing_permissions: 'Microsoft needs both permissions, reading and sending mail. Start the sign in again and allow both.',
  profile_failed: 'Signed in, but the Microsoft account could not be read. Start the sign in again.',
  no_connector: 'Save the application (client) id before signing in.',
};

// Microsoft matches the loopback host name localhost for a Mobile and desktop redirect and ignores the port.
export const microsoftOAuthCallbackPath = '/api/connectors/microsoft/oauth/callback';

export function microsoftRedirectUri(): string {
  return `http://localhost:${apiPort()}${microsoftOAuthCallbackPath}`;
}

const configureSchema = z
  .object({
    clientId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => !/\s/.test(value), 'Must not contain spaces'),
  })
  .strict();

interface RawConnectorRow {
  id: string;
  status: 'connected' | 'error';
  settings: string;
  secret: string;
  updated_at: string;
}

type Current = { row: RawConnectorRow; settings: Record<string, unknown>; secret: Record<string, unknown> };

function readRow(tx: Tx): Current | null {
  const row = tx.db
    .prepare("SELECT id, status, settings, secret, updated_at FROM connector WHERE workspace_id = ? AND kind = 'microsoft'")
    .get(tx.workspaceId) as RawConnectorRow | undefined;
  if (!row) return null;
  const parse = (value: string): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  return { row, settings: parse(row.settings), secret: parse(row.secret) };
}

interface Patch {
  settings?: Record<string, unknown>;
  secret?: Record<string, unknown>;
  status?: 'connected' | 'error';
  // Bumps updated_at. Token refreshes and cursor writes do not, because they carry no decision.
  touch?: boolean;
  // Keys to remove from settings.
  drop?: string[];
}

function writeIn(tx: Tx, current: Current, patch: Patch): void {
  const settings = { ...current.settings, ...(patch.settings ?? {}) };
  for (const key of patch.drop ?? []) delete settings[key];
  const secret = { ...current.secret, ...(patch.secret ?? {}) };
  tx.db
    .prepare('UPDATE connector SET settings = ?, secret = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(
      JSON.stringify(settings),
      JSON.stringify(secret),
      patch.status ?? current.row.status,
      patch.touch ? tx.now() : current.row.updated_at,
      current.row.id,
    );
}

// Saves the application (client) id. No network call: it is checked when someone signs in with it. The row exists
// before sign in, so the card can tell "id saved" from "nothing saved". There is no client secret.
export function configureMicrosoftConnector(ctx: ActionContext, input: unknown): { connector: MicrosoftConnector; created: boolean } {
  const data = parseInput(configureSchema, input);
  const created = mutate(ctx, (tx) => {
    const current = readRow(tx);
    if (!current) {
      const id = tx.newId('con');
      const now = tx.now();
      tx.db
        .prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES (?, ?, ?, 'microsoft', ?, ?, 'connected', ?)")
        .run(id, now, tx.workspaceId, JSON.stringify({ clientId: data.clientId, emailAddress: null, deltaLink: null, lastSyncAt: null, lastSyncError: null }), '{}', now);
      tx.audit('connector.configure', 'connector', id, { kind: 'microsoft', clientIdReplaced: true });
      return true;
    }
    const previousClientId = typeof current.settings.clientId === 'string' ? current.settings.clientId : null;
    const clientChanged = data.clientId !== previousClientId;
    const settingsPatch: Record<string, unknown> = { clientId: data.clientId };
    const secretPatch: Record<string, unknown> = {};
    const drop = ['pending'];
    let status = current.row.status;
    if (clientChanged) {
      // Tokens belong to the app registration that issued them. A different id means signing in again, and messages
      // that were approved to leave from the old sign in are blocked rather than sent from a new one.
      const oldAddress = typeof current.settings.emailAddress === 'string' ? current.settings.emailAddress : null;
      if (oldAddress) blockWaitingIntentsIn(tx, { provider: 'microsoft' }, reasonCodes.connectorRemoved);
      Object.assign(settingsPatch, { emailAddress: null, deltaLink: null, lastSyncAt: null, lastSyncError: null });
      Object.assign(secretPatch, { accessToken: null, refreshToken: null, expiresAt: null });
      drop.push('statusMessage', 'errorKind', 'oauthCompletedAt');
      status = 'connected';
    }
    writeIn(tx, current, { settings: settingsPatch, secret: secretPatch, status, touch: true, drop });
    tx.audit('connector.configure', 'connector', current.row.id, { kind: 'microsoft', clientIdReplaced: clientChanged, signedOut: clientChanged });
    return false;
  });
  return { connector: getConnector(ctx.db, ctx.workspaceId, 'microsoft')!, created };
}

const loopbackOrigin = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/;

// Builds the Microsoft consent URL and saves the pending state and PKCE verifier. returnOrigin is the browser page that
// asked for the sign in; the callback sends the browser back there when it is a loopback origin.
export function startMicrosoftOAuth(ctx: ActionContext, options: { returnOrigin?: string | null } = {}): { url: string } {
  const internals = getMicrosoftInternals(ctx.db, ctx.workspaceId);
  const clientId = typeof internals?.settings.clientId === 'string' ? internals.settings.clientId : null;
  if (!internals || !clientId) {
    throw new AppError('conflict', 'Save the application (client) id first, then sign in with Microsoft.');
  }
  const { verifier, challenge } = createPkce();
  const state = createState();
  const returnOrigin = options.returnOrigin && loopbackOrigin.test(options.returnOrigin) ? options.returnOrigin : null;
  mutate(ctx, (tx) => {
    const current = readRow(tx);
    if (!current) throw notFound('Microsoft connector');
    writeIn(tx, current, { settings: { pending: { state, verifier, createdAt: tx.now(), returnOrigin } } });
    tx.audit('connector.oauth_start', 'connector', current.row.id, { kind: 'microsoft', scopes: microsoftScopes.length });
  });
  return { url: buildMicrosoftAuthorizationUrl({ clientId, redirectUri: microsoftRedirectUri(), state, challenge }) };
}

function equalStrings(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface MicrosoftCallbackQuery extends OAuthCallbackQuery {
  errorDescription?: string | undefined;
}

function redirectFor(origin: string | null, errorCode: string | null): string {
  const base = `${origin ?? ''}/settings/connectors`;
  return errorCode ? `${base}?microsoft_error=${encodeURIComponent(errorCode)}` : base;
}

// Records why a sign in failed, as a sentence on the connector. updated_at moves so the Settings card sees that the
// sign in ended. Status stays as it was: a failed attempt does not sign out an account that was working.
function recordFailure(ctx: ActionContext, code: string, detail?: string): void {
  mutate(ctx, (tx) => {
    const current = readRow(tx);
    if (!current) return;
    writeIn(tx, current, {
      settings: { statusMessage: detail ?? microsoftSignInMessageFor[code] ?? microsoftSignInMessageFor.microsoft_error },
      touch: true,
    });
    tx.audit('connector.oauth_failed', 'connector', current.row.id, { kind: 'microsoft', code });
  });
}

function safeErrorCode(value: string | undefined): string {
  const cleaned = (value ?? '').toLowerCase().replace(/[^a-z_]/g, '').slice(0, 40);
  return cleaned === 'access_denied' ? 'access_denied' : 'microsoft_error';
}

// Microsoft's own sentence from the callback: its first line, which holds the AADSTS code and the explanation. The
// trace lines after it are left out. A person who pressed Cancel gets the plain sentence instead.
function microsoftSentence(error: string | undefined, description: string | undefined): string | undefined {
  const first = (description ?? '').split(/\r?\n/)[0]?.trim() ?? '';
  if (first === '') return undefined;
  if (error === 'access_denied' && /AADSTS65004|declined|cancel/i.test(first)) return undefined;
  return first.slice(0, 600);
}

// The callback Microsoft redirects the browser to. State is checked and consumed before anything goes to the network,
// so a repeated or forged callback cannot sign anything in.
export async function completeMicrosoftOAuth(ctx: ActionContext, query: MicrosoftCallbackQuery): Promise<OAuthOutcome> {
  const fail = (code: string, origin: string | null, detail?: string): OAuthOutcome => {
    recordFailure(ctx, code, detail);
    return { redirect: redirectFor(origin, code), ok: false, errorCode: code };
  };
  const internals = getMicrosoftInternals(ctx.db, ctx.workspaceId);
  if (!internals) return { redirect: redirectFor(null, 'no_connector'), ok: false, errorCode: 'no_connector' };
  const pending = readGmailPending(internals.settings);
  const supplied = query.state ?? '';
  if (!pending || supplied === '' || !equalStrings(pending.state, supplied)) {
    // A callback that cannot be matched to a sign in started here records nothing: no sentence, no change to the
    // connector, no audit row. Anyone who can reach the loopback port could send one, so it must not be able to
    // overwrite a status or make the card think a sign in ended. A pending request is left alone for the same reason.
    return { redirect: redirectFor(null, 'state_mismatch'), ok: false, errorCode: 'state_mismatch' };
  }
  const origin = pending.returnOrigin;
  // The request is used once. Whatever happens next, it cannot be replayed.
  mutate(ctx, (tx) => {
    const current = readRow(tx);
    if (current) writeIn(tx, current, { drop: ['pending'] });
  });
  if (Date.parse(ctx.now()) - Date.parse(pending.createdAt) > oauthPendingMaxAgeMilliseconds) return fail('expired', origin);
  if (query.error) return fail(safeErrorCode(query.error), origin, microsoftSentence(query.error.toLowerCase(), query.errorDescription));
  if (!query.code) return fail('missing_code', origin);
  const clientId = typeof internals.settings.clientId === 'string' ? internals.settings.clientId : null;
  if (!clientId) return fail('no_connector', origin);

  let tokens;
  try {
    tokens = await exchangeMicrosoftCode({
      clientId,
      code: query.code,
      verifier: pending.verifier,
      redirectUri: microsoftRedirectUri(),
      now: () => Date.parse(ctx.now()),
    });
  } catch (error) {
    // Microsoft's refusal sentences (including the public client one) are already plain, so they are shown as they are.
    const plain = error instanceof MailProviderError && (error.message === publicClientSentence || error.message === clientRejectedSentence);
    return fail('exchange_failed', origin, plain ? error.message : error instanceof MailProviderError ? `${microsoftSignInMessageFor.exchange_failed} (${error.message})` : undefined);
  }
  if (tokens.scopes) {
    const granted = grantedScopeNames(tokens.scopes);
    if (!requiredMicrosoftScopes.every((scope) => granted.includes(scope))) return fail('missing_permissions', origin);
  }

  let profile;
  try {
    profile = await fetchMicrosoftProfile(tokens.accessToken);
  } catch (error) {
    if (error instanceof MailProviderError && error.kind === 'unauthorized') return fail('missing_permissions', origin, readPermissionSentence);
    return fail('profile_failed', origin);
  }

  mutate(ctx, (tx) => {
    const current = readRow(tx);
    if (!current) throw notFound('Microsoft connector');
    const previousAddress = typeof current.settings.emailAddress === 'string' ? current.settings.emailAddress : null;
    const sameAccount = previousAddress === profile.address;
    const previousCursor = typeof current.settings.deltaLink === 'string' ? current.settings.deltaLink : null;
    if (previousAddress && !sameAccount) {
      blockWaitingIntentsIn(tx, { inboxId: previousAddress, provider: 'microsoft' }, 'The sending inbox changed after this message was approved.');
    }
    writeIn(tx, current, {
      settings: {
        // Only a finished sign in sets this. The Settings card waits for it to change, so a failed attempt, which
        // only moves updated_at, can be told apart from a success.
        oauthCompletedAt: tx.now(),
        emailAddress: profile.address,
        // The same account keeps its position, so replies that arrived while signed out are still found. A new
        // account starts from the moment it signed in: nothing before that is read.
        deltaLink: sameAccount && previousCursor ? previousCursor : startCursor(tx.now()),
        lastSyncError: null,
        ...(sameAccount ? {} : { lastSyncAt: null }),
      },
      secret: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt },
      status: 'connected',
      touch: true,
      drop: ['pending', 'statusMessage', 'errorKind'],
    });
    activateMailProviderIfUnsetIn(tx, 'microsoft');
    tx.audit('connector.oauth_complete', 'connector', current.row.id, { kind: 'microsoft', accountChanged: !sameAccount });
    // An account is signed in: messages sent from this address whose outcome was unknown go back to being checked.
    resumeReconcilesIn(tx, 'microsoft', profile.address);
  });
  return { redirect: redirectFor(origin, null), ok: true, errorCode: null };
}

// Queued and approved Microsoft messages become blocked. A message that is being submitted, or whose outcome is
// unknown, keeps its state because the email may already be out. The reason is added to its error text, and the message
// is marked so that its saved draft is never sent again, even after the same account signs in again.
export function disconnectMicrosoftConnector(ctx: ActionContext): void {
  if (!getConnector(ctx.db, ctx.workspaceId, 'microsoft')) throw notFound('Microsoft connector');
  mutate(ctx, (tx) => {
    const row = tx.db.prepare("SELECT id FROM connector WHERE workspace_id = ? AND kind = 'microsoft'").get(tx.workspaceId) as { id: string } | undefined;
    if (!row) throw notFound('Microsoft connector');
    const wasActive = getActiveMailConnector(tx.db, tx.workspaceId)?.kind === 'microsoft';
    const blocked = blockWaitingIntentsIn(tx, { provider: 'microsoft' }, reasonCodes.connectorRemoved);
    stopRulesForProviderIn(tx, { provider: 'microsoft' }, 'connector_changed');
    const inFlight = tx.db
      .prepare("SELECT id, status FROM send_intent WHERE workspace_id = ? AND provider = 'microsoft' AND status IN ('submitting', 'unknown')")
      .all(tx.workspaceId) as { id: string; status: 'submitting' | 'unknown' }[];
    for (const intent of inFlight) {
      transitionIntentIn(tx, intent.id, [intent.status], intent.status, { appendError: reasonCodes.connectorRemoved }, 'connector_removed', {
        reason: reasonCodes.connectorRemoved,
        noResend: true,
      });
      // Time passes while no account is signed in, and nothing guards that gap. Once the same account signs in again, the
      // saved draft is only ever read for this message, never sent again. Switching to another provider does not set
      // this, because the check that the provider is still in use covers that gap.
      tx.db.prepare('UPDATE send_intent SET no_resend = 1 WHERE id = ? AND workspace_id = ?').run(intent.id, tx.workspaceId);
    }
    tx.db.prepare('DELETE FROM connector WHERE id = ?').run(row.id);
    reassignMailProviderAfterRemovalIn(tx, wasActive);
    tx.audit('connector.disconnect', 'connector', row.id, { kind: 'microsoft', intentsBlocked: blocked, intentsInFlight: inFlight.length });
  });
}

// Marks the connector as needing a new sign in. Does nothing when it is already marked, so the first and most specific
// sentence stays.
export function markMicrosoftError(ctx: ActionContext, reason: 'invalid_grant' | 'invalid_client' | 'unauthorized'): void {
  mutate(ctx, (tx) => {
    const current = readRow(tx);
    if (!current || current.row.status === 'error') return;
    const message = reason === 'invalid_client' ? clientRejectedSentence : signInExpiredSentence;
    writeIn(tx, current, { settings: { statusMessage: message, errorKind: reason }, status: 'error', touch: true });
    tx.audit('connector.error', 'connector', current.row.id, { kind: 'microsoft', reason });
  });
}

// Reads and saves tokens for the adapter. Every call reads the database, so a refresh by another path is seen at once.
export function createMicrosoftTokenStore(ctx: ActionContext): MicrosoftTokenStore {
  return {
    key: `${ctx.workspaceId}:microsoft`,
    read(): MicrosoftSession {
      const internals = getMicrosoftInternals(ctx.db, ctx.workspaceId);
      const clientId = typeof internals?.settings.clientId === 'string' ? internals.settings.clientId : null;
      if (!internals || !clientId || !internals.secret.refreshToken) {
        throw new MailProviderError('unauthorized', microsoftNotSignedInMessage);
      }
      const address = typeof internals.settings.emailAddress === 'string' ? internals.settings.emailAddress.toLowerCase() : null;
      return {
        clientId,
        accessToken: internals.secret.accessToken,
        refreshToken: internals.secret.refreshToken,
        expiresAt: internals.secret.expiresAt,
        address,
      };
    },
    // Compare and set. A refresh takes a network round trip, and a sign in can finish inside it. The new account's
    // tokens must never be replaced by tokens that belong to the old one, so nothing is written unless the stored
    // refresh token is still the one this refresh started from. Microsoft rotates the refresh token on every use, so
    // the replacement is written in the same statement as the new access token.
    save(update) {
      return mutate(ctx, (tx) => {
        const current = readRow(tx);
        if (!current || current.secret.refreshToken !== update.startedFromRefreshToken) return false;
        writeIn(tx, current, {
          secret: {
            accessToken: update.accessToken,
            expiresAt: update.expiresAt,
            ...(update.refreshToken ? { refreshToken: update.refreshToken } : {}),
          },
        });
        return true;
      });
    },
    // The same rule for a refusal: a refresh that started from an old refresh token cannot mark a newer sign in.
    invalid(reason, startedFromRefreshToken) {
      const stored = getMicrosoftInternals(ctx.db, ctx.workspaceId)?.secret.refreshToken;
      if (stored !== startedFromRefreshToken) return;
      markMicrosoftError(ctx, reason);
    },
  };
}

export function requireMicrosoftSignedIn(ctx: ActionContext): MicrosoftConnector {
  const connector = getConnector(ctx.db, ctx.workspaceId, 'microsoft');
  if (!connector || !connector.settings.signedIn) throw new AppError('conflict', microsoftNotSignedInMessage);
  return connector;
}
