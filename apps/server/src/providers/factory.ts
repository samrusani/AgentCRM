import { defaultOllamaBase } from '../config.js';
import { createAnthropicProvider } from './anthropic.js';
import type { ModelProvider, ModelProviderKind } from './modelTypes.js';
import { createOllamaProvider } from './ollama.js';
import { createOpenAiCompatibleProvider } from './openaiCompatible.js';
import { compatiblePresets } from './presets.js';

export interface ProviderCredentials {
  // Empty for Ollama, which has no key.
  apiKey: string;
  // Only Ollama reads it.
  baseUrl?: string | null;
}

// Maps a connector kind to its adapter. The compatible adapters take their preset, Ollama takes its address.
export function createModelProvider(kind: ModelProviderKind, credentials: ProviderCredentials): ModelProvider {
  if (kind === 'anthropic') return createAnthropicProvider(credentials.apiKey);
  if (kind === 'ollama') return createOllamaProvider(credentials.baseUrl ?? defaultOllamaBase);
  return createOpenAiCompatibleProvider(compatiblePresets[kind], credentials.apiKey);
}

export { createOllamaProvider };
