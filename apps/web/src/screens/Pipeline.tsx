import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { api, isVersionConflict } from '../api/client';
import {
  useActivities,
  useMoveStage,
  useOpportunities,
  usePatchOpportunity,
  usePipelines,
} from '../api/hooks';
import type { Opportunity, OpportunityStatus, Pipeline as PipelineType, Stage } from '../api/types';
import {
  ActionMenu,
  Chip,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Sheet,
  errorMessage,
  type MenuItem,
} from '../components/common';
import { NoteForm, SheetSection, Timeline } from '../components/record';
import { VirtualTable, type Column } from '../components/VirtualTable';
import { describeDue, formatAmount, humanize } from '../lib/format';
import { useUI } from '../lib/ui';

type View = 'board' | 'table';
type StatusFilter = 'open' | 'nurture' | 'passed' | 'lost' | 'all';

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'nurture', label: 'Nurture' },
  { value: 'passed', label: 'Passed' },
  { value: 'lost', label: 'Lost' },
  { value: 'all', label: 'All statuses' },
];

function sumLabel(opportunities: Opportunity[]): string {
  const totals = new Map<string, number>();
  for (const item of opportunities) {
    if (item.amountTarget === null || item.amountTarget === undefined) continue;
    const amount = Number(item.amountTarget);
    if (!Number.isFinite(amount)) continue;
    const currency = item.currency || 'USD';
    totals.set(currency, (totals.get(currency) ?? 0) + amount);
  }
  if (totals.size === 0) return 'No amounts';
  return Array.from(totals.entries())
    .map(([currency, total]) => formatAmount(total, currency))
    .join(', ');
}

function stageMenuItems(
  opportunity: Opportunity,
  stages: Stage[],
  move: (opportunity: Opportunity, stage: Stage) => void,
  openStatus: (opportunity: Opportunity) => void,
): MenuItem[] {
  return [
    ...stages.map((stage) => ({
      key: stage.id,
      label: stage.id === opportunity.stageId ? `${stage.name} (current)` : `Move to ${stage.name}`,
      checked: stage.id === opportunity.stageId,
      disabled: stage.id === opportunity.stageId,
      onSelect: () => move(opportunity, stage),
    })),
    { key: 'status', label: 'Change status...', onSelect: () => openStatus(opportunity) },
  ];
}

