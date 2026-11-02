import type { Db } from '../db.js';
import { notFound, validationError } from '../errors.js';
import {
  activeRunStatuses,
  type Row,
  type RunStatus,
  toApproval,
  toRun,
  toRunStep,
} from '../records.js';
import { paginate, type Page } from './pagination.js';

const allStatuses: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting_approval',
  'paused',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
];

export function getRun(db: Db, workspaceId: string, id: string) {
  const row = db.prepare('SELECT * FROM run WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as
    | Row
    | undefined;
  return row ? toRun(row) : null;
}

export function requireRun(db: Db, workspaceId: string, id: string) {
  const run = getRun(db, workspaceId, id);
  if (!run) throw notFound('Run');
  return run;
}

export function listRunSteps(db: Db, runId: string) {
  return (db.prepare('SELECT * FROM run_step WHERE run_id = ? ORDER BY seq, id').all(runId) as Row[]).map(toRunStep);
}

export function getRunDetail(db: Db, workspaceId: string, id: string) {
  const run = requireRun(db, workspaceId, id);
  return {
    ...run,
    steps: listRunSteps(db, id),
    approvals: (
      db
        .prepare(
          `SELECT a.*, r.title AS run_title FROM approval a JOIN run r ON r.id = a.run_id
           WHERE a.workspace_id = ? AND a.run_id = ? ORDER BY a.created_at, a.id`,
        )
        .all(workspaceId, id) as Row[]
    ).map(toApproval),
  };
}

export interface ListRunsInput {
  status?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

// Accepts one status, a comma separated list, or "active" for every unfinished status.
function parseStatuses(value: string): RunStatus[] {
  if (value === 'active') return [...activeRunStatuses];
  const parts = value.split(',').map((part) => part.trim());
  for (const part of parts) {
    if (!allStatuses.includes(part as RunStatus)) throw validationError(`Run status "${part}" is not valid.`);
  }
  return parts as RunStatus[];
}

// Large arrays kept in a run's scope. The list leaves them out so one long draft run does not bloat every poll.
// GET /api/runs/:id and the approval payload keep them.
const bulkyScopeKeys = ['drafts', 'failures', 'skipped', 'audienceIds'] as const;

function trimScopeForList(run: ReturnType<typeof toRun>): ReturnType<typeof toRun> {
  if (!bulkyScopeKeys.some((key) => key in run.scope)) return run;
  const scope = { ...run.scope };
  for (const key of bulkyScopeKeys) delete scope[key];
  return { ...run, scope };
}

export function listRuns(db: Db, workspaceId: string, input: ListRunsInput = {}): Page<ReturnType<typeof toRun>> {
  const where = ['r.workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (input.status) {
    const statuses = parseStatuses(input.status);
    where.push(`r.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  return paginate({
    db,
    workspaceId,
    select: 'SELECT r.* FROM run r',
    table: 'run',
    alias: 'r',
    where,
    params,
    keys: ['r.created_at', 'r.id'],
    direction: 'DESC',
    cursor: input.cursor,
    limit: input.limit,
    map: (row) => trimScopeForList(toRun(row)),
  });
}

export const approvalSelect = 'SELECT a.*, r.title AS run_title FROM approval a JOIN run r ON r.id = a.run_id';

export function getApproval(db: Db, workspaceId: string, id: string) {
  const row = db
    .prepare(`${approvalSelect} WHERE a.workspace_id = ? AND a.id = ?`)
    .get(workspaceId, id) as Row | undefined;
  return row ? toApproval(row) : null;
}

export function requireApproval(db: Db, workspaceId: string, id: string) {
  const approval = getApproval(db, workspaceId, id);
  if (!approval) throw notFound('Approval');
  return approval;
}

export interface ListApprovalsInput {
  status?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export function listApprovals(
  db: Db,
  workspaceId: string,
  input: ListApprovalsInput = {},
): Page<ReturnType<typeof toApproval>> {
  const where = ['a.workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (input.status) {
    if (!['pending', 'approved', 'rejected'].includes(input.status)) {
      throw validationError(`Approval status "${input.status}" is not valid.`);
    }
    where.push('a.status = ?');
    params.push(input.status);
  }
  return paginate({
    db,
    workspaceId,
    select: approvalSelect,
    table: 'approval',
    alias: 'a',
    where,
    params,
    keys: ['a.created_at', 'a.id'],
    direction: 'DESC',
    cursor: input.cursor,
    limit: input.limit,
    map: toApproval,
  });
}
