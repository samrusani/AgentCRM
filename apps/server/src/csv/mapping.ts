import { z } from 'zod';
import { fieldAliases, mapItem, type MappedRow } from '../actions/apifyMapping.js';
import { validationError } from '../errors.js';
import { parseCsv, type CsvDelimiter } from './parse.js';

export const csvFields = [
  'firstName',
  'lastName',
  'name',
  'email',
  'company',
  'domain',
  'title',
  'location',
  'linkedinUrl',
  'tags',
  'ignore',
] as const;
export type CsvField = (typeof csvFields)[number];
export type CsvMapping = Record<string, CsvField>;

export const csvMappingSchema = z.record(z.enum(csvFields));

const nameFields: readonly CsvField[] = ['firstName', 'lastName', 'name'];

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizedSet(...lists: readonly (readonly string[])[]): Set<string> {
  return new Set(lists.flat().map(normalizeHeader));
}

// The Apify alias lists plus the header names spreadsheets and CRM exports commonly use.
const headerHints: Record<HintedField, Set<string>> = {
  firstName: normalizedSet(fieldAliases.firstName, ['givenName', 'forename', 'first']),
  lastName: normalizedSet(fieldAliases.lastName, ['surname', 'familyName', 'last']),
  name: normalizedSet(fieldAliases.name, ['contactName', 'person', 'contact']),
  email: normalizedSet(fieldAliases.email, ['mail', 'workEmail', 'businessEmail', 'primaryEmail']),
  company: normalizedSet(fieldAliases.company, ['employer', 'firm', 'fund', 'account']),
  domain: normalizedSet(fieldAliases.domain, fieldAliases.website, ['web', 'site']),
  title: normalizedSet(fieldAliases.title, ['role', 'jobRole', 'jobPosition']),
  location: normalizedSet(fieldAliases.location, fieldAliases.city, fieldAliases.country, ['region', 'state', 'address']),
  linkedinUrl: normalizedSet(fieldAliases.linkedinUrl, ['linkedinProfile', 'linkedinProfileUrl']),
  tags: normalizedSet(['tags', 'tag', 'labels', 'label', 'categories', 'category', 'groups']),
};

type HintedField = Exclude<CsvField, 'ignore'>;
const matchOrder: readonly HintedField[] = ['linkedinUrl', 'firstName', 'lastName', 'name', 'email', 'tags', 'title', 'company', 'location', 'domain'];

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Picks a field per header. Name, email, company, domain, title, linkedin and tags use the first matching column.
// Location can combine several columns such as city and country. Headers with no match are ignored.
// When no header says email, a column whose values mostly look like email addresses is used.
export function suggestMapping(headers: readonly string[], rows: readonly Record<string, string>[] = []): CsvMapping {
  const mapping: CsvMapping = {};
  const taken = new Set<CsvField>();
  for (const header of headers) {
    const key = normalizeHeader(header);
    let chosen: CsvField = 'ignore';
    // "url" alone is ambiguous. Treat LinkedIn headers as LinkedIn first, then websites as domains.
    for (const field of matchOrder) {
      if (!headerHints[field].has(key)) continue;
      if (field === 'linkedinUrl' && key === 'url') continue;
      if (taken.has(field) && field !== 'location') continue;
      chosen = field;
      break;
    }
    if (chosen !== 'ignore') taken.add(chosen);
    mapping[header] = chosen;
  }
  if (!taken.has('email')) {
    for (const header of headers) {
      if (mapping[header] !== 'ignore') continue;
      const values = rows.slice(0, 50).map((row) => (row[header] ?? '').trim()).filter((value) => value !== '');
      if (values.length > 0 && values.filter((value) => emailPattern.test(value)).length / values.length >= 0.6) {
        mapping[header] = 'email';
        break;
      }
    }
  }
  return mapping;
}

export function validateMapping(headers: readonly string[], input: unknown): CsvMapping {
  const parsed = csvMappingSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const column = issue && issue.path.length > 0 ? String(issue.path[0]) : null;
    throw validationError(
      column
        ? `mapping: column "${column}" must be one of ${csvFields.join(', ')}.`
        : 'mapping: give an object that maps each column name to a field.',
    );
  }
  const mapping: CsvMapping = {};
  for (const header of headers) mapping[header] = parsed.data[header] ?? 'ignore';
  for (const header of Object.keys(parsed.data)) {
    if (!headers.includes(header)) throw validationError(`mapping: column "${header}" is not in the file.`);
  }
  const fields = new Set(Object.values(mapping));
  if (!fields.has('email') && !nameFields.some((field) => fields.has(field))) {
    throw validationError('mapping: map at least an email column or a name column (name, first name, or last name).');
  }
  return mapping;
}

const maxTagsPerRow = 20;

function splitTags(value: string): string[] {
  const tags = value
    .split(/[,;]/)
    .map((tag) => tag.trim().replace(/\s+/g, ' ').slice(0, 60))
    .filter((tag) => tag !== '');
  return [...new Set(tags)];
}

// Builds the same mapped shape the Apify heuristics produce, plus tags. Several columns on one field
// resolve to the first non-empty value, except location (joined) and tags (merged).
export function mapCsvRow(row: Record<string, string>, mapping: CsvMapping): MappedRow {
  const item: Record<string, unknown> = {};
  const locations: string[] = [];
  const tags: string[] = [];
  for (const [header, field] of Object.entries(mapping)) {
    const value = (row[header] ?? '').trim();
    if (field === 'ignore' || value === '') continue;
    if (field === 'tags') {
      tags.push(...splitTags(value));
    } else if (field === 'location') {
      if (!locations.includes(value)) locations.push(value);
    } else if (item[field] === undefined) {
      item[field] = value;
    }
  }
  if (locations.length > 0) item.location = locations.join(', ');
  const mapped = mapItem(item);
  return { ...mapped, tags: [...new Set(tags)].slice(0, maxTagsPerRow) };
}

export const sampleSize = 5;

export interface CsvPreview {
  headers: string[];
  delimiter: CsvDelimiter;
  rowCount: number;
  suggestedMapping: CsvMapping;
  sample: Record<string, string>[];
}

export function previewCsv(content: string): CsvPreview {
  const parsed = parseCsv(content);
  return {
    headers: parsed.headers,
    delimiter: parsed.delimiter,
    rowCount: parsed.rows.length,
    suggestedMapping: suggestMapping(parsed.headers, parsed.rows),
    sample: parsed.rows.slice(0, sampleSize),
  };
}
