import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePipelines, useReports } from '../api/hooks';
import type { ReportMoney, ReportSource, ReportsData } from '../api/types';
import { EmptyState, ErrorState, Loading, PageHeader } from '../components/common';
import { formatAmount, formatWeek, humanize, runStatusLabel } from '../lib/format';

// Reports is read only: it issues one GET and no mutation, and every number comes from the local database.

const PERIODS: Array<{ value: string; label: string; days: number | null }> = [
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
  { value: '365', label: 'Last 365 days', days: 365 },
  { value: 'all', label: 'All time', days: null },
];
const DEFAULT_PERIOD = '90';

// Stack order matches the server's source precedence. Labels follow the design copy.
const SOURCES: Array<{ key: ReportSource; label: string; fill: string }> = [
  { key: 'mailbox', label: 'Mailbox', fill: '' },
  { key: 'linkedin', label: 'LinkedIn', fill: ' report-bar__fill--2' },
  { key: 'transcript', label: 'Transcript', fill: ' report-bar__fill--6' },
  { key: 'csv', label: 'CSV', fill: ' report-bar__fill--3' },
  { key: 'captured', label: 'Extension', fill: ' report-bar__fill--4' },
  { key: 'manual', label: 'Manual', fill: ' report-bar__fill--5' },
];

function money(amounts: ReportMoney[]): string {
  return amounts.map((entry) => formatAmount(entry.amount, entry.currency)).join(', ');
}

function estimate(usd: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(usd);
}

function ReportCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="today-card" aria-labelledby={id}>
      <header className="today-card__header">
        <h2 className="today-card__title" id={id}>
          {title}
        </h2>
      </header>
      <div className="today-card__body">{children}</div>
    </section>
  );
}

// One row: a label, a bar sized against the largest value in the card, and the value as text so the bar is decoration.
function BarRow({ label, value, max, text, segments }: { label: string; value: number; max: number; text: string; segments?: Array<{ n: number; fill: string }> }) {
  const percent = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="report-row">
      <span className="report-row__label" title={label}>
        {label}
      </span>
      <span className="report-row__bar">
        <span className="report-bar" style={{ width: `${percent}%`, minWidth: value > 0 ? undefined : 0 }} aria-hidden="true">
          {segments ? (
            segments
              .filter((segment) => segment.n > 0)
              .map((segment, index) => (
                <span key={index} className={`report-bar__fill${segment.fill}`} style={{ width: `${(segment.n / value) * 100}%` }} />
              ))
          ) : (
            <span className="report-bar__fill" style={{ width: '100%' }} />
          )}
        </span>
        <span className="report-row__value num">{text}</span>
      </span>
    </div>
  );
}

function PipelineCard({ data }: { data: ReportsData['pipeline'] }) {
  const empty = data.every((stage) => stage.openCount + stage.passedCount + stage.lostCount === 0);
  const max = Math.max(0, ...data.map((stage) => stage.openCount));
  return (
    <ReportCard id="report-pipeline" title="Pipeline now">
      {empty ? (
        <EmptyState message="No deals in this pipeline yet. This card will show open deals and their amounts per stage, plus deals passed or lost in the period." />
      ) : (
        <>
          <p className="report-note">
            Passed and lost deals are counted by when they were last updated, so the period is an approximation.
          </p>
          <div className="report-rows">
            {data.map((stage) => {
              const amounts = money(stage.openAmounts);
              const closed = [
                stage.passedCount > 0 ? `${stage.passedCount} passed${stage.passedAmounts.length ? ` (${money(stage.passedAmounts)})` : ''}` : '',
                stage.lostCount > 0 ? `${stage.lostCount} lost${stage.lostAmounts.length ? ` (${money(stage.lostAmounts)})` : ''}` : '',
              ].filter(Boolean);
              return (
                <div key={stage.stageId}>
                  <BarRow
                    label={stage.name}
                    value={stage.openCount}
                    max={max}
                    text={`${stage.openCount} open${amounts ? `, ${amounts}` : ''}`}
                  />
                  {closed.length > 0 ? <div className="report-note">{closed.join(', ')} in this period</div> : null}
                </div>
              );
            })}
          </div>
        </>
      )}
    </ReportCard>
  );
}

function StageFlowCard({ data }: { data: ReportsData['stageFlow'] }) {
  const max = Math.max(0, ...data.map((stage) => stage.entered));
  return (
    <ReportCard id="report-flow" title="Stage flow">
      {max === 0 ? (
        <EmptyState message="No deals entered a stage in this period. This card will show how many deals entered each stage." />
      ) : (
        <>
          <p className="report-note">A deal that re-enters a stage counts again.</p>
          <div className="report-rows">
            {data.map((stage) => (
              <BarRow key={stage.stageId} label={stage.name} value={stage.entered} max={max} text={`${stage.entered} entered`} />
            ))}
          </div>
        </>
      )}
    </ReportCard>
  );
}

