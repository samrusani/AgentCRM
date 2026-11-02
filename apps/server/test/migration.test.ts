import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db.js';
import { migrationsDirectory } from '../src/paths.js';

type Snapshot = Record<string, unknown>[];

const batches = [
  {
    id: 'imp_alpha',
    created_at: '2026-01-02T03:04:05.001Z',
    workspace_id: 'wsp_1',
    run_id: 'run_alpha',
    source_kind: 'apify',
    source_ref: '{"actorId":"acme/leads","apifyRunId":"abc123","datasetId":"ds_9"}',
    status: 'awaiting_review',
    counts: '{"fetched":5,"staged":2,"duplicates":1,"invalid":1,"accepted":0,"rejected":1}',
    updated_at: '2026-01-02T03:05:06.002Z',
  },
  {
    id: 'imp_bravo',
    created_at: '2026-01-03T04:05:06.003Z',
    workspace_id: 'wsp_1',
    run_id: 'run_bravo',
    source_kind: 'apify',
    source_ref: '{"actorId":"acme/people","datasetId":"ds_10"}',
    status: 'accepted',
    counts: '{"fetched":2,"staged":0,"duplicates":0,"invalid":0,"accepted":2,"rejected":0}',
    updated_at: '2026-01-03T04:09:10.004Z',
  },
  {
    id: 'imp_charlie',
    created_at: '2026-01-04T05:06:07.005Z',
    workspace_id: 'wsp_2',
    run_id: 'run_charlie',
    source_kind: 'apify',
    source_ref: '{"actorId":"acme/other"}',
    status: 'failed',
    counts: '{"fetched":1,"staged":0,"duplicates":0,"invalid":1,"accepted":0,"rejected":0}',
    updated_at: '2026-01-04T05:07:08.006Z',
  },
];

const rows = [
  {
    id: 'row_a1',
    created_at: '2026-01-02T03:04:06.001Z',
    batch_id: 'imp_alpha',
    seq: 1,
    raw: '{"fullName":"Ada Quill","email":"ada@northwind.example.com"}',
    mapped: '{"name":"Ada Quill","email":"ada@northwind.example.com","company":"Northwind"}',
    status: 'staged',
    match_entity_type: 'organization',
    match_entity_id: 'org_known',
    reason: 'The organization already exists, so the person will link to it.',
  },
  {
    id: 'row_a2',
    created_at: '2026-01-02T03:04:06.002Z',
    batch_id: 'imp_alpha',
    seq: 2,
    raw: '{"fullName":"Ben Marsh"}',
    mapped: '{"name":"Ben Marsh","email":null}',
    status: 'duplicate',
    match_entity_type: 'person',
    match_entity_id: 'per_known',
    reason: 'Email matches an existing person.',
  },
  {
    id: 'row_a3',
    created_at: '2026-01-02T03:04:06.003Z',
    batch_id: 'imp_alpha',
    seq: 3,
    raw: '{"note":"nothing usable"}',
    mapped: '{"name":null,"email":null}',
    status: 'invalid',
    match_entity_type: null,
    match_entity_id: null,
    reason: 'No name or email found in this row.',
  },
  {
    id: 'row_a4',
    created_at: '2026-01-02T03:04:06.004Z',
    batch_id: 'imp_alpha',
    seq: 4,
    raw: '{"fullName":"Cy Dunn"}',
    mapped: '{"name":"Cy Dunn"}',
    status: 'rejected',
    match_entity_type: null,
    match_entity_id: null,
    reason: 'Rejected at review.',
  },
  {
    id: 'row_b1',
    created_at: '2026-01-03T04:05:07.001Z',
    batch_id: 'imp_bravo',
    seq: 1,
    raw: '{"fullName":"Dee Frost"}',
    mapped: '{"name":"Dee Frost","title":"Partner","location":"Port Alder, Aurelia"}',
    status: 'accepted',
    match_entity_type: 'person',
    match_entity_id: 'per_new',
    reason: null,
  },
  {
    id: 'row_b2',
    created_at: '2026-01-03T04:05:07.002Z',
    batch_id: 'imp_bravo',
    seq: 2,
    raw: '{"fullName":"Eli Ward"}',
    mapped: '{"name":"Eli Ward","linkedinUrl":"https://www.linkedin.com/in/eli"}',
    status: 'accepted',
    match_entity_type: 'person',
    match_entity_id: 'per_new2',
    reason: null,
  },
  {
    id: 'row_c1',
    created_at: '2026-01-04T05:06:08.001Z',
    batch_id: 'imp_charlie',
    seq: 1,
    raw: '{}',
    mapped: '{}',
    status: 'invalid',
    match_entity_type: null,
    match_entity_id: null,
    reason: 'Empty item.',
  },
];

function snapshot(db: Database.Database, table: string): Snapshot {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Snapshot;
}

function insert(db: Database.Database, table: string, record: Record<string, unknown>): void {
  const columns = Object.keys(record);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(record));
}

function tableSql(db: Database.Database, name: string): string {
  return String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql);
}

