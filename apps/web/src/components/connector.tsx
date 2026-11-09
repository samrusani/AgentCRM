import { useState, type FormEvent, type ReactNode } from 'react';
import type { Connector } from '../api/types';
import { formatAgo } from '../lib/format';
import { errorMessage } from './common';
import { Icon } from './Icons';

export interface CardState {
  tone: 'accent' | 'danger' | 'neutral' | 'off';
  label: string;
}

// Two letter marks for the card identity badges. Plain initials, not brand logos.
export const CONNECTOR_MARKS: Record<string, string> = {
  anthropic: 'An',
  openai: 'Oa',
  deepseek: 'De',
  zai: 'Z',
  ollama: 'Ol',
  apify: 'Ap',
  agentmail: 'Am',
  gmail: 'Gm',
  microsoft: 'Ms',
  imap: 'Im',
  backblaze: 'Bz',
  extension: 'Bx',
};

// The card header is a disclosure: collapsed it still names the card, a short summary, and its state.
export function CardToggle({
  name,
  mark,
  markActive = false,
  summary,
  state,
  open,
  onToggle,
  bodyId,
}: {
  name: string;
  mark: string;
  markActive?: boolean;
  summary?: string | null;
  state: CardState;
  open: boolean;
  onToggle: () => void;
  bodyId: string;
}) {
  return (
    <h3 className="connector__name">
      <button
        type="button"
        className="connector__toggle"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={onToggle}
      >
        <span className={`connector__mark${markActive ? ' connector__mark--accent' : ''}`} aria-hidden="true">
          {mark}
        </span>
        <span className="connector__title">{name}</span>
        {!open && summary ? <span className="connector__summary">{summary}</span> : null}
        <span className={`connector__state connector__state--${state.tone}`}>
          <span className="connector__state-dot" aria-hidden="true" />
          {state.label}
        </span>
        <Icon name="chevronRight" className={`connector__chevron${open ? ' is-open' : ''}`} />
      </button>
    </h3>
  );
}

// Open when the user says so; a card whose connection has an error opens on its own so the problem is not hidden.
export function useCardOpen(connector: Connector | null, forceOpen = false): [boolean, () => void] {
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? (connector?.status === 'error' || forceOpen);
  return [open, () => setChoice(!open)];
}

export function lastFour(masked: string | null): string | null {
  if (!masked) return null;
  const tail = masked.replace(/\s/g, '').slice(-4);
  return tail || null;
}

export type SecretNoun = 'token' | 'key';

export function TokenLine({ connector, noun = 'token' }: { connector: Connector; noun?: SecretNoun }) {
  const tokenTail = lastFour(connector.tokenMasked);
  const Noun = noun === 'key' ? 'Key' : 'Token';
  return (
    <p className="connector__token">
      {tokenTail ? (
        <>
          {Noun} <span className="num" aria-hidden="true">{`••••••••${tokenTail}`}</span>
          <span className="sr-only">ending in {tokenTail}</span>
        </>
      ) : (
        `${Noun} stored locally`
      )}
      {connector.updatedAt ? <span className="muted">, updated {formatAgo(connector.updatedAt)}</span> : null}
    </p>
  );
}

export function TokenForm({
  idPrefix,
  provider,
  connected,
  busy,
  error,
  onSubmit,
  noun = 'token',
  destination,
}: {
  idPrefix: string;
  provider: string;
  connected: boolean;
  busy: boolean;
  error: unknown;
  onSubmit: (token: string) => Promise<boolean>;
  // Anthropic calls its credential a key. Apify calls it a token.
  noun?: SecretNoun;
  // Where the secret is sent. Defaults to the provider name.
  destination?: string;
}) {
  const [token, setToken] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (!value || busy) return;
    if (await onSubmit(value)) setToken('');
  };
  const label = connected ? `New API ${noun}` : `${provider} API ${noun}`;
  return (
    <form className="connector__form" onSubmit={(event) => void submit(event)}>
      <label className="connector__label" htmlFor={`${idPrefix}-token`}>
        {label}
      </label>
      <div className="connector__row">
        <input
          id={`${idPrefix}-token`}
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          aria-describedby={`${idPrefix}-token-note`}
        />
        <button type="submit" className="btn btn--primary" disabled={busy || token.trim() === ''}>
          {busy ? `Checking ${noun}...` : connected ? 'Reconnect' : 'Connect'}
        </button>
      </div>
      <p className="muted" id={`${idPrefix}-token-note`}>
        The {noun} is stored unencrypted in the local database file on this computer and is sent only to{' '}
        {destination ?? provider}. Anyone who can read that file can read the {noun}.
      </p>
      {error ? (
        <p className="inline-error" role="alert">
          {errorMessage(error)}
        </p>
      ) : null}
    </form>
  );
}

export function RemoveControl({
  provider,
  warning,
  mutation,
}: {
  provider: string;
  warning: ReactNode;
  mutation: { isPending: boolean; isError: boolean; error: unknown; mutate: () => void };
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="connector__remove">
      {confirming ? (
        <span className="run-controls__confirm" role="alert">
          {warning}
          <button
            type="button"
            className="btn btn--danger"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Removing...' : `Remove ${provider}`}
          </button>
          <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={mutation.isPending}>
            Keep connected
          </button>
        </span>
      ) : (
        <button type="button" className="btn btn--quiet" onClick={() => setConfirming(true)}>
          Remove
        </button>
      )}
      {mutation.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(mutation.error)} The connector is still in place.
        </p>
      ) : null}
    </div>
  );
}
