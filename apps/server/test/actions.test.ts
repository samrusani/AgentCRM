import { afterAll, describe, expect, it } from 'vitest';
import {
  applyChanges,
  createActivity,
  createContext,
  createOpportunity,
  createOrganization,
  createPerson,
  createTask,
  moveOpportunityStage,
  proposeChanges,
  updateOrganization,
  updatePerson,
} from '../src/actions/index.js';
import { AppError } from '../src/errors.js';
import { listActivities } from '../src/queries/activities.js';
import { getPerson, listPeople } from '../src/queries/people.js';
import { listPipelines } from '../src/queries/pipelines.js';
import { listRuns } from '../src/queries/runs.js';
import { searchAll } from '../src/queries/search.js';
import { listTasks } from '../src/queries/tasks.js';
import { createTestEnvironment, insertSecondWorkspace } from './helpers.js';

const env = createTestEnvironment();
afterAll(() => env.cleanup());

function catchError(work: () => unknown): AppError {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Expected the action to throw.');
}

describe('version checks', () => {
  it('rejects a stale update with version_conflict and the current record', () => {
    const person = createPerson(env.ctx, { firstName: 'Ada', lastName: 'Testcase', email: 'ada@example.com' });
    const updated = updatePerson(env.ctx, person.id, { expectedVersion: 1, fields: { title: 'Partner' } });
    expect(updated.version).toBe(2);

    const error = catchError(() => updatePerson(env.ctx, person.id, { expectedVersion: 1, fields: { title: 'Principal' } }));
    expect(error.code).toBe('version_conflict');
    expect(error.status).toBe(409);
    expect((error.current as { version: number; title: string }).version).toBe(2);
    expect((error.current as { title: string }).title).toBe('Partner');
    expect(getPerson(env.db, env.workspaceId, person.id)?.title).toBe('Partner');
  });

  it('writes an audit event with the change and none for a failed update', () => {
    const person = createPerson(env.ctx, { firstName: 'Bea', lastName: 'Audited' });
    updatePerson(env.ctx, person.id, { expectedVersion: 1, fields: { location: 'Dublin' } });
    const count = (): number =>
      (env.db.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE entity_id = ? AND action = 'person.update'").get(person.id) as { n: number }).n;
    expect(count()).toBe(1);
    expect(() => updatePerson(env.ctx, person.id, { expectedVersion: 1, fields: { location: 'Lisbon' } })).toThrow();
    expect(count()).toBe(1);
  });

  it('does not bump the version when nothing changes', () => {
    const person = createPerson(env.ctx, { firstName: 'Cy', lastName: 'Same', title: 'Scout' });
    const result = updatePerson(env.ctx, person.id, { expectedVersion: 1, fields: { title: 'Scout' } });
    expect(result.version).toBe(1);
  });

  it('applies the version check to organizations and stage moves', () => {
    const organization = createOrganization(env.ctx, { name: 'Testbed Fund', kind: 'fund' });
    updateOrganization(env.ctx, organization.id, { expectedVersion: 1, fields: { location: 'Austin' } });
    expect(catchError(() => updateOrganization(env.ctx, organization.id, { expectedVersion: 1, fields: { location: 'Berlin' } })).code).toBe('version_conflict');

    const stages = listPipelines(env.db, env.workspaceId)[0]!.stages;
    const opportunity = createOpportunity(env.ctx, { name: 'Testbed seed round', organizationId: organization.id });
    expect(opportunity.stageId).toBe(stages[0]!.id);
    const moved = moveOpportunityStage(env.ctx, opportunity.id, { stageId: stages[2]!.id, expectedVersion: 1 });
    expect(moved.stageId).toBe(stages[2]!.id);
    expect(moved.version).toBe(2);
    expect(catchError(() => moveOpportunityStage(env.ctx, opportunity.id, { stageId: stages[3]!.id, expectedVersion: 1 })).code).toBe('version_conflict');
    const events = env.db.prepare('SELECT COUNT(*) AS n FROM stage_event WHERE opportunity_id = ?').get(opportunity.id) as { n: number };
    expect(events.n).toBe(2);
    const timeline = listActivities(env.db, env.workspaceId, { entityType: 'opportunity', entityId: opportunity.id });
    expect(timeline.items[0]?.kind).toBe('stage_change');
  });
});

describe('validation and conflicts', () => {
  it('rejects bad input with a validation error', () => {
    expect(catchError(() => createPerson(env.ctx, { firstName: '' })).code).toBe('validation');
    expect(catchError(() => createPerson(env.ctx, { firstName: 'Dee', email: 'not-an-email' })).code).toBe('validation');
    const person = createPerson(env.ctx, { firstName: 'Eve', lastName: 'Fields' });
    expect(catchError(() => updatePerson(env.ctx, person.id, { expectedVersion: 1, fields: { bogus: 1 } })).code).toBe('validation');
    expect(catchError(() => updatePerson(env.ctx, person.id, { expectedVersion: 1, fields: {} })).code).toBe('validation');
  });

  it('rejects a duplicate email address', () => {
    createPerson(env.ctx, { firstName: 'Finn', email: 'finn@example.com' });
    expect(catchError(() => createPerson(env.ctx, { firstName: 'Finn Two', email: 'FINN@example.com' })).code).toBe('conflict');
  });
});

describe('workspace scoping', () => {
  it('hides records from another workspace on reads and writes', () => {
    const otherId = insertSecondWorkspace(env.db);
    const otherCtx = createContext(env.db, otherId, { bus: env.bus, now: env.ctx.now });
    const mine = createPerson(env.ctx, { firstName: 'Gus', lastName: 'Scoped', email: 'gus@example.com' });
    const theirs = createPerson(otherCtx, { firstName: 'Hana', lastName: 'Scoped', email: 'hana@example.com' });

    expect(getPerson(env.db, otherId, mine.id)).toBeNull();
    expect(getPerson(env.db, env.workspaceId, theirs.id)).toBeNull();
    const names = listPeople(env.db, otherId, { q: 'scoped' }).items.map((person) => person.firstName);
    expect(names).toEqual(['Hana']);
    expect(searchAll(env.db, otherId, 'gus').people).toHaveLength(0);
    expect(catchError(() => updatePerson(otherCtx, mine.id, { expectedVersion: 1, fields: { title: 'X' } })).code).toBe('not_found');
    expect(catchError(() => createTask(otherCtx, { title: 'Call', entityType: 'person', entityId: mine.id })).code).toBe('not_found');
    expect(catchError(() => createActivity(otherCtx, { entityType: 'person', entityId: mine.id, body: 'Hello' })).code).toBe('not_found');
    expect(listTasks(env.db, otherId).items).toHaveLength(0);
    expect(listRuns(env.db, otherId).items).toHaveLength(0);
  });

  it('does not accept a cursor from another workspace', () => {
    const otherId = insertSecondWorkspace(env.db);
    const page = listPeople(env.db, env.workspaceId, { limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    expect(catchError(() => listPeople(env.db, otherId, { cursor: page.nextCursor! })).code).toBe('validation');
  });
});

describe('cursor pagination', () => {
  it('walks every person once and ends with a null cursor', () => {
    const scoped = createContext(env.db, insertSecondWorkspace(env.db), { bus: env.bus, now: env.ctx.now });
    for (let index = 0; index < 7; index += 1) {
      createPerson(scoped, { firstName: `Page${index}`, lastName: `Row${index % 3}` });
    }
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = listPeople(env.db, scoped.workspaceId, { limit: 3, cursor });
      sizes.push(page.items.length);
      seen.push(...page.items.map((person) => person.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.length).toBeGreaterThanOrEqual(7);
    expect(new Set(seen).size).toBe(seen.length);
    expect(sizes.slice(0, -1).every((size) => size === 3)).toBe(true);

    const sortedNames = seen.map((id) => getPerson(env.db, scoped.workspaceId, id)!);
    const keys = sortedNames.map((person) => `${person.lastName.toLowerCase()}|${person.firstName.toLowerCase()}`);
    expect([...keys].sort()).toEqual(keys);
  });

  it('clamps the limit and rejects a malformed cursor', () => {
    expect(listPeople(env.db, env.workspaceId, { limit: 5000 }).items.length).toBeLessThanOrEqual(200);
    expect(catchError(() => listPeople(env.db, env.workspaceId, { cursor: 'not-a-cursor' })).code).toBe('validation');
  });

  it('pages newest first for timelines', () => {
    const person = createPerson(env.ctx, { firstName: 'Ivy', lastName: 'Timeline' });
    for (let index = 0; index < 5; index += 1) {
      createActivity(env.ctx, { entityType: 'person', entityId: person.id, body: `Note ${index}` });
    }
    const first = listActivities(env.db, env.workspaceId, { entityType: 'person', entityId: person.id, limit: 2 });
    expect(first.items.map((item) => item.body)).toEqual(['Note 4', 'Note 3']);
    const second = listActivities(env.db, env.workspaceId, { entityType: 'person', entityId: person.id, limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.body)).toEqual(['Note 2', 'Note 1']);
    const third = listActivities(env.db, env.workspaceId, { entityType: 'person', entityId: person.id, limit: 2, cursor: second.nextCursor! });
    expect(third.items.map((item) => item.body)).toEqual(['Note 0']);
    expect(third.nextCursor).toBeNull();
  });
});

describe('batched changes', () => {
  it('previews without writing, then applies the proposal atomically', () => {
    const person = createPerson(env.ctx, { firstName: 'Jo', lastName: 'Batch' });
    const organization = createOrganization(env.ctx, { name: 'Batch Capital', kind: 'fund' });
    const changes = [
      { entityType: 'person', id: person.id, fields: { title: 'Partner' } },
      { entityType: 'organization', id: organization.id, fields: { location: 'Denver' } },
    ];
    const proposal = proposeChanges(env.ctx, { changes });
    expect(proposal.valid).toBe(true);
    expect(proposal.changes[0]!.diff).toEqual([{ field: 'title', from: null, to: 'Partner' }]);
    expect(getPerson(env.db, env.workspaceId, person.id)?.title).toBeNull();

    const applyInput = {
      proposalHash: proposal.proposalHash,
      changes: proposal.changes.map(({ entityType, id, expectedVersion, fields }) => ({ entityType, id, expectedVersion, fields })),
    };
    expect(catchError(() => applyChanges(env.ctx, { ...applyInput, proposalHash: 'a'.repeat(64) })).code).toBe('validation');

    updatePerson(env.ctx, person.id, { expectedVersion: 1, fields: { location: 'Moved' } });
    const stale = catchError(() => applyChanges(env.ctx, applyInput));
    expect(stale.code).toBe('version_conflict');
    expect(getPerson(env.db, env.workspaceId, person.id)?.title).toBeNull();

    const fresh = proposeChanges(env.ctx, { changes });
    const result = applyChanges(env.ctx, {
      proposalHash: fresh.proposalHash,
      changes: fresh.changes.map(({ entityType, id, expectedVersion, fields }) => ({ entityType, id, expectedVersion, fields })),
    });
    expect(result.applied).toHaveLength(2);
    expect(getPerson(env.db, env.workspaceId, person.id)?.title).toBe('Partner');
  });
});
