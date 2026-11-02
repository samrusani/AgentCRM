import { createHash } from 'node:crypto';
import { z } from 'zod';
import { notFound, validationError } from '../errors.js';
import {
  type ActionContext,
  mutate,
  parseInput,
  type Tx,
} from './context.js';
import {
  checkUpdateReferences,
  computeChanges,
  type FieldChange,
  loadEntity,
  parseUpdate,
  type UpdatableType,
  updatableTypes,
  updateEntityIn,
} from './entities.js';
import { idSchema } from './schemas.js';

const maxChanges = 50;

const proposeSchema = z
  .object({
    changes: z
      .array(
        z
          .object({
            entityType: z.enum(updatableTypes),
            id: idSchema,
            expectedVersion: z.number().int().min(1).optional(),
            fields: z.record(z.unknown()),
          })
          .strict(),
      )
      .min(1)
      .max(maxChanges),
  })
  .strict();

const applySchema = z
  .object({
    proposalHash: z.string().length(64),
    changes: z
      .array(
        z
          .object({
            entityType: z.enum(updatableTypes),
            id: idSchema,
            expectedVersion: z.number().int().min(1),
            fields: z.record(z.unknown()),
          })
          .strict(),
      )
      .min(1)
      .max(maxChanges),
  })
  .strict();

export interface NormalizedChange {
  entityType: UpdatableType;
  id: string;
  expectedVersion: number;
  fields: Record<string, unknown>;
}

export interface ProposedChange extends NormalizedChange {
  valid: boolean;
  errors: string[];
  diff: FieldChange[];
}

function hashChanges(changes: NormalizedChange[]): string {
  const canonical = changes.map((change) => ({
    entityType: change.entityType,
    id: change.id,
    expectedVersion: change.expectedVersion,
    fields: change.fields,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function readOnlyTx(ctx: ActionContext): Tx {
  return {
    db: ctx.db,
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    now: ctx.now,
    newId: ctx.newId,
    audit: () => undefined,
    emit: () => undefined,
  };
}

// Validates a batch and previews each diff. Nothing is written.
export function proposeChanges(ctx: ActionContext, input: unknown) {
  const data = parseInput(proposeSchema, input);
  const tx = readOnlyTx(ctx);
  const changes: ProposedChange[] = data.changes.map((change) => {
    const current = loadEntity(ctx.db, ctx.workspaceId, change.entityType, change.id);
    const base = {
      entityType: change.entityType,
      id: change.id,
      expectedVersion: change.expectedVersion ?? current?.version ?? 0,
      fields: change.fields,
    };
    if (!current) return { ...base, valid: false, errors: [`${change.entityType} ${change.id} was not found.`], diff: [] };
    const errors: string[] = [];
    let diff: FieldChange[] = [];
    let fields = change.fields;
    try {
      const parsed = parseUpdate(change.entityType, { expectedVersion: base.expectedVersion, fields: change.fields });
      fields = parsed.fields;
      if (current.version !== base.expectedVersion) {
        errors.push(`Expected version ${base.expectedVersion} but the record is at version ${current.version}.`);
      }
      diff = computeChanges(current, parsed.fields);
      checkUpdateReferences(tx, change.entityType, change.id, Object.fromEntries(diff.map((entry) => [entry.field, entry.to])), current);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'The change is not valid.');
    }
    return { ...base, fields, valid: errors.length === 0, errors, diff };
  });
  const normalized = changes.map((change) => ({
    entityType: change.entityType,
    id: change.id,
    expectedVersion: change.expectedVersion,
    fields: change.fields,
  }));
  return {
    valid: changes.every((change) => change.valid),
    changes,
    proposalHash: hashChanges(normalized),
    note: 'Nothing was written. Pass these changes and the proposalHash to apply them.',
  };
}

// Applies a validated proposal as one transaction. A stale version fails the whole batch.
export function applyChanges(ctx: ActionContext, input: unknown) {
  const data = parseInput(applySchema, input);
  const normalized: NormalizedChange[] = data.changes.map((change) => {
    const parsed = parseUpdate(change.entityType, { expectedVersion: change.expectedVersion, fields: change.fields });
    return { entityType: change.entityType, id: change.id, expectedVersion: change.expectedVersion, fields: parsed.fields };
  });
  if (hashChanges(normalized) !== data.proposalHash) {
    throw validationError('The changes do not match the proposal that was validated. Propose them again.');
  }
  return mutate(ctx, (tx) => {
    const applied = normalized.map((change) => {
      if (!loadEntity(tx.db, tx.workspaceId, change.entityType, change.id)) throw notFound(change.entityType);
      return {
        entityType: change.entityType,
        record: updateEntityIn(tx, change.entityType, change.id, {
          expectedVersion: change.expectedVersion,
          fields: change.fields,
        }),
      };
    });
    tx.audit('changes.apply', 'workspace', tx.workspaceId, { count: applied.length });
    return { applied };
  });
}
