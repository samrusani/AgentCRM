import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface StubReply {
  status: number;
  body: unknown;
}

// Decides the answer for one messages request. `call` counts from 1.
export type Responder = (body: any, call: number) => StubReply;

export interface AnthropicStubState {
  apiKey: string;
  messageCalls: number;
  // Requests answered 400 because they carried the fallbacks field and rejectFallbacks is on.
  fallbackRejections: number;
  modelsCalls: number;
  messageBodies: any[];
  messageHeaders: http.IncomingHttpHeaders[];
  authHeaders: string[];
  paths: string[];
  // Replies used once each, in order, before the fallback responder.
  script: Responder[];
  fallback: Responder;
  // Answers 400 to any request that carries the fallbacks field, as a server that does not know it would.
  rejectFallbacks: boolean;
  // Same, but only for requests naming one of these models.
  rejectFallbackModels: string[];
}

export interface AnthropicStub {
  url: string;
  state: AnthropicStubState;
  reset: () => void;
  close: () => Promise<void>;
}

export const stubApiKey = 'sk-ant-testkey-abcd1234';

export const defaultUsage: StubUsage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0 };

function message(content: unknown[], stopReason: string, usage: StubUsage, extra: Record<string, unknown> = {}) {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
    ...extra,
  };
}

export function textReply(text: string, usage: StubUsage = defaultUsage): StubReply {
  return { status: 200, body: message([{ type: 'text', text }], 'end_turn', usage) };
}

export interface StubToolUse {
  name: string;
  input: Record<string, unknown>;
}

// A tool_use answer. It carries a thinking block first, as models with thinking on do.
export function toolUseReply(tools: StubToolUse[], usage: StubUsage = defaultUsage, text?: string): StubReply {
  const content: unknown[] = [{ type: 'thinking', thinking: 'Deciding which tool to use.', signature: 'stub-signature' }];
  if (text) content.push({ type: 'text', text });
  tools.forEach((tool, index) => {
    content.push({ type: 'tool_use', id: `toolu_${index + 1}`, name: tool.name, input: tool.input });
  });
  return { status: 200, body: message(content, 'tool_use', usage) };
}

export function jsonReply(output: unknown, usage: StubUsage = defaultUsage): StubReply {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return {
    status: 200,
    body: message([{ type: 'thinking', thinking: 'Planning the draft.', signature: 'stub-signature' }, { type: 'text', text }], 'end_turn', usage),
  };
}

export function refusalReply(category: string | null = 'general_harms', usage: StubUsage = defaultUsage): StubReply {
  return {
    status: 200,
    body: message([], 'refusal', usage, { stop_details: { type: 'refusal', category, explanation: 'The stub refused this request.' } }),
  };
}

export function errorReply(status: number, type = 'api_error', text = 'Stub failure.'): StubReply {
  return { status, body: { type: 'error', error: { type, message: text } } };
}

function freshState(): AnthropicStubState {
  return {
    apiKey: stubApiKey,
    messageCalls: 0,
    fallbackRejections: 0,
    modelsCalls: 0,
    messageBodies: [],
    messageHeaders: [],
    authHeaders: [],
    paths: [],
    script: [],
    fallback: () => textReply('Stub reply.'),
    rejectFallbacks: false,
    rejectFallbackModels: [],
  };
}

function send(response: http.ServerResponse, reply: StubReply): void {
  response.writeHead(reply.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(reply.body));
}

export async function startAnthropicStub(): Promise<AnthropicStub> {
  const state = freshState();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub.local');
    // SDK 1.x sends the key as a bearer token. Older SDKs sent x-api-key. The stub accepts both.
    const bearer = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ''));
    const key = bearer ? bearer[1]! : String(request.headers['x-api-key'] ?? '');
    state.authHeaders.push(key);
    state.paths.push(`${request.method} ${url.pathname}`);
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (key !== state.apiKey) {
        return send(response, errorReply(401, 'authentication_error', 'invalid x-api-key'));
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        state.modelsCalls += 1;
        return send(response, {
          status: 200,
          body: { data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: null, last_id: null },
        });
      }
      if (request.method === 'POST' && url.pathname === '/v1/messages') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as Record<string, unknown>;
        if ((state.rejectFallbacks || state.rejectFallbackModels.includes(String(body.model))) && body.fallbacks !== undefined) {
          state.fallbackRejections += 1;
          return send(response, errorReply(400, 'invalid_request_error', 'fallbacks: Extra inputs are not permitted'));
        }
        state.messageCalls += 1;
        state.messageBodies.push(body);
        state.messageHeaders.push(request.headers);
        const responder = state.script.shift() ?? state.fallback;
        return send(response, responder(body, state.messageCalls));
      }
      return send(response, errorReply(404, 'not_found_error', 'No such route.'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    reset: () => Object.assign(state, freshState()),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Points the provider at the stub and turns off the SDK's own retries so failures answer at once.
export function useAnthropicStub(stub: AnthropicStub, extra: Record<string, string> = {}): () => void {
  const names = ['AGENTCRM_ANTHROPIC_BASE', 'AGENTCRM_ANTHROPIC_RETRIES', ...Object.keys(extra)];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.AGENTCRM_ANTHROPIC_BASE = stub.url;
  process.env.AGENTCRM_ANTHROPIC_RETRIES = '0';
  Object.assign(process.env, extra);
  return () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  };
}

// Pulls the person's name out of a draft prompt so a responder can write a draft for that person.
export function recordFromPrompt(body: any): { name: string; firstName: string; email: string } {
  const content = String(body?.messages?.[0]?.content ?? '');
  const match = /<record>\n([\s\S]*)\n<\/record>/.exec(content);
  const record = match ? (JSON.parse(match[1]!) as { person: { name: string; firstName: string; email: string } }) : null;
  return record ? record.person : { name: '', firstName: '', email: '' };
}

export function draftFor(body: any, usage: StubUsage = defaultUsage): StubReply {
  const person = recordFromPrompt(body);
  return jsonReply(
    {
      subject: `Hello ${person.firstName}`,
      body: `Hi ${person.firstName}, this is a draft written for ${person.name}.`,
      factsUsed: [{ field: 'name', value: person.name }],
    },
    usage,
  );
}
