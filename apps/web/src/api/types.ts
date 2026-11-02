// Types mirror docs/architecture.md. JSON keys are camelCase on the client;
// the client converts snake_case keys if the server sends them.

export type EntityType = 'person' | 'organization' | 'opportunity';

export interface Workspace {
  id: string;
  name: string;
  template: string;
}

export interface Health {
  ok: boolean;
  version: string;
  dbPath: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Person {
  id: string;
  version: number;
  firstName: string;
  lastName: string;
  name?: string;
  email: string | null;
  title: string | null;
  organizationId: string | null;
  organizationName?: string | null;
  location: string | null;
  tags: string[];
  nextActionAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Organization {
  id: string;
  version: number;
  name: string;
  domain: string | null;
  kind: 'fund' | 'company' | string;
  location: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export type ClaimStatus = 'imported' | 'extracted' | 'corroborated' | 'human_confirmed';

export interface Claim {
  id: string;
  entityType: EntityType;
  entityId: string;
  field: string;
  value: string | null;
  sourceUrl: string | null;
  sourceType: string;
  observedAt: string;
  status: ClaimStatus | string;
}

export type ActivityKind = 'note' | 'email_draft' | 'stage_change' | 'agent' | string;

export interface Activity {
  id: string;
  entityType: EntityType;
  entityId: string;
  kind: ActivityKind;
  body: string;
  actor: string;
  createdAt: string;
}

export type TaskStatus = 'open' | 'done';

export interface Task {
  id: string;
  version: number;
  title: string;
  entityType: EntityType | null;
  entityId: string | null;
  entityName?: string | null;
  dueAt: string | null;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Stage {
  id: string;
  pipelineId: string;
  name: string;
  seq: number;
}

export interface Pipeline {
  id: string;
  name: string;
  stages: Stage[];
}

export type OpportunityStatus = 'open' | 'passed' | 'lost' | 'nurture';

export interface Opportunity {
  id: string;
  version: number;
  name: string;
  pipelineId: string;
  stageId: string;
  organizationId: string | null;
  organizationName?: string | null;
  personId: string | null;
  personName?: string | null;
  amountTarget: number | null;
  currency: string | null;
  owner: string | null;
  status: OpportunityStatus;
  reason: string | null;
  nextActionAt: string | null;
  stageChangedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonDetail extends Person {
  organization: Organization | null;
  affiliationsSummary: unknown;
  claims: Claim[];
  activities: Activity[];
  tasks: Task[];
  opportunities: Opportunity[];
}

export interface OrganizationDetail extends Organization {
  people: Person[];
  claims: Claim[];
  activities: Activity[];
  opportunities: Opportunity[];
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface RunCounts {
  processed: number;
  found: number;
  flagged: number;
}

export interface RunStep {
  id: string;
  runId: string;
  seq: number;
  title: string;
  status: string;
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Run {
  id: string;
  kind: 'demo_research' | string;
  title: string;
  status: RunStatus;
  scope: Record<string, unknown>;
  counts: RunCounts;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  steps?: RunStep[];
  approvals?: Approval[];
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;
  runId: string | null;
  runTitle?: string | null;
  runKind?: string | null;
  kind: string;
  title: string;
  payload: unknown;
  payloadHash: string;
  status: ApprovalStatus;
  note: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  createdAt: string;
}

export interface TodayData {
  tasksDue: Task[];
  approvalsPending: Approval[];
  runsActive: Run[];
  counts: Record<string, number>;
}

export interface SearchResults {
  people: Person[];
  organizations: Organization[];
  opportunities: Opportunity[];
}

export interface AgentAction {
  id: string;
  label: string;
  kind: string;
  entityType?: 'person' | 'organization' | 'opportunity';
  entityId?: string;
}

export interface AgentReply {
  reply: string;
  actions: AgentAction[];
  modelConnected?: boolean;
}

export interface ApiErrorEnvelope {
  error: { code: string; message: string; current?: unknown };
}

export type ServerEventName = 'run_updated' | 'approval_updated' | 'record_updated';
