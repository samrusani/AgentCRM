import { attempt, cleanText, compact, textLines, validEmail } from './common';
import { parseContactInfo } from './contactInfo';

export interface LinkedinProfile {
  name: string;
  headline?: string;
  company?: string;
  location?: string;
  email?: string;
  /** From the contact info overlay only, and only when it is open at capture time. */
  phone?: string;
  /** From the contact info overlay only. */
  website?: string;
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

const LINKEDIN_WORD = 'linkedin';

/**
 * Removes a trailing "| LinkedIn" (any case, any whitespace around the pipe) and returns the text before it, or
 * null when the suffix is absent. Linear on purpose: the title is page controlled, and a regex with a whitespace
 * run before the suffix backtracks quadratically.
 */
function stripLinkedinSuffix(text: string): string | null {
  const trimmed = text.trimEnd();
  if (trimmed.length < LINKEDIN_WORD.length || trimmed.slice(-LINKEDIN_WORD.length).toLowerCase() !== LINKEDIN_WORD) return null;
  const before = trimmed.slice(0, -LINKEDIN_WORD.length).trimEnd();
  return before.endsWith('|') ? before.slice(0, -1).trimEnd() : null;
}

/**
 * Parses "Name - Title | LinkedIn" or "Name | LinkedIn". With `split: false` the whole text before the suffix is the
 * name (the document.title format carries no headline, so a spaced hyphen in a name stays in it).
 */
export function parseTitle(raw: string, options: { split?: boolean } = {}): Layer {
  const text = raw.replace(/^\(\d[\d,.]*\+?\)\s*/, '');
  const stripped = stripLinkedinSuffix(text);
  if (stripped === null) return {};
  const split = options.split === false ? -1 : stripped.indexOf(' - ');
  if (split === -1) return { name: cleanText(stripped) };
  return { name: cleanText(stripped.slice(0, split)), headline: cleanText(stripped.slice(split + 3)) };
}

function fromOgTitle(doc: Document): Layer {
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const parsed = og ? parseTitle(og) : {};
  return usableName(parsed.name) ? parsed : {};
}

/**
 * document.title as "<name> | LinkedIn" with a leading "(N) " notification count removed; the whole text is the
 * name, never split on " - ". A title without the literal suffix is not used, and the NOT_A_NAME rejects apply. The signed in SPA serves this and nothing else
 * in the head.
 */
function fromDocumentTitle(doc: Document): Layer {
  const parsed = doc.title ? parseTitle(doc.title, { split: false }) : {};
  return usableName(parsed.name) ? parsed : {};
}

function fromHeading(doc: Document): Layer {
  return { name: usableName(cleanText(doc.querySelector('h1')?.textContent)) };
}

/** Headings (h1 or h2) inside main, in document order. The signed in top card's name is an h2 here. */
function mainHeadings(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll('main h1, main h2'));
}

const sameText = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * The name heading of the top card: the first heading inside main, unless a heading's text is corroborated by a name
 * another layer produced, which then wins. A heading is page content and carries no profile id, so it is checked
 * against the address bar through the links around it instead (see `cardNamesOtherProfile`).
 */
function nameHeading(doc: Document, hints: string[]): Element | null {
  const headings = mainHeadings(doc);
  const corroborated = headings.find((heading) => {
    const text = usableName(cleanText(heading.textContent));
    return text !== undefined && hints.some((hint) => sameText(hint, text));
  });
  return corroborated ?? headings[0] ?? null;
}

/** True when some heading in main (or the page's h1) has the same text as the name. */
function headingMatches(doc: Document, name: string): boolean {
  const candidates = [...mainHeadings(doc), ...Array.from(doc.querySelectorAll('h1'))];
  return candidates.some((heading) => sameText(cleanText(heading.textContent), name));
}

