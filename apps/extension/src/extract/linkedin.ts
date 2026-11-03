import { attempt, cleanText, compact, validEmail } from './common';

export interface LinkedinProfile {
  name: string;
  headline?: string;
  company?: string;
  location?: string;
  email?: string;
}

type Layer = Partial<LinkedinProfile>;

/** Returns the profile id for a `/in/<id>` path, otherwise null. Mirrors the server's normalizeProfileUrl. */
export function isProfilePath(pathname: string): string | null {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Keep the raw path when it is not valid percent encoding.
  }
  const match = /^\/in\/([^/]+)\/?/.exec(decoded);
  return match && match[1] ? match[1] : null;
}

/** The guaranteed floor: the profile id with dashes and dots turned into spaces. */
export function nameFromId(id: string): string {
  return cleanText(id.replace(/[-.]+/g, ' ')) ?? id;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findPerson(node: unknown): Record<string, unknown> | undefined {
  for (const item of asArray(node)) {
    if (!isObject(item)) continue;
    const type = item['@type'];
    if (asArray(type).includes('Person')) return item;
    const nested = findPerson(item['@graph']);
    if (nested) return nested;
  }
  return undefined;
}

function addressText(address: unknown): string | undefined {
  if (typeof address === 'string') return cleanText(address);
  if (!isObject(address)) return undefined;
  const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
    .map((part) => cleanText(part))
    .filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** The `/in/<id>` segment a URL-ish string names, lowercased and percent decoded, or null when it names none. */
function profileIdIn(value: string): string | null {
  const match = /\/in\/([^/?#\s]+)/i.exec(value);
  if (!match || !match[1]) return null;
  let id = match[1];
  try {
    id = decodeURIComponent(id);
  } catch {
    // Keep the raw segment when it is not valid percent encoding.
  }
  return id.toLowerCase();
}

/** True when any string names a `/in/` profile other than the one in the address bar. */
function namesOtherProfile(values: unknown[], ownId: string): boolean {
  return values.some((value) => {
    if (typeof value !== 'string') return false;
    const id = profileIdIn(value);
    return id !== null && id !== ownId.toLowerCase();
  });
}

/** Head signals that describe a profile: true when og:url or the canonical link names a different one. */
function headIsStale(doc: Document, ownId: string): boolean {
  const og = doc.querySelector('meta[property="og:url"]')?.getAttribute('content') ?? '';
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '';
  return namesOtherProfile([og, canonical], ownId);
}

// Page titles and headings of interstitial or error views. They are never a person's name.
const NOT_A_NAME = new Set(['page not found', 'profile not found', 'sign up', 'sign in', 'join linkedin', 'linkedin']);

function usableName(name: string | undefined): string | undefined {
  return name !== undefined && NOT_A_NAME.has(name.trim().toLowerCase()) ? undefined : name;
}

function fromJsonLd(doc: Document, ownId: string | null): Layer {
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    const parsed = attempt(() => JSON.parse(script.textContent ?? '') as unknown);
    const person = findPerson(parsed);
    if (!person) continue;
    // A Person whose own url names another profile is the previous page's head, not this one.
    if (ownId !== null && namesOtherProfile([person.url, ...asArray(person.sameAs), person['@id']], ownId)) continue;
    const works = asArray(person.worksFor).find(isObject);
    return {
      name: cleanText(person.name),
      headline: cleanText(asArray(person.jobTitle)[0]),
      company: works ? cleanText(works.name) : undefined,
      location: addressText(person.address),
      email: validEmail(person.email),
    };
  }
  return {};
}

/** Parses "Name - Title | LinkedIn" or "Name | LinkedIn". */
export function parseTitle(raw: string): Layer {
  const text = raw.replace(/^\(\d+\)\s*/, '');
  const stripped = text.replace(/\s*\|\s*LinkedIn\s*$/i, '');
  if (stripped === text) return {};
  const split = stripped.indexOf(' - ');
  if (split === -1) return { name: cleanText(stripped) };
  return { name: cleanText(stripped.slice(0, split)), headline: cleanText(stripped.slice(split + 3)) };
}

function fromTitle(doc: Document): Layer {
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const fromOg = og ? parseTitle(og) : {};
  if (usableName(fromOg.name)) return fromOg;
  const fromDocTitle = doc.title ? parseTitle(doc.title) : {};
  return usableName(fromDocTitle.name) ? fromDocTitle : {};
}

function fromHeading(doc: Document): Layer {
  return { name: usableName(cleanText(doc.querySelector('h1')?.textContent)) };
}

/**
 * Layered extraction: JSON-LD Person, then og:title, then the page heading, then the id from the URL.
 * Each layer may fail or be empty; earlier layers win per field. Never throws.
 */
export function extractLinkedinProfile(doc: Document, url: URL): LinkedinProfile {
  const id = isProfilePath(url.pathname);
  // Both sites swap pages in place, so the head can still describe the previous profile. A head that names a
  // different profile than the address bar is dropped whole and the capture degrades to the floor.
  const stale = id !== null && (attempt(() => headIsStale(doc, id)) ?? false);
  const layers = stale
    ? []
    : [() => fromJsonLd(doc, id), () => fromTitle(doc), () => fromHeading(doc)].map((layer) => attempt(layer) ?? {});
  const pick = <K extends keyof Layer>(key: K): Layer[K] => layers.map((layer) => layer[key]).find((v) => v !== undefined);
  const name = pick('name') ?? (id ? nameFromId(id) : 'Unknown');
  return compact({
    name,
    headline: pick('headline'),
    company: pick('company'),
    location: pick('location'),
    email: pick('email'),
  });
}

/**
 * The element the chip sits next to: the profile name heading, the same first h1 the heading layer above reads.
 * Pure over the document. Null when the page has no h1 yet (profile pages render the header late).
 */
export function findLinkedinNameAnchor(doc: Document): Element | null {
  return doc.querySelector('h1');
}
