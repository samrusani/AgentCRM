import { z } from 'zod';
import { conflict, notFound, validationError } from '../errors.js';
import { activeFollowupStatuses } from '../queries/followupRules.js';
import { fillableColumns, orderedPair, organizationFillableColumns, planFill, planOrganizationFill } from '../queries/duplicates.js';
import { getOrganization } from '../queries/organizations.js';
import { getPerson } from '../queries/people.js';
import { emitRecord, mutate, parseInput, versionConflict, type ActionContext, type Tx } from './context.js';
import { promotePersonIn } from './lifecycle.js';
import { expectedVersionSchema, idSchema } from './schemas.js';

export const activeSendingMessage = 'Stop the follow-ups and sends first.';

const dismissSchema = z.object({ personIds: z.array(idSchema).length(2) }).strict();

const mergeSchema = z
  .object({
    otherId: idSchema,
    expectedVersion: expectedVersionSchema,
    otherExpectedVersion: expectedVersionSchema,
  })
  .strict();

const maxTags = 30;

// Records that two people are not duplicates. The pair is stored once, ordered. Repeating the call writes nothing.
export function dismissDuplicate(ctx: ActionContext, input: unknown): { personIds: [string, string] } {
  const data = parseInput(dismissSchema, input);
  const [first, second] = data.personIds as [string, string];
  if (first === second) throw validationError('personIds: Choose two different people.');
  const [a, b] = orderedPair(first, second);
  return mutate(ctx, (tx) => {
    for (const id of [a, b]) {
      if (!getPerson(tx.db, tx.workspaceId, id)) throw notFound('Person');
    }
    const result = tx.db
      .prepare('INSERT OR IGNORE INTO duplicate_dismissal (workspace_id, person_a_id, person_b_id, created_at) VALUES (?, ?, ?, ?)')
      .run(tx.workspaceId, a, b, tx.now());
    if (result.changes === 1) tx.audit('duplicate.dismiss', 'person', a, { personIds: [a, b] });
    return { personIds: [a, b] };
  });
}

function assertNoActiveSending(tx: Tx, ids: string[]): void {
  const marks = ids.map(() => '?').join(', ');
  const rule = tx.db
    .prepare(
      `SELECT 1 FROM followup_rule WHERE workspace_id = ? AND person_id IN (${marks}) AND status IN (${activeFollowupStatuses.map(() => '?').join(', ')}) LIMIT 1`,
    )
    .get(tx.workspaceId, ...ids, ...activeFollowupStatuses);
  const intent = tx.db
    .prepare(`SELECT 1 FROM send_intent WHERE workspace_id = ? AND person_id IN (${marks}) AND status IN ('queued', 'approved', 'submitting') LIMIT 1`)
    .get(tx.workspaceId, ...ids);
  if (rule || intent) throw conflict(activeSendingMessage);
}

