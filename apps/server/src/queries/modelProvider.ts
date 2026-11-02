import type { Db } from '../db.js';
import { readSettings } from '../qualification/config.js';
import { isModelConnectorKind, listConnectors, type ModelConnector } from './connectors.js';

export function listModelConnectors(db: Db, workspaceId: string): ModelConnector[] {
  return listConnectors(db, workspaceId).filter((connector): connector is ModelConnector => isModelConnectorKind(connector.kind));
}

// The chosen provider is stored in workspace.settings.modelProvider. A missing or stale choice falls back to
// the first connected model provider, so a workspace that predates the setting keeps working.
export function getActiveModelConnector(db: Db, workspaceId: string): ModelConnector | null {
  const connectors = listModelConnectors(db, workspaceId);
  const chosen = readSettings(db, workspaceId).modelProvider;
  return connectors.find((connector) => connector.kind === chosen) ?? connectors[0] ?? null;
}

// A provider can run work only when it is connected without an error and, for Ollama, a model is chosen.
function isModelReady(connector: ModelConnector): boolean {
  return connector.status === 'connected' && (connector.kind !== 'ollama' || Boolean(connector.settings.model));
}

// What crm_describe reports as modelConnected: an active provider that can run work right now.
export function isActiveModelReady(db: Db, workspaceId: string): boolean {
  const active = getActiveModelConnector(db, workspaceId);
  return active ? isModelReady(active) : false;
}

export interface ActiveModelProvider {
  kind: string;
  model: string | null;
  status: 'connected' | 'error';
  statusMessage: string | null;
  ready: boolean;
}

export function readActiveModelProvider(db: Db, workspaceId: string): ActiveModelProvider | null {
  const active = getActiveModelConnector(db, workspaceId);
  return active
    ? {
        kind: active.kind,
        model: active.settings.model,
        status: active.status,
        statusMessage: active.statusMessage,
        ready: isModelReady(active),
      }
    : null;
}

// What crm_describe reports. The kind, the status, and the model only. Never a key and never an address.
export function describeModelProvider(db: Db, workspaceId: string) {
  const active = getActiveModelConnector(db, workspaceId);
  return active
    ? { configured: true as const, kind: active.kind, status: active.status, model: active.settings.model, ready: isModelReady(active) }
    : { configured: false as const };
}
