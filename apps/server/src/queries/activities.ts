import type { Db } from '../db.js';
import { toActivity } from '../records.js';
import { paginate } from './pagination.js';

export interface ListActivitiesInput {
  entityType?: string | undefined;
  entityId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export function listActivities(db: Db, workspaceId: string, input: ListActivitiesInput = {}) {
  const where = ['a.workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (input.entityType) {
    where.push('a.entity_type = ?');
    params.push(input.entityType);
  }
  if (input.entityId) {
    where.push('a.entity_id = ?');
    params.push(input.entityId);
  }
  return paginate({
    db,
    workspaceId,
    select: 'SELECT a.* FROM activity a',
    table: 'activity',
    alias: 'a',
    where,
    params,
    keys: ['a.created_at', 'a.id'],
    direction: 'DESC',
    cursor: input.cursor,
    limit: input.limit,
    map: toActivity,
  });
}
