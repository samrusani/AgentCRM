import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import { type Row, toOpportunity, toOrganization, toPerson } from '../records.js';
import { listActivities } from './activities.js';
import { listClaims } from './claims.js';
import { opportunitySelect } from './opportunities.js';
import { containsPattern, paginate, type Page } from './pagination.js';

export function getOrganization(db: Db, workspaceId: string, id: string) {
  const row = db
    .prepare('SELECT * FROM organization WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, id) as Row | undefined;
  return row ? toOrganization(row) : null;
}

export function requireOrganization(db: Db, workspaceId: string, id: string) {
  const organization = getOrganization(db, workspaceId, id);
  if (!organization) throw notFound('Organization');
  return organization;
}

export interface ListOrganizationsInput {
  q?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export function listOrganizations(
  db: Db,
  workspaceId: string,
  input: ListOrganizationsInput = {},
): Page<ReturnType<typeof toOrganization>> {
  const where = ['o.workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (input.q && input.q.trim().length > 0) {
    const pattern = containsPattern(input.q);
    where.push(`(lower(o.name) LIKE ? ESCAPE '\\' OR lower(o.domain) LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern);
  }
  return paginate({
    db,
    workspaceId,
    select: 'SELECT o.* FROM organization o',
    table: 'organization',
    alias: 'o',
    where,
    params,
    keys: ['lower(o.name)', 'o.id'],
    direction: 'ASC',
    cursor: input.cursor,
    limit: input.limit,
    map: toOrganization,
  });
}

export function getOrganizationDetail(db: Db, workspaceId: string, id: string) {
  const organization = requireOrganization(db, workspaceId, id);
  const people = (
    db
      .prepare(
        `SELECT p.*, o.name AS organization_name FROM person p LEFT JOIN organization o ON o.id = p.organization_id
         WHERE p.workspace_id = ? AND p.organization_id = ? ORDER BY lower(p.last_name), lower(p.first_name), p.id LIMIT 200`,
      )
      .all(workspaceId, id) as Row[]
  ).map(toPerson);
  const opportunities = (
    db
      .prepare(`${opportunitySelect} WHERE op.workspace_id = ? AND op.organization_id = ? ORDER BY op.updated_at DESC, op.id DESC`)
      .all(workspaceId, id) as Row[]
  ).map(toOpportunity);
  return {
    ...organization,
    people,
    claims: listClaims(db, workspaceId, 'organization', id),
    activities: listActivities(db, workspaceId, { entityType: 'organization', entityId: id, limit: 50 }).items,
    opportunities,
  };
}
