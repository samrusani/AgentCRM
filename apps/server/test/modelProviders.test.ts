import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPerson, startRun } from '../src/actions/index.js';
import { markConnectorError } from '../src/actions/connectors.js';
import { buildApp } from '../src/http/app.js';
import { describeModelProvider, isActiveModelReady } from '../src/queries/modelProvider.js';
import { providerCatalog } from '../src/providers/presets.js';
import { type AnthropicStub, startAnthropicStub, stubApiKey, useAnthropicStub } from './anthropicStub.js';
import { type CompatKind, type CompatStub, compatKeys, startCompatStub, useCompatStub } from './openaiCompatStub.js';
import { type OllamaStub, startOllamaStub } from './ollamaStub.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let anthropic: AnthropicStub;
const compat = {} as Record<CompatKind, CompatStub>;
let ollama: OllamaStub;
const restores: (() => void)[] = [];
const kinds: CompatKind[] = ['openai', 'deepseek', 'zai'];
const labels: Record<CompatKind, string> = { openai: 'OpenAI', deepseek: 'DeepSeek', zai: 'Z.ai' };
const defaults: Record<CompatKind, string> = { openai: 'gpt-5.6-terra', deepseek: 'deepseek-flash', zai: 'glm-5.3' };
const others: Record<CompatKind, string> = { openai: 'gpt-5.6-sol', deepseek: 'deepseek-v4-pro', zai: 'glm-4.7' };

beforeAll(async () => {
  anthropic = await startAnthropicStub();
  restores.push(useAnthropicStub(anthropic));
  for (const kind of kinds) {
    compat[kind] = await startCompatStub(kind);
    restores.push(useCompatStub(compat[kind]));
  }
  ollama = await startOllamaStub();
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

beforeEach(() => {
  for (const kind of kinds) compat[kind].reset();
  ollama.reset();
});

afterAll(async () => {
  await app.close();
  await anthropic.close();
  for (const kind of kinds) await compat[kind].close();
  await ollama.close();
  for (const restore of restores) restore();
  env.cleanup();
});

async function call(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, payload: payload as object | undefined, headers: { host: '127.0.0.1:4720' } });
  const text = response.body;
  return { status: response.statusCode, text, body: text ? (JSON.parse(text) as any) : null };
}

async function removeAll() {
  for (const kind of ['anthropic', 'openai', 'deepseek', 'zai', 'ollama']) await call('DELETE', `/api/connectors/${kind}`);
}

