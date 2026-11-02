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
import { createModelProvider } from '../providers/factory.js';
import { ModelProviderError } from '../providers/modelTypes.js';
import { createOllamaProvider, type OllamaModelInfo } from '../providers/ollama.js';
import { defaultModelId, offeredModelIds, providerLabels } from '../providers/presets.js';
import { defaultOllamaBase } from '../config.js';
import {
  type AnthropicConnector,
  type ApifyConnector,
  type ConnectorKind,
  type KeyedModelKind,
  type ModelConnector,
  type ModelConnectorKind,
  type OllamaConnector,
  defaultLeadCaptureActors,
  getConnector,
  getConnectorSecret,
  isModelConnectorKind,
  leadCaptureActorFields,
} from '../queries/connectors.js';
import { getActiveModelConnector } from '../queries/modelProvider.js';
import { abortRemoteRunIfNeeded, failActiveApifyRuns } from './apifyScrape.js';
import { type ActionContext, mutate, parseInput } from './context.js';
import { failActiveDraftRuns } from './draftOutreach.js';
import { activateIfFirstIn, noModelProviderMessage, reassignAfterRemovalIn } from './modelProvider.js';

// The lead capture actor ids a workspace starts with. Edited per workspace in the Apify connector settings.
export { defaultLeadCaptureActors } from '../queries/connectors.js';

export const tokenRejectedMessage = 'Apify rejected the saved API token. Enter a new one to reconnect.';
export const connectApifyMessage = 'Apify is not connected. Connect Apify in Settings first.';

const actorIdPattern = /^[A-Za-z0-9_.~/-]+$/;

// An empty string resets the field to its default. Anything else must be a valid actor id.
const leadCaptureField = z
  .string()
  .trim()
  .max(200)
  .refine((value) => value === '' || (actorIdPattern.test(value) && !hasDotSegment(value)), 'Use actor ids like username/actor-name')
  .optional();

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
    // Fields that are sent change; fields that are left out stay as they are. An empty string resets one to its default.
    leadCapture: z
      .object({ reactionsActor: leadCaptureField, commentsActor: leadCaptureField, profileActor: leadCaptureField })
      .strict()
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

