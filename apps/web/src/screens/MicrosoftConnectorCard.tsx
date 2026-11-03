import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useMailProvider,
  useMicrosoftConnector,
  useRemoveMicrosoftConnector,
  useSaveMicrosoftConnector,
  useStartMicrosoftOAuth,
} from '../api/hooks';
import { errorMessage } from '../components/common';
import { CONNECTOR_MARKS, CardToggle, RemoveControl, useCardOpen } from '../components/connector';
import { UseMailProvider, mailCardState } from '../components/mailProvider';
import { formatAgo } from '../lib/format';
import { DAILY_SEND_CAP } from '../lib/mail';

interface SignInBaseline {
  completedAt: string | null;
  updatedAt: string | null;
}

// Stop polling after this long. The user can start the sign in again.
const WAIT_LIMIT_MS = 10 * 60 * 1000;

const OAUTH_ERRORS: Record<string, string> = {
  access_denied: 'Microsoft sign in was cancelled or denied, so Microsoft 365 is not connected.',
  invalid_state: 'The Microsoft sign in could not be matched to this app, so it was discarded. Start it again.',
  state_mismatch: 'The Microsoft sign in could not be matched to this app, so it was discarded. Start it again.',
  expired: 'The Microsoft sign in took too long and expired. Start it again.',
};

function oauthErrorSentence(code: string, statusMessage: string | null): string {
  if (statusMessage) return statusMessage;
  return OAUTH_ERRORS[code] ?? `Microsoft sign in did not finish (${code}). Start it again.`;
}

const SETUP_STEPS = [
  'Open the Microsoft Entra admin center (entra.microsoft.com), then Identity, Applications, App registrations, New registration. Any name works.',
  'Under Supported account types, choose "Accounts in any organizational directory and personal Microsoft accounts".',
  'After registering, open Authentication, add a platform, choose "Mobile and desktop applications", and enter the full redirect URI http://localhost/api/connectors/microsoft/oauth/callback. Microsoft ignores the port for localhost but matches the path, so do not stop at http://localhost.',
  'Still under Authentication, set "Allow public client flows" to Yes and save. No client secret is needed.',
  'Copy the Application (client) id from the Overview page, paste it below, save it, then select Sign in with Microsoft.',
];

