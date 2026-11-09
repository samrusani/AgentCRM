import { describe, expect, it, vi } from 'vitest';
import { isLoopbackAddress, normalizeBaseUrl, sendCapture, sendNote, verifyConnection } from '../src/api';
import type { CapturePayload } from '../src/messages';

const payload: CapturePayload = { source: 'linkedin', url: 'https://www.linkedin.com/in/jane-doe', name: 'Jane Doe' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('normalizeBaseUrl', () => {
  it('defaults and strips trailing slashes', () => {
    expect(normalizeBaseUrl(undefined)).toBe('http://localhost:4720');
    expect(normalizeBaseUrl('  ')).toBe('http://localhost:4720');
    expect(normalizeBaseUrl('http://127.0.0.1:5000//')).toBe('http://127.0.0.1:5000');
  });
});

describe('sendCapture', () => {
  it('is unconfigured without a token and never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const result = await sendCapture({ baseUrl: '', token: '' }, payload, fetchImpl);
    expect(result).toMatchObject({ ok: false, code: 'unconfigured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts with the bearer token and maps 201 and 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(201, { outcome: 'created', person: { id: 'p1', name: 'Jane Doe' } }))
      .mockResolvedValueOnce(json(200, { outcome: 'existing', person: { id: 'p1', name: 'Jane Doe' } }));
    const settings = { baseUrl: 'http://localhost:4720/', token: 'cap_abc' };
    expect(await sendCapture(settings, payload, fetchImpl)).toEqual({ ok: true, outcome: 'created', personName: 'Jane Doe' });
    expect(await sendCapture(settings, payload, fetchImpl)).toEqual({ ok: true, outcome: 'existing', personName: 'Jane Doe' });
    const filled = vi.fn(async () => new Response(JSON.stringify({ outcome: 'existing', person: { name: 'Jane Doe' }, added: ['title', 7, 'phone'] }), { status: 200 }));
    expect(await sendCapture(settings, payload, filled as never)).toEqual({ ok: true, outcome: 'existing', personName: 'Jane Doe', added: ['title', 'phone'] });
    const [target, init] = fetchImpl.mock.calls[0]!;
    expect(target).toBe('http://localhost:4720/api/capture');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer cap_abc');
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it('maps the server error envelope', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(401, { error: { code: 'unauthorized', message: 'Bad token.' } }));
    expect(await sendCapture({ token: 'cap_x' }, payload, fetchImpl)).toEqual({ ok: false, code: 'unauthorized', message: 'Bad token.' });
  });

  it('maps a 401 without an envelope to unauthorized', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    expect(await sendCapture({ token: 'cap_x' }, payload, fetchImpl)).toMatchObject({ ok: false, code: 'unauthorized' });
  });

  it('maps a network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await sendCapture({ token: 'cap_x' }, payload, fetchImpl)).toEqual({
      ok: false,
      code: 'network',
      message: 'Could not reach the AgentCRM server. Is it running?',
    });
  });
});

describe('verifyConnection', () => {
  it('returns the workspace name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { ok: true, workspace: 'Demo workspace' }));
    expect(await verifyConnection('http://localhost:4720', 'cap_x', fetchImpl)).toEqual({ ok: true, workspace: 'Demo workspace' });
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://localhost:4720/api/capture/verify');
  });

  it('accepts a workspace object with a name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { ok: true, workspace: { id: 'w', name: 'Demo' } }));
    expect(await verifyConnection('', 'cap_x', fetchImpl)).toEqual({ ok: true, workspace: 'Demo' });
  });

  it('reports a rejected token and a network failure', async () => {
    const rejected = vi.fn().mockResolvedValue(json(401, { error: { code: 'unauthorized', message: 'x' } }));
    expect(await verifyConnection('', 'cap_x', rejected)).toEqual({ ok: false, message: 'The server rejected the token.' });
    const down = vi.fn().mockRejectedValue(new Error('down'));
    expect(await verifyConnection('', 'cap_x', down)).toEqual({ ok: false, message: 'Could not reach the AgentCRM server. Is it running?' });
  });
});

