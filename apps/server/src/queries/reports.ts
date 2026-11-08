import type { Db } from '../db.js';
import type { Row } from '../records.js';

export type ReportDays = 30 | 90 | 365;

export interface MoneyTotal {
  currency: string;
  amount: number;
}

export interface PipelineStageReport {
  stageId: string;
  name: string;
  seq: number;
  openCount: number;
  openAmounts: MoneyTotal[];
  // "won" counts deals whose status is passed, "lost" counts lost, both with updated_at inside the period.
  passedCount: number;
  passedAmounts: MoneyTotal[];
  lostCount: number;
  lostAmounts: MoneyTotal[];
}

export type IntakeSource = 'mailbox' | 'linkedin' | 'transcript' | 'csv' | 'captured' | 'manual';

export interface IntakeWeek {
  // The Monday (UTC) that starts the week, as YYYY-MM-DD.
  weekStart: string;
  total: number;
  bySource: Record<IntakeSource, number>;
}

export interface ReportsData {
  pipeline: PipelineStageReport[];
  stageFlow: Array<{ stageId: string; name: string; seq: number; entered: number }>;
  intake: { weeks: IntakeWeek[] };
  outreach: { sends: number; replies: number; bounces: number; optOuts: number };
  runs: {
    groups: Array<{ kind: string; status: string; count: number }>;
    // Sum of counts.estimatedUsd over runs that report one. An estimate, never a bill.
    estimatedUsd: number;
    runsWithEstimate: number;
  };
}

const DAY_MS = 86_400_000;

// Tag to source, in precedence order. The first tag a person carries decides the source.
const SOURCE_TAGS: Array<[string, IntakeSource]> = [
  ['mailbox-import', 'mailbox'],
  ['linkedin-leads', 'linkedin'],
  ['transcript-import', 'transcript'],
  ['csv-import', 'csv'],
  ['captured', 'captured'],
];

export function intakeSource(tags: string[]): IntakeSource {
  for (const [tag, source] of SOURCE_TAGS) if (tags.includes(tag)) return source;
  return 'manual';
}

// Weeks are calendar weeks starting Monday in UTC, not rolling 7 day buckets, so a bar means the same
// span whenever the screen is opened. The key is the Monday's date.
export function weekStartOf(iso: string): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const date = new Date(time);
  date.setUTCHours(0, 0, 0, 0);
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

