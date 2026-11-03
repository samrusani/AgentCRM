// Types mirror docs/architecture.md. JSON keys are camelCase on the client;
// the client converts snake_case keys if the server sends them.

export type EntityType = 'person' | 'organization' | 'opportunity';

export interface Workspace {
  id: string;
  name: string;
  template: string;
  // The workspace version, used as expectedVersion when switching templates.
  version?: number;
}

export interface WorkspaceTemplate {
  id: string;
  name: string;
  description: string;
  pipelineName: string;
  stageNames: string[];
  current: boolean;
}

export interface TemplateSwitchInput {
  template: string;
  // Existing stage id to a stage name of the target template. A stage left out is removed.
  stageMapping: Record<string, string>;
  replaceQualification: boolean;
  expectedVersion: number;
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

export type ActivityKind = 'note' | 'email_draft' | 'email_out' | 'email_in' | 'stage_change' | 'agent' | string;

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
  // The provider and model that answered. Ollama runs on this computer, so its replies carry no cost.
  provider?: string;
  model?: string;
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

export type ModelProviderKind = 'anthropic' | 'openai' | 'deepseek' | 'zai' | 'ollama';
export type ConnectorKind = 'apify' | 'agentmail' | ModelProviderKind;

// The one provider chat and drafting use. The server answers null when none is configured.
export interface ModelProviderSelection {
  kind: ModelProviderKind | string;
  model: string | null;
  // 'error' means the saved key was rejected. The provider stays saved and active but cannot run work.
  status: 'connected' | 'error';
  statusMessage: string | null;
  // Connected, no error, and for Ollama a model chosen. Only a ready provider can answer chat or draft.
  ready: boolean;
}

export interface ModelProviderInput {
  // Keyed providers.
  token?: string;
  // Ollama.
  baseUrl?: string;
  model?: string;
}

export interface OllamaModel {
  name: string;
}

// The four actors lead capture runs. The server always sends effective values, with defaults applied.
export interface LeadCaptureSettings {
  postActor: string;
  reactionsActor: string;
  commentsActor: string;
  profileActor: string;
}

export interface ApifyConnectorInput {
  token?: string;
  allowlist?: string[];
  // Each field is optional. An empty string resets that field to its default.
  leadCapture?: Partial<LeadCaptureSettings>;
}

export type LeadSource = 'post' | 'reactions' | 'comments';

export interface LeadCaptureInput {
  postUrl: string;
  sources?: LeadSource[];
  maxPeople?: number;
  enrich?: boolean;
  enrichLimit?: number;
  title?: string;
}

export interface Connector {
  id: string | null;
  kind: ConnectorKind | string;
  status: ConnectorStatus;
  statusMessage: string | null;
  allowlist: string[];
  // Apify only: the actors lead capture runs. Null for other connectors.
  leadCapture: LeadCaptureSettings | null;
  // Model providers only: the chosen model id from settings.model.
  model: string | null;
  // Ollama only: the server address from settings.baseUrl.
  baseUrl: string | null;
  // AgentMail only: the selected sending inbox from settings.
  inboxId: string | null;
  inboxEmail: string | null;
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
  // Lead capture batches only: the LinkedIn post the people came from.
  postUrl: string | null;
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
  // Lead capture rows named in a post text: the snippet of the post that names the row, as evidence.
  postQuote: string | null;
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
  // Lead capture reviews also show the title and the LinkedIn profile.
  title: string | null;
  linkedinUrl: string | null;
  // Lead capture reviews can stage organizations named in a post. Other imports are always people.
  kind: 'person' | 'organization';
}

export interface ImportReviewPayload {
  batchId: string | null;
  actorId: string | null;
  // Lead capture reviews: the LinkedIn post the people came from.
  postUrl: string | null;
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
  // The provider that wrote the drafts. A local model costs nothing, so no dollar line is shown for it.
  provider: string | null;
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

export interface MailInbox {
  id: string;
  email: string;
}

export type SendIntentStatus =
  | 'awaiting_approval'
  | 'approved'
  | 'queued'
  | 'submitting'
  | 'accepted'
  | 'failed'
  | 'unknown'
  | 'blocked'
  | 'cancelled'
  | 'replied'
  | 'bounced';

export interface SendIntent {
  id: string;
  personId: string | null;
  personName: string | null;
  toEmail: string;
  subject: string;
  status: SendIntentStatus | string;
  error: string | null;
  providerMessageId: string | null;
  submittedAt: string | null;
  updatedAt: string | null;
}

export interface SendExcluded {
  personName: string | null;
  toEmail: string | null;
  reason: string;
}

// One frozen message as the send_review approval holds it. Approving sends exactly this text.
export interface SendReviewMessage {
  intentId: string | null;
  personName: string | null;
  to: string | null;
  subject: string | null;
  body: string | null;
  inboxEmail: string | null;
}

export interface SendReviewPayload {
  messages: SendReviewMessage[];
  excluded: SendExcluded[];
  remainingDailyCap: number | null;
}

export interface StageSendInput {
  draftActivityIds?: string[];
  runId?: string;
}

export interface StageSendResult {
  approval: Approval | null;
  excluded: SendExcluded[];
}

export interface Suppression {
  id: string;
  email: string;
  reason: string;
  createdAt: string | null;
  matchedWording: string | null;
}

export interface MailReply {
  id: string;
  personId: string | null;
  personName: string | null;
  fromEmail: string | null;
  subject: string | null;
  preview: string | null;
  receivedAt: string | null;
  taskId: string | null;
  taskTitle: string | null;
  optOut: boolean;
  matchedWording: string | null;
  suppressionId: string | null;
}

export interface MailSummary {
  counts: Record<string, number>;
  remainingDailyCap: number | null;
  dailyCap: number;
  lastSyncAt: string | null;
  replies: MailReply[];
  // The server may report only a number. It is at least the number of rows in replies.
  repliesNeedingAttention: number;
}
