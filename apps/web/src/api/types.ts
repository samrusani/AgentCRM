// Types mirror docs/architecture.md. JSON keys are camelCase on the client;
// the client converts snake_case keys if the server sends them.

export type EntityType = 'person' | 'organization' | 'opportunity';

export interface Workspace {
  id: string;
  name: string;
  version?: number;
}

export interface WorkspaceTemplate {
  id: string;
  name: string;
  description: string;
  pipelineName: string;
  stageNames: string[];
}

export interface TemplateSwitchInput {
  // The pipeline being switched. expectedVersion is that pipeline's version.
  pipelineId: string;
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

export interface CaptureSettings {
  configured: boolean;
  createdAt: string | null;
}

export interface CaptureToken {
  token: string;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// A person is a lead until someone replies or a deal moves, then a relationship.
export type Lifecycle = 'lead' | 'relationship';

export interface Person {
  id: string;
  version: number;
  lifecycle?: Lifecycle;
  firstName: string;
  lastName: string;
  name?: string;
  email: string | null;
  title: string | null;
  organizationId: string | null;
  organizationName?: string | null;
  location: string | null;
  // Canonical profile URLs, null when none is saved.
  linkedinUrl?: string | null;
  xUrl?: string | null;
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
  linkedinUrl?: string | null;
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
  // The template the pipeline runs, and its version for renames and template switches.
  template: string;
  version: number;
  stages: Stage[];
}

// A named, hand curated set of people. Lists hold people only.
export interface PersonList {
  id: string;
  name: string;
  version: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AddMembersResult {
  added: number;
  already: number;
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
  // The lists this person is on, newest membership first.
  lists: Array<{ id: string; name: string }>;
  // Stored mail linked to this person, or null when none is linked.
  interaction: PersonInteraction | null;
}

export interface PersonInteraction {
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  inbound: number;
  outbound: number;
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
export type MailProviderKind = 'agentmail' | 'gmail' | 'microsoft' | 'imap';
export type ConnectorKind = 'apify' | MailProviderKind | ModelProviderKind;

// The one mail connector sending and inbound sync use. The server answers null when none is configured.
export interface MailProviderSelection {
  kind: MailProviderKind | string;
  // The sending address, null until the connector has one.
  address: string | null;
  // Connected, healthy, and with a sending address. Only a ready provider can send.
  ready: boolean;
  lastSyncAt: string | null;
}

export interface GmailCredentialsInput {
  clientId: string;
  clientSecret: string;
}

// Microsoft is a public client: the Entra client id is the only credential, there is no secret.
export interface MicrosoftCredentialsInput {
  clientId: string;
}

export type ImapPreset = 'icloud' | 'fastmail' | 'custom';
export type SmtpTls = 'tls' | 'starttls';

// The PUT body for the IMAP and SMTP connector. Presets fill the servers on the server, so only custom sends them.
export interface ImapConnectorInput {
  preset: ImapPreset;
  address: string;
  username?: string;
  appPassword?: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  smtpTls?: SmtpTls;
  sentMailbox?: string;
}

// The servers an IMAP and SMTP connector reads and sends through, as the server reports them.
export interface ImapServers {
  imapHost: string | null;
  imapPort: number | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpTls: string | null;
}

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

// The actors lead capture and enrichment run. The server always sends effective values, with defaults applied.
export interface LeadCaptureSettings {
  postActor: string;
  reactionsActor: string;
  commentsActor: string;
  profileActor: string;
  companyActor: string;
  personSearchActor: string;
}

export interface ApifyConnectorInput {
  token?: string;
  allowlist?: string[];
  // Each field is optional. An empty string resets that field to its default.
  leadCapture?: Partial<LeadCaptureSettings>;
}

export type LeadSource = 'post' | 'reactions' | 'comments';

export interface LeadCaptureInput {
  // A post link or a lnkd.in short link. Optional provenance when postText is set.
  postUrl?: string;
  // The pasted post text. Setting it makes the run a pasted capture that reads only this text.
  postText?: string;
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
  // Gmail and Microsoft: the OAuth client id (masked or whole, as the server sends it), the signed in account, and the last inbound sync.
  clientId: string | null;
  emailAddress: string | null;
  // Gmail and Microsoft: when a sign in last finished. It changes only on success, so the card can tell a failed
  // attempt from a finished one.
  oauthCompletedAt: string | null;
  lastSyncAt: string | null;
  tokenMasked: string | null;
  updatedAt: string | null;
  // IMAP and SMTP only: the preset, the servers, the Sent mailbox, and what the last connect verified. Never the password.
  imap: ImapSettings | null;
}

export interface ImapSettings {
  preset: ImapPreset | null;
  servers: ImapServers;
  sentMailbox: string | null;
  imapOk: boolean;
  smtpOk: boolean;
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
  // Lead capture batches only: the LinkedIn post the people came from. A short link shows as the resolved post link.
  postUrl: string | null;
  // Lead capture batches only: true when the people were read out of pasted post text.
  pasted: boolean;
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
  // Mailbox rows: how much stored mail there is with this address, from the counts the row keeps.
  mailbox: MailboxCounts | null;
}

export interface MailboxCounts {
  inbound: number;
  outbound: number;
  lastSeenAt: string | null;
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
  // Mailbox capture reviews show how much mail there is with each address. Other imports leave these null.
  inbound: number | null;
  outbound: number | null;
  lastSeenAt: string | null;
}

export interface ImportReviewPayload {
  batchId: string | null;
  actorId: string | null;
  // Lead capture reviews: the LinkedIn post the people came from. A short link shows as the resolved post link.
  postUrl: string | null;
  // Lead capture reviews: true when the people were read out of pasted post text.
  pasted: boolean;
  // True for a mailbox capture: the people come from mail already synced to this computer.
  mailbox: boolean;
  counts: ImportCounts;
  sample: ImportSampleRow[];
}

export interface MailboxCaptureInput {
  // Omitted means all synced mail.
  sinceDays?: number;
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

export interface ImportSettings {
  autoAccept: boolean;
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

export type EnrichmentField = 'title' | 'location' | 'email' | 'linkedinUrl' | 'domain';

export interface EnrichmentRun {
  id: string;
  status: RunStatus | string;
  startedAt: string | null;
  // The final or failing step detail, null while the run is open.
  detail?: string | null;
  // How many suggestions the run produced in all, including 0. Only pending ones are listed.
  suggestedCount?: number;
  // Person runs only: a name search (no LinkedIn profile saved at start) or a profile scrape. Absent from older servers.
  mode?: 'profile' | 'name';
}

export interface EnrichmentSuggestion {
  field: EnrichmentField | string;
  value: string;
  status: 'pending' | string;
}

export interface EnrichmentState {
  run: EnrichmentRun | null;
  suggestions: EnrichmentSuggestion[];
}

export interface AcceptEnrichmentInput {
  personId: string;
  runId: string;
  field: string;
  expectedVersion: number;
}

export interface AcceptOrganizationEnrichmentInput {
  organizationId: string;
  runId: string;
  field: string;
  expectedVersion: number;
}

export type ServerEventName = 'run_updated' | 'approval_updated' | 'record_updated' | 'followup_updated';

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
  // The mail provider that staged the intent. Null when the server does not say.
  provider: string | null;
  // The sending address the message was approved to leave from. Null when the server does not say.
  address: string | null;
  submittedAt: string | null;
  updatedAt: string | null;
  // Set on an intent a follow-up rule created: the rule and the 1 based step it sends. Null on first messages.
  followupRuleId: string | null;
  followupStep: number | null;
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
  // The provider that will send this message, when the frozen payload names it.
  provider: string | null;
}

// One pre-approved follow-up. The same text goes to every recipient, word for word.
export interface FollowupStep {
  waitDays: number;
  body: string;
}

export interface FollowupPlan {
  steps: FollowupStep[];
}

export interface SendReviewPayload {
  messages: SendReviewMessage[];
  excluded: SendExcluded[];
  remainingDailyCap: number | null;
  // The provider the send goes out through, when the frozen payload names it. Decides the thread wording.
  mailProvider: string | null;
  // Present only when a follow-up plan was attached. Older payloads lack it.
  followups: FollowupPlan | null;
}

export interface StageSendInput {
  draftActivityIds?: string[];
  runId?: string;
  followups?: FollowupPlan;
}

export type FollowupRuleStatus = 'waiting' | 'armed' | 'sending' | 'done' | 'stopped' | 'expired';

export type FollowupStoppedReason =
  | 'not_sent'
  | 'replied'
  | 'suppressed'
  | 'bounced'
  | 'connector_changed'
  | 'stopped_by_user'
  | 'step_not_sent'
  // On an expired rule: more than 7 days past a due step, or 90 days past the approval.
  | 'overdue'
  | 'ceiling';

export interface FollowupRule {
  id: string;
  personId: string | null;
  personName: string | null;
  status: FollowupRuleStatus | string;
  steps: FollowupStep[];
  // The 1 based number of the follow-up that goes out next.
  nextStep: number;
  nextDueAt: string | null;
  stoppedReason: FollowupStoppedReason | string | null;
  provider: string | null;
  anchorIntentId: string | null;
  anchorSubject: string | null;
  lastIntentId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
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
