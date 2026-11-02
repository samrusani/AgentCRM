import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useControlRun, useRun, useRuns, useStartRun } from '../api/hooks';
import type { Run } from '../api/types';
import { ApprovalCard } from '../components/approvals';
import {
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  RunStatusChip,
  SimulatedChip,
  errorMessage,
} from '../components/common';
import { Icon } from '../components/Icons';
import { DraftRunIssuesView } from '../components/draftReview';
import { batchHref } from '../components/importReview';
import { CountsList, RunLedger } from '../components/ledger';
import { parseDraftRunIssues } from '../lib/drafts';
import { formatAgo, formatDateTime, isSimulatedRun } from '../lib/format';
import { DraftOutreachSheet } from './DraftOutreachSheet';
import { ImportBatchSheet, ImportSetupSheet } from './ImportSheets';
import { useUI } from '../lib/ui';

export function Research() {
  const runs = useRuns();
  const [params, setParams] = useSearchParams();
  const startRun = useStartRun();
  const { pushToast } = useUI();
  const requested = params.get('run');

  const select = (id: string) => {
    const copy = new URLSearchParams(params);
    copy.set('run', id);
    setParams(copy, { replace: true });
  };

  const importOpen = params.get('import') === 'new';
  const draftOpen = params.get('draft') === 'new';
  const batchId = params.get('batch');

  const openImport = () => {
    const copy = new URLSearchParams(params);
    copy.set('import', 'new');
    copy.delete('batch');
    copy.delete('draft');
    setParams(copy);
  };

  const openDraft = () => {
    const copy = new URLSearchParams(params);
    copy.set('draft', 'new');
    copy.delete('batch');
    copy.delete('import');
    setParams(copy);
  };

  const closeDraft = () => {
    const copy = new URLSearchParams(params);
    copy.delete('draft');
    setParams(copy, { replace: true });
  };

  const closeImport = () => {
    const copy = new URLSearchParams(params);
    copy.delete('import');
    setParams(copy, { replace: true });
  };

  const closeBatch = () => {
    const copy = new URLSearchParams(params);
    copy.delete('batch');
    setParams(copy, { replace: true });
  };

  const runStarted = (run: Run) => {
    const copy = new URLSearchParams(params);
    copy.delete('import');
    copy.delete('draft');
    copy.delete('batch');
    copy.set('run', run.id);
    setParams(copy, { replace: true });
  };

  const start = () =>
    startRun.mutate(undefined, {
      onSuccess: (run) => select(run.id),
      onError: (error) => pushToast(`Could not start the run. ${errorMessage(error)}`, 'error'),
    });

  const startButton = (
    <>
      <button type="button" className="btn" onClick={openImport} aria-haspopup="dialog">
        Import from Apify
      </button>
      <button type="button" className="btn" onClick={openDraft} aria-haspopup="dialog">
        Draft outreach
      </button>
      <button type="button" className="btn btn--primary" onClick={start} disabled={startRun.isPending}>
        {startRun.isPending ? 'Starting...' : 'Start demo research'}
      </button>
    </>
  );

  if (runs.isPending) {
    return (
      <div className="screen">
        <PageHeader title="Research" />
        <Loading what="runs" />
      </div>
    );
  }
  if (runs.isError) {
    return (
      <div className="screen">
        <PageHeader title="Research" />
        <ErrorState what="runs" error={runs.error} onRetry={() => void runs.refetch()} />
      </div>
    );
  }

  const items = runs.data;
  const selectedId = requested ?? items[0]?.id ?? null;

  return (
    <div className="screen screen--split">
      <PageHeader title="Research">{startButton}</PageHeader>
      {items.length === 0 && !selectedId ? (
        <EmptyState
          message="No research runs yet. A demo run is simulated: it shows the ledger, counts, and approval flow with synthetic data. An Apify import is real: it runs an actor on your own Apify account. A CSV import starts from the People tab in Relationships. Draft outreach needs an Anthropic key: it writes drafts for you to review and sends nothing."
        />
      ) : (
        <div className="research">
          <nav className="run-list" aria-label="Runs">
            <ul>
              {items.map((run) => (
                <li key={run.id}>
                  <RunListItem run={run} selected={run.id === selectedId} onSelect={() => select(run.id)} />
                </li>
              ))}
            </ul>
          </nav>
          <div className="run-detail">{selectedId ? <RunDetail id={selectedId} /> : null}</div>
        </div>
      )}
      {batchId ? (
        <ImportBatchSheet key={batchId} id={batchId} onClose={closeBatch} />
      ) : importOpen ? (
        <ImportSetupSheet onClose={closeImport} onStarted={runStarted} />
      ) : draftOpen ? (
        <DraftOutreachSheet onClose={closeDraft} onStarted={runStarted} />
      ) : null}
    </div>
  );
}

