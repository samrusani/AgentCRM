import { defaultModel as anthropicDefaultModel, estimateUsd as estimateAnthropicUsd, modelListPrices, supportedModels } from './anthropic.js';
import type { ModelProviderKind, ModelUsage } from './modelTypes.js';

// Every price below was read from the provider's own documentation on this date. They are list prices in
// US dollars per million tokens, used only for estimates, and every estimate shown says it is dated.
export const providerPricesAsOf = '2026-11-02';

export interface ModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  // Null when the provider does not publish a cached input price. Cached tokens then bill as plain input.
  cachedInputPerMillionUsd: number | null;
}

export interface PresetModel {
  id: string;
  prices: ModelPrice;
}

export type JsonMode = 'json_schema' | 'json_object';

export interface CompatibleQuirks {
  // Blank content from a json_object request is retried once, then fails.
  blankJsonRetry: boolean;
  // Tool call arguments may arrive as an object instead of a JSON string.
  argumentsMayBeObject: boolean;
  // Every request sends reasoning_effort "low", because the model reasons at maximum effort by default.
  reasoningEffortLow: boolean;
  maxCompletionTokensField: 'max_completion_tokens' | 'max_tokens';
}

export type KeyCheck = { method: 'models' } | { method: 'completion'; model: string };

export type CompatibleKind = 'openai' | 'deepseek' | 'zai';

export interface CompatiblePreset {
  kind: CompatibleKind;
  label: string;
  defaultBaseUrl: string;
  baseUrlEnvironmentName: string;
  models: PresetModel[];
  defaultModel: string;
  jsonMode: JsonMode;
  strictTools: boolean;
  keyCheck: KeyCheck;
  quirks: CompatibleQuirks;
  // Extra words for the price hint, such as "peak" for DeepSeek.
  priceQualifier: string | null;
}

export const compatiblePresets: Record<CompatibleKind, CompatiblePreset> = {
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlEnvironmentName: 'AGENTCRM_OPENAI_BASE',
    // gpt-6-astra and gpt-6.1-sol need the Responses API for tool calling, so they are not offered.
    models: [
      { id: 'gpt-5.6-terra', prices: { inputPerMillionUsd: 2.0, outputPerMillionUsd: 12.0, cachedInputPerMillionUsd: 0.2 } },
      { id: 'gpt-5.6-sol', prices: { inputPerMillionUsd: 4.0, outputPerMillionUsd: 20.0, cachedInputPerMillionUsd: 0.4 } },
      { id: 'gpt-6-luna', prices: { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5, cachedInputPerMillionUsd: 0.01 } },
    ],
    defaultModel: 'gpt-5.6-terra',
    jsonMode: 'json_schema',
    strictTools: true,
    keyCheck: { method: 'models' },
    quirks: { blankJsonRetry: false, argumentsMayBeObject: false, reasoningEffortLow: false, maxCompletionTokensField: 'max_completion_tokens' },
    priceQualifier: null,
  },
  deepseek: {
    kind: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    baseUrlEnvironmentName: 'AGENTCRM_DEEPSEEK_BASE',
    // Peak prices. Off peak is half.
    models: [
      { id: 'deepseek-flash', prices: { inputPerMillionUsd: 0.3, outputPerMillionUsd: 1.2, cachedInputPerMillionUsd: 0.006 } },
      { id: 'deepseek-v4-pro', prices: { inputPerMillionUsd: 1.32, outputPerMillionUsd: 3.96, cachedInputPerMillionUsd: 0.044 } },
    ],
    defaultModel: 'deepseek-flash',
    jsonMode: 'json_object',
    strictTools: false,
    keyCheck: { method: 'models' },
    quirks: { blankJsonRetry: true, argumentsMayBeObject: false, reasoningEffortLow: false, maxCompletionTokensField: 'max_tokens' },
    priceQualifier: 'peak',
  },
  zai: {
    kind: 'zai',
    label: 'Z.ai',
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    baseUrlEnvironmentName: 'AGENTCRM_ZAI_BASE',
    models: [
      { id: 'glm-5.3', prices: { inputPerMillionUsd: 1.4, outputPerMillionUsd: 4.4, cachedInputPerMillionUsd: 0.26 } },
      { id: 'glm-4.7', prices: { inputPerMillionUsd: 0.6, outputPerMillionUsd: 2.2, cachedInputPerMillionUsd: 0.11 } },
    ],
    defaultModel: 'glm-5.3',
    jsonMode: 'json_object',
    strictTools: false,
    keyCheck: { method: 'completion', model: 'glm-4.7-flash' },
    quirks: { blankJsonRetry: false, argumentsMayBeObject: true, reasoningEffortLow: true, maxCompletionTokensField: 'max_tokens' },
    priceQualifier: null,
  },
};

