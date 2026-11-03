import { z } from 'zod';
import { AppError, conflict, notFound, validationError } from '../errors.js';
import { reasonCodes } from '../mail/rules.js';
import { MailProviderError } from '../providers/mailTypes.js';
import {
  AgentmailError,
  createInbox,
  listInboxes,
  type MailInbox,
  validateKey,
} from '../providers/agentmail.js';
import { type AgentmailConnector, getConnector, getConnectorSecret } from '../queries/connectors.js';
import { type ActionContext, mutate, parseInput, type Tx } from './context.js';
import { getActiveMailConnector } from '../queries/mailProvider.js';
import { activateMailProviderIfUnsetIn, reassignMailProviderAfterRemovalIn } from './mailProvider.js';
import { blockWaitingIntentsIn, transitionIntentIn } from './sendIntentState.js';

export const agentmailKeyRejectedMessage = 'AgentMail rejected the saved API key. Enter a new one to reconnect.';
export const connectAgentmailMessage = 'AgentMail is not connected. Connect AgentMail in Settings first.';

// A first sync looks back this far, so a clock that runs a little ahead of AgentMail's does not hide a reply.
const initialLookbackMilliseconds = 120_000;
const maxInboxPages = 10;

// Turns a provider failure into the standard error envelope. The message never carries the key.
export function mapAgentmailError(error: unknown): AppError {
  if (!(error instanceof MailProviderError)) return new AppError('internal', 'Something went wrong while talking to AgentMail.');
  switch (error.kind) {
    case 'unauthorized':
      return new AppError('conflict', 'AgentMail did not accept the saved API key. Update it in Settings.');
    case 'not_found':
      return new AppError('not_found', 'AgentMail could not find that resource.');
    case 'rate_limited':
      return new AppError('conflict', 'AgentMail is rate limiting requests. Wait a moment and try again.', { status: 429 });
    case 'rejected':
    case 'conflict':
      return new AppError('conflict', error.message);
    case 'timeout':
      return new AppError('internal', 'AgentMail did not answer in time. Try again.', { status: 504 });
    case 'network':
    case 'unavailable':
      return new AppError('internal', 'Could not reach AgentMail. Check your connection and try again.', { status: 502 });
    case 'bad_response':
      return new AppError('internal', 'AgentMail sent a response this app could not read.', { status: 502 });
    case 'gone':
    case 'unexpected_status':
      return new AppError('internal', 'AgentMail answered in a way this app did not expect. Try again.', { status: 502 });
  }
}

async function fetchAllInboxes(apiKey: string): Promise<MailInbox[]> {
  const found: MailInbox[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxInboxPages; page += 1) {
    const result = await listInboxes(apiKey, { limit: 100, ...(pageToken ? { pageToken } : {}) });
    found.push(...result.inboxes);
    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }
  return found;
}

const configureSchema = z
  .object({
    token: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((value) => !/\s/.test(value), 'Key must not contain spaces')
      .optional(),
    inboxId: z.string().trim().min(1).max(320).optional(),
    inboxEmail: z.string().trim().min(1).max(320).optional(),
  })
  .strict();

function findInbox(inboxes: MailInbox[], wanted: { inboxId?: string | undefined; inboxEmail?: string | undefined }): MailInbox | null {
  const id = wanted.inboxId?.toLowerCase();
  const email = wanted.inboxEmail?.toLowerCase();
  return (
    inboxes.find((inbox) => (id ? inbox.inboxId.toLowerCase() === id : true) && (email ? inbox.email.toLowerCase() === email : true)) ?? null
  );
}

