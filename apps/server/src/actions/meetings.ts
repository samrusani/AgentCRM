import { z } from 'zod';
import { validationError } from '../errors.js';
import { requireMeeting } from '../queries/meetings.js';
import { assertEntityExists, emitRecord, emitRecordDeleted, mutate, parseInput, versionConflict, type ActionContext, type Tx } from './context.js';
import { computeChanges } from './entities.js';
import { expectedVersionSchema, idSchema, isoTimestamp, optionalText } from './schemas.js';

const meetingFields = {
  title: z.string().trim().min(1).max(200),
  startsAt: isoTimestamp,
  endsAt: isoTimestamp.nullable(),
  location: optionalText(200),
  organizationId: idSchema.nullable(),
  opportunityId: idSchema.nullable(),
  notes: optionalText(10_000),
};

const columns: Record<string, string> = {
  title: 'title',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
  location: 'location',
  organizationId: 'organization_id',
  opportunityId: 'opportunity_id',
  notes: 'notes',
};

const createMeetingSchema = z
  .object({
    title: meetingFields.title,
    startsAt: meetingFields.startsAt,
    endsAt: meetingFields.endsAt.optional().default(null),
    location: meetingFields.location.optional().default(null),
    organizationId: meetingFields.organizationId.optional().default(null),
    opportunityId: meetingFields.opportunityId.optional().default(null),
    attendeeIds: z.array(idSchema).max(200).optional().default([]),
  })
  .strict();

const updateMeetingSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    fields: z
      .object(meetingFields)
      .partial()
      .strict()
      .refine((fields) => Object.keys(fields).length > 0, 'Provide at least one field to change'),
  })
  .strict();

const attendeeSchema = z.object({ personId: idSchema }).strict();

function assertOrder(startsAt: string, endsAt: string | null): void {
  if (endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw validationError('endsAt: The end must be after the start.');
  }
}

function assertReferences(tx: Tx, organizationId: string | null | undefined, opportunityId: string | null | undefined): void {
  if (organizationId) assertEntityExists(tx, 'organization', organizationId);
  if (opportunityId) assertEntityExists(tx, 'opportunity', opportunityId);
}

