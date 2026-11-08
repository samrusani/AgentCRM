import type { Db } from './db.js';
import { validationError } from './errors.js';
import type { IdPrefix } from './ids.js';
import {
  type AttributeDef,
  type AttributeEntityType,
  type AttributeKind,
  listAttributeDefs,
  readStoredValue,
} from './queries/attributes.js';

// The five person attributes every workspace starts with. Ordinary rows after that: the user may rename or delete them.
// Migration 025 inserts the same five for existing workspaces.
export const seededPersonAttributes: readonly { key: string; label: string; kind: AttributeKind; description: string }[] = [
  { key: 'message-angle', label: 'Message angle', kind: 'text', description: 'The outreach angle to lead with for this person.' },
  { key: 'fit-notes', label: 'Fit notes', kind: 'text', description: 'If and how this investor fits what you are raising for.' },
  { key: 'research-notes', label: 'Research notes', kind: 'text', description: 'Free form research notes.' },
  { key: 'minimum-check-size', label: 'Minimum check size', kind: 'money', description: 'The smallest check this investor writes.' },
  { key: 'maximum-check-size', label: 'Maximum check size', kind: 'money', description: 'The largest check this investor writes.' },
];

export function seedPersonAttributes(
  db: Db,
  workspaceId: string,
  now: string,
  newId: (prefix: IdPrefix) => string,
): void {
  const insert = db.prepare(
    `INSERT INTO attribute_def (id, created_at, workspace_id, version, entity_type, key, label, kind, description, seq, updated_at)
     VALUES (?, ?, ?, 1, 'person', ?, ?, ?, ?, ?, ?)`,
  );
  seededPersonAttributes.forEach((entry, index) => {
    insert.run(newId('atd'), now, workspaceId, entry.key, entry.label, entry.kind, entry.description, index + 1, now);
  });
}

export const maxAttributeKeyLength = 64;
export const maxTextAttributeLength = 2000;
export const maxMoneyAmount = 1_000_000_000_000;

// Lowercase, runs of anything but letters and digits become one hyphen, hyphens trimmed, at most 64 characters.
export function slugifyLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxAttributeKeyLength).replace(/-+$/g, '');
}

// The key for a new definition: the slug, with -2, -3 and so on when the workspace already uses it for this entity type.
export function uniqueAttributeKey(db: Db, workspaceId: string, entityType: AttributeEntityType, label: string): string {
  const base = slugifyLabel(label);
  if (base === '') throw validationError('label: The label needs at least one letter or number.');
  const taken = new Set(listAttributeDefs(db, workspaceId, entityType).map((def) => def.key));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, maxAttributeKeyLength - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// An attribute is addressed in a fields envelope as attr:<key>.
const attributeFieldPattern = /^attr:([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function attributeKeyOfField(field: string): string | null {
  const match = attributeFieldPattern.exec(field);
  return match && match[1]!.length <= maxAttributeKeyLength ? match[1]! : null;
}

// What an edit writes for one definition: the stored text and currency, or null to clear.
export interface StoredAttributeValue {
  value: string;
  currency: string;
}

// The value as a field change shows it: text as a string, number as a number, money as { amount, currency }.
export type AttributeFieldValue = string | number | { amount: number; currency: string } | null;

export interface AttributeChange {
  def: AttributeDef;
  field: string;
  from: AttributeFieldValue;
  to: AttributeFieldValue;
  stored: StoredAttributeValue | null;
}

const currencyPattern = /^[A-Za-z]{3}$/;

// Validates one raw value against its definition. Null clears. Throws a validation error naming the field.
export function normalizeAttributeValue(def: AttributeDef, raw: unknown): StoredAttributeValue | null {
  const field = `attr:${def.key}`;
  if (raw === null) return null;
  if (def.kind === 'text') {
    if (typeof raw !== 'string') throw validationError(`${field}: ${def.label} takes text.`);
    const text = raw.trim();
    if (text.length > maxTextAttributeLength) {
      throw validationError(`${field}: ${def.label} is limited to ${maxTextAttributeLength} characters.`);
    }
    return text === '' ? null : { value: text, currency: 'USD' };
  }
  if (def.kind === 'number') {
    let parsed: number;
    if (typeof raw === 'number') parsed = raw;
    else if (typeof raw === 'string') {
      const text = raw.trim();
      if (text === '') return null;
      // Only plain decimal spellings: a hex, binary, or octal literal is refused, never silently converted.
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
        throw validationError(`${field}: ${def.label} takes a plain number.`);
      }
      parsed = Number(text);
    } else throw validationError(`${field}: ${def.label} takes a number.`);
    if (!Number.isFinite(parsed)) throw validationError(`${field}: ${def.label} takes a finite number.`);
    return { value: String(parsed), currency: 'USD' };
  }
  let amount: unknown = raw;
  let currency = 'USD';
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const entry = raw as Record<string, unknown>;
    const extra = Object.keys(entry).filter((key) => key !== 'amount' && key !== 'currency');
    if (extra.length > 0) throw validationError(`${field}: ${def.label} takes { amount, currency } only.`);
    amount = entry.amount;
    if (entry.currency !== undefined) {
      if (typeof entry.currency !== 'string' || !currencyPattern.test(entry.currency.trim())) {
        throw validationError(`${field}: The currency must be a three letter code.`);
      }
      currency = entry.currency.trim().toUpperCase();
    }
  }
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > maxMoneyAmount) {
    throw validationError(`${field}: ${def.label} takes a whole number of zero or more.`);
  }
  return { value: String(amount), currency };
}

