import { Link } from 'react-router-dom';
import { useRun } from '../api/hooks';
import type { Run, RunCounts, RunStep } from '../api/types';
import { formatDuration, isSimulatedRun } from '../lib/format';
import { runProvider } from '../lib/drafts';
import { formatUsd, isLocalProvider } from '../lib/models';
import { RunStatusChip, SimulatedChip } from './common';

type StepState = 'queued' | 'running' | 'done' | 'waiting' | 'failed' | 'skipped';

export function stepState(status: string): StepState {
  switch (status) {
    case 'done':
    case 'succeeded':
    case 'completed':
    case 'complete':
      return 'done';
    case 'skipped':
      return 'skipped';
    case 'running':
    case 'active':
    case 'in_progress':
      return 'running';
    case 'waiting':
    case 'waiting_approval':
    case 'paused':
      return 'waiting';
    case 'failed':
    case 'error':
    case 'cancelled':
      return 'failed';
    default:
      return 'queued';
  }
}

const STATE_LABELS: Record<StepState, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  waiting: 'Waiting for a decision',
  failed: 'Failed',
  skipped: 'Skipped',
};

function foundLabel(kind?: string): string {
  // Qualify runs count people who matched every enabled criterion, so "Found" would mislead there.
  if (kind === 'qualify') return 'Full matches';
  if (kind === 'draft_outreach') return 'Drafted';
  return 'Found';
}

// A run on a local model costs nothing, so its cost line says so instead of showing a dollar estimate.
export function CountsList({ counts, kind, provider }: { counts: RunCounts; kind?: string; provider?: string | null }) {
  return (
    <dl className="counts counts--wrap">
      <div>
        <dt>Processed</dt>
        <dd>{counts.processed}</dd>
      </div>
      <div>
        <dt>{foundLabel(kind)}</dt>
        <dd>{counts.found}</dd>
      </div>
      <div>
        <dt>Flagged</dt>
        <dd>{counts.flagged}</dd>
      </div>
      {typeof counts.excluded === 'number' ? (
        <div>
          <dt>Excluded</dt>
          <dd>{counts.excluded}</dd>
        </div>
      ) : null}
      {typeof counts.estimatedUsd === 'number' ? (
        <div>
          <dt>{isLocalProvider(provider) ? 'Cost' : 'Estimated cost'}</dt>
          <dd>
            {isLocalProvider(provider) ? (
              'Local, no cost'
            ) : (
              <>
                {formatUsd(counts.estimatedUsd)} <span className="muted counts__qualifier">estimate</span>
              </>
            )}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

export function RunLedger({
  steps,
  runStatus,
  compact,
}: {
  steps: RunStep[];
  runStatus?: string;
  compact?: boolean;
}) {
  if (steps.length === 0) {
    return <p className="muted ledger__empty">No steps recorded yet. The run has not started.</p>;
  }
  return (
    <ol className={`ledger${compact ? ' ledger--compact' : ''}`} aria-label="Run ledger">
      {steps.map((step) => {
        const state = stepState(step.status);
        const pulse = state === 'running' && (runStatus === undefined || runStatus === 'running');
        const duration = formatDuration(step.startedAt, state === 'running' ? null : step.finishedAt);
        return (
          <li key={step.id} className={`ledger__step ledger__step--${state}`}>
            <span className={`marker marker--${state}${pulse ? ' marker--pulse' : ''}`} aria-hidden="true" />
            <div className="ledger__text">
              <span className="ledger__title">{step.title}</span>
              {step.detail ? <span className="ledger__detail">{step.detail}</span> : null}
            </div>
            <span className="ledger__state">
              {STATE_LABELS[state]}
              {duration && state !== 'queued' && state !== 'skipped' ? <span className="num"> {duration}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// Compact run with its live ledger. Loads the full run because lists may omit steps.
export function LiveRun({ run, showLink = true }: { run: Run; showLink?: boolean }) {
  const detail = useRun(run.id);
  const current = detail.data ?? run;
  return (
    <article className="run-card">
      <header className="run-card__header">
        <h3 className="run-card__title">{current.title}</h3>
        <div className="run-card__chips">
          {isSimulatedRun(current) ? <SimulatedChip /> : null}
          <RunStatusChip status={current.status} />
        </div>
      </header>
      <CountsList counts={current.counts} kind={current.kind} provider={runProvider(current.scope)} />
      <RunLedger steps={current.steps ?? []} runStatus={current.status} compact />
      {showLink ? (
        <Link className="link" to={`/research?run=${current.id}`}>
          Open run
        </Link>
      ) : null}
    </article>
  );
}