// Regression for a live integration find: a Content-Type of application/json with an empty body is
// rejected by the server with 400, so verify must not claim a JSON body it does not send.
describe('postJson headers', () => {
  it('KILLS: verifyConnection sends no Content-Type header because it sends no body', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = async (_input: string, init?: RequestInit) => {
      seen = init;
      return json(200, { ok: true, workspace: 'Demo workspace' });
    };
    await verifyConnection('http://localhost:4720', 'cap_x', fetchImpl);
    expect(seen?.body).toBeUndefined();
    expect(Object.keys((seen?.headers ?? {}) as Record<string, string>)).not.toContain('Content-Type');
  });

  it('KILLS: sendCapture still sends the JSON Content-Type with its body', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = async (_input: string, init?: RequestInit) => {
      seen = init;
      return json(201, { outcome: 'created', person: { name: 'A' } });
    };
    await sendCapture({ baseUrl: 'http://localhost:4720', token: 'cap_x' }, { source: 'x', url: 'https://x.com/a', name: 'A', handle: 'a' }, fetchImpl);
    expect((seen?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(typeof seen?.body).toBe('string');
  });
});

describe('isLoopbackAddress', () => {
  it('treats localhost, 127.0.0.1, [::1], and *.localhost as on this computer', () => {
    for (const address of ['http://localhost:4720', 'http://127.0.0.1:4720', 'http://[::1]:4720', 'https://LOCALHOST', 'http://app.localhost:3000', 'http://127.0.0.1']) {
      expect(isLoopbackAddress(address), address).toBe(true);
    }
  });

  it('flags every other host, including look-alikes', () => {
    for (const address of ['https://crm.example.com', 'http://192.168.1.5:4720', 'http://localhost.evil.example', 'http://localhost@evil.example', 'http://evillocalhost', 'http://127.0.0.2', 'http://0.0.0.0:4720']) {
      expect(isLoopbackAddress(address), address).toBe(false);
    }
  });

  it('does not warn on text that is not an address yet', () => {
    expect(isLoopbackAddress('')).toBe(true);
    expect(isLoopbackAddress('htt')).toBe(true);
  });
});

describe('sendNote', () => {
  const note = { source: 'x' as const, url: 'https://x.com/jack', note: 'Met at the summit' };

  it('is unconfigured without a token and never calls fetch', async () => {
    const fetchImpl = vi.fn();
    expect(await sendNote({ baseUrl: '', token: ' ' }, note, fetchImpl)).toMatchObject({ ok: false, code: 'unconfigured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts source, url, and note only, with the bearer token, and returns the name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(201, { ok: true, person: { name: 'Jack' } }));
    const extra = { ...note, personId: 'per_1' } as typeof note;
    const result = await sendNote({ baseUrl: 'http://localhost:4720/', token: ' cap_abc ' }, extra, fetchImpl);
    expect(result).toEqual({ ok: true, personName: 'Jack' });
    const [target, init] = fetchImpl.mock.calls[0]!;
    expect(target).toBe('http://localhost:4720/api/capture/note');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer cap_abc');
    expect(JSON.parse(init.body)).toEqual(note);
  });

  it('maps the error envelope, a bare 401, a network failure, and an unreadable success', async () => {
    const envelope = vi.fn().mockResolvedValue(json(404, { error: { code: 'not_found', message: 'No one in the CRM matches this profile. Capture it first.' } }));
    expect(await sendNote({ token: 'cap_x' }, note, envelope)).toEqual({
      ok: false,
      code: 'not_found',
      message: 'No one in the CRM matches this profile. Capture it first.',
    });
    const bare = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    expect(await sendNote({ token: 'cap_x' }, note, bare)).toMatchObject({ ok: false, code: 'unauthorized' });
    const down = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await sendNote({ token: 'cap_secret' }, note, down)).toMatchObject({ ok: false, code: 'network' });
    const garbled = vi.fn().mockResolvedValue(new Response('nope', { status: 201 }));
    expect(await sendNote({ token: 'cap_x' }, note, garbled)).toMatchObject({ ok: false, code: 'http' });
  });
});
