import { z } from 'zod';
import type { Db } from '../db.js';
import { conflict, notFound, validationError } from '../errors.js';
import { getOpportunity } from '../queries/opportunities.js';
import { getOrganization } from '../queries/organizations.js';
import { getPerson } from '../queries/people.js';
import { getTask } from '../queries/tasks.js';
import {
  assertEntityExists,
  emitRecord,
  parseInput,
  type Tx,
  versionConflict,
} from './context.js';
import {
  canonicalCompanyLinkedinUrl,
  canonicalPersonLinkedinUrl,
  canonicalXUrl,
  companyLinkedinUrlMessage,
  linkedinProfileUrlMessage,
  xProfileUrlMessage,
} from './profileUrls.js';
import { entityTypeSchema, expectedVersionSchema, idSchema, isoTimestamp, optionalText, tagsSchema } from './schemas.js';

export type UpdatableType = 'person' | 'organization' | 'opportunity' | 'task';
export const updatableTypes = ['person', 'organization', 'opportunity', 'task'] as const;

const emailSchema = z.string().trim().toLowerCase().email().max(200);

// A profile URL field: null or an empty string clears it, any other value must canonicalize or the edit is refused.
const profileUrlField = (canonical: (value: string) => string | null, message: string) =>
  z
    .string()
    .trim()
    .max(500)
    .nullable()
    .transform((value, ctx) => {
      if (value === null || value === '') return null;
      const url = canonical(value);
      if (url === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: message.replace(/\.$/, '') });
        return z.NEVER;
      }
      return url;
    });

export const personFields = {
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100),
  email: emailSchema.nullable(),
  title: optionalText(200),
  organizationId: idSchema.nullable(),
  location: optionalText(200),
  linkedinUrl: profileUrlField(canonicalPersonLinkedinUrl, linkedinProfileUrlMessage),
  xUrl: profileUrlField(canonicalXUrl, xProfileUrlMessage),
  tags: tagsSchema,
  nextActionAt: isoTimestamp.nullable(),
};

export const organizationFields = {
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().toLowerCase().max(200).nullable().transform((value) => (value === '' ? null : value)),
  kind: z.enum(['fund', 'company']),
  location: optionalText(200),
  linkedinUrl: profileUrlField(canonicalCompanyLinkedinUrl, companyLinkedinUrlMessage),
  tags: tagsSchema,
};

export const opportunityFields = {
  name: z.string().trim().min(1).max(200),
  organizationId: idSchema.nullable(),
  personId: idSchema.nullable(),
  amountTarget: z.number().int().min(0).max(1_000_000_000_000).nullable(),
  currency: z.string().trim().length(3).toUpperCase(),
  owner: optionalText(100),
  status: z.enum(['open', 'passed', 'lost', 'nurture']),
  reason: optionalText(500),
  nextActionAt: isoTimestamp.nullable(),
};

export const taskFields = {
  title: z.string().trim().min(1).max(300),
  entityType: entityTypeSchema.nullable(),
  entityId: idSchema.nullable(),
  dueAt: isoTimestamp.nullable(),
  status: z.enum(['open', 'done']),
};

type Loader = (db: Db, workspaceId: string, id: string) => (Record<string, unknown> & { version: number }) | null;

interface EntitySpec {
  table: string;
  label: string;
  fields: z.ZodRawShape;
  columns: Record<string, string>;
  jsonFields: readonly string[];
  load: Loader;
  checkReferences?: (tx: Tx, id: string, patch: Record<string, unknown>, current: Record<string, unknown>) => void;
}

