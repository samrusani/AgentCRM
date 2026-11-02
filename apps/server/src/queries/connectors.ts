import type { Db } from '../db.js';
import { defaultModel, isSupportedModel, type ModelId } from '../providers/anthropic.js';
import { type Row } from '../records.js';

export type ConnectorKind = 'apify' | 'anthropic' | 'agentmail';

export interface ApifyConnectorSettings {
  allowlist: string[];
  username: string | null;
}

export interface AnthropicConnectorSettings {
  model: ModelId;
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
  agentmail: 'AgentMail rejected the saved API key.',
};

interface ConnectorBase {
  id: string;
  workspaceId: string;
  status: 'connected' | 'error';
  statusMessage: string | null;
  tokenMasked: string;
  createdAt: string;
  updatedAt: string;
}

export type ApifyConnector = ConnectorBase & { kind: 'apify'; settings: ApifyConnectorSettings };
export type AnthropicConnector = ConnectorBase & { kind: 'anthropic'; settings: AnthropicConnectorSettings };
export type AgentmailConnector = ConnectorBase & { kind: 'agentmail'; settings: AgentmailConnectorSettings };
export type Connector = ApifyConnector | AnthropicConnector | AgentmailConnector;

export function toConnector(row: Row): Connector {
  const kind = String(row.kind) as ConnectorKind;
  const stored = parseObject(row.settings);
  const status = String(row.status) as 'connected' | 'error';
  const base: ConnectorBase = {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    status,
    statusMessage: status === 'error' ? (typeof stored.statusMessage === 'string' ? stored.statusMessage : errorMessages[kind]) : null,
    tokenMasked: maskToken(String(row.secret)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  if (kind === 'anthropic') {
    return { ...base, kind, settings: { model: isSupportedModel(stored.model) ? stored.model : defaultModel } };
  }
  if (kind === 'agentmail') {
    const field = (key: string): string | null => (typeof stored[key] === 'string' && stored[key] !== '' ? (stored[key] as string) : null);
    return {
      ...base,
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
  return {
    ...base,
    kind: 'apify',
    settings: {
      allowlist: Array.isArray(stored.allowlist) ? stored.allowlist.filter((item): item is string => typeof item === 'string') : [],
      username: typeof stored.username === 'string' ? stored.username : null,
    },
  };
}

export function getConnector(db: Db, workspaceId: string, kind: 'apify'): ApifyConnector | null;
export function getConnector(db: Db, workspaceId: string, kind: 'anthropic'): AnthropicConnector | null;
export function getConnector(db: Db, workspaceId: string, kind: 'agentmail'): AgentmailConnector | null;
export function getConnector(db: Db, workspaceId: string, kind: ConnectorKind): Connector | null;
export function getConnector(db: Db, workspaceId: string, kind: ConnectorKind): Connector | null {
  const row = db.prepare('SELECT * FROM connector WHERE workspace_id = ? AND kind = ?').get(workspaceId, kind) as
    | Row
    | undefined;
  return row ? toConnector(row) : null;
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
