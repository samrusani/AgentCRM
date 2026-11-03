import { attempt, cleanText, compact, textPieces } from './common';

export interface XProfile {
  name: string;
  handle: string;
  bio?: string;
  location?: string;
  website?: string;
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const RESERVED = new Set([
  'home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i', 'compose', 'intent',
  'login', 'signup', 'about', 'tos', 'privacy', 'jobs', 'hashtag', 'share', 'download',
  'account', 'logout', 'lists', 'bookmarks', 'help', 'verified', 'grok',
]);
// Sub pages of a profile that still show the profile header.
const PROFILE_TABS = new Set(['with_replies', 'highlights', 'media', 'articles', 'superfollows', 'likes']);

/** Returns the handle for a path whose first segment is a valid, non reserved handle. Mirrors the server. */
export function isProfilePath(pathname: string): string | null {
  const first = pathname.split('/')[1] ?? '';
  if (!HANDLE.test(first) || RESERVED.has(first.toLowerCase())) return null;
  return first;
}

/** Stricter than the server: true only where the page shows a profile header (the profile or one of its tabs). */
export function isProfileView(pathname: string): string | null {
  const handle = isProfilePath(pathname);
  if (!handle) return null;
  const rest = pathname.split('/').filter((segment) => segment !== '').slice(1);
  if (rest.length === 0) return handle;
  return rest.length === 1 && PROFILE_TABS.has(rest[0]!) ? handle : null;
}

/** The name from "Name (@handle) / X", only when the title's handle is the one in the address bar. */
function nameFromTitle(doc: Document, handle: string): string | undefined {
  const match = /^(?:\(\d+\)\s*)?(.+?)\s*\(@([A-Za-z0-9_]+)\)/.exec(doc.title);
  if (!match || match[2]!.toLowerCase() !== handle.toLowerCase()) return undefined;
  return cleanText(match[1]);
}

/**
 * Reads the header name and handle. `trusted` is false when a header exists but does not name the profile in the
 * address bar (or names none), because the whole header then belongs to another profile.
 */
function fromUserName(doc: Document, handle: string): { name?: string; handle?: string; trusted: boolean } {
  const el = doc.querySelector('[data-testid="UserName"]');
  if (!el) return { trusted: true };
  const pieces = textPieces(el);
  const at = pieces.findIndex((piece) => /^@[A-Za-z0-9_]{1,15}$/.test(piece));
  const domHandle = at >= 0 ? pieces[at]!.slice(1) : undefined;
  if (!domHandle || domHandle.toLowerCase() !== handle.toLowerCase()) return { trusted: false };
  return { name: cleanText(pieces.slice(0, at).join(' ')), handle: domHandle, trusted: true };
}

const NOT_LOCATION = new Set(['UserUrl', 'UserJoinDate', 'UserBirthdate', 'UserProfession']);

function locationOf(doc: Document): string | undefined {
  const header = doc.querySelector('[data-testid="UserProfileHeader_Items"]');
  if (!header) return undefined;
  const explicit = cleanText(header.querySelector('[data-testid="UserLocation"]')?.textContent);
  if (explicit) return explicit;
  for (const item of Array.from(header.children)) {
    if (NOT_LOCATION.has(item.getAttribute('data-testid') ?? '') || item.querySelector('a')) continue;
    const text = cleanText(item.textContent);
    if (text && !/^(Joined|Born)\b/.test(text)) return text;
  }
  return undefined;
}

/** Reads the profile header test ids with the floor of the handle from the URL and the name from the page title. Never throws. */
export function extractXProfile(doc: Document, url: URL): XProfile {
  const pathHandle = isProfilePath(url.pathname) ?? '';
  const user = attempt(() => fromUserName(doc, pathHandle)) ?? { trusted: true };
  const handle = user.handle ?? pathHandle;
  const name = user.name ?? attempt(() => nameFromTitle(doc, pathHandle)) ?? handle;
  // A header for another handle is the previous profile's: nothing in it is read.
  if (!user.trusted) return { name, handle };
  return compact({
    name,
    handle,
    bio: attempt(() => cleanText(doc.querySelector('[data-testid="UserDescription"]')?.textContent, 2000)),
    location: attempt(() => locationOf(doc)),
    website: attempt(() => cleanText(doc.querySelector('[data-testid="UserUrl"]')?.textContent, 500)),
  });
}
