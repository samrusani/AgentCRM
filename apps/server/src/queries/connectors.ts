import type { Db } from '../db.js';
import { type Row } from '../records.js';

export type ConnectorKind = 'apify';

export interface ConnectorSettings {
  allowlist: string[];
  username: string | null;
}

interface StoredSettings extends ConnectorSettings {
  statusMessage: string | null;
}

// Settings hold the allowlist, the account name, and the last error sentence. They never hold the token.
// The secret never leaves this module through a response. Only getConnectorSecret reads it.
export function maskToken(token: string): string {
  return token.length > 4 ? `****${token.slice(-4)}` : '****';
}

function parseSettings(value: unknown): StoredSettings {
  try {
    const parsed = JSON.parse(String(value)) as Partial<StoredSettings>;
    return {
      allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist.filter((item) => typeof item === 'string') : [],
      username: typeof parsed.username === 'string' ? parsed.username : null,
      statusMessage: typeof parsed.statusMessage === 'string' ? parsed.statusMessage : null,
    };
  } catch {
    return { allowlist: [], username: null, statusMessage: null };
  }
}

export function toConnector(row: Row) {
  const { statusMessage, ...settings } = parseSettings(row.settings);
  const status = String(row.status) as 'connected' | 'error';
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    kind: String(row.kind) as ConnectorKind,
    status,
    statusMessage: status === 'error' ? (statusMessage ?? 'Apify rejected the saved API token.') : null,
    settings,
    tokenMasked: maskToken(String(row.secret)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export type Connector = ReturnType<typeof toConnector>;

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