export function allowlistIncludes(connector: ApifyConnector, actorId: string): boolean {
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
): Promise<{ connector: ApifyConnector; created: boolean }> {
  const data = parseInput(configureSchema, input);
  const existing = getConnector(ctx.db, ctx.workspaceId, 'apify');
  if (!data.token && !existing) throw validationError('token: A token is required to connect Apify.');
  if (!data.token && data.allowlist === undefined && data.leadCapture === undefined) {
    throw validationError('Send a token, an allowlist, lead capture actors, or any mix of them.');
  }

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
    // Only ids that differ from the defaults are stored, so a changed default reaches everyone who never edited it.
    const leadCapture: Record<string, string> = {};
    for (const field of leadCaptureActorFields) {
      const wanted = data.leadCapture?.[field];
      if (wanted === '') continue;
      if (wanted !== undefined) {
        leadCapture[field] = normalizeActorId(wanted);
        continue;
      }
      // A field that was not sent keeps what it had. Reads show the default for a field with no saved id.
      const kept = current?.settings.leadCapture[field];
      if (kept !== undefined && kept !== defaultLeadCaptureActors[field]) leadCapture[field] = kept;
    }
    const settings = JSON.stringify({ allowlist, username, statusMessage: keptMessage, leadCapture });
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
        leadCaptureCustomized: Object.keys(leadCapture).length,
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
export function markConnectorError(ctx: ActionContext, failedToken: string, kind: ConnectorKind = 'apify'): void {
  mutate(ctx, (tx) => {
    const row = tx.db
      .prepare("SELECT id, settings, secret FROM connector WHERE workspace_id = ? AND kind = ? AND status != 'error'")
      .get(tx.workspaceId, kind) as { id: string; settings: string; secret: string } | undefined;
    if (!row || row.secret !== failedToken) return;
    const message = isModelConnectorKind(kind)
      ? `${providerLabels[kind]} rejected the saved API key. Enter a new one to reconnect.`
      : tokenRejectedMessage;
    const settings = { ...(JSON.parse(row.settings) as Record<string, unknown>), statusMessage: message };
    tx.db
      .prepare("UPDATE connector SET status = 'error', settings = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(settings), tx.now(), row.id);
    tx.audit('connector.error', 'connector', row.id, { kind, reason: 'token_rejected' });
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

function keyedConfigureSchema(kind: KeyedModelKind) {
  const models = offeredModelIds(kind);
  return z
    .object({
      token: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .refine((value) => !/\s/.test(value), 'Token must not contain spaces')
        .optional(),
      model: z
        .string()
        .refine((value) => models.includes(value), { message: `Choose one of ${models.join(', ')}` })
        .optional(),
    })
    .strict();
}

// Turns a provider failure into the standard error envelope. The message never carries the key.
export function mapModelError(error: unknown, label = 'Anthropic'): AppError {
  if (!(error instanceof ModelProviderError)) return new AppError('internal', `Something went wrong while talking to ${label}.`);
  switch (error.kind) {
    case 'unauthorized':
      return new AppError('conflict', `${label} did not accept the saved API key. Update it in Settings.`);
    case 'rate_limited':
      return new AppError('conflict', `${label} is rate limiting requests. Wait a moment and try again.`, { status: 429 });
    case 'rejected':
      return new AppError('conflict', error.message);
    case 'timeout':
      return new AppError('internal', `${label} did not answer in time. Try again.`, { status: 504 });
    case 'unavailable':
      return new AppError(
        'internal',
        label === 'Ollama'
          ? 'Could not reach the Ollama server. Check that it is running and that the address is right.'
          : `Could not reach ${label}. Check your connection and try again.`,
        { status: 502 },
      );
    case 'bad_response':
      return new AppError('internal', `${label} sent a response this app could not read.`, { status: 502 });
  }
}

export async function configureModelConnector(
  ctx: ActionContext,
  kind: KeyedModelKind,
  input: unknown,
): Promise<{ connector: ModelConnector; created: boolean }> {
  const label = providerLabels[kind];
  const data = parseInput(keyedConfigureSchema(kind), input);
  const existing = getConnector(ctx.db, ctx.workspaceId, kind);
  if (!data.token && !existing) throw validationError(`token: A key is required to connect ${label}.`);
  if (!data.token && data.model === undefined) throw validationError('Send a key, a model, or both.');

  if (data.token) {
    try {
      await createModelProvider(kind, { apiKey: data.token }).validateKey();
    } catch (error) {
      if (error instanceof ModelProviderError && error.kind === 'unauthorized') {
        throw validationError(`${label} did not accept this key. Check it and try again.`);
      }
      throw mapModelError(error, label);
    }
  }

  // The saved row is read again inside the write transaction, so a model change made while the key
  // was being checked is not overwritten with stale values.
  const save = (): boolean => mutate(ctx, (tx) => {
    const current = getConnector(tx.db, tx.workspaceId, kind);
    if (!data.token && !current) throw validationError(`token: A key is required to connect ${label}.`);
    const model: string = data.model ?? current?.settings.model ?? defaultModelId(kind);
    const keptMessage = !data.token && current?.status === 'error' ? current.statusMessage : null;
    const settings = JSON.stringify({ model, statusMessage: keptMessage });
    const now = tx.now();
    if (current) {
      if (data.token) {
        tx.db
          .prepare("UPDATE connector SET settings = ?, secret = ?, status = 'connected', updated_at = ? WHERE id = ?")
          .run(settings, data.token, now, current.id);
      } else {
        tx.db.prepare('UPDATE connector SET settings = ?, updated_at = ? WHERE id = ?').run(settings, now, current.id);
      }
      tx.audit('connector.configure', 'connector', current.id, { kind, tokenReplaced: Boolean(data.token), model });
      return false;
    }
    const created = tx.newId('con');
    tx.db
      .prepare(
        "INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'connected', ?)",
      )
      .run(created, now, tx.workspaceId, kind, settings, data.token ?? '', now);
    tx.audit('connector.configure', 'connector', created, { kind, tokenReplaced: true, model });
    activateIfFirstIn(tx, kind);
    return true;
  });
  let created: boolean;
  try {
    created = save();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('internal', 'The key is valid, but it could not be saved to the local database.');
  }
  return { connector: getConnector(ctx.db, ctx.workspaceId, kind)!, created };
}

export async function configureAnthropicConnector(
  ctx: ActionContext,
  input: unknown,
): Promise<{ connector: AnthropicConnector; created: boolean }> {
  const result = await configureModelConnector(ctx, 'anthropic', input);
  return result as { connector: AnthropicConnector; created: boolean };
}

const ollamaConfigureSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(300).optional(),
    model: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const ollamaAddressMessage = 'baseUrl: Use an http or https address, for example http://127.0.0.1:11434, without a username or password.';

// Keeps the scheme, host, and any path prefix. Drops a trailing slash, the query, and the fragment.
export function normalizeOllamaBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw validationError(ollamaAddressMessage);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '') {
    throw validationError(ollamaAddressMessage);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function installedList(models: OllamaModelInfo[]): string {
  const names = models.slice(0, 10).map((model) => model.name);
  return `${names.join(', ')}${models.length > 10 ? ', and more' : ''}`;
}

// Saves the address and the chosen model. The address alone is enough to connect: the model stays unset
// until a person picks one of the installed models. Both are checked against the server's model list.
export async function configureOllamaConnector(
  ctx: ActionContext,
  input: unknown,
): Promise<{ connector: OllamaConnector; created: boolean }> {
  const data = parseInput(ollamaConfigureSchema, input);
  const existing = getConnector(ctx.db, ctx.workspaceId, 'ollama');
  if (data.baseUrl === undefined && data.model === undefined && existing) {
    throw validationError('Send an address, a model, or both.');
  }
  const baseUrl = data.baseUrl !== undefined ? normalizeOllamaBaseUrl(data.baseUrl) : (existing?.settings.baseUrl ?? defaultOllamaBase);

  let installed: OllamaModelInfo[];
  try {
    installed = await createOllamaProvider(baseUrl).listModels();
  } catch (error) {
    throw mapModelError(error, 'Ollama');
  }
  // A changed address keeps the old model only if the new server has it too.
  const keptModel = existing?.settings.model && installed.some((model) => model.name === existing.settings.model) ? existing.settings.model : null;
  const model = data.model ?? keptModel;
  if (data.model !== undefined && !installed.some((entry) => entry.name === data.model)) {
    throw validationError(
      installed.length === 0
        ? 'model: No models are installed on this Ollama server. Pull one first, then pick it here.'
        : `model: ${data.model} is not installed on this Ollama server. Installed models: ${installedList(installed)}.`,
    );
  }

  const save = (): boolean => mutate(ctx, (tx) => {
    const current = getConnector(tx.db, tx.workspaceId, 'ollama');
    const settings = JSON.stringify({ baseUrl, model, statusMessage: null });
    const now = tx.now();
    if (current) {
      tx.db.prepare("UPDATE connector SET settings = ?, status = 'connected', updated_at = ? WHERE id = ?").run(settings, now, current.id);
      tx.audit('connector.configure', 'connector', current.id, { kind: 'ollama', model });
      return false;
    }
    const created = tx.newId('con');
    tx.db
      .prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES (?, ?, ?, 'ollama', ?, '', 'connected', ?)")
      .run(created, now, tx.workspaceId, settings, now);
    tx.audit('connector.configure', 'connector', created, { kind: 'ollama', model });
    activateIfFirstIn(tx, 'ollama');
    return true;
  });
  let created: boolean;
  try {
    created = save();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('internal', 'The address works, but it could not be saved to the local database.');
  }
  return { connector: getConnector(ctx.db, ctx.workspaceId, 'ollama')!, created };
}

// Installed models from the saved server's tags endpoint.
export async function listOllamaModels(ctx: ActionContext): Promise<{ items: OllamaModelInfo[]; nextCursor: null }> {
  const connector = getConnector(ctx.db, ctx.workspaceId, 'ollama');
  if (!connector) throw conflict('Ollama is not connected. Save the server address in Settings first.');
  try {
    return { items: await createOllamaProvider(connector.settings.baseUrl).listModels(), nextCursor: null };
  } catch (error) {
    throw mapModelError(error, 'Ollama');
  }
}

// Draft runs pinned to this provider that have written nothing yet cannot continue without it, so they are failed
// first, whether or not it is the active provider. Runs pinned to another provider keep going. A run that already
// has drafts, or is waiting for review, keeps them, because approving them needs no key.
export function disconnectModelConnector(ctx: ActionContext, kind: ModelConnectorKind): void {
  if (!getConnector(ctx.db, ctx.workspaceId, kind)) throw notFound(`${providerLabels[kind]} connector`);
  const wasActive = getActiveModelConnector(ctx.db, ctx.workspaceId)?.kind === kind;
  const stopped = failActiveDraftRuns(ctx, kind, `${providerLabels[kind]} was disconnected in Settings, so this run was stopped.`);
  mutate(ctx, (tx) => {
    const row = tx.db.prepare('SELECT id FROM connector WHERE workspace_id = ? AND kind = ?').get(tx.workspaceId, kind) as
      | { id: string }
      | undefined;
    if (!row) throw notFound(`${providerLabels[kind]} connector`);
    tx.db.prepare('DELETE FROM connector WHERE id = ?').run(row.id);
    tx.audit('connector.disconnect', 'connector', row.id, { kind, runsStopped: stopped.length });
    reassignAfterRemovalIn(tx, wasActive);
  });
}

export function disconnectAnthropicConnector(ctx: ActionContext): void {
  disconnectModelConnector(ctx, 'anthropic');
}

export interface ModelConnection {
  kind: ModelConnectorKind;
  label: string;
  model: string;
  apiKey: string;
  // Only set for Ollama.
  baseUrl: string | null;
}

// The saved connection for one provider, or a conflict a person can fix in Settings.
export function requireModelConnection(ctx: ActionContext, kind: ModelConnectorKind): ModelConnection {
  const label = providerLabels[kind];
  const connector = getConnector(ctx.db, ctx.workspaceId, kind);
  const apiKey = getConnectorSecret(ctx.db, ctx.workspaceId, kind);
  if (!connector || apiKey === null || (kind !== 'ollama' && apiKey === '')) throw conflict(`${label} is not connected. Connect ${label} in Settings first.`);
  if (connector.status === 'error') throw conflict(`${label} rejected the saved key. Update it in Settings.`);
  if (connector.kind === 'ollama') {
    if (!connector.settings.model) throw conflict('No Ollama model is chosen. Pick an installed model in Settings first.');
    return { kind, label, model: connector.settings.model, apiKey: '', baseUrl: connector.settings.baseUrl };
  }
  return { kind, label, model: connector.settings.model, apiKey, baseUrl: null };
}

// The connection chat and new draft runs use: the active provider chosen in Settings.
export function requireActiveModel(ctx: ActionContext): ModelConnection {
  const active = getActiveModelConnector(ctx.db, ctx.workspaceId);
  if (!active) throw conflict(noModelProviderMessage);
  return requireModelConnection(ctx, active.kind);
}