export async function configureAgentmailConnector(
  ctx: ActionContext,
  input: unknown,
): Promise<{ connector: AgentmailConnector; created: boolean }> {
  const data = parseInput(configureSchema, input);
  const existing = getConnector(ctx.db, ctx.workspaceId, 'agentmail');
  if (!data.token && !existing) throw validationError('token: A key is required to connect AgentMail.');
  const choosesInbox = data.inboxId !== undefined || data.inboxEmail !== undefined;
  if (!data.token && !choosesInbox) throw validationError('Send a key, an inbox, or both.');

  const apiKey = data.token ?? getConnectorSecret(ctx.db, ctx.workspaceId, 'agentmail') ?? '';
  if (data.token) {
    try {
      await validateKey(data.token);
    } catch (error) {
      if (error instanceof AgentmailError && error.kind === 'unauthorized') {
        throw validationError('AgentMail did not accept this key. Check it and try again.');
      }
      throw mapAgentmailError(error);
    }
  }

  // An inbox choice must exist on the account behind this key. A replaced key also re-checks the saved inbox.
  let chosen: MailInbox | null = null;
  let savedInboxMissing = false;
  if (choosesInbox || (data.token && existing?.settings.inboxId)) {
    let inboxes: MailInbox[];
    try {
      inboxes = await fetchAllInboxes(apiKey);
    } catch (error) {
      throw mapAgentmailError(error);
    }
    if (choosesInbox) {
      chosen = findInbox(inboxes, { inboxId: data.inboxId, inboxEmail: data.inboxEmail });
      if (!chosen) throw validationError('inboxId: That inbox was not found on this AgentMail account.');
    } else {
      chosen = findInbox(inboxes, { inboxId: existing!.settings.inboxId ?? undefined });
      savedInboxMissing = chosen === null;
    }
  }

  const save = (): boolean =>
    mutate(ctx, (tx) => {
      const current = getConnector(tx.db, tx.workspaceId, 'agentmail');
      if (!data.token && !current) throw validationError('token: A key is required to connect AgentMail.');
      const now = tx.now();
      const previousInboxId = current?.settings.inboxId ?? null;
      let inboxId = previousInboxId;
      let inboxEmail = current?.settings.inboxEmail ?? null;
      if (chosen) {
        inboxId = chosen.inboxId;
        inboxEmail = chosen.email;
      } else if (savedInboxMissing) {
        inboxId = null;
        inboxEmail = null;
      }
      const inboxChanged = inboxId !== previousInboxId;
      const keepCursors = !inboxChanged;
      const settings = {
        inboxId,
        inboxEmail,
        lastMessageTimestamp: inboxId
          ? keepCursors
            ? (current?.settings.lastMessageTimestamp ?? null)
            : new Date(Date.parse(now) - initialLookbackMilliseconds).toISOString()
          : null,
        seenEventId: keepCursors ? (current?.settings.seenEventId ?? null) : null,
        lastSyncAt: keepCursors ? (current?.settings.lastSyncAt ?? null) : null,
        lastSyncError: null,
        statusMessage: !data.token && current?.status === 'error' ? current.statusMessage : null,
      };
      if (inboxChanged && previousInboxId) {
        blockWaitingIntentsIn(tx, { inboxId: previousInboxId }, 'The sending inbox changed after this message was approved.');
      }
      if (current) {
        if (data.token) {
          tx.db
            .prepare("UPDATE connector SET settings = ?, secret = ?, status = 'connected', updated_at = ? WHERE id = ?")
            .run(JSON.stringify(settings), data.token, now, current.id);
        } else {
          tx.db.prepare('UPDATE connector SET settings = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(settings), now, current.id);
        }
        tx.audit('connector.configure', 'connector', current.id, {
          kind: 'agentmail',
          tokenReplaced: Boolean(data.token),
          inboxSelected: Boolean(chosen),
          inboxChanged,
        });
        if (inboxId) activateMailProviderIfUnsetIn(tx, 'agentmail');
        return false;
      }
      const created = tx.newId('con');
      tx.db
        .prepare(
          "INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES (?, ?, ?, 'agentmail', ?, ?, 'connected', ?)",
        )
        .run(created, now, tx.workspaceId, JSON.stringify(settings), data.token ?? '', now);
      tx.audit('connector.configure', 'connector', created, {
        kind: 'agentmail',
        tokenReplaced: true,
        inboxSelected: Boolean(chosen),
        inboxChanged,
      });
      if (inboxId) activateMailProviderIfUnsetIn(tx, 'agentmail');
      return true;
    });
  let created: boolean;
  try {
    created = save();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('internal', 'The key is valid, but it could not be saved to the local database.');
  }
  return { connector: getConnector(ctx.db, ctx.workspaceId, 'agentmail')!, created };
}

// Queued and approved intents become blocked. An intent that is being submitted, or whose outcome is unknown,
// keeps its state because the message may already be out. The reason is added to its error text.
export function disconnectAgentmailConnector(ctx: ActionContext): void {
  if (!getConnector(ctx.db, ctx.workspaceId, 'agentmail')) throw notFound('AgentMail connector');
  mutate(ctx, (tx) => {
    const row = tx.db.prepare('SELECT id FROM connector WHERE workspace_id = ? AND kind = ?').get(tx.workspaceId, 'agentmail') as
      | { id: string }
      | undefined;
    if (!row) throw notFound('AgentMail connector');
    const wasActive = getActiveMailConnector(tx.db, tx.workspaceId)?.kind === 'agentmail';
    const blocked = blockWaitingIntentsIn(tx, { provider: 'agentmail' }, reasonCodes.connectorRemoved);
    const inFlight = tx.db
      .prepare("SELECT id, status FROM send_intent WHERE workspace_id = ? AND provider = 'agentmail' AND status IN ('submitting', 'unknown')")
      .all(tx.workspaceId) as { id: string; status: 'submitting' | 'unknown' }[];
    for (const intent of inFlight) {
      transitionIntentIn(
        tx,
        intent.id,
        [intent.status],
        intent.status,
        { appendError: reasonCodes.connectorRemoved },
        'connector_removed',
        { reason: reasonCodes.connectorRemoved },
      );
    }
    tx.db.prepare('DELETE FROM connector WHERE id = ?').run(row.id);
    reassignMailProviderAfterRemovalIn(tx, wasActive);
    tx.audit('connector.disconnect', 'connector', row.id, { kind: 'agentmail', intentsBlocked: blocked, intentsInFlight: inFlight.length });
  });
}

// A rejected key flips the connector to "error" so Settings can ask for a new one. It only does so
// when the key that failed is still the saved one.
export function markAgentmailError(ctx: ActionContext, failedKey: string): void {
  mutate(ctx, (tx) => {
    const row = tx.db
      .prepare("SELECT id, settings, secret FROM connector WHERE workspace_id = ? AND kind = 'agentmail' AND status != 'error'")
      .get(tx.workspaceId) as { id: string; settings: string; secret: string } | undefined;
    if (!row || row.secret !== failedKey) return;
    const settings = { ...(JSON.parse(row.settings) as Record<string, unknown>), statusMessage: agentmailKeyRejectedMessage };
    tx.db.prepare("UPDATE connector SET status = 'error', settings = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(settings), tx.now(), row.id);
    tx.audit('connector.error', 'connector', row.id, { kind: 'agentmail', reason: 'token_rejected' });
  });
}

// The saved key and connector for a provider call, or a conflict a person can fix in Settings.
export function requireAgentmail(ctx: ActionContext): { apiKey: string; connector: AgentmailConnector } {
  const connector = getConnector(ctx.db, ctx.workspaceId, 'agentmail');
  const apiKey = getConnectorSecret(ctx.db, ctx.workspaceId, 'agentmail');
  if (!connector || !apiKey) throw conflict(connectAgentmailMessage);
  if (connector.status === 'error') throw conflict('AgentMail rejected the saved key. Update it in Settings.');
  return { apiKey, connector };
}

export async function listAgentmailInboxes(ctx: ActionContext) {
  const { apiKey } = requireAgentmail(ctx);
  try {
    const inboxes = await fetchAllInboxes(apiKey);
    return { items: inboxes.map((inbox) => ({ id: inbox.inboxId, email: inbox.email })), nextCursor: null };
  } catch (error) {
    if (error instanceof AgentmailError && error.kind === 'unauthorized') markAgentmailError(ctx, apiKey);
    throw mapAgentmailError(error);
  }
}

const createInboxSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, numbers, dots, dashes, and underscores')
      .optional(),
  })
  .strict();

// The client id is built from the workspace and the username, so asking twice returns the same inbox.
export async function createAgentmailInbox(ctx: ActionContext, input: unknown): Promise<{ id: string; email: string }> {
  const data = parseInput(createInboxSchema, input ?? {});
  const { apiKey } = requireAgentmail(ctx);
  let inbox: MailInbox;
  try {
    inbox = await createInbox(apiKey, {
      clientId: `agentcrm-${ctx.workspaceId}-${(data.username ?? 'default').toLowerCase()}`,
      ...(data.username ? { username: data.username } : {}),
    });
  } catch (error) {
    if (error instanceof AgentmailError && error.kind === 'unauthorized') markAgentmailError(ctx, apiKey);
    throw mapAgentmailError(error);
  }
  mutate(ctx, (tx: Tx) => {
    tx.audit('connector.inbox_create', 'connector', 'agentmail', { username: data.username ?? null });
  });
  return { id: inbox.inboxId, email: inbox.email };
}
