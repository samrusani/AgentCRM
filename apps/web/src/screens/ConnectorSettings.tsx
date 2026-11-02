import { useState, type FormEvent } from 'react';
import {
  useApifyConnector,
  useRemoveApifyConnector,
  useSaveApifyConnector,
} from '../api/hooks';
import type { Connector } from '../api/types';
import { Chip, ErrorState, Loading, errorMessage } from '../components/common';
import { CardToggle, RemoveControl, TokenForm, TokenLine, useCardOpen } from '../components/connector';
import { Icon } from '../components/Icons';
import { normalizeActorId } from '../lib/imports';
import { AgentMailConnectorCard } from './AgentMailConnectorCard';

function ApifyRemoveControl() {
  const remove = useRemoveApifyConnector();
  return (
    <RemoveControl
      provider="Apify"
      mutation={{ isPending: remove.isPending, isError: remove.isError, error: remove.error, mutate: () => remove.mutate() }}
      warning="Remove Apify and delete the stored token? Any Apify run that is still queued, running, or paused will fail, and this app will ask Apify to stop its actor run. Imports waiting for review and finished runs stay."
    />
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

function ApifyCard({ connector }: { connector: Connector | null }) {
  const save = useSaveApifyConnector();

  const connect = async (token: string): Promise<boolean> => {
    try {
      await save.mutateAsync({ token });
      return true;
    } catch {
      return false;
    }
  };

  const hasError = connector?.status === 'error';
  const [open, toggle] = useCardOpen(connector);
  const allowed = connector?.allowlist.length ?? 0;

  return (
    <article className="connector" aria-label="Apify connector">
      <CardToggle
        name="Apify"
        summary={connector ? `${allowed} ${allowed === 1 ? 'actor' : 'actors'} allowed for agents` : null}
        chip={
          hasError ? (
            <Chip tone="danger">Error</Chip>
          ) : (
            <Chip tone="neutral">{connector ? 'Connected' : 'Not connected'}</Chip>
          )
        }
        open={open}
        onToggle={toggle}
        bodyId="apify-card-body"
      />

      {open ? (
        <div className="connector__body" id="apify-card-body">
      {connector ? (
        <TokenLine connector={connector} />
      ) : (
        <p className="muted">
          Connect your own Apify account to run actors from the Apify store. Results are staged for your review before
          anything enters the CRM.
        </p>
      )}

      {hasError ? (
        <p className="inline-error" role="alert">
          {connector?.statusMessage ?? 'The last check of this token failed. Reconnect with a valid token.'}
        </p>
      ) : null}

      <TokenForm
        idPrefix="apify"
        provider="Apify"
        connected={Boolean(connector)}
        busy={save.isPending}
        error={save.isError ? save.error : null}
        onSubmit={connect}
      />

      {connector ? <ApifyRemoveControl /> : null}
      {connector ? <Allowlist connector={connector} /> : null}
        </div>
      ) : null}
    </article>
  );
}

export function ConnectorSettings() {
  const { query, connector } = useApifyConnector();
  const agentmail = query.data?.find((entry) => entry.kind === 'agentmail') ?? null;

  return (
    <section className="section" aria-labelledby="settings-connectors">
      <h2 className="section__title" id="settings-connectors">
        Connectors
      </h2>
      {query.isPending ? <Loading what="connectors" /> : null}
      {query.isError ? <ErrorState what="connectors" error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.isSuccess ? (
        <div className="connector-list">
          <ApifyCard connector={connector} />
          <AgentMailConnectorCard connector={agentmail} />
        </div>
      ) : null}
    </section>
  );
}
