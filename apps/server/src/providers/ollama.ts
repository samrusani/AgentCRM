import { modelChatTimeoutMilliseconds, modelDraftTimeoutMilliseconds, modelKeyCheckTimeoutMilliseconds } from '../config.js';
import {
  addUsage,
  type ChatToolCall,
  emptyUsage,
  isRecord,
  ModelProviderError,
  type ModelProvider,
  type ModelUsage,
} from './modelTypes.js';

const chatMaxTokens = 6000;
const draftMaxTokens = 12000;
// Ollama's own default window is small enough to cut off record data silently, so every request asks for more.
const contextTokens = 8192;

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

export interface OllamaProvider extends ModelProvider {
  listModels(): Promise<OllamaModelInfo[]>;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function usageOf(response: Record<string, unknown>): ModelUsage {
  return {
    inputTokens: numberOf(response.prompt_eval_count),
    outputTokens: numberOf(response.eval_count),
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

// A model that cannot take tools says so, for example "does not support tools". A missing model (HTTP 404) or any
// other rejection that merely mentions tools must not trigger the retry without them.
const toolsRejectedPattern = /\b(?:does not|doesn't|do not|don't) support tools?\b|\btools? (?:is |are |calling is |use is )?not supported\b/i;

function rejectsTools(error: unknown): boolean {
  return error instanceof ModelProviderError && error.kind === 'rejected' && error.status !== 404 && toolsRejectedPattern.test(error.message);
}

export function createOllamaProvider(baseUrl: string): OllamaProvider {
  const label = 'Ollama';

  async function send(method: 'GET' | 'POST', pathname: string, timeoutMilliseconds: number, body?: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const init: RequestInit = { method, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMilliseconds) };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${pathname}`, init);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new ModelProviderError('timeout', 'The Ollama server did not answer in time.');
      throw new ModelProviderError('unavailable', 'Could not reach the Ollama server at the configured address.');
    }
    if (response.status >= 500) {
      throw new ModelProviderError('unavailable', `The Ollama server had a problem (HTTP ${response.status}).`, response.status);
    }
    if (!response.ok) {
      let detail = '';
      try {
        const parsed = (await response.json()) as unknown;
        if (isRecord(parsed) && typeof parsed.error === 'string' && parsed.error.trim() !== '') detail = `: ${parsed.error.trim().slice(0, 300)}`;
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

  async function listModels(timeoutMilliseconds = modelKeyCheckTimeoutMilliseconds): Promise<OllamaModelInfo[]> {
    const response = await send('GET', '/api/tags', timeoutMilliseconds);
    if (!Array.isArray(response.models)) throw new ModelProviderError('bad_response', `${label} sent a model list this app could not read.`);
    return response.models.filter(isRecord).flatMap((entry) => {
      const name = typeof entry.name === 'string' ? entry.name : typeof entry.model === 'string' ? entry.model : '';
      if (name === '') return [];
      return [
        {
          name,
          sizeBytes: typeof entry.size === 'number' ? entry.size : null,
          modifiedAt: typeof entry.modified_at === 'string' ? entry.modified_at : null,
        },
      ];
    });
  }

  function replyMessage(response: Record<string, unknown>): Record<string, unknown> {
    if (!isRecord(response.message)) throw new ModelProviderError('bad_response', `${label} sent a response with no answer in it.`);
    return response.message;
  }

  return {
    listModels: () => listModels(),

    async validateKey() {
      await listModels();
    },

    async chat(request) {
      const messages: Record<string, unknown>[] = [
        { role: 'system', content: request.system },
        ...request.messages.map((turn) => ({ role: turn.role, content: turn.text })),
      ];
      let tools: unknown[] | undefined =
        request.tools.length > 0
          ? request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }))
          : undefined;
      let toolsUnavailable = false;
      let usage = emptyUsage;
      let toolRounds = 0;
      let lastText = '';
      for (;;) {
        const body = (): Record<string, unknown> => ({
          model: request.model,
          messages,
          ...(tools ? { tools } : {}),
          stream: false,
          options: { num_ctx: contextTokens, num_predict: chatMaxTokens },
        });
        let response: Record<string, unknown>;
        try {
          response = await send('POST', '/api/chat', modelChatTimeoutMilliseconds, body());
        } catch (error) {
          if (!tools || !rejectsTools(error)) throw error;
          // The model cannot take tools. Ask again without them, with a prompt that does not promise lookups.
          tools = undefined;
          toolsUnavailable = true;
          if (request.systemWithoutTools) messages[0] = { role: 'system', content: request.systemWithoutTools };
          response = await send('POST', '/api/chat', modelChatTimeoutMilliseconds, body());
        }
        const callUsage = usageOf(response);
        usage = addUsage(usage, callUsage);
        request.onCall?.({ provider: 'ollama', model: request.model, usage: callUsage });

        const message = replyMessage(response);
        const text = typeof message.content === 'string' ? message.content.trim() : '';
        if (text) lastText = text;
        const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
        const done = {
          text: lastText,
          usage,
          refusal: null,
          hitToolLimit: false,
          cutOff: response.done_reason === 'length',
          // Only an answer written without any lookups says so. After earlier tool rounds it did use them.
          ...(toolsUnavailable && !tools && toolRounds === 0 ? { toolsUnavailable: true } : {}),
        };
        if (rawCalls.length === 0 || !tools) return { ...done, toolRounds };
        if (toolRounds >= request.maxToolRounds) return { ...done, toolRounds, hitToolLimit: true, cutOff: false };
        toolRounds += 1;

        const calls: ChatToolCall[] = rawCalls.map((raw, index) => {
          const fn = isRecord(raw.function) ? raw.function : {};
          let input: Record<string, unknown> = {};
          if (isRecord(fn.arguments)) input = fn.arguments;
          else if (typeof fn.arguments === 'string') {
            try {
              const parsed = JSON.parse(fn.arguments) as unknown;
              if (isRecord(parsed)) input = parsed;
            } catch {
              input = {};
            }
          }
          return { id: `call_${toolRounds}_${index + 1}`, name: typeof fn.name === 'string' ? fn.name : '', input };
        });
        messages.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : '', tool_calls: rawCalls });
        for (const call of calls) {
          let content: string;
          try {
            content = (await request.runTool(call)).content;
          } catch {
            content = 'The tool failed.';
          }
          messages.push({ role: 'tool', tool_name: call.name, content });
        }
      }
    },

    async draft(request) {
      const response = await send('POST', '/api/chat', modelDraftTimeoutMilliseconds, {
        model: request.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: `${request.prompt}\n\nReply with one json object that matches the requested schema and nothing else.` },
        ],
        format: request.schema,
        stream: false,
        options: { num_ctx: contextTokens, num_predict: draftMaxTokens },
      });
      const usage = usageOf(response);
      request.onCall?.({ provider: 'ollama', model: request.model, usage });
      if (response.done_reason === 'length') throw new ModelProviderError('bad_response', `${label} cut the draft off before it was complete.`);
      const message = replyMessage(response);
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      if (text === '') throw new ModelProviderError('bad_response', `${label} sent an empty draft.`);
      try {
        return { status: 'ok', output: JSON.parse(text) as unknown, usage };
      } catch {
        throw new ModelProviderError('bad_response', `${label} sent a draft that is not valid JSON.`);
      }
    },
  };
}
