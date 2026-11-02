import type { z } from 'zod';
import type { Db } from '../db.js';
import { AppError, notFound, validationError } from '../errors.js';
import type { DomainEvent, EntityType } from '../events.js';
import { EventBus } from '../events.js';
import { type IdPrefix, randomId } from '../ids.js';

export interface ActionContext {
  db: Db;
  bus: EventBus;
  workspaceId: string;
  actor: string;
  now: () => string;
  newId: (prefix: IdPrefix) => string;
}

export function createContext(
  db: Db,
  workspaceId: string,
  options: Partial<Omit<ActionContext, 'db' | 'workspaceId'>> = {},
): ActionContext {
  return {
    db,
    workspaceId,
    bus: options.bus ?? new EventBus(),
    actor: options.actor ?? 'user',
    now: options.now ?? (() => new Date().toISOString()),
    newId: options.newId ?? randomId,
  };
}

export function withActor(ctx: ActionContext, actor: string): ActionContext {
  return { ...ctx, actor };
}

export interface Tx {
  db: Db;
  workspaceId: string;
  actor: string;
  now: () => string;
  newId: (prefix: IdPrefix) => string;
  audit: (action: string, entityType: string, entityId: string, detail?: Record<string, unknown>) => void;
  emit: (event: DomainEvent) => void;
}

// One short immediate transaction. Events leave the process only after the commit succeeds.
export function mutate<T>(ctx: ActionContext, work: (tx: Tx) => T): T {
  const events: DomainEvent[] = [];
  const tx: Tx = {
    db: ctx.db,
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    now: ctx.now,
    newId: ctx.newId,
    audit: (action, entityType, entityId, detail = {}) => {
      ctx.db
        .prepare(
          'INSERT INTO audit_event (id, created_at, workspace_id, actor, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(ctx.newId('aud'), ctx.now(), ctx.workspaceId, ctx.actor, action, entityType, entityId, JSON.stringify(detail));
    },
    emit: (event) => {
      events.push(event);
    },
  };
  const result = ctx.db.transaction(() => work(tx)).immediate();
  for (const event of events) ctx.bus.emit(event);
  return result;
}

export function withTxActor(tx: Tx, actor: string): Tx {
  return { ...tx, actor };
}

export function parseInput<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue && issue.path.length > 0 ? issue.path.join('.') : '';
  const message = issue ? issue.message : 'Input is not valid';
  throw validationError(path ? `${path}: ${message}.` : `${message}.`);
}

export function emitRecord(tx: Tx, entityType: EntityType | string, entityId: string): void {
  tx.emit({ type: 'record_updated', entityType, entityId });
}

export function assertEntityExists(tx: Tx, entityType: string, entityId: string): void {
  const table = entityTables[entityType];
  if (!table) throw validationError(`Entity type "${entityType}" is not supported.`);
  const row = tx.db
    .prepare(`SELECT 1 FROM ${table} WHERE id = ? AND workspace_id = ?`)
    .get(entityId, tx.workspaceId);
  if (!row) throw notFound(`${entityType.charAt(0).toUpperCase()}${entityType.slice(1)} "${entityId}"`);
}

const entityTables: Record<string, string> = {
  person: 'person',
  organization: 'organization',
  opportunity: 'opportunity',
};

export function versionConflict(current: unknown): AppError {
  return new AppError('version_conflict', 'This record changed since you loaded it. Reload it and try again.', {
    current,
  });
}
