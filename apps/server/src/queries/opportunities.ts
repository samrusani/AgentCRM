import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import { type Row, toOpportunity, toStageEvent, toTask } from '../records.js';
import { listActivities, modelHiddenActivityKinds } from './activities.js';
import type { DetailOptions } from './people.js';
import { listClaims } from './claims.js';
import { paginate, type Page } from './pagination.js';
import { taskSelect } from './tasks.js';

export const opportunitySelect = `SELECT op.*, s.name AS stage_name, o.name AS organization_name,
  TRIM(p.first_name || ' ' || p.last_name) AS person_name
  FROM opportunity op
  JOIN stage s ON s.id = op.stage_id
  LEFT JOIN organization o ON o.id = op.organization_id
  LEFT JOIN person p ON p.id = op.person_id`;

export function getOpportunity(db: Db, workspaceId: string, id: string) {
  const row = db
    .prepare(`${opportunitySelect} WHERE op.workspace_id = ? AND op.id = ?`)
    .get(workspaceId, id) as Row | undefined;
  return row ? toOpportunity(row) : null;
}

export function requireOpportunity(db: Db, workspaceId: string, id: string) {
  const opportunity = getOpportunity(db, workspaceId, id);
  if (!opportunity) throw notFound('Opportunity');
  return opportunity;
}

export interface ListOpportunitiesInput {
  pipelineId?: string | undefined;
  stageId?: string | undefined;
  status?: string | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export function listOpportunities(
  db: Db,
  workspaceId: string,
  input: ListOpportunitiesInput = {},
): Page<ReturnType<typeof toOpportunity>> {
  const where = ['op.workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (input.pipelineId) {
    where.push('op.pipeline_id = ?');
    params.push(input.pipelineId);
  }
  if (input.stageId) {
    where.push('op.stage_id = ?');
    params.push(input.stageId);
  }
  if (input.status) {
    where.push('op.status = ?');
    params.push(input.status);
  }
  return paginate({
    db,
    workspaceId,
    select: opportunitySelect,
    table: 'opportunity',
    alias: 'op',
    where,
    params,
    keys: ['op.updated_at', 'op.id'],
    direction: 'DESC',
    cursor: input.cursor,
    limit: input.limit,
    map: toOpportunity,
  });
}

export function getOpportunityDetail(db: Db, workspaceId: string, id: string, options: DetailOptions = {}) {
  const opportunity = requireOpportunity(db, workspaceId, id);
  const stageEvents = (
    db
      .prepare(
        `SELECT e.*, f.name AS from_stage_name, t.name AS to_stage_name FROM stage_event e
         LEFT JOIN stage f ON f.id = e.from_stage_id JOIN stage t ON t.id = e.to_stage_id
         WHERE e.opportunity_id = ? ORDER BY e.at DESC, e.id DESC`,
      )
      .all(id) as Row[]
  ).map(toStageEvent);
  const tasks = (
    db
      .prepare(
        `${taskSelect} WHERE t.workspace_id = ? AND t.entity_type = 'opportunity' AND t.entity_id = ? ORDER BY t.status ASC, COALESCE(t.due_at, '9999') ASC, t.id ASC`,
      )
      .all(workspaceId, id) as Row[]
  ).map(toTask);
  return {
    ...opportunity,
    stageEvents,
    claims: listClaims(db, workspaceId, 'opportunity', id),
    activities: listActivities(db, workspaceId, {
      entityType: 'opportunity',
      entityId: id,
      limit: 50,
      ...(options.forModel ? { excludeKinds: modelHiddenActivityKinds } : {}),
    }).items,
    tasks,
  };
}
