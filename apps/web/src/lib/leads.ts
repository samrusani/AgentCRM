import type { LeadCaptureSettings } from '../api/types';

// Client side checks for the LinkedIn lead capture form. The server validates again and its answer is final.

export const MAX_POST_URL_LENGTH = 500;
// A pasted capture reads at most this many characters. The count appears once the text is this close to the limit.
export const MAX_POST_TEXT_LENGTH = 15000;
export const POST_TEXT_COUNT_WINDOW = 1000;
export const DEFAULT_MAX_PEOPLE = 50;
export const MAX_PEOPLE = 500;
export const DEFAULT_ENRICH_LIMIT = 25;
export const MAX_ENRICH_LIMIT = 200;

// The actors the server uses when a field is empty. The server returns the effective ids; these are the fallback.
export const DEFAULT_LEAD_ACTORS: LeadCaptureSettings = {
  postActor: 'apimaestro/linkedin-post-detail',
  reactionsActor: 'harvestapi/linkedin-post-reactions',
  commentsActor: 'harvestapi/linkedin-post-comments',
  profileActor: 'harvestapi/linkedin-profile-scraper',
  companyActor: 'harvestapi/linkedin-company',
  personSearchActor: 'harvestapi/linkedin-profile-search-by-name',
};

export const ACCEPTED_POST_SHAPES =
  'linkedin.com/posts/<name>-activity-<digits> (ugcPost and share work too), linkedin.com/feed/update/urn:li:activity:<digits>, or a lnkd.in short link such as lnkd.in/aBc-12_3 or lnkd.in/p/aBc-12_3';

function linkedinHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Removes the invisible format characters a copy out of a web page or message can carry: soft hyphen, zero width
// spaces and joiners, direction marks and embeddings, word joiner and invisible operators, and the byte order mark.
// String.trim leaves these in, so a field holding only these would otherwise read as filled in.
export function stripInvisible(text: string): string {
  return text.replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
}

// A pasted link is rarely the bare link. A copy out of post text or a message brings invisible formatting characters,
// wrapping quotes or brackets, and trailing punctuation along, and none of those can appear where they sit in an
// accepted post link. They are removed before the shape check, and the tidied link is what the run receives.
// The server still validates whatever it is sent.
export function tidyLink(url: string): string {
  const visible = stripInvisible(url).trim();
  return visible.replace(/^[('"‘“‹«[{<]+/, '').replace(/[.,;:!?'"…’”›»)\]}>]+$/, '');
}

// A bare linkedin.com or lnkd.in link gets https:// in front, so a paste without the scheme works. Anything else stays as typed.
export function withHttps(url: string): string {
  const value = url.trim();
  return /^(?:(?:[a-z0-9-]+\.)*linkedin\.com|(?:www\.)?lnkd\.in)(?:[/?#]|$)/i.test(value) ? `https://${value}` : value;
}

// Same shapes as the server: a post slug ending in -activity-, -ugcPost-, or -share- plus digits, or a feed
// update urn. The link must start with http:// or https://.
export function isLinkedinPostUrl(url: string): boolean {
  const value = url.trim();
  if (value.length === 0 || value.length > MAX_POST_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
    return false;
  }
  if (!linkedinHost(parsed.hostname)) return false;
  const path = safeDecode(parsed.pathname);
  if (/^\/posts\/[^/]+-(?:activity|ugcPost|share)-\d+(?:-[A-Za-z0-9_-]*)?\/?$/.test(path)) return true;
  return /^\/feed\/update\/urn:li:(?:activity|ugcPost|share):\d+\/?$/.test(path);
}

// Same shape as the server: a lnkd.in short link. The run resolves it to the full post link before fetching anything.
// http or https, host lnkd.in or www.lnkd.in, no userinfo and no port, and one slug of 1 to 64 letters, numbers,
// hyphens, or underscores, optionally behind one single letter path section as in lnkd.in/p/<slug> (the LinkedIn
// mobile app's share sheet produces that form). Query and fragment are ignored.
export function isLnkdInShortUrl(url: string): boolean {
  const value = url.trim();
  if (value.length === 0 || value.length > MAX_POST_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
    return false;
  }
  if (parsed.hostname !== 'lnkd.in' && parsed.hostname !== 'www.lnkd.in') return false;
  return /^\/(?:[A-Za-z]\/)?[A-Za-z0-9_-]{1,64}\/?$/.test(parsed.pathname);
}

// A full post link or a short link: what the link field accepts.
export function isPostLink(url: string): boolean {
  return isLinkedinPostUrl(url) || isLnkdInShortUrl(url);
}

// Whole number inside 1..max, or null.
export function parseLimit(value: string, max: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed >= 1 && parsed <= max ? parsed : null;
}
