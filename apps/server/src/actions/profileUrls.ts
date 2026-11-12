import type { Db } from '../db.js';

// Canonical profile URLs for the person.linkedin_url, person.x_url, and organization.linkedin_url columns. Capture,
// lookup, import accept, record edits, and the migration backfill all go through these helpers, so a stored value
// always round trips through the same normalization.

export const linkedinProfileUrlMessage =
  'The LinkedIn link must be a profile link such as https://www.linkedin.com/in/example.';
export const xProfileUrlMessage =
  'The X link must be a profile link such as https://x.com/example, with a handle of 1 to 15 letters, numbers, or underscores.';
export const companyLinkedinUrlMessage =
  'The LinkedIn link must be a company page such as https://www.linkedin.com/company/example.';

export const crunchbaseUrlMessage =
  'The Crunchbase link must be an organization page such as https://www.crunchbase.com/organization/example.';

export function linkedinHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// http or https only, with no userinfo and no port. Shared by the three canonical URL helpers.
function plainWebUrl(url: URL): boolean {
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '' && url.port === '';
}

function parseUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

// "/in/<id>" without host, query, or trailing slash. The host is case insensitive; the id keeps its case
// because some profile ids are case sensitive. Null for anything that is not a profile link.
export function normalizeProfileUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!linkedinHost(url.hostname)) return null;
  const match = /^\/in\/([^/]+)\/?/.exec(safeDecode(url.pathname));
  if (!match || !match[1]) return null;
  return `/in/${match[1]}`;
}

// The raw, still percent encoded /in/ segment of a LinkedIn link. The decoded form from
// normalizeProfileUrl cannot be used to rebuild the URL: a decoded ? or # would cut the stored URL
// short on the next parse and the capture would never match itself again.
export function rawLinkedinSegment(value: string): string | null {
  const url = parseUrl(value);
  if (!url) return null;
  const match = /^\/in\/([^/]+)\/?/.exec(url.pathname);
  return match ? match[1]! : null;
}

// https://www.linkedin.com/in/<id> for a person's LinkedIn profile link, or null when it is not a profile link.
// The id keeps its case and percent encoding.
export function canonicalPersonLinkedinUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !normalizeProfileUrl(value)) return null;
  const parsed = parseUrl(value);
  if (!parsed || !plainWebUrl(parsed)) return null;
  const raw = rawLinkedinSegment(value);
  if (!raw) return null;
  const canonicalUrl = `https://www.linkedin.com/in/${raw}`;
  // The dedupe key comes from the canonical URL itself, so storing and re-reading always agree.
  // Known limit: an id carrying an encoded slash decodes into a path and collapses onto its first
  // segment; real LinkedIn ids never contain one.
  return normalizeProfileUrl(canonicalUrl) ? canonicalUrl : null;
}

// https://www.linkedin.com/company/<slug> for an organization's LinkedIn page, or null for any other link.
// The slug keeps its case and percent encoding; query, fragment, trailing slash, and deeper path are dropped.
// A link whose canonical form would pass 500 characters is refused, the same bound the extraction schema puts on URLs.
export const maxCompanyLinkedinUrlLength = 500;

export function canonicalCompanyLinkedinUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = parseUrl(value);
  if (!url) return null;
  if (!plainWebUrl(url)) return null;
  if (!linkedinHost(url.hostname)) return null;
  const match = /^\/company\/([^/]+)/.exec(url.pathname);
  if (!match || !match[1]) return null;
  const canonicalUrl = `https://www.linkedin.com/company/${match[1]}`;
  return canonicalUrl.length > maxCompanyLinkedinUrlLength ? null : canonicalUrl;
}

// https://www.crunchbase.com/organization/<slug> for an organization's Crunchbase page, or null for any other link.
// Same rules as the company LinkedIn form: the slug keeps its case and percent encoding; query, fragment, trailing
// slash, and deeper path are dropped; a canonical form past 500 characters is refused.
export function canonicalCrunchbaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = parseUrl(value);
  if (!url) return null;
  if (!plainWebUrl(url)) return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'crunchbase.com' && !host.endsWith('.crunchbase.com')) return null;
  const match = /^\/organization\/([^/]+)/.exec(url.pathname);
  if (!match || !match[1]) return null;
  const canonicalUrl = `https://www.crunchbase.com/organization/${match[1]}`;
  return canonicalUrl.length > maxCompanyLinkedinUrlLength ? null : canonicalUrl;
}

// encodeURIComponent throws on a lone surrogate. An identifier that cannot be percent encoded counts as absent.
export function encodeIdentifier(value: string): string | null {
  try {
    return encodeURIComponent(value);
  } catch {
    return null;
  }
}

const reservedXPaths = new Set([
  'home',
  'explore',
  'notifications',
  'messages',
  'search',
  'settings',
  'i',
  'compose',
  'intent',
  'login',
  'signup',
  'about',
  'tos',
  'privacy',
  'jobs',
  'hashtag',
  'share',
  'download',
  'account',
  'logout',
  'lists',
  'bookmarks',
  'help',
  'verified',
  'grok',
]);

const xHosts = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);

export interface XProfile {
  handle: string;
  // Lowercased handle, because X handles are case insensitive.
  key: string;
  url: string;
}

// The profile an X link points at, or null when it is not a profile link.
export function normalizeXProfileUrl(value: unknown): XProfile | null {
  if (typeof value !== 'string') return null;
  const url = parseUrl(value);
  if (!url) return null;
  if (!plainWebUrl(url)) return null;
  if (!xHosts.has(url.hostname.toLowerCase())) return null;
  const handle = url.pathname.split('/')[1] ?? '';
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  if (reservedXPaths.has(handle.toLowerCase())) return null;
  return { handle, key: handle.toLowerCase(), url: `https://x.com/${handle}` };
}

export function canonicalXUrl(value: unknown): string | null {
  return normalizeXProfileUrl(value)?.url ?? null;
}

// Migration 018: fills the new columns from the newest saved claim of each entity whose value passes the same
// canonicalization. A claim that does not parse is skipped, so an older claim that does parse can still win.
export function backfillProfileUrls(db: Db): void {
  const targets: { table: string; entityType: string; field: string; column: string; canonical: (value: string) => string | null }[] = [
    { table: 'person', entityType: 'person', field: 'linkedinUrl', column: 'linkedin_url', canonical: canonicalPersonLinkedinUrl },
    { table: 'person', entityType: 'person', field: 'xUrl', column: 'x_url', canonical: canonicalXUrl },
    { table: 'organization', entityType: 'organization', field: 'linkedinUrl', column: 'linkedin_url', canonical: canonicalCompanyLinkedinUrl },
  ];
  for (const target of targets) {
    const claims = db
      .prepare(
        `SELECT workspace_id, entity_id, value FROM field_claim WHERE entity_type = ? AND field = ?
         ORDER BY entity_id, observed_at DESC, created_at DESC, id DESC`,
      )
      .all(target.entityType, target.field) as { workspace_id: string; entity_id: string; value: string }[];
    const update = db.prepare(`UPDATE ${target.table} SET ${target.column} = ? WHERE id = ? AND workspace_id = ? AND ${target.column} IS NULL`);
    let done = '';
    for (const claim of claims) {
      if (claim.entity_id === done) continue;
      const canonicalUrl = target.canonical(claim.value);
      if (!canonicalUrl) continue;
      update.run(canonicalUrl, claim.entity_id, claim.workspace_id);
      done = claim.entity_id;
    }
  }
}