describe.each(kinds)('%s connector', (kind) => {
  const label = labels[kind];
  const key = compatKeys[kind];

  it('rejects a bad key and stores nothing', async () => {
    const response = await call('PUT', `/api/connectors/${kind}`, { token: 'wrong-key-0000' });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain(`${label} did not accept this key`);
    expect(response.text).not.toContain('wrong-key-0000');
    expect((await call('GET', '/api/connectors')).body.items).toHaveLength(0);
    expect((await call('PUT', `/api/connectors/${kind}`, { model: others[kind] })).status).toBe(400);
    expect((await call('PUT', `/api/connectors/${kind}`, {})).status).toBe(400);
  });

  it('validates the key the documented way, stores it, and masks it everywhere', async () => {
    const created = await call('PUT', `/api/connectors/${kind}`, { token: key });
    expect(created.status).toBe(201);
    if (kind === 'zai') {
      // Z.ai has no free key check endpoint, so the key is tried with a one token completion.
      expect(compat.zai.state.keyCheckCalls).toBe(1);
      expect(compat.zai.state.modelsCalls).toBe(0);
    } else {
      expect(compat[kind].state.modelsCalls).toBe(1);
      expect(compat[kind].state.paths).toContainEqual(expect.stringMatching(/^GET .*\/models$/));
    }
    expect(compat[kind].state.authHeaders).toContain(key);
    expect(Object.keys(created.body).sort()).toEqual(['createdAt', 'id', 'kind', 'settings', 'status', 'statusMessage', 'tokenMasked', 'updatedAt', 'workspaceId']);
    expect(created.body).toMatchObject({ kind, status: 'connected', statusMessage: null, tokenMasked: `****${key.slice(-4)}`, settings: { model: defaults[kind] } });
    expect(created.text).not.toContain(key);

    const list = await call('GET', '/api/connectors');
    expect(list.text).not.toContain(key);
    expect(list.body.items[0].settings).toEqual({ model: defaults[kind] });
    const audits = JSON.stringify(env.db.prepare('SELECT detail FROM audit_event').all());
    expect(audits).not.toContain(key);
    const stored = env.db.prepare('SELECT secret FROM connector WHERE kind = ?').get(kind) as { secret: string };
    expect(stored.secret).toBe(key);
  });

  it('switches the model without a key and rejects models that are not offered', async () => {
    const switched = await call('PUT', `/api/connectors/${kind}`, { model: others[kind] });
    expect(switched.status).toBe(200);
    expect(switched.body.settings.model).toBe(others[kind]);
    expect(switched.body.tokenMasked).toBe(`****${key.slice(-4)}`);
    const unknown = await call('PUT', `/api/connectors/${kind}`, { model: 'gpt-4' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toContain(defaults[kind]);
  });

  it('removes the connector and its key', async () => {
    expect((await call('DELETE', `/api/connectors/${kind}`)).status).toBe(204);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM connector').get()).toEqual({ n: 0 });
    expect((await call('DELETE', `/api/connectors/${kind}`)).status).toBe(404);
  });
});

describe('ollama connector', () => {
  const connect = (payload: unknown) => call('PUT', '/api/connectors/ollama', payload);

  it('connects with only an address, leaves the model unset, and has no tokenMasked', async () => {
    const created = await connect({ baseUrl: `${ollama.url}/` });
    expect(created.status).toBe(201);
    expect(ollama.state.tagsCalls).toBe(1);
    expect(created.body).toMatchObject({ kind: 'ollama', status: 'connected', statusMessage: null, settings: { baseUrl: ollama.url, model: null } });
    expect(created.body).not.toHaveProperty('tokenMasked');
    expect(Object.keys(created.body).sort()).toEqual(['createdAt', 'id', 'kind', 'settings', 'status', 'statusMessage', 'updatedAt', 'workspaceId']);
    expect(ollama.state.authHeaders.every((header) => header === undefined)).toBe(true);
    expect(env.db.prepare("SELECT secret FROM connector WHERE kind = 'ollama'").get()).toEqual({ secret: '' });
  });

  it('lists installed models from the saved server', async () => {
    const models = await call('GET', '/api/connectors/ollama/models');
    expect(models.status).toBe(200);
    expect(models.body.items.map((item: { name: string }) => item.name)).toEqual(['llama-stub:8b', 'qwen-stub:4b']);
    expect(models.body.items[0]).toEqual({ name: 'llama-stub:8b', sizeBytes: 4_000_000_000, modifiedAt: '2026-10-01T00:00:00Z' });
  });

  it('requires a model that exists in the installed list', async () => {
    const missing = await connect({ model: 'ghost:1b' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toContain('llama-stub:8b');
    const picked = await connect({ model: 'qwen-stub:4b' });
    expect(picked.status).toBe(200);
    expect(picked.body.settings).toEqual({ baseUrl: ollama.url, model: 'qwen-stub:4b' });
    expect((await call('GET', '/api/connectors')).body.items[0].settings.model).toBe('qwen-stub:4b');
  });

  it('keeps the model when the same server is saved again and drops it when the new server lacks it', async () => {
    expect((await connect({ baseUrl: ollama.url })).body.settings.model).toBe('qwen-stub:4b');
    ollama.state.models = ['other:1b'];
    expect((await connect({ baseUrl: ollama.url })).body.settings.model).toBeNull();
    ollama.state.models = ['llama-stub:8b', 'qwen-stub:4b'];
  });

  it('only accepts http and https addresses without credentials, and reports an unreachable server', async () => {
    for (const baseUrl of ['ftp://127.0.0.1:11434', 'not a url', 'http://user:pass@127.0.0.1:11434']) {
      const response = await connect({ baseUrl });
      expect(response.status).toBe(400);
      expect(response.text).not.toContain('pass@');
    }
    const unreachable = await connect({ baseUrl: 'http://127.0.0.1:1' });
    expect(unreachable.status).toBe(502);
    expect(unreachable.body.error.message).toContain('Ollama');
    expect((await call('PUT', '/api/connectors/ollama', {})).status).toBe(400);
  });

  it('removes the connector', async () => {
    expect((await call('DELETE', '/api/connectors/ollama')).status).toBe(204);
    expect((await call('GET', '/api/connectors/ollama/models')).status).toBe(409);
  });
});

describe('active model provider', () => {
  beforeEach(async () => {
    await removeAll();
  });

  it('reports null with nothing connected and refuses to activate a provider that is not connected', async () => {
    const empty = await call('GET', '/api/model-provider');
    expect(empty.status).toBe(200);
    expect(empty.body).toBeNull();
    // The body is the JSON literal null, not an empty response.
    expect(empty.text).toBe('null');
    const refused = await call('PUT', '/api/model-provider', { kind: 'openai' });
    expect(refused.status).toBe(409);
    expect((await call('PUT', '/api/model-provider', { kind: 'gpt' })).status).toBe(400);
  });

  it('makes the first connected provider active automatically and keeps it when a second is added', async () => {
    await call('PUT', '/api/connectors/openai', { token: compatKeys.openai });
    expect((await call('GET', '/api/model-provider')).body).toEqual({ kind: 'openai', model: 'gpt-5.6-terra', status: 'connected', statusMessage: null, ready: true });
    await call('PUT', '/api/connectors/deepseek', { token: compatKeys.deepseek });
    expect((await call('GET', '/api/model-provider')).body).toEqual({ kind: 'openai', model: 'gpt-5.6-terra', status: 'connected', statusMessage: null, ready: true });
    const settings = JSON.parse((env.db.prepare('SELECT settings FROM workspace').get() as { settings: string }).settings);
    expect(settings.modelProvider).toBe('openai');
  });

  it('switches the active provider and follows its model', async () => {
    await call('PUT', '/api/connectors/openai', { token: compatKeys.openai });
    await call('PUT', '/api/connectors/zai', { token: compatKeys.zai });
    const switched = await call('PUT', '/api/model-provider', { kind: 'zai' });
    expect(switched.status).toBe(200);
    expect(switched.body).toEqual({ kind: 'zai', model: 'glm-5.3', status: 'connected', statusMessage: null, ready: true });
    await call('PUT', '/api/connectors/zai', { model: 'glm-4.7' });
    expect((await call('GET', '/api/model-provider')).body).toEqual({ kind: 'zai', model: 'glm-4.7', status: 'connected', statusMessage: null, ready: true });
  });

  it('reassigns when the active provider is removed, then clears to null', async () => {
    await call('PUT', '/api/connectors/anthropic', { token: stubApiKey });
    await call('PUT', '/api/connectors/openai', { token: compatKeys.openai });
    await call('PUT', '/api/model-provider', { kind: 'openai' });
    expect((await call('DELETE', '/api/connectors/openai')).status).toBe(204);
    expect((await call('GET', '/api/model-provider')).body).toEqual({ kind: 'anthropic', model: 'claude-opus-5-5', status: 'connected', statusMessage: null, ready: true });
    expect((await call('DELETE', '/api/connectors/anthropic')).status).toBe(204);
    expect((await call('GET', '/api/model-provider')).body).toBeNull();
    const settings = JSON.parse((env.db.prepare('SELECT settings FROM workspace').get() as { settings: string }).settings);
    expect(settings).not.toHaveProperty('modelProvider');
  });

  it('leaves the active provider and draft runs alone when a provider that is not active is removed', async () => {
    createPerson(env.ctx, { firstName: 'Ada', lastName: 'Avery', email: 'ada.avery@example.com' });
    await call('PUT', '/api/connectors/openai', { token: compatKeys.openai });
    await call('PUT', '/api/connectors/deepseek', { token: compatKeys.deepseek });
    const run = startRun(env.ctx, { kind: 'draft_outreach', scope: {} });
    expect(run.scope).toMatchObject({ provider: 'openai', model: 'gpt-5.6-terra' });
    expect(run.steps[0]!.title).toBe('Check the OpenAI connection');
    await call('DELETE', '/api/connectors/deepseek');
    expect((await call('GET', '/api/model-provider')).body.kind).toBe('openai');
    expect((await call('GET', `/api/runs/${run.id}`)).body.status).toBe('queued');
    // Removing the active one fails the run that was still working.
    await call('DELETE', '/api/connectors/openai');
    const failed = (await call('GET', `/api/runs/${run.id}`)).body;
    expect(failed.status).toBe('failed');
    expect(failed.steps.some((step: { detail: string | null }) => step.detail?.includes('OpenAI was disconnected in Settings'))).toBe(true);
  });

  it('fails only the runs pinned to the removed provider, and counts a run with no pinned provider as Anthropic', async () => {
    await call('PUT', '/api/connectors/anthropic', { token: stubApiKey });
    await call('PUT', '/api/connectors/openai', { token: compatKeys.openai });
    await call('PUT', '/api/connectors/deepseek', { token: compatKeys.deepseek });
    const legacy = startRun(env.ctx, { kind: 'draft_outreach', scope: {} });
    await call('PUT', '/api/model-provider', { kind: 'openai' });
    const pinnedOpenai = startRun(env.ctx, { kind: 'draft_outreach', scope: {} });
    await call('PUT', '/api/model-provider', { kind: 'deepseek' });
    const pinnedDeepseek = startRun(env.ctx, { kind: 'draft_outreach', scope: {} });
    expect(pinnedDeepseek.scope).toMatchObject({ provider: 'deepseek' });
    // A run from before the provider setting has no pinned provider in its scope.
    env.db.prepare("UPDATE run SET scope = json_remove(scope, '$.provider', '$.model') WHERE id = ?").run(legacy.id);
    const status = async (id: string) => (await call('GET', `/api/runs/${id}`)).body.status;

    // Neither of these is the active provider, and each stops only its own pinned run.
    await call('DELETE', '/api/connectors/openai');
    expect(await status(pinnedOpenai.id)).toBe('failed');
    expect(await status(legacy.id)).toBe('queued');
    expect(await status(pinnedDeepseek.id)).toBe('queued');
    await call('DELETE', '/api/connectors/anthropic');
    expect(await status(legacy.id)).toBe('failed');
    expect(await status(pinnedDeepseek.id)).toBe('queued');
    expect((await call('GET', '/api/model-provider')).body.kind).toBe('deepseek');
    // Removing the active provider stops its own run too.
    await call('DELETE', '/api/connectors/deepseek');
    expect(await status(pinnedDeepseek.id)).toBe('failed');
  });

  it('describes the active provider for MCP without any key or address', async () => {
    expect(describeModelProvider(env.db, env.workspaceId)).toEqual({ configured: false });
    await call('PUT', '/api/connectors/zai', { token: compatKeys.zai });
    await call('PUT', '/api/connectors/ollama', { baseUrl: ollama.url, model: 'llama-stub:8b' });
    expect(describeModelProvider(env.db, env.workspaceId)).toEqual({ configured: true, kind: 'zai', status: 'connected', model: 'glm-5.3', ready: true });
    await call('PUT', '/api/model-provider', { kind: 'ollama' });
    const described = describeModelProvider(env.db, env.workspaceId);
    expect(described).toEqual({ configured: true, kind: 'ollama', status: 'connected', model: 'llama-stub:8b', ready: true });
    expect(JSON.stringify(described)).not.toContain(ollama.url);
    expect(JSON.stringify(describeModelProvider(env.db, env.workspaceId))).not.toContain(compatKeys.zai);
  });

  it('reports status and ready for the active provider, and not ready for an errored or model-less one', async () => {
    expect(isActiveModelReady(env.db, env.workspaceId)).toBe(false);
    await call('PUT', '/api/connectors/openai', { token: compatKeys.openai });
    const healthy = (await call('GET', '/api/model-provider')).body;
    expect(Object.keys(healthy).sort()).toEqual(['kind', 'model', 'ready', 'status', 'statusMessage']);
    expect(healthy).toMatchObject({ kind: 'openai', status: 'connected', statusMessage: null, ready: true });
    expect(isActiveModelReady(env.db, env.workspaceId)).toBe(true);

    // A rejected key leaves the provider saved and active, but it cannot run work.
    markConnectorError(env.ctx, compatKeys.openai, 'openai');
    const errored = (await call('GET', '/api/model-provider')).body;
    expect(errored).toMatchObject({ kind: 'openai', status: 'error', ready: false });
    expect(errored.statusMessage).toContain('OpenAI rejected the saved API key');
    expect(isActiveModelReady(env.db, env.workspaceId)).toBe(false);
    expect(describeModelProvider(env.db, env.workspaceId)).toMatchObject({ configured: true, status: 'error', ready: false });

    // An Ollama server with no chosen model is connected but not ready.
    await call('PUT', '/api/connectors/ollama', { baseUrl: ollama.url });
    await call('PUT', '/api/model-provider', { kind: 'ollama' });
    const noModel = (await call('GET', '/api/model-provider')).body;
    expect(noModel).toEqual({ kind: 'ollama', model: null, status: 'connected', statusMessage: null, ready: false });
    expect(isActiveModelReady(env.db, env.workspaceId)).toBe(false);
    await call('PUT', '/api/connectors/ollama', { model: 'llama-stub:8b' });
    expect((await call('GET', '/api/model-provider')).body).toMatchObject({ kind: 'ollama', ready: true });
    expect(isActiveModelReady(env.db, env.workspaceId)).toBe(true);
  });

  it('serves the preset catalog with dated prices', async () => {
    const catalog = await call('GET', '/api/model-providers');
    expect(catalog.status).toBe(200);
    expect(catalog.body.items.map((item: { kind: string }) => item.kind)).toEqual(['anthropic', 'openai', 'deepseek', 'zai', 'ollama']);
    const deepseek = catalog.body.items.find((item: { kind: string }) => item.kind === 'deepseek');
    expect(deepseek.models[0].priceHint).toContain('2026-11-02');
    expect(deepseek.models[0].priceHint).toContain('peak');
    expect(deepseek.models[0].priceHint).toContain('Off peak is half');
    expect(catalog.body.items.find((item: { kind: string }) => item.kind === 'openai').models[0].priceHint).toContain('$0.20 cached');
    expect(catalog.body.items.find((item: { kind: string }) => item.kind === 'ollama').models).toEqual([]);
  });

  it('keeps model ids unique across the presets', () => {
    const ids = providerCatalog().flatMap((entry) => entry.models.map((model) => model.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('gpt-6-astra');
    expect(ids).not.toContain('gpt-6.1-sol');
  });
});
