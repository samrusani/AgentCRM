export interface MappedRow {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  company: string | null;
  domain: string | null;
  title: string | null;
  location: string | null;
  linkedinUrl: string | null;
  // Only CSV rows carry tags. Apify items never do.
  tags?: string[];
  // Set to 'organization' on lead capture rows that name an organization. Person rows leave it out.
  kind?: 'organization';
  // Organization rows only: whether the model read the organization as a fund or an operating company.
  orgKind?: 'fund' | 'company';
}

// Item keys the heuristic mapping reads, in priority order. The CSV header suggestions use the same lists.
export const fieldAliases = {
  firstName: ['firstName', 'first_name'],
  lastName: ['lastName', 'last_name'],
  name: ['name', 'fullName', 'full_name'],
  email: ['email', 'emailAddress', 'email_address'],
  company: ['company', 'organization', 'organisation', 'companyName', 'company_name'],
  domain: ['domain', 'companyDomain', 'company_domain'],
  website: ['website', 'companyWebsite', 'company_website', 'url'],
  title: ['title', 'position', 'jobTitle', 'job_title'],
  location: ['location'],
  city: ['city'],
  country: ['country'],
  linkedinUrl: ['linkedinUrl', 'linkedin_url', 'linkedin', 'profileUrl', 'profile_url', 'url'],
} as const;

export type Item = Record<string, unknown>;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed === '' ? null : trimmed.slice(0, max);
}

// Returns the first usable string among the keys. A nested object with a name or title field counts too.
export function pick(item: Item, keys: readonly string[], max: number): string | null {
  for (const key of keys) {
    const value = item[key];
    const direct = clean(value, max);
    if (direct) return direct;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = value as Item;
      const inner = clean(nested.name, max) ?? clean(nested.title, max);
      if (inner) return inner;
    }
  }
  return null;
}

function pickEmail(item: Item): string | null {
  const candidates: unknown[] = fieldAliases.email.map((key) => item[key]);
  const list = item.emails;
  if (Array.isArray(list)) {
    const first = list[0];
    candidates.push(
      typeof first === 'object' && first !== null ? ((first as Item).email ?? (first as Item).address) : first,
    );
  } else {
    candidates.push(list);
  }
  for (const candidate of candidates) {
    const value = clean(candidate, 200)?.toLowerCase();
    if (value && emailPattern.test(value)) return value;
  }
  return null;
}

export function hostnameOf(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return host.includes('.') ? host.slice(0, 200) : null;
  } catch {
    return null;
  }
}

function pickDomain(item: Item): string | null {
  // A LinkedIn profile or company page is never the company's own domain, however the column was mapped.
  const direct = pick(item, fieldAliases.domain, 200);
  if (direct && !/linkedin\.com/i.test(direct)) return hostnameOf(direct);
  for (const key of fieldAliases.website) {
    const value = clean(item[key], 500);
    if (!value || /linkedin\.com/i.test(value)) continue;
    const host = hostnameOf(value);
    if (host) return host;
  }
  return null;
}

function pickLinkedin(item: Item): string | null {
  for (const key of fieldAliases.linkedinUrl) {
    const value = clean(item[key], 500);
    if (value && /linkedin\.com/i.test(value)) return value;
  }
  return null;
}

function pickLocation(item: Item): string | null {
  const direct = clean(item.location, 200);
  if (direct) return direct;
  const parts = [clean(item.city, 100), clean(item.country, 100)].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(', ') : null;
}

export function splitName(name: string): { firstName: string; lastName: string } {
  const [first = '', ...rest] = name.trim().split(/\s+/);
  return { firstName: first.slice(0, 100), lastName: rest.join(' ').slice(0, 100) };
}

// Heuristic mapping for common lead scraper output. Unmapped keys stay in the raw item.
export function mapItem(raw: unknown): MappedRow {
  const item: Item = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Item) : {};
  const firstPart = pick(item, fieldAliases.firstName, 100);
  const lastPart = pick(item, fieldAliases.lastName, 100);
  const joined = [firstPart, lastPart].filter((part): part is string => part !== null).join(' ');
  const name = pick(item, fieldAliases.name, 200) ?? (joined === '' ? null : joined);
  const split = name ? splitName(name) : null;
  return {
    name,
    firstName: split ? split.firstName : null,
    lastName: split ? split.lastName : null,
    email: pickEmail(item),
    company: pick(item, fieldAliases.company, 200),
    domain: pickDomain(item),
    title: pick(item, fieldAliases.title, 200),
    location: pickLocation(item),
    linkedinUrl: pickLinkedin(item),
  };
}

// The key names are compared on: lowercase, combining accents removed ("Société" matches "Societe"; marks of other scripts stay), punctuation as one space.
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
