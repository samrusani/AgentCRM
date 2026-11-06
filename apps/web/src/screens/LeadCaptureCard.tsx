import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApifyConnector, useModelProvider, useStartLeadCapture } from '../api/hooks';
import type { LeadCaptureInput, LeadSource, Run } from '../api/types';
import { errorMessage } from '../components/common';
import {
  ACCEPTED_POST_SHAPES,
  DEFAULT_ENRICH_LIMIT,
  DEFAULT_MAX_PEOPLE,
  MAX_ENRICH_LIMIT,
  MAX_PEOPLE,
  MAX_POST_TEXT_LENGTH,
  POST_TEXT_COUNT_WINDOW,
  isPostLink,
  parseLimit,
  tidyLink,
  withHttps,
} from '../lib/leads';

type Mode = 'link' | 'pasted';

const POST_LINK_REASON = `This does not look like a LinkedIn post. Use a link such as ${ACCEPTED_POST_SHAPES}.`;

function formatCharacters(count: number): string {
  return count.toLocaleString('en-US');
}

// The Research entry for LinkedIn lead capture. The server validates every field again.
export function LeadCaptureCard({ onStarted }: { onStarted: (run: Run) => void }) {
  const { query, connector } = useApifyConnector();
  const start = useStartLeadCapture();
  const provider = useModelProvider();
  const [mode, setMode] = useState<Mode>('link');
  const pasted = mode === 'pasted';
  // An error from one form does not describe the other, so switching modes clears it.
  const changeMode = (next: Mode) => {
    if (next !== mode) start.reset();
    setMode(next);
  };
  // Reading the post uses the model provider, so the post source needs a ready one. While the provider is still
  // loading, or when none is ready, the box is off and disabled. Once ready it defaults on until the person unticks it.
  const providerReady = provider.data?.ready === true;
  const [postChoice, setPostChoice] = useState<boolean | null>(null);
  const post = providerReady && (postChoice ?? true);
  const [url, setUrl] = useState('');
  const [reactions, setReactions] = useState(true);
  const [comments, setComments] = useState(true);
  const [text, setText] = useState('');
  const [textCut, setTextCut] = useState(false);
  const [provenance, setProvenance] = useState('');
  const [maxPeople, setMaxPeople] = useState(String(DEFAULT_MAX_PEOPLE));
  // A link capture enriches by default. A pasted capture starts with enrichment off, because it works with no Apify account.
  const [enrichLink, setEnrichLink] = useState(true);
  const [enrichPasted, setEnrichPasted] = useState(false);
  const enrich = pasted ? enrichPasted : enrichLink;
  const setEnrich = pasted ? setEnrichPasted : setEnrichLink;
  const [enrichLimit, setEnrichLimit] = useState(String(DEFAULT_ENRICH_LIMIT));

  const typed = url.trim() !== '';
  const fullUrl = withHttps(tidyLink(url));
  const urlOk = isPostLink(fullUrl);
  const hasText = text.trim() !== '';
  const provenanceTyped = provenance.trim() !== '';
  const fullProvenance = withHttps(tidyLink(provenance));
  const provenanceOk = !provenanceTyped || isPostLink(fullProvenance);
  const people = parseLimit(maxPeople, MAX_PEOPLE);
  const cap = parseLimit(enrichLimit, MAX_ENRICH_LIMIT);

  const apifyReady = Boolean(connector) && connector?.status !== 'error';
  const apifyChecked = query.isSuccess || query.isError;

  const showCount = text.trim().length >= MAX_POST_TEXT_LENGTH - POST_TEXT_COUNT_WINDOW;
  // The server trims before it counts, so the limit is measured on the trimmed text and the whitespace the person typed
  // stays. A cut never splits a surrogate pair: when it would land inside one, it goes one code unit earlier.
  const changeText = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length > MAX_POST_TEXT_LENGTH) {
      const start = value.length - value.trimStart().length;
      let end = start + MAX_POST_TEXT_LENGTH;
      const last = value.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
      setText(value.slice(0, end));
      setTextCut(true);
    } else {
      setText(value);
      setTextCut(false);
    }
  };

  // The first problem found is the one shown. An empty URL disables the button without a reason line.
  let reason: ReactNode = null;
  if (pasted) {
    if (!providerReady) {
      // The line under the text box already says how to fix this.
      reason = null;
    } else if (!hasText) {
      reason = 'Paste the post text to capture leads.';
    } else if (!provenanceOk) {
      reason = 'Fix the post link first.';
    } else if (enrich && !apifyReady) {
      reason = (
        <>
          {query.isSuccess ? 'Apify is not connected. ' : 'Could not check the Apify connection yet. '}Turn off enrichment or{' '}
          <Link className="link" to="/settings/connectors">
            check Apify in Settings
          </Link>
          .
        </>
      );
    } else if (people === null) {
      reason = `People per source must be a whole number from 1 to ${MAX_PEOPLE}.`;
    } else if (enrich && cap === null) {
      reason = `The enrichment limit must be a whole number from 1 to ${MAX_ENRICH_LIMIT}.`;
    }
  } else if (query.isError) {
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
    reason = POST_LINK_REASON;
  } else if (!post && !reactions && !comments) {
    reason = 'Choose at least one source.';
  } else if (people === null) {
    reason = `People per source must be a whole number from 1 to ${MAX_PEOPLE}.`;
  } else if (enrich && cap === null) {
    reason = `The enrichment limit must be a whole number from 1 to ${MAX_ENRICH_LIMIT}.`;
  }

  const canStart = pasted
    ? providerReady && hasText && provenanceOk && reason === null && !start.isPending
    : apifyReady && urlOk && reason === null && !start.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canStart || people === null) return;
    const enrichFields = { enrich, ...(enrich && cap !== null ? { enrichLimit: cap } : {}) };
    let input: LeadCaptureInput;
    if (pasted) {
      // A pasted capture reads only the text, so no sources are sent.
      input = { postText: text, ...(provenanceTyped ? { postUrl: fullProvenance } : {}), maxPeople: people, ...enrichFields };
    } else {
      const sources: LeadSource[] = [];
      if (post) sources.push('post');
      if (reactions) sources.push('reactions');
      if (comments) sources.push('comments');
      input = { postUrl: fullUrl, sources, maxPeople: people, ...enrichFields };
    }
    start.mutate(input, { onSuccess: onStarted });
  };

  const providerLine = provider.isError ? (
    <p className="muted" id="lead-capture-post-reason">
      Could not check the model provider.
    </p>
  ) : !provider.isPending && !providerReady ? (
    <p className="muted" id="lead-capture-post-reason">
      Connect a{' '}
      <Link className="link" to="/settings/models">
        model provider
      </Link>{' '}
      to read people from the post text.
    </p>
  ) : null;

  // Enrichment needs Apify. Pasted mode can still capture without it, so the toggle only locks while it is off.
  const enrichLocked = pasted && !enrichPasted && apifyChecked && !apifyReady;

  return (
    <section className="lead-capture" aria-labelledby="lead-capture-title">
      <h2 className="lead-capture__title" id="lead-capture-title">
        From a LinkedIn post
      </h2>
      <div className="segmented" role="group" aria-label="Capture from">
        <button type="button" className={!pasted ? 'is-active' : ''} aria-pressed={!pasted} onClick={() => changeMode('link')}>
          Post link
        </button>
        <button type="button" className={pasted ? 'is-active' : ''} aria-pressed={pasted} onClick={() => changeMode('pasted')}>
          Pasted text
        </button>
      </div>
      <form className="connector__form" onSubmit={submit} noValidate>
        {pasted ? (
          <>
            <label className="sr-only" htmlFor="lead-capture-text">
              Post text
            </label>
            <textarea
              id="lead-capture-text"
              className="input"
              rows={6}
              spellCheck={false}
              placeholder="Paste the post text"
              value={text}
              aria-describedby="lead-capture-text-note"
              onChange={(event) => changeText(event.target.value)}
            />
            <p className="muted" id="lead-capture-text-note">
              Up to {formatCharacters(MAX_POST_TEXT_LENGTH)} characters.
              {textCut
                ? ` The text was longer, so the first ${formatCharacters(MAX_POST_TEXT_LENGTH)} were kept.`
                : showCount
                  ? ` ${formatCharacters(text.trim().length)} used.`
                  : ''}
            </p>
            <div className="lead-capture__field">
              <label className="connector__label" htmlFor="lead-capture-provenance">
                Post link (optional)
              </label>
              <input
                id="lead-capture-provenance"
                className="input"
                type="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste a LinkedIn post URL"
                value={provenance}
                aria-invalid={!provenanceOk}
                aria-describedby={provenanceOk ? undefined : 'lead-capture-provenance-reason'}
                onChange={(event) => setProvenance(event.target.value)}
              />
              {!provenanceOk ? (
                <p className="muted" id="lead-capture-provenance-reason">
                  {POST_LINK_REASON}
                </p>
              ) : null}
            </div>
            <p className="muted">
              Captures the people and organizations named in the text. Reactions and comments need a post link.
            </p>
            {providerLine}
          </>
        ) : (
          <>
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
                  <input
                    type="checkbox"
                    checked={post}
                    disabled={!providerReady}
                    aria-describedby={providerReady ? undefined : 'lead-capture-post-reason'}
                    onChange={(event) => setPostChoice(event.target.checked)}
                  />
                  <span>People named in the post</span>
                </label>
                <label className="toggle">
                  <input type="checkbox" checked={reactions} onChange={(event) => setReactions(event.target.checked)} />
                  <span>People who reacted</span>
                </label>
                <label className="toggle">
                  <input type="checkbox" checked={comments} onChange={(event) => setComments(event.target.checked)} />
                  <span>People who commented</span>
                </label>
              </div>
              {providerLine}
            </div>
          </>
        )}

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
            <input
              type="checkbox"
              checked={enrich}
              disabled={enrichLocked}
              aria-describedby={enrichLocked ? 'lead-capture-enrich-reason' : undefined}
              onChange={(event) => setEnrich(event.target.checked)}
            />
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
        {enrichLocked ? (
          <p className="muted" id="lead-capture-enrich-reason">
            {query.isSuccess ? '' : 'Could not check the Apify connection yet. '}
            <Link className="link" to="/settings/connectors">
              Connect Apify in Settings
            </Link>{' '}
            to enrich new people. The capture works without it.
          </p>
        ) : null}

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
        {pasted && !enrich
          ? 'Reading the text uses your model provider; costs shown are estimates. Nothing else is charged.'
          : pasted
            ? 'Enrichment runs on your own Apify account. Store price as of November 2026: profile details from $4.00 per 1,000. Reading the text also uses your model provider; costs shown are estimates. Item caps bind only pay per result actors; the run timeout limits the rest.'
            : 'Runs on your own Apify account. Store prices for the default actors as of November 2026: post text from $5.00 per 1,000 results, engagement from $1.50 per 1,000, profile details from $4.00 per 1,000. Reading the post also uses your model provider; costs shown are estimates. Item caps bind only pay per result actors; the run timeout limits the rest.'}
      </p>
    </section>
  );
}
