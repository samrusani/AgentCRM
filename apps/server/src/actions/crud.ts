import { z } from 'zod';
import { AppError, notFound, validationError } from '../errors.js';
import { requireOrganization } from '../queries/organizations.js';
import { requirePerson } from '../queries/people.js';
import { requireOpportunity } from '../queries/opportunities.js';
import { requireStage } from '../queries/pipelines.js';
import { requireTask } from '../queries/tasks.js';
import {
  type ActionContext,
  assertEntityExists,
  emitRecord,
  mutate,
  parseInput,
  type Tx,
  versionConflict,
} from './context.js';
import {
  assertDomainAvailable,
  assertEmailAvailable,
  opportunityFields,
  organizationFields,
  parseUpdate,
  personFields,
  taskFields,
  updateEntityIn,
} from './entities.js';
import { fireStageAutomationsIn } from './automations.js';
import { promoteForStageIn, promotePersonIn } from './lifecycle.js';
import { linkStoredMessagesToPerson } from './mailLinks.js';
import { entityTypeSchema, idSchema, isoTimestamp } from './schemas.js';
import type { Opportunity, Organization, Person, Row, Task } from '../records.js';

const createPersonSchema = z
  .object({
    firstName: personFields.firstName,
    lastName: personFields.lastName.default(''),
    email: personFields.email.optional().default(null),
    title: personFields.title.optional().default(null),
    organizationId: personFields.organizationId.optional().default(null),
    location: personFields.location.optional().default(null),
    linkedinUrl: personFields.linkedinUrl.optional().default(null),
    xUrl: personFields.xUrl.optional().default(null),
    phone: personFields.phone.optional().default(null),
    website: personFields.website.optional().default(null),
    lifecycle: personFields.lifecycle.optional().default('lead'),
    tags: personFields.tags.optional().default([]),
    nextActionAt: personFields.nextActionAt.optional().default(null),
  })
  .strict();

export function createPerson(ctx: ActionContext, input: unknown) {
  const data = parseInput(createPersonSchema, input);
  return mutate(ctx, (tx) => createPersonIn(tx, data));
}

// Internal callers pass profile URLs already canonicalized (see profileUrls.ts) and may leave them out.
type PersonInput = Omit<z.output<typeof createPersonSchema>, 'linkedinUrl' | 'xUrl' | 'lifecycle' | 'phone' | 'website'> & {
  phone?: string | null;
  website?: string | null;
  linkedinUrl?: string | null;
  xUrl?: string | null;
  lifecycle?: 'lead' | 'relationship';
};