function SetupSteps() {
  return (
    <details className="connector__howto">
      <summary>How to register the app in Microsoft Entra</summary>
      <ol className="connector__howto-steps">
        {SETUP_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="muted">
        The full walkthrough, with the permissions and limits worth knowing, is the document{' '}
        <code>docs/connect-microsoft.md</code> in the AgentCRM repository.
      </p>
    </details>
  );
}

function AdminConsentNote() {
  return (
    <p className="muted">
      A work or school tenant may require an administrator to approve the permissions this app asks for. If yours does,
      Microsoft&apos;s own error will say so, and this card repeats it. A personal account does not need an administrator.
    </p>
  );
}

export function MicrosoftConnectorCard({
  oauthError,
  onDismissOauthError,
}: {
  // The code Microsoft's callback left in the page address, if any.
  oauthError: string | null;
  onDismissOauthError: () => void;
}) {
  const queryClient = useQueryClient();
  // baseline is what the connector held once the sign in had started: the time it last finished a sign in, and the
  // time it last changed. undefined means it is still being read.
  const [waiting, setWaiting] = useState<{ url: string; baseline: SignInBaseline | undefined } | null>(null);
  const [stoppedWaiting, setStoppedWaiting] = useState(false);
  // The sentence for a sign in that ended without finishing, taken from the connector.
  const [signInFailure, setSignInFailure] = useState<string | null>(null);
  const [justSignedIn, setJustSignedIn] = useState(false);
  const { query, connector } = useMicrosoftConnector(waiting !== null);
  const active = useMailProvider().data ?? null;
  const save = useSaveMicrosoftConnector();
  const start = useStartMicrosoftOAuth();
  const remove = useRemoveMicrosoftConnector();

  const [clientId, setClientId] = useState('');

  const hasError = connector?.status === 'error';
  const signedIn = Boolean(connector?.emailAddress);
  const hasCredentials = Boolean(connector);
  const dirty = clientId.trim() !== '';
  // A sign in error in the page address opens the card once, and the user may collapse it afterwards.
  const [openedByError] = useState(oauthError !== null);
  const [open, toggle] = useCardOpen(connector, openedByError);

  // The user finishes in the other tab. Refetch when they return, and notice when the connector changes.
  useEffect(() => {
    if (!waiting) return;
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ['connectors'] });
    window.addEventListener('focus', refresh);
    const timer = window.setTimeout(() => {
      setWaiting(null);
      setStoppedWaiting(true);
    }, WAIT_LIMIT_MS);
    return () => {
      window.removeEventListener('focus', refresh);
      window.clearTimeout(timer);
    };
  }, [waiting, queryClient]);

  // Success is the server's own completion time changing. A failed attempt only moves updatedAt and leaves a sentence on
  // the connector, so that is shown as the failure and the wait ends. A sign in that did not finish is never shown as done.
  useEffect(() => {
    if (!waiting || waiting.baseline === undefined || !connector) return;
    const { baseline } = waiting;
    if (connector.oauthCompletedAt !== null && connector.oauthCompletedAt !== baseline.completedAt) {
      setWaiting(null);
      setJustSignedIn(true);
      void queryClient.invalidateQueries({ queryKey: ['mail-provider'] });
    } else if (connector.updatedAt !== baseline.updatedAt) {
      setWaiting(null);
      setSignInFailure(connector.statusMessage ?? 'The Microsoft sign in did not finish. Start it again.');
    }
  }, [connector, waiting, queryClient]);

  const submitCredentials = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending || clientId.trim() === '') return;
    save.mutate(
      { clientId: clientId.trim() },
      {
        onSuccess: () => setClientId(''),
      },
    );
  };

  const signIn = () => {
    if (start.isPending) return;
    setStoppedWaiting(false);
    setJustSignedIn(false);
    setSignInFailure(null);
    onDismissOauthError();
    start.mutate(undefined, {
      onSuccess: (url) => {
        const opened = window.open(url, '_blank');
        if (opened) opened.opener = null;
        setWaiting({ url, baseline: undefined });
        // Read the connector after the server persisted the pending sign in, so only later changes count as done.
        void query.refetch().then((result) => {
          const entry = result.data?.find((item) => item.kind === 'microsoft') ?? null;
          const source = result.isError ? connector : entry;
          setWaiting((current) =>
            current ? { ...current, baseline: { completedAt: source?.oauthCompletedAt ?? null, updatedAt: source?.updatedAt ?? null } } : current,
          );
        });
      },
    });
  };

  const summary = connector ? (connector.emailAddress ?? 'sign in needed') : null;
  const body = (
    <>
      {oauthError !== null ? (
        <div className="connector__notice connector__notice--error" role="alert">
          <span>{oauthErrorSentence(oauthError, connector?.statusMessage ?? null)}</span>
          <div>
            <button type="button" className="btn btn--quiet" onClick={onDismissOauthError}>
              Dismiss
            </button>
          </div>
        </div>
      ) : signInFailure !== null ? (
        <p className="inline-error" role="alert">
          {signInFailure}
        </p>
      ) : hasError ? (
        <p className="inline-error" role="alert">
          {connector?.statusMessage ?? 'Microsoft rejected the stored sign in. Sign in again.'}
        </p>
      ) : connector?.statusMessage ? (
        // A note on a connected account, such as the sync gap after Microsoft could not replay old mail.
        <p className="muted" role="status">
          {connector.statusMessage}
        </p>
      ) : null}

      {waiting ? (
        <div className="connector__notice connector__notice--waiting" role="status">
          <span>
            Waiting for Microsoft. Finish signing in in the tab that opened, then come back here. This card updates when
            you do.
          </span>
          <span className="muted">
            If no tab opened, your browser may have blocked it.{' '}
            <a className="link" href={waiting.url} target="_blank" rel="noopener noreferrer">
              Open Microsoft sign in
            </a>
          </span>
          <div>
            <button type="button" className="btn btn--quiet" onClick={() => setWaiting(null)}>
              Stop waiting
            </button>
          </div>
        </div>
      ) : null}
      {stoppedWaiting && !waiting ? (
        <p className="muted" role="status">
          Stopped waiting for Microsoft. If you finished signing in, reload this page to see the result.
        </p>
      ) : null}
      {justSignedIn && signedIn ? (
        <p role="status">
          Signed in as <span className="cell-name">{connector?.emailAddress}</span>.
        </p>
      ) : null}
      {start.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(start.error)} Microsoft sign in did not start.
        </p>
      ) : null}

      {signedIn && connector ? (
        <>
          <p>
            Sending from <span className="cell-name">{connector.emailAddress}</span>
          </p>
          <p className="muted">
            {connector.lastSyncAt ? `Last synced ${formatAgo(connector.lastSyncAt)}.` : 'Not synced yet.'}
            {connector.clientId ? (
              <>
                {' '}
                Client id <span className="num">{connector.clientId}</span>.
              </>
            ) : null}
          </p>

          <p className="muted">
            Replies are read from the inbox, so a reply that Outlook files to junk or that a filter archives is not seen.
          </p>

          <UseMailProvider kind="microsoft" name="Microsoft 365" connector={connector} active={active} />

          <div className="connector__row">
            <button
              type="button"
              className={hasError ? 'btn btn--primary' : 'btn'}
              disabled={start.isPending || waiting !== null}
              onClick={signIn}
            >
              {start.isPending ? 'Starting...' : hasError ? 'Sign in with Microsoft again' : 'Reconnect'}
            </button>
          </div>
          {hasError ? <AdminConsentNote /> : null}
        </>
      ) : (
        <>
          <p className="muted">
            Connect your own Microsoft 365 or Outlook.com mailbox to send the drafts you approve and to read replies.
            You register the app in Microsoft Entra yourself, so your mailbox access stays between you and Microsoft.
            Each message is sent only after you approve its exact text. Agents cannot send.
          </p>
          <SetupSteps />

          {hasCredentials ? (
            <p className="connector__token">
              Client id <span className="num">{connector?.clientId ?? 'stored locally'}</span>
              {connector?.updatedAt ? <span className="muted">, updated {formatAgo(connector.updatedAt)}</span> : null}
            </p>
          ) : null}

          <form className="connector__form" onSubmit={submitCredentials}>
            <label className="connector__label" htmlFor="microsoft-client-id">
              {hasCredentials ? 'New client id' : 'Client id'}
            </label>
            <div className="connector__row">
              <input
                id="microsoft-client-id"
                className="input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                aria-describedby="microsoft-client-note"
              />
              <button type="submit" className="btn" disabled={save.isPending || clientId.trim() === ''}>
                {save.isPending ? 'Saving...' : hasCredentials ? 'Replace client id' : 'Save client id'}
              </button>
            </div>
            <p className="muted" id="microsoft-client-note">
              The client id and the tokens Microsoft issues are stored unencrypted in the local database file on this
              computer and are sent only to Microsoft. Anyone who can read that file can read them. Saving does not
              contact Microsoft.
            </p>
            {save.isError ? (
              <p className="inline-error" role="alert">
                {errorMessage(save.error)} The client id was not saved.
              </p>
            ) : null}
          </form>

          <div className="connector__form">
            <div className="connector__row">
              <button
                type="button"
                className="btn btn--primary"
                disabled={!hasCredentials || dirty || start.isPending || waiting !== null}
                onClick={signIn}
              >
                {start.isPending ? 'Starting...' : 'Sign in with Microsoft'}
              </button>
            </div>
            {!hasCredentials ? <p className="muted">Save the client id first.</p> : null}
            {hasCredentials && dirty ? <p className="muted">Save the new client id before signing in.</p> : null}
          </div>

          <AdminConsentNote />
        </>
      )}

      <p className="muted">
        Microsoft applies its own sending limits: 10,000 recipients per day per Microsoft 365 mailbox and 30 messages
        per minute. Limits for personal accounts are not published. This app also stops at{' '}
        <span className="num">{DAILY_SEND_CAP}</span> accepted sends per inbox per day.
      </p>

      {connector ? (
        <RemoveControl
          provider="Microsoft 365"
          mutation={{ isPending: remove.isPending, isError: remove.isError, error: remove.error, mutate: () => remove.mutate() }}
          warning="Remove Microsoft 365 and delete the stored client id and tokens? Messages that are queued or approved to be sent with Microsoft 365 will be blocked and will not send. Sent messages and replies already stored stay. To end Microsoft's side of the access, also revoke it in your Microsoft account permissions."
        />
      ) : null}
    </>
  );

  return (
    <article className="connector" aria-label="Microsoft 365 connector">
      <CardToggle
        name="Microsoft 365"
        mark={CONNECTOR_MARKS.microsoft}
        markActive={active?.kind === 'microsoft'}
        summary={summary}
        state={mailCardState(
          'microsoft',
          connector,
          active,
          connector && !signedIn ? { tone: 'off', label: 'Sign in needed' } : undefined,
        )}
        open={open}
        onToggle={toggle}
        bodyId="microsoft-card-body"
      />
      {open ? (
        <div className="connector__body" id="microsoft-card-body">
          {query.isError ? (
            <p className="inline-error" role="alert">
              {errorMessage(query.error)} The Microsoft 365 connection could not be checked.
            </p>
          ) : null}
          {body}
        </div>
      ) : null}
    </article>
  );
}
