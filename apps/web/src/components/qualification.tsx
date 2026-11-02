import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQualifyRun, useRun } from '../api/hooks';
import type { CriterionOutcome, QualificationResult, QualificationSummary } from '../api/types';
import { formatAgo, isRunActive } from '../lib/format';
import { Chip, RunStatusChip, errorMessage } from './common';
import { SheetSection } from './record';

const OUTCOME_LABELS: Record<CriterionOutcome, string> = {
  matched: 'Matched',
  not_matched: 'Not matched',
  unknown: 'Unknown',
};

// Shape carries the meaning: filled for matched, hollow ring for not matched,
// dashed ring for unknown. Colour only reinforces it.
export function FitMarker({ outcome }: { outcome: CriterionOutcome }) {
  return (
    <span className={`fit-marker fit-marker--${outcome}`} role="img" aria-label={OUTCOME_LABELS[outcome]} title={OUTCOME_LABELS[outcome]} />
  );
}

// True when the person was edited after qualification last ran, so the stored result may no longer fit.
export function isQualificationStale(computedAt: string | null | undefined, personUpdatedAt: string | null | undefined): boolean {
  if (!computedAt || !personUpdatedAt) return false;
  const computed = Date.parse(computedAt);
  const updated = Date.parse(personUpdatedAt);
  return Number.isFinite(computed) && Number.isFinite(updated) && updated > computed;
}

const STALE_TITLE = 'This person changed after qualification ran, so these numbers may be out of date.';

// Fit column cell: matched of total and the unknown count stay separate, never a percentage.
export function FitCell({
  qualification,
  personUpdatedAt,
}: {
  qualification: QualificationSummary | null | undefined;
  personUpdatedAt?: string | null;
}) {
  if (!qualification) return <span className="muted">Not qualified yet</span>;
  const { matched, total, unknown, excluded } = qualification;
  const stale = isQualificationStale(qualification.computedAt, personUpdatedAt);
  return (
    <span className="fit-cell">
      {excluded ? <Chip tone="neutral">Excluded</Chip> : null}
      {total === 0 ? (
        excluded ? null : <span className="muted">No criteria</span>
      ) : (
        <>
          <span className={`num${excluded ? ' muted' : ''}`} aria-hidden="true">
            {matched}/{total}
          </span>
          <span className="sr-only">
            {matched} of {total} criteria matched
          </span>
        </>
      )}
      {unknown > 0 ? <span className="muted num">{unknown} unknown</span> : null}
      {stale ? (
        <span className="muted fit-stale" title={STALE_TITLE}>
          out of date
        </span>
      ) : null}
    </span>
  );
}

export function QualifyRunAction({ variant, note }: { variant: 'person' | 'settings'; note?: string }) {
  const qualify = useQualifyRun();
  const [startedId, setStartedId] = useState<string | null>(null);
  const run = useRun(startedId);
  const active = Boolean(run.data && isRunActive(run.data.status));
  const label = variant === 'settings' ? 'Run qualification' : 'Qualify now';

  return (
    <div className="qualify-action">
      <div className="qualify-action__row">
        <button
          type="button"
          className={variant === 'settings' ? 'btn' : 'btn btn--quiet'}
          disabled={qualify.isPending || active}
          onClick={() => qualify.mutate({}, { onSuccess: (started) => setStartedId(started.id) })}
        >
          {qualify.isPending ? 'Starting...' : label}
        </button>
        {note ? <span className="muted">{note}</span> : null}
      </div>
      {qualify.isError ? (
        <p className="inline-error" role="alert">
          Could not start the qualification run. {errorMessage(qualify.error)} Nothing was started.
        </p>
      ) : null}
      {startedId ? (
        <p className="muted qualify-action__note" role="status">
          Qualification run started for all people.{' '}
          {run.data ? <RunStatusChip status={run.data.status} /> : null}{' '}
          <Link className="link" to={`/research?run=${encodeURIComponent(startedId)}`}>
            Open the run
          </Link>
        </p>
      ) : null}
    </div>
  );
}

export function QualificationSection({
  result,
  personUpdatedAt,
}: {
  result: QualificationResult | null;
  personUpdatedAt?: string | null;
}) {
  return (
    <SheetSection title="Qualification">
      {result ? (
        <>
          {result.excluded ? (
            <div className="fit-excluded">
              <Chip tone="neutral">Excluded</Chip>
              {result.excludedReasons.length > 0 ? (
                <ul className="fit-excluded__reasons" aria-label="Exclusion reasons">
                  {result.excludedReasons.map((reason, index) => (
                    <li key={`${index}-${reason}`}>{reason}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">An exclusion rule matched. The server gave no reason.</p>
              )}
            </div>
          ) : null}

          <p className="muted fit-summary">
            <span className="num">{result.matched}</span> of <span className="num">{result.total}</span> matched,{' '}
            <span className="num">{result.unknown}</span> unknown, qualified {formatAgo(result.computedAt)}
          </p>
          {isQualificationStale(result.computedAt, personUpdatedAt) ? (
            <p className="muted fit-summary">
              Out of date. This person changed after qualification ran. Run qualification again to refresh these results.
            </p>
          ) : null}

          {result.criteria.length === 0 ? (
            <p className="muted">
              No criteria are enabled. Add some in{' '}
              <Link className="link" to="/settings/qualification">
                Settings
              </Link>
              .
            </p>
          ) : (
            <ul className="fit-list" aria-label="Criteria">
              {result.criteria.map((criterion, index) => (
                <li key={criterion.id || index} className="fit-row">
                  <FitMarker outcome={criterion.outcome} />
                  <div className="fit-row__text">
                    <span className="fit-row__label">
                      {criterion.label}
                    </span>
                    {criterion.reason ? <span className="muted">{criterion.reason}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="muted">This person has not been qualified yet. Run qualification to see which criteria they match.</p>
      )}
      <QualifyRunAction variant="person" note="Evaluates every person, not only this one." />
    </SheetSection>
  );
}
