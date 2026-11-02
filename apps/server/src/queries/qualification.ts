import type { Db } from '../db.js';
import type { QualificationPayload } from '../qualification/evaluate.js';

export interface QualificationSummary {
  matched: number;
  total: number;
  unknown: number;
  excluded: boolean;
  // When the qualification was computed. Compare with the person's updatedAt to tell if it is out of date.
  computedAt: string | null;
}

export function getQualificationPayload(db: Db, workspaceId: string, personId: string): QualificationPayload | null {
  const row = db
    .prepare('SELECT payload FROM qualification_result WHERE workspace_id = ? AND person_id = ?')
    .get(workspaceId, personId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as QualificationPayload;
  } catch {
    return null;
  }
}

// Columns the people list joins from qualification_result, read with json_extract so the payload is not parsed per row.
export const qualificationColumns =
  "json_extract(qr.payload, '$.matched') AS q_matched, json_extract(qr.payload, '$.total') AS q_total, json_extract(qr.payload, '$.unknown') AS q_unknown, json_extract(qr.payload, '$.excluded') AS q_excluded, json_extract(qr.payload, '$.computedAt') AS q_computed_at";

export const qualificationJoin =
  'LEFT JOIN qualification_result qr ON qr.workspace_id = p.workspace_id AND qr.person_id = p.id';

export function toQualificationSummary(row: Record<string, unknown>): QualificationSummary | null {
  if (row.q_total === null || row.q_total === undefined) return null;
  return {
    matched: Number(row.q_matched ?? 0),
    total: Number(row.q_total),
    unknown: Number(row.q_unknown ?? 0),
    excluded: Boolean(Number(row.q_excluded ?? 0)),
    computedAt: typeof row.q_computed_at === 'string' ? row.q_computed_at : null,
  };
}
