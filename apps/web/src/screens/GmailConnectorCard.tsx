import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGmailConnector,
  useMailProvider,
  useRemoveGmailConnector,
  useSaveGmailConnector,
  useStartGmailOAuth,
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
  access_denied: 'Google sign in was cancelled or denied, so Gmail is not connected.',
  invalid_state: 'The Google sign in could not be matched to this app, so it was discarded. Start it again.',
  state_mismatch: 'The Google sign in could not be matched to this app, so it was discarded. Start it again.',
  expired: 'The Google sign in took too long and expired. Start it again.',
};

function oauthErrorSentence(code: string, statusMessage: string | null): string {
  if (statusMessage) return statusMessage;
  return OAUTH_ERRORS[code] ?? `Google sign in did not finish (${code}). Start it again.`;
}

const SETUP_STEPS = [
  'Open the Google Cloud console and create a project, any name.',
  'Enable the Gmail API: APIs and services, Library, Gmail API, Enable.',
  'Configure the OAuth consent screen as External with an app name and your email address. You do not need to submit it for verification.',
  'Add yourself as a test user on the consent screen. Only test users can sign in while the app is in Testing status.',
  'Create the client: Credentials, Create credentials, OAuth client ID, application type Desktop app. Copy the client id and client secret.',
  'Paste both below, save them, then select Sign in with Google.',
];

