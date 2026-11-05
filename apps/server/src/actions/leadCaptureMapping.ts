import { canonicalCompanyLinkedinUrl, linkedinHost, normalizeProfileUrl, safeDecode } from './profileUrls.js';
import { clean, hostnameOf, type Item, mapItem, type MappedRow, normalizeName, splitName } from './apifyMapping.js';

export { normalizeProfileUrl };

export const postUrlShapesMessage =
  'The link must start with http:// or https:// and be a linkedin.com post link. Accepted shapes: https://www.linkedin.com/posts/name-topic-activity-1234567890123456789-AbCd (ugcPost and share slugs work too) and https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789 (urn:li:ugcPost and urn:li:share work too). At most 500 characters';

const maxPostUrlLength = 500;

// Accepts the post shapes the engagement actors understand. The URL itself is passed on as given.
export function isLinkedinPostUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxPostUrlLength) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '' || url.port !== '') {
    return false;
  }
  if (!linkedinHost(url.hostname)) return false;
  const path = safeDecode(url.pathname);
  if (/^\/posts\/[^/]+-(?:activity|ugcPost|share)-\d+(?:-[A-Za-z0-9_-]*)?\/?$/.test(path)) return true;
  return /^\/feed\/update\/urn:li:(?:activity|ugcPost|share):\d+\/?$/.test(path);
}

