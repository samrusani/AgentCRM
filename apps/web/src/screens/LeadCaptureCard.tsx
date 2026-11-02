import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApifyConnector, useStartLeadCapture } from '../api/hooks';
import type { LeadSource, Run } from '../api/types';
import { errorMessage } from '../components/common';
import {
  ACCEPTED_POST_SHAPES,
  DEFAULT_ENRICH_LIMIT,
  DEFAULT_MAX_PEOPLE,
  MAX_ENRICH_LIMIT,
  MAX_PEOPLE,
  isLinkedinPostUrl,
  parseLimit,
  withHttps,
} from '../lib/leads';

// The Research entry for LinkedIn lead capture. The server validates every field again.
export function LeadCaptureCard({ onStarted }: { onStarted: (run: Run) => void }) {
  const { query, connector } = useApifyConnector();
  const start = useStartLeadCapture();
  const [url, setUrl] = useState('');
  const [reactions, setReactions] = useState(true);
  const [comments, setComments] = useState(true);
  const [maxPeople, setMaxPeople] = useState(String(DEFAULT_MAX_PEOPLE));
  const [enrich, setEnrich] = useState(true);
  const [enrichLimit, setEnrichLimit] = useState(String(DEFAULT_ENRICH_LIMIT));

  const typed = url.trim() !== '';
  const fullUrl = withHttps(url);
  const urlOk = isLinkedinPostUrl(fullUrl);
  const people = parseLimit(maxPeople, MAX_PEOPLE);
  const cap = parseLimit(enrichLimit, MAX_ENRICH_LIMIT);

  // The first problem found is the one shown. An empty URL disables the button without a reason line.
  let reason: ReactNode = null;
  if (query.isError) {
    reason = (
      <>
        Could not check the Apify connection. Retry from <Link className="link" to="/settings/connectors">Settings</Link>.
      </>
    );
  } else if (query.isSuccess && !connector) {
    reason = (
      <>
        Apify is not connected. <Link className="link" to="/settings/connectors">Connect Apify in Settings</Link> to
        capture leads.
      </>
    );
  } else if (connector?.status === 'error') {
    reason = (
      <>
        The Apify token was rejected. <Link className="link" to="/settings/connectors">Reconnect Apify in Settings</Link>.
      </>
    );
  } else if (typed && !urlOk) {
    reason = `This does not look like a LinkedIn post. Use a link such as ${ACCEPTED_POST_SHAPES}.`;
  } else if (!reactions && !comments) {
    reason = 'Choose reactions, comments, or both.';
  } else if (people === null) {
    reason = `People per source must be a whole number from 1 to ${MAX_PEOPLE}.`;
  } else if (enrich && cap === null) {
    reason = `The enrichment limit must be a whole number from 1 to ${MAX_ENRICH_LIMIT}.`;
  }

  const ready = Boolean(connector) && connector?.status !== 'error';
  const canStart = ready && urlOk && reason === null && !start.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canStart || people === null) return;
    const sources: LeadSource[] = [];
    if (reactions) sources.push('reactions');
    if (comments) sources.push('comments');
    start.mutate(
      {
        postUrl: fullUrl,
        sources,
        maxPeople: people,
        enrich,
        ...(enrich && cap !== null ? { enrichLimit: cap } : {}),
      },
      { onSuccess: onStarted },
    );
  };

  return (
    <section className="lead-capture" aria-labelledby="lead-capture-title">
      <h2 className="lead-capture__title" id="lead-capture-title">
        From a LinkedIn post
      </h2>
      <form className="connector__form" onSubmit={submit} noValidate>
        <label className="sr-only" htmlFor="lead-capture-url">
          LinkedIn post URL
        </label>
        <input
          id="lead-capture-url"
          className="input"
          type="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste a LinkedIn post URL"
          value={url}
          aria-invalid={typed && !urlOk}
          aria-describedby="lead-capture-reason"
          onChange={(event) => setUrl(event.target.value)}
        />

        <div className="lead-capture__group" role="group" aria-labelledby="lead-capture-include">
          <span className="connector__label" id="lead-capture-include">
            Include
          </span>
          <div className="lead-capture__row">
            <label className="toggle">
              <input type="checkbox" checked={reactions} onChange={(event) => setReactions(event.target.checked)} />
              <span>People who reacted</span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={comments} onChange={(event) => setComments(event.target.checked)} />
              <span>People who commented</span>
            </label>
          </div>
        </div>

        <div className="lead-capture__field">
          <label className="connector__label" htmlFor="lead-capture-max">
            People per source
          </label>
          <input
            id="lead-capture-max"
            className="input input--number"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_PEOPLE}
            value={maxPeople}
            aria-invalid={people === null}
            onChange={(event) => setMaxPeople(event.target.value)}
          />
        </div>

        <div className="lead-capture__row lead-capture__row--align">
          <label className="toggle">
            <input type="checkbox" checked={enrich} onChange={(event) => setEnrich(event.target.checked)} />
            <span>Enrich new people</span>
          </label>
          <span className="muted" aria-hidden="true">
            up to
          </span>
          <label className="sr-only" htmlFor="lead-capture-enrich-limit">
            Most new people to enrich
          </label>
          <input
            id="lead-capture-enrich-limit"
            className="input input--number"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_ENRICH_LIMIT}
            value={enrichLimit}
            disabled={!enrich}
            aria-invalid={enrich && cap === null}
            onChange={(event) => setEnrichLimit(event.target.value)}
          />
        </div>

        <div>
          <button type="submit" className="btn btn--primary" disabled={!canStart}>
            {start.isPending ? 'Starting...' : 'Capture leads'}
          </button>
        </div>
        <p className={reason ? 'muted' : 'sr-only'} id="lead-capture-reason" aria-live="polite">
          {reason}
        </p>
        {start.isError ? (
          <p className="inline-error" role="alert">
            Could not start the capture. {errorMessage(start.error)}
          </p>
        ) : null}
      </form>
      <p className="muted lead-capture__note">
        Runs on your own Apify account. Store prices for the default actors as of November 2026: engagement from $1.50
        per 1,000 results, profile details from $4.00 per 1,000. Item caps bind only pay per result actors; the run
        timeout limits the rest.
      </p>
    </section>
  );
}
