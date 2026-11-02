import {
  modelChatTimeoutMilliseconds,
  modelDraftTimeoutMilliseconds,
  modelKeyCheckTimeoutMilliseconds,
  providerBaseUrl,
} from '../config.js';
import {
  addUsage,
  type ChatToolCall,
  type ChatToolDefinition,
  emptyUsage,
  isRecord,
  type ModelProvider,
  ModelProviderError,
  type ModelUsage,
  type Refusal,
} from './modelTypes.js';
import type { CompatiblePreset } from './presets.js';

const chatMaxTokens = 6000;
const draftMaxTokens = 12000;

export function compatibleBaseUrl(preset: CompatiblePreset): string {
  return providerBaseUrl(preset.baseUrlEnvironmentName, preset.defaultBaseUrl);
}

function scrub(message: string, apiKey: string): string {
  return apiKey.length > 0 ? message.replaceAll(apiKey, '[removed]') : message;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

// Prompt tokens include the cached ones here, so cached tokens are split out to price them separately.
function usageOf(response: Record<string, unknown>): ModelUsage {
  const usage = isRecord(response.usage) ? response.usage : {};
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const prompt = numberOf(usage.prompt_tokens);
  const cached = Math.min(prompt, numberOf(details.cached_tokens) || numberOf(usage.prompt_cache_hit_tokens));
  return { inputTokens: prompt - cached, outputTokens: numberOf(usage.completion_tokens), cacheReadTokens: cached, cacheCreationTokens: 0 };
}

// Strict schemas need every property listed in required, so optional ones become required and nullable.
export function toStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (!isRecord(schema)) return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    result[key] = key === 'properties' && isRecord(value) ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, toStrictSchema(entry)])) : toStrictSchema(value);
  }
  if (isRecord(result.properties)) {
    const required = new Set(Array.isArray(result.required) ? (result.required as string[]) : []);
    const properties = result.properties as Record<string, Record<string, unknown>>;
    for (const [name, property] of Object.entries(properties)) {
      if (required.has(name) || !isRecord(property)) continue;
      const type = property.type;
      properties[name] = {
        ...property,
        ...(typeof type === 'string' ? { type: [type, 'null'] } : {}),
        ...(Array.isArray(property.enum) ? { enum: [...property.enum, null] } : {}),
      };
    }
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }
  return result;
}

function withoutNulls(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null));
}

function parseArguments(value: unknown, mayBeObject: boolean): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value.trim() === '' ? '{}' : value) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return mayBeObject && isRecord(value) ? value : {};
}

interface ToolCallMessage {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export function createOpenAiCompatibleProvider(preset: CompatiblePreset, apiKey: string): ModelProvider {
  const { label, quirks } = preset;