export function Pipeline() {
  const pipelines = usePipelines();
  const [params, setParams] = useSearchParams();
  const openId = params.get('opportunity');
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [view, setView] = useState<View>('board');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const move = useMoveStage();

  const activePipeline: PipelineType | undefined =
    pipelines.data?.find((pipeline) => pipeline.id === pipelineId) ?? pipelines.data?.[0];

  const list = useOpportunities({
    pipelineId: activePipeline?.id,
    status: statusFilter === 'all' ? undefined : statusFilter,
  });

  // The sheet must find an opportunity even when the status filter hides it.
  const everything = useQueries({
    queries: (pipelines.data ?? []).map((pipeline) => ({
      queryKey: ['opportunities', pipeline.id, ''],
      queryFn: () => api.opportunities.list({ pipelineId: pipeline.id }),
      enabled: Boolean(openId),
    })),
  });
  const openOpportunity = useMemo(() => {
    if (!openId) return null;
    for (const result of everything) {
      const found = result.data?.find((item) => item.id === openId);
      if (found) return found;
    }
    return list.data?.find((item) => item.id === openId) ?? null;
  }, [openId, everything, list.data]);
  const lookupPending = Boolean(openId) && !openOpportunity && everything.some((result) => result.isPending);

  useEffect(() => {
    if (openOpportunity && openOpportunity.pipelineId !== activePipeline?.id) {
      setPipelineId(openOpportunity.pipelineId);
    }
    // Only follow a deep link when the opened record changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openOpportunity?.id]);

  const open = useCallback(
    (id: string) => {
      const copy = new URLSearchParams(params);
      copy.set('opportunity', id);
      setParams(copy);
    },
    [params, setParams],
  );
  const close = useCallback(() => {
    const copy = new URLSearchParams(params);
    copy.delete('opportunity');
    setParams(copy, { replace: true });
  }, [params, setParams]);

  const moveTo = useCallback(
    (opportunity: Opportunity, stage: Stage) =>
      move.mutate({ opportunity, stageId: stage.id, stageName: stage.name }),
    [move],
  );

  if (pipelines.isPending) {
    return (
      <div className="screen">
        <PageHeader title="Pipeline" />
        <Loading what="pipeline" />
      </div>
    );
  }
  if (pipelines.isError) {
    return (
      <div className="screen">
        <PageHeader title="Pipeline" />
        <ErrorState what="the pipeline" error={pipelines.error} onRetry={() => void pipelines.refetch()} />
      </div>
    );
  }
  if (!activePipeline) {
    return (
      <div className="screen">
        <PageHeader title="Pipeline" />
        <EmptyState framed icon="pipeline" message="No pipeline exists yet. Seed the demo workspace to create one with stages." />
      </div>
    );
  }

  const opportunities = list.data ?? [];

  return (
    <div className="screen screen--table">
      <PageHeader title="Pipeline">
        {pipelines.data.length > 1 ? (
          <>
            <label className="sr-only" htmlFor="pipeline-select">
              Pipeline
            </label>
            <select
              id="pipeline-select"
              className="input input--select"
              value={activePipeline.id}
              onChange={(event) => setPipelineId(event.target.value)}
            >
              {pipelines.data.map((pipeline) => (
                <option key={pipeline.id} value={pipeline.id}>
                  {pipeline.name}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span className="muted">{activePipeline.name}</span>
        )}
        <label className="sr-only" htmlFor="status-filter">
          Status
        </label>
        <select
          id="status-filter"
          className="input input--select"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
        >
          {STATUS_FILTERS.map((filter) => (
            <option key={filter.value} value={filter.value}>
              {filter.label}
            </option>
          ))}
        </select>
        <div className="segmented" role="group" aria-label="View">
          <button type="button" className={view === 'board' ? 'is-active' : ''} aria-pressed={view === 'board'} onClick={() => setView('board')}>
            Board
          </button>
          <button type="button" className={view === 'table' ? 'is-active' : ''} aria-pressed={view === 'table'} onClick={() => setView('table')}>
            Table
          </button>
        </div>
      </PageHeader>

      <div className="table-region">
        {list.isPending ? (
          <Loading what="opportunities" />
        ) : list.isError && !list.data ? (
          <ErrorState what="opportunities" error={list.error} onRetry={() => void list.refetch()} />
        ) : view === 'board' ? (
          <Board
            stages={activePipeline.stages}
            opportunities={opportunities}
            selectedId={openId}
            onOpen={open}
            onMove={moveTo}
            onStatus={(opportunity) => open(opportunity.id)}
          />
        ) : opportunities.length === 0 ? (
          <EmptyState
            framed
            icon="deal"
            message="No opportunities match this status. Choose another status or move a record into the pipeline."
          />
        ) : (
          <OpportunityTable
            stages={activePipeline.stages}
            opportunities={opportunities}
            selectedId={openId}
            onOpen={open}
            onMove={moveTo}
          />
        )}

        {openId ? (
          openOpportunity ? (
            <OpportunitySheet opportunity={openOpportunity} stages={pipelines.data.flatMap((p) => p.stages)} onClose={close} />
          ) : (
            <Sheet title="Opportunity" onClose={close}>
              {lookupPending ? (
                <Loading what="opportunity" />
              ) : (
                <EmptyState message="This opportunity was not found. It may have been removed, or the link is out of date." />
              )}
            </Sheet>
          )
        ) : null}
      </div>
    </div>
  );
}

function Board({
  stages,
  opportunities,
  selectedId,
  onOpen,
  onMove,
  onStatus,
}: {
  stages: Stage[];
  opportunities: Opportunity[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onMove: (opportunity: Opportunity, stage: Stage) => void;
  onStatus: (opportunity: Opportunity) => void;
}) {
  return (
    <div className="board" role="list" aria-label="Pipeline stages">
      {stages.map((stage) => {
        const cards = opportunities.filter((item) => item.stageId === stage.id);
        return (
          <section key={stage.id} className="board__column" role="listitem" aria-label={`${stage.name}, ${cards.length} opportunities`}>
            <header className="board__header">
              <h2 className="board__stage">{stage.name}</h2>
              <span className="board__count num">{cards.length}</span>
              <span className="board__sum num">{sumLabel(cards)}</span>
            </header>
            <ul className="board__cards">
              {cards.length === 0 ? <li className="muted board__empty">No opportunities in this stage.</li> : null}
              {cards.map((item) => (
                <li key={item.id}>
                  <article className={`card${selectedId === item.id ? ' is-selected' : ''}`}>
                    <div className="card__top">
                      <button type="button" className="card__name" onClick={() => onOpen(item.id)}>
                        {item.name}
                      </button>
                      <ActionMenu
                        label={`Actions for ${item.name}`}
                        items={stageMenuItems(item, stages, onMove, onStatus)}
                      />
                    </div>
                    <p className="card__sub">{item.organizationName || item.personName || ''}</p>
                    <div className="card__foot">
                      <span className="num">{formatAmount(item.amountTarget, item.currency)}</span>
                      {item.status !== 'open' ? <Chip>{humanize(item.status)}</Chip> : null}
                      {item.nextActionAt ? (
                        <span className={`muted num${describeDue(item.nextActionAt).overdue ? ' is-overdue' : ''}`}>
                          {describeDue(item.nextActionAt).text}
                        </span>
                      ) : null}
                    </div>
                  </article>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function OpportunityTable({
  stages,
  opportunities,
  selectedId,
  onOpen,
  onMove,
}: {
  stages: Stage[];
  opportunities: Opportunity[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onMove: (opportunity: Opportunity, stage: Stage) => void;
}) {
  const stageNames = useMemo(() => new Map(stages.map((stage) => [stage.id, stage.name])), [stages]);
  const columns = useMemo<Column<Opportunity>[]>(
    () => [
      { key: 'name', header: 'Name', width: 'minmax(180px, 1.5fr)', render: (row) => <span className="cell-name">{row.name}</span> },
      { key: 'org', header: 'Organization', width: 'minmax(120px, 1.2fr)', render: (row) => <span className="cell-text">{row.organizationName}</span> },
      { key: 'stage', header: 'Stage', width: 'minmax(100px, 1fr)', render: (row) => <span className="cell-text">{stageNames.get(row.stageId) ?? ''}</span> },
      { key: 'amount', header: 'Amount', width: '96px', numeric: true, render: (row) => <span className="num">{formatAmount(row.amountTarget, row.currency)}</span> },
      { key: 'status', header: 'Status', width: '96px', render: (row) => <span className="cell-text">{humanize(row.status)}</span> },
      {
        key: 'next',
        header: 'Next action',
        width: '112px',
        numeric: true,
        render: (row) =>
          row.nextActionAt ? (
            <span className={`num${describeDue(row.nextActionAt).overdue ? ' is-overdue' : ''}`}>{describeDue(row.nextActionAt).text}</span>
          ) : (
            <span className="muted">None</span>
          ),
      },
      {
        key: 'menu',
        header: 'Actions',
        width: '56px',
        render: (row) => (
          <ActionMenu label={`Actions for ${row.name}`} items={stageMenuItems(row, stages, onMove, (item) => onOpen(item.id))} />
        ),
      },
    ],
    [stageNames, stages, onMove, onOpen],
  );
  return (
    <VirtualTable
      label="Opportunities"
      columns={columns}
      rows={opportunities}
      getKey={(row) => row.id}
      selectedKey={selectedId}
      onOpen={(row) => onOpen(row.id)}
    />
  );
}

const STATUS_CHOICES: Array<{ value: OpportunityStatus; label: string; hint: string }> = [
  { value: 'open', label: 'Open', hint: 'Active in the pipeline' },
  { value: 'nurture', label: 'Nurture', hint: 'Not now, keep warm' },
  { value: 'passed', label: 'Passed', hint: 'We are not pursuing it' },
  { value: 'lost', label: 'Lost', hint: 'They chose not to proceed' },
];

function OpportunitySheet({
  opportunity,
  stages,
  onClose,
}: {
  opportunity: Opportunity;
  stages: Stage[];
  onClose: () => void;
}) {
  const { setSelectedRecord } = useUI();
  const patch = usePatchOpportunity();
  const activities = useActivities('opportunity', opportunity.id);
  const [status, setStatus] = useState<OpportunityStatus>(opportunity.status);
  const [reason, setReason] = useState(opportunity.reason ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSelectedRecord({ kind: 'opportunity', id: opportunity.id, label: opportunity.name });
    return () => setSelectedRecord(null);
  }, [opportunity.id, opportunity.name, setSelectedRecord]);

  useEffect(() => {
    setStatus(opportunity.status);
    setReason(opportunity.reason ?? '');
  }, [opportunity.id, opportunity.version, opportunity.status, opportunity.reason]);

  const stageName = stages.find((stage) => stage.id === opportunity.stageId)?.name ?? '';
  const changed = status !== opportunity.status || reason.trim() !== (opportunity.reason ?? '');

  const save = (versionOverride?: number) => {
    setSaved(false);
    if (status !== 'open' && !reason.trim()) {
      setProblem('Add a reason so the history explains this change.');
      return;
    }
    setProblem(null);
    setConflictVersion(null);
    patch.mutate(
      {
        id: opportunity.id,
        expectedVersion: versionOverride ?? opportunity.version,
        fields: { status, reason: status === 'open' ? null : reason.trim() },
      },
      {
        onSuccess: () => setSaved(true),
        onError: (error) => {
          if (isVersionConflict(error)) {
            const current = (error.current ?? {}) as Record<string, unknown>;
            setConflictVersion(typeof current.version === 'number' ? current.version : null);
            setProblem(
              `This opportunity changed since you opened it${
                typeof current.status === 'string' ? ` (status is now ${humanize(current.status)})` : ''
              }. Your status change was not saved.`,
            );
          } else {
            setProblem(`${errorMessage(error)} Your status change was not saved.`);
          }
        },
      },
    );
  };

  return (
    <Sheet
      title={opportunity.name}
      subtitle={[opportunity.organizationName, stageName].filter(Boolean).join(', ')}
      onClose={onClose}
    >
      <SheetSection title="Fields">
        <dl className="fields">
          <div className="field">
            <dt className="field__label">Stage</dt>
            <dd className="field__value">{stageName || 'Unknown'}</dd>
          </div>
          <div className="field">
            <dt className="field__label">Amount</dt>
            <dd className="field__value num">{formatAmount(opportunity.amountTarget, opportunity.currency) || 'Not set'}</dd>
          </div>
          <div className="field">
            <dt className="field__label">Organization</dt>
            <dd className="field__value">{opportunity.organizationName || 'None'}</dd>
          </div>
          <div className="field">
            <dt className="field__label">Contact</dt>
            <dd className="field__value">{opportunity.personName || 'None'}</dd>
          </div>
          <div className="field">
            <dt className="field__label">Owner</dt>
            <dd className="field__value">{opportunity.owner || 'Unassigned'}</dd>
          </div>
          <div className="field">
            <dt className="field__label">Next action</dt>
            <dd className="field__value">{opportunity.nextActionAt ? describeDue(opportunity.nextActionAt).text : 'Not set'}</dd>
          </div>
        </dl>
      </SheetSection>

      <SheetSection title="Status">
        <form
          className="status-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="radio-group" role="radiogroup" aria-label="Status">
            {STATUS_CHOICES.map((choice) => (
              <label key={choice.value} className="radio">
                <input
                  type="radio"
                  name="opportunity-status"
                  value={choice.value}
                  checked={status === choice.value}
                  onChange={() => {
                    setStatus(choice.value);
                    setSaved(false);
                  }}
                />
                <span>
                  {choice.label}
                  <span className="muted"> {choice.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {status !== 'open' ? (
            <>
              <label className="field__label" htmlFor="status-reason">
                Reason
              </label>
              <textarea
                id="status-reason"
                className="input"
                rows={3}
                value={reason}
                placeholder={`Why is this ${humanize(status)}?`}
                onChange={(event) => {
                  setReason(event.target.value);
                  setSaved(false);
                }}
              />
            </>
          ) : null}
          {problem ? (
            <div className="conflict" role="alert">
              <p>{problem}</p>
              {conflictVersion !== null ? (
                <div className="conflict__actions">
                  <button type="button" className="btn" onClick={() => {
                      setProblem(null);
                      setConflictVersion(null);
                    }}>
                    Dismiss
                  </button>
                  <button type="button" className="btn" onClick={() => save(conflictVersion)}>
                    Save my status over it
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {saved ? (
            <p className="muted" role="status">
              Status saved.
            </p>
          ) : null}
          <div>
            <button type="submit" className="btn btn--primary" disabled={!changed || patch.isPending}>
              {patch.isPending ? 'Saving status...' : 'Save status'}
            </button>
          </div>
        </form>
      </SheetSection>

      <SheetSection title="Notes and activity">
        <NoteForm entityType="opportunity" entityId={opportunity.id} />
        {activities.isPending ? <Loading what="activity" /> : null}
        {activities.isError ? <ErrorState what="activity" error={activities.error} onRetry={() => void activities.refetch()} /> : null}
        {activities.data ? <Timeline activities={activities.data} /> : null}
      </SheetSection>
    </Sheet>
  );
}