// Creates a meeting. Attendees, the organization, and the deal must all exist in this workspace, or nothing is written.
export function createMeeting(ctx: ActionContext, input: unknown) {
  const data = parseInput(createMeetingSchema, input);
  assertOrder(data.startsAt, data.endsAt);
  const attendeeIds = [...new Set(data.attendeeIds)];
  return mutate(ctx, (tx) => {
    assertReferences(tx, data.organizationId, data.opportunityId);
    for (const personId of attendeeIds) assertEntityExists(tx, 'person', personId);
    const id = tx.newId('mtg');
    const now = tx.now();
    tx.db
      .prepare(
        `INSERT INTO meeting (id, created_at, workspace_id, version, title, starts_at, ends_at, location, organization_id, opportunity_id, notes, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(id, now, tx.workspaceId, data.title, data.startsAt, data.endsAt, data.location, data.organizationId, data.opportunityId, now);
    const insert = tx.db.prepare('INSERT OR IGNORE INTO meeting_attendee (meeting_id, person_id, created_at) VALUES (?, ?, ?)');
    for (const personId of attendeeIds) insert.run(id, personId, now);
    tx.audit('meeting.create', 'meeting', id, { title: data.title, startsAt: data.startsAt, attendees: attendeeIds.length });
    emitRecord(tx, 'meeting', id);
    return requireMeeting(tx.db, tx.workspaceId, id);
  });
}

// Version checked update. An update that changes nothing writes nothing. The end must stay after the start for the pair
// the meeting ends up with, whichever of the two changed.
export function updateMeeting(ctx: ActionContext, rawId: string, input: unknown) {
  const id = parseInput(idSchema, rawId);
  const data = parseInput(updateMeetingSchema, input);
  return mutate(ctx, (tx) => {
    const current = requireMeeting(tx.db, tx.workspaceId, id);
    if (current.version !== data.expectedVersion) throw versionConflict(current);
    const changes = computeChanges(current as unknown as Record<string, unknown>, data.fields as Record<string, unknown>);
    if (changes.length === 0) return current;
    const patch = Object.fromEntries(changes.map((change) => [change.field, change.to])) as Record<string, unknown>;
    assertOrder(
      'startsAt' in patch ? (patch.startsAt as string) : current.startsAt,
      'endsAt' in patch ? (patch.endsAt as string | null) : current.endsAt,
    );
    assertReferences(tx, patch.organizationId as string | null | undefined, patch.opportunityId as string | null | undefined);
    const result = tx.db
      .prepare(
        `UPDATE meeting SET ${[...changes.map((change) => `${columns[change.field]} = ?`), 'version = version + 1', 'updated_at = ?'].join(', ')}
         WHERE id = ? AND workspace_id = ? AND version = ?`,
      )
      .run(...(changes.map((change) => change.to) as never[]), tx.now(), id, tx.workspaceId, data.expectedVersion);
    if (result.changes !== 1) throw versionConflict(requireMeeting(tx.db, tx.workspaceId, id));
    // The notes can be long, so the audit trail records that they changed and their length, never the text.
    tx.audit('meeting.update', 'meeting', id, {
      changes: Object.fromEntries(
        changes.map((change) => [
          change.field,
          change.field === 'notes'
            ? { changed: true, characters: typeof change.to === 'string' ? change.to.length : 0 }
            : { from: change.from, to: change.to },
        ]),
      ),
    });
    emitRecord(tx, 'meeting', id);
    return requireMeeting(tx.db, tx.workspaceId, id);
  });
}

// Adds one attendee. Adding someone already there changes nothing and writes nothing. Like list members, no version.
export function addMeetingAttendee(ctx: ActionContext, rawId: string, input: unknown) {
  const id = parseInput(idSchema, rawId);
  const data = parseInput(attendeeSchema, input);
  return mutate(ctx, (tx) => {
    requireMeeting(tx.db, tx.workspaceId, id);
    assertEntityExists(tx, 'person', data.personId);
    const added = tx.db
      .prepare('INSERT OR IGNORE INTO meeting_attendee (meeting_id, person_id, created_at) VALUES (?, ?, ?)')
      .run(id, data.personId, tx.now()).changes;
    if (added === 1) {
      tx.audit('meeting.attendee_add', 'meeting', id, { personId: data.personId });
      emitRecord(tx, 'meeting', id);
    }
    return requireMeeting(tx.db, tx.workspaceId, id);
  });
}

// Removes one attendee. Removing someone who is not there changes nothing and writes nothing.
export function removeMeetingAttendee(ctx: ActionContext, rawId: string, rawPersonId: string) {
  const id = parseInput(idSchema, rawId);
  const personId = parseInput(idSchema, rawPersonId);
  return mutate(ctx, (tx) => {
    requireMeeting(tx.db, tx.workspaceId, id);
    const removed = tx.db.prepare('DELETE FROM meeting_attendee WHERE meeting_id = ? AND person_id = ?').run(id, personId).changes;
    if (removed === 1) {
      tx.audit('meeting.attendee_remove', 'meeting', id, { personId });
      emitRecord(tx, 'meeting', id);
    }
    return requireMeeting(tx.db, tx.workspaceId, id);
  });
}

// Deletes a meeting. Attendee rows go with it (the foreign key cascades); people and their records stay. The audit keeps
// the title and the attendee count, and open clients learn of the deletion from record_deleted.
export function deleteMeeting(ctx: ActionContext, rawId: string): void {
  const id = parseInput(idSchema, rawId);
  mutate(ctx, (tx) => {
    const current = requireMeeting(tx.db, tx.workspaceId, id);
    tx.db.prepare('DELETE FROM meeting WHERE id = ? AND workspace_id = ?').run(id, tx.workspaceId);
    tx.audit('meeting.delete', 'meeting', id, { title: current.title, attendees: current.attendees.length });
    emitRecordDeleted(tx, 'meeting', id);
  });
}
