export function recordLink(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null;
  if (entityType === 'person') return `/relationships?tab=people&person=${entityId}`;
  if (entityType === 'organization') return `/relationships?tab=organizations&org=${entityId}`;
  if (entityType === 'opportunity') return `/pipeline?opportunity=${entityId}`;
  return null;
}

function parseProfileUrl(value: string): URL | null {
  const text = value.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// The link target for a saved profile URL. The server may store a URL without a scheme, so https is assumed.
export function profileHref(value: string | null | undefined): string | null {
  return value ? (parseProfileUrl(value)?.toString() ?? null) : null;
}

// The path form shown in the sheet: /in/jane-doe, /company/acme, /janedoe. Falls back to the stored text.
export function profilePath(value: string | null | undefined): string {
  if (!value) return '';
  const url = parseProfileUrl(value);
  const path = url ? url.pathname.replace(/\/+$/, '') : '';
  return path || value;
}

// The link target for a stored organization domain: https://<domain>. Only a bare host becomes a
// link: anything carrying a scheme, path, query, userinfo, port, or whitespace renders as plain
// text, and so does a purely numeric address, so a hostile stored value never links elsewhere
// than the text it shows.
export function domainHref(value: string | null | undefined): string | null {
  const host = (value ?? '').trim();
  if (/[/?#:@\s]/.test(host)) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) return null;
  // Numeric address spellings (127.1, 0x7f.1) can resolve to loopback or private machines.
  if (host.split('.').every((label) => /^\d+$/.test(label) || /^0x[0-9a-f]+$/i.test(label))) return null;
  return `https://${host}`;
}

// The label shown for a stored website: host plus path, with the scheme, a leading www., and a trailing slash dropped
// (https://www.acme.com/team becomes acme.com/team). Falls back to the stored text when it does not parse.
export function websiteLabel(value: string | null | undefined): string {
  if (!value) return '';
  const url = parseProfileUrl(value);
  if (!url) return value;
  const host = url.host.replace(/^www\./i, '');
  const path = url.pathname.replace(/\/+$/, '');
  return `${host}${path}`;
}

// The link target for a stored website: the stored URL, or null when it does not parse as an http or https URL.
export function websiteHref(value: string | null | undefined): string | null {
  return profileHref(value);
}