// Merges `otherId` into `survivorId` in one transaction and deletes the other person. See "Duplicate review and merge"
// in docs/architecture.md for the contract.
export function mergePeople(ctx: ActionContext, survivorId: string, input: unknown) {
  const data = parseInput(mergeSchema, input);
  const survivorKey = parseInput(idSchema, survivorId);
  if (survivorKey === data.otherId) throw validationError('Choose two different people to merge.');
  return mutate(ctx, (tx) => {
    const survivor = getPerson(tx.db, tx.workspaceId, survivorKey);
    if (!survivor) throw notFound('Person');
    const other = getPerson(tx.db, tx.workspaceId, data.otherId);
    if (!other) throw notFound('Person');
    if (survivor.version !== data.expectedVersion) throw versionConflict(survivor);
    if (other.version !== data.otherExpectedVersion) throw versionConflict(other);
    assertNoActiveSending(tx, [survivor.id, other.id]);

    const run = (sql: string, ...params: unknown[]): number => tx.db.prepare(sql).run(...(params as never[])).changes;
    const now = tx.now();

    // Custom attribute values: no foreign key ties them to the person, so they are moved or removed here.
    const attributeRows = (id: string) =>
      new Set(
        (tx.db.prepare('SELECT attribute_id FROM attribute_value WHERE workspace_id = ? AND entity_id = ?').all(tx.workspaceId, id) as {
          attribute_id: string;
        }[]).map((row) => row.attribute_id),
      );
    const plan = planFill(survivor, other, attributeRows(survivor.id), attributeRows(other.id));
    let attributesFilled = 0;
    for (const attributeId of plan.attributeIds) {
      attributesFilled += run(
        'UPDATE attribute_value SET entity_id = ?, updated_at = ? WHERE workspace_id = ? AND entity_id = ? AND attribute_id = ?',
        survivor.id,
        now,
        tx.workspaceId,
        other.id,
        attributeId,
      );
    }
    // What remains after the moves is displaced: the survivor already holds those attributes, so the other's
    // values are deleted. The audit keeps them so nothing a merge discards vanishes without trace.
    const displacedAttributes = tx.db
      .prepare('SELECT attribute_id AS attributeId, value FROM attribute_value WHERE workspace_id = ? AND entity_id = ?')
      .all(tx.workspaceId, other.id) as { attributeId: string; value: string }[];
    run('DELETE FROM attribute_value WHERE workspace_id = ? AND entity_id = ?', tx.workspaceId, other.id);

    const moved = {
      claims: run("UPDATE field_claim SET entity_id = ? WHERE workspace_id = ? AND entity_type = 'person' AND entity_id = ?", survivor.id, tx.workspaceId, other.id),
      activities: run("UPDATE activity SET entity_id = ? WHERE workspace_id = ? AND entity_type = 'person' AND entity_id = ?", survivor.id, tx.workspaceId, other.id),
      tasks: run("UPDATE task SET entity_id = ? WHERE workspace_id = ? AND entity_type = 'person' AND entity_id = ?", survivor.id, tx.workspaceId, other.id),
      opportunities: run('UPDATE opportunity SET person_id = ? WHERE workspace_id = ? AND person_id = ?', survivor.id, tx.workspaceId, other.id),
      messages: run('UPDATE email_message SET person_id = ? WHERE workspace_id = ? AND person_id = ?', survivor.id, tx.workspaceId, other.id),
      sendIntents: run('UPDATE send_intent SET person_id = ? WHERE workspace_id = ? AND person_id = ?', survivor.id, tx.workspaceId, other.id),
      followupRules: run('UPDATE followup_rule SET person_id = ? WHERE workspace_id = ? AND person_id = ?', survivor.id, tx.workspaceId, other.id),
      lists: run(
        'INSERT OR IGNORE INTO list_member (list_id, person_id, created_at) SELECT list_id, ?, created_at FROM list_member WHERE person_id = ?',
        survivor.id,
        other.id,
      ),
    };
    const qualificationsDeleted = run('DELETE FROM qualification_result WHERE workspace_id = ? AND person_id = ?', tx.workspaceId, other.id);
    // The other's memberships and any dismissals naming it go with the row (both foreign keys cascade).
    run('DELETE FROM person WHERE id = ? AND workspace_id = ?', other.id, tx.workspaceId);

    // A relationship merged into a lead makes the survivor a relationship. promotePersonIn bumps the version itself, so the
    // update below only bumps when no promotion happened and the survivor's version still moves exactly once.
    const promoted = other.lifecycle === 'relationship' ? promotePersonIn(tx, survivor.id, 'merged') : false;
    const union = [...new Set([...survivor.tags, ...other.tags])];
    const tags = union.slice(0, maxTags);
    // The do-not-contact tag gates outreach drafting, so the cap may never cut it.
    const guarded = union.find((tag) => tag.toLowerCase() === 'do-not-contact');
    if (guarded && !tags.some((tag) => tag.toLowerCase() === 'do-not-contact')) tags[tags.length - 1] = guarded;
    const droppedTags = union.filter((tag) => !tags.includes(tag));
    const assignments = ['tags = ?', 'updated_at = ?'];
    const values: unknown[] = [JSON.stringify(tags), now];
    for (const [field, column] of plan.columns) {
      assignments.push(`${column} = ?`);
      values.push(other[field]);
    }
    if (!promoted) assignments.push('version = version + 1');
    const updated = run(`UPDATE person SET ${assignments.join(', ')} WHERE id = ? AND workspace_id = ?`, ...values, survivor.id, tx.workspaceId);
    if (updated !== 1) throw versionConflict(getPerson(tx.db, tx.workspaceId, survivor.id));

    const filledFields = new Set<string>(plan.columns.map(([field]) => field));
    const displacedFields: Record<string, unknown> = {};
    for (const [field] of fillableColumns) {
      const value = other[field];
      // A value identical to the survivor's was not beaten, so it is not displaced.
      if (!filledFields.has(field) && value !== null && value !== undefined && value !== '' && value !== survivor[field])
        displacedFields[field] = value;
    }
    tx.audit('person.merge', 'person', survivor.id, {
      survivorId: survivor.id,
      otherId: other.id,
      moved: { ...moved, qualificationsDeleted },
      filled: { fields: plan.columns.map(([field]) => field), attributes: attributesFilled },
      displaced: { fields: displacedFields, attributes: displacedAttributes, tags: droppedTags },
      promoted,
    });
    emitRecord(tx, 'person', survivor.id);
    return getPerson(tx.db, tx.workspaceId, survivor.id)!;
  });
}

