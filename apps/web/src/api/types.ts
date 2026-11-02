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
  // Present on list items and details. Null means the person was never qualified.
  qualification?: QualificationSummary | null;
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

export interface PersonDetail extends Omit<Person, 'qualification'> {
  qualification: QualificationResult | null;
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
  // Reported by qualify runs only.
  excluded?: number;
  // Reported by model backed runs (draft_outreach): estimated spend observed so far, from list prices.
  estimatedUsd?: number;
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

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  // An estimate from list prices, never an invoice amount.
  estimatedUsd: number;
}

export interface AgentReply {
  reply: string;
  actions: AgentAction[];
  modelConnected?: boolean;
  // Set by the server when the model call failed and the rule based helper answered instead.
  modelFailed?: boolean;
  // Present only when a model produced the reply.
  usage?: AgentUsage;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AgentContext {
  entityType: EntityType;
  entityId: string;
}

export interface AgentMessageInput {
  text: string;
  history?: ChatTurn[];
  context?: AgentContext;
}

export interface ApiErrorEnvelope {
  error: { code: string; message: string; current?: unknown };
}

export type ConnectorStatus = 'connected' | 'error' | string;

export interface Connector {
  id: string | null;
  kind: 'apify' | 'anthropic' | string;
  status: ConnectorStatus;
  statusMessage: string | null;
  allowlist: string[];
  // Anthropic only: the chosen model id from settings.model.
  model: string | null;
  tokenMasked: string | null;
  updatedAt: string | null;
}

export interface ApifyActorSummary {
  id: string;
  name: string | null;
  title: string | null;
  username: string | null;
  description: string | null;
  totalRuns: number | null;
  pricingHint: string | null;
}

export interface ApifyActorDetail extends ApifyActorSummary {
  exampleInput: Record<string, unknown> | null;
}

export interface ImportCounts {
  fetched: number;
  staged: number;
  duplicates: number;
  invalid: number;
  accepted: number | null;
  rejected: number | null;
}

export type ImportBatchStatus = 'staging' | 'awaiting_review' | 'accepted' | 'rejected' | 'failed' | string;
export type ImportRowStatus = 'staged' | 'duplicate' | 'invalid' | 'accepted' | 'rejected' | string;

export interface ImportBatch {
  id: string;
  runId: string | null;
  sourceKind: string;
  actorId: string | null;
  apifyRunId: string | null;
  datasetId: string | null;
  status: ImportBatchStatus;
  counts: ImportCounts;
  updatedAt: string | null;
}

export interface ImportRow {
  seq: number;
  status: ImportRowStatus;
  reason: string | null;
  mapped: Record<string, unknown>;
  matchEntityType: string | null;
  matchEntityId: string | null;
}

export interface ImportBatchPage {
  batch: ImportBatch;
  items: ImportRow[];
  nextCursor: string | null;
}

export interface ImportSampleRow {
  name: string | null;
  email: string | null;
  company: string | null;
}

export interface ImportReviewPayload {
  batchId: string | null;
  actorId: string | null;
  counts: ImportCounts;
  sample: ImportSampleRow[];
}

export interface ApifyRunInput {
  actorId: string;
  input: Record<string, unknown>;
  maxItems: number;
  title?: string;
}

export interface DraftOutreachInput {
  personIds?: string[];
  tag?: string;
  instructions?: string;
  maxPeople: number;
  budgetUsd?: number;
  title?: string;
}

export interface DraftSample {
  personName: string | null;
  subject: string | null;
}

export interface DraftFact {
  field: string;
  value: string;
}

// One full draft as the approval holds it. Facts are reported by the model and checked only against the record text.
export interface DraftEntry {
  personId: string | null;
  personName: string | null;
  subject: string | null;
  body: string | null;
  factsUsed: DraftFact[];
}

export interface DraftReviewPayload {
  count: number;
  // Up to three entries, kept for approvals made before full drafts were included.
  sample: DraftSample[];
  drafts: DraftEntry[];
  estimatedUsd: number | null;
}

export interface DraftPersonNote {
  personName: string | null;
  reason: string;
}

// What a draft run reports about people it did not draft for, read from the run scope.
export interface DraftRunIssues {
  failures: DraftPersonNote[];
  skipped: DraftPersonNote[];
  stoppedEarly: string | null;
  notDrafted: number | null;
  budgetUsd: number | null;
  budgetDefaulted: boolean;
}

export type CsvField =
  | 'firstName'
  | 'lastName'
  | 'name'
  | 'email'
  | 'company'
  | 'domain'
  | 'title'
  | 'location'
  | 'linkedinUrl'
  | 'tags';

export type CsvMappingTarget = CsvField | 'ignore';

export type CsvMapping = Record<string, CsvMappingTarget>;

export interface CsvPreview {
  headers: string[];
  delimiter: string;
  rowCount: number;
  suggestedMapping: Record<string, string>;
  // Parsed sample rows, each as one string per column in header order.
  sample: string[][];
}

export interface CsvImportInput {
  fileName: string;
  content: string;
  mapping: CsvMapping;
}

export type CriterionTarget = 'person' | 'organization';
export type CriterionField = 'title' | 'location' | 'tags' | 'email' | 'name' | 'kind' | 'domain';
export type CriterionOperator = 'contains' | 'equals' | 'in' | 'exists';

export interface Criterion {
  id: string;
  label: string;
  target: CriterionTarget;
  field: CriterionField;
  operator: CriterionOperator;
  values: string[];
  enabled: boolean;
}

export interface QualificationConfig {
  exclusions: Criterion[];
  criteria: Criterion[];
  // True until a configuration is saved: the server is showing the template defaults.
  defaulted?: boolean;
}

export interface QualificationSummary {
  matched: number;
  total: number;
  unknown: number;
  excluded: boolean;
  // When qualification last ran for this person. Compare with the person's updatedAt to spot stale results.
  computedAt: string | null;
}

export type CriterionOutcome = 'matched' | 'not_matched' | 'unknown';

export interface CriterionResult {
  id: string;
  label: string;
  outcome: CriterionOutcome;
  reason: string | null;
  evidence: unknown;
}

export interface QualificationResult extends QualificationSummary {
  excludedReasons: string[];
  criteria: CriterionResult[];
}

export type ServerEventName = 'run_updated' | 'approval_updated' | 'record_updated';