function SetupSteps() {
  return (
    <details className="connector__howto">
      <summary>How to create the OAuth client</summary>
      <ol className="connector__howto-steps">
        {SETUP_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="muted">
        The full walkthrough, with the limits worth knowing, is the document <code>docs/connect-gmail.md</code> in the
        AgentCRM repository.
      </p>
    </details>
  );
}

function Consequences() {
  return (
    <div className="connector__form">
      <p className="muted">
        While your Google client is in Testing status, Google expires the sign in every seven days and you sign in
        again. Publishing it without verification avoids that, but Google then shows an unverified app warning during
        sign in. Both are expected for a client you own.
      </p>
      <p className="muted">This app asks Google for two permissions:</p>
      <ul className="connector__scopes muted">
        <li>
          <code>gmail.send</code>: send the messages you approve.
        </li>
        <li>
          <code>gmail.readonly</code>: read replies and bounces, and check for an existing message after an unclear
          send so nothing goes out twice.
        </li>
      </ul>
    </div>
  );
}

export function GmailConnectorCard({
  oauthError,
  onDismissOauthError,
}: {
  // The code Google's callback left in the page address, if any.
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
  const { query, connector } = useGmailConnector(waiting !== null);
  const active = useMailProvider().data ?? null;
  const save = useSaveGmailConnector();
  const start = useStartGmailOAuth();
  const remove = useRemoveGmailConnector();

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  const hasError = connector?.status === 'error';
  const signedIn = Boolean(connector?.emailAddress);
  const hasCredentials = Boolean(connector);
  const dirty = clientId.trim() !== '' || clientSecret.trim() !== '';
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
      setSignInFailure(connector.statusMessage ?? 'The Google sign in did not finish. Start it again.');
    }
  }, [connector, waiting, queryClient]);

  const submitCredentials = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending || clientId.trim() === '' || clientSecret.trim() === '') return;
    save.mutate(
      { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
      {
        onSuccess: () => {
          setClientId('');
          setClientSecret('');
        },
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
          const entry = result.data?.find((item) => item.kind === 'gmail') ?? null;
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
          {connector?.statusMessage ?? 'Google rejected the stored sign in. Sign in again.'}
        </p>
      ) : connector?.statusMessage ? (
        // A note on a connected account, such as the sync gap after Gmail could not replay old mail.
        <p className="muted" role="status">
          {connector.statusMessage}
        </p>
      ) : null}

      {waiting ? (
        <div className="connector__notice connector__notice--waiting" role="status">
          <span>
            Waiting for Google. Finish signing in in the tab that opened, then come back here. This card updates when
            you do.
          </span>
          <span className="muted">
            If no tab opened, your browser may have blocked it.{' '}
            <a className="link" href={waiting.url} target="_blank" rel="noopener noreferrer">
              Open Google sign in
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
          Stopped waiting for Google. If you finished signing in, reload this page to see the result.
        </p>
      ) : null}
      {justSignedIn && signedIn ? (
        <p role="status">
          Signed in as <span className="cell-name">{connector?.emailAddress}</span>.
        </p>
      ) : null}
      {start.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(start.error)} Google sign in did not start.
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
            Replies are read from the inbox, so a reply that Gmail files to spam or that a filter archives is not seen.
          </p>

          <UseMailProvider kind="gmail" name="Gmail" connector={connector} active={active} />

          <div className="connector__row">
            <button
              type="button"
              className={hasError ? 'btn btn--primary' : 'btn'}
              disabled={start.isPending || waiting !== null}
              onClick={signIn}
            >
              {start.isPending ? 'Starting...' : hasError ? 'Sign in with Google again' : 'Reconnect'}
            </button>
          </div>
          {hasError ? <Consequences /> : null}
        </>
      ) : (
        <>
          <p className="muted">
            Connect your own Gmail account to send the drafts you approve and to read replies. You create the Google
            OAuth client yourself, so your mailbox access stays between you and Google. Each message is sent only
            after you approve its exact text. Agents cannot send.
          </p>
          <SetupSteps />

          {hasCredentials ? (
            <p className="connector__token">
              Client id <span className="num">{connector?.clientId ?? 'stored locally'}</span>, client secret stored
              locally
              {connector?.updatedAt ? <span className="muted">, updated {formatAgo(connector.updatedAt)}</span> : null}
            </p>
          ) : null}

          <form className="connector__form" onSubmit={submitCredentials}>
            <label className="connector__label" htmlFor="gmail-client-id">
              {hasCredentials ? 'New client id' : 'Client id'}
            </label>
            <input
              id="gmail-client-id"
              className="input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            />
            <label className="connector__label" htmlFor="gmail-client-secret">
              {hasCredentials ? 'New client secret' : 'Client secret'}
            </label>
            <div className="connector__row">
              <input
                id="gmail-client-secret"
                className="input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                aria-describedby="gmail-secret-note"
              />
              <button
                type="submit"
                className="btn"
                disabled={save.isPending || clientId.trim() === '' || clientSecret.trim() === ''}
              >
                {save.isPending ? 'Saving...' : hasCredentials ? 'Replace credentials' : 'Save credentials'}
              </button>
            </div>
            <p className="muted" id="gmail-secret-note">
              The client secret and the tokens Google issues are stored unencrypted in the local database file on this
              computer and are sent only to Google. Anyone who can read that file can read them. Saving does not
              contact Google.
            </p>
            {save.isError ? (
              <p className="inline-error" role="alert">
                {errorMessage(save.error)} The credentials were not saved.
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
                {start.isPending ? 'Starting...' : 'Sign in with Google'}
              </button>
            </div>
            {!hasCredentials ? <p className="muted">Save the client id and secret first.</p> : null}
            {hasCredentials && dirty ? <p className="muted">Save the new credentials before signing in.</p> : null}
          </div>

          <Consequences />
        </>
      )}

      <p className="muted">
        Google applies its own daily sending limits to your account, and they differ between consumer and Workspace
        accounts. This app also stops at <span className="num">{DAILY_SEND_CAP}</span> accepted sends per inbox per
        day.
      </p>

      {connector ? (
        <RemoveControl
          provider="Gmail"
          mutation={{ isPending: remove.isPending, isError: remove.isError, error: remove.error, mutate: () => remove.mutate() }}
          warning="Remove Gmail and delete the stored client secret and tokens? Messages that are queued or approved to be sent with Gmail will be blocked and will not send. Sent messages and replies already stored stay. To end Google's side of the access, also revoke it in your Google account permissions."
        />
      ) : null}
    </>
  );

  return (
    <article className="connector" aria-label="Gmail connector">
      <CardToggle
        name="Gmail"
        mark={CONNECTOR_MARKS.gmail}
        markActive={active?.kind === 'gmail'}
        summary={summary}
        state={mailCardState(
          'gmail',
          connector,
          active,
          connector && !signedIn ? { tone: 'off', label: 'Sign in needed' } : undefined,
        )}
        open={open}
        onToggle={toggle}
        bodyId="gmail-card-body"
      />
      {open ? (
        <div className="connector__body" id="gmail-card-body">
          {query.isError ? (
            <p className="inline-error" role="alert">
              {errorMessage(query.error)} The Gmail connection could not be checked.
            </p>
          ) : null}
          {body}
        </div>
      ) : null}
    </article>
  );
}