describe('migration 003', () => {
  it('copies every import batch and row unchanged, keeps keys and indexes, and allows csv batches', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of ['001_init.sql', '002_apify.sql']) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      for (const workspace of ['wsp_1', 'wsp_2']) {
        db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run(workspace, '2026-01-01', `Workspace ${workspace}`, 't');
      }
      for (const batch of batches) {
        db.prepare("INSERT INTO run (id, created_at, workspace_id, kind, title, status) VALUES (?, '2026-01-01', ?, 'apify_scrape', 'r', 'succeeded')").run(batch.run_id, batch.workspace_id);
        insert(db, 'import_batch', batch);
      }
      for (const row of rows) insert(db, 'import_row', row);

      const batchesBefore = snapshot(db, 'import_batch');
      const rowsBefore = snapshot(db, 'import_row');
      // Every seeded value is read back before the migration, so the comparison below starts from the intended data.
      expect(batchesBefore).toEqual([...batches].sort((a, b) => a.id.localeCompare(b.id)));
      expect(rowsBefore).toEqual([...rows].sort((a, b) => a.id.localeCompare(b.id)));

      expect(applyMigrations(db)).toEqual(['003_csv_qualify.sql', '004_lookup_indexes.sql']);

      expect(snapshot(db, 'import_batch')).toEqual(batchesBefore);
      expect(snapshot(db, 'import_row')).toEqual(rowsBefore);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);

      // Foreign keys point at the final table names, not the temporary ones.
      const rowKeys = db.pragma('foreign_key_list(import_row)') as { table: string; from: string; to: string }[];
      expect(rowKeys.map((key) => [key.table, key.from, key.to])).toEqual([['import_batch', 'batch_id', 'id']]);
      const batchKeys = (db.pragma('foreign_key_list(import_batch)') as { table: string; from: string; to: string }[])
        .map((key) => [key.table, key.from, key.to])
        .sort();
      expect(batchKeys).toEqual([
        ['run', 'run_id', 'id'],
        ['workspace', 'workspace_id', 'id'],
      ]);
      expect(tableSql(db, 'import_row')).not.toContain('_new');
      expect(tableSql(db, 'import_batch')).not.toContain('_new');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%\\_new' ESCAPE '\\'").all()).toEqual([]);

      // The unique constraint on (batch_id, seq) survives the rebuild.
      const uniqueIndexes = (db.pragma('index_list(import_row)') as { name: string; unique: number; origin: string }[]).filter(
        (index) => index.unique === 1 && index.origin === 'u',
      );
      expect(uniqueIndexes).toHaveLength(1);
      const uniqueColumns = (db.pragma(`index_info(${uniqueIndexes[0]!.name})`) as { name: string }[]).map((column) => column.name);
      expect(uniqueColumns).toEqual(['batch_id', 'seq']);
      expect(() => insert(db, 'import_row', { ...rows[0], id: 'row_dupe' })).toThrow(/UNIQUE/);

      // Index names and the columns they cover.
      const indexColumns = (table: string, name: string): (string | null)[] | null => {
        const found = (db.pragma(`index_list(${table})`) as { name: string }[]).find((index) => index.name === name);
        return found ? (db.pragma(`index_info(${name})`) as { name: string | null }[]).map((column) => column.name) : null;
      };
      expect(indexColumns('import_batch', 'idx_import_batch_run')).toEqual(['workspace_id', 'run_id']);
      expect(indexColumns('import_row', 'idx_import_row_batch')).toEqual(['batch_id', 'seq']);
      expect(indexColumns('import_row', 'idx_import_row_status')).toEqual(['batch_id', 'status']);
      expect(indexColumns('qualification_result', 'idx_qualification_result_person')).toEqual(['workspace_id', 'person_id']);
      const unique = (db.pragma('index_list(qualification_result)') as { name: string; unique: number }[]).find(
        (index) => index.name === 'idx_qualification_result_person',
      );
      expect(unique?.unique).toBe(1);

      // The widened check accepts csv, still refuses anything else, and the other checks are intact.
      const csvBatch = { ...batches[0]!, id: 'imp_csv', run_id: 'run_alpha', source_kind: 'csv', source_ref: '{"fileName":"leads.csv"}', status: 'staging' };
      insert(db, 'import_batch', csvBatch);
      insert(db, 'import_row', { ...rows[0], id: 'row_csv', batch_id: 'imp_csv' });
      expect(db.prepare('SELECT source_kind FROM import_batch WHERE id = ?').get('imp_csv')).toEqual({ source_kind: 'csv' });
      expect(() => insert(db, 'import_batch', { ...csvBatch, id: 'imp_other', source_kind: 'other' })).toThrow(/CHECK/);
      expect(() => insert(db, 'import_batch', { ...csvBatch, id: 'imp_status', status: 'unknown' })).toThrow(/CHECK/);
      expect(() => insert(db, 'import_row', { ...rows[0], id: 'row_status', seq: 99, status: 'unknown' })).toThrow(/CHECK/);
      expect(() => insert(db, 'import_row', { ...rows[0], id: 'row_type', seq: 98, match_entity_type: 'opportunity' })).toThrow(/CHECK/);
      expect(() => insert(db, 'import_row', { ...rows[0], id: 'row_orphan', batch_id: 'imp_missing', seq: 1 })).toThrow(/FOREIGN KEY/);
      expect(() => insert(db, 'import_batch', { ...csvBatch, id: 'imp_ws', workspace_id: 'wsp_missing' })).toThrow(/FOREIGN KEY/);

      // Migration 004 adds expression indexes, and the uniqueness checks use them instead of scanning.
      expect(indexColumns('person', 'idx_person_email_lower')).toEqual(['workspace_id', null]);
      expect(indexColumns('organization', 'idx_organization_domain_lower')).toEqual(['workspace_id', null]);
      const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT id FROM person WHERE workspace_id = ? AND lower(email) = ? AND id != ?").all('wsp_1', 'a@b.c', '') as { detail: string }[])
        .map((step) => step.detail)
        .join(' ');
      expect(plan).toContain('idx_person_email_lower');

      // New pieces from the same migration.
      expect(db.prepare('SELECT settings FROM workspace WHERE id = ?').get('wsp_1')).toEqual({ settings: null });
      expect(db.prepare('SELECT COUNT(*) AS n FROM qualification_result').get()).toEqual({ n: 0 });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
