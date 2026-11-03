import { z } from 'zod';
import { conflict } from '../errors.js';
import { reasonCodes } from '../mail/rules.js';
import { mailProviderKinds, mailProviderLabels, type MailProviderKind } from '../providers/mailTypes.js';
import { readSettings } from '../qualification/config.js';
import {
  type ActiveMailProvider,
  type MailAccount,
  getActiveMailConnector,
  getMailAccount,
  listMailConnectors,
  mailAccountOf,
  readActiveMailProvider,
} from '../queries/mailProvider.js';
import { type ActionContext, mutate, parseInput, type Tx } from './context.js';
import { stopRulesForProviderIn } from './followupRules.js';
import { blockWaitingIntentsIn } from './sendIntentState.js';

function writeChoiceIn(tx: Tx, kind: MailProviderKind | null): void {
  const settings = { ...readSettings(tx.db, tx.workspaceId) };
  if (kind === null) delete settings.mailProvider;
  else settings.mailProvider = kind;
  tx.db.prepare('UPDATE workspace SET settings = ? WHERE id = ?').run(JSON.stringify(settings), tx.workspaceId);
  tx.audit('mail_provider.set', 'workspace', tx.workspaceId, { kind });
  tx.emit({ type: 'record_updated', entityType: 'mail_provider', entityId: tx.workspaceId });
}

// Called when a mail connector becomes ready to send: AgentMail with an inbox chosen, or Gmail or Microsoft with a finished sign in.
// Connecting a second provider never moves sending. When no provider is stored yet (a workspace that predates the
// setting, or a choice that points at a removed connector), the provider already sending is stored first, using the
// same fallback the queries use: the first other connector that is ready. Only a workspace with no other ready mail
// connector takes the new one, because then nothing is sending that could move.
export function activateMailProviderIfUnsetIn(tx: Tx, kind: MailProviderKind): void {
  const chosen = readSettings(tx.db, tx.workspaceId).mailProvider;
  const connectors = listMailConnectors(tx.db, tx.workspaceId);
  if (connectors.some((connector) => connector.kind === chosen)) return;
  const inUse = connectors.find((connector) => connector.kind !== kind && mailAccountOf(connector).ready);
  writeChoiceIn(tx, inUse?.kind ?? kind);
}

// Called after a mail connector row is deleted. Only the provider in use moves the choice.
export function reassignMailProviderAfterRemovalIn(tx: Tx, wasActive: boolean): void {
  if (!wasActive) return;
  const remaining = listMailConnectors(tx.db, tx.workspaceId);
  const next = remaining.find((connector) => mailAccountOf(connector).ready) ?? remaining[0];
  writeChoiceIn(tx, next?.kind ?? null);
}

export function isActiveMailProviderIn(tx: Tx, kind: MailProviderKind): boolean {
  return getActiveMailConnector(tx.db, tx.workspaceId)?.kind === kind;
}

export function getMailProvider(ctx: ActionContext): ActiveMailProvider | null {
  return readActiveMailProvider(ctx.db, ctx.workspaceId);
}

function notReadySentence(kind: MailProviderKind, account: MailAccount): string {
  const label = mailProviderLabels[kind];
  if (account.status === 'error') {
    return `${label} needs attention before it can be used: ${account.statusMessage ?? 'it no longer accepts the saved credentials.'}`;
  }
  if (kind === 'agentmail') return 'AgentMail has no inbox selected. Select an inbox in Settings before making it the mail provider in use.';
  if (kind === 'imap') {
    return 'The IMAP and SMTP account is not verified. Connect it in Settings and check that both logins work before making it the mail provider in use.';
  }
  return kind === 'microsoft'
    ? 'Microsoft needs a sign in. Sign in with Microsoft in Settings before making it the mail provider in use.'
    : 'Gmail needs a sign in. Sign in with Google in Settings before making it the mail provider in use.';
}

const setProviderSchema = z.object({ kind: z.enum(mailProviderKinds) }).strict();

// Switches the provider in use. Messages that were queued for another provider are blocked, never re-routed: they
// were approved to leave from one account, and they must not leave from a different one.
export function setMailProvider(ctx: ActionContext, input: unknown): ActiveMailProvider {
  const { kind } = parseInput(setProviderSchema, input);
  mutate(ctx, (tx) => {
    const account = getMailAccount(tx.db, tx.workspaceId, kind);
    if (!account) {
      throw conflict(`${mailProviderLabels[kind]} is not connected. Connect it in Settings before making it the mail provider in use.`);
    }
    // A provider that cannot send yet would leave every approved message blocked, so it cannot be put in use.
    if (!account.ready) throw conflict(notReadySentence(kind, account));
    writeChoiceIn(tx, kind);
    const blocked = blockWaitingIntentsIn(tx, { notProvider: kind }, reasonCodes.connectorRemoved);
    if (blocked > 0) tx.audit('mail_provider.intents_blocked', 'workspace', tx.workspaceId, { kind, blocked });
    // A follow-up rule belongs to the provider that sent its first message. It does not move to another one.
    stopRulesForProviderIn(tx, { notProvider: kind }, 'connector_changed');
  });
  return getMailProvider(ctx)!;
}