// A short whole line that is a connection degree marker: a digit ordinal such as "2nd", "3rd+", or "2e", with an
// optional leading dot. A line that merely starts with one ("3rd year PhD student") is a headline, not a marker.
const DEGREE_MARKER = /^(?:·\s*)?\d{1,2}\s?(?:st|nd|rd|th|e|er|re|ère|ème|º|ª|°)\+?$/i;
// A follower or connection count by shape: a number written with separators or a plus, then one or two words, so
// "12 382 687 abonnés" and "500+ relations" filter without a word list. The English words are an extra match.
const COUNT_SHAPE = /^(?:\d{1,3}(?:[,.\s\u00a0\u202f]\d{3})+|\d+\+)\s+\p{L}[\p{L}'’.-]*(?:\s+\p{L}[\p{L}'’.-]*)?$/u;
const COUNT_ENGLISH = /^\d[\d,.]*\+?\s+(?:followers?|connections?)$/i;
const CONTACT_INFO_LINE = /^contact info$/i;
const CONTACT_LINK = 'a[href*="/overlay/contact-info" i]';
// How many ancestors above the name heading the top card is looked for.
const TOP_CARD_DEPTH = 8;

/**
 * The top card: the smallest ancestor of the name heading that shows "Contact info" (as text, or as the link to the
 * contact info overlay, which also works in another language). Without that link (a connection the viewer cannot
 * see details for, or markup drift) the heading's third ancestor stands in, never climbing to the body.
 */
function topCardOf(heading: Element, doc: Document): Element | null {
  let node = heading.parentElement;
  for (let depth = 0; node && depth < TOP_CARD_DEPTH && node !== doc.body && node !== doc.documentElement; depth += 1) {
    if ((node.textContent ?? '').includes('Contact info') || node.querySelector(CONTACT_LINK) !== null) return node;
    node = node.parentElement;
  }
  let fallback: Element | null = heading;
  for (let step = 0; step < 3; step += 1) {
    const parent: Element | null = fallback?.parentElement ?? null;
    if (!parent || parent === doc.body || parent === doc.documentElement) break;
    fallback = parent;
  }
  return fallback === heading ? null : fallback;
}

/**
 * True when the top card's own links name `/in/` profiles and NONE of them names the address bar's: the card is the
 * previous profile's, left behind by an SPA swap. A legitimate card can hold links to other profiles (mutual
 * connections), but it always also links its own, through the Contact info overlay link or the name link, so only a
 * card with profile links that all point elsewhere is stale.
 */
function cardNamesOtherProfile(doc: Document, heading: Element, ownId: string | null): boolean {
  if (ownId === null) return false;
  const card = topCardOf(heading, doc);
  const links: Element[] = card ? Array.from(card.querySelectorAll('a[href]')) : [];
  const around = heading.closest('a[href]');
  if (around) links.push(around);
  const ids = links
    .map((link) => profileIdIn(link.getAttribute('href') ?? ''))
    .filter((id): id is string => id !== null);
  return ids.length > 0 && !ids.includes(ownId.toLowerCase());
}

/**
 * Headline and location from the top card's text lines, by position (class names rotate, so nothing label based).
 * Lines after the name line, minus connection degree markers, follower or connection counts, a bare dot, and the
 * "Contact info" line with everything after it. The first line left is the headline and the last line left is the
 * location. Pure over the document; empty when no top card can be found.
 */
export function parseTopCard(doc: Document, heading: Element): { headline?: string; location?: string } {
  const card = topCardOf(heading, doc);
  if (!card) return {};
  const name = cleanText(heading.textContent);
  let lines = textLines(card);
  const contactText = cleanText(card.querySelector(CONTACT_LINK)?.textContent);
  const cut = lines.findIndex((line) => CONTACT_INFO_LINE.test(line) || (contactText !== undefined && line === contactText));
  if (cut >= 0) lines = lines.slice(0, cut);
  const at = lines.findIndex((line) => sameText(line, name));
  if (at >= 0) lines = lines.slice(at + 1);
  const rest = lines.filter(
    (line) =>
      !sameText(line, name) &&
      !line.startsWith('·') &&
      !DEGREE_MARKER.test(line) &&
      !COUNT_SHAPE.test(line) &&
      !COUNT_ENGLISH.test(line),
  );
  return compact({ headline: cleanText(rest[0], 200), location: rest.length > 1 ? cleanText(rest[rest.length - 1], 200) : undefined });
}

