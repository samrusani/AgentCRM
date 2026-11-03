import { useState } from 'react';
import { useMailProviderNamer, useSendIntents, useSetMailProvider } from '../api/hooks';
import type { Connector, MailProviderKind, MailProviderSelection } from '../api/types';
import { errorMessage } from './common';
import type { CardState } from './connector';

// Same state language as the model provider cards: In use, Error, Connected, Not connected.
export function mailCardState(
  kind: MailProviderKind,
  connector: Connector | null,
  active: MailProviderSelection | null,
  extra?: CardState,
): CardState {
  if (connector?.status === 'error') return { tone: 'danger', label: 'Error' };
  if (active?.kind === kind) return { tone: 'accent', label: 'In use' };
  if (extra) return extra;
  return connector ? { tone: 'neutral', label: 'Connected' } : { tone: 'off', label: 'Not connected' };
}

// A provider can be put in use only when it can send: connected, with no error, and with a sending address.
// AgentMail needs an inbox chosen. Gmail needs a finished sign in. This is the same rule the server applies.
export function mailConnectorReady(kind: MailProviderKind, connector: Connector | null): boolean {
  if (!connector || connector.status !== 'connected') return false;
  if (kind === 'agentmail') return Boolean(connector.inboxId && connector.inboxEmail);
  // IMAP and SMTP is ready only after the last connect verified both the IMAP login and SMTP.
  if (kind === 'imap') return Boolean(connector.emailAddress && connector.imap?.imapOk && connector.imap.smtpOk);
  return Boolean(connector.emailAddress);
}

// Statuses of messages that can still go out from the provider that staged them, or are waiting for review.
const OPEN_INTENT_STATUSES = ['awaiting_approval', 'approved', 'queued'];

// Exactly one connected mail connector is in use. The one in use says so in text, the others offer a quiet switch.
// Switching blocks the open messages staged with the provider that is in use now, so it asks first when there are any.
export function UseMailProvider({
  kind,
  name,
  connector,
  active,
  usable,
}: {
  kind: MailProviderKind;
  name: string;
  connector: Connector | null;
  active: MailProviderSelection | null;
  // Defaults to the connector's own readiness. False hides the switch for a half configured provider, such as Gmail
  // before sign in or AgentMail before an inbox is chosen.
  usable?: boolean;
}) {
  const setProvider = useSetMailProvider();
  const intents = useSendIntents();
  const providerName = useMailProviderNamer();
  const [confirming, setConfirming] = useState(false);
  if (!connector) return null;
  if (active?.kind === kind) {
    return <p className="connector__use">In use for sending and replies</p>;
  }
  if (!(usable ?? mailConnectorReady(kind, connector))) return null;
  if (connector.status === 'error') return null;

  const open = active ? (intents.data ?? []).filter((intent) => intent.provider === active.kind && OPEN_INTENT_STATUSES.includes(intent.status)).length : 0;
  const activeName = providerName(active?.kind);
  const switchNow = () => setProvider.mutate(kind, { onSuccess: () => setConfirming(false) });

  return (
    <div className="connector__use">
      {confirming ? (
        <span className="run-controls__confirm" role="alert">
          {open === 1
            ? `Switching blocks 1 open message staged with ${activeName}. It will need a fresh review.`
            : `Switching blocks ${open} open messages staged with ${activeName}. They will need a fresh review.`}
          <button type="button" className="btn btn--primary" disabled={setProvider.isPending} onClick={switchNow}>
            {setProvider.isPending ? 'Switching...' : `Use ${name}`}
          </button>
          <button type="button" className="btn" disabled={setProvider.isPending} onClick={() => setConfirming(false)}>
            Keep {activeName}
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="btn btn--quiet"
          disabled={setProvider.isPending}
          aria-label={`Use this provider, ${name}`}
          onClick={() => (open > 0 ? setConfirming(true) : switchNow())}
        >
          {setProvider.isPending ? 'Switching...' : 'Use this provider'}
        </button>
      )}
      {active ? (
        <p className="muted">
          Messages already queued or approved stay with the provider that staged them and are blocked if it is no longer
          in use.
        </p>
      ) : null}
      {setProvider.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(setProvider.error)} The provider in use did not change.
        </p>
      ) : null}
    </div>
  );
}
