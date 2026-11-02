import type { Db } from '../db.js';
import { type Row, toClaim } from '../records.js';

export function listClaims(db: Db, workspaceId: string, entityType: string, entityId: string) {
  return (
    db
      .prepare(
        'SELECT * FROM field_claim WHERE workspace_id = ? AND entity_type = ? AND entity_id = ? ORDER BY field ASC, observed_at DESC, id ASC',
      )
      .all(workspaceId, entityType, entityId) as Row[]
  ).map(toClaim);
}