/**
 * Layered extraction: JSON-LD Person, then og:title, then the first h1 (logged out and older markup), then the top
 * card heading (the signed in SPA), then document.title, then the id from the URL. Each layer may fail or be empty;
 * earlier layers win per field. When the contact info overlay is open its email and website win over page derived
 * ones and its phone is added. `details: false` skips the text line and overlay reads (the placement poll only
 * needs the name). Never throws.
 */
export function extractLinkedinProfile(doc: Document, url: URL, options: { details?: boolean } = {}): LinkedinProfile {
  const details = options.details !== false;
  const id = isProfilePath(url.pathname);
  // Both sites swap pages in place, so the head can still describe the previous profile. A head that names a
  // different profile than the address bar is dropped whole and the capture degrades to the floor.
  const stale = id !== null && (attempt(() => headIsStale(doc, id)) ?? false);
  let layers: Layer[] = [];
  if (!stale) {
    const jsonLd = attempt(() => fromJsonLd(doc, id)) ?? {};
    const og = attempt(() => fromOgTitle(doc)) ?? {};
    const h1 = attempt(() => fromHeading(doc)) ?? {};
    const docTitle = attempt(() => fromDocumentTitle(doc)) ?? {};
    const hints = [jsonLd.name, og.name, h1.name, docTitle.name].filter((hint): hint is string => hint !== undefined);
    const titleNames = [og.name, docTitle.name].filter((hint): hint is string => hint !== undefined);
    const topCard =
      attempt((): Layer => {
        // A title names the person and no heading matches it: a profile subpage whose first heading is a section
        // title. The whole layer (name, headline, location) is skipped.
        if (titleNames.length > 0 && !titleNames.some((title) => headingMatches(doc, title))) return {};
        const heading = nameHeading(doc, hints);
        if (!heading) return {};
        // The card's own links name another profile than the address bar: the previous profile's card.
        if (cardNamesOtherProfile(doc, heading, id)) return {};
        const name = usableName(cleanText(heading.textContent));
        if (name === undefined) return {};
        return { name, ...(details ? (attempt(() => parseTopCard(doc, heading)) ?? {}) : {}) };
      }) ?? {};
    layers = [jsonLd, og, h1, topCard, docTitle];
  }
  const pick = <K extends keyof Layer>(key: K): Layer[K] => layers.map((layer) => layer[key]).find((v) => v !== undefined);
  const name = pick('name') ?? (id ? nameFromId(id) : 'Unknown');
  const overlay = details ? (attempt(() => parseContactInfo(doc, url)) ?? {}) : {};
  return compact({
    name,
    headline: pick('headline'),
    company: pick('company'),
    location: pick('location'),
    email: overlay.email ?? pick('email'),
    phone: overlay.phone,
    website: overlay.website,
  });
}

/**
 * The element the chip sits next to: the first heading inside main whose trimmed text equals the extracted name,
 * else the first h1 on the page, else the first heading inside main, else null (the chip floats). When a title
 * names the person and no heading matches it (a profile subpage, or a card left over from an SPA swap) the answer
 * is null, so the chip floats instead of sitting on a section title. Pure over the document. Pass the address
 * bar's URL so the name is the one the capture would send; without it the name match step is skipped. Null when
 * the page has not rendered a heading yet (profile pages render the header late).
 */
export function findLinkedinNameAnchor(doc: Document, url?: URL): Element | null {
  const headings = mainHeadings(doc);
  if (url) {
    const name = extractLinkedinProfile(doc, url, { details: false }).name;
    const match = headings.find((heading) => sameText(cleanText(heading.textContent), name));
    if (match) return match;
    const id = isProfilePath(url.pathname);
    const stale = id !== null && (attempt(() => headIsStale(doc, id)) ?? false);
    if (!stale) {
      const titles = [attempt(() => fromOgTitle(doc))?.name, attempt(() => fromDocumentTitle(doc))?.name].filter(
        (title): title is string => title !== undefined,
      );
      if (titles.length > 0 && !titles.some((title) => headingMatches(doc, title))) return null;
    }
  }
  return doc.querySelector('h1') ?? headings[0] ?? null;
}