function isItem(value: unknown): value is Item {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const emptyRow: MappedRow = {
  name: null,
  firstName: null,
  lastName: null,
  email: null,
  company: null,
  domain: null,
  title: null,
  location: null,
  linkedinUrl: null,
};

// Keeps the value only when it parses as an http or https URL on linkedin.com or one of its subdomains.
export function linkedinOnly(value: unknown): string | null {
  const text = clean(value, 500);
  if (!text) return null;
  try {
    const url = new URL(text);
    return (url.protocol === 'https:' || url.protocol === 'http:') && linkedinHost(url.hostname) ? text : null;
  } catch {
    return null;
  }
}

// Reads one reaction or comment item. The engagement actors answer with an `actor` object; the
// `author` object is the fallback shape. Every person field comes from one object, never a mix of both.
export function mapEngagementItem(raw: unknown): MappedRow {
  const item: Item = isItem(raw) ? raw : {};
  const actor = isItem(item.actor) ? item.actor : null;
  const author = isItem(item.author) ? item.author : null;
  const fields = actor
    ? { name: actor.name, title: actor.position, url: actor.linkedinUrl }
    : author
      ? { name: author.name, title: author.headline, url: author.profile_url }
      : { name: undefined, title: undefined, url: undefined };
  const name = clean(fields.name, 200);
  const split = name ? splitName(name) : null;
  return {
    ...emptyRow,
    name,
    firstName: split ? split.firstName : null,
    lastName: split ? split.lastName : null,
    title: clean(fields.title, 200),
    linkedinUrl: linkedinOnly(fields.url),
  };
}

function firstOf(value: unknown): Item | null {
  return Array.isArray(value) && isItem(value[0]) ? value[0] : null;
}

// The organization domain comes only from explicit company fields. A generic website or url field on a
// profile is usually the person's own site, so it is never read.
function companyDomainOf(item: Item): string | null {
  for (const key of ['companyDomain', 'company_domain', 'companyWebsite', 'company_website']) {
    const value = clean(item[key], 500);
    if (!value) continue;
    const host = hostnameOf(value);
    if (host && !linkedinHost(host)) return host;
  }
  return null;
}

// Reads one profile scraper item: the flat heuristic first, then the nested shapes.
export function mapProfileItem(raw: unknown): MappedRow {
  const item: Item = isItem(raw) ? raw : {};
  const base = { ...mapItem(item), domain: companyDomainOf(item) };
  const location = isItem(item.location) ? item.location : null;
  const company = base.company ?? clean(firstOf(item.currentPosition)?.companyName, 200);
  const title = base.title ?? clean(item.headline, 200);
  const next: MappedRow = {
    ...base,
    company,
    title,
    location: base.location ?? clean(location?.linkedinText, 200),
  };
  if (!next.name) {
    const joined = [clean(item.firstName, 100), clean(item.lastName, 100)].filter((part): part is string => part !== null).join(' ');
    if (joined !== '') {
      const split = splitName(joined);
      next.name = joined.slice(0, 200);
      next.firstName = split.firstName;
      next.lastName = split.lastName;
    }
  }
  return next;
}

// Keys an enrichment output item can be matched on, best first: profile URLs, then the public identifier.
export function profileItemKeys(raw: unknown): { profiles: string[]; name: string | null } {
  const item: Item = isItem(raw) ? raw : {};
  const profiles: string[] = [];
  for (const key of ['linkedinUrl', 'linkedin_url', 'profileUrl', 'profile_url', 'url', 'inputUrl']) {
    const profile = normalizeProfileUrl(item[key]);
    if (profile && !profiles.includes(profile)) profiles.push(profile);
  }
  for (const key of ['publicIdentifier', 'public_identifier', 'username']) {
    const id = clean(item[key], 200);
    const profile = id ? normalizeProfileUrl(`https://www.linkedin.com/in/${encodeURIComponent(id)}`) : null;
    if (profile && !profiles.includes(profile)) profiles.push(profile);
  }
  const mapped = mapProfileItem(item);
  return { profiles, name: mapped.name ? normalizeName(mapped.name) : null };
}

export const mergeableFields = ['name', 'email', 'company', 'domain', 'title', 'location', 'linkedinUrl'] as const;
export type MergeableField = (typeof mergeableFields)[number];

// Fills only the fields that are empty in `target`. Name carries its first and last name with it.
// Returns the fields that were filled.
export function fillEmptyFields(target: MappedRow, source: MappedRow): MergeableField[] {
  const filled: MergeableField[] = [];
  for (const field of mergeableFields) {
    if (target[field] === null || target[field] === '') {
      const value = source[field];
      if (value !== null && value !== '') {
        target[field] = value;
        if (field === 'name') {
          target.firstName = source.firstName;
          target.lastName = source.lastName;
        }
        filled.push(field);
      }
    }
  }
  return filled;
}

// What the post actor takes as input: the bare activity id for a /feed/update/urn:li:activity:<digits> link,
// otherwise the link as given.
export function postActorTarget(postUrl: string): string {
  try {
    const path = safeDecode(new URL(postUrl).pathname);
    const match = /^\/feed\/update\/urn:li:activity:(\d+)\/?$/.exec(path);
    if (match?.[1]) return match[1];
  } catch {
    // Fall through to the link as given.
  }
  return postUrl;
}

export interface ExtractedEntry {
  kind: 'person' | 'organization';
  name: string;
  title: string | null;
  company: string | null;
  location: string | null;
  linkedinUrl: string | null;
  // Organization entries only. Left out by the model, it means company.
  orgKind?: 'fund' | 'company' | null | undefined;
  quote: string;
}

// Person entries become person fields. Organization entries put their name in company and carry no person name.
export function mapExtractedEntry(entry: ExtractedEntry): MappedRow {
  if (entry.kind === 'organization') {
    return {
      ...emptyRow,
      kind: 'organization',
      orgKind: entry.orgKind === 'fund' ? 'fund' : 'company',
      company: clean(entry.name, 200),
      location: clean(entry.location, 200),
      // The verification kept this link because it occurs in the post text. Only a company page rides along; a
      // person link on an organization entry would never be a valid company URL.
      linkedinUrl: canonicalCompanyLinkedinUrl(entry.linkedinUrl) ? linkedinOnly(entry.linkedinUrl) : null,
    };
  }
  const name = clean(entry.name, 200);
  const split = name ? splitName(name) : null;
  return {
    ...emptyRow,
    name,
    firstName: split ? split.firstName : null,
    lastName: split ? split.lastName : null,
    title: clean(entry.title, 200),
    company: clean(entry.company, 200),
    location: clean(entry.location, 200),
    linkedinUrl: linkedinOnly(entry.linkedinUrl),
  };
}

// The post item from the post actor: text (with two fallbacks) and the structured author.
export function readPostItem(raw: unknown): { text: string | null; author: Item | null } {
  const item: Item = isItem(raw) ? raw : {};
  const post = isItem(item.post) ? item.post : {};
  const text = [post.text, item.text, item.commentary]
    .map((value) => (typeof value === 'string' && value.trim() !== '' ? value : null))
    .find((value) => value !== null) ?? null;
  return { text, author: isItem(item.author) ? item.author : null };
}
