import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type CompatKind = 'openai' | 'deepseek' | 'zai';

export interface CompatReply {
  status: number;
  body: unknown;
}

export type CompatResponder = (body: any, call: number) => CompatReply;

export interface CompatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

export interface CompatStubState {
  apiKey: string;
  // Requests to the chat completions route that are not key checks.
  chatCalls: number;
  chatBodies: any[];
  modelsCalls: number;
  // One token completions sent to check a key (zai).
  keyCheckCalls: number;
  authHeaders: string[];
  paths: string[];
  script: CompatResponder[];
  fallback: CompatResponder;
}

export interface CompatStub {
  kind: CompatKind;
  // The value for the preset's base URL environment variable.
  base: string;
  state: CompatStubState;
  reset: () => void;
  close: () => Promise<void>;
}

const prefixes: Record<CompatKind, string> = { openai: '/v1', deepseek: '', zai: '/api/paas/v4' };
const environmentNames: Record<CompatKind, string> = {
  openai: 'AGENTCRM_OPENAI_BASE',
  deepseek: 'AGENTCRM_DEEPSEEK_BASE',
  zai: 'AGENTCRM_ZAI_BASE',
};
const modelIds: Record<CompatKind, string> = { openai: 'gpt-5.6-terra', deepseek: 'deepseek-flash', zai: 'glm-5.3' };

export const compatKeys: Record<CompatKind, string> = {
  openai: 'sk-openai-testkey-ab12',
  deepseek: 'sk-deepseek-testkey-cd34',
  zai: 'zai-testkey-ef56.suffix',
};

export const defaultCompatUsage: CompatUsage = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 0 } };

function completion(message: Record<string, unknown>, finishReason: string, usage: CompatUsage) {
  return {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    model: 'stub',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }],
    usage,
  };
}

export function textReply(text: string, usage: CompatUsage = defaultCompatUsage): CompatReply {
  return { status: 200, body: completion({ content: text }, 'stop', usage) };
}

export interface StubCall {
  name: string;
  input: Record<string, unknown>;
}

// A tool call answer. Arguments go out as JSON strings, or as objects when argsAs is "object" (the Z.ai quirk).
export function toolCallsReply(calls: StubCall[], options: { argsAs?: 'string' | 'object'; usage?: CompatUsage; text?: string } = {}): CompatReply {
  const tool_calls = calls.map((call, index) => ({
    id: `call_${index + 1}`,
    type: 'function',
    function: { name: call.name, arguments: options.argsAs === 'object' ? call.input : JSON.stringify(call.input) },
  }));
  return { status: 200, body: completion({ content: options.text ?? null, tool_calls }, 'tool_calls', options.usage ?? defaultCompatUsage) };
}

export function jsonReply(output: unknown, usage: CompatUsage = defaultCompatUsage): CompatReply {
  return textReply(typeof output === 'string' ? output : JSON.stringify(output), usage);
}

// The DeepSeek quirk: json_object mode can answer with nothing but spaces.
export function blankReply(usage: CompatUsage = defaultCompatUsage): CompatReply {
  return textReply('  \n ', usage);
}

export function refusalReply(usage: CompatUsage = defaultCompatUsage): CompatReply {
  return { status: 200, body: completion({ content: null, refusal: 'I cannot help with that.' }, 'stop', usage) };
}

export function errorReply(status: number, message = 'Stub failure.'): CompatReply {
  return { status, body: { error: { message, type: 'stub_error', code: String(status) } } };
}

function freshState(kind: CompatKind): CompatStubState {
  return {
    apiKey: compatKeys[kind],
    chatCalls: 0,
    chatBodies: [],
    modelsCalls: 0,
    keyCheckCalls: 0,
    authHeaders: [],
    paths: [],
    script: [],
    fallback: () => textReply('Stub reply.'),
  };
}

function send(response: http.ServerResponse, reply: CompatReply): void {
  response.writeHead(reply.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(reply.body));
}

export async function startCompatStub(kind: CompatKind): Promise<CompatStub> {
  const state = freshState(kind);
  const prefix = prefixes[kind];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub.local');
    const bearer = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ''));
    const key = bearer ? bearer[1]! : '';
    state.authHeaders.push(key);
    state.paths.push(`${request.method} ${url.pathname}`);
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (key !== state.apiKey) return send(response, errorReply(401, 'Incorrect API key provided.'));
      if (request.method === 'GET' && url.pathname === `${prefix}/models`) {
        state.modelsCalls += 1;
        return send(response, { status: 200, body: { object: 'list', data: [{ id: modelIds[kind], object: 'model' }] } });
      }
      if (request.method === 'POST' && url.pathname === `${prefix}/chat/completions`) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as Record<string, any>;
        if (body.max_tokens === 1 && body.model === 'glm-4.7-flash') {
          state.keyCheckCalls += 1;
          return send(response, textReply('o', { prompt_tokens: 5, completion_tokens: 1 }));
        }
        state.chatCalls += 1;
        state.chatBodies.push(body);
        const responder = state.script.shift() ?? state.fallback;
        return send(response, responder(body, state.chatCalls));
      }
      return send(response, errorReply(404, 'No such route.'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    kind,
    base: `http://127.0.0.1:${port}${prefix}`,
    state,
    reset: () => Object.assign(state, freshState(kind)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function useCompatStub(stub: CompatStub): () => void {
  const name = environmentNames[stub.kind];
  const previous = process.env[name];
  process.env[name] = stub.base;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

// Pulls the person out of a draft prompt. The record sits between tags, in the user message.
export function recordFromCompatPrompt(body: any): { name: string; firstName: string; email: string } {
  const user = (body?.messages ?? []).find((message: any) => message.role === 'user');
  const match = /<record>\n([\s\S]*?)\n<\/record>/.exec(String(user?.content ?? ''));
  const record = match ? (JSON.parse(match[1]!) as { person: { name: string; firstName: string; email: string } }) : null;
  return record ? record.person : { name: '', firstName: '', email: '' };
}

export function compatDraftFor(body: any, usage: CompatUsage = defaultCompatUsage): CompatReply {
  const person = recordFromCompatPrompt(body);
  return jsonReply(
    {
      subject: `Hello ${person.firstName}`,
      body: `Hi ${person.firstName}, this is a draft written for ${person.name}.`,
      factsUsed: [{ field: 'name', value: person.name }],
    },
    usage,
  );
}
