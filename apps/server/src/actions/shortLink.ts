import { shortLinkTimeoutMilliseconds } from '../config.js';
import { hasExplicitPort, isLinkedinPostUrl } from './leadCaptureMapping.js';
import { linkedinHost } from './profileUrls.js';

// Resolves a lnkd.in short link to the full LinkedIn post link. The code follows redirects itself, one request at a
// time, and reads only the Location header. It never reads a response body, sends no cookies or credentials, and
// never requests a host that is not lnkd.in or linkedin.com.

export const maxShortLinkHops = 5;
const maxLocationCharacters = 2000;
const maxResolvedCharacters = 500;
const redirectStatuses = [301, 302, 303, 307, 308];

export const openInBrowserSentence = 'Open the link in your browser and paste the full post link.';

export type ShortLinkResult = { ok: true; postUrl: string; hops: number } | { ok: false; detail: string };

function fail(reason: string): ShortLinkResult {
  return { ok: false, detail: `${reason} ${openInBrowserSentence}` };
}

function isLnkdInHost(hostname: string): boolean {
  return hostname === 'lnkd.in' || hostname === 'www.lnkd.in';
}

// http or https, no userinfo, no port (an explicit default port is refused by hasExplicitPort on the raw text), and a host that is lnkd.in or LinkedIn's.
function stayedOnLinkedin(url: URL): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username !== '' || url.password !== '' || url.port !== '') return false;
  return isLnkdInHost(url.hostname) || linkedinHost(url.hostname);
}

function leftLinkedin(url: URL): ShortLinkResult {
  const where = url.protocol === 'http:' || url.protocol === 'https:' ? ` to ${url.hostname.slice(0, 100)}` : '';
  return fail(`The short link redirected away from LinkedIn${where}, so it was not followed.`);
}

// Frees the connection without reading anything the server sent.
function discardBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Nothing to free.
  }
}

export async function resolveShortLink(shortUrl: string, fetchImpl: typeof fetch): Promise<ShortLinkResult> {
  let current: URL;
  try {
    current = new URL(shortUrl);
  } catch {
    return fail('The short link is not a valid link.');
  }
  if (!stayedOnLinkedin(current) || hasExplicitPort(shortUrl)) return leftLinkedin(current);
  // The query and fragment of the short link never leave this process: only the host and slug are requested.
  current.search = '';
  current.hash = '';

  for (let hop = 1; hop <= maxShortLinkHops; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(shortLinkTimeoutMilliseconds),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        return fail(`${current.hostname} did not answer in time, and the link was not retried.`);
      }
      return fail(`Could not reach ${current.hostname}, and the link was not retried.`);
    }
    discardBody(response);
    if (!redirectStatuses.includes(response.status)) {
      return fail(`${current.hostname} answered with HTTP ${response.status} instead of a redirect, so the full post link could not be read from it.`);
    }
    const location = response.headers.get('location');
    if (location === null || location === '') return fail(`${current.hostname} sent a redirect without a destination.`);
    if (location.length > maxLocationCharacters) return fail(`The redirect destination was longer than ${maxLocationCharacters} characters.`);
    let target: URL;
    try {
      target = new URL(location, current);
    } catch {
      return fail('The redirect destination was not a valid link.');
    }
    if (!stayedOnLinkedin(target) || hasExplicitPort(location)) return leftLinkedin(target);

    const stripped = new URL(target.href);
    stripped.search = '';
    stripped.hash = '';
    const postUrl = stripped.href;
    if (postUrl.length > maxResolvedCharacters) {
      return fail(`The resolved link was longer than ${maxResolvedCharacters} characters.`);
    }
    if (isLinkedinPostUrl(postUrl)) return { ok: true, postUrl, hops: hop };
    current = target;
  }
  return fail(`The short link did not reach a LinkedIn post within ${maxShortLinkHops} redirects.`);
}

// Tests replace the fetch used by the lead capture run so no run test reaches the network.
let configuredFetch: typeof fetch | null = null;

export function setShortLinkFetch(fetchImpl: typeof fetch | null): void {
  configuredFetch = fetchImpl;
}

export function resolveShortLinkForRun(shortUrl: string): Promise<ShortLinkResult> {
  return resolveShortLink(shortUrl, configuredFetch ?? fetch);
}
