import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  anthropicBaseUrl,
  anthropicChatTimeoutMilliseconds,
  anthropicDraftTimeoutMilliseconds,
  anthropicKeyCheckTimeoutMilliseconds,
  anthropicMaxRetries,
} from '../config.js';
import {
  addUsage,
  type ChatToolDefinition,
  emptyUsage,
  isRecord,
  type ModelProvider,
  ModelProviderError,
  type ModelUsage,
  type Refusal,
} from './modelTypes.js';

export {
  addUsage,
  type ChatRequest,
  type ChatResponse,
  type ChatToolCall,
  type ChatToolDefinition,
  type ChatToolResult,
  type ChatTurn,
  type DraftRequest,
  type DraftResponse,
  emptyUsage,
  type ModelCallReport,
  type ModelErrorKind,
  type ModelProvider,
  ModelProviderError,
  type ModelUsage,
  type Refusal,
} from './modelTypes.js';

export const supportedModels = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type ModelId = (typeof supportedModels)[number];
export const defaultModel: ModelId = 'claude-opus-5-5';

export function isSupportedModel(value: unknown): value is ModelId {
  return typeof value === 'string' && (supportedModels as readonly string[]).includes(value);
}

// List prices in US dollars per million tokens. Used only for estimates. Haiku's price holds for prompts up to 100K tokens.
export const modelListPrices: Record<ModelId, { inputPerMillionUsd: number; outputPerMillionUsd: number }> = {
  'claude-opus-5-5': { inputPerMillionUsd: 4.0, outputPerMillionUsd: 20.0 },
  'claude-sonnet-5-5': { inputPerMillionUsd: 2.0, outputPerMillionUsd: 10.0 },
  'claude-haiku-5-5': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5 },
};

// Cache reads are billed at a tenth of the input price. Cache writes cost a quarter more than input.
const cacheReadPriceFactor = 0.1;
const cacheWritePriceFactor = 1.25;

// An estimate from list prices, rounded to a millionth of a dollar. It is not a bill.
export function estimateUsd(model: string, usage: ModelUsage): number {
  const prices = isSupportedModel(model) ? modelListPrices[model] : modelListPrices[defaultModel];
  const dollars =
    (usage.inputTokens * prices.inputPerMillionUsd +
      usage.cacheReadTokens * prices.inputPerMillionUsd * cacheReadPriceFactor +
      usage.cacheCreationTokens * prices.inputPerMillionUsd * cacheWritePriceFactor +
      usage.outputTokens * prices.outputPerMillionUsd) /
    1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}

const fallbackBeta = 'server-side-fallback-2026-07-01';
const chatMaxTokens = 6000;
const draftMaxTokens = 12000;

// Model ids whose server rejected the fallback fields. Remembered for the life of the process, per model,
// so one model that rejects them does not turn fallbacks off for the others.
const fallbacksRejected = new Set<string>();

export function resetFallbackMemory(): void {
  fallbacksRejected.clear();
}

function scrub(message: string, apiKey: string): string {
  return apiKey.length > 0 ? message.replaceAll(apiKey, '[removed]') : message;
}

function mapError(error: unknown, apiKey: string): ModelProviderError {
  if (error instanceof ModelProviderError) return error;
  if (error instanceof Anthropic.AuthenticationError) {
    return new ModelProviderError('unauthorized', 'Anthropic did not accept the API key.', 401);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ModelProviderError('rate_limited', 'Anthropic is rate limiting requests.', 429);
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ModelProviderError('timeout', 'Anthropic did not answer in time.');
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ModelProviderError('unavailable', 'Could not reach Anthropic.');
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new ModelProviderError('unavailable', `Anthropic had a server problem (HTTP ${error.status ?? 500}).`, error.status ?? 500);
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? null;
    if (status !== null && status >= 500) {
      return new ModelProviderError('unavailable', `Anthropic had a server problem (HTTP ${status}).`, status);
    }
    const body = isRecord(error.error) ? error.error : null;
    const inner = body && isRecord(body.error) ? body.error : body;
    const detail = inner && typeof inner.message === 'string' ? inner.message.trim() : '';
    const reason = detail ? `: ${scrub(detail, apiKey).slice(0, 300)}` : '';
    return new ModelProviderError('rejected', `Anthropic rejected the request${status ? ` (HTTP ${status})` : ''}${reason}`, status);
  }
  return new ModelProviderError('bad_response', 'Something went wrong while talking to Anthropic.');
}

