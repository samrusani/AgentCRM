import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { apiHost, apiPort } from '../config.js';
import { AppError, notFound, validationError } from '../errors.js';
import { reasonCodes } from '../mail/rules.js';
import {
  buildAuthorizationUrl,
  clientRejectedSentence,
  consentExpiredSentence,
  createPkce,
  createState,
  exchangeAuthorizationCode,
  fetchProfileWithToken,
  gmailScopes,
  type GmailSession,
  type GmailTokenStore,
  readPermissionSentence,
} from '../providers/gmail.js';
import { MailProviderError } from '../providers/mailTypes.js';
import { type GmailConnector, getConnector, getGmailInternals, readGmailPending } from '../queries/connectors.js';
import { getActiveMailConnector } from '../queries/mailProvider.js';
import { type ActionContext, mutate, parseInput, type Tx } from './context.js';
import { activateMailProviderIfUnsetIn, reassignMailProviderAfterRemovalIn } from './mailProvider.js';
import { blockWaitingIntentsIn, resumeGmailReconcilesIn, transitionIntentIn } from './sendIntentState.js';

export const gmailNotSignedInMessage = 'Gmail is not signed in. Sign in with Google in Settings first.';
export const gmailSignInMessageFor: Record<string, string> = {
  state_mismatch: 'That Google sign in could not be matched to a request made here, so it was refused. Start the sign in again.',
  expired: 'The Google sign in took more than 15 minutes, so it was refused. Start the sign in again.',
  access_denied: 'Google sign in was cancelled. Start the sign in again when you are ready.',
  google_error: 'Google ended the sign in with an error. Start the sign in again.',
  missing_code: 'Google did not send a sign in code. Start the sign in again.',
  exchange_failed: 'Google did not accept the sign in. Check the client id and client secret, then start the sign in again.',
  missing_permissions: 'Gmail needs both permissions, sending and reading. Start the sign in again and allow both.',
  profile_failed: 'Signed in, but the Gmail account could not be read. Start the sign in again.',
  no_connector: 'Save the client id and client secret before signing in.',
};

// A sign in that is not finished within this time is refused.
export const oauthPendingMaxAgeMilliseconds = 15 * 60 * 1000;

export const oauthCallbackPath = '/api/connectors/gmail/oauth/callback';

export function oauthRedirectUri(): string {
  return `http://${apiHost}:${apiPort()}${oauthCallbackPath}`;
}

const credentialField = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/\s/.test(value), 'Must not contain spaces');

const configureSchema = z.object({ clientId: credentialField(300).optional(), clientSecret: credentialField(300).optional() }).strict();

interface RawConnectorRow {
  id: string;
  status: 'connected' | 'error';
  settings: string;
  secret: string;
  updated_at: string;
}