export const providerLabels: Record<ModelProviderKind, string> = {
  anthropic: 'Anthropic',
  openai: compatiblePresets.openai.label,
  deepseek: compatiblePresets.deepseek.label,
  zai: compatiblePresets.zai.label,
  ollama: 'Ollama',
};

export function isCompatibleKind(kind: ModelProviderKind): kind is CompatibleKind {
  return kind === 'openai' || kind === 'deepseek' || kind === 'zai';
}

export function offeredModelIds(kind: Exclude<ModelProviderKind, 'ollama'>): string[] {
  return kind === 'anthropic' ? [...supportedModels] : compatiblePresets[kind].models.map((model) => model.id);
}

export function defaultModelId(kind: Exclude<ModelProviderKind, 'ollama'>): string {
  return kind === 'anthropic' ? anthropicDefaultModel : compatiblePresets[kind].defaultModel;
}

export function isOfferedModel(kind: Exclude<ModelProviderKind, 'ollama'>, model: unknown): model is string {
  return typeof model === 'string' && offeredModelIds(kind).includes(model);
}

function presetModel(preset: CompatiblePreset, model: string): PresetModel {
  return preset.models.find((entry) => entry.id === model) ?? preset.models.find((entry) => entry.id === preset.defaultModel)!;
}

// An estimate from the dated list prices, rounded to a millionth of a dollar. It is not a bill.
// Ollama runs on the user's own machine, so its cost is always zero.
export function estimateModelCostUsd(kind: ModelProviderKind, model: string, usage: ModelUsage): number {
  if (kind === 'ollama') return 0;
  if (kind === 'anthropic') return estimateAnthropicUsd(model, usage);
  const prices = presetModel(compatiblePresets[kind], model).prices;
  const cachedPrice = prices.cachedInputPerMillionUsd ?? prices.inputPerMillionUsd;
  const dollars =
    (usage.inputTokens * prices.inputPerMillionUsd + usage.cacheReadTokens * cachedPrice + usage.outputTokens * prices.outputPerMillionUsd) /
    1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}

function dollars(value: number): string {
  return `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

// One plain sentence for the settings screen and the draft sheet.
export function priceHint(kind: ModelProviderKind, model: string | null): string {
  if (kind === 'ollama') return 'Runs on your machine. Local, no cost.';
  if (kind === 'anthropic') {
    const prices = modelListPrices[(model && isOfferedModel('anthropic', model) ? model : anthropicDefaultModel) as keyof typeof modelListPrices];
    return `Estimate as of ${providerPricesAsOf}: ${dollars(prices.inputPerMillionUsd)} in, ${dollars(prices.outputPerMillionUsd)} out per million tokens.`;
  }
  const preset = compatiblePresets[kind];
  const prices = presetModel(preset, model ?? preset.defaultModel).prices;
  const cached = prices.cachedInputPerMillionUsd === null ? '' : `, ${dollars(prices.cachedInputPerMillionUsd)} cached`;
  const qualifier = preset.priceQualifier ? `${preset.priceQualifier} ` : '';
  const offPeak = preset.kind === 'deepseek' ? ' Off peak is half.' : '';
  return `Estimate as of ${providerPricesAsOf}, ${qualifier}prices: ${dollars(prices.inputPerMillionUsd)} in, ${dollars(prices.outputPerMillionUsd)} out${cached} per million tokens.${offPeak}`;
}

export interface ProviderCatalogEntry {
  kind: ModelProviderKind;
  label: string;
  defaultModel: string | null;
  models: { id: string; priceHint: string }[];
  // Null for Ollama, whose models come from the server.
  pricesAsOf: string | null;
}

export function providerCatalog(): ProviderCatalogEntry[] {
  const kinds: ModelProviderKind[] = ['anthropic', 'openai', 'deepseek', 'zai'];
  const offered = kinds.map((kind): ProviderCatalogEntry => {
    const key = kind as Exclude<ModelProviderKind, 'ollama'>;
    return {
      kind,
      label: providerLabels[kind],
      defaultModel: defaultModelId(key),
      models: offeredModelIds(key).map((id) => ({ id, priceHint: priceHint(kind, id) })),
      pricesAsOf: providerPricesAsOf,
    };
  });
  return [...offered, { kind: 'ollama', label: providerLabels.ollama, defaultModel: null, models: [], pricesAsOf: null }];
}
