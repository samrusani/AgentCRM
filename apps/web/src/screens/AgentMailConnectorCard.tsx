import { useEffect, useState, type FormEvent } from 'react';
import {
  useCreateMailInbox,
  useMailInboxes,
  useMailProvider,
  useRemoveAgentMailConnector,
  useSaveAgentMailConnector,
} from '../api/hooks';
import type { Connector } from '../api/types';
import { errorMessage } from '../components/common';
import { CONNECTOR_MARKS, CardToggle, RemoveControl, TokenForm, TokenLine, useCardOpen } from '../components/connector';
import { UseMailProvider, mailCardState } from '../components/mailProvider';
import { DAILY_SEND_CAP } from '../lib/mail';

function InboxSection({ connector }: { connector: Connector }) {
  const inboxes = useMailInboxes(true);
  const select = useSaveAgentMailConnector();
  const create = useCreateMailInbox();
  const [chosen, setChosen] = useState(connector.inboxId ?? '');
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState('');

  const items = inboxes.data ?? [];
  const savedId = connector.inboxId ?? '';

  // Follow the saved inbox when it changes elsewhere, without discarding an unsaved choice otherwise.
  useEffect(() => {
    setChosen(savedId);
  }, [savedId]);

  const chosenInbox = items.find((inbox) => inbox.id === chosen) ?? null;
  const dirty = chosen !== '' && chosen !== savedId;

  const useInbox = () => {
    if (!chosenInbox) return;
    select.mutate({ inboxId: chosenInbox.id, inboxEmail: chosenInbox.email });
  };

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    create.mutate(username.trim() || undefined, {
      onSuccess: (inbox) => {
        setUsername('');
        setCreating(false);
        if (inbox) setChosen(inbox.id);
      },
    });
  };

  return (
    <div className="connector__form">
      <h4 className="connector__heading" id="agentmail-inbox-heading">
        Sending inbox
      </h4>
      <p>
        {connector.inboxId ? (
          <>
            Sending from <span className="cell-name">{connector.inboxEmail ?? connector.inboxId}</span>
          </>
        ) : (
          <span className="muted">
            No inbox is selected. Choose one or create one. Nothing can be prepared for sending until an inbox is
            selected.
          </span>
        )}
      </p>

      {inboxes.isPending ? (
        <p className="muted" role="status">
          Loading inboxes...
        </p>
      ) : null}
      {inboxes.isError ? (
        <div role="alert">
          <p className="inline-error">{errorMessage(inboxes.error)} The inbox list did not load.</p>
          <button type="button" className="btn" onClick={() => void inboxes.refetch()}>
            Retry
          </button>
        </div>
      ) : null}
      {inboxes.isSuccess && items.length === 0 ? (
        <p className="muted">This AgentMail account has no inboxes yet. Create one below.</p>
      ) : null}

      {items.length > 0 ? (
        <>
          <label className="connector__label" htmlFor="agentmail-inbox">
            Inbox
          </label>
          <div className="connector__row">
            <select
              id="agentmail-inbox"
              className="input"
              value={chosen}
              disabled={select.isPending}
              onChange={(event) => setChosen(event.target.value)}
            >
              {savedId === '' || chosen === '' ? <option value="">Choose an inbox</option> : null}
              {savedId !== '' && !items.some((inbox) => inbox.id === savedId) ? (
                <option value={savedId}>{connector.inboxEmail ?? savedId}</option>
              ) : null}
              {items.map((inbox) => (
                <option key={inbox.id} value={inbox.id}>
                  {inbox.email}
                </option>
              ))}
            </select>
            <button type="button" className="btn" disabled={!dirty || select.isPending} onClick={useInbox}>
              {select.isPending ? 'Saving...' : 'Use inbox'}
            </button>
          </div>
        </>
      ) : null}
      {select.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(select.error)} The sending inbox did not change.
        </p>
      ) : null}

      {creating ? (
        <form className="connector__form" onSubmit={submitCreate}>
          <label className="connector__label" htmlFor="agentmail-username">
            Username (optional)
          </label>
          <div className="connector__row">
            <input
              id="agentmail-username"
              className="input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="Leave empty to let AgentMail choose"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <button type="submit" className="btn" disabled={create.isPending}>
              {create.isPending ? 'Creating...' : 'Create inbox'}
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              disabled={create.isPending}
              onClick={() => {
                setCreating(false);
                setUsername('');
              }}
            >
              Cancel
            </button>
          </div>
          <p className="muted">Creating an inbox makes a new address on your AgentMail account.</p>
        </form>
      ) : (
        <div>
          <button type="button" className="btn btn--quiet" onClick={() => setCreating(true)}>
            Create inbox
          </button>
        </div>
      )}
      {create.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(create.error)} No inbox was created.
        </p>
      ) : null}
      {create.isSuccess && !creating ? (
        <p className="muted" role="status">
          Inbox created{create.data ? ` as ${create.data.email}` : ''}. Choose Use inbox to send from it.
        </p>
      ) : null}
    </div>
  );
}

export function AgentMailConnectorCard({ connector }: { connector: Connector | null }) {
  const connect = useSaveAgentMailConnector();
  const remove = useRemoveAgentMailConnector();
  const hasError = connector?.status === 'error';
  const active = useMailProvider().data ?? null;

  const submitToken = async (token: string): Promise<boolean> => {
    try {
      await connect.mutateAsync({ token });
      return true;
    } catch {
      return false;
    }
  };

  const [open, toggle] = useCardOpen(connector);
  // Collapsed, the card still says which address sends, or that none is selected yet.
  const summary = connector ? (connector.inboxEmail ?? connector.inboxId ?? 'no inbox selected') : null;

  return (
    <article className="connector" aria-label="AgentMail connector">
      <CardToggle
        name="AgentMail"
        mark={CONNECTOR_MARKS.agentmail}
        markActive={active?.kind === 'agentmail'}
        summary={summary}
        state={mailCardState('agentmail', connector, active)}
        open={open}
        onToggle={toggle}
        bodyId="agentmail-card-body"
      />

      {open ? (
        <div className="connector__body" id="agentmail-card-body">
      {connector ? (
        <TokenLine connector={connector} noun="key" />
      ) : (
        <p className="muted">
          Connect your own AgentMail account to send the drafts you approve. Each message is sent only after you
          approve its exact text. Agents cannot send.
        </p>
      )}

      {hasError ? (
        <p className="inline-error" role="alert">
          {connector?.statusMessage ?? 'The last check of this key failed. Reconnect with a valid key.'}
        </p>
      ) : null}

      <TokenForm
        idPrefix="agentmail"
        provider="AgentMail"
        connected={Boolean(connector)}
        busy={connect.isPending}
        error={connect.isError ? connect.error : null}
        onSubmit={submitToken}
        noun="key"
        destination="the configured AgentMail endpoint"
      />

      {connector ? <InboxSection connector={connector} /> : null}

      <UseMailProvider kind="agentmail" name="AgentMail" connector={connector} active={active} />

      <p className="muted">
        AgentMail applies its own daily sending limits to your account. This app also stops at{' '}
        <span className="num">{DAILY_SEND_CAP}</span> accepted sends per inbox per day.
      </p>

      {connector ? (
        <RemoveControl
          provider="AgentMail"
          mutation={{ isPending: remove.isPending, isError: remove.isError, error: remove.error, mutate: () => remove.mutate() }}
          warning="Remove AgentMail and delete the stored key? Messages that are queued or approved will be blocked and will not send. Sent messages and replies already stored stay."
        />
      ) : null}
        </div>
      ) : null}
    </article>
  );
}
