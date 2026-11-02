export const modelProviderKinds = ['anthropic', 'openai', 'deepseek', 'zai', 'ollama'] as const;
export type ModelProviderKind = (typeof modelProviderKinds)[number];

export function isModelProviderKind(value: unknown): value is ModelProviderKind {
  return typeof value === 'string' && (modelProviderKinds as readonly string[]).includes(value);
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export const emptyUsage: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

export function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
  };
}

export type ModelErrorKind = 'unauthorized' | 'rate_limited' | 'unavailable' | 'timeout' | 'rejected' | 'bad_response';

// Messages are written in the provider modules and never include the API key.
export class ModelProviderError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | null;

  constructor(kind: ModelErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'ModelProviderError';
    this.kind = kind;
    this.status = status;
  }

  // Rate limits, server errors, and network trouble can pass. Everything else needs a person to change something.
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable' || this.kind === 'timeout';
  }
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

export interface ChatToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatToolResult {
  content: string;
  isError?: boolean;
}

export interface Refusal {
  category: string | null;
  explanation: string | null;
}

// Reported once per provider response, including refusals, so each paid call is recorded as it happens.
export interface ModelCallReport {
  provider: ModelProviderKind;
  model: string;
  usage: ModelUsage;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatTurn[];
  tools: ChatToolDefinition[];
  maxToolRounds: number;
  runTool: (call: ChatToolCall) => Promise<ChatToolResult> | ChatToolResult;
  onCall?: (report: ModelCallReport) => void;
  // Used instead of `system` when a provider has to drop the tools, so the prompt does not promise lookups.
  systemWithoutTools?: string;
}

export interface ChatResponse {
  text: string;
  usage: ModelUsage;
  refusal: Refusal | null;
  toolRounds: number;
  hitToolLimit: boolean;
  cutOff: boolean;
  // Set when the model could not take tools and the answer was written without them.
  toolsUnavailable?: boolean;
}

export interface DraftRequest {
  model: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  onCall?: (report: ModelCallReport) => void;
}

export type DraftResponse =
  | { status: 'ok'; output: unknown; usage: ModelUsage }
  | { status: 'refused'; refusal: Refusal; usage: ModelUsage };

// Every provider implements the same three calls.
export interface ModelProvider {
  validateKey(): Promise<void>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  draft(request: DraftRequest): Promise<DraftResponse>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