export function fieldValueOf(kind: AttributeKind, stored: StoredAttributeValue | null): AttributeFieldValue {
  if (stored === null) return null;
  const typed = readStoredValue(kind, stored.value);
  return kind === 'money' ? { amount: typed as number, currency: stored.currency } : typed;
}

// Resolves attr:<key> fields against the live definitions for the entity type, validates each by kind, and returns the
// ones that differ from what the record holds now. An unknown key is a validation error naming it. Runs inside the
// writing transaction so a definition deleted between a proposal and its apply is refused.
export function resolveAttributeChanges(
  db: Db,
  workspaceId: string,
  entityType: AttributeEntityType,
  entityId: string,
  fields: Record<string, unknown>,
): AttributeChange[] {
  const entries = Object.entries(fields);
  if (entries.length === 0) return [];
  const defs = new Map(listAttributeDefs(db, workspaceId, entityType).map((def) => [def.key, def]));
  const changes: AttributeChange[] = [];
  for (const [field, raw] of entries) {
    if (raw === undefined) continue;
    const key = attributeKeyOfField(field);
    const def = key === null ? undefined : defs.get(key);
    if (!def) throw validationError(`${field}: There is no custom attribute with this key on ${entityType === 'person' ? 'people' : 'organizations'}.`);
    const stored = normalizeAttributeValue(def, raw);
    const row = db
      .prepare('SELECT value, currency FROM attribute_value WHERE attribute_id = ? AND entity_id = ? AND workspace_id = ?')
      .get(def.id, entityId, workspaceId) as { value: string; currency: string } | undefined;
    const from = fieldValueOf(def.kind, row ? { value: row.value, currency: row.currency } : null);
    const to = fieldValueOf(def.kind, stored);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ def, field, from, to, stored });
  }
  return changes;
}

export function writeAttributeValues(db: Db, workspaceId: string, entityId: string, changes: AttributeChange[], now: string): void {
  for (const change of changes) {
    if (change.stored === null) {
      db.prepare('DELETE FROM attribute_value WHERE attribute_id = ? AND entity_id = ? AND workspace_id = ?').run(
        change.def.id,
        entityId,
        workspaceId,
      );
    } else {
      db.prepare(
        `INSERT INTO attribute_value (attribute_id, entity_id, workspace_id, value, currency, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (attribute_id, entity_id) DO UPDATE SET value = excluded.value, currency = excluded.currency, updated_at = excluded.updated_at`,
      ).run(change.def.id, entityId, workspaceId, change.stored.value, change.stored.currency, now);
    }
  }
}
