import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  useApifyConnector,
  useRemoveApifyConnector,
  useSaveApifyConnector,
} from '../api/hooks';
import type { Connector, LeadCaptureSettings } from '../api/types';
import { ErrorState, Loading, errorMessage } from '../components/common';
import { CONNECTOR_MARKS, CardToggle, RemoveControl, TokenForm, TokenLine, useCardOpen } from '../components/connector';
import { Icon } from '../components/Icons';
import { normalizeActorId } from '../lib/imports';
import { DEFAULT_LEAD_ACTORS } from '../lib/leads';
import { AgentMailConnectorCard } from './AgentMailConnectorCard';
import { BrowserExtensionCard } from './BrowserExtensionCard';
import { GmailConnectorCard } from './GmailConnectorCard';
import { ImapConnectorCard } from './ImapConnectorCard';
import { MicrosoftConnectorCard } from './MicrosoftConnectorCard';

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

const LEAD_FIELDS: Array<{ key: keyof LeadCaptureSettings; label: string; note?: string }> = [
  { key: 'postActor', label: 'Post text' },
  { key: 'reactionsActor', label: 'Reactions' },
  { key: 'commentsActor', label: 'Comments' },
  { key: 'profileActor', label: 'Profile enrichment' },
  { key: 'companyActor', label: 'Company lookup' },
  {
    key: 'personSearchActor',
    label: 'People search actor',
    note: 'Used by Enrich on a person with no LinkedIn profile saved. Lead capture does not use it.',
  },
];

// Actor ids compare trimmed, with a slash as a tilde, and without regard to case, as the server lowercases them. Only
// the change check uses this: what is sent on a real change stays as typed.
function sameActor(a: string, b: string): boolean {
  return (normalizeActorId(a) ?? a.trim()).toLowerCase() === (normalizeActorId(b) ?? b.trim()).toLowerCase();
}

function LeadCaptureActors({ connector }: { connector: Connector }) {
  const save = useSaveApifyConnector();
  const saved = connector.leadCapture ?? DEFAULT_LEAD_ACTORS;
  // A field holds a draft only while the user is editing it; otherwise it shows the saved value.
  const [drafts, setDrafts] = useState<Partial<Record<keyof LeadCaptureSettings, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const valueOf = (key: keyof LeadCaptureSettings) => drafts[key] ?? saved[key];
  const changed = LEAD_FIELDS.filter(({ key }) => drafts[key] !== undefined && !sameActor(drafts[key] as string, saved[key]));

  const write = (leadCapture: Partial<LeadCaptureSettings>, onDone?: () => void) => {
    save.mutate({ leadCapture }, { onSuccess: onDone });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body: Partial<LeadCaptureSettings> = {};
    for (const { key, label } of changed) {
      const raw = (drafts[key] as string).trim();
      if (raw === '') {
        body[key] = '';
        continue;
      }
      const id = normalizeActorId(raw);
      if (!id) {
        setProblem(
          `${label}: enter an actor id such as username~actor-name. Spaces, other characters, and parts that are only dots are not allowed.`,
        );
        return;
      }
      body[key] = id;
    }
    setProblem(null);
    write(body, () => setDrafts({}));
  };

  const reset = (key: keyof LeadCaptureSettings) => {
    setProblem(null);
    // An empty string asks the server to return this field to its default.
    write({ [key]: '' }, () =>
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      }),
    );
  };

  return (
    <form className="connector__allowlist" onSubmit={submit} aria-labelledby="apify-lead-heading">
      <h4 className="connector__heading" id="apify-lead-heading">
        Lead capture actors
      </h4>
      {LEAD_FIELDS.map(({ key, label, note }) => {
        const isDefault = sameActor(valueOf(key), DEFAULT_LEAD_ACTORS[key]);
        return (
          <div className="connector__form" key={key}>
            <label className="connector__label" htmlFor={`apify-lead-${key}`}>
              {label}
            </label>
            <div className="connector__row">
              <input
                id={`apify-lead-${key}`}
                className="input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={DEFAULT_LEAD_ACTORS[key]}
                value={valueOf(key)}
                onChange={(event) => {
                  setDrafts((current) => ({ ...current, [key]: event.target.value }));
                  setProblem(null);
                }}
              />
              <button
                type="button"
                className="btn btn--quiet"
                disabled={save.isPending || isDefault}
                aria-label={`Reset ${label} to default`}
                onClick={() => reset(key)}
              >
                Reset to default
              </button>
            </div>
            {note ? <p className="muted">{note}</p> : null}
          </div>
        );
      })}
      <div>
        <button type="submit" className="btn" disabled={save.isPending || changed.length === 0}>
          {save.isPending ? 'Saving...' : 'Save actors'}
        </button>
      </div>
      <p className="muted">
        These actors run on your Apify account. Agent started captures need them on the allowlist.
      </p>
      {problem ? (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      ) : null}
      {save.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(save.error)} The lead capture actors did not change.
        </p>
      ) : null}
    </form>
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
        mark={CONNECTOR_MARKS.apify}
        summary={connector ? `${allowed} ${allowed === 1 ? 'actor' : 'actors'} allowed for agents` : null}
        state={
          hasError
            ? { tone: 'danger', label: 'Error' }
            : connector
              ? { tone: 'neutral', label: 'Connected' }
              : { tone: 'off', label: 'Not connected' }
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
      {connector ? <LeadCaptureActors connector={connector} /> : null}
        </div>
      ) : null}
    </article>
  );
}

export function ConnectorSettings() {
  const { query, connector } = useApifyConnector();
  const agentmail = query.data?.find((entry) => entry.kind === 'agentmail') ?? null;
  // Google's and Microsoft's callbacks send the browser back here, with gmail_error=<code> or microsoft_error=<code> when sign in did not finish.
  const [params, setParams] = useSearchParams();
  const gmailError = params.get('gmail_error');
  const dismissGmailError = () => {
    if (!params.has('gmail_error')) return;
    const next = new URLSearchParams(params);
    next.delete('gmail_error');
    setParams(next, { replace: true });
  };

  const microsoftError = params.get('microsoft_error');
  const dismissMicrosoftError = () => {
    if (!params.has('microsoft_error')) return;
    const next = new URLSearchParams(params);
    next.delete('microsoft_error');
    setParams(next, { replace: true });
  };

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
          <GmailConnectorCard oauthError={gmailError} onDismissOauthError={dismissGmailError} />
          <MicrosoftConnectorCard oauthError={microsoftError} onDismissOauthError={dismissMicrosoftError} />
          <ImapConnectorCard />
          <BrowserExtensionCard />
        </div>
      ) : null}
    </section>
  );
}
