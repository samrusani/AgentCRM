import { afterEach, expect, it, vi } from 'vitest';
import { configureGmailConnector, configureMicrosoftConnector } from '../src/actions/index.js';
import { buildApp } from '../src/http/app.js';
import { createTestEnvironment } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  ['gmail', '127.0.0.1'],
  ['microsoft', 'localhost'],
])('uses the bound listener for %s and exchanges the code with the original URI', async (provider, hostname) => {
  const env = createTestEnvironment();
  const app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath });
  try {
    if (provider === 'gmail') configureGmailConnector(env.ctx, { clientId: 'fixture-client', clientSecret: 'fixture-secret' });
    else configureMicrosoftConnector(env.ctx, { clientId: 'fixture-client' });
    const exchange = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 400 }));
    vi.stubGlobal('fetch', exchange);
    const listener = vi.spyOn(app.server, 'address').mockReturnValue({ address: '127.0.0.1', family: 'IPv4', port: 51387 });
    const base = `/api/connectors/${provider}/oauth`;
    const headers = { host: '127.0.0.1:9999' };
    const consent = await app.inject({ method: 'POST', url: `${base}/start`, headers });
    expect(consent.statusCode).toBe(200);
    const url = new URL(consent.json<{ url: string }>().url);
    const redirect = `http://${hostname}:51387${base}/callback`;
    expect(url.searchParams.get('redirect_uri')).toBe(redirect);
    listener.mockReturnValue({ address: '127.0.0.1', family: 'IPv4', port: 51388 });
    const callback = await app.inject({
      url: `${base}/callback?state=${url.searchParams.get('state')}&code=fixture-code`,
      headers,
    });
    expect(callback.statusCode).toBe(303);
    expect(exchange).toHaveBeenCalledTimes(1);
    const body = exchange.mock.calls[0]?.[1]?.body;
    expect(new URLSearchParams(String(body)).get('redirect_uri')).toBe(redirect);
  } finally {
    await app.close();
    env.cleanup();
  }
});
