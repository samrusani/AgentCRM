import type { Db } from '../db.js';
import { isMailProviderKind, type MailProviderKind } from '../providers/mailTypes.js';
import { readSettings } from '../qualification/config.js';
import { type AgentmailConnector, type GmailConnector, listConnectors } from './connectors.js';

export type MailConnector = AgentmailConnector | GmailConnector;

export function isMailConnector(connector: { kind: string }): connector is MailConnector {
  return isMailProviderKind(connector.kind);
}

// The account a connector sends from. AgentMail has an inbox id and an address. Gmail's account id is its address.
export interface MailAccount {
  kind: MailProviderKind;
  connectorId: string;
  status: 'connected' | 'error';
  statusMessage: string | null;
  accountId: string | null;
  address: string | null;
  lastSyncAt: string | null;
  // Connected, no error, and a sending address. This is what every mail surface treats as "mail is available".
  ready: boolean;
}

export function mailAccountOf(connector: MailConnector): MailAccount {
  const accountId = connector.kind === 'agentmail' ? connector.settings.inboxId : connector.settings.address?.toLowerCase() ?? null;
  const address = connector.kind === 'agentmail' ? connector.settings.inboxEmail : connector.settings.address?.toLowerCase() ?? null;
  return {
    kind: connector.kind,
    connectorId: connector.id,
    status: connector.status,
    statusMessage: connector.statusMessage,
    accountId,
    address,
    lastSyncAt: connector.settings.lastSyncAt,
    ready: connector.status === 'connected' && Boolean(accountId) && Boolean(address),
  };
}

export function listMailConnectors(db: Db, workspaceId: string): MailConnector[] {
  return listConnectors(db, workspaceId).filter(isMailConnector);
}

// The chosen provider is stored in workspace.settings.mailProvider. A missing or stale choice falls back to the first
// mail connector that is ready, then to the first one, so a workspace that predates the setting keeps working.
export function getActiveMailConnector(db: Db, workspaceId: string): MailConnector | null {
  const connectors = listMailConnectors(db, workspaceId);
  const chosen = readSettings(db, workspaceId).mailProvider;
  return (
    connectors.find((connector) => connector.kind === chosen) ??
    connectors.find((connector) => mailAccountOf(connector).ready) ??
    connectors[0] ??
    null
  );
}

export function getActiveMailAccount(db: Db, workspaceId: string): MailAccount | null {
  const connector = getActiveMailConnector(db, workspaceId);
  return connector ? mailAccountOf(connector) : null;
}

export function getMailAccount(db: Db, workspaceId: string, kind: MailProviderKind): MailAccount | null {
  const connector = listMailConnectors(db, workspaceId).find((item) => item.kind === kind);
  return connector ? mailAccountOf(connector) : null;
}

export interface ActiveMailProvider {
  kind: MailProviderKind;
  address: string | null;
  ready: boolean;
  lastSyncAt: string | null;
}

export function readActiveMailProvider(db: Db, workspaceId: string): ActiveMailProvider | null {
  const account = getActiveMailAccount(db, workspaceId);
  return account ? { kind: account.kind, address: account.address, ready: account.ready, lastSyncAt: account.lastSyncAt } : null;
}