function readRow(tx: Tx): { row: RawConnectorRow; settings: Record<string, unknown>; secret: Record<string, unknown> } | null {
  const row = tx.db
    .prepare("SELECT id, status, settings, secret, updated_at FROM connector WHERE workspace_id = ? AND kind = 'gmail'")
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

function writeIn(tx: Tx, current: NonNullable<ReturnType<typeof readRow>>, patch: Patch): void {
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

// Saves the OAuth client. No network call: the client is checked when someone signs in with it. The row exists before
// sign in, so the card can tell "credentials saved" from "nothing saved".
export function configureGmailConnector(ctx: ActionContext, input: unknown): { connector: GmailConnector; created: boolean } {
  const data = parseInput(configureSchema, input);
  if (data.clientId === undefined && data.clientSecret === undefined) {
    throw validationError('Send a client id, a client secret, or both.');
  }
  const created = mutate(ctx, (tx) => {
    const current = readRow(tx);
    if (!current) {
      if (!data.clientId || !data.clientSecret) throw validationError('clientId: A client id and a client secret are both required to connect Gmail.');
      const id = tx.newId('con');
      const now = tx.now();
      tx.db
        .prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES (?, ?, ?, 'gmail', ?, ?, 'connected', ?)")
        .run(
          id,
          now,
          tx.workspaceId,
          JSON.stringify({ clientId: data.clientId, emailAddress: null, historyId: null, lastSyncAt: null, lastSyncError: null }),
          JSON.stringify({ clientSecret: data.clientSecret }),
          now,
        );
      tx.audit('connector.configure', 'connector', id, { kind: 'gmail', clientIdReplaced: true, clientSecretReplaced: true });
      return true;
    }
    const previousClientId = typeof current.settings.clientId === 'string' ? current.settings.clientId : null;
    const clientChanged = data.clientId !== undefined && data.clientId !== previousClientId;
    const settingsPatch: Record<string, unknown> = {};
    const secretPatch: Record<string, unknown> = {};
    const drop = ['pending'];
    if (data.clientId !== undefined) settingsPatch.clientId = data.clientId;
    if (data.clientSecret !== undefined) secretPatch.clientSecret = data.clientSecret;
    let status = current.row.status;
    if (clientChanged) {
      // Tokens belong to the client that issued them. A different client means signing in again, and messages that were
      // approved to leave from the old sign in are blocked rather than sent from a new one.
      const oldAddress = typeof current.settings.emailAddress === 'string' ? current.settings.emailAddress : null;
      if (oldAddress) blockWaitingIntentsIn(tx, { provider: 'gmail' }, reasonCodes.connectorRemoved);
      Object.assign(settingsPatch, { emailAddress: null, historyId: null, lastSyncAt: null, lastSyncError: null });
      Object.assign(secretPatch, { accessToken: null, refreshToken: null, expiresAt: null });
      drop.push('statusMessage', 'errorKind');
      status = 'connected';
    } else if (current.row.status === 'error' && current.settings.errorKind === 'invalid_client' && data.clientSecret !== undefined) {
      drop.push('statusMessage', 'errorKind');
      status = 'connected';
    }
    writeIn(tx, current, { settings: settingsPatch, secret: secretPatch, status, touch: true, drop });
    // Back to connected with the same account: unknown messages are checked again.
    if (current.row.status === 'error' && status === 'connected' && typeof current.settings.emailAddress === 'string' && !clientChanged) {
      resumeGmailReconcilesIn(tx, current.settings.emailAddress);
    }
    tx.audit('connector.configure', 'connector', current.row.id, {
      kind: 'gmail',
      clientIdReplaced: data.clientId !== undefined,
      clientSecretReplaced: data.clientSecret !== undefined,
      signedOut: clientChanged,
    });
    return false;
  });
  return { connector: getConnector(ctx.db, ctx.workspaceId, 'gmail')!, created };
}

const loopbackOrigin = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/;

// Builds the Google consent URL and saves the pending state and PKCE verifier. returnOrigin is the browser page that
// asked for the sign in; the callback sends the browser back there when it is a loopback origin.
export function startGmailOAuth(ctx: ActionContext, options: { returnOrigin?: string | null } = {}): { url: string } {
  const internals = getGmailInternals(ctx.db, ctx.workspaceId);
  const clientId = typeof internals?.settings.clientId === 'string' ? internals.settings.clientId : null;
  if (!internals || !clientId || !internals.secret) {
    throw new AppError('conflict', 'Save the client id and client secret first, then sign in with Google.');
  }
  const { verifier, challenge } = createPkce();
  const state = createState();
  const returnOrigin = options.returnOrigin && loopbackOrigin.test(options.returnOrigin) ? options.returnOrigin : null;
  mutate(ctx, (tx) => {
    const current = readRow(tx);
    if (!current) throw notFound('Gmail connector');
    writeIn(tx, current, { settings: { pending: { state, verifier, createdAt: tx.now(), returnOrigin } } });
    tx.audit('connector.oauth_start', 'connector', current.row.id, { kind: 'gmail', scopes: gmailScopes.length });
  });
  return { url: buildAuthorizationUrl({ clientId, redirectUri: oauthRedirectUri(), state, challenge }) };
}

function equalStrings(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface OAuthCallbackQuery {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
}

export interface OAuthOutcome {
  // A path, or an absolute loopback URL when the browser that started the sign in is known.
  redirect: string;
  ok: boolean;
  errorCode: string | null;
}

function redirectFor(origin: string | null, errorCode: string | null): string {
  const base = `${origin ?? ''}/settings/connectors`;
  return errorCode ? `${base}?gmail_error=${encodeURIComponent(errorCode)}` : base;
}

// Records why a sign in failed, as a sentence on the connector. updated_at moves so the Settings card sees that the
// sign in ended. Status stays as it was: a failed attempt does not sign out an account that was working.
function recordFailure(ctx: ActionContext, code: string, detail?: string): void {
  mutate(ctx, (tx) => {
    const current = readRow(tx);
    if (!current) return;
    writeIn(tx, current, {
      settings: { statusMessage: detail ?? gmailSignInMessageFor[code] ?? gmailSignInMessageFor.google_error },
      touch: true,
    });
    tx.audit('connector.oauth_failed', 'connector', current.row.id, { kind: 'gmail', code });
  });
}

function safeErrorCode(value: string | undefined): string {
  const cleaned = (value ?? '').toLowerCase().replace(/[^a-z_]/g, '').slice(0, 40);
  return cleaned === 'access_denied' ? 'access_denied' : 'google_error';
}

// The callback Google redirects the browser to. State is checked and consumed before anything goes to the network, so
// a repeated or forged callback cannot sign anything in.
export async function completeGmailOAuth(ctx: ActionContext, query: OAuthCallbackQuery): Promise<OAuthOutcome> {
  const fail = (code: string, origin: string | null, detail?: string): OAuthOutcome => {
    recordFailure(ctx, code, detail);
    return { redirect: redirectFor(origin, code), ok: false, errorCode: code };
  };
  const internals = getGmailInternals(ctx.db, ctx.workspaceId);
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
  if (query.error) return fail(safeErrorCode(query.error), origin);
  if (!query.code) return fail('missing_code', origin);
  const clientId = typeof internals.settings.clientId === 'string' ? internals.settings.clientId : null;
  if (!clientId || !internals.secret) return fail('no_connector', origin);

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode({
      clientId,
      clientSecret: internals.secret.clientSecret,
      code: query.code,
      verifier: pending.verifier,
      redirectUri: oauthRedirectUri(),
      now: () => Date.parse(ctx.now()),
    });
  } catch (error) {
    return fail('exchange_failed', origin, error instanceof MailProviderError ? `${gmailSignInMessageFor.exchange_failed} (${error.message})` : undefined);
  }
  if (tokens.scopes && !gmailScopes.every((scope) => tokens.scopes!.includes(scope))) return fail('missing_permissions', origin);

  let profile;
  try {
    profile = await fetchProfileWithToken(tokens.accessToken);
  } catch (error) {
    if (error instanceof MailProviderError && error.kind === 'unauthorized') return fail('missing_permissions', origin, readPermissionSentence);
    return fail('profile_failed', origin);
  }

  mutate(ctx, (tx) => {
    const current = readRow(tx);
    if (!current) throw notFound('Gmail connector');
    const previousAddress = typeof current.settings.emailAddress === 'string' ? current.settings.emailAddress : null;
    const sameAccount = previousAddress === profile.emailAddress;
    const previousHistory = typeof current.settings.historyId === 'string' ? current.settings.historyId : null;
    if (previousAddress && !sameAccount) {
      blockWaitingIntentsIn(tx, { inboxId: previousAddress, provider: 'gmail' }, 'The sending inbox changed after this message was approved.');
    }
    writeIn(tx, current, {
      settings: {
        // Only a finished sign in sets this. The Settings card waits for it to change, so a failed attempt, which
        // only moves updated_at, can be told apart from a success.
        oauthCompletedAt: tx.now(),
        emailAddress: profile.emailAddress,
        // The same account keeps its position, so replies that arrived while signed out are still found.
        historyId: sameAccount && previousHistory ? previousHistory : profile.historyId,
        lastSyncError: null,
        ...(sameAccount ? {} : { lastSyncAt: null }),
      },
      secret: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt },
      status: 'connected',
      touch: true,
      drop: ['pending', 'statusMessage', 'errorKind'],
    });
    activateMailProviderIfUnsetIn(tx, 'gmail');
    tx.audit('connector.oauth_complete', 'connector', current.row.id, { kind: 'gmail', accountChanged: !sameAccount });
    // An account is signed in: messages sent from this address whose outcome was unknown go back to being checked,
    // read only. This covers a sign in after an error and a new sign in after the connector was removed.
    resumeGmailReconcilesIn(tx, profile.emailAddress);
  });
  return { redirect: redirectFor(origin, null), ok: true, errorCode: null };
}

// Queued and approved Gmail messages become blocked. A message that is being submitted, or whose outcome is unknown,
// keeps its state because the email may already be out. The reason is added to its error text.
export function disconnectGmailConnector(ctx: ActionContext): void {
  if (!getConnector(ctx.db, ctx.workspaceId, 'gmail')) throw notFound('Gmail connector');
  mutate(ctx, (tx) => {
    const row = tx.db.prepare("SELECT id FROM connector WHERE workspace_id = ? AND kind = 'gmail'").get(tx.workspaceId) as { id: string } | undefined;
    if (!row) throw notFound('Gmail connector');
    const wasActive = getActiveMailConnector(tx.db, tx.workspaceId)?.kind === 'gmail';
    const blocked = blockWaitingIntentsIn(tx, { provider: 'gmail' }, reasonCodes.connectorRemoved);
    const inFlight = tx.db
      .prepare("SELECT id, status FROM send_intent WHERE workspace_id = ? AND provider = 'gmail' AND status IN ('submitting', 'unknown')")
      .all(tx.workspaceId) as { id: string; status: 'submitting' | 'unknown' }[];
    for (const intent of inFlight) {
      transitionIntentIn(tx, intent.id, [intent.status], intent.status, { appendError: reasonCodes.connectorRemoved }, 'connector_removed', {
        reason: reasonCodes.connectorRemoved,
      });
    }
    tx.db.prepare('DELETE FROM connector WHERE id = ?').run(row.id);
    reassignMailProviderAfterRemovalIn(tx, wasActive);
    tx.audit('connector.disconnect', 'connector', row.id, { kind: 'gmail', intentsBlocked: blocked, intentsInFlight: inFlight.length });
  });
}

// Marks the connector as needing a new sign in. Does nothing when it is already marked, so the first and most specific
// sentence stays.
export function markGmailError(ctx: ActionContext, reason: 'invalid_grant' | 'invalid_client' | 'unauthorized'): void {
  mutate(ctx, (tx) => {
    const current = readRow(tx);
    if (!current || current.row.status === 'error') return;
    const message = reason === 'invalid_grant' ? consentExpiredSentence : reason === 'invalid_client' ? clientRejectedSentence : 'Google no longer accepts the saved sign in. Sign in with Google again.';
    writeIn(tx, current, { settings: { statusMessage: message, errorKind: reason }, status: 'error', touch: true });
    tx.audit('connector.error', 'connector', current.row.id, { kind: 'gmail', reason });
  });
}

// Reads and saves tokens for the adapter. Every call reads the database, so a refresh by another path is seen at once.
export function createGmailTokenStore(ctx: ActionContext): GmailTokenStore {
  return {
    key: `${ctx.workspaceId}:gmail`,
    read(): GmailSession {
      const internals = getGmailInternals(ctx.db, ctx.workspaceId);
      const clientId = typeof internals?.settings.clientId === 'string' ? internals.settings.clientId : null;
      if (!internals || !clientId || !internals.secret || !internals.secret.refreshToken) {
        throw new MailProviderError('unauthorized', gmailNotSignedInMessage);
      }
      return {
        clientId,
        clientSecret: internals.secret.clientSecret,
        accessToken: internals.secret.accessToken,
        refreshToken: internals.secret.refreshToken,
        expiresAt: internals.secret.expiresAt,
      };
    },
    // Compare and set. A refresh takes a network round trip, and a sign in can finish inside it. The new account's
    // tokens must never be replaced by tokens that belong to the old one, so nothing is written unless the stored
    // refresh token is still the one this refresh started from.
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
      const stored = getGmailInternals(ctx.db, ctx.workspaceId)?.secret?.refreshToken;
      if (stored !== startedFromRefreshToken) return;
      markGmailError(ctx, reason);
    },
  };
}

export function requireGmailSignedIn(ctx: ActionContext): GmailConnector {
  const connector = getConnector(ctx.db, ctx.workspaceId, 'gmail');
  if (!connector || !connector.settings.signedIn) throw new AppError('conflict', gmailNotSignedInMessage);
  return connector;
}
