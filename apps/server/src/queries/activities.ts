import type { Db } from '../db.js';
import { toActivity } from '../records.js';
import { paginate } from './pagination.js';

export interface ListActivitiesInput {
  entityType?: string | undefined;
  entityId?: string | undefined;
  // Kinds to leave out, for callers that hand activity to a model.
  excludeKinds?: readonly string[] | undefined;
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
  if (input.excludeKinds && input.excludeKinds.length > 0) {
    where.push(`a.kind NOT IN (${input.excludeKinds.map(() => '?').join(', ')})`);
    params.push(...input.excludeKinds);
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

// Text that came from outside the app (inbound email) stays out of anything a model reads. The human screens keep it.
export const modelHiddenActivityKinds = ['email_in'] as const;
