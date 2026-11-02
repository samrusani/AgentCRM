import { z } from 'zod';
import { AppError, conflict, notFound, validationError } from '../errors.js';
import {
  ApifyError,
  dotSegmentMessage,
  getActor,
  hasDotSegment,
  normalizeActorId,
  searchActors,
  validateToken,
} from '../providers/apify.js';
import { type Connector, getConnector, getConnectorSecret } from '../queries/connectors.js';
import { abortRemoteRunIfNeeded, failActiveApifyRuns } from './apifyScrape.js';
import { type ActionContext, mutate, parseInput } from './context.js';

export const tokenRejectedMessage = 'Apify rejected the saved API token. Enter a new one to reconnect.';
export const connectApifyMessage = 'Apify is not connected. Connect Apify in Settings first.';

const actorIdPattern = /^[A-Za-z0-9_.~/-]+$/;

const configureSchema = z
  .object({
    token: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((value) => !/\s/.test(value), 'Token must not contain spaces')
      .optional(),
    allowlist: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(actorIdPattern, 'Use actor ids like username/actor-name')
          .refine((value) => !hasDotSegment(value), dotSegmentMessage),
      )
      .max(100)
      .optional(),
  })
  .strict();

function dedupeActorIds(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    const key = normalizeActorId(id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function allowlistIncludes(connector: Connector, actorId: string): boolean {
  const wanted = normalizeActorId(actorId);
  return connector.settings.allowlist.some((entry) => normalizeActorId(entry) === wanted);
}

// Turns a provider failure into the standard error envelope. The message never carries the token.
export function mapApifyError(error: unknown, subject: string): AppError {
  if (!(error instanceof ApifyError)) return new AppError('internal', 'Something went wrong while talking to Apify.');
  switch (error.kind) {
    case 'unauthorized':
      return new AppError('conflict', 'Apify did not accept the saved API token. Update it in Settings.');
    case 'not_found':
      return new AppError('not_found', `${subject} was not found on Apify.`);
    case 'rate_limited':
      return new AppError('conflict', 'Apify is rate limiting requests. Wait a moment and try again.', { status: 429 });
    case 'rejected':
      return new AppError('conflict', error.message);
    case 'timeout':
      return new AppError('internal', 'Apify did not answer in time. Try again.', { status: 504 });
    case 'unavailable':
      return new AppError('internal', 'Could not reach Apify. Check your connection and try again.', { status: 502 });
    case 'bad_response':
      return new AppError('internal', 'Apify sent a response this app could not read.', { status: 502 });
  }
}

export async function configureApifyConnector(
  ctx: ActionContext,
  input: unknown,
): Promise<{ connector: Connector; created: boolean }> {
  const data = parseInput(configureSchema, input);
  const existing = getConnector(ctx.db, ctx.workspaceId, 'apify');
  if (!data.token && !existing) throw validationError('token: A token is required to connect Apify.');
  if (!data.token && data.allowlist === undefined) throw validationError('Send a token, an allowlist, or both.');

  let validatedUsername: string | null = null;
  if (data.token) {
    try {
      validatedUsername = (await validateToken(data.token)).username;
    } catch (error) {
      if (error instanceof ApifyError && error.kind === 'unauthorized') {
        throw validationError('Apify did not accept this token. Check it and try again.');
      }
      throw mapApifyError(error, 'Apify');
    }
  }

  // The saved row is read again inside the write transaction, so an allowlist edit made while the token
  // was being checked is not overwritten with stale values.
  const save = (): boolean => mutate(ctx, (tx) => {
    const current = getConnector(tx.db, tx.workspaceId, 'apify');
    if (!data.token && !current) throw validationError('token: A token is required to connect Apify.');
    const username = data.token ? validatedUsername : (current?.settings.username ?? null);
    const keptMessage = !data.token && current?.status === 'error' ? current.statusMessage : null;
    const allowlist = data.allowlist ? dedupeActorIds(data.allowlist) : (current?.settings.allowlist ?? []);
    const settings = JSON.stringify({ allowlist, username, statusMessage: keptMessage });
    const now = tx.now();
    if (current) {
      if (data.token) {
        tx.db
          .prepare("UPDATE connector SET settings = ?, secret = ?, status = 'connected', updated_at = ? WHERE id = ?")
          .run(settings, data.token, now, current.id);
      } else {
        tx.db.prepare('UPDATE connector SET settings = ?, updated_at = ? WHERE id = ?').run(settings, now, current.id);
      }
      tx.audit('connector.configure', 'connector', current.id, {
        kind: 'apify',
        tokenReplaced: Boolean(data.token),
        allowlistCount: allowlist.length,
      });
      return false;
    }
    const created = tx.newId('con');
    tx.db
      .prepare(
        "INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES (?, ?, ?, 'apify', ?, ?, 'connected', ?)",
      )
      .run(created, now, tx.workspaceId, settings, data.token ?? '', now);
    tx.audit('connector.configure', 'connector', created, {
      kind: 'apify',
      tokenReplaced: true,
      allowlistCount: allowlist.length,
    });
    return true;
  });
  let created: boolean;
  try {
    created = save();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('internal', 'The token is valid, but it could not be saved to the local database.');
  }
  return { connector: getConnector(ctx.db, ctx.workspaceId, 'apify')!, created };
}

// Active runs cannot continue without the token, so they are failed first and their Apify runs are
// asked to stop while the token still exists. Runs waiting for review keep their staged rows.
export async function disconnectApifyConnector(ctx: ActionContext): Promise<void> {
  if (!getConnector(ctx.db, ctx.workspaceId, 'apify')) throw notFound('Apify connector');
  const stopped = failActiveApifyRuns(ctx, 'Apify was disconnected in Settings, so this run was stopped.');
  for (const runId of stopped) await abortRemoteRunIfNeeded(ctx, runId);
  mutate(ctx, (tx) => {
    const row = tx.db.prepare('SELECT id FROM connector WHERE workspace_id = ? AND kind = ?').get(tx.workspaceId, 'apify') as
      | { id: string }
      | undefined;
    if (!row) throw notFound('Apify connector');
    tx.db.prepare('DELETE FROM connector WHERE id = ?').run(row.id);
    tx.audit('connector.disconnect', 'connector', row.id, { kind: 'apify', runsStopped: stopped.length });
  });
}

// A rejected token flips the connector to "error" so Settings can ask for a new one. It only does so
// when the token that failed is still the saved one, so a token replaced meanwhile is not marked bad.
export function markConnectorError(ctx: ActionContext, failedToken: string): void {
  mutate(ctx, (tx) => {
    const row = tx.db
      .prepare("SELECT id, settings, secret FROM connector WHERE workspace_id = ? AND kind = 'apify' AND status != 'error'")
      .get(tx.workspaceId) as { id: string; settings: string; secret: string } | undefined;
    if (!row || row.secret !== failedToken) return;
    const settings = { ...(JSON.parse(row.settings) as Record<string, unknown>), statusMessage: tokenRejectedMessage };
    tx.db
      .prepare("UPDATE connector SET status = 'error', settings = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(settings), tx.now(), row.id);
    tx.audit('connector.error', 'connector', row.id, { kind: 'apify', reason: 'token_rejected' });
  });
}

export function requireApifyToken(ctx: ActionContext): string {
  const connector = getConnector(ctx.db, ctx.workspaceId, 'apify');
  const token = getConnectorSecret(ctx.db, ctx.workspaceId, 'apify');
  if (!connector || !token) throw conflict(connectApifyMessage);
  if (connector.status === 'error') throw conflict('Apify rejected the saved token. Update it in Settings.');
  return token;
}

async function proxy<T>(ctx: ActionContext, subject: string, call: (token: string) => Promise<T>): Promise<T> {
  const token = requireApifyToken(ctx);
  try {
    return await call(token);
  } catch (error) {
    if (error instanceof ApifyError && error.kind === 'unauthorized') markConnectorError(ctx, token);
    throw mapApifyError(error, subject);
  }
}

const searchSchema = z
  .object({ q: z.string().trim().max(200).default(''), limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();

export async function searchApifyActors(ctx: ActionContext, input: unknown) {
  const { q, limit } = parseInput(searchSchema, input);
  const items = await proxy(ctx, 'The store', (token) => searchActors(token, q, limit));
  return { items, nextCursor: null };
}

export async function getApifyActor(ctx: ActionContext, actorId: string) {
  const id = actorId.trim();
  if (id === '' || id.length > 200 || !actorIdPattern.test(id) || hasDotSegment(id)) throw validationError('The actor id is not valid.');
  return proxy(ctx, `Actor "${id}"`, (token) => getActor(token, id));
}
