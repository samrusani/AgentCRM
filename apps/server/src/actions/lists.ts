import { z } from 'zod';
import { validationError } from '../errors.js';
import { requireList } from '../queries/lists.js';
import { emitRecord, mutate, parseInput, versionConflict, type ActionContext } from './context.js';
import { opportunityFields } from './entities.js';
import { idSchema } from './schemas.js';

// The list name follows the same rule as other record names: trimmed, 1 to 200 characters.
const listName = opportunityFields.name;

const createListSchema = z.object({ name: listName }).strict();

const updateListSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    fields: z.object({ name: listName }).strict(),
  })
  .strict();

const addMembersSchema = z.object({ personIds: z.array(idSchema).min(1).max(500) }).strict();

// Creates an empty list. Members come from addListMembers.
export function createList(ctx: ActionContext, input: unknown) {
  const data = parseInput(createListSchema, input);
  return mutate(ctx, (tx) => {
    const id = tx.newId('lst');
    const now = tx.now();
    tx.db
      .prepare('INSERT INTO list (id, created_at, workspace_id, version, name, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
      .run(id, now, tx.workspaceId, data.name, now);
    tx.audit('list.create', 'list', id, { name: data.name });
    emitRecord(tx, 'list', id);
    return requireList(tx.db, tx.workspaceId, id);
  });
}

// Renames a list. Membership changes through addListMembers and removeListMember.
export function updateList(ctx: ActionContext, id: string, input: unknown) {
  const data = parseInput(updateListSchema, input);
  return mutate(ctx, (tx) => {
    const current = requireList(tx.db, tx.workspaceId, id);
    if (current.version !== data.expectedVersion) throw versionConflict(current);
    const result = tx.db
      .prepare('UPDATE list SET name = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND version = ?')
      .run(data.fields.name, tx.now(), id, tx.workspaceId, data.expectedVersion);
    if (result.changes !== 1) throw versionConflict(requireList(tx.db, tx.workspaceId, id));
    tx.audit('list.update', 'list', id, { from: current.name, to: data.fields.name });
    emitRecord(tx, 'list', id);
    return requireList(tx.db, tx.workspaceId, id);
  });
}

// Deletes a list and its memberships (the foreign key cascades). Always allowed: membership is cheap curation, and the
// people stay.
export function deleteList(ctx: ActionContext, rawId: string): void {
  const id = parseInput(idSchema, rawId);
  mutate(ctx, (tx) => {
    const current = requireList(tx.db, tx.workspaceId, id);
    tx.db.prepare('DELETE FROM list WHERE id = ? AND workspace_id = ?').run(id, tx.workspaceId);
    tx.audit('list.delete', 'list', id, { name: current.name, members: current.memberCount });
    emitRecord(tx, 'list', id);
  });
}

// Adds the missing people and ignores the ones already on the list. One unknown person refuses the whole call before
// anything is written. Membership is curation: the people are not touched (no version bump, no claim, no event for them).
// A call that adds nobody writes nothing.
export function addListMembers(ctx: ActionContext, id: string, input: unknown): { added: number; already: number } {
  const data = parseInput(addMembersSchema, input);
  const personIds = [...new Set(data.personIds)];
  return mutate(ctx, (tx) => {
    requireList(tx.db, tx.workspaceId, id);
    const exists = tx.db.prepare('SELECT 1 FROM person WHERE id = ? AND workspace_id = ?');
    const unknown = personIds.filter((personId) => !exists.get(personId, tx.workspaceId)).length;
    if (unknown > 0) {
      throw validationError(
        `${unknown === 1 ? '1 selected person was' : `${unknown} selected people were`} not found, so nobody was added.`,
      );
    }
    const insert = tx.db.prepare('INSERT OR IGNORE INTO list_member (list_id, person_id, created_at) VALUES (?, ?, ?)');
    let added = 0;
    for (const personId of personIds) added += insert.run(id, personId, tx.now()).changes;
    const already = personIds.length - added;
    if (added > 0) {
      tx.db.prepare('UPDATE list SET version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ?').run(tx.now(), id, tx.workspaceId);
      tx.audit('list.member_add', 'list', id, { added, already });
      emitRecord(tx, 'list', id);
    }
    return { added, already };
  });
}

// Removes one membership. Removing an absent one answers `removed: 0` and writes nothing. The audit detail is counts only,
// never a person id (contract).
export function removeListMember(ctx: ActionContext, rawListId: string, rawPersonId: string): { removed: number } {
  const listId = parseInput(idSchema, rawListId);
  const personId = parseInput(idSchema, rawPersonId);
  return mutate(ctx, (tx) => {
    requireList(tx.db, tx.workspaceId, listId);
    const removed = tx.db.prepare('DELETE FROM list_member WHERE list_id = ? AND person_id = ?').run(listId, personId).changes;
    if (removed > 0) {
      tx.db.prepare('UPDATE list SET version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ?').run(tx.now(), listId, tx.workspaceId);
      tx.audit('list.member_remove', 'list', listId, { removed });
      emitRecord(tx, 'list', listId);
    }
    return { removed };
  });
}
