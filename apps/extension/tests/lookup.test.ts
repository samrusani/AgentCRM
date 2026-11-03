import { describe, expect, it, vi } from 'vitest';
import { sendLookup } from '../src/api';

const payload = { source: 'linkedin' as const, url: 'https://www.linkedin.com/in/jane' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('sendLookup', () => {
  it('POSTs source and url only, with the bearer header, to the lookup path', async () => {
    const fetchImpl = vi.fn(async () => json({ exists: true }));
    const extra = { ...payload, name: 'Jane', bio: 'private' } as typeof payload;
    const result = await sendLookup({ baseUrl: 'http://localhost:4720/', token: ' cap_secret ' }, extra, fetchImpl);
    expect(result).toEqual({ ok: true, exists: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:4720/api/capture/lookup');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer cap_secret', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it('answers exists false', async () => {
    const result = await sendLookup({ token: 't' }, payload, vi.fn(async () => json({ exists: false })));
    expect(result).toEqual({ ok: true, exists: false });
  });

  it('does not call the server without a token', async () => {
    const fetchImpl = vi.fn();
    const result = await sendLookup({ baseUrl: '', token: '  ' }, payload, fetchImpl);
    expect(result).toMatchObject({ ok: false, code: 'unconfigured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  const failures: Array<[string, () => Promise<Response>, string]> = [
    ['404 without a body (older server)', async () => new Response('Not found', { status: 404 }), 'http'],
    ['401 with an error body', async () => json({ error: { code: 'unauthorized', message: 'Nope' } }, 401), 'unauthorized'],
    ['500 with html', async () => new Response('<html>oops</html>', { status: 500 }), 'http'],
    ['200 with a body that is not json', async () => new Response('not json', { status: 200 }), 'http'],
    ['network failure', () => Promise.reject(new TypeError('Failed to fetch')), 'network'],
  ];
  it.each(failures)('%s comes back as ok false without throwing or echoing the token', async (_name, make, code) => {
    const result = await sendLookup({ baseUrl: '', token: 'cap_secret_value' }, payload, make as never);
    expect(result).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain('cap_secret_value');
  });
});

describe('background lookup', () => {
  async function bootBackground(stored: Record<string, unknown>, fetchImpl: (...a: any[]) => Promise<Response>) {
    vi.resetModules();
    let listener: ((m: unknown, sender: { id?: string }, respond: (r: unknown) => void) => boolean) | undefined;
    vi.stubGlobal('chrome', {
      runtime: { id: 'ext', openOptionsPage: vi.fn(), onMessage: { addListener: (l: typeof listener) => (listener = l) } },
      action: { onClicked: { addListener: () => undefined } },
      storage: { local: { get: vi.fn(async (defaults: Record<string, unknown>) => ({ ...defaults, ...stored })) } },
    });
    vi.stubGlobal('fetch', fetchImpl);
    await import('../src/background');
    return { listener: listener! };
  }
  const ask = (listener: (m: unknown, s: { id?: string }, r: (x: unknown) => void) => boolean, message: unknown = { kind: 'lookup', payload }) =>
    new Promise<unknown>((resolve) => {
      expect(listener(message, { id: 'ext' }, resolve)).toBe(true);
    });

  it('a lookup from the own extension POSTs to the stored base url with the bearer header and returns exists', async () => {
    const fetchImpl = vi.fn(async () => json({ exists: true }));
    const { listener } = await bootBackground({ token: ' cap_secret ', baseUrl: 'http://127.0.0.1:5000/' }, fetchImpl);
    const response = await ask(listener);
    expect(response).toEqual({ ok: true, exists: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5000/api/capture/lookup');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer cap_secret' });
    expect(JSON.parse(init.body as string)).toEqual(payload);
    expect(JSON.stringify(response)).not.toContain('cap_secret');
  });

  it('uses the default base url when none is stored', async () => {
    const fetchImpl = vi.fn(async () => json({ exists: false }));
    const { listener } = await bootBackground({ token: 'cap_secret' }, fetchImpl);
    expect(await ask(listener)).toEqual({ ok: true, exists: false });
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe('http://localhost:4720/api/capture/lookup');
  });

  it('a non 200 answer and a network failure return ok false with no token anywhere in the result', async () => {
    for (const make of [
      async () => new Response('Not found', { status: 404 }),
      async () => json({ error: { code: 'unauthorized', message: 'Nope' } }, 401),
      async () => new Response('boom', { status: 500 }),
      () => Promise.reject(new TypeError('Failed to fetch')),
    ]) {
      const { listener } = await bootBackground({ token: 'cap_secret', baseUrl: 'http://localhost:4720' }, make);
      const response = await ask(listener);
      expect(response).toMatchObject({ ok: false });
      expect(JSON.stringify(response)).not.toContain('cap_secret');
    }
  });

  it('a non loopback base url answers ok false without any fetch, so nothing leaves the machine on view', async () => {
    for (const baseUrl of ['https://remote.example', 'http://192.168.1.20:4720', 'http://localhost.evil.example', 'localhost:4720']) {
      const fetchImpl = vi.fn(async () => json({ exists: true }));
      const { listener } = await bootBackground({ token: 'cap_secret', baseUrl }, fetchImpl);
      const response = await ask(listener);
      expect(response, baseUrl).toMatchObject({ ok: false });
      expect(fetchImpl, baseUrl).not.toHaveBeenCalled();
      expect(JSON.stringify(response)).not.toContain('cap_secret');
    }
  });

  it('loopback hosts (localhost, 127.0.0.1, [::1], *.localhost) still send the lookup', async () => {
    for (const baseUrl of ['http://localhost:4720', 'http://127.0.0.1:4720', 'http://[::1]:4720', 'http://crm.localhost:4720']) {
      const fetchImpl = vi.fn(async () => json({ exists: false }));
      const { listener } = await bootBackground({ token: 'cap_secret', baseUrl }, fetchImpl);
      expect(await ask(listener), baseUrl).toEqual({ ok: true, exists: false });
      expect(fetchImpl, baseUrl).toHaveBeenCalledTimes(1);
    }
  });

  it('an unconfigured token answers ok false without a fetch', async () => {
    const fetchImpl = vi.fn();
    const { listener } = await bootBackground({}, fetchImpl);
    expect(await ask(listener)).toMatchObject({ ok: false, code: 'unconfigured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lookup messages from other sender ids are ignored without a response or a fetch', async () => {
    const fetchImpl = vi.fn();
    const { listener } = await bootBackground({ token: 'cap_secret' }, fetchImpl);
    const respond = vi.fn();
    for (const sender of [{ id: 'other-extension' }, {}, { id: undefined }]) {
      expect(listener({ kind: 'lookup', payload }, sender, respond)).toBe(false);
    }
    await Promise.resolve();
    expect(respond).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