  async function send(method: 'GET' | 'POST', pathname: string, timeoutMilliseconds: number, body?: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, accept: 'application/json' };
    const init: RequestInit = { method, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMilliseconds) };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetch(`${compatibleBaseUrl(preset)}${pathname}`, init);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new ModelProviderError('timeout', `${label} did not answer in time.`);
      throw new ModelProviderError('unavailable', `Could not reach ${label}.`);
    }
    if (response.status === 401) throw new ModelProviderError('unauthorized', `${label} did not accept the API key.`, 401);
    if (response.status === 429) throw new ModelProviderError('rate_limited', `${label} is rate limiting requests.`, 429);
    if (response.status >= 500) {
      throw new ModelProviderError('unavailable', `${label} had a server problem (HTTP ${response.status}).`, response.status);
    }
    if (!response.ok) {
      let detail = '';
      try {
        const parsed = (await response.json()) as unknown;
        const inner = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : isRecord(parsed) ? parsed : null;
        if (inner && typeof inner.message === 'string' && inner.message.trim() !== '') detail = `: ${scrub(inner.message.trim(), apiKey).slice(0, 300)}`;
      } catch {
        detail = '';
      }
      throw new ModelProviderError('rejected', `${label} rejected the request (HTTP ${response.status})${detail}`, response.status);
    }
    try {
      const parsed = (await response.json()) as unknown;
      if (!isRecord(parsed)) throw new Error('not an object');
      return parsed;
    } catch {
      throw new ModelProviderError('bad_response', `${label} sent a response this app could not read.`);
    }
  }

  function firstChoice(response: Record<string, unknown>): { message: Record<string, unknown>; finishReason: string | null } {
    const choice = Array.isArray(response.choices) && isRecord(response.choices[0]) ? response.choices[0] : null;
    const message = choice && isRecord(choice.message) ? choice.message : null;
    if (!choice || !message) throw new ModelProviderError('bad_response', `${label} sent a response with no answer in it.`);
    return { message, finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null };
  }

  function contentOf(message: Record<string, unknown>): string {
    return typeof message.content === 'string' ? message.content.trim() : '';
  }

  function refusalOf(message: Record<string, unknown>, finishReason: string | null): Refusal | null {
    if (typeof message.refusal === 'string' && message.refusal.trim() !== '') {
      return { category: 'refusal', explanation: scrub(message.refusal.trim(), apiKey).slice(0, 300) };
    }
    if (finishReason === 'content_filter' || finishReason === 'sensitive') {
      return { category: 'content_filter', explanation: `${label} blocked this answer.` };
    }
    return null;
  }

  function limits(max: number): Record<string, unknown> {
    return {
      [quirks.maxCompletionTokensField]: max,
      ...(quirks.reasoningEffortLow ? { reasoning_effort: 'low' } : {}),
    };
  }

  function toolDefinition(tool: ChatToolDefinition) {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: preset.strictTools ? toStrictSchema(tool.inputSchema) : tool.inputSchema,
        ...(preset.strictTools ? { strict: true } : {}),
      },
    };
  }

  // The prompt must say json and carry the schema as text, because json_object mode only guarantees valid json.
  function jsonObjectPrompt(prompt: string, schema: Record<string, unknown>): string {
    return [
      prompt,
      '',
      'Reply with one json object and nothing else. The json object must match this JSON schema:',
      JSON.stringify(schema, null, 2),
    ].join('\n');
  }

  return {
    async validateKey() {
      if (preset.keyCheck.method === 'models') {
        await send('GET', '/models', modelKeyCheckTimeoutMilliseconds);
        return;
      }
      await send('POST', '/chat/completions', modelKeyCheckTimeoutMilliseconds, {
        model: preset.keyCheck.model,
        messages: [{ role: 'user', content: 'Reply with the word ok.' }],
        max_tokens: 1,
      });
    },

    async chat(request) {
      const messages: Record<string, unknown>[] = [
        { role: 'system', content: request.system },
        ...request.messages.map((turn) => ({ role: turn.role, content: turn.text })),
      ];
      const tools = request.tools.map(toolDefinition);
      let usage = emptyUsage;
      let toolRounds = 0;
      let lastText = '';
      for (;;) {
        const response = await send('POST', '/chat/completions', modelChatTimeoutMilliseconds, {
          model: request.model,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          ...limits(chatMaxTokens),
        });
        const callUsage = usageOf(response);
        usage = addUsage(usage, callUsage);
        request.onCall?.({ provider: preset.kind, model: request.model, usage: callUsage });

        const { message, finishReason } = firstChoice(response);
        const refusal = refusalOf(message, finishReason);
        if (refusal) return { text: lastText, usage, refusal, toolRounds, hitToolLimit: false, cutOff: false };
        const text = contentOf(message);
        if (text) lastText = text;
        const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
        if (rawCalls.length === 0) {
          return { text: lastText, usage, refusal: null, toolRounds, hitToolLimit: false, cutOff: finishReason === 'length' };
        }
        if (toolRounds >= request.maxToolRounds) {
          return { text: lastText, usage, refusal: null, toolRounds, hitToolLimit: true, cutOff: false };
        }
        toolRounds += 1;

        const calls: ChatToolCall[] = rawCalls.map((raw, index) => {
          const fn = isRecord(raw.function) ? raw.function : {};
          const parsed = parseArguments(fn.arguments, quirks.argumentsMayBeObject);
          return {
            id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `call_${toolRounds}_${index + 1}`,
            name: typeof fn.name === 'string' ? fn.name : '',
            input: preset.strictTools ? withoutNulls(parsed) : parsed,
          };
        });
        // The assistant turn goes back with arguments as strings, whichever form the provider used.
        const echoed: ToolCallMessage[] = calls.map((call, index) => {
          const raw = rawCalls[index]!;
          const original = isRecord(raw.function) ? raw.function.arguments : undefined;
          return {
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: typeof original === 'string' ? original : JSON.stringify(call.input) },
          };
        });
        messages.push({
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : null,
          ...(typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : {}),
          tool_calls: echoed,
        });
        for (const call of calls) {
          let content: string;
          try {
            content = (await request.runTool(call)).content;
          } catch {
            content = 'The tool failed.';
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
      }
    },

    async draft(request) {
      const jsonSchemaMode = preset.jsonMode === 'json_schema';
      const body = {
        model: request.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: jsonSchemaMode ? request.prompt : jsonObjectPrompt(request.prompt, request.schema) },
        ],
        response_format: jsonSchemaMode
          ? { type: 'json_schema', json_schema: { name: 'draft', schema: toStrictSchema(request.schema), strict: true } }
          : { type: 'json_object' },
        ...limits(draftMaxTokens),
      };
      let total = emptyUsage;
      // DeepSeek can answer a json_object request with blank content. One more try, then the failure path.
      const attempts = quirks.blankJsonRetry ? 2 : 1;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const response = await send('POST', '/chat/completions', modelDraftTimeoutMilliseconds, body);
        const usage = usageOf(response);
        total = addUsage(total, usage);
        request.onCall?.({ provider: preset.kind, model: request.model, usage });
        const { message, finishReason } = firstChoice(response);
        const refusal = refusalOf(message, finishReason);
        if (refusal) return { status: 'refused', refusal, usage: total };
        if (finishReason === 'length') throw new ModelProviderError('bad_response', `${label} cut the draft off before it was complete.`);
        const text = contentOf(message);
        if (text === '') {
          if (attempt < attempts) continue;
          throw new ModelProviderError('bad_response', `${label} sent an empty draft.`);
        }
        try {
          return { status: 'ok', output: JSON.parse(text) as unknown, usage: total };
        } catch {
          // json_object mode only promises json. A reply that is not json goes to the caller as text so it can ask again.
          if (!jsonSchemaMode) return { status: 'ok', output: text, usage: total };
          throw new ModelProviderError('bad_response', `${label} sent a draft that is not valid JSON.`);
        }
      }
      throw new ModelProviderError('bad_response', `${label} sent an empty draft.`);
    },
  };
}
