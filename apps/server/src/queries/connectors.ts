import type { Db } from '../db.js';
import { defaultModel, isSupportedModel, type ModelId } from '../providers/anthropic.js';
import { isModelProviderKind, type ModelProviderKind } from '../providers/modelTypes.js';
import { defaultModelId, isOfferedModel, providerLabels } from '../providers/presets.js';
import { type Row } from '../records.js';

export type ModelConnectorKind = ModelProviderKind;
export type KeyedModelKind = 'anthropic' | 'openai' | 'deepseek' | 'zai';
export type ConnectorKind = 'apify' | 'agentmail' | 'gmail' | 'microsoft' | ModelConnectorKind;

// Actor ids for the LinkedIn lead capture run. Settings hold only the ids a person changed; reads fill in the defaults.
export interface LeadCaptureActors {
  postActor: string;
  reactionsActor: string;
  commentsActor: string;
  profileActor: string;
}

export const defaultLeadCaptureActors: LeadCaptureActors = {
  postActor: 'apimaestro/linkedin-post-detail',
  reactionsActor: 'harvestapi/linkedin-post-reactions',
  commentsActor: 'harvestapi/linkedin-post-comments',
  profileActor: 'harvestapi/linkedin-profile-scraper',
};

export const leadCaptureActorFields = ['postActor', 'reactionsActor', 'commentsActor', 'profileActor'] as const;

export interface ApifyConnectorSettings {
  allowlist: string[];
  username: string | null;
  // The effective ids, defaults applied.
  leadCapture: LeadCaptureActors;
}

export interface AnthropicConnectorSettings {
  model: ModelId;
}

export interface KeyedModelConnectorSettings {
  model: string;
}

export interface OllamaConnectorSettings {
  baseUrl: string;
  // Null until a person picks one of the installed models.
  model: string | null;
}

