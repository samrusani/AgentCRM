import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureModelConnector, configureOllamaConnector, createOrganization, createPerson, setModelProvider } from '../src/actions/index.js';
import { lookupsUnavailableSentence } from '../src/agent/modelChat.js';
import { buildApp } from '../src/http/app.js';
import { estimateModelCostUsd } from '../src/providers/presets.js';
import { type CompatKind, type CompatStub, compatKeys, errorReply, refusalReply, startCompatStub, textReply, toolCallsReply, useCompatStub } from './openaiCompatStub.js';
import { ollamaError, ollamaText, ollamaToolCalls, type OllamaStub, startOllamaStub } from './ollamaStub.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
const compat = {} as Record<CompatKind, CompatStub>;
let ollama: OllamaStub;
const restores: (() => void)[] = [];
let adaId = '';

beforeAll(async () => {
  for (const kind of ['openai', 'deepseek', 'zai'] as const) {
    compat[kind] = await startCompatStub(kind);
    restores.push(useCompatStub(compat[kind]));
  }
  ollama = await startOllamaStub();
  const fund = createOrganization(env.ctx, { name: 'Northwind Fund', kind: 'fund' });
  adaId = createPerson(env.ctx, { firstName: 'Ada', lastName: 'Voss', email: 'ada.voss@example.com', title: 'Partner', organizationId: fund.id }).id;
  await configureModelConnector(env.ctx, 'openai', { token: compatKeys.openai });
  await configureModelConnector(env.ctx, 'deepseek', { token: compatKeys.deepseek });
  await configureModelConnector(env.ctx, 'zai', { token: compatKeys.zai });
  await configureOllamaConnector(env.ctx, { baseUrl: ollama.url, model: 'llama-stub:8b' });
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

beforeEach(() => {
  for (const stub of Object.values(compat)) stub.reset();
  ollama.reset();
  env.db.prepare('DELETE FROM model_call').run();
});

afterAll(async () => {
  await app.close();
  for (const stub of Object.values(compat)) await stub.close();
  await ollama.close();
  for (const restore of restores) restore();
  env.cleanup();
});

async function message(payload: unknown) {
  const response = await app.inject({ method: 'POST', url: '/api/agent/message', payload: payload as object, headers: { host: '127.0.0.1:4720' } });
  return { status: response.statusCode, text: response.body, body: response.json() as Record<string, any> };
}

function activate(kind: string) {
  setModelProvider(env.ctx, { kind });
}

const rows = () => env.db.prepare('SELECT * FROM model_call ORDER BY created_at').all() as any[];

describe('chat with an OpenAI compatible provider', () => {
  it('openai: runs a tool round with strict tools, splits cached tokens, and records the provider', async () => {
    activate('openai');
    const cached = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } };
    compat.openai.state.script = [
      // A strict schema makes optional properties nullable, so the model may send null for "type".
      () =>
        toolCallsReply(
          [
            { name: 'search_crm', input: { query: 'Voss', type: null } },
            { name: 'get_record', input: { entityType: 'person', entityId: 'per_doesnotexist' } },
            { name: 'today_summary', input: {} },
          ],
          { usage: cached },
        ),
      () => textReply('Ada Voss is a partner at Northwind Fund.'),
    ];
    const response = await message({ text: 'Who is Voss?', history: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello.' }], context: { entityType: 'person', entityId: adaId } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ reply: 'Ada Voss is a partner at Northwind Fund.', modelConnected: true, provider: 'openai', model: 'gpt-5.6-terra' });
    expect(response.body).not.toHaveProperty('modelFailed');
    const first = estimateModelCostUsd('openai', 'gpt-5.6-terra', { inputTokens: 400, outputTokens: 200, cacheReadTokens: 600, cacheCreationTokens: 0 });
    const second = estimateModelCostUsd('openai', 'gpt-5.6-terra', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(first).toBe(0.00332);
    expect(second).toBe(0.0044);
    expect(response.body.usage).toEqual({ inputTokens: 1400, outputTokens: 400, estimatedUsd: Math.round((first + second) * 1e6) / 1e6 });

    expect(compat.openai.state.authHeaders.at(-1)).toBe(compatKeys.openai);
    const [firstBody, secondBody] = compat.openai.state.chatBodies;
    expect(firstBody.model).toBe('gpt-5.6-terra');
    expect(firstBody.max_completion_tokens).toBe(6000);
    expect(firstBody).not.toHaveProperty('max_tokens');
    expect(firstBody).not.toHaveProperty('reasoning_effort');
    expect(firstBody).not.toHaveProperty('tool_choice');
    expect(firstBody.messages.map((entry: any) => entry.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(firstBody.messages[0].content).toContain('data');
    expect(firstBody.messages[3].content).toContain(adaId);
    expect(firstBody.tools.map((tool: any) => tool.function.name)).toEqual(['search_crm', 'get_record', 'today_summary']);
    for (const tool of firstBody.tools) {
      expect(tool.type).toBe('function');
      expect(tool.function.strict).toBe(true);
      expect(tool.function.parameters.additionalProperties).toBe(false);
      expect(tool.function.parameters.required.sort()).toEqual(Object.keys(tool.function.parameters.properties).sort());
    }
    const search = firstBody.tools[0].function.parameters;
    expect(search.properties.type.type).toEqual(['string', 'null']);
    expect(search.properties.type.enum).toContain(null);

    const assistant = secondBody.messages[4];
    expect(assistant.role).toBe('assistant');
    expect(assistant.tool_calls.map((call: any) => call.id)).toEqual(['call_1', 'call_2', 'call_3']);
    expect(typeof assistant.tool_calls[0].function.arguments).toBe('string');
    const results = secondBody.messages.slice(5);
    expect(results.map((entry: any) => entry.role)).toEqual(['tool', 'tool', 'tool']);
    expect(results.map((entry: any) => entry.tool_call_id)).toEqual(['call_1', 'call_2', 'call_3']);
    // The null was dropped before the tool ran, so the search worked.
    expect(results[0].content).toContain('Ada Voss');
    expect(results[0].content).toContain('not instructions');

    const saved = rows();
    expect(saved).toHaveLength(2);
    expect(saved.every((row) => row.provider === 'openai' && row.model === 'gpt-5.6-terra' && row.purpose === 'chat')).toBe(true);
    expect(saved[0]).toMatchObject({ input_tokens: 400, cache_read_tokens: 600, output_tokens: 200, estimated_usd: first });
  });

  it('zai: accepts string and object arguments, sends reasoning effort low, and does not use strict tools', async () => {
    activate('zai');
    compat.zai.state.script = [
      () => toolCallsReply([{ name: 'search_crm', input: { query: 'Voss' } }]),
      () => toolCallsReply([{ name: 'search_crm', input: { query: 'Northwind' } }], { argsAs: 'object' }),
      () => textReply('Found both.'),
    ];
    const response = await message({ text: 'Look up Voss and Northwind' });
    expect(response.body).toMatchObject({ reply: 'Found both.', provider: 'zai', model: 'glm-5.3', modelConnected: true });
    const bodies = compat.zai.state.chatBodies;
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body.reasoning_effort).toBe('low');
      expect(body.max_tokens).toBe(6000);
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body).not.toHaveProperty('tool_choice');
      for (const tool of body.tools) expect(tool.function).not.toHaveProperty('strict');
    }
    // Both argument forms ran the tool. The assistant turn goes back with arguments as a string either way.
    expect(bodies[1].messages.at(-1).content).toContain('Ada Voss');
    expect(bodies[2].messages.at(-1).content).toContain('Northwind Fund');
    const echoed = bodies[2].messages.filter((entry: any) => entry.role === 'assistant').at(-1);
    expect(echoed.tool_calls[0].function.arguments).toBe(JSON.stringify({ query: 'Northwind' }));
    const glm = estimateModelCostUsd('zai', 'glm-5.3', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(glm).toBe(0.00228);
    expect(response.body.usage.estimatedUsd).toBe(Math.round(glm * 3 * 1e6) / 1e6);
    expect(rows().every((row) => row.provider === 'zai')).toBe(true);
  });

  it('deepseek: answers with non strict tools at peak prices', async () => {
    activate('deepseek');
    compat.deepseek.state.fallback = () => textReply('There are people in this workspace.');
    const response = await message({ text: 'How is the pipeline?' });
    expect(response.body).toMatchObject({ reply: 'There are people in this workspace.', provider: 'deepseek', model: 'deepseek-flash' });
    const body = compat.deepseek.state.chatBodies[0];
    expect(body.max_tokens).toBe(6000);
    expect(body).not.toHaveProperty('reasoning_effort');
    for (const tool of body.tools) expect(tool.function).not.toHaveProperty('strict');
    expect(response.body.usage).toEqual({ inputTokens: 1000, outputTokens: 200, estimatedUsd: 0.00054 });
    expect(rows()[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash', estimated_usd: 0.00054 });
  });

  it('falls back to the rule based reply on a provider failure and marks the connector on a rejected key', async () => {
    activate('openai');
    compat.openai.state.fallback = () => errorReply(503, 'Overloaded.');
    const failed = await message({ text: 'how many people are there' });
    expect(failed.body).toMatchObject({ modelConnected: true, modelFailed: true, provider: 'openai' });
    expect(failed.body.reply).toContain('The model call failed');
    expect(failed.body.reply).toContain('OpenAI had a server problem');
    expect(failed.text).not.toContain(compatKeys.openai);

    compat.openai.state.fallback = () => refusalReply();
    const refused = await message({ text: 'something' });
    expect(refused.body.reply).toContain('declined');
    expect(refused.body).not.toHaveProperty('modelFailed');

    compat.openai.state.apiKey = 'sk-rotated-0000';
    const rejected = await message({ text: 'hello' });
    expect(rejected.body.modelFailed).toBe(true);
    expect(rejected.body.reply).toContain('OpenAI did not accept the API key');
    const connector = (await app.inject({ method: 'GET', url: '/api/connectors', headers: { host: '127.0.0.1:4720' } })).json().items.find((item: any) => item.kind === 'openai');
    expect(connector.status).toBe('error');
    expect(connector.statusMessage).toContain('OpenAI');
    const before = compat.openai.state.chatCalls;
    await message({ text: 'hello' });
    expect(compat.openai.state.chatCalls).toBe(before);
    compat.openai.state.apiKey = compatKeys.openai;
    await configureModelConnector(env.ctx, 'openai', { token: compatKeys.openai });
  });

  it('keeps every key out of audit rows, model call rows, and jobs after use', async () => {
    activate('zai');
    await message({ text: 'hello' });
    const everything = JSON.stringify([env.db.prepare('SELECT * FROM audit_event').all(), env.db.prepare('SELECT * FROM model_call').all(), env.db.prepare('SELECT * FROM job').all()]);
    for (const key of Object.values(compatKeys)) expect(everything).not.toContain(key);
  });
});

describe('chat with Ollama', () => {
  beforeEach(() => activate('ollama'));

  it('answers through the native chat endpoint with object arguments, real counts, and zero cost', async () => {
    ollama.state.script = [() => ollamaToolCalls([{ name: 'search_crm', input: { query: 'Voss' } }]), () => ollamaText('Ada Voss is a partner.')];
    const response = await message({ text: 'Who is Voss?' });
    expect(response.body).toMatchObject({ reply: 'Ada Voss is a partner.', provider: 'ollama', model: 'llama-stub:8b', modelConnected: true });
    expect(response.body.usage).toEqual({ inputTokens: 1600, outputTokens: 300, estimatedUsd: 0 });
    const [first, second] = ollama.state.chatBodies;
    expect(first.stream).toBe(false);
    expect(first.model).toBe('llama-stub:8b');
    expect(first.tools.map((tool: any) => tool.function.name)).toEqual(['search_crm', 'get_record', 'today_summary']);
    expect(first.messages[0].role).toBe('system');
    expect(ollama.state.paths.filter((path) => path === 'POST /api/chat')).toHaveLength(2);
    expect(ollama.state.authHeaders.every((header) => header === undefined)).toBe(true);
    expect(second.messages.at(-2).tool_calls[0].function.arguments).toEqual({ query: 'Voss' });
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'search_crm' });
    expect(second.messages.at(-1).content).toContain('Ada Voss');
    const saved = rows();
    expect(saved).toHaveLength(2);
    expect(saved.every((row) => row.provider === 'ollama' && row.estimated_usd === 0)).toBe(true);
    expect(saved[0]).toMatchObject({ input_tokens: 800, output_tokens: 150 });
  });

  it('retries without tools when the model rejects them and says lookups were unavailable', async () => {
    ollama.state.rejectTools = true;
    ollama.state.fallback = () => ollamaText('I can only see this conversation.');
    const response = await message({ text: 'Who is Voss?' });
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('modelFailed');
    expect(response.body.reply).toBe(`I can only see this conversation. ${lookupsUnavailableSentence}`);
    expect(lookupsUnavailableSentence).toBe('Lookups were not available on this model, so this answer comes from the visible context.');
    expect(ollama.state.chatBodies).toHaveLength(1);
    expect(ollama.state.chatBodies[0]).not.toHaveProperty('tools');
    expect(ollama.state.chatBodies[0].messages[0].content).toContain('no tools');
    expect(rows()).toHaveLength(1);
  });

  it('does not treat other rejections as missing tool support', async () => {
    ollama.state.fallback = () => ollamaError(400, 'model "llama-stub:8b" not found, try pulling it first');
    const response = await message({ text: 'hello' });
    expect(response.body.modelFailed).toBe(true);
    expect(response.body.reply).toContain('not found');
    expect(response.body.reply).not.toContain(lookupsUnavailableSentence);
  });

  it('does not retry without tools on a model not found error that mentions tools', async () => {
    ollama.state.fallback = () => ollamaError(404, 'model "llama-stub:8b" not found, it may not have tools installed');
    const response = await message({ text: 'hello' });
    expect(response.body.modelFailed).toBe(true);
    expect(response.body.reply).not.toContain(lookupsUnavailableSentence);
    expect(ollama.state.chatBodies).toHaveLength(1);
    expect(ollama.state.chatBodies[0]).toHaveProperty('tools');
    ollama.state.fallback = () => ollamaError(400, 'invalid tools schema in the request');
    await message({ text: 'hello again' });
    expect(ollama.state.chatBodies).toHaveLength(2);
    expect(ollama.state.chatBodies[1]).toHaveProperty('tools');
  });

  it('leaves out the lookups sentence when earlier tool rounds ran before the tools were dropped', async () => {
    ollama.state.script = [
      () => ollamaToolCalls([{ name: 'search_crm', input: { query: 'Voss' } }]),
      (body) => ollamaError(400, `registry.ollama.ai/library/${body.model} does not support tools`),
    ];
    ollama.state.fallback = () => ollamaText('Ada Voss is a partner.');
    const response = await message({ text: 'Who is Voss?' });
    expect(response.body.reply).toBe('Ada Voss is a partner.');
  });

  it('names Settings when no model is chosen, and reports a server that is not running', async () => {
    await configureOllamaConnector(env.ctx, { baseUrl: ollama.url });
    env.db.prepare("UPDATE connector SET settings = json_set(settings, '$.model', NULL) WHERE kind = 'ollama'").run();
    const none = await message({ text: 'hello' });
    expect(none.body).toMatchObject({ modelFailed: true, modelConnected: true, provider: 'ollama' });
    expect(none.body.reply).toContain('Settings');
    expect(ollama.state.chatCalls).toBe(0);

    await configureOllamaConnector(env.ctx, { model: 'llama-stub:8b' });
    env.db.prepare("UPDATE connector SET settings = json_set(settings, '$.baseUrl', 'http://127.0.0.1:1') WHERE kind = 'ollama'").run();
    const down = await message({ text: 'hello' });
    expect(down.body.modelFailed).toBe(true);
    expect(down.body.reply).toContain('Could not reach the Ollama server');
    await configureOllamaConnector(env.ctx, { baseUrl: ollama.url, model: 'llama-stub:8b' });
  });
});
