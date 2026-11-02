// Provider presets and list prices per million tokens, mirrored from docs/architecture.md (Model adapter).
// Used only for estimates and labels in the UI. The server computes the costs it reports.

import type { ModelProviderKind, ModelProviderSelection } from '../api/types';

export interface ModelOption {
  id: string;
  name: string;
  inputPerMillion: number;
  outputPerMillion: number;
  note?: string;
}

export interface ProviderPreset {
  kind: ModelProviderKind;
  name: string;
  // Keyed providers take an API key. Ollama takes a base URL instead.
  keyed: boolean;
  // Offered models, default first. Ollama has none here: the installed models come from the local server.
  models: ModelOption[];
  defaultModelId: string | null;
  // Where the key is sent, for the storage note.
  destination: string;
  // Shown on a card that is not connected.
  introduction: string;
  // Shown under the model select when prices need a qualifier.
  priceNote?: string;
}

export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

export const PROVIDERS: ProviderPreset[] = [
  {
    kind: 'anthropic',
    name: 'Anthropic',
    keyed: true,
    models: [
      { id: 'claude-opus-5-5', name: 'Opus 5.5', inputPerMillion: 4, outputPerMillion: 20 },
      { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', inputPerMillion: 2, outputPerMillion: 10 },
      {
        id: 'claude-haiku-5-5',
        name: 'Haiku 5.5',
        inputPerMillion: 0.1,
        outputPerMillion: 0.5,
        note: 'up to 100K prompts',
      },
    ],
    defaultModelId: 'claude-opus-5-5',
    destination: 'the configured Anthropic endpoint',
    introduction:
      'Connect your own Anthropic API key so chat can answer from your records and the agent can draft outreach. Without a model provider, chat stays rule based and research runs stay simulated.',
  },
  {
    kind: 'openai',
    name: 'OpenAI',
    keyed: true,
    models: [
      { id: 'gpt-5.6-terra', name: 'gpt-5.6-terra', inputPerMillion: 2, outputPerMillion: 12 },
      { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', inputPerMillion: 4, outputPerMillion: 20 },
      { id: 'gpt-6-luna', name: 'gpt-6-luna', inputPerMillion: 0.1, outputPerMillion: 0.5 },
    ],
    defaultModelId: 'gpt-5.6-terra',
    destination: 'the configured OpenAI endpoint',
    introduction: 'Connect your own OpenAI API key so chat can answer from your records and the agent can draft outreach.',
  },
  {
    kind: 'deepseek',
    name: 'DeepSeek',
    keyed: true,
    models: [
      { id: 'deepseek-flash', name: 'deepseek-flash', inputPerMillion: 0.3, outputPerMillion: 1.2, note: 'peak price' },
      { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', inputPerMillion: 1.32, outputPerMillion: 3.96, note: 'peak price' },
    ],
    defaultModelId: 'deepseek-flash',
    destination: 'the configured DeepSeek endpoint',
    introduction:
      'Connect your own DeepSeek API key so chat can answer from your records and the agent can draft outreach.',
    priceNote: 'DeepSeek prices shown are peak prices. Off peak is half, so estimates may run high.',
  },
  {
    kind: 'zai',
    name: 'Z.ai',
    keyed: true,
    models: [
      { id: 'glm-5.3', name: 'glm-5.3', inputPerMillion: 1.4, outputPerMillion: 4.4 },
      { id: 'glm-4.7', name: 'glm-4.7', inputPerMillion: 0.6, outputPerMillion: 2.2 },
    ],
    defaultModelId: 'glm-5.3',
    destination: 'the configured Z.ai endpoint',
    introduction: 'Connect your own Z.ai API key so chat can answer from your records and the agent can draft outreach.',
  },
  {
    kind: 'ollama',
    name: 'Ollama',
    keyed: false,
    models: [],
    defaultModelId: null,
    destination: 'the Ollama server at the address you set',
    introduction:
      'Connect a local Ollama server so chat and drafting run on your own computer. No key and no per token cost.',
  },
];

export function findProvider(kind: string | null | undefined): ProviderPreset | null {
  return PROVIDERS.find((provider) => provider.kind === kind) ?? null;
}

export function providerName(kind: string | null | undefined): string {
  return findProvider(kind)?.name ?? kind ?? 'Unknown provider';
}

export function isLocalProvider(kind: string | null | undefined): boolean {
  return kind === 'ollama';
}

export function findModel(kind: string | null | undefined, id: string | null | undefined): ModelOption | null {
  return findProvider(kind)?.models.find((model) => model.id === id) ?? null;
}

// Model ids are distinct across providers, so a bare id resolves without its kind. Unknown ids show as they are.
export function modelName(id: string | null | undefined): string {
  if (!id) return 'Unknown model';
  for (const provider of PROVIDERS) {
    const found = provider.models.find((model) => model.id === id);
    if (found) return found.name;
  }
  return id;
}

function price(value: number): string {
  return value.toFixed(2);
}

export function modelHint(model: ModelOption): string {
  const base = `${model.name}, ${price(model.inputPerMillion)} in / ${price(model.outputPerMillion)} out per million tokens`;
  return model.note ? `${base} (${model.note})` : base;
}

export function localModelHint(name: string): string {
  return `${name}, local, no cost`;
}

// The statement on the model provider section and in other places that name the provider in use.
export function activeProviderSentence(kind: string, model: string | null): string {
  return model ? `Chat and drafting use ${providerName(kind)}, ${modelName(model)}.` : `Chat and drafting use ${providerName(kind)}.`;
}

// What to tell a person when the active provider cannot run work, or null when it can. A rejected key shows the
// server's own message. An Ollama server with no model chosen says so.
export function providerAttention(active: ModelProviderSelection): string | null {
  if (active.ready) return null;
  const name = providerName(active.kind);
  const reason =
    active.status === 'error'
      ? active.statusMessage ?? 'The saved key was rejected.'
      : isLocalProvider(active.kind) && !active.model
        ? 'A model must be chosen.'
        : 'It is not ready to use.';
  return `Model provider needs attention (${name}): ${reason}`;
}

// The model the preflight prices: the chosen one when this build knows its prices, else the provider's default.
export function pricedModel(
  kind: string | null | undefined,
  modelId: string | null | undefined,
): { model: ModelOption; exact: boolean } | null {
  const provider = findProvider(kind);
  if (!provider || provider.models.length === 0) return null;
  const chosen = findModel(kind, modelId);
  if (chosen) return { model: chosen, exact: true };
  const fallback = provider.models.find((model) => model.id === provider.defaultModelId) ?? provider.models[0];
  return fallback ? { model: fallback, exact: false } : null;
}

// Rough per draft token guess used by the preflight estimate in the draft outreach sheet.
export const DRAFT_INPUT_TOKENS = 1500;
export const DRAFT_OUTPUT_TOKENS = 400;
// The guess is wide on purpose: reasoning tokens bill as output and prompts vary with the record.
const RANGE_LOW = 0.5;
const RANGE_HIGH = 2;

export interface CostRange {
  low: number;
  high: number;
}

export function estimateDraftCost(people: number, model: ModelOption): CostRange {
  const perDraft =
    (DRAFT_INPUT_TOKENS * model.inputPerMillion + DRAFT_OUTPUT_TOKENS * model.outputPerMillion) / 1_000_000;
  const point = perDraft * people;
  return { low: point * RANGE_LOW, high: point * RANGE_HIGH };
}

// Small amounts keep three decimals ("$0.005") so a cheap chat reply never rounds to zero.
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.001) return 'under $0.001';
  if (value < 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}