export interface AgentmailConnectorSettings {
  inboxId: string | null;
  inboxEmail: string | null;
  // High water marks for the inbound sync. Neither one is a secret.
  lastMessageTimestamp: string | null;
  seenEventId: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

// What the sign in with Google flow keeps in settings between start and callback. Never sent to the browser.
export interface GmailPendingAuth {
  state: string;
  verifier: string;
  createdAt: string;
  // Where the browser goes after the callback: a loopback origin that started the flow, or null for a relative redirect.
  returnOrigin: string | null;
}

// Safe to send to the browser: no secret, no token, no verifier. The Microsoft connector has the same shape, because
// it is a public client with no client secret.
export interface GmailConnectorSettings {
  clientId: string | null;
  // The signed in account. Null until the sign in finishes.
  emailAddress: string | null;
  // The same value, under the name the mail provider uses for it.
  address: string | null;
  signedIn: boolean;
  oauthPending: boolean;
  // When a sign in last finished successfully. The card waits for this to change, so a failed attempt is not
  // mistaken for a success.
  oauthCompletedAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

// Settings hold the allowlist, the account name, the model choice, and the last error sentence. They never hold the secret.
// The secret never leaves this module through a response. Only getConnectorSecret reads it.
export function maskToken(token: string): string {
  return token.length > 4 ? `****${token.slice(-4)}` : '****';
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const errorMessages: Record<ConnectorKind, string> = {
  apify: 'Apify rejected the saved API token.',
  anthropic: 'Anthropic rejected the saved API key.',
  openai: 'OpenAI rejected the saved API key.',
  deepseek: 'DeepSeek rejected the saved API key.',
  zai: 'Z.ai rejected the saved API key.',
  ollama: 'The Ollama server rejected the request.',
  agentmail: 'AgentMail rejected the saved API key.',
  gmail: 'Google no longer accepts the saved sign in.',
  microsoft: 'Microsoft no longer accepts the saved sign in.',
};

interface ConnectorBase {
  id: string;
  workspaceId: string;
  status: 'connected' | 'error';
  statusMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

type WithToken = ConnectorBase & { tokenMasked: string };

export type ApifyConnector = WithToken & { kind: 'apify'; settings: ApifyConnectorSettings };
export type AnthropicConnector = WithToken & { kind: 'anthropic'; settings: AnthropicConnectorSettings };
export type OpenAiConnector = WithToken & { kind: 'openai'; settings: KeyedModelConnectorSettings };
export type DeepseekConnector = WithToken & { kind: 'deepseek'; settings: KeyedModelConnectorSettings };
export type ZaiConnector = WithToken & { kind: 'zai'; settings: KeyedModelConnectorSettings };
// Ollama has no key, so its shape has no tokenMasked.
export type OllamaConnector = ConnectorBase & { kind: 'ollama'; settings: OllamaConnectorSettings };
export type AgentmailConnector = WithToken & { kind: 'agentmail'; settings: AgentmailConnectorSettings };
// Gmail keeps a client secret and tokens as one JSON secret. Only the masked client secret is ever shown.
export type GmailConnector = ConnectorBase & { kind: 'gmail'; clientSecretMasked: string | null; settings: GmailConnectorSettings };

// Microsoft is a public client: the only credential is the application id, and the secret column holds the tokens.
export type MicrosoftConnector = ConnectorBase & { kind: 'microsoft'; settings: GmailConnectorSettings };

export interface ConnectorByKind {
  apify: ApifyConnector;
  anthropic: AnthropicConnector;
  openai: OpenAiConnector;
  deepseek: DeepseekConnector;
  zai: ZaiConnector;
  ollama: OllamaConnector;
  agentmail: AgentmailConnector;
  gmail: GmailConnector;
  microsoft: MicrosoftConnector;
}

export type Connector = ConnectorByKind[ConnectorKind];
export type ModelConnector = ConnectorByKind[ModelConnectorKind];

export function isModelConnectorKind(value: unknown): value is ModelConnectorKind {
  return isModelProviderKind(value);
}

export const defaultOllamaServer = 'http://127.0.0.1:11434';

export interface GmailSecret {
  clientSecret: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
}

export function parseGmailSecret(value: unknown): GmailSecret | null {
  const parsed = parseObject(value);
  const string = (key: string): string | null => (typeof parsed[key] === 'string' && parsed[key] !== '' ? (parsed[key] as string) : null);
  const clientSecret = string('clientSecret');
  if (!clientSecret) return null;
  return { clientSecret, accessToken: string('accessToken'), refreshToken: string('refreshToken'), expiresAt: string('expiresAt') };
}

export interface MicrosoftSecret {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
}

export function parseMicrosoftSecret(value: unknown): MicrosoftSecret {
  const parsed = parseObject(value);
  const string = (key: string): string | null => (typeof parsed[key] === 'string' && parsed[key] !== '' ? (parsed[key] as string) : null);
  return { accessToken: string('accessToken'), refreshToken: string('refreshToken'), expiresAt: string('expiresAt') };
}

function isPendingAuth(value: unknown): value is GmailPendingAuth {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).state === 'string' &&
    typeof (value as Record<string, unknown>).verifier === 'string' &&
    typeof (value as Record<string, unknown>).createdAt === 'string'
  );
}

export function readGmailPending(settings: Record<string, unknown>): GmailPendingAuth | null {
  const pending = settings.pending;
  if (!isPendingAuth(pending)) return null;
  const origin = (pending as unknown as Record<string, unknown>).returnOrigin;
  return { state: pending.state, verifier: pending.verifier, createdAt: pending.createdAt, returnOrigin: typeof origin === 'string' ? origin : null };
}

// The stored settings and secret of the Gmail connector, for the code that runs the sign in and the sync. Never send
// the result to a client.
export function getGmailInternals(
  db: Db,
  workspaceId: string,
): { id: string; status: 'connected' | 'error'; settings: Record<string, unknown>; secret: GmailSecret | null } | null {
  const row = db.prepare("SELECT id, status, settings, secret FROM connector WHERE workspace_id = ? AND kind = 'gmail'").get(workspaceId) as
    | { id: string; status: 'connected' | 'error'; settings: string; secret: string }
    | undefined;
  return row ? { id: row.id, status: row.status, settings: parseObject(row.settings), secret: parseGmailSecret(row.secret) } : null;
}

// The stored settings and secret of the Microsoft connector, for the code that runs the sign in and the sync. Never send
// the result to a client.
export function getMicrosoftInternals(
  db: Db,
  workspaceId: string,
): { id: string; status: 'connected' | 'error'; settings: Record<string, unknown>; secret: MicrosoftSecret } | null {
  const row = db.prepare("SELECT id, status, settings, secret FROM connector WHERE workspace_id = ? AND kind = 'microsoft'").get(workspaceId) as
    | { id: string; status: 'connected' | 'error'; settings: string; secret: string }
    | undefined;
  return row ? { id: row.id, status: row.status, settings: parseObject(row.settings), secret: parseMicrosoftSecret(row.secret) } : null;
}

export function toConnector(row: Row): Connector {
  const kind = String(row.kind) as ConnectorKind;
  const stored = parseObject(row.settings);
  const status = String(row.status) as 'connected' | 'error';
  const base: ConnectorBase = {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    status,
    statusMessage: status === 'error' ? (typeof stored.statusMessage === 'string' ? stored.statusMessage : errorMessages[kind]) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  const withToken = { ...base, tokenMasked: maskToken(String(row.secret)) };
  if (kind === 'anthropic') {
    return { ...withToken, kind, settings: { model: isSupportedModel(stored.model) ? stored.model : defaultModel } };
  }
  if (kind === 'openai' || kind === 'deepseek' || kind === 'zai') {
    return { ...withToken, kind, settings: { model: isOfferedModel(kind, stored.model) ? stored.model : defaultModelId(kind) } };
  }
  if (kind === 'ollama') {
    return {
      ...base,
      kind,
      settings: {
        baseUrl: typeof stored.baseUrl === 'string' && stored.baseUrl !== '' ? stored.baseUrl : defaultOllamaServer,
        model: typeof stored.model === 'string' && stored.model !== '' ? stored.model : null,
      },
    };
  }
  if (kind === 'gmail') {
    const field = (key: string): string | null => (typeof stored[key] === 'string' && stored[key] !== '' ? (stored[key] as string) : null);
    const secret = parseGmailSecret(row.secret);
    const emailAddress = field('emailAddress');
    return {
      ...base,
      kind,
      // A note about a possible sync gap is shown on a connected account too, so the message is not limited to errors.
      statusMessage: field('statusMessage') ?? (status === 'error' ? errorMessages.gmail : null),
      clientSecretMasked: secret?.clientSecret ? maskToken(secret.clientSecret) : null,
      settings: {
        clientId: field('clientId'),
        emailAddress,
        address: emailAddress,
        signedIn: Boolean(emailAddress && secret?.refreshToken),
        oauthPending: isPendingAuth(stored.pending),
        oauthCompletedAt: field('oauthCompletedAt'),
        lastSyncAt: field('lastSyncAt'),
        lastSyncError: field('lastSyncError'),
      },
    };
  }
  if (kind === 'microsoft') {
    const field = (key: string): string | null => (typeof stored[key] === 'string' && stored[key] !== '' ? (stored[key] as string) : null);
    const secret = parseMicrosoftSecret(row.secret);
    const emailAddress = field('emailAddress');
    return {
      ...base,
      kind,
      // A note about a possible sync gap is shown on a connected account too, so the message is not limited to errors.
      statusMessage: field('statusMessage') ?? (status === 'error' ? errorMessages.microsoft : null),
      settings: {
        clientId: field('clientId'),
        emailAddress,
        address: emailAddress,
        signedIn: Boolean(emailAddress && secret.refreshToken),
        oauthPending: isPendingAuth(stored.pending),
        oauthCompletedAt: field('oauthCompletedAt'),
        lastSyncAt: field('lastSyncAt'),
        lastSyncError: field('lastSyncError'),
      },
    };
  }
  if (kind === 'agentmail') {
    const field = (key: string): string | null => (typeof stored[key] === 'string' && stored[key] !== '' ? (stored[key] as string) : null);
    return {
      ...withToken,
      kind,
      settings: {
        inboxId: field('inboxId'),
        inboxEmail: field('inboxEmail'),
        lastMessageTimestamp: field('lastMessageTimestamp'),
        seenEventId: field('seenEventId'),
        lastSyncAt: field('lastSyncAt'),
        lastSyncError: field('lastSyncError'),
      },
    };
  }
  const storedLeadCapture =
    typeof stored.leadCapture === 'object' && stored.leadCapture !== null && !Array.isArray(stored.leadCapture)
      ? (stored.leadCapture as Record<string, unknown>)
      : {};
  const leadCapture = { ...defaultLeadCaptureActors };
  for (const field of leadCaptureActorFields) {
    const value = storedLeadCapture[field];
    if (typeof value === 'string' && value.trim() !== '') leadCapture[field] = value.trim();
  }
  return {
    ...withToken,
    kind: 'apify',
    settings: {
      allowlist: Array.isArray(stored.allowlist) ? stored.allowlist.filter((item): item is string => typeof item === 'string') : [],
      username: typeof stored.username === 'string' ? stored.username : null,
      leadCapture,
    },
  };
}

export function getConnector<K extends ConnectorKind>(db: Db, workspaceId: string, kind: K): ConnectorByKind[K] | null {
  const row = db.prepare('SELECT * FROM connector WHERE workspace_id = ? AND kind = ?').get(workspaceId, kind) as
    | Row
    | undefined;
  return row ? (toConnector(row) as ConnectorByKind[K]) : null;
}

export function listConnectors(db: Db, workspaceId: string): Connector[] {
  return (
    db.prepare('SELECT * FROM connector WHERE workspace_id = ? ORDER BY created_at, id').all(workspaceId) as Row[]
  ).map(toConnector);
}

// Only code that calls the provider may use this. Do not put the result in a response, audit row, or log line.
export function getConnectorSecret(db: Db, workspaceId: string, kind: ConnectorKind): string | null {
  const row = db.prepare('SELECT secret FROM connector WHERE workspace_id = ? AND kind = ?').get(workspaceId, kind) as
    | { secret: string }
    | undefined;
  return row ? row.secret : null;
}

export function connectorLabel(kind: ModelConnectorKind): string {
  return providerLabels[kind];
}
