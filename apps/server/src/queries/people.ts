import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import { type Row, toOpportunity, toOrganization, toPerson, toTask } from '../records.js';
import { containsPattern, paginate, type Page } from './pagination.js';
import { listActivities } from './activities.js';
import { listClaims } from './claims.js';
import { opportunitySelect } from './opportunities.js';
import { taskSelect } from './tasks.js';

const personSelect =
  'SELECT p.*, o.name AS organization_name FROM person p LEFT JOIN organization o ON o.id = p.organization_id';

export function getPerson(db: Db, workspaceId: string, id: string) {
  const row = db
    .prepare(`${personSelect} WHERE p.workspace_id = ? AND p.id = ?`)
    .get(workspaceId, id) as Row | undefined;
  return row ? toPerson(row) : null;
}

export function requirePerson(db: Db, workspaceId: string, id: string) {
  const person = getPerson(db, workspaceId, id);
  if (!person) throw notFound('Person');
  return person;
}

export interface ListPeopleInput {
  q?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  organizationId?: string | undefined;
}

export function listPeople(
  db: Db,
  workspaceId: string,
  input: ListPeopleInput = {},
): Page<ReturnType<typeof toPerson>> {
  const where = ['p.workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (input.q && input.q.trim().length > 0) {
    const pattern = containsPattern(input.q);
    where.push(
      `(lower(p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\' OR lower(p.email) LIKE ? ESCAPE '\\' OR lower(o.name) LIKE ? ESCAPE '\\')`,
    );
    params.push(pattern, pattern, pattern);
  }
  if (input.organizationId) {
    where.push('p.organization_id = ?');
    params.push(input.organizationId);
  }
  return paginate({
    db,
    workspaceId,
    select: personSelect,
    table: 'person',
    alias: 'p',
    where,
    params,
    keys: ['lower(p.last_name)', 'lower(p.first_name)', 'p.id'],
    direction: 'ASC',
    cursor: input.cursor,
    limit: input.limit,
    map: toPerson,
  });
}

export function getPersonDetail(db: Db, workspaceId: string, id: string) {
  const person = requirePerson(db, workspaceId, id);
  const organizationRow = person.organizationId
    ? (db
        .prepare('SELECT * FROM organization WHERE workspace_id = ? AND id = ?')
        .get(workspaceId, person.organizationId) as Row | undefined)
    : undefined;
  const organization = organizationRow ? toOrganization(organizationRow) : null;
  const opportunities = (
    db
      .prepare(`${opportunitySelect} WHERE op.workspace_id = ? AND op.person_id = ? ORDER BY op.updated_at DESC, op.id DESC`)
      .all(workspaceId, id) as Row[]
  ).map(toOpportunity);
  const tasks = (
    db
      .prepare(
        `${taskSelect} WHERE t.workspace_id = ? AND t.entity_type = 'person' AND t.entity_id = ? ORDER BY t.status ASC, COALESCE(t.due_at, '9999') ASC, t.id ASC`,
      )
      .all(workspaceId, id) as Row[]
  ).map(toTask);
  const openCount = opportunities.filter((opportunity) => opportunity.status === 'open').length;
  const parts: string[] = [];
  if (organization) {
    parts.push(person.title ? `${person.title} at ${organization.name}` : `Works at ${organization.name}`);
  } else if (person.title) {
    parts.push(person.title);
  }
  if (opportunities.length > 0) {
    parts.push(`${opportunities.length} ${opportunities.length === 1 ? 'opportunity' : 'opportunities'} (${openCount} open)`);
  }
  return {
    ...person,
    organization,
    affiliationsSummary: parts.length > 0 ? parts.join('. ') : 'No affiliations recorded.',
    claims: listClaims(db, workspaceId, 'person', id),
    activities: listActivities(db, workspaceId, { entityType: 'person', entityId: id, limit: 50 }).items,
    tasks,
    opportunities,
  };
}

