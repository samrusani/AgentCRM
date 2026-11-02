export type Row = Record<string, unknown>;

export type OpportunityStatus = 'open' | 'passed' | 'lost' | 'nurture';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export const terminalRunStatuses: readonly RunStatus[] = ['succeeded', 'partial', 'failed', 'cancelled'];
export const activeRunStatuses: readonly RunStatus[] = ['queued', 'running', 'waiting_approval', 'paused'];

export interface RunCounts {
  processed: number;
  found: number;
  flagged: number;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toWorkspace(row: Row) {
  return {
    id: String(row.id),
    name: String(row.name),
    template: String(row.template),
    createdAt: String(row.created_at),
  };
}

export function toPerson(row: Row) {
  const firstName = String(row.first_name);
  const lastName = String(row.last_name ?? '');
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    version: Number(row.version),
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim(),
    email: text(row.email),
    title: text(row.title),
    organizationId: text(row.organization_id),
    organizationName: text(row.organization_name),
    location: text(row.location),
    tags: parseJson<string[]>(row.tags, []),
    nextActionAt: text(row.next_action_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toOrganization(row: Row) {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    version: Number(row.version),
    name: String(row.name),
    domain: text(row.domain),
    kind: String(row.kind) as 'fund' | 'company',
    location: text(row.location),
    tags: parseJson<string[]>(row.tags, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toOpportunity(row: Row) {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    version: Number(row.version),
    name: String(row.name),
    pipelineId: String(row.pipeline_id),
    stageId: String(row.stage_id),
    stageName: text(row.stage_name),
    organizationId: text(row.organization_id),
    organizationName: text(row.organization_name),
    personId: text(row.person_id),
    personName: text(row.person_name),
    amountTarget: row.amount_target === null || row.amount_target === undefined ? null : Number(row.amount_target),
    currency: String(row.currency),
    owner: text(row.owner),
    status: String(row.status) as OpportunityStatus,
    reason: text(row.reason),
    nextActionAt: text(row.next_action_at),
    stageChangedAt: String(row.stage_changed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toStageEvent(row: Row) {
  return {
    id: String(row.id),
    opportunityId: String(row.opportunity_id),
    fromStageId: text(row.from_stage_id),
    fromStageName: text(row.from_stage_name),
    toStageId: String(row.to_stage_id),
    toStageName: text(row.to_stage_name),
    at: String(row.at),
    actor: String(row.actor),
  };
}

export function toActivity(row: Row) {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    kind: String(row.kind),
    body: String(row.body),
    actor: String(row.actor),
    createdAt: String(row.created_at),
  };
}

export function toTask(row: Row) {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    version: Number(row.version),
    title: String(row.title),
    entityType: text(row.entity_type),
    entityId: text(row.entity_id),
    entityName: text(row.entity_name),
    dueAt: text(row.due_at),
    status: String(row.status) as 'open' | 'done',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toClaim(row: Row) {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    field: String(row.field),
    value: String(row.value),
    sourceUrl: text(row.source_url),
    sourceType: String(row.source_type),
    observedAt: String(row.observed_at),
    status: String(row.status),
    createdAt: String(row.created_at),
  };
}

export function toRun(row: Row) {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    kind: String(row.kind),
    title: String(row.title),
    status: String(row.status) as RunStatus,
    simulated: String(row.kind) === 'demo_research',
    scope: parseJson<Record<string, unknown>>(row.scope, {}),
    counts: parseJson<RunCounts>(row.counts, { processed: 0, found: 0, flagged: 0 }),
    startedAt: text(row.started_at),
    finishedAt: text(row.finished_at),
    createdAt: String(row.created_at),
  };
}

export function toRunStep(row: Row) {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    seq: Number(row.seq),
    title: String(row.title),
    status: String(row.status),
    detail: text(row.detail),
    startedAt: text(row.started_at),
    finishedAt: text(row.finished_at),
  };
}

export function toApproval(row: Row) {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    runTitle: text(row.run_title),
    kind: String(row.kind),
    title: String(row.title),
    payload: parseJson<unknown>(row.payload, {}),
    payloadHash: String(row.payload_hash),
    status: String(row.status) as 'pending' | 'approved' | 'rejected',
    note: text(row.note),
    decidedAt: text(row.decided_at),
    decidedBy: text(row.decided_by),
    createdAt: String(row.created_at),
  };
}

export type Person = ReturnType<typeof toPerson>;
export type Organization = ReturnType<typeof toOrganization>;
export type Opportunity = ReturnType<typeof toOpportunity>;
export type Activity = ReturnType<typeof toActivity>;
export type Task = ReturnType<typeof toTask>;
export type FieldClaim = ReturnType<typeof toClaim>;
export type Run = ReturnType<typeof toRun>;
export type RunStep = ReturnType<typeof toRunStep>;
export type Approval = ReturnType<typeof toApproval>;
