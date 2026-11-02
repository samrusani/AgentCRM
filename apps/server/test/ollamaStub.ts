import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OllamaReply {
  status: number;
  body: unknown;
}

export type OllamaResponder = (body: any, call: number) => OllamaReply;

export interface OllamaStubState {
  models: string[];
  tagsCalls: number;
  chatCalls: number;
  chatBodies: any[];
  authHeaders: (string | undefined)[];
  paths: string[];
  script: OllamaResponder[];
  fallback: OllamaResponder;
  // Answers 400 "does not support tools" to any chat request that carries tools, as a model without tool support would.
  rejectTools: boolean;
}

export interface OllamaStub {
  url: string;
  state: OllamaStubState;
  reset: () => void;
  close: () => Promise<void>;
}

export interface OllamaCounts {
  prompt_eval_count: number;
  eval_count: number;
}

export const defaultOllamaCounts: OllamaCounts = { prompt_eval_count: 800, eval_count: 150 };

function chatBody(message: Record<string, unknown>, counts: OllamaCounts, doneReason = 'stop') {
  return { model: 'stub', created_at: '2026-11-02T00:00:00Z', message: { role: 'assistant', ...message }, done: true, done_reason: doneReason, ...counts };
}

export function ollamaText(text: string, counts: OllamaCounts = defaultOllamaCounts): OllamaReply {
  return { status: 200, body: chatBody({ content: text }, counts) };
}

// Ollama sends tool arguments as objects.
export function ollamaToolCalls(calls: { name: string; input: Record<string, unknown> }[], counts: OllamaCounts = defaultOllamaCounts): OllamaReply {
  return {
    status: 200,
    body: chatBody({ content: '', tool_calls: calls.map((call) => ({ function: { name: call.name, arguments: call.input } })) }, counts),
  };
}

export function ollamaError(status: number, message: string): OllamaReply {
  return { status, body: { error: message } };
}

function freshState(): OllamaStubState {
  return {
    models: ['llama-stub:8b', 'qwen-stub:4b'],
    tagsCalls: 0,
    chatCalls: 0,
    chatBodies: [],
    authHeaders: [],
    paths: [],
    script: [],
    fallback: () => ollamaText('Stub reply.'),
    rejectTools: false,
  };
}

function send(response: http.ServerResponse, reply: OllamaReply): void {
  response.writeHead(reply.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(reply.body));
}

export async function startOllamaStub(): Promise<OllamaStub> {
  const state = freshState();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub.local');
    state.authHeaders.push(request.headers.authorization);
    state.paths.push(`${request.method} ${url.pathname}`);
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'GET' && url.pathname === '/api/tags') {
        state.tagsCalls += 1;
        return send(response, {
          status: 200,
          body: { models: state.models.map((name) => ({ name, model: name, size: 4_000_000_000, modified_at: '2026-10-01T00:00:00Z' })) },
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/chat') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as Record<string, any>;
        if (state.rejectTools && body.tools !== undefined) {
          return send(response, ollamaError(400, `registry.ollama.ai/library/${body.model} does not support tools`));
        }
        state.chatCalls += 1;
        state.chatBodies.push(body);
        const responder = state.script.shift() ?? state.fallback;
        return send(response, responder(body, state.chatCalls));
      }
      return send(response, ollamaError(404, 'No such route.'));
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

export function ollamaDraftFor(body: any, counts: OllamaCounts = defaultOllamaCounts): OllamaReply {
  const user = (body?.messages ?? []).find((message: any) => message.role === 'user');
  const match = /<record>\n([\s\S]*?)\n<\/record>/.exec(String(user?.content ?? ''));
  const person = match ? (JSON.parse(match[1]!) as { person: { name: string; firstName: string } }).person : { name: '', firstName: '' };
  return ollamaText(
    JSON.stringify({
      subject: `Hello ${person.firstName}`,
      body: `Hi ${person.firstName}, this is a draft written for ${person.name}.`,
      factsUsed: [{ field: 'name', value: person.name }],
    }),
    counts,
  );
}
