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
