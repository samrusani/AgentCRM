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

// Scope keys of an enrichment run that hold scraped text or the frozen lookup target. Agent facing reads leave them
// out so scraped text reaches no model or agent surface before a person accepted it.
const enrichAgentHiddenKeys = new Map<string, readonly string[]>([
  ['enrich_person', ['suggestions', 'profileUrl', 'fullName', 'firstName', 'lastName', 'sourceUrl']],
  ['enrich_organization', ['suggestions', 'target', 'sourceUrl']],
]);

export function getRunDetail(db: Db, workspaceId: string, id: string, options: { forAgent?: boolean } = {}) {
  const found = requireRun(db, workspaceId, id);
  let run = found;
  const hiddenForAgent = enrichAgentHiddenKeys.get(found.kind);
  if (options.forAgent && hiddenForAgent) {
    const scope = { ...found.scope };
    for (const key of hiddenForAgent) delete scope[key];
    run = { ...found, scope };
  }
  if (options.forAgent && found.kind === 'lead_capture') {
    const scope = { ...found.scope };
    for (const key of postTextScopeKeys) delete scope[key];
    run = { ...found, scope };
  }
  // Agent reads of enrich runs also blank every step detail: a name mode detail names the scraped
  // company, and scraped text reaches no agent surface before a human accepted it. Lead capture runs do the same,
  // because a step detail can quote post content (a provider error echoing the request, a refusal explanation), and
  // their approval payload leaves out the sample rows, which are names and titles read out of the post.
  const blankDetails = options.forAgent && (hiddenForAgent !== undefined || found.kind === 'lead_capture');
  const steps = listRunSteps(db, id);
  return {
    ...run,
    steps: blankDetails ? steps.map((step) => ({ ...step, detail: null })) : steps,
    approvals: (
      db
        .prepare(
          `SELECT a.*, r.title AS run_title FROM approval a JOIN run r ON r.id = a.run_id
           WHERE a.workspace_id = ? AND a.run_id = ? ORDER BY a.created_at, a.id`,
        )
        .all(workspaceId, id) as Row[]
    )
      .map(toApproval)
      .map((approval) => (options.forAgent && found.kind === 'lead_capture' ? withoutSampleRows(approval) : approval)),
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
// GET /api/runs/:id and the approval payload keep them. The lead capture extraction holds names and quotes read out
// of a post, and a pasted capture holds the pasted text itself, so those stay out of the list too.
const bulkyScopeKeys = ['drafts', 'failures', 'skipped', 'audienceIds', 'extraction', 'extractionResult', 'postText'] as const;

// Scope keys of a lead capture run that hold post text. Agent facing reads leave them out, so post content reaches no
// agent surface, not even while a pasted capture is waiting to be read.
const postTextScopeKeys = ['postText', 'extraction', 'extractionResult'] as const;

// An import review payload for a lead capture run without its sample rows (names, titles, and companies read out of
// post text). Counts and the source stay.
function withoutSampleRows<T extends { payload: unknown }>(approval: T): T {
  const payload = approval.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || !('sample' in payload)) return approval;
  const { sample: _sample, ...rest } = payload as Record<string, unknown>;
  return { ...approval, payload: rest };
}

export function trimScopeForList(run: ReturnType<typeof toRun>): ReturnType<typeof toRun> {
  const hidden: readonly string[] = [...bulkyScopeKeys, ...(enrichAgentHiddenKeys.get(run.kind) ?? [])];
  if (!hidden.some((key) => key in run.scope)) return run;
  const scope = { ...run.scope };
  for (const key of hidden) delete scope[key];
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