const specs: Record<UpdatableType, EntitySpec> = {
  person: {
    table: 'person',
    label: 'Person',
    fields: personFields,
    columns: {
      firstName: 'first_name',
      lastName: 'last_name',
      email: 'email',
      title: 'title',
      organizationId: 'organization_id',
      location: 'location',
      linkedinUrl: 'linkedin_url',
      xUrl: 'x_url',
      tags: 'tags',
      nextActionAt: 'next_action_at',
    },
    jsonFields: ['tags'],
    load: getPerson,
    checkReferences: (tx, id, patch) => {
      if (typeof patch.organizationId === 'string') assertEntityExists(tx, 'organization', patch.organizationId);
      if (typeof patch.email === 'string') assertEmailAvailable(tx, patch.email, id);
    },
  },
  organization: {
    table: 'organization',
    label: 'Organization',
    fields: organizationFields,
    columns: { name: 'name', domain: 'domain', kind: 'kind', location: 'location', linkedinUrl: 'linkedin_url', tags: 'tags' },
    jsonFields: ['tags'],
    load: getOrganization,
    checkReferences: (tx, id, patch) => {
      if (typeof patch.domain === 'string') assertDomainAvailable(tx, patch.domain, id);
    },
  },
  opportunity: {
    table: 'opportunity',
    label: 'Opportunity',
    fields: opportunityFields,
    columns: {
      name: 'name',
      organizationId: 'organization_id',
      personId: 'person_id',
      amountTarget: 'amount_target',
      currency: 'currency',
      owner: 'owner',
      status: 'status',
      reason: 'reason',
      nextActionAt: 'next_action_at',
    },
    jsonFields: [],
    load: getOpportunity,
    checkReferences: (tx, _id, patch) => {
      if (typeof patch.organizationId === 'string') assertEntityExists(tx, 'organization', patch.organizationId);
      if (typeof patch.personId === 'string') assertEntityExists(tx, 'person', patch.personId);
    },
  },
  task: {
    table: 'task',
    label: 'Task',
    fields: taskFields,
    columns: { title: 'title', entityType: 'entity_type', entityId: 'entity_id', dueAt: 'due_at', status: 'status' },
    jsonFields: [],
    load: getTask,
    checkReferences: (tx, _id, patch, current) => {
      if (!('entityType' in patch) && !('entityId' in patch)) return;
      const entityType = 'entityType' in patch ? patch.entityType : current.entityType;
      const entityId = 'entityId' in patch ? patch.entityId : current.entityId;
      if ((entityType === null) !== (entityId === null)) {
        throw validationError('A task link needs both entityType and entityId, or neither.');
      }
      if (typeof entityType === 'string' && typeof entityId === 'string') assertEntityExists(tx, entityType, entityId);
    },
  },
};

export function assertEmailAvailable(tx: Tx, email: string, ignoreId?: string): void {
  const row = tx.db
    .prepare('SELECT id FROM person WHERE workspace_id = ? AND lower(email) = ? AND id != ?')
    .get(tx.workspaceId, email.toLowerCase(), ignoreId ?? '');
  if (row) throw conflict('A person with this email address already exists.');
}

export function assertDomainAvailable(tx: Tx, domain: string, ignoreId?: string): void {
  const row = tx.db
    .prepare('SELECT id FROM organization WHERE workspace_id = ? AND lower(domain) = ? AND id != ?')
    .get(tx.workspaceId, domain.toLowerCase(), ignoreId ?? '');
  if (row) throw conflict('An organization with this domain already exists.');
}

export function updateSchemaFor(type: UpdatableType) {
  return z
    .object({
      expectedVersion: expectedVersionSchema,
      fields: z
        .object(specs[type].fields)
        .partial()
        .strict()
        .refine((fields) => Object.keys(fields).length > 0, 'Provide at least one field to change'),
    })
    .strict();
}

export type UpdateInput = { expectedVersion: number; fields: Record<string, unknown> };

export function parseUpdate(type: UpdatableType, input: unknown): UpdateInput {
  return parseInput(updateSchemaFor(type), input) as UpdateInput;
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export function computeChanges(current: Record<string, unknown>, fields: Record<string, unknown>): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (JSON.stringify(current[field] ?? null) !== JSON.stringify(value)) {
      changes.push({ field, from: current[field] ?? null, to: value });
    }
  }
  return changes;
}

// Runs inside an open transaction so batches can apply several updates atomically.
export function updateEntityIn(tx: Tx, type: UpdatableType, id: string, parsed: UpdateInput) {
  const spec = specs[type];
  const current = spec.load(tx.db, tx.workspaceId, id);
  if (!current) throw notFound(spec.label);
  if (current.version !== parsed.expectedVersion) throw versionConflict(current);

  const changes = computeChanges(current, parsed.fields);
  if (changes.length === 0) return current;

  const patch = Object.fromEntries(changes.map((change) => [change.field, change.to]));
  spec.checkReferences?.(tx, id, patch, current);

  const assignments = changes.map((change) => `${spec.columns[change.field]} = ?`);
  const values = changes.map((change) =>
    spec.jsonFields.includes(change.field) ? JSON.stringify(change.to) : change.to,
  );
  const now = tx.now();
  const result = tx.db
    .prepare(
      `UPDATE ${spec.table} SET ${assignments.join(', ')}, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND version = ?`,
    )
    .run(...(values as never[]), now, id, tx.workspaceId, parsed.expectedVersion);
  if (result.changes !== 1) throw versionConflict(spec.load(tx.db, tx.workspaceId, id));

  tx.audit(`${type}.update`, type, id, {
    changes: Object.fromEntries(changes.map((change) => [change.field, { from: change.from, to: change.to }])),
  });
  emitRecord(tx, type, id);
  return spec.load(tx.db, tx.workspaceId, id)!;
}

export function loadEntity(db: Db, workspaceId: string, type: UpdatableType, id: string) {
  return specs[type].load(db, workspaceId, id);
}

export function checkUpdateReferences(
  tx: Tx,
  type: UpdatableType,
  id: string,
  patch: Record<string, unknown>,
  current: Record<string, unknown>,
): void {
  specs[type].checkReferences?.(tx, id, patch, current);
}
