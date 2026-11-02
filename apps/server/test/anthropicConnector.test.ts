import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { markConnectorError } from '../src/actions/index.js';
import { buildApp } from '../src/http/app.js';
import { resetFallbackMemory } from '../src/providers/anthropic.js';
import { type AnthropicStub, startAnthropicStub, stubApiKey, textReply, useAnthropicStub } from './anthropicStub.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let stub: AnthropicStub;
let restore: () => void;
const events: string[] = [];

beforeAll(async () => {
  stub = await startAnthropicStub();
  restore = useAnthropicStub(stub);
  env.bus.subscribe((event) => events.push(JSON.stringify(event)));
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

beforeEach(() => {
  resetFallbackMemory();
});

afterAll(async () => {
  await app.close();
  await stub.close();
  restore();
  env.cleanup();
});

async function call(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, payload: payload as object | undefined, headers: { host: '127.0.0.1:4720' } });
  const text = response.body;
  return { status: response.statusCode, text, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

describe('anthropic connector', () => {
  it('rejects a bad key and stores nothing', async () => {
    const response = await call('PUT', '/api/connectors/anthropic', { token: 'sk-ant-wrongkey-0000' });
    expect(response.status).toBe(400);
    expect(response.body!.error.code).toBe('validation');
    expect(response.body!.error.message).toContain('Check it and try again');
    expect(response.text).not.toContain('wrongkey-0000');
    expect((await call('GET', '/api/connectors')).body!.items).toHaveLength(0);
    expect((await call('PUT', '/api/connectors/anthropic', { model: 'claude-haiku-5-5' })).status).toBe(400);
    expect((await call('PUT', '/api/connectors/anthropic', {})).status).toBe(400);
  });

  it('validates the key with the models endpoint, stores it, and masks it everywhere', async () => {
    const created = await call('PUT', '/api/connectors/anthropic', { token: stubApiKey });
    expect(created.status).toBe(201);
    expect(stub.state.modelsCalls).toBe(1);
    expect(created.body).toMatchObject({
      kind: 'anthropic',
      status: 'connected',
      statusMessage: null,
      tokenMasked: '****1234',
      settings: { model: 'claude-opus-5-5' },
    });
    expect(created.text).not.toContain(stubApiKey);
    expect(created.body).not.toHaveProperty('secret');

    const list = await call('GET', '/api/connectors');
    expect(list.text).not.toContain(stubApiKey);
    expect(list.body!.items).toHaveLength(1);
    expect(list.body!.items[0].settings).toEqual({ model: 'claude-opus-5-5' });

    const audits = env.db.prepare('SELECT action, detail FROM audit_event').all() as { action: string; detail: string }[];
    expect(audits.some((row) => row.action === 'connector.configure')).toBe(true);
    expect(audits.some((row) => row.detail.includes(stubApiKey) || row.detail.includes('abcd1234'))).toBe(false);
    expect(events.some((event) => event.includes(stubApiKey))).toBe(false);
    const stored = env.db.prepare('SELECT secret FROM connector').get() as { secret: string };
    expect(stored.secret).toBe(stubApiKey);
    expect(stub.state.authHeaders).toContain(stubApiKey);
  });

  it('switches the model without a key and rejects unknown models', async () => {
    const switched = await call('PUT', '/api/connectors/anthropic', { model: 'claude-sonnet-5-5' });
    expect(switched.status).toBe(200);
    expect(switched.body!.settings.model).toBe('claude-sonnet-5-5');
    expect(switched.body!.tokenMasked).toBe('****1234');
    expect(stub.state.modelsCalls).toBe(1);

    const unknown = await call('PUT', '/api/connectors/anthropic', { model: 'claude-opus-4-1' });
    expect(unknown.status).toBe(400);
    expect(unknown.body!.error.message).toContain('claude-opus-5-5');
    expect((await call('GET', '/api/connectors')).body!.items[0].settings.model).toBe('claude-sonnet-5-5');

    const both = await call('PUT', '/api/connectors/anthropic', { token: stubApiKey, model: 'claude-haiku-5-5' });
    expect(both.status).toBe(200);
    expect(both.body!.settings.model).toBe('claude-haiku-5-5');
    expect(stub.state.modelsCalls).toBe(2);
    await call('PUT', '/api/connectors/anthropic', { model: 'claude-opus-5-5' });
  });

  it('only marks the connector as error when the failing key is still the saved one', async () => {
    markConnectorError(env.ctx, 'sk-ant-someoldkey', 'anthropic');
    expect((await call('GET', '/api/connectors')).body!.items[0].status).toBe('connected');
    markConnectorError(env.ctx, stubApiKey, 'anthropic');
    const failed = (await call('GET', '/api/connectors')).body!.items[0];
    expect(failed.status).toBe('error');
    expect(failed.statusMessage).toContain('Anthropic');
    expect(failed.statusMessage).not.toContain(stubApiKey);
    const fixed = await call('PUT', '/api/connectors/anthropic', { token: stubApiKey });
    expect(fixed.body!.status).toBe('connected');
    expect(fixed.body!.statusMessage).toBeNull();
  });

  it('flips to error when a chat call is rejected with 401', async () => {
    stub.state.apiKey = 'sk-ant-rotated-0000';
    const reply = await call('POST', '/api/agent/message', { text: 'hello' });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ modelConnected: true, modelFailed: true });
    expect(reply.body!.reply).toContain('The model call failed');
    expect(reply.text).not.toContain(stubApiKey);
    expect((await call('GET', '/api/connectors')).body!.items[0].status).toBe('error');
    // With the connector in error, no further provider call is made.
    const before = stub.state.messageCalls;
    await call('POST', '/api/agent/message', { text: 'hello' });
    expect(stub.state.messageCalls).toBe(before);
    stub.state.apiKey = stubApiKey;
    expect((await call('PUT', '/api/connectors/anthropic', { token: stubApiKey })).body!.status).toBe('connected');
  });

  it('keeps the key out of audit rows, events, and model call rows after use', async () => {
    stub.state.fallback = () => textReply('Fine.');
    await call('POST', '/api/agent/message', { text: 'hello' });
    const everything = [
      JSON.stringify(env.db.prepare('SELECT * FROM audit_event').all()),
      JSON.stringify(env.db.prepare('SELECT * FROM model_call').all()),
      JSON.stringify(env.db.prepare('SELECT * FROM job').all()),
      events.join('\n'),
    ].join('\n');
    expect(everything).not.toContain(stubApiKey);
    expect(everything).not.toContain('abcd1234');
  });

  it('removes the connector and its key', async () => {
    expect((await call('DELETE', '/api/connectors/anthropic')).status).toBe(204);
    expect((await call('GET', '/api/connectors')).body!.items).toHaveLength(0);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM connector').get()).toEqual({ n: 0 });
    expect((await call('DELETE', '/api/connectors/anthropic')).status).toBe(404);
    const message = await call('POST', '/api/agent/message', { text: 'hello' });
    expect(message.body).toMatchObject({ modelConnected: false });
    expect(message.body).not.toHaveProperty('usage');
    expect(message.body!.reply).toContain('No model connected');
  });
});
