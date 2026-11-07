import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import { type Row, toOpportunity, toOrganization, toPerson, toTask } from '../records.js';
import { containsPattern, paginate, type Page } from './pagination.js';
import { listActivities, modelHiddenActivityKinds } from './activities.js';
import { listClaims } from './claims.js';
import { listsForPerson } from './lists.js';
import { opportunitySelect } from './opportunities.js';
import { taskSelect } from './tasks.js';
import { getQualificationPayload, qualificationColumns, qualificationJoin, toQualificationSummary } from './qualification.js';

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
  sort?: 'name' | 'fit' | undefined;
  // Absent means all people.
  lifecycle?: 'lead' | 'relationship' | undefined;
  // A list id: members only. An unknown id matches nobody, so the page is empty.
  list?: string | undefined;
}

const listSelect = `SELECT p.*, o.name AS organization_name, ${qualificationColumns} FROM person p LEFT JOIN organization o ON o.id = p.organization_id ${qualificationJoin}`;

// Fit order as one ascending key list so the keyset cursor works: qualified people who are not excluded come
// first, then excluded people, then people who were never qualified. Within a group, more matched criteria
// come first (matched is negated to sort ascending), then fewer unknown, then name and id.
const fitKeys = [
  'CASE WHEN qr.id IS NULL THEN 2 WHEN COALESCE(json_extract(qr.payload, \'$.excluded\'), 0) THEN 1 ELSE 0 END',
  'COALESCE(-json_extract(qr.payload, \'$.matched\'), 0)',
  'COALESCE(json_extract(qr.payload, \'$.unknown\'), 0)',
  'lower(p.last_name)',
  'lower(p.first_name)',
  'p.id',
];

export function listPeople(
  db: Db,
  workspaceId: string,
  input: ListPeopleInput = {},
): Page<ReturnType<typeof toPerson> & { qualification: ReturnType<typeof toQualificationSummary> }> {
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
  if (input.lifecycle) {
    where.push('p.lifecycle = ?');
    params.push(input.lifecycle);
  }
  if (input.list) {
    where.push('EXISTS (SELECT 1 FROM list_member lm JOIN list l ON l.id = lm.list_id WHERE lm.person_id = p.id AND lm.list_id = ? AND l.workspace_id = ?)');
    params.push(input.list, workspaceId);
  }
  return paginate({
    db,
    workspaceId,
    select: listSelect,
    table: 'person',
    alias: 'p',
    where,
    params,
    keys: input.sort === 'fit' ? fitKeys : ['lower(p.last_name)', 'lower(p.first_name)', 'p.id'],
    direction: 'ASC',
    cursor: input.cursor,
    limit: input.limit,
    map: (row) => ({ ...toPerson(row), qualification: toQualificationSummary(row) }),
    ...(input.sort === 'fit'
      ? { cursorSource: `person AS p LEFT JOIN qualification_result qr ON qr.workspace_id = p.workspace_id AND qr.person_id = p.id` }
      : {}),
  });
}

export interface DetailOptions {
  // True when a model will read the result: inbound email text is left out of the activity list.
  forModel?: boolean;
}

export function getPersonDetail(db: Db, workspaceId: string, id: string, options: DetailOptions = {}) {
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
    activities: listActivities(db, workspaceId, {
      entityType: 'person',
      entityId: id,
      limit: 50,
      ...(options.forModel ? { excludeKinds: modelHiddenActivityKinds } : {}),
    }).items,
    tasks,
    opportunities,
    qualification: getQualificationPayload(db, workspaceId, id),
    // Lists are a human surface: agent reads (forModel) never include membership.
    ...(options.forModel ? {} : { lists: listsForPerson(db, workspaceId, id) }),
  };
}

