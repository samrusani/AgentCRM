import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  useAcceptEnrichment,
  useAcceptOrganizationEnrichment,
  useApifyConnector,
  useDismissEnrichment,
  useModelProvider,
  useDismissOrganizationEnrichment,
  useOrganizationEnrichment,
  usePersonEnrichment,
  useStartEnrichOrganization,
  useStartEnrichPerson,
  useStartWebSearch,
} from '../api/hooks';
import type { EnrichmentState } from '../api/types';
import { ENRICH_FIELD_LABELS, ENRICH_LINK_FIELDS } from '../lib/enrichment';
import { isRunActive } from '../lib/format';
import { websiteHref } from '../lib/links';
import { errorMessage } from './common';
import { SheetSection } from './record';

// A link field's value opens in a new tab so it can be checked before accepting. The full stored value is the
// text; a value that does not parse as http or https stays plain text.
function SuggestionValue({ field, value }: { field: string; value: string }) {
  const href = ENRICH_LINK_FIELDS.has(field) ? websiteHref(value) : null;
  if (!href) return <span className="suggestion-row__value">{value}</span>;
  return (
    <a className="suggestion-row__value" href={href} target="_blank" rel="noreferrer noopener">
      {value}
    </a>
  );
}

export const ENRICH_COST_LINE = 'Runs one profile scrape on your Apify account.';
export const ENRICH_NAME_COST_LINE =
  'No profile saved, so this searches LinkedIn by their name on your Apify account. Check the match before accepting.';
export const WEB_SEARCH_COST_LINE =
  'Searches the web for their profiles and links on your Apify account and reads the results with your model provider. Check the match before accepting.';
export const WEB_SEARCH_CHECK_FAILED = 'Could not check the model provider.';
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
  // Person sheets only: the quiet Search the web button beside Enrich.
  web?: {
    start: { isPending: boolean; isError: boolean; error: unknown; mutate: (id: string) => void };
    providerReady: boolean;
    providerPending: boolean;
    providerFailed: boolean;
  };
}

// The Enrich button and its lines. Rendered beside the Fields title, so the lines wrap below it.
function EnrichControlView({ subjectId, costLine, enrichment, start, web }: EnrichControlViewProps) {
  const { query: connectorQuery, connector } = useApifyConnector();

  const connected = Boolean(connector) && connector?.status !== 'error';
  const runOpen = Boolean(enrichment.data?.run && isRunActive(enrichment.data.run.status));
  // One open run per person covers both buttons: the one that started it shows its progress, both stay disabled.
  const webRunOpen = runOpen && enrichment.data?.run?.mode === 'web';
  const searching = Boolean(web) && (webRunOpen || Boolean(web?.start.isPending));
  const enriching = (runOpen && !webRunOpen) || start.isPending;
  const anyOpen = runOpen || start.isPending || Boolean(web?.start.isPending);

  // Name the missing piece once the connector check has settled, so the line never flashes while loading.
  // When the check itself failed, say so rather than claiming Apify is not connected.
  const reason = connected || connectorQuery.isPending ? null : connectorQuery.isError ? ENRICH_CHECK_FAILED : ENRICH_NEEDS_APIFY;

  const blocked = !connected;
  const reasonId = `enrich-reason-${subjectId}`;
  const providerReasonId = `web-search-reason-${subjectId}`;
  // The search also needs a model provider. Name the missing piece once the check has settled; a failed check says so.
  const providerReason =
    !web || web.providerPending || web.providerReady ? null : web.providerFailed ? (
      <p className="muted sheet-section__note" id={providerReasonId}>
        {WEB_SEARCH_CHECK_FAILED}
      </p>
    ) : (
      <p className="muted sheet-section__note" id={providerReasonId}>
        Connect a{' '}
        <Link className="link" to="/settings/models">
          model provider
        </Link>{' '}
        in Settings to search the web.
      </p>
    );

  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={anyOpen || blocked}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => start.mutate(subjectId)}
      >
        {enriching ? 'Enriching' : 'Enrich'}
      </button>
      {web ? (
        <button
          type="button"
          className="btn btn--quiet"
          disabled={anyOpen || blocked || !web.providerReady}
          aria-describedby={[reason ? reasonId : null, providerReason ? providerReasonId : null].filter(Boolean).join(' ') || undefined}
          onClick={() => web.start.mutate(subjectId)}
        >
          {searching ? 'Searching' : 'Search the web'}
        </button>
      ) : null}
      <p className="muted sheet-section__note">{costLine}</p>
      {web ? <p className="muted sheet-section__note">{WEB_SEARCH_COST_LINE}</p> : null}
      {reason ? (
        <p className="muted sheet-section__note" id={reasonId}>
          {reason}
        </p>
      ) : null}
      {providerReason}
      {start.isError ? (
        <p className="inline-error sheet-section__note" role="alert">
          {errorMessage(start.error)}
        </p>
      ) : null}
      {web?.start.isError ? (
        <p className="inline-error sheet-section__note" role="alert">
          {errorMessage(web.start.error)}
        </p>
      ) : null}
    </>
  );
}

