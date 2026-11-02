import type { Db } from '../db.js';
import { type Row, toOpportunity, toOrganization, toPerson } from '../records.js';
import { containsPattern, prefixPattern } from './pagination.js';
import { opportunitySelect } from './opportunities.js';

export const searchLimit = 8;

export function searchAll(db: Db, workspaceId: string, query: string, limit: number = searchLimit) {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { people: [], organizations: [], opportunities: [] };
  const contains = containsPattern(trimmed);
  const prefix = prefixPattern(trimmed);

  const people = (
    db
      .prepare(
        `SELECT p.*, o.name AS organization_name FROM person p LEFT JOIN organization o ON o.id = p.organization_id
         WHERE p.workspace_id = ? AND (lower(p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\'
           OR lower(p.email) LIKE ? ESCAPE '\\' OR lower(o.name) LIKE ? ESCAPE '\\')
         ORDER BY (lower(p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\' OR lower(p.last_name) LIKE ? ESCAPE '\\') DESC,
           lower(p.last_name), lower(p.first_name), p.id LIMIT ?`,
      )
      .all(workspaceId, contains, contains, contains, prefix, prefix, limit) as Row[]
  ).map(toPerson);

  const organizations = (
    db
      .prepare(
        `SELECT * FROM organization o WHERE o.workspace_id = ?
         AND (lower(o.name) LIKE ? ESCAPE '\\' OR lower(o.domain) LIKE ? ESCAPE '\\')
         ORDER BY (lower(o.name) LIKE ? ESCAPE '\\') DESC, lower(o.name), o.id LIMIT ?`,
      )
      .all(workspaceId, contains, contains, prefix, limit) as Row[]
  ).map(toOrganization);

  const opportunities = (
    db
      .prepare(
        `${opportunitySelect} WHERE op.workspace_id = ?
         AND (lower(op.name) LIKE ? ESCAPE '\\' OR lower(o.name) LIKE ? ESCAPE '\\')
         ORDER BY (lower(op.name) LIKE ? ESCAPE '\\') DESC, lower(op.name), op.id LIMIT ?`,
      )
      .all(workspaceId, contains, contains, prefix, limit) as Row[]
  ).map(toOpportunity);

  return { people, organizations, opportunities };
}
