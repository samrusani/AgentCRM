import { createAgentmailMailProvider } from '../providers/agentmail.js';
import { createGmailMailProvider } from '../providers/gmail.js';
import { createMicrosoftMailProvider } from '../providers/microsoft.js';
import type { MailProvider, MailProviderKind } from '../providers/mailTypes.js';
import { getConnectorSecret } from '../queries/connectors.js';
import { getMailAccount, type MailAccount } from '../queries/mailProvider.js';
import { markAgentmailError } from './agentmailConnector.js';
import type { ActionContext } from './context.js';
import { createGmailTokenStore, markGmailError } from './gmailConnector.js';
import { createMicrosoftTokenStore, markMicrosoftError } from './microsoftConnector.js';

export interface MailAdapter {
  provider: MailProvider;
  account: MailAccount;
  // The credential a rejection should be matched against before the connector is marked as rejected.
  credential: string;
}

// Builds the adapter for one provider from the saved connector, or null when that provider has no usable account.
// Sending and inbound sync both come through here, so a provider is only ever reached by its own code path.
export function createMailAdapter(ctx: ActionContext, kind: MailProviderKind): MailAdapter | null {
  const account = getMailAccount(ctx.db, ctx.workspaceId, kind);
  if (!account || !account.accountId || !account.address) return null;
  if (kind === 'agentmail') {
    const apiKey = getConnectorSecret(ctx.db, ctx.workspaceId, 'agentmail');
    if (!apiKey) return null;
    return {
      account,
      credential: apiKey,
      provider: createAgentmailMailProvider({
        apiKey,
        inboxId: account.accountId,
        inboxEmail: account.address,
        workspaceId: ctx.workspaceId,
        now: ctx.now,
      }),
    };
  }
  if (kind === 'microsoft') {
    return {
      account,
      credential: '',
      provider: createMicrosoftMailProvider({
        address: account.address,
        store: createMicrosoftTokenStore(ctx),
        now: () => Date.parse(ctx.now()),
      }),
    };
  }
  return {
    account,
    credential: '',
    provider: createGmailMailProvider({
      address: account.address,
      store: createGmailTokenStore(ctx),
      now: () => Date.parse(ctx.now()),
    }),
  };
}

// A provider said its credentials are not accepted. The connector flips to "error" so Settings can ask for a new one.
export function markMailProviderRejected(ctx: ActionContext, adapter: Pick<MailAdapter, 'account' | 'credential'>): void {
  if (adapter.account.kind === 'agentmail') markAgentmailError(ctx, adapter.credential);
  else if (adapter.account.kind === 'microsoft') markMicrosoftError(ctx, 'unauthorized');
  else markGmailError(ctx, 'unauthorized');
}