function RunListItem({ run, selected, onSelect }: { run: Run; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`run-list__item${selected ? ' is-selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="run-list__title">{run.title}</span>
      <span className="run-list__chips">
        {isSimulatedRun(run) ? <SimulatedChip /> : null}
        <RunStatusChip status={run.status} />
      </span>
      <span className="run-list__meta muted">
        <span className="num">
          {run.counts.processed} processed, {run.counts.found} {run.kind === 'draft_outreach' ? 'drafted' : 'found'},{' '}
          {run.counts.flagged} flagged
        </span>
        <span>{run.startedAt ? `Started ${formatAgo(run.startedAt)}` : 'Not started'}</span>
      </span>
    </button>
  );
}

function RunDetail({ id }: { id: string }) {
  const query = useRun(id);
  const control = useControlRun();
  const [confirmCancel, setConfirmCancel] = useState(false);

  if (query.isPending) return <Loading what="run" />;
  if (query.isError) return <ErrorState what="this run" error={query.error} onRetry={() => void query.refetch()} />;

  const run = query.data;
  const canPause = run.status === 'running' || run.status === 'queued';
  const canResume = run.status === 'paused';
  const canCancel = canPause || canResume;
  const approvals = run.approvals ?? [];
  const isApify = run.kind === 'apify_scrape';
  const isDraft = run.kind === 'draft_outreach';
  const batchId = typeof run.scope.batchId === 'string' && run.scope.batchId !== '' ? run.scope.batchId : null;

  const act = (action: 'pause' | 'resume' | 'cancel') => {
    setConfirmCancel(false);
    control.mutate({ id: run.id, action });
  };

  return (
    <article aria-label={`Run: ${run.title}`}>
      <header className="run-detail__header">
        <h2 className="run-detail__title">{run.title}</h2>
        <div className="run-card__chips">
          {isSimulatedRun(run) ? <SimulatedChip /> : null}
          <RunStatusChip status={run.status} />
        </div>
      </header>
      <p className="muted run-detail__times">
        {run.startedAt ? <>Started {formatDateTime(run.startedAt)}</> : 'Not started'}
        {run.finishedAt ? <>, finished {formatDateTime(run.finishedAt)}</> : null}
      </p>
      {isSimulatedRun(run) ? (
        <p className="muted">
          No model is connected. This run is simulated and creates synthetic candidates tagged demo-candidate.
        </p>
      ) : null}

      <CountsList counts={run.counts} kind={run.kind} />
      {isDraft ? (
        <p className="muted">
          Costs are estimates from list prices. Drafts are created for review: approved drafts are saved on each
          person as drafts that were not sent, and nothing is ever sent.
        </p>
      ) : null}
      {isDraft ? <DraftRunIssuesView issues={parseDraftRunIssues(run.scope)} /> : null}

      {batchId ? (
        <p>
          <Link className="link" to={batchHref(batchId, run.id)}>
            View import batch
          </Link>
        </p>
      ) : null}

      {canPause || canResume || canCancel ? (
        <div className="run-controls" role="group" aria-label="Run controls">
          {canPause ? (
            <button type="button" className="btn" onClick={() => act('pause')} disabled={control.isPending}>
              <Icon name="pause" /> Pause run
            </button>
          ) : null}
          {canResume ? (
            <button type="button" className="btn" onClick={() => act('resume')} disabled={control.isPending}>
              <Icon name="play" /> Resume run
            </button>
          ) : null}
          {canCancel && !confirmCancel ? (
            <button type="button" className="btn btn--danger-text" onClick={() => setConfirmCancel(true)} disabled={control.isPending}>
              <Icon name="stop" /> Cancel run
            </button>
          ) : null}
          {confirmCancel ? (
            <span className="run-controls__confirm" role="alert">
              {isApify
                ? 'Cancel this run? Cancelling is final. It also asks Apify to stop the actor run. Apify still bills for the time the actor already ran.'
                : isDraft
                  ? 'Cancel this run? Cancelling is final and no drafts are saved. Model calls already made are still billed to your Anthropic account.'
                  : 'Cancel this run? Cancelling is final.'}
              <button type="button" className="btn btn--danger" onClick={() => act('cancel')}>
                Cancel run
              </button>
              <button type="button" className="btn" onClick={() => setConfirmCancel(false)}>
                Keep running
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      {isApify && (canPause || canResume) ? (
        <p className="muted">
          Pausing stops processing in this app only. The Apify run keeps going and keeps billing until it finishes or
          you cancel.
        </p>
      ) : null}
      {control.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(control.error)} The run state did not change.
        </p>
      ) : null}

      <section className="section" aria-labelledby="ledger-heading">
        <h3 className="section__title" id="ledger-heading">
          Run ledger
        </h3>
        <RunLedger steps={run.steps ?? []} runStatus={run.status} />
      </section>

      <section className="section" aria-labelledby="run-approvals-heading">
        <h3 className="section__title" id="run-approvals-heading">
          Approvals
        </h3>
        {approvals.length === 0 ? (
          <p className="muted">No approvals for this run yet. A run asks for one before it creates any drafts.</p>
        ) : (
          <div className="stack">
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={{ ...approval, runKind: approval.runKind ?? run.kind, runId: approval.runId ?? run.id }}
                expandDrafts
              />
            ))}
          </div>
        )}
      </section>
    </article>
  );
}
