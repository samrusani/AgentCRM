import { useState, type FormEvent } from 'react';
import {
  useApifyConnector,
  useRemoveApifyConnector,
  useSaveApifyConnector,
} from '../api/hooks';
import type { Connector } from '../api/types';
import { Chip, ErrorState, Loading, errorMessage } from '../components/common';
import { Icon } from '../components/Icons';
import { formatAgo } from '../lib/format';
import { normalizeActorId } from '../lib/imports';

function lastFour(masked: string | null): string | null {
  if (!masked) return null;
  const tail = masked.replace(/\s/g, '').slice(-4);
  return tail || null;
}

function TokenForm({
  connected,
  busy,
  error,
  onSubmit,
}: {
  connected: boolean;
  busy: boolean;
  error: unknown;
  onSubmit: (token: string) => Promise<boolean>;
}) {
  const [token, setToken] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (!value || busy) return;
    if (await onSubmit(value)) setToken('');
  };
  const label = connected ? 'New API token' : 'Apify API token';
  return (
    <form className="connector__form" onSubmit={(event) => void submit(event)}>
      <label className="connector__label" htmlFor="apify-token">
        {label}
      </label>
      <div className="connector__row">
        <input
          id="apify-token"
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          aria-describedby="apify-token-note"
        />
        <button type="submit" className="btn btn--primary" disabled={busy || token.trim() === ''}>
          {busy ? 'Checking token...' : connected ? 'Reconnect' : 'Connect'}
        </button>
      </div>
      <p className="muted" id="apify-token-note">
        The token is stored unencrypted in the local database file on this computer and is sent only to Apify. Anyone who can read that file can read the token.
      </p>
      {error ? (
        <p className="inline-error" role="alert">
          {errorMessage(error)}
        </p>
      ) : null}
    </form>
  );
}

function RemoveControl() {
  const remove = useRemoveApifyConnector();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="connector__remove">
      {confirming ? (
        <span className="run-controls__confirm" role="alert">
          Remove Apify and delete the stored token? Any Apify run that is still queued, running, or paused will fail, and this app will ask Apify to stop its actor run. Imports waiting for review and finished runs stay.
          <button
            type="button"
            className="btn btn--danger"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? 'Removing...' : 'Remove Apify'}
          </button>
          <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={remove.isPending}>
            Keep connected
          </button>
        </span>
      ) : (
        <button type="button" className="btn btn--quiet" onClick={() => setConfirming(true)}>
          Remove
        </button>
      )}
      {remove.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(remove.error)} The connector is still in place.
        </p>
      ) : null}
    </div>
  );
}

function Allowlist({ connector }: { connector: Connector }) {
  const save = useSaveApifyConnector();
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const allowlist = connector.allowlist;

  const write = (next: string[], onDone?: () => void) => {
    save.mutate({ allowlist: next }, { onSuccess: onDone });
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    const id = normalizeActorId(draft);
    if (!id) {
      setProblem('Enter an actor id such as username~actor-name. Spaces, other characters, and parts that are only dots are not allowed.');
      return;
    }
    if (allowlist.includes(id)) {
      setProblem(`${id} is already on the allowlist.`);
      return;
    }
    setProblem(null);
    write([...allowlist, id], () => setDraft(''));
  };

  return (
    <div className="connector__allowlist">
      <h4 className="connector__heading" id="apify-allowlist-heading">
        Actor allowlist
      </h4>
      <p className="muted">
        Runs started by agents through MCP or chat may only use actors on this list. Runs you start yourself are not
        restricted.
      </p>
      {allowlist.length === 0 ? (
        <p className="muted">No actors are allowed. Agents cannot start Apify runs until you add one.</p>
      ) : (
        <ul className="chip-list" aria-labelledby="apify-allowlist-heading">
          {allowlist.map((id) => (
            <li key={id}>
              <span className="chip chip--neutral chip--removable">
                {id}
                <button
                  type="button"
                  className="chip__remove"
                  aria-label={`Remove ${id} from the allowlist`}
                  disabled={save.isPending}
                  onClick={() => write(allowlist.filter((entry) => entry !== id))}
                >
                  <Icon name="close" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form className="connector__row" onSubmit={add}>
        <label className="sr-only" htmlFor="apify-allow-add">
          Add an actor id to the allowlist
        </label>
        <input
          id="apify-allow-add"
          className="input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="username~actor-name"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(null);
          }}
        />
        <button type="submit" className="btn" disabled={save.isPending || draft.trim() === ''}>
          {save.isPending ? 'Saving...' : 'Add actor'}
        </button>
      </form>
      {problem ? (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      ) : null}
      {save.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(save.error)} The allowlist did not change.
        </p>
      ) : null}
    </div>
  );
}

export function ConnectorSettings() {
  const { query, connector } = useApifyConnector();
  const save = useSaveApifyConnector();

  const connect = async (token: string): Promise<boolean> => {
    try {
      await save.mutateAsync({ token });
      return true;
    } catch {
      return false;
    }
  };

  const tokenTail = lastFour(connector?.tokenMasked ?? null);
  const hasError = connector?.status === 'error';

  return (
    <section className="section" aria-labelledby="settings-connectors">
      <h2 className="section__title" id="settings-connectors">
        Connectors
      </h2>
      {query.isPending ? <Loading what="connectors" /> : null}
      {query.isError ? <ErrorState what="connectors" error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.isSuccess ? (
        <article className="connector" aria-label="Apify connector">
          <header className="connector__header">
            <h3 className="connector__name">Apify</h3>
            {connector ? (
              hasError ? (
                <Chip tone="danger">Error</Chip>
              ) : (
                <Chip tone="neutral">Connected</Chip>
              )
            ) : (
              <Chip tone="neutral">Not connected</Chip>
            )}
          </header>

          {connector ? (
            <p className="connector__token">
              {tokenTail ? (
                <>
                  Token{' '}
                  <span className="num" aria-hidden="true">{`••••••••${tokenTail}`}</span>
                  <span className="sr-only">ending in {tokenTail}</span>
                </>
              ) : (
                'Token stored locally'
              )}
              {connector.updatedAt ? <span className="muted">, updated {formatAgo(connector.updatedAt)}</span> : null}
            </p>
          ) : (
            <p className="muted">
              Connect your own Apify account to run actors from the Apify store. Results are staged for your review
              before anything enters the CRM.
            </p>
          )}

          {hasError ? (
            <p className="inline-error" role="alert">
              {connector?.statusMessage ?? 'The last check of this token failed. Reconnect with a valid token.'}
            </p>
          ) : null}

          <TokenForm
            connected={Boolean(connector)}
            busy={save.isPending}
            error={save.isError ? save.error : null}
            onSubmit={connect}
          />

          {connector ? <RemoveControl /> : null}
          {connector ? <Allowlist connector={connector} /> : null}
        </article>
      ) : null}
    </section>
  );
}