function IntakeCard({ data }: { data: ReportsData['intake'] }) {
  const max = Math.max(0, ...data.weeks.map((week) => week.total));
  return (
    <ReportCard id="report-intake" title="New people">
      {data.weeks.length === 0 ? (
        <EmptyState message="No people were added in this period. This card will show new people per week by where they came from." />
      ) : (
        <>
          <ul className="report-legend" aria-label="Sources">
            {SOURCES.map((source) => (
              <li key={source.key}>
                <span className={`report-legend__swatch report-bar__fill${source.fill}`} aria-hidden="true" />
                {source.label}
              </li>
            ))}
          </ul>
          <div className="report-rows">
            {data.weeks.map((week) => {
              const parts = SOURCES.filter((source) => week.bySource[source.key] > 0).map(
                (source) => `${source.label} ${week.bySource[source.key]}`,
              );
              return (
                <BarRow
                  key={week.weekStart}
                  label={`Week of ${formatWeek(week.weekStart)}`}
                  value={week.total}
                  max={max}
                  text={`${week.total} (${parts.join(', ')})`}
                  segments={SOURCES.map((source) => ({ n: week.bySource[source.key], fill: source.fill }))}
                />
              );
            })}
          </div>
        </>
      )}
    </ReportCard>
  );
}

function OutreachCard({ data }: { data: ReportsData['outreach'] }) {
  const empty = data.sends + data.replies + data.bounces + data.optOuts === 0;
  const figures: Array<[string, number]> = [
    ['Sends', data.sends],
    ['Replies', data.replies],
    ['Bounces', data.bounces],
    ['Opt outs', data.optOuts],
  ];
  return (
    <ReportCard id="report-outreach" title="Outreach">
      {empty ? (
        <EmptyState message="No email activity in this period. This card will show sends, replies, bounces, and opt outs." />
      ) : (
        <dl className="report-figures">
          {figures.map(([label, value]) => (
            <div key={label} className="report-figure">
              <dt>{label}</dt>
              <dd className="num">{value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      )}
    </ReportCard>
  );
}

function RunsCard({ data }: { data: ReportsData['runs'] }) {
  const kinds = [...new Set(data.groups.map((group) => group.kind))];
  const max = Math.max(0, ...kinds.map((kind) => data.groups.filter((group) => group.kind === kind).reduce((sum, group) => sum + group.count, 0)));
  return (
    <ReportCard id="report-runs" title="Runs">
      {data.groups.length === 0 ? (
        <EmptyState message="No runs finished in this period. This card will show runs by kind and outcome, with estimated spend." />
      ) : (
        <>
          <div className="report-rows">
            {kinds.map((kind) => {
              const groups = data.groups.filter((group) => group.kind === kind);
              const total = groups.reduce((sum, group) => sum + group.count, 0);
              return (
                <BarRow
                  key={kind}
                  label={humanize(kind)}
                  value={total}
                  max={max}
                  text={`${total}: ${groups.map((group) => `${group.count} ${runStatusLabel(group.status).toLowerCase()}`).join(', ')}`}
                />
              );
            })}
          </div>
          <p className="report-note">
            {data.runsWithEstimate > 0
              ? `Estimated spend ${estimate(data.estimatedUsd)} (estimate, from ${data.runsWithEstimate} ${data.runsWithEstimate === 1 ? 'run' : 'runs'} that report one).`
              : 'No estimated spend reported in this period.'}
          </p>
        </>
      )}
    </ReportCard>
  );
}

export function Reports() {
  const pipelines = usePipelines();
  const [params, setParams] = useSearchParams();
  // An unknown days value falls back to 90, like an unknown pipeline falls back to the first.
  const periodValue = PERIODS.some((period) => period.value === params.get('days')) ? (params.get('days') as string) : DEFAULT_PERIOD;
  const days = PERIODS.find((period) => period.value === periodValue)!.days;
  const requestedPipelineId = params.get('pipeline');
  const activePipeline = pipelines.data?.find((pipeline) => pipeline.id === requestedPipelineId) ?? pipelines.data?.[0];
  const reports = useReports(days, activePipeline?.id, pipelines.isSuccess);

  const setParam = (key: string, value: string) => {
    const copy = new URLSearchParams(params);
    copy.set(key, value);
    setParams(copy);
  };

  const header = (
    <PageHeader title="Reports">
      <div className="reports-filters">
        <label className="sr-only" htmlFor="reports-period">
          Period
        </label>
        <select id="reports-period" className="input input--select" value={periodValue} onChange={(event) => setParam('days', event.target.value)}>
          {PERIODS.map((period) => (
            <option key={period.value} value={period.value}>
              {period.label}
            </option>
          ))}
        </select>
        {pipelines.data && pipelines.data.length > 0 ? (
          <>
            <label className="sr-only" htmlFor="reports-pipeline">
              Pipeline
            </label>
            <select
              id="reports-pipeline"
              className="input input--select"
              value={activePipeline?.id ?? ''}
              onChange={(event) => setParam('pipeline', event.target.value)}
            >
              {pipelines.data.map((pipeline) => (
                <option key={pipeline.id} value={pipeline.id}>
                  {pipeline.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>
    </PageHeader>
  );

  if (pipelines.isError) {
    return (
      <div className="screen">
        {header}
        <ErrorState what="reports" error={pipelines.error} onRetry={() => void pipelines.refetch()} />
      </div>
    );
  }
  if (pipelines.isPending || reports.isPending) {
    return (
      <div className="screen">
        {header}
        <Loading what="reports" />
      </div>
    );
  }
  if (reports.isError) {
    return (
      <div className="screen">
        {header}
        <ErrorState what="reports" error={reports.error} onRetry={() => void reports.refetch()} />
      </div>
    );
  }

  const data = reports.data;
  return (
    <div className="screen">
      {header}
      <div className="today-area">
        <div className="today">
          <PipelineCard data={data.pipeline} />
          <StageFlowCard data={data.stageFlow} />
          <IntakeCard data={data.intake} />
          <OutreachCard data={data.outreach} />
          <RunsCard data={data.runs} />
        </div>
      </div>
    </div>
  );
}
