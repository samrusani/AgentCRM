import type { LeadCaptureSettings } from '../api/types';

// Client side checks for the LinkedIn lead capture form. The server validates again and its answer is final.

export const MAX_POST_URL_LENGTH = 500;
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
};

export const ACCEPTED_POST_SHAPES =
  'linkedin.com/posts/<name>-activity-<digits> (ugcPost and share work too) or linkedin.com/feed/update/urn:li:activity:<digits>';

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

// A bare linkedin.com link gets https:// in front, so a paste without the scheme works. Anything else stays as typed.
export function withHttps(url: string): string {
  const value = url.trim();
  return /^(?:[a-z0-9-]+\.)*linkedin\.com(?:[/?#]|$)/i.test(value) ? `https://${value}` : value;
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

// Whole number inside 1..max, or null.
export function parseLimit(value: string, max: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed >= 1 && parsed <= max ? parsed : null;
}