// The parts of a message response this adapter reads.
interface ProviderMessage {
  content: BetaContentBlock[];
  stop_reason: string | null;
  stop_details?: unknown;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

function usageOf(response: ProviderMessage): ModelUsage {
  return {
    inputTokens: Number(response.usage.input_tokens) || 0,
    outputTokens: Number(response.usage.output_tokens) || 0,
    cacheReadTokens: Number(response.usage.cache_read_input_tokens ?? 0) || 0,
    cacheCreationTokens: Number(response.usage.cache_creation_input_tokens ?? 0) || 0,
  };
}

function refusalOf(response: ProviderMessage): Refusal {
  const details = isRecord(response.stop_details) ? response.stop_details : {};
  return {
    category: typeof details.category === 'string' ? details.category : null,
    explanation: typeof details.explanation === 'string' ? details.explanation : null,
  };
}

function textOf(content: BetaContentBlock[]): string {
  return content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
}

export function createAnthropicProvider(apiKey: string): ModelProvider {
  const client = new Anthropic({ apiKey, baseURL: anthropicBaseUrl(), maxRetries: anthropicMaxRetries() });

  // Every message call asks for server side fallbacks. A server that rejects those fields gets one retry
  // without them, and the choice is remembered so later calls skip the extra request.
  async function createMessage(
    params: Record<string, unknown>,
    timeout: number,
    options: { maxRetries?: number } = {},
  ): Promise<ProviderMessage> {
    const model = String(params.model);
    const send = async (extra: Record<string, unknown>): Promise<ProviderMessage> =>
      (await client.beta.messages.create({ ...params, ...extra } as unknown as Parameters<typeof client.beta.messages.create>[0], {
        timeout,
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      })) as unknown as ProviderMessage;
    try {
      if (fallbacksRejected.has(model)) return await send({});
      try {
        return await send({ betas: [fallbackBeta], fallbacks: 'default' });
      } catch (error) {
        if (!(error instanceof Anthropic.BadRequestError)) throw error;
        const retried = await send({});
        fallbacksRejected.add(model);
        return retried;
      }
    } catch (error) {
      throw mapError(error, apiKey);
    }
  }

  const system = (text: string) => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];

  return {
    async validateKey() {
      try {
        await client.models.list({}, { timeout: anthropicKeyCheckTimeoutMilliseconds });
      } catch (error) {
        throw mapError(error, apiKey);
      }
    },

    async chat(request) {
      const messages: BetaMessageParam[] = request.messages.map((turn) => ({ role: turn.role, content: turn.text }));
      const tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        strict: true,
        input_schema: tool.inputSchema,
      }));
      let usage = emptyUsage;
      let toolRounds = 0;
      let lastText = '';
      for (;;) {
        const response = await createMessage(
          {
            model: request.model,
            max_tokens: chatMaxTokens,
            system: system(request.system),
            messages,
            tools,
            output_config: { effort: 'low' },
          },
          anthropicChatTimeoutMilliseconds,
        );
        const callUsage = usageOf(response);
        usage = addUsage(usage, callUsage);
        request.onCall?.({ provider: 'anthropic', model: request.model, usage: callUsage });

        if (response.stop_reason === 'refusal') {
          return { text: lastText, usage, refusal: refusalOf(response), toolRounds, hitToolLimit: false, cutOff: false };
        }
        const text = textOf(response.content);
        if (text) lastText = text;
        const toolUses = response.content.flatMap((block) => (block.type === 'tool_use' ? [block] : []));
        if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
          return {
            text: lastText,
            usage,
            refusal: null,
            toolRounds,
            hitToolLimit: false,
            cutOff: response.stop_reason === 'max_tokens',
          };
        }
        if (toolRounds >= request.maxToolRounds) {
          return { text: lastText, usage, refusal: null, toolRounds, hitToolLimit: true, cutOff: false };
        }
        toolRounds += 1;

        // All results go back in one user message. Thinking blocks stay in the assistant turn as sent.
        const results: BetaToolResultBlockParam[] = [];
        for (const block of toolUses) {
          const input = isRecord(block.input) ? block.input : {};
          try {
            const outcome = await request.runTool({ id: block.id, name: block.name, input });
            results.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: outcome.content,
              ...(outcome.isError ? { is_error: true } : {}),
            });
          } catch {
            results.push({ type: 'tool_result', tool_use_id: block.id, content: 'The tool failed.', is_error: true });
          }
        }
        messages.push({ role: 'assistant', content: response.content as unknown as Extract<BetaMessageParam['content'], unknown[]> });
        messages.push({ role: 'user', content: results });
      }
    },

    async draft(request) {
      const response = await createMessage(
        {
          model: request.model,
          max_tokens: draftMaxTokens,
          system: system(request.system),
          messages: [{ role: 'user', content: request.prompt }],
          output_config: { effort: 'medium', format: { type: 'json_schema', schema: request.schema } },
        },
        anthropicDraftTimeoutMilliseconds,
        // The draft worker makes its own attempts per person, so the SDK does not stack more retries on top.
        { maxRetries: 0 },
      );
      const usage = usageOf(response);
      request.onCall?.({ provider: 'anthropic', model: request.model, usage });
      if (response.stop_reason === 'refusal') return { status: 'refused', refusal: refusalOf(response), usage };
      if (response.stop_reason === 'max_tokens') {
        throw new ModelProviderError('bad_response', 'Anthropic cut the draft off before it was complete.');
      }
      const text = textOf(response.content);
      try {
        return { status: 'ok', output: JSON.parse(text) as unknown, usage };
      } catch {
        throw new ModelProviderError('bad_response', 'Anthropic sent a draft that is not valid JSON.');
      }
    },
  };
}
