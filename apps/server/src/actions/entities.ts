import { z } from 'zod';
import type { Db } from '../db.js';
import { attributeKeyOfField, resolveAttributeChanges, writeAttributeValues } from '../attributes.js';
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
import { phoneField, websiteField } from './contactFields.js';
import { promoteForStageIn } from './lifecycle.js';
import { linkStoredMessagesToPerson } from './mailLinks.js';
import {
  canonicalCompanyLinkedinUrl,
  canonicalPersonLinkedinUrl,
  canonicalXUrl,
  companyLinkedinUrlMessage,
  linkedinProfileUrlMessage,
  xProfileUrlMessage,
} from './profileUrls.js';
import { normalizeProfileUrl } from './profileUrls.js';
import { entityTypeSchema, expectedVersionSchema, idSchema, isoTimestamp, optionalText, tagsSchema } from './schemas.js';

export type UpdatableType = 'person' | 'organization' | 'opportunity' | 'task';
export const updatableTypes = ['person', 'organization', 'opportunity', 'task'] as const;

export const emailSchema = z.string().trim().toLowerCase().email().max(200);

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

export const birthdayMessage = 'Birthday must be YYYY-MM-DD or MM-DD.';

// A birthday is YYYY-MM-DD or MM-DD (the year is optional because people often share the day without it). The shape is
// a regex; the calendar check follows. With no year, February 29 is allowed. With a year, it must be a real date, so
// 2023-02-29 is refused. Null or an empty string clears the value.
const birthdayField = z
  .string()
  .trim()
  .max(20)
  .nullable()
  .transform((value, ctx) => {
    if (value === null || value === '') return null;
    const match = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(value);
    if (match) {
      const year = match[1] === undefined ? 2000 : Number(match[1]); // 2000 is a leap year
      const month = Number(match[2]);
      const day = Number(match[3]);
      const check = new Date(Date.UTC(year, month - 1, day));
      if (year >= 1 && check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day) {
        return value;
      }
    }
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: birthdayMessage.replace(/\.$/, '') });
    return z.NEVER;
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
  phone: phoneField,
  website: websiteField,
  lifecycle: z.enum(['lead', 'relationship']),
  tags: tagsSchema,
  birthday: birthdayField,
  nextActionAt: isoTimestamp.nullable(),
};

export const organizationFields = {
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().toLowerCase().max(200).nullable().transform((value) => (value === '' ? null : value)),
  kind: z.enum(['fund', 'company']),
  location: optionalText(200),
  linkedinUrl: profileUrlField(canonicalCompanyLinkedinUrl, companyLinkedinUrlMessage),
  phone: phoneField,
  website: websiteField,
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
      phone: 'phone',
      website: 'website',
      lifecycle: 'lifecycle',
      tags: 'tags',
      birthday: 'birthday',
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
    columns: {
      name: 'name',
      domain: 'domain',
      kind: 'kind',
      location: 'location',
      linkedinUrl: 'linkedin_url',
      phone: 'phone',
      website: 'website',
      tags: 'tags',
    },
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

// The other person who holds a LinkedIn profile, compared as decoded profile ids without regard to case, so a case or
// percent spelling difference cannot slip past. Null when nobody else has it.
export function personHoldingLinkedin(tx: Tx, linkedinUrl: string, ignoreId?: string): string | null {
  const wanted = normalizeProfileUrl(linkedinUrl)?.toLowerCase();
  if (!wanted) return null;
  const rows = tx.db
    .prepare('SELECT id, linkedin_url FROM person WHERE workspace_id = ? AND linkedin_url IS NOT NULL AND id != ?')
    .all(tx.workspaceId, ignoreId ?? '') as { id: string; linkedin_url: string }[];
  const held = rows.find((row) => normalizeProfileUrl(row.linkedin_url)?.toLowerCase() === wanted);
  return held ? held.id : null;
}

export function assertLinkedinAvailable(tx: Tx, linkedinUrl: string, ignoreId?: string): void {
  if (personHoldingLinkedin(tx, linkedinUrl, ignoreId)) throw conflict('A person with this LinkedIn link already exists.');
}

export function assertDomainAvailable(tx: Tx, domain: string, ignoreId?: string): void {
  const row = tx.db
    .prepare('SELECT id FROM organization WHERE workspace_id = ? AND lower(domain) = ? AND id != ?')
    .get(tx.workspaceId, domain.toLowerCase(), ignoreId ?? '');
  if (row) throw conflict('An organization with this domain already exists.');
}

export function updateSchemaFor(type: UpdatableType, allowEmpty = false) {
  return z
    .object({
      expectedVersion: expectedVersionSchema,
      fields: z
        .object(specs[type].fields)
        .partial()
        .strict()
        .refine((fields) => allowEmpty || Object.keys(fields).length > 0, 'Provide at least one field to change'),
    })
    .strict();
}

export type UpdateInput = { expectedVersion: number; fields: Record<string, unknown> };

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Custom attributes ride the same envelope as built in fields: attr:<key> on a person or organization. The key shape is
// checked here; the key itself and the value are resolved against the live definitions where the write happens, because
// definitions are data and can change between a proposal and its apply.
export function splitAttributeFields(fields: Record<string, unknown>): {
  builtin: Record<string, unknown>;
  attributes: Record<string, unknown>;
} {
  const builtin: Record<string, unknown> = {};
  const attributes: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (attributeKeyOfField(field) !== null) attributes[field] = value;
    else builtin[field] = value;
  }
  return { builtin, attributes };
}

