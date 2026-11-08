import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import type { Row } from '../records.js';

export type AttributeEntityType = 'person' | 'organization';
export type AttributeKind = 'text' | 'number' | 'money';

export interface AttributeDef {
  id: string;
  workspaceId: string;
  entityType: AttributeEntityType;
  key: string;
  label: string;
  kind: AttributeKind;
  description: string | null;
  seq: number;
  version: number;
  // How many records hold a value for this definition; the delete confirm states it.
  valueCount: number;
  createdAt: string;
  updatedAt: string;
}

// What a record read carries for one definition. Null values are included so a reader sees every field that exists.
// Money carries its currency (USD while unset); other kinds carry null.
export interface AttributeReading {
  id: string;
  key: string;
  label: string;
  kind: AttributeKind;
  description: string | null;
  value: string | number | null;
  currency: string | null;
}

const defSelect = 'SELECT d.*, (SELECT COUNT(*) FROM attribute_value v WHERE v.attribute_id = d.id) AS value_count FROM attribute_def d';

export function toAttributeDef(row: Row): AttributeDef {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    entityType: row.entity_type as AttributeEntityType,
    key: String(row.key),
    label: String(row.label),
    kind: row.kind as AttributeKind,
    description: row.description === null || row.description === undefined ? null : String(row.description),
    seq: Number(row.seq),
    version: Number(row.version),
    valueCount: Number(row.value_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// Definitions in display order, optionally for one entity type.
export function listAttributeDefs(db: Db, workspaceId: string, entityType?: AttributeEntityType): AttributeDef[] {
  const rows = entityType
    ? db
        .prepare(`${defSelect} WHERE d.workspace_id = ? AND d.entity_type = ? ORDER BY d.seq, d.id`)
        .all(workspaceId, entityType)
    : db.prepare(`${defSelect} WHERE d.workspace_id = ? ORDER BY d.entity_type, d.seq, d.id`).all(workspaceId);
  return (rows as Row[]).map(toAttributeDef);
}

export function getAttributeDef(db: Db, workspaceId: string, id: string): AttributeDef | null {
  const row = db.prepare(`${defSelect} WHERE d.workspace_id = ? AND d.id = ?`).get(workspaceId, id) as Row | undefined;
  return row ? toAttributeDef(row) : null;
}

export function requireAttributeDef(db: Db, workspaceId: string, id: string): AttributeDef {
  const def = getAttributeDef(db, workspaceId, id);
  if (!def) throw notFound('Attribute');
  return def;
}

export function countAttributeValues(db: Db, workspaceId: string, attributeId: string): number {
  return Number(
    (
      db.prepare('SELECT COUNT(*) AS n FROM attribute_value WHERE workspace_id = ? AND attribute_id = ?').get(workspaceId, attributeId) as {
        n: number;
      }
    ).n,
  );
}

// The typed reading of a stored value. Text stays text; number and money come back as numbers.
export function readStoredValue(kind: AttributeKind, value: string): string | number {
  return kind === 'text' ? value : Number(value);
}

// Every definition for the entity type in display order with this record's value (or null). Used by record details and
// by the model facing reads alike, so an agent sees exactly what the sheet shows.
export function getEntityAttributes(db: Db, workspaceId: string, entityType: AttributeEntityType, entityId: string): AttributeReading[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.key, d.label, d.kind, d.description, v.value AS value, v.currency AS currency
       FROM attribute_def d
       LEFT JOIN attribute_value v ON v.attribute_id = d.id AND v.entity_id = ?
       WHERE d.workspace_id = ? AND d.entity_type = ?
       ORDER BY d.seq, d.id`,
    )
    .all(entityId, workspaceId, entityType) as Row[];
  return rows.map((row) => {
    const kind = row.kind as AttributeKind;
    const stored = row.value === null || row.value === undefined ? null : String(row.value);
    return {
      id: String(row.id),
      key: String(row.key),
      label: String(row.label),
      kind,
      description: row.description === null || row.description === undefined ? null : String(row.description),
      value: stored === null ? null : readStoredValue(kind, stored),
      currency: kind === 'money' ? (stored === null ? 'USD' : String(row.currency)) : null,
    };
  });
}
