import type { Db } from '../db.js';
import { defaultModel, isSupportedModel, type ModelId } from '../providers/anthropic.js';
import { isModelProviderKind, type ModelProviderKind } from '../providers/modelTypes.js';
import { defaultModelId, isOfferedModel, providerLabels } from '../providers/presets.js';
import { type Row } from '../records.js';

export type ModelConnectorKind = ModelProviderKind;
export type KeyedModelKind = 'anthropic' | 'openai' | 'deepseek' | 'zai';
export type ConnectorKind = 'apify' | 'agentmail' | ModelConnectorKind;

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

export interface ConnectorByKind {
  apify: ApifyConnector;
  anthropic: AnthropicConnector;
  openai: OpenAiConnector;
  deepseek: DeepseekConnector;
  zai: ZaiConnector;
  ollama: OllamaConnector;
  agentmail: AgentmailConnector;
}

export type Connector = ConnectorByKind[ConnectorKind];
export type ModelConnector = ConnectorByKind[ModelConnectorKind];

export function isModelConnectorKind(value: unknown): value is ModelConnectorKind {
  return isModelProviderKind(value);
}

export const defaultOllamaServer = 'http://127.0.0.1:11434';

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
