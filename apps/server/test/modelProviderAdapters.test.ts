import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOllamaProvider } from '../src/providers/ollama.js';
import { createOpenAiCompatibleProvider, toStrictSchema } from '../src/providers/openaiCompatible.js';
import { ModelProviderError } from '../src/providers/modelTypes.js';
import { compatiblePresets } from '../src/providers/presets.js';

const secret = 'sk-secret-key-9876';
let server: http.Server;
let base = '';
let mode: 'echo_key' | 'redirect' | 'html' | 'rate_limit' = 'echo_key';
const restore: (() => void)[] = [];

beforeAll(async () => {
  server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (mode === 'redirect') {
        response.writeHead(302, { location: '/elsewhere' });
        return response.end();
      }
      if (mode === 'html') {
        response.writeHead(200, { 'content-type': 'text/html' });
        return response.end('<html>not json</html>');
      }
      if (mode === 'rate_limit') {
        response.writeHead(429, { 'content-type': 'application/json' });
        return response.end('{"error":{"message":"slow down"}}');
      }
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `Invalid key ${secret} for this request` } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const previous = process.env.AGENTCRM_DEEPSEEK_BASE;
  process.env.AGENTCRM_DEEPSEEK_BASE = base;
  restore.push(() => {
    if (previous === undefined) delete process.env.AGENTCRM_DEEPSEEK_BASE;
    else process.env.AGENTCRM_DEEPSEEK_BASE = previous;
  });
});

afterAll(async () => {
  for (const undo of restore) undo();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const draftRequest = { model: 'deepseek-flash', system: 's', prompt: 'p', schema: { type: 'object' } };

describe('openai compatible adapter', () => {
  it('removes the key from provider text it repeats in an error message', async () => {
    mode = 'echo_key';
    const provider = createOpenAiCompatibleProvider(compatiblePresets.deepseek, secret);
    const error = await provider.draft(draftRequest).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect((error as ModelProviderError).kind).toBe('rejected');
    expect((error as ModelProviderError).message).toContain('[removed]');
    expect((error as ModelProviderError).message).not.toContain(secret);
    expect((error as ModelProviderError).retryable).toBe(false);
  });

  it('does not follow redirects, so the key never leaves for another address', async () => {
    mode = 'redirect';
    const provider = createOpenAiCompatibleProvider(compatiblePresets.deepseek, secret);
    const error = (await provider.validateKey().catch((caught: unknown) => caught)) as ModelProviderError;
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error.kind).toBe('unavailable');
    expect(error.message).not.toContain(secret);
  });

  it('maps rate limits and unreadable bodies to fixed typed errors', async () => {
    const provider = createOpenAiCompatibleProvider(compatiblePresets.deepseek, secret);
    mode = 'rate_limit';
    expect(((await provider.validateKey().catch((caught: unknown) => caught)) as ModelProviderError).kind).toBe('rate_limited');
    mode = 'html';
    const unreadable = (await provider.validateKey().catch((caught: unknown) => caught)) as ModelProviderError;
    expect(unreadable.kind).toBe('bad_response');
    expect(unreadable.message).toBe('DeepSeek sent a response this app could not read.');
  });

  it('makes optional properties required and nullable for strict schemas, without changing the input', () => {
    const input = {
      type: 'object',
      properties: { query: { type: 'string' }, scope: { type: 'string', enum: ['a', 'b'] } },
      required: ['query'],
      additionalProperties: false,
    };
    const copy = JSON.parse(JSON.stringify(input));
    const strict = toStrictSchema(input) as any;
    expect(input).toEqual(copy);
    expect(strict.required).toEqual(['query', 'scope']);
    expect(strict.properties.query).toEqual({ type: 'string' });
    expect(strict.properties.scope).toEqual({ type: ['string', 'null'], enum: ['a', 'b', null] });
  });
});

describe('ollama adapter', () => {
  it('reports an unreachable server with a fixed message that does not repeat the address', async () => {
    const provider = createOllamaProvider('http://127.0.0.1:1/secret-prefix');
    const error = (await provider.validateKey().catch((caught: unknown) => caught)) as ModelProviderError;
    expect(error.kind).toBe('unavailable');
    expect(error.message).toBe('Could not reach the Ollama server at the configured address.');
  });

  it('does not follow redirects', async () => {
    mode = 'redirect';
    const error = (await createOllamaProvider(base).listModels().catch((caught: unknown) => caught)) as ModelProviderError;
    expect(error.kind).toBe('unavailable');
  });
});
