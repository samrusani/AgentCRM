import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import {
  useAcceptEnrichment,
  useApifyConnector,
  useDismissEnrichment,
  usePersonEnrichment,
  useStartEnrichPerson,
} from '../api/hooks';
import { ENRICH_FIELD_LABELS } from '../lib/enrichment';
import { isRunActive } from '../lib/format';
import { errorMessage } from './common';
import { SheetSection } from './record';

export const ENRICH_COST_LINE = 'Runs one profile scrape on your Apify account.';
export const ENRICH_NEEDS_APIFY = 'Connect Apify in Settings to enrich';
export const ENRICH_NEEDS_LINKEDIN = 'Add a LinkedIn profile first';
export const ENRICH_NOTHING_NEW = 'Nothing new to suggest.';
export const ENRICH_FAILED = 'The enrich run did not finish.';

// The Enrich button and its lines. Rendered beside the Fields title, so the lines wrap below it.
export function EnrichControl({ personId, linkedinUrl }: { personId: string; linkedinUrl: string | null | undefined }) {
  const { query: connectorQuery, connector } = useApifyConnector();
  const enrichment = usePersonEnrichment(personId);
  const start = useStartEnrichPerson();

  const connected = Boolean(connector) && connector?.status !== 'error';
  const runOpen = Boolean(enrichment.data?.run && isRunActive(enrichment.data.run.status));
  const enriching = runOpen || start.isPending;

  // Name the missing piece once the connector check has settled, so the line never flashes while loading.
  let reason: string | null = null;
  if (!connected && !connectorQuery.isPending) reason = ENRICH_NEEDS_APIFY;
  else if (connected && !linkedinUrl) reason = ENRICH_NEEDS_LINKEDIN;

  const blocked = !connected || !linkedinUrl;
  const reasonId = `enrich-reason-${personId}`;

  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={enriching || blocked}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => start.mutate(personId)}
      >
        {enriching ? 'Enriching' : 'Enrich'}
      </button>
      <p className="muted sheet-section__note">{ENRICH_COST_LINE}</p>
      {reason ? (
        <p className="muted sheet-section__note" id={reasonId}>
          {reason}
        </p>
      ) : null}
      {start.isError ? (
        <p className="inline-error sheet-section__note" role="alert">
          {errorMessage(start.error)}
        </p>
      ) : null}
    </>
  );
}

// Pending suggestions from the newest enrich run, between Fields and Qualification.
export function EnrichmentSuggestions({ personId, version }: { personId: string; version: number }) {
  const enrichment = usePersonEnrichment(personId);
  const accept = useAcceptEnrichment();
  const dismiss = useDismissEnrichment();
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const [acceptingField, setAcceptingField] = useState<string | null>(null);

  const run = enrichment.data?.run ?? null;
  const suggestions = enrichment.data?.suggestions ?? [];
  const runId = run?.id ?? null;
  const hasSuggestions = suggestions.length > 0;

  useEffect(() => {
    setProblem(null);
  }, [runId]);

  if (!run) return null;

  if (!hasSuggestions) {
    // No client memory: the server says how many suggestions the run produced in all.
    // A succeeded run that produced some, now all decided, shows nothing.
    let line: string | null = null;
    if (run.status === 'succeeded' && run.suggestedCount === 0) line = run.detail || ENRICH_NOTHING_NEW;
    else if (run.status === 'failed') line = run.detail || ENRICH_FAILED;
    if (!line) return null;
    return (
      <SheetSection title="Suggestions">
        <p className="muted">{line}</p>
      </SheetSection>
    );
  }

  const onAccept = (field: string) => {
    setProblem(null);
    setAcceptingField(field);
    accept.mutate(
      { personId, runId: run.id, field, expectedVersion: version },
      {
        onError: (error) => {
          const conflict = error instanceof ApiError && error.status === 409;
          const label = ENRICH_FIELD_LABELS[field] ?? field;
          setProblem({
            field,
            message: conflict
              ? `${label} changed since you opened this record, so the suggestion was not applied.`
              : `${errorMessage(error)} The suggestion was not applied.`,
          });
        },
        onSettled: () => setAcceptingField(null),
      },
    );
  };

  const busy = accept.isPending || dismiss.isPending;

  return (
    <SheetSection title="Suggestions">
      <ul className="suggestion-list">
        {suggestions.map((suggestion) => {
          const label = ENRICH_FIELD_LABELS[suggestion.field] ?? suggestion.field;
          const failed = problem?.field === suggestion.field ? problem : null;
          return (
            <li key={suggestion.field} className="suggestion-row">
              <span className="suggestion-row__field">{label}</span>
              <span className="suggestion-row__value">{suggestion.value}</span>
              <button
                type="button"
                className="btn"
                disabled={busy}
                aria-label={`Accept ${label.toLowerCase()}`}
                onClick={() => onAccept(suggestion.field)}
              >
                {acceptingField === suggestion.field ? 'Accepting...' : 'Accept'}
              </button>
              {failed ? (
                <div className="conflict suggestion-row__problem" role="alert">
                  <p>{failed.message}</p>
                  <div className="conflict__actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setProblem(null);
                        void enrichment.refetch();
                      }}
                    >
                      Reload suggestions
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="suggestion-actions">
        <button
          type="button"
          className="btn btn--quiet"
          disabled={busy}
          onClick={() => {
            setProblem(null);
            dismiss.mutate({ personId, runId: run.id });
          }}
        >
          Dismiss
        </button>
        {dismiss.isError ? <span className="inline-error">{errorMessage(dismiss.error)}</span> : null}
      </div>
    </SheetSection>
  );
}