export function EnrichControl({ personId, linkedinUrl }: { personId: string; linkedinUrl: string | null | undefined }) {
  const enrichment = usePersonEnrichment(personId);
  const start = useStartEnrichPerson();
  const webStart = useStartWebSearch();
  const provider = useModelProvider();
  return (
    <EnrichControlView
      subjectId={personId}
      web={{
        start: webStart,
        providerReady: provider.data?.ready === true,
        providerPending: provider.isPending,
        providerFailed: provider.isError,
      }}
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
  dismiss: { isPending: boolean; mutate: (runId: string, field?: string, options?: { onError: (error: unknown) => void }) => void };
}

function SuggestionsView({ version, detailAbovePending, enrichment, accept, dismiss }: SuggestionsViewProps) {
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  // A failed dismiss reports where it was started: a row failure in the row, a Dismiss all failure beside its button.
  // Neither reads the shared mutation state, so a cleared error can never resurface somewhere else.
  const [bottomProblem, setBottomProblem] = useState<string | null>(null);
  const [acceptingField, setAcceptingField] = useState<string | null>(null);

  const run = enrichment.data?.run ?? null;
  const suggestions = enrichment.data?.suggestions ?? [];
  const runId = run?.id ?? null;
  const hasSuggestions = suggestions.length > 0;

  useEffect(() => {
    setProblem(null);
    setBottomProblem(null);
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
    setBottomProblem(null);
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
              conflict && (run.mode === 'name' || run.mode === 'web')
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
              <SuggestionValue field={suggestion.field} value={suggestion.value} />
              <button
                type="button"
                className="btn"
                disabled={busy}
                aria-label={`Accept ${label.toLowerCase()}`}
                onClick={() => onAccept(suggestion.field)}
              >
                {acceptingField === suggestion.field ? 'Accepting...' : 'Accept'}
              </button>
              <button
                type="button"
                className="btn btn--quiet"
                disabled={busy}
                aria-label={`Dismiss ${label.toLowerCase()}`}
                onClick={() => {
                  setProblem(null);
                  setBottomProblem(null);
                  dismiss.mutate(run.id, suggestion.field, {
                    onError: (error) => setProblem({ field: suggestion.field, message: errorMessage(error) }),
                  });
                }}
              >
                Dismiss
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
            setBottomProblem(null);
            dismiss.mutate(run.id, undefined, {
              onError: (error) => setBottomProblem(errorMessage(error)),
            });
          }}
        >
          {suggestions.length === 1 ? 'Dismiss' : 'Dismiss all'}
        </button>
        {bottomProblem ? <span className="inline-error">{bottomProblem}</span> : null}
      </div>
    </SheetSection>
  );
}

// Pending suggestions from the newest enrich run, between Fields and Qualification. A name lookup also shows its
// detail line above them, because that line names the person the search found, and a web search its detail, which
// names the query it searched.
export function EnrichmentSuggestions({ personId, version }: { personId: string; version: number }) {
  const enrichment = usePersonEnrichment(personId);
  const accept = useAcceptEnrichment();
  const dismiss = useDismissEnrichment();
  return (
    <SuggestionsView
      version={version}
      detailAbovePending={(run) => run.mode === 'name' || run.mode === 'web'}
      enrichment={enrichment}
      accept={{ isPending: accept.isPending, mutate: (vars, options) => accept.mutate({ personId, ...vars }, options) }}
      dismiss={{
        isPending: dismiss.isPending,
        mutate: (runId, field, options) => dismiss.mutate({ personId, runId, field }, options),
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
        mutate: (runId, field, options) => dismiss.mutate({ organizationId, runId, field }, options),
      }}
    />
  );
}
