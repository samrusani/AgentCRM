import { CONFIG_MESSAGE, DEFAULT_BASE_URL } from './messages';
import type { CapturePayload, CaptureResponse, LookupPayload, LookupResponse } from './messages';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const NETWORK_MESSAGE = 'Could not reach the AgentCRM server. Is it running?';

export function normalizeBaseUrl(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text === '' ? DEFAULT_BASE_URL : text).replace(/\/+$/, '');
}

/** True for localhost, 127.0.0.1, [::1], and *.localhost hosts. Anything else is not on this computer. */
export function isLoopbackAddress(value: string): boolean {
  let host: string;
  try {
    host = new URL(value.trim()).hostname.toLowerCase();
  } catch {
    return true; // Not a parseable address yet: nothing to warn about.
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

async function postJson(base: string, path: string, token: string, body: unknown, fetchImpl: FetchLike) {
  // A Content-Type of application/json with no body is rejected by the server, so the header is only
  // sent when there is a body to describe.
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetchImpl(`${base}${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readError(res: Response): Promise<{ ok: false; code: string; message: string }> {
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  const error = (parsed as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    return { ok: false, code: error.code, message: error.message };
  }
  if (res.status === 401) return { ok: false, code: 'unauthorized', message: CONFIG_MESSAGE };
  return { ok: false, code: 'http', message: `The server answered ${res.status}.` };
}

/** One capture request. Never throws: every outcome comes back as a CaptureResponse. */
export async function sendCapture(
  settings: { baseUrl?: unknown; token?: unknown },
  payload: CapturePayload,
  fetchImpl: FetchLike = fetch,
): Promise<CaptureResponse> {
  const token = typeof settings.token === 'string' ? settings.token.trim() : '';
  if (token === '') return { ok: false, code: 'unconfigured', message: CONFIG_MESSAGE };
  let res: Response;
  try {
    res = await postJson(normalizeBaseUrl(settings.baseUrl), '/api/capture', token, payload, fetchImpl);
  } catch {
    return { ok: false, code: 'network', message: NETWORK_MESSAGE };
  }
  if (res.status === 200 || res.status === 201) {
    try {
      const body = (await res.json()) as { outcome?: unknown; person?: { name?: unknown } };
      const outcome = body.outcome === 'existing' ? 'existing' : 'created';
      return { ok: true, outcome, personName: typeof body.person?.name === 'string' ? body.person.name : '' };
    } catch {
      return { ok: false, code: 'http', message: 'The server sent a reply the extension could not read.' };
    }
  }
  return readError(res);
}

/**
 * One lookup request: is this profile already in the CRM? Never throws. A 404 (an older server without the
 * endpoint), a 401, or a network failure all come back as ok: false, and the chip treats every one as silent.
 */
export async function sendLookup(
  settings: { baseUrl?: unknown; token?: unknown },
  payload: LookupPayload,
  fetchImpl: FetchLike = fetch,
): Promise<LookupResponse> {
  const token = typeof settings.token === 'string' ? settings.token.trim() : '';
  if (token === '') return { ok: false, code: 'unconfigured', message: CONFIG_MESSAGE };
  let res: Response;
  try {
    // Only the two fields the endpoint accepts are sent, whatever the caller passed in.
    const body = { source: payload.source, url: payload.url };
    res = await postJson(normalizeBaseUrl(settings.baseUrl), '/api/capture/lookup', token, body, fetchImpl);
  } catch {
    return { ok: false, code: 'network', message: NETWORK_MESSAGE };
  }
  if (res.status === 200) {
    try {
      // The reply is { exists } and nothing else; anything beyond a literal true counts as not found.
      const body = (await res.json()) as { exists?: unknown };
      return { ok: true, exists: body.exists === true };
    } catch {
      return { ok: false, code: 'http', message: 'The server sent a reply the extension could not read.' };
    }
  }
  return readError(res);
}

export type VerifyResult = { ok: true; workspace: string } | { ok: false; message: string };

/** Test connection: uses the values passed in, which may not be saved yet. */
export async function verifyConnection(
  baseUrl: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<VerifyResult> {
  if (token.trim() === '') return { ok: false, message: 'Paste the capture token first.' };
  let res: Response;
  try {
    res = await postJson(normalizeBaseUrl(baseUrl), '/api/capture/verify', token.trim(), undefined, fetchImpl);
  } catch {
    return { ok: false, message: NETWORK_MESSAGE };
  }
  if (res.status === 200) {
    try {
      const body = (await res.json()) as { workspace?: unknown };
      const w = body.workspace;
      const name = typeof w === 'string' ? w : typeof (w as { name?: unknown } | null)?.name === 'string' ? (w as { name: string }).name : '';
      return { ok: true, workspace: name };
    } catch {
      return { ok: false, message: 'The server sent a reply the extension could not read.' };
    }
  }
  const error = await readError(res);
  return { ok: false, message: error.code === 'unauthorized' ? 'The server rejected the token.' : error.message };
}
