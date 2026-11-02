import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApifyConnector, markConnectorError } from '../src/actions/index.js';
import { buildApp } from '../src/http/app.js';
import { createTestEnvironment } from './helpers.js';
import { type ApifyStub, startApifyStub, stubToken, useStub } from './apifyStub.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let stub: ApifyStub;
let restore: () => void;

beforeAll(async () => {
  stub = await startApifyStub();
  restore = useStub(stub);
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await stub.close();
  restore();
  env.cleanup();
});

async function call(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { host: '127.0.0.1:4720' },
  });
  const text = response.body;
  return { status: response.statusCode, text, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

describe('apify connector', () => {
  it('requires a connector before proxying the store', async () => {
    const search = await call('GET', '/api/connectors/apify/actors?q=lead');
    expect(search.status).toBe(409);
    expect(search.body!.error.code).toBe('conflict');
    expect(search.body!.error.message).toContain('Settings');
    expect((await call('GET', '/api/connectors/apify/actors/tester~lead-scraper')).status).toBe(409);
    expect((await call('GET', '/api/connectors')).body).toEqual({ items: [], nextCursor: null });
  });

  it('rejects a bad token and stores nothing', async () => {
    const response = await call('PUT', '/api/connectors/apify', { token: 'apify_api_wrongtoken0000' });
    expect(response.status).toBe(400);
    expect(response.body!.error.code).toBe('validation');
    expect(response.text).not.toContain('wrongtoken0000');
    expect((await call('GET', '/api/connectors')).body!.items).toHaveLength(0);
    expect((await call('PUT', '/api/connectors/apify', { allowlist: ['a/b'] })).status).toBe(400);
  });

  it('validates, stores, and masks the token everywhere', async () => {
    const created = await call('PUT', '/api/connectors/apify', { token: stubToken, allowlist: ['tester/lead-scraper'] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'apify',
      status: 'connected',
      statusMessage: null,
      tokenMasked: '****1234',
      settings: { allowlist: ['tester/lead-scraper'], username: 'tester' },
    });
    expect(created.text).not.toContain(stubToken);
    expect(created.body).not.toHaveProperty('secret');

    const list = await call('GET', '/api/connectors');
    expect(list.text).not.toContain(stubToken);
    expect(list.body!.items).toHaveLength(1);

    const audits = env.db.prepare('SELECT action, detail FROM audit_event').all() as { action: string; detail: string }[];
    expect(audits.some((row) => row.action === 'connector.configure')).toBe(true);
    expect(audits.some((row) => row.detail.includes(stubToken) || row.detail.includes('1234'))).toBe(false);
    expect(stub.state.authHeaders).toContain(`Bearer ${stubToken}`);
    const stored = env.db.prepare('SELECT secret FROM connector').get() as { secret: string };
    expect(stored.secret).toBe(stubToken);
  });

  it('updates the allowlist without a token and keeps the secret', async () => {
    const updated = await call('PUT', '/api/connectors/apify', { allowlist: ['tester/lead-scraper', 'Tester~Lead-Scraper', 'other/map-finder'] });
    expect(updated.status).toBe(200);
    expect(updated.body!.settings.allowlist).toEqual(['tester/lead-scraper', 'other/map-finder']);
    expect(updated.body!.tokenMasked).toBe('****1234');
    expect(updated.text).not.toContain(stubToken);
    expect((await call('PUT', '/api/connectors/apify', {})).status).toBe(400);
  });

  it('proxies store search and actor detail', async () => {
    const search = await call('GET', '/api/connectors/apify/actors?q=lead');
    expect(search.status).toBe(200);
    expect(search.body!.items).toEqual([
      {
        id: 'tester~lead-scraper',
        name: 'lead-scraper',
        title: 'Lead scraper',
        username: 'tester',
        description: 'Finds fictional leads.',
        stats: { totalRuns: 4200 },
        pricingHint: 'Pay per result, $0.004 per result',
      },
    ]);
    const detail = await call('GET', '/api/connectors/apify/actors/tester~lead-scraper');
    expect(detail.status).toBe(200);
    expect(detail.body!.id).toBe('tester~lead-scraper');
    expect(detail.body!.exampleRunInput).toEqual({ queries: ['fintech'], max_results: 10 });
    expect((await call('GET', '/api/connectors/apify/actors/tester%2Flead-scraper')).status).toBe(200);
    const missing = await call('GET', '/api/connectors/apify/actors/nobody~nothing');
    expect(missing.status).toBe(404);
    expect(missing.body!.error.code).toBe('not_found');
  });

  it('suggests the import setup only when Apify is connected', async () => {
    const connected = await call('POST', '/api/agent/message', { text: 'Can you scrape leads for me?' });
    expect(connected.body!.actions.map((action: { kind: string }) => action.kind)).toEqual(['start_apify_import']);
    const importing = await call('POST', '/api/agent/message', { text: 'import contacts with apify' });
    expect(importing.body!.actions.map((action: { kind: string }) => action.kind)).toEqual(['start_apify_import']);
    const research = await call('POST', '/api/agent/message', { text: 'find investor leads' });
    expect(research.body!.actions.map((action: { kind: string }) => action.kind)).toEqual(['start_demo_run']);
  });

  it('keeps allowlist edits made while a new token is being checked', async () => {
    const pending = configureApifyConnector(env.ctx, { token: stubToken });
    await configureApifyConnector(env.ctx, { allowlist: ['tester/lead-scraper', 'other/map-finder', 'late/edit'] });
    const saved = await pending;
    expect(saved.connector.settings.allowlist).toEqual(['tester/lead-scraper', 'other/map-finder', 'late/edit']);
    await configureApifyConnector(env.ctx, { allowlist: ['tester/lead-scraper', 'other/map-finder'] });
  });

  it('only marks the connector as error when the failing token is still the saved one', async () => {
    markConnectorError(env.ctx, 'apify_api_someoldtoken');
    expect((await call('GET', '/api/connectors')).body!.items[0].status).toBe('connected');
    markConnectorError(env.ctx, stubToken);
    expect((await call('GET', '/api/connectors')).body!.items[0].status).toBe('error');
    expect((await call('PUT', '/api/connectors/apify', { token: stubToken })).body!.status).toBe('connected');
  });

  it('rejects dot segment actor ids in the allowlist', async () => {
    const response = await call('PUT', '/api/connectors/apify', { allowlist: ['..'] });
    expect(response.status).toBe(400);
    expect(response.body!.error.code).toBe('validation');
  });

  it('marks the connector as error when Apify rejects the saved token', async () => {
    const original = stub.state.token;
    stub.state.token = 'apify_api_rotated0000';
    const response = await call('GET', '/api/connectors/apify/actors?q=lead');
    expect(response.status).toBe(409);
    expect(response.text).not.toContain(stubToken);
    const connector = (await call('GET', '/api/connectors')).body!.items[0];
    expect(connector.status).toBe('error');
    expect(connector.statusMessage).toContain('Apify');
    expect(connector.settings.allowlist).toHaveLength(2);
    stub.state.token = original;
    const fixed = await call('PUT', '/api/connectors/apify', { token: stubToken });
    expect(fixed.status).toBe(200);
    expect(fixed.body!.status).toBe('connected');
    expect(fixed.body!.settings.allowlist).toHaveLength(2);
  });

  it('removes the connector and its token', async () => {
    expect((await call('DELETE', '/api/connectors/apify')).status).toBe(204);
    expect((await call('GET', '/api/connectors')).body!.items).toHaveLength(0);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM connector').get()).toEqual({ n: 0 });
    expect((await call('DELETE', '/api/connectors/apify')).status).toBe(404);
    const message = await call('POST', '/api/agent/message', { text: 'scrape some leads' });
    expect(message.body!.reply).toContain('Settings');
    expect(message.body!.actions).toEqual([]);
    expect((await call('GET', '/api/imports/imp_000000000000')).status).toBe(404);
  });
});