export function parseUpdate(type: UpdatableType, input: unknown): UpdateInput {
  if ((type === 'person' || type === 'organization') && isPlainRecord(input) && isPlainRecord(input.fields)) {
    const { builtin, attributes } = splitAttributeFields(input.fields);
    if (Object.keys(attributes).length > 0) {
      const parsed = parseInput(updateSchemaFor(type, true), { ...input, fields: builtin }) as UpdateInput;
      return { expectedVersion: parsed.expectedVersion, fields: { ...parsed.fields, ...attributes } };
    }
  }
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

// Runs inside an open transaction so batches can apply several updates atomically. Custom attribute fields
// (attr:<key>) resolve against the live definitions in this transaction and count as changes like built in fields.
export function updateEntityIn(tx: Tx, type: UpdatableType, id: string, parsed: UpdateInput) {
  const spec = specs[type];
  const current = spec.load(tx.db, tx.workspaceId, id);
  if (!current) throw notFound(spec.label);
  if (current.version !== parsed.expectedVersion) throw versionConflict(current);

  const { builtin, attributes } = splitAttributeFields(parsed.fields);
  const attributeChanges =
    type === 'person' || type === 'organization'
      ? resolveAttributeChanges(tx.db, tx.workspaceId, type, id, attributes)
      : [];
  const changes = computeChanges(current, builtin);
  if (changes.length === 0 && attributeChanges.length === 0) return current;

  const patch = Object.fromEntries(changes.map((change) => [change.field, change.to]));
  spec.checkReferences?.(tx, id, patch, current);

  const assignments = changes.map((change) => `${spec.columns[change.field]} = ?`);
  const values = changes.map((change) =>
    spec.jsonFields.includes(change.field) ? JSON.stringify(change.to) : change.to,
  );
  const now = tx.now();
  const result = tx.db
    .prepare(
      `UPDATE ${spec.table} SET ${[...assignments, 'version = version + 1', 'updated_at = ?'].join(', ')} WHERE id = ? AND workspace_id = ? AND version = ?`,
    )
    .run(...(values as never[]), now, id, tx.workspaceId, parsed.expectedVersion);
  if (result.changes !== 1) throw versionConflict(spec.load(tx.db, tx.workspaceId, id));
  if (attributeChanges.length > 0) writeAttributeValues(tx.db, tx.workspaceId, id, attributeChanges, now);

  // Attribute edits record no claim in this version; the audit event is their provenance.
  tx.audit(`${type}.update`, type, id, {
    changes: Object.fromEntries(
      [...changes, ...attributeChanges].map((change) => [change.field, { from: change.from, to: change.to }]),
    ),
  });
  emitRecord(tx, type, id);
  const updated = spec.load(tx.db, tx.workspaceId, id)!;
  // A new email address picks up mail already stored for it. Linking never promotes.
  if (type === 'person' && typeof patch.email === 'string') linkStoredMessagesToPerson(tx, id, patch.email);
  // Re-pointing an opportunity at a person while it sits past the first stage is a relationship signal for that person.
  if (type === 'opportunity' && 'personId' in patch) {
    const row = updated as unknown as { personId: string | null; stageId: string };
    if (row.personId) promoteForStageIn(tx, row.personId, row.stageId);
  }
  return updated;
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