function parseTags(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function parseEstimate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  try {
    const estimate = (JSON.parse(value) as { estimatedUsd?: unknown } | null)?.estimatedUsd;
    return typeof estimate === 'number' && Number.isFinite(estimate) ? estimate : null;
  } catch {
    return null;
  }
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

function addMoney(totals: MoneyTotal[], currency: string, amount: number): void {
  if (amount <= 0) return;
  const existing = totals.find((total) => total.currency === currency);
  if (existing) existing.amount += amount;
  else totals.push({ currency, amount });
}

export function getReports(
  db: Db,
  workspaceId: string,
  days: ReportDays | null,
  pipelineId: string | null,
  now: Date = new Date(),
): ReportsData {
  // ISO string comparison like the rest of the codebase. All time uses the empty string, which sorts before any timestamp.
  const since = days === null ? '' : new Date(now.getTime() - days * DAY_MS).toISOString();

  // No pipelineId means the first pipeline. An id that names no pipeline of this workspace is not an error:
  // the pipeline sections come back empty so a stale link still renders the screen.
  const chosen = (
    pipelineId === null
      ? db.prepare('SELECT id FROM pipeline WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1').get(workspaceId)
      : db.prepare('SELECT id FROM pipeline WHERE workspace_id = ? AND id = ?').get(workspaceId, pipelineId)
  ) as { id: string } | undefined;

  const pipeline: PipelineStageReport[] = [];
  const stageFlow: ReportsData['stageFlow'] = [];
  if (chosen) {
    const stages = db
      .prepare('SELECT id, name, seq FROM stage WHERE pipeline_id = ? ORDER BY seq, id')
      .all(chosen.id) as Row[];
    const byStage = new Map<string, PipelineStageReport>();
    for (const stage of stages) {
      const report: PipelineStageReport = {
        stageId: String(stage.id),
        name: String(stage.name),
        seq: Number(stage.seq),
        openCount: 0,
        openAmounts: [],
        passedCount: 0,
        passedAmounts: [],
        lostCount: 0,
        lostAmounts: [],
      };
      byStage.set(report.stageId, report);
      pipeline.push(report);
    }
    // Status is current state: open deals are counted as they stand now, closed deals by when they were last updated.
    const deals = db
      .prepare(
        `SELECT stage_id, status, currency, COUNT(*) AS n, COALESCE(SUM(amount_target), 0) AS amount
         FROM opportunity
         WHERE workspace_id = ? AND pipeline_id = ?
           AND (status = 'open' OR (status IN ('passed', 'lost') AND updated_at >= ?))
         GROUP BY stage_id, status, currency
         ORDER BY currency`,
      )
      .all(workspaceId, chosen.id, since) as Row[];
    for (const deal of deals) {
      const report = byStage.get(String(deal.stage_id));
      if (!report) continue;
      const n = Number(deal.n);
      const currency = String(deal.currency);
      const amount = Number(deal.amount);
      if (deal.status === 'open') {
        report.openCount += n;
        addMoney(report.openAmounts, currency, amount);
      } else if (deal.status === 'passed') {
        report.passedCount += n;
        addMoney(report.passedAmounts, currency, amount);
      } else {
        report.lostCount += n;
        addMoney(report.lostAmounts, currency, amount);
      }
    }

    // Creation writes a stage_event with no from stage, so it counts as entering the first recorded stage.
    // A deal that re-enters a stage counts again.
    const entered = db
      .prepare(
        `SELECT e.to_stage_id AS stage_id, COUNT(*) AS n
         FROM stage_event e JOIN opportunity o ON o.id = e.opportunity_id
         WHERE o.workspace_id = ? AND o.pipeline_id = ? AND e.at >= ?
         GROUP BY e.to_stage_id`,
      )
      .all(workspaceId, chosen.id, since) as Row[];
    const enteredBy = new Map(entered.map((row) => [String(row.stage_id), Number(row.n)]));
    for (const stage of pipeline) {
      stageFlow.push({ stageId: stage.stageId, name: stage.name, seq: stage.seq, entered: enteredBy.get(stage.stageId) ?? 0 });
    }
  }

  const weeks = new Map<string, IntakeWeek>();
  const people = db
    .prepare('SELECT created_at, tags FROM person WHERE workspace_id = ? AND created_at >= ?')
    .all(workspaceId, since) as Row[];
  for (const person of people) {
    const key = weekStartOf(String(person.created_at));
    if (key === null) continue;
    let week = weeks.get(key);
    if (!week) {
      week = { weekStart: key, total: 0, bySource: { mailbox: 0, linkedin: 0, transcript: 0, csv: 0, captured: 0, manual: 0 } };
      weeks.set(key, week);
    }
    week.total += 1;
    week.bySource[intakeSource(parseTags(person.tags))] += 1;
  }

  // A send counts once the provider accepted it, so intents that later turned into a reply or a bounce still count.
  const outreach = {
    sends: count(
      db,
      `SELECT COUNT(*) AS n FROM send_intent
       WHERE workspace_id = ? AND status IN ('accepted', 'replied', 'bounced') AND submitted_at >= ?`,
      workspaceId,
      since,
    ),
    replies: count(
      db,
      `SELECT COUNT(*) AS n FROM email_message
       WHERE workspace_id = ? AND direction = 'in' AND person_id IS NOT NULL AND provider_timestamp >= ?`,
      workspaceId,
      since,
    ),
    bounces: count(
      db,
      `SELECT COUNT(*) AS n FROM suppression WHERE workspace_id = ? AND reason = 'bounce' AND created_at >= ?`,
      workspaceId,
      since,
    ),
    optOuts: count(
      db,
      `SELECT COUNT(*) AS n FROM suppression WHERE workspace_id = ? AND reason = 'opt_out' AND created_at >= ?`,
      workspaceId,
      since,
    ),
  };

  const runRows = db
    .prepare('SELECT kind, status, counts FROM run WHERE workspace_id = ? AND finished_at IS NOT NULL AND finished_at >= ?')
    .all(workspaceId, since) as Row[];
  const groups = new Map<string, { kind: string; status: string; count: number }>();
  let estimatedUsd = 0;
  let runsWithEstimate = 0;
  for (const run of runRows) {
    const kind = String(run.kind);
    const status = String(run.status);
    const key = `${kind}\u0000${status}`;
    const group = groups.get(key) ?? { kind, status, count: 0 };
    group.count += 1;
    groups.set(key, group);
    const estimate = parseEstimate(run.counts);
    if (estimate !== null) {
      estimatedUsd += estimate;
      runsWithEstimate += 1;
    }
  }

  return {
    pipeline,
    stageFlow,
    intake: { weeks: [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)) },
    outreach,
    runs: {
      groups: [...groups.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.status.localeCompare(b.status)),
      estimatedUsd: Math.round(estimatedUsd * 1_000_000) / 1_000_000,
      runsWithEstimate,
    },
  };
}
