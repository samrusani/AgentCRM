import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import {
  useAcceptEnrichment,
  useAcceptOrganizationEnrichment,
  useApifyConnector,
  useDismissEnrichment,
  useDismissOrganizationEnrichment,
  useOrganizationEnrichment,
  usePersonEnrichment,
  useStartEnrichOrganization,
  useStartEnrichPerson,
} from '../api/hooks';
import type { EnrichmentState } from '../api/types';
import { ENRICH_FIELD_LABELS } from '../lib/enrichment';
import { isRunActive } from '../lib/format';
import { errorMessage } from './common';
import { SheetSection } from './record';

export const ENRICH_COST_LINE = 'Runs one profile scrape on your Apify account.';
export const ENRICH_NAME_COST_LINE =
  'No profile saved, so this searches LinkedIn by their name on your Apify account. Check the match before accepting.';
export const ENRICH_ORG_COST_LINE = 'Runs one company lookup on your Apify account.';
export const ENRICH_NEEDS_APIFY = 'Connect Apify in Settings to enrich';
export const ENRICH_CHECK_FAILED = 'Could not check the Apify connector. Retry from Settings.';
export const ENRICH_NOTHING_NEW = 'Nothing new to suggest.';
export const ENRICH_FAILED = 'The enrich run did not finish.';

interface EnrichControlViewProps {
  subjectId: string;
  costLine: string;
  enrichment: { data: EnrichmentState | undefined };
  start: { isPending: boolean; isError: boolean; error: unknown; mutate: (id: string) => void };
}

// The Enrich button and its lines. Rendered beside the Fields title, so the lines wrap below it.
function EnrichControlView({ subjectId, costLine, enrichment, start }: EnrichControlViewProps) {
  const { query: connectorQuery, connector } = useApifyConnector();

  const connected = Boolean(connector) && connector?.status !== 'error';
  const runOpen = Boolean(enrichment.data?.run && isRunActive(enrichment.data.run.status));
  const enriching = runOpen || start.isPending;

  // Name the missing piece once the connector check has settled, so the line never flashes while loading.
  // When the check itself failed, say so rather than claiming Apify is not connected.
  const reason = connected || connectorQuery.isPending ? null : connectorQuery.isError ? ENRICH_CHECK_FAILED : ENRICH_NEEDS_APIFY;

  const blocked = !connected;
  const reasonId = `enrich-reason-${subjectId}`;

  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={enriching || blocked}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => start.mutate(subjectId)}
      >
        {enriching ? 'Enriching' : 'Enrich'}
      </button>
      <p className="muted sheet-section__note">{costLine}</p>
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

export function EnrichControl({ personId, linkedinUrl }: { personId: string; linkedinUrl: string | null | undefined }) {
  const enrichment = usePersonEnrichment(personId);
  const start = useStartEnrichPerson();
  return (
    <EnrichControlView
      subjectId={personId}
      // Without a saved profile the run is a name search, which the line says before any money is spent.
      costLine={linkedinUrl ? ENRICH_COST_LINE : ENRICH_NAME_COST_LINE}
      enrichment={enrichment}
      start={start}
    />
  );
}

export function OrganizationEnrichControl({ organizationId }: { organizationId: string }) {
  const enrichment = useOrganizationEnrichment(organizationId);
  const start = useStartEnrichOrganization();
  return (
    <EnrichControlView
      subjectId={organizationId}
      costLine={ENRICH_ORG_COST_LINE}
      enrichment={enrichment}
      start={start}
    />
  );
}

interface AcceptVars {
  runId: string;
  field: string;
  expectedVersion: number;
}

interface SuggestionsViewProps {
  version: number;
  // A run that matched by name has a detail naming who was found, and it shows above the list so a wrong match is
  // visible before any Accept. Organization runs always show it; a person run only when it was a name search.
  detailAbovePending: boolean | ((run: NonNullable<EnrichmentState['run']>) => boolean);
  enrichment: { data: EnrichmentState | undefined; refetch: () => unknown };
  accept: { isPending: boolean; mutate: (vars: AcceptVars, options: { onError: (error: unknown) => void; onSettled: () => void }) => void };
  dismiss: { isPending: boolean; isError: boolean; error: unknown; mutate: (runId: string) => void };
}

function SuggestionsView({ version, detailAbovePending, enrichment, accept, dismiss }: SuggestionsViewProps) {
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
      { runId: run.id, field, expectedVersion: version },
      {
        onError: (error) => {
          const conflict = error instanceof ApiError && error.status === 409;
          const label = ENRICH_FIELD_LABELS[field] ?? field;
          // A name lookup is refused for reasons the server states (the name changed, a profile was saved, the link is
          // taken), so its own message is shown instead of the generic field-changed wording.
          setProblem({
            field,
            message:
              conflict && run.mode === 'name'
                ? errorMessage(error)
                : conflict
                  ? `${label} changed since you opened this record, so the suggestion was not applied.`
                  : `${errorMessage(error)} The suggestion was not applied.`,
          });
        },
        onSettled: () => setAcceptingField(null),
      },
    );
  };

  const busy = accept.isPending || dismiss.isPending;
  const showDetailAbove = typeof detailAbovePending === 'function' ? detailAbovePending(run) : detailAbovePending;

  return (
    <SheetSection title="Suggestions">
      {showDetailAbove && !isRunActive(run.status) && run.detail ? <p className="muted">{run.detail}</p> : null}
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
            dismiss.mutate(run.id);
          }}
        >
          Dismiss
        </button>
        {dismiss.isError ? <span className="inline-error">{errorMessage(dismiss.error)}</span> : null}
      </div>
    </SheetSection>
  );
}

// Pending suggestions from the newest enrich run, between Fields and Qualification. A name lookup also shows its
// detail line above them, because that line names the person the search found.
export function EnrichmentSuggestions({ personId, version }: { personId: string; version: number }) {
  const enrichment = usePersonEnrichment(personId);
  const accept = useAcceptEnrichment();
  const dismiss = useDismissEnrichment();
  return (
    <SuggestionsView
      version={version}
      detailAbovePending={(run) => run.mode === 'name'}
      enrichment={enrichment}
      accept={{ isPending: accept.isPending, mutate: (vars, options) => accept.mutate({ personId, ...vars }, options) }}
      dismiss={{
        isPending: dismiss.isPending,
        isError: dismiss.isError,
        error: dismiss.error,
        mutate: (runId) => dismiss.mutate({ personId, runId }),
      }}
    />
  );
}

// The same list for an organization, plus the run detail above it (it names the company a name lookup found).
export function OrganizationEnrichmentSuggestions({ organizationId, version }: { organizationId: string; version: number }) {
  const enrichment = useOrganizationEnrichment(organizationId);
  const accept = useAcceptOrganizationEnrichment();
  const dismiss = useDismissOrganizationEnrichment();
  return (
    <SuggestionsView
      version={version}
      detailAbovePending
      enrichment={enrichment}
      accept={{ isPending: accept.isPending, mutate: (vars, options) => accept.mutate({ organizationId, ...vars }, options) }}
      dismiss={{
        isPending: dismiss.isPending,
        isError: dismiss.isError,
        error: dismiss.error,
        mutate: (runId) => dismiss.mutate({ organizationId, runId }),
      }}
    />
  );
}