export function createPersonIn(tx: Tx, data: PersonInput) {
  if (data.organizationId) assertEntityExists(tx, 'organization', data.organizationId);
  if (data.email) assertEmailAvailable(tx, data.email);
  const id = tx.newId('per');
  const now = tx.now();
  tx.db
    .prepare(
      `INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, email, title, organization_id, location, linkedin_url, x_url, phone, website, lifecycle, tags, next_action_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      now,
      tx.workspaceId,
      data.firstName,
      data.lastName,
      data.email,
      data.title,
      data.organizationId,
      data.location,
      data.linkedinUrl ?? null,
      data.xUrl ?? null,
      data.phone ?? null,
      data.website ?? null,
      data.lifecycle ?? 'lead',
      JSON.stringify(data.tags),
      data.nextActionAt,
      now,
    );
  tx.audit('person.create', 'person', id, { name: `${data.firstName} ${data.lastName}`.trim() });
  // Mail already stored for this address now belongs to the person. Linking never promotes.
  if (data.email) linkStoredMessagesToPerson(tx, id, data.email);
  emitRecord(tx, 'person', id);
  return requirePerson(tx.db, tx.workspaceId, id);
}

export function updatePerson(ctx: ActionContext, id: string, input: unknown) {
  const parsed = parseUpdate('person', input);
  return mutate(ctx, (tx) => updateEntityIn(tx, 'person', id, parsed) as unknown as Person);
}

const createOrganizationSchema = z
  .object({
    name: organizationFields.name,
    domain: organizationFields.domain.optional().default(null),
    kind: organizationFields.kind.default('company'),
    location: organizationFields.location.optional().default(null),
    linkedinUrl: organizationFields.linkedinUrl.optional().default(null),
    crunchbaseUrl: organizationFields.crunchbaseUrl.optional().default(null),
    phone: organizationFields.phone.optional().default(null),
    website: organizationFields.website.optional().default(null),
    tags: organizationFields.tags.optional().default([]),
  })
  .strict();

export function createOrganization(ctx: ActionContext, input: unknown) {
  const data = parseInput(createOrganizationSchema, input);
  return mutate(ctx, (tx) => createOrganizationIn(tx, data));
}

type OrganizationInput = Omit<z.output<typeof createOrganizationSchema>, 'linkedinUrl' | 'crunchbaseUrl' | 'phone' | 'website'> & {
  linkedinUrl?: string | null;
  crunchbaseUrl?: string | null;
  phone?: string | null;
  website?: string | null;
};

export function createOrganizationIn(tx: Tx, data: OrganizationInput) {
  if (data.domain) assertDomainAvailable(tx, data.domain);
  const id = tx.newId('org');
  const now = tx.now();
  tx.db
    .prepare(
      `INSERT INTO organization (id, created_at, workspace_id, version, name, domain, kind, location, linkedin_url, crunchbase_url, phone, website, tags, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      now,
      tx.workspaceId,
      data.name,
      data.domain,
      data.kind,
      data.location,
      data.linkedinUrl ?? null,
      data.crunchbaseUrl ?? null,
      data.phone ?? null,
      data.website ?? null,
      JSON.stringify(data.tags),
      now,
    );
  tx.audit('organization.create', 'organization', id, { name: data.name });
  emitRecord(tx, 'organization', id);
  return requireOrganization(tx.db, tx.workspaceId, id);
}

export function updateOrganization(ctx: ActionContext, id: string, input: unknown) {
  const parsed = parseUpdate('organization', input);
  return mutate(ctx, (tx) => updateEntityIn(tx, 'organization', id, parsed) as unknown as Organization);
}

const createOpportunitySchema = z
  .object({
    name: opportunityFields.name,
    pipelineId: idSchema.optional(),
    stageId: idSchema.optional(),
    organizationId: opportunityFields.organizationId.optional().default(null),
    personId: opportunityFields.personId.optional().default(null),
    amountTarget: opportunityFields.amountTarget.optional().default(null),
    currency: opportunityFields.currency.optional().default('USD'),
    owner: opportunityFields.owner.optional().default(null),
    status: opportunityFields.status.optional().default('open'),
    reason: opportunityFields.reason.optional().default(null),
    nextActionAt: opportunityFields.nextActionAt.optional().default(null),
  })
  .strict();

export function createOpportunity(ctx: ActionContext, input: unknown) {
  const data = parseInput(createOpportunitySchema, input);
  return mutate(ctx, (tx) => {
    if (data.organizationId) assertEntityExists(tx, 'organization', data.organizationId);
    if (data.personId) assertEntityExists(tx, 'person', data.personId);

    let stageId = data.stageId;
    let pipelineId = data.pipelineId;
    if (stageId) {
      const stage = requireStage(tx.db, tx.workspaceId, stageId);
      if (pipelineId && pipelineId !== stage.pipelineId) {
        throw validationError('The stage does not belong to the pipeline.');
      }
      pipelineId = stage.pipelineId;
    } else {
      const pipelineRow = (
        pipelineId
          ? tx.db.prepare('SELECT id FROM pipeline WHERE workspace_id = ? AND id = ?').get(tx.workspaceId, pipelineId)
          : tx.db.prepare('SELECT id FROM pipeline WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1').get(tx.workspaceId)
      ) as Row | undefined;
      if (!pipelineRow) throw notFound('Pipeline');
      pipelineId = String(pipelineRow.id);
      const firstStage = tx.db
        .prepare('SELECT id FROM stage WHERE pipeline_id = ? ORDER BY seq LIMIT 1')
        .get(pipelineId) as Row | undefined;
      if (!firstStage) throw validationError('The pipeline has no stages.');
      stageId = String(firstStage.id);
    }

    const id = tx.newId('opp');
    const now = tx.now();
    tx.db
      .prepare(
        `INSERT INTO opportunity (id, created_at, workspace_id, version, name, pipeline_id, stage_id, organization_id, person_id, amount_target, currency, owner, status, reason, next_action_at, stage_changed_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        now,
        tx.workspaceId,
        data.name,
        pipelineId,
        stageId,
        data.organizationId,
        data.personId,
        data.amountTarget,
        data.currency,
        data.owner,
        data.status,
        data.reason,
        data.nextActionAt,
        now,
        now,
      );
    tx.db
      .prepare('INSERT INTO stage_event (id, created_at, opportunity_id, from_stage_id, to_stage_id, at, actor) VALUES (?, ?, ?, NULL, ?, ?, ?)')
      .run(tx.newId('evt'), now, id, stageId, now, tx.actor);
    tx.audit('opportunity.create', 'opportunity', id, { name: data.name });
    emitRecord(tx, 'opportunity', id);
    fireStageAutomationsIn(tx, { id, name: data.name }, stageId!);
    if (data.personId) promoteForStageIn(tx, data.personId, stageId!);
    return requireOpportunity(tx.db, tx.workspaceId, id);
  });
}

export function updateOpportunity(ctx: ActionContext, id: string, input: unknown) {
  const parsed = parseUpdate('opportunity', input);
  return mutate(ctx, (tx) => updateEntityIn(tx, 'opportunity', id, parsed) as unknown as Opportunity);
}

const moveStageSchema = z.object({ stageId: idSchema, expectedVersion: z.number().int().min(1) }).strict();

export function moveOpportunityStage(ctx: ActionContext, id: string, input: unknown) {
  const data = parseInput(moveStageSchema, input);
  return mutate(ctx, (tx) => {
    const current = requireOpportunity(tx.db, tx.workspaceId, id);
    if (current.version !== data.expectedVersion) throw versionConflict(current);
    const target = requireStage(tx.db, tx.workspaceId, data.stageId);
    if (target.pipelineId !== current.pipelineId) {
      throw validationError('The stage belongs to a different pipeline.');
    }
    if (target.id === current.stageId) throw new AppError('conflict', 'The opportunity is already in this stage.');
    const now = tx.now();
    const result = tx.db
      .prepare(
        'UPDATE opportunity SET stage_id = ?, stage_changed_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND version = ?',
      )
      .run(target.id, now, now, id, tx.workspaceId, data.expectedVersion);
    if (result.changes !== 1) throw versionConflict(requireOpportunity(tx.db, tx.workspaceId, id));
    tx.db
      .prepare('INSERT INTO stage_event (id, created_at, opportunity_id, from_stage_id, to_stage_id, at, actor) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tx.newId('evt'), now, id, current.stageId, target.id, now, tx.actor);
    tx.db
      .prepare('INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        tx.newId('act'),
        now,
        tx.workspaceId,
        'opportunity',
        id,
        'stage_change',
        `Moved from ${current.stageName ?? 'unknown'} to ${target.name}.`,
        tx.actor,
      );
    tx.audit('opportunity.stage', 'opportunity', id, { fromStageId: current.stageId, toStageId: target.id });
    emitRecord(tx, 'opportunity', id);
    fireStageAutomationsIn(tx, { id, name: current.name }, target.id);
    if (current.personId && target.seq > 1) promotePersonIn(tx, current.personId, 'opportunity');
    return requireOpportunity(tx.db, tx.workspaceId, id);
  });
}

const createTaskSchema = z
  .object({
    title: taskFields.title,
    entityType: entityTypeSchema.nullable().optional().default(null),
    entityId: idSchema.nullable().optional().default(null),
    dueAt: isoTimestamp.nullable().optional().default(null),
  })
  .strict();

export function createTask(ctx: ActionContext, input: unknown) {
  const data = parseInput(createTaskSchema, input);
  return mutate(ctx, (tx) => {
    if ((data.entityType === null) !== (data.entityId === null)) {
      throw validationError('A task link needs both entityType and entityId, or neither.');
    }
    if (data.entityType && data.entityId) assertEntityExists(tx, data.entityType, data.entityId);
    const id = tx.newId('tsk');
    const now = tx.now();
    tx.db
      .prepare(
        `INSERT INTO task (id, created_at, workspace_id, version, title, entity_type, entity_id, due_at, status, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(id, now, tx.workspaceId, data.title, data.entityType, data.entityId, data.dueAt, now);
    tx.audit('task.create', 'task', id, { title: data.title });
    emitRecord(tx, 'task', id);
    return requireTask(tx.db, tx.workspaceId, id);
  });
}

export function updateTask(ctx: ActionContext, id: string, input: unknown) {
  const parsed = parseUpdate('task', input);
  return mutate(ctx, (tx) => updateEntityIn(tx, 'task', id, parsed) as unknown as Task);
}

const createActivitySchema = z
  .object({
    entityType: entityTypeSchema,
    entityId: idSchema,
    body: z.string().trim().min(1).max(10_000),
    kind: z.enum(['note', 'email_draft', 'agent']).default('note'),
  })
  .strict();

export function createActivityIn(tx: Tx, data: z.output<typeof createActivitySchema>) {
  assertEntityExists(tx, data.entityType, data.entityId);
  const id = tx.newId('act');
  const now = tx.now();
  tx.db
    .prepare('INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, tx.workspaceId, data.entityType, data.entityId, data.kind, data.body, tx.actor);
  tx.audit('activity.create', data.entityType, data.entityId, { activityId: id, kind: data.kind });
  emitRecord(tx, data.entityType, data.entityId);
  return {
    id,
    workspaceId: tx.workspaceId,
    entityType: data.entityType,
    entityId: data.entityId,
    kind: data.kind,
    body: data.body,
    actor: tx.actor,
    createdAt: now,
  };
}

export function createActivity(ctx: ActionContext, input: unknown) {
  const data = parseInput(createActivitySchema, input);
  return mutate(ctx, (tx) => createActivityIn(tx, data));
}

const createClaimSchema = z
  .object({
    entityType: entityTypeSchema,
    entityId: idSchema,
    field: z.string().trim().min(1).max(100),
    value: z.string().trim().min(1).max(2000),
    sourceUrl: z.string().trim().url().max(2000).nullable().optional().default(null),
    sourceType: z.string().trim().min(1).max(60),
    observedAt: isoTimestamp.optional(),
    status: z.enum(['imported', 'extracted', 'corroborated', 'human_confirmed']),
    extractionMethod: z.string().trim().min(1).max(200).nullable().optional().default(null),
  })
  .strict();

export function createFieldClaimIn(
  tx: Tx,
  data: Omit<z.output<typeof createClaimSchema>, 'extractionMethod'> & { extractionMethod?: string | null },
) {
  assertEntityExists(tx, data.entityType, data.entityId);
  const id = tx.newId('clm');
  const now = tx.now();
  tx.db
    .prepare(
      `INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_url, source_type, observed_at, status, extraction_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      now,
      tx.workspaceId,
      data.entityType,
      data.entityId,
      data.field,
      data.value,
      data.sourceUrl,
      data.sourceType,
      data.observedAt ?? now,
      data.status,
      data.extractionMethod ?? null,
    );
  tx.audit('claim.create', data.entityType, data.entityId, { claimId: id, field: data.field, status: data.status });
  emitRecord(tx, data.entityType, data.entityId);
  return id;
}

export function createFieldClaim(ctx: ActionContext, input: unknown) {
  const data = parseInput(createClaimSchema, input);
  return mutate(ctx, (tx) => createFieldClaimIn(tx, data));
}
