import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import type { Row } from '../records.js';
import { type FollowupStep, parseSteps } from './followupRules.js';

export interface Sequence {
  id: string;
  workspaceId: string;
  name: string;
  steps: FollowupStep[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toSequence(row: Row): Sequence {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    steps: parseSteps(row.steps),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// Newest first.
export function listSequences(db: Db, workspaceId: string): Sequence[] {
  const rows = db.prepare('SELECT * FROM sequence WHERE workspace_id = ? ORDER BY created_at DESC, id DESC').all(workspaceId) as Row[];
  return rows.map(toSequence);
}

export function getSequence(db: Db, workspaceId: string, id: string): Sequence | null {
  const row = db.prepare('SELECT * FROM sequence WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as Row | undefined;
  return row ? toSequence(row) : null;
}

export function requireSequence(db: Db, workspaceId: string, id: string): Sequence {
  const sequence = getSequence(db, workspaceId, id);
  if (!sequence) throw notFound('Sequence');
  return sequence;
}