const dismissOrganizationSchema = z.object({ organizationIds: z.array(idSchema).length(2) }).strict();

// Records that two organizations are not duplicates. The pair is stored once, ordered. Repeating the call writes nothing.
export function dismissOrganizationDuplicate(ctx: ActionContext, input: unknown): { organizationIds: [string, string] } {
  const data = parseInput(dismissOrganizationSchema, input);
  const [first, second] = data.organizationIds as [string, string];
  if (first === second) throw validationError('organizationIds: Choose two different organizations.');
  const [a, b] = orderedPair(first, second);
  return mutate(ctx, (tx) => {
    for (const id of [a, b]) {
      if (!getOrganization(tx.db, tx.workspaceId, id)) throw notFound('Organization');
    }
    const result = tx.db
      .prepare(
        'INSERT OR IGNORE INTO organization_duplicate_dismissal (workspace_id, organization_a_id, organization_b_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(tx.workspaceId, a, b, tx.now());
    if (result.changes === 1) tx.audit('duplicate.dismiss', 'organization', a, { organizationIds: [a, b] });
    return { organizationIds: [a, b] };
  });
}

// Merges `otherId` into `survivorId` in one transaction and deletes the other organization. See "Organization
// duplicates" in docs/architecture.md for the contract. Unlike the person merge there is no sending gate: nothing
// sends on behalf of an organization.
export function mergeOrganizations(ctx: ActionContext, survivorId: string, input: unknown) {
  const data = parseInput(mergeSchema, input);
  const survivorKey = parseInput(idSchema, survivorId);
  if (survivorKey === data.otherId) throw validationError('Choose two different organizations to merge.');
  return mutate(ctx, (tx) => {
    const survivor = getOrganization(tx.db, tx.workspaceId, survivorKey);
    if (!survivor) throw notFound('Organization');
    const other = getOrganization(tx.db, tx.workspaceId, data.otherId);
    if (!other) throw notFound('Organization');
    if (survivor.version !== data.expectedVersion) throw versionConflict(survivor);
    if (other.version !== data.otherExpectedVersion) throw versionConflict(other);

    const run = (sql: string, ...params: unknown[]): number => tx.db.prepare(sql).run(...(params as never[])).changes;
    const now = tx.now();

    // Custom attribute values: no foreign key ties them to the organization, so they are moved or removed here.
    const attributeRows = (id: string) =>
      new Set(
        (tx.db.prepare('SELECT attribute_id FROM attribute_value WHERE workspace_id = ? AND entity_id = ?').all(tx.workspaceId, id) as {
          attribute_id: string;
        }[]).map((row) => row.attribute_id),
      );
    const plan = planOrganizationFill(survivor, other, attributeRows(survivor.id), attributeRows(other.id));
    let attributesFilled = 0;
    for (const attributeId of plan.attributeIds) {
      attributesFilled += run(
        'UPDATE attribute_value SET entity_id = ?, updated_at = ? WHERE workspace_id = ? AND entity_id = ? AND attribute_id = ?',
        survivor.id,
        now,
        tx.workspaceId,
        other.id,
        attributeId,
      );
    }
    // What remains after the moves is displaced: the survivor already holds those attributes, so the other's
    // values are deleted. The audit keeps them so nothing a merge discards vanishes without trace.
    const displacedAttributes = tx.db
      .prepare('SELECT attribute_id AS attributeId, value FROM attribute_value WHERE workspace_id = ? AND entity_id = ?')
      .all(tx.workspaceId, other.id) as { attributeId: string; value: string }[];
    run('DELETE FROM attribute_value WHERE workspace_id = ? AND entity_id = ?', tx.workspaceId, other.id);

    const moved = {
      people: run('UPDATE person SET organization_id = ? WHERE workspace_id = ? AND organization_id = ?', survivor.id, tx.workspaceId, other.id),
      opportunities: run('UPDATE opportunity SET organization_id = ? WHERE workspace_id = ? AND organization_id = ?', survivor.id, tx.workspaceId, other.id),
      claims: run("UPDATE field_claim SET entity_id = ? WHERE workspace_id = ? AND entity_type = 'organization' AND entity_id = ?", survivor.id, tx.workspaceId, other.id),
      activities: run("UPDATE activity SET entity_id = ? WHERE workspace_id = ? AND entity_type = 'organization' AND entity_id = ?", survivor.id, tx.workspaceId, other.id),
      tasks: run("UPDATE task SET entity_id = ? WHERE workspace_id = ? AND entity_type = 'organization' AND entity_id = ?", survivor.id, tx.workspaceId, other.id),
    };
    // Dismissals naming the other organization go with the row (both foreign keys cascade).
    run('DELETE FROM organization WHERE id = ? AND workspace_id = ?', other.id, tx.workspaceId);

    // No organization tag gates any behavior, so unlike the person merge nothing is protected from the cap.
    const union = [...new Set([...survivor.tags, ...other.tags])];
    const tags = union.slice(0, maxTags);
    const droppedTags = union.filter((tag) => !tags.includes(tag));
    const assignments = ['tags = ?', 'updated_at = ?', 'version = version + 1'];
    const values: unknown[] = [JSON.stringify(tags), now];
    for (const [field, column] of plan.columns) {
      assignments.push(`${column} = ?`);
      values.push(other[field]);
    }
    const updated = run(`UPDATE organization SET ${assignments.join(', ')} WHERE id = ? AND workspace_id = ?`, ...values, survivor.id, tx.workspaceId);
    if (updated !== 1) throw versionConflict(getOrganization(tx.db, tx.workspaceId, survivor.id));

    const filledFields = new Set<string>(plan.columns.map(([field]) => field));
    const displacedFields: Record<string, unknown> = {};
    for (const [field] of organizationFillableColumns) {
      const value = other[field];
      // A value identical to the survivor's was not beaten, so it is not displaced.
      if (!filledFields.has(field) && value !== null && value !== undefined && value !== '' && value !== survivor[field])
        displacedFields[field] = value;
    }
    tx.audit('organization.merge', 'organization', survivor.id, {
      survivorId: survivor.id,
      otherId: other.id,
      moved,
      filled: { fields: plan.columns.map(([field]) => field), attributes: attributesFilled },
      displaced: { fields: displacedFields, attributes: displacedAttributes, tags: droppedTags },
    });
    emitRecord(tx, 'organization', survivor.id);
    return getOrganization(tx.db, tx.workspaceId, survivor.id)!;
  });
}
