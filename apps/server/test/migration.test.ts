import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

      expect(applyMigrations(db)).toEqual(['003_csv_qualify.sql', '004_lookup_indexes.sql', '005_anthropic.sql', '006_model_call_markers.sql', '007_agentmail.sql', '008_send_intent_guards.sql', '009_model_providers.sql', '010_lead_capture.sql', '011_workspace_version.sql', '012_mail_providers.sql', '013_microsoft.sql', '014_imap.sql', '015_people_order_index.sql', '016_followup_rules.sql', '017_search_index.sql', '018_profile_urls.sql', '019_lifecycle.sql', '020_lifecycle_indexes.sql', '021_worker_lease.sql', '022_pipelines.sql', '023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql']);

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

describe('migration 005', () => {
  it('keeps connector rows, allows the anthropic kind, and adds model_call', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of ['001_init.sql', '002_apify.sql', '003_csv_qualify.sql', '004_lookup_indexes.sql']) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'Workspace', 't');
      const connector = {
        id: 'con_old',
        created_at: '2026-01-02T03:04:05.001Z',
        workspace_id: 'wsp_1',
        kind: 'apify',
        settings: '{"allowlist":["a/b"],"username":"u"}',
        secret: 'token-value',
        status: 'error',
        updated_at: '2026-01-03T03:04:05.001Z',
      };
      insert(db, 'connector', connector);
      expect(() => insert(db, 'connector', { ...connector, id: 'con_x', kind: 'anthropic' })).toThrow(/CHECK/);

      expect(applyMigrations(db)).toEqual(['005_anthropic.sql', '006_model_call_markers.sql', '007_agentmail.sql', '008_send_intent_guards.sql', '009_model_providers.sql', '010_lead_capture.sql', '011_workspace_version.sql', '012_mail_providers.sql', '013_microsoft.sql', '014_imap.sql', '015_people_order_index.sql', '016_followup_rules.sql', '017_search_index.sql', '018_profile_urls.sql', '019_lifecycle.sql', '020_lifecycle_indexes.sql', '021_worker_lease.sql', '022_pipelines.sql', '023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql']);
      expect(snapshot(db, 'connector')).toEqual([connector]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(tableSql(db, 'connector')).not.toContain('_new');

      insert(db, 'connector', { ...connector, id: 'con_new', kind: 'anthropic', settings: '{"model":"claude-opus-5-5"}' });
      expect(() => insert(db, 'connector', { ...connector, id: 'con_dupe', kind: 'anthropic' })).toThrow(/UNIQUE/);
      expect(() => insert(db, 'connector', { ...connector, id: 'con_bad', kind: 'other' })).toThrow(/CHECK/);

      const call = { id: 'mcl_1', created_at: '2026-01-04', workspace_id: 'wsp_1', run_id: null, purpose: 'chat', model: 'claude-opus-5-5' };
      insert(db, 'model_call', call);
      expect(db.prepare('SELECT input_tokens, output_tokens, cache_read_tokens, estimated_usd FROM model_call').get()).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        estimated_usd: 0,
      });
      expect(db.prepare('SELECT cache_creation_tokens, pending, subject_id FROM model_call').get()).toEqual({
        cache_creation_tokens: 0,
        pending: 0,
        subject_id: null,
      });
      expect(() => insert(db, 'model_call', { ...call, id: 'mcl_2', purpose: 'other' })).toThrow(/CHECK/);
      expect(() => insert(db, 'model_call', { ...call, id: 'mcl_3', run_id: 'run_missing' })).toThrow(/FOREIGN KEY/);
      const indexed = (name: string) => (db.pragma(`index_info(${name})`) as { name: string }[]).map((column) => column.name);
      expect(indexed('idx_model_call_workspace')).toEqual(['workspace_id', 'created_at']);
      expect(indexed('idx_model_call_run')).toEqual(['run_id']);
      expect(indexed('idx_connector_workspace')).toEqual(['workspace_id', 'kind']);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('migration 007', () => {
  it('keeps connector and activity rows, allows the new kinds, and adds the mail tables', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      const earlier = [
        '001_init.sql',
        '002_apify.sql',
        '003_csv_qualify.sql',
        '004_lookup_indexes.sql',
        '005_anthropic.sql',
        '006_model_call_markers.sql',
      ];
      for (const file of earlier) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'Workspace', 't');
      const connector = {
        id: 'con_old',
        created_at: '2026-01-02T03:04:05.001Z',
        workspace_id: 'wsp_1',
        kind: 'anthropic',
        settings: '{"model":"claude-opus-5-5"}',
        secret: 'key-value',
        status: 'connected',
        updated_at: '2026-01-03T03:04:05.001Z',
      };
      insert(db, 'connector', connector);
      const activity = {
        id: 'act_old',
        created_at: '2026-01-02T03:04:05.001Z',
        workspace_id: 'wsp_1',
        entity_type: 'person',
        entity_id: 'per_1',
        kind: 'email_draft',
        body: 'Draft, not sent.',
        actor: 'user',
      };
      insert(db, 'activity', activity);
      expect(() => insert(db, 'activity', { ...activity, id: 'act_x', kind: 'email_out' })).toThrow(/CHECK/);
      expect(() => insert(db, 'connector', { ...connector, id: 'con_x', kind: 'agentmail' })).toThrow(/CHECK/);

      expect(applyMigrations(db)).toEqual(['007_agentmail.sql', '008_send_intent_guards.sql', '009_model_providers.sql', '010_lead_capture.sql', '011_workspace_version.sql', '012_mail_providers.sql', '013_microsoft.sql', '014_imap.sql', '015_people_order_index.sql', '016_followup_rules.sql', '017_search_index.sql', '018_profile_urls.sql', '019_lifecycle.sql', '020_lifecycle_indexes.sql', '021_worker_lease.sql', '022_pipelines.sql', '023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql']);
      expect(snapshot(db, 'connector')).toEqual([connector]);
      expect(snapshot(db, 'activity')).toEqual([activity]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(tableSql(db, 'connector')).not.toContain('_new');
      expect(tableSql(db, 'activity')).not.toContain('_new');

      insert(db, 'connector', { ...connector, id: 'con_mail', kind: 'agentmail', settings: '{}' });
      expect(() => insert(db, 'connector', { ...connector, id: 'con_dupe', kind: 'agentmail' })).toThrow(/UNIQUE/);
      insert(db, 'activity', { ...activity, id: 'act_out', kind: 'email_out' });
      insert(db, 'activity', { ...activity, id: 'act_in', kind: 'email_in' });
      expect(() => insert(db, 'activity', { ...activity, id: 'act_bad', kind: 'other' })).toThrow(/CHECK/);

      const indexed = (name: string) => (db.pragma(`index_info(${name})`) as { name: string }[]).map((column) => column.name);
      expect(indexed('idx_activity_entity')).toEqual(['workspace_id', 'entity_type', 'entity_id', 'created_at']);
      expect(indexed('idx_connector_workspace')).toEqual(['workspace_id', 'kind']);
      expect(indexed('idx_email_message_provider')).toEqual(['workspace_id', 'provider_message_id']);
      expect(indexed('idx_email_message_person')).toEqual(['workspace_id', 'person_id', 'provider_timestamp']);
      expect(indexed('idx_send_intent_status')).toEqual(['workspace_id', 'status']);
      expect(indexed('idx_send_intent_person')).toEqual(['workspace_id', 'person_id']);
      expect(indexed('idx_suppression_email')).toEqual(['workspace_id', 'email']);

      db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, updated_at) VALUES (?, ?, ?, ?, ?)').run('per_1', '2026-01-01', 'wsp_1', 'Ada', '2026-01-01');
      const message = {
        id: 'msg_1',
        created_at: '2026-01-04',
        workspace_id: 'wsp_1',
        provider_message_id: 'pm_1',
        direction: 'in',
        from_email: 'ada@lanternrow.invalid',
        provider_timestamp: '2026-01-04T00:00:00.000Z',
      };
      insert(db, 'email_message', message);
      expect(() => insert(db, 'email_message', { ...message, id: 'msg_2' })).toThrow(/UNIQUE/);
      expect(() => insert(db, 'email_message', { ...message, id: 'msg_3', provider_message_id: 'pm_3', direction: 'sideways' })).toThrow(/CHECK/);
      expect(db.prepare('SELECT "to", labels FROM email_message').get()).toEqual({ to: '[]', labels: '[]' });

      const intent = {
        id: 'snd_1',
        created_at: '2026-01-04',
        workspace_id: 'wsp_1',
        person_id: 'per_1',
        inbox_id: 'inbox',
        to_email: 'ada@lanternrow.invalid',
        subject: 'Hello',
        body: 'Body',
        payload_hash: 'hash',
        updated_at: '2026-01-04',
      };
      insert(db, 'send_intent', intent);
      expect(db.prepare('SELECT status FROM send_intent').get()).toEqual({ status: 'awaiting_approval' });
      expect(() => insert(db, 'send_intent', { ...intent, id: 'snd_2', status: 'delivered' })).toThrow(/CHECK/);
      expect(() => insert(db, 'send_intent', { ...intent, id: 'snd_3', person_id: 'per_missing' })).toThrow(/FOREIGN KEY/);

      const suppression = { id: 'sup_1', created_at: '2026-01-04', workspace_id: 'wsp_1', email: 'ada@lanternrow.invalid', reason: 'bounce' };
      insert(db, 'suppression', suppression);
      expect(() => insert(db, 'suppression', { ...suppression, id: 'sup_2' })).toThrow(/UNIQUE/);
      expect(() => insert(db, 'suppression', { ...suppression, id: 'sup_3', email: 'b@lanternrow.invalid', reason: 'other' })).toThrow(/CHECK/);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('migration 008', () => {
  it('adds the open-intent guard and indexes, cancels extra unapproved duplicates, and backfills acknowledged unknowns', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of [
        '001_init.sql',
        '002_apify.sql',
        '003_csv_qualify.sql',
        '004_lookup_indexes.sql',
        '005_anthropic.sql',
        '006_model_call_markers.sql',
        '007_agentmail.sql',
      ]) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'Workspace', 't');
      db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, updated_at) VALUES (?, ?, ?, ?, ?)').run('per_1', '2026-01-01', 'wsp_1', 'Ada', '2026-01-01');
      for (const id of ['act_1', 'act_2', 'act_3']) {
        insert(db, 'activity', {
          id,
          created_at: '2026-01-02',
          workspace_id: 'wsp_1',
          entity_type: 'person',
          entity_id: 'per_1',
          kind: 'email_draft',
          body: 'Subject: x',
          actor: 'user',
        });
      }
      const intent = (id: string, draft: string | null, status: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
        id,
        created_at: createdAt,
        workspace_id: 'wsp_1',
        person_id: 'per_1',
        draft_activity_id: draft,
        inbox_id: 'inbox',
        to_email: 'ada@lanternrow.invalid',
        subject: 'Über uns',
        body: 'Body',
        payload_hash: 'hash',
        status,
        updated_at: createdAt,
        ...extra,
      });
      // act_1 holds an unknown send and an extra awaiting one. act_2 holds two awaiting ones. act_3 holds an
      // acknowledged unknown send.
      insert(db, 'send_intent', intent('snd_1a', 'act_1', 'unknown', '2026-01-03T00:00:00.000Z'));
      insert(db, 'send_intent', intent('snd_1b', 'act_1', 'awaiting_approval', '2026-01-04T00:00:00.000Z'));
      insert(db, 'send_intent', intent('snd_2a', 'act_2', 'awaiting_approval', '2026-01-03T00:00:00.000Z'));
      insert(db, 'send_intent', intent('snd_2b', 'act_2', 'awaiting_approval', '2026-01-04T00:00:00.000Z'));
      insert(db, 'send_intent', intent('snd_3a', 'act_3', 'cancelled', '2026-01-03T00:00:00.000Z', { error: 'Outcome unknown. Acknowledged by a person. Whether this email was sent was never confirmed.' }));
      insert(db, 'send_intent', intent('snd_3b', 'act_3', 'cancelled', '2026-01-04T00:00:00.000Z', { error: 'The send was rejected.' }));

      expect(applyMigrations(db)).toEqual(['008_send_intent_guards.sql', '009_model_providers.sql', '010_lead_capture.sql', '011_workspace_version.sql', '012_mail_providers.sql', '013_microsoft.sql', '014_imap.sql', '015_people_order_index.sql', '016_followup_rules.sql', '017_search_index.sql', '018_profile_urls.sql', '019_lifecycle.sql', '020_lifecycle_indexes.sql', '021_worker_lease.sql', '022_pipelines.sql', '023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql']);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      const statuses = Object.fromEntries((db.prepare('SELECT id, status FROM send_intent').all() as { id: string; status: string }[]).map((row) => [row.id, row.status]));
      expect(statuses).toEqual({
        snd_1a: 'unknown',
        snd_1b: 'cancelled',
        snd_2a: 'awaiting_approval',
        snd_2b: 'cancelled',
        snd_3a: 'cancelled',
        snd_3b: 'cancelled',
      });
      const acknowledged = db.prepare('SELECT id FROM send_intent WHERE unknown_acknowledged = 1').all();
      expect(acknowledged).toEqual([{ id: 'snd_3a' }]);

      const indexed = (name: string) => (db.pragma(`index_info(${name})`) as { name: string }[]).map((column) => column.name);
      expect(indexed('idx_send_intent_open_draft')).toEqual(['workspace_id', 'draft_activity_id']);
      expect(indexed('idx_send_intent_draft')).toEqual(['draft_activity_id']);
      expect(indexed('idx_send_intent_approval')).toEqual(['approval_id']);
      expect(indexed('idx_send_intent_provider_message')).toEqual(['workspace_id', 'provider_message_id']);
      const list = db.pragma('index_list(send_intent)') as { name: string; unique: number; partial: number }[];
      expect(list.find((index) => index.name === 'idx_send_intent_open_draft')).toMatchObject({ unique: 1, partial: 1 });
      expect(list.find((index) => index.name === 'idx_send_intent_provider_message')).toMatchObject({ unique: 1, partial: 1 });

      // One open intent per draft. Closed intents and intents without a draft are not limited.
      expect(() => insert(db, 'send_intent', intent('snd_x1', 'act_1', 'awaiting_approval', '2026-01-05T00:00:00.000Z'))).toThrow(/UNIQUE/);
      expect(() => insert(db, 'send_intent', intent('snd_x2', 'act_2', 'queued', '2026-01-05T00:00:00.000Z'))).toThrow(/UNIQUE/);
      expect(() => insert(db, 'send_intent', intent('snd_x3', 'act_3', 'cancelled', '2026-01-05T00:00:00.000Z'))).not.toThrow();
      expect(() => insert(db, 'send_intent', intent('snd_x4', null, 'awaiting_approval', '2026-01-05T00:00:00.000Z'))).not.toThrow();
      expect(() => insert(db, 'send_intent', intent('snd_x5', null, 'awaiting_approval', '2026-01-05T00:00:00.000Z'))).not.toThrow();

      // A provider message id belongs to one intent.
      db.prepare("UPDATE send_intent SET provider_message_id = 'pm_1' WHERE id = 'snd_3a'").run();
      expect(() => db.prepare("UPDATE send_intent SET provider_message_id = 'pm_1' WHERE id = 'snd_3b'").run()).toThrow(/UNIQUE/);
      expect(() => db.prepare("UPDATE send_intent SET provider_message_id = NULL WHERE id = 'snd_3b'").run()).not.toThrow();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('migration 009', () => {
  it('keeps connector and model_call rows, allows the new provider kinds and an empty secret, and adds the provider column', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      const earlier = [
        '001_init.sql',
        '002_apify.sql',
        '003_csv_qualify.sql',
        '004_lookup_indexes.sql',
        '005_anthropic.sql',
        '006_model_call_markers.sql',
        '007_agentmail.sql',
        '008_send_intent_guards.sql',
      ];
      for (const file of earlier) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'Workspace', 't');
      db.prepare("INSERT INTO run (id, created_at, workspace_id, kind, title, status) VALUES (?, ?, ?, ?, ?, 'queued')").run('run_1', '2026-01-02', 'wsp_1', 'draft_outreach', 'Draft');
      const connectors = [
        { id: 'con_a', created_at: '2026-01-02T03:04:05.001Z', workspace_id: 'wsp_1', kind: 'apify', settings: '{"allowlist":["a/b"],"username":"u"}', secret: 'token-value', status: 'error', updated_at: '2026-01-03T03:04:05.001Z' },
        { id: 'con_b', created_at: '2026-01-02T03:04:06.002Z', workspace_id: 'wsp_1', kind: 'anthropic', settings: '{"model":"claude-sonnet-5-5"}', secret: 'key-value', status: 'connected', updated_at: '2026-01-03T03:04:06.002Z' },
        { id: 'con_c', created_at: '2026-01-02T03:04:07.003Z', workspace_id: 'wsp_1', kind: 'agentmail', settings: '{"inboxId":"inbox_1"}', secret: 'mail-key', status: 'connected', updated_at: '2026-01-03T03:04:07.003Z' },
      ];
      for (const connector of connectors) insert(db, 'connector', connector);
      const calls = [
        { id: 'mcl_a', created_at: '2026-01-04T00:00:00.001Z', workspace_id: 'wsp_1', run_id: null, purpose: 'chat', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 200, cache_read_tokens: 5, cache_creation_tokens: 7, estimated_usd: 0.008, pending: 0, subject_id: null },
        { id: 'mcl_b', created_at: '2026-01-04T00:00:00.002Z', workspace_id: 'wsp_1', run_id: 'run_1', purpose: 'draft', model: 'claude-haiku-5-5', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_usd: 0, pending: 1, subject_id: 'per_1' },
      ];
      for (const call of calls) insert(db, 'model_call', call);
      expect(() => insert(db, 'connector', { ...connectors[1], id: 'con_x', kind: 'ollama' })).toThrow(/CHECK/);

      expect(applyMigrations(db)).toEqual(['009_model_providers.sql', '010_lead_capture.sql', '011_workspace_version.sql', '012_mail_providers.sql', '013_microsoft.sql', '014_imap.sql', '015_people_order_index.sql', '016_followup_rules.sql', '017_search_index.sql', '018_profile_urls.sql', '019_lifecycle.sql', '020_lifecycle_indexes.sql', '021_worker_lease.sql', '022_pipelines.sql', '023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql']);
      expect(snapshot(db, 'connector')).toEqual(connectors);
      expect(snapshot(db, 'model_call')).toEqual(calls.map((call) => ({ ...call, provider: 'anthropic' })));
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(tableSql(db, 'connector')).not.toContain('_new');

      const template = { ...connectors[1]!, settings: '{}' };
      insert(db, 'connector', { ...template, id: 'con_openai', kind: 'openai' });
      insert(db, 'connector', { ...template, id: 'con_deepseek', kind: 'deepseek' });
      insert(db, 'connector', { ...template, id: 'con_zai', kind: 'zai' });
      insert(db, 'connector', { ...template, id: 'con_ollama', kind: 'ollama', settings: '{"baseUrl":"http://127.0.0.1:11434","model":null}', secret: '' });
      expect(db.prepare("SELECT secret FROM connector WHERE kind = 'ollama'").get()).toEqual({ secret: '' });
      expect(() => insert(db, 'connector', { ...template, id: 'con_dupe', kind: 'openai' })).toThrow(/UNIQUE/);
      expect(() => insert(db, 'connector', { ...template, id: 'con_bad', kind: 'gemini' })).toThrow(/CHECK/);
      expect(() => insert(db, 'connector', { ...template, id: 'con_null', kind: 'zai', secret: null })).toThrow(/NOT NULL|UNIQUE/);
      expect(() => insert(db, 'connector', { ...template, id: 'con_status', kind: 'zai', status: 'other' })).toThrow(/CHECK|UNIQUE/);

      const call = { id: 'mcl_new', created_at: '2026-01-05', workspace_id: 'wsp_1', run_id: null, purpose: 'chat', model: 'llama-stub:8b' };
      insert(db, 'model_call', call);
      expect(db.prepare("SELECT provider FROM model_call WHERE id = 'mcl_new'").get()).toEqual({ provider: 'anthropic' });
      insert(db, 'model_call', { ...call, id: 'mcl_local', provider: 'ollama' });
      expect(() => insert(db, 'model_call', { ...call, id: 'mcl_bad', provider: 'gemini' })).toThrow(/CHECK/);
      const indexed = (name: string) => (db.pragma(`index_info(${name})`) as { name: string }[]).map((column) => column.name);
      expect(indexed('idx_connector_workspace')).toEqual(['workspace_id', 'kind']);
      expect(indexed('idx_model_call_workspace')).toEqual(['workspace_id', 'created_at']);
      expect(indexed('idx_model_call_run')).toEqual(['run_id']);
      expect(indexed('idx_model_call_subject')).toEqual(['run_id', 'subject_id']);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('migration 010', () => {
  it('keeps import batches and rows unchanged, allows lead_capture batches, and keeps indexes and keys', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of ['001_init.sql', '002_apify.sql', '003_csv_qualify.sql']) {
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

      const applied = applyMigrations(db);
      expect(applied).toContain('010_lead_capture.sql');
      expect(snapshot(db, 'import_batch')).toEqual(batchesBefore);
      expect(snapshot(db, 'import_row')).toEqual(rowsBefore);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(tableSql(db, 'import_row')).not.toContain('_new');
      expect(tableSql(db, 'import_batch')).not.toContain('_new');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%\\_new' ESCAPE '\\'").all()).toEqual([]);

      const rowKeys = db.pragma('foreign_key_list(import_row)') as { table: string; from: string; to: string }[];
      expect(rowKeys.map((key) => [key.table, key.from, key.to])).toEqual([['import_batch', 'batch_id', 'id']]);
      const indexColumns = (name: string): string[] => (db.pragma(`index_info(${name})`) as { name: string }[]).map((column) => column.name);
      expect(indexColumns('idx_import_batch_run')).toEqual(['workspace_id', 'run_id']);
      expect(indexColumns('idx_import_row_batch')).toEqual(['batch_id', 'seq']);
      expect(indexColumns('idx_import_row_status')).toEqual(['batch_id', 'status']);
      expect(() => insert(db, 'import_row', { ...rows[0], id: 'row_dupe' })).toThrow(/UNIQUE/);

      const leadBatch = { ...batches[0]!, id: 'imp_lead', source_kind: 'lead_capture', source_ref: '{"postUrl":"https://www.linkedin.com/posts/x-activity-1"}', status: 'staging' };
      insert(db, 'import_batch', leadBatch);
      insert(db, 'import_row', { ...rows[0], id: 'row_lead', batch_id: 'imp_lead' });
      insert(db, 'import_batch', { ...leadBatch, id: 'imp_csv', source_kind: 'csv' });
      expect(() => insert(db, 'import_batch', { ...leadBatch, id: 'imp_other', source_kind: 'other' })).toThrow(/CHECK/);
      expect(() => insert(db, 'import_batch', { ...leadBatch, id: 'imp_status', status: 'unknown' })).toThrow(/CHECK/);
      expect(() => insert(db, 'import_row', { ...rows[0], id: 'row_orphan', batch_id: 'imp_missing', seq: 1 })).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('migration 012', () => {
  it('keeps connectors and send intents, defaults old intents to agentmail, and allows gmail', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      const files = ['001_init.sql', '002_apify.sql', '003_csv_qualify.sql', '004_lookup_indexes.sql', '005_anthropic.sql', '006_model_call_markers.sql', '007_agentmail.sql', '008_send_intent_guards.sql', '009_model_providers.sql', '010_lead_capture.sql', '011_workspace_version.sql'];
      for (const file of files) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'One', 't');
      db.prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES ('con_1', '2026-01-01', 'wsp_1', 'agentmail', '{\"inboxId\":\"a@b.invalid\"}', 'am_secret', 'connected', '2026-01-01')").run();
      db.prepare("INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, updated_at) VALUES ('per_1', '2026-01-01', 'wsp_1', 1, 'A', 'B', '2026-01-01')").run();
      db.prepare(
        `INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, updated_at)
         VALUES ('snd_1', '2026-01-01', 'wsp_1', 'per_1', 'a@b.invalid', 'x@y.invalid', 's', 'b', 'h', 'accepted', '2026-01-01')`,
      ).run();
      const connectorsBefore = db.prepare('SELECT * FROM connector').all();

      expect(applyMigrations(db)).toEqual(['012_mail_providers.sql', '013_microsoft.sql', '014_imap.sql', '015_people_order_index.sql', '016_followup_rules.sql', '017_search_index.sql', '018_profile_urls.sql', '019_lifecycle.sql', '020_lifecycle_indexes.sql', '021_worker_lease.sql', '022_pipelines.sql', '023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql']);
      expect(db.prepare('SELECT * FROM connector').all()).toEqual(connectorsBefore);
      expect(db.prepare('SELECT provider, message_id_header FROM send_intent').get()).toEqual({ provider: 'agentmail', message_id_header: null });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%\\_new' ESCAPE '\\'").all()).toEqual([]);
      expect((db.pragma('index_info(idx_connector_workspace)') as { name: string }[]).map((column) => column.name)).toEqual(['workspace_id', 'kind']);

      db.prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES ('con_2', '2026-01-02', 'wsp_1', 'gmail', '{}', '{}', 'connected', '2026-01-02')").run();
      expect(() =>
        db.prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES ('con_3', '2026-01-02', 'wsp_1', 'carrier_pigeon', '{}', '{}', 'connected', '2026-01-02')").run(),
      ).toThrow(/CHECK/);
      expect(() => db.prepare("UPDATE send_intent SET provider = 'carrier_pigeon'").run()).toThrow(/CHECK/);

      // A Message-ID header identifies one intent per workspace.
      db.prepare("UPDATE send_intent SET message_id_header = '<ac-1@x.invalid>' WHERE id = 'snd_1'").run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, updated_at, message_id_header)
             VALUES ('snd_2', '2026-01-01', 'wsp_1', 'per_1', 'a@b.invalid', 'x@y.invalid', 's2', 'b', 'h', 'queued', '2026-01-01', '<ac-1@x.invalid>')`,
          )
          .run(),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('migration 013', () => {
  it('keeps connectors and send intents with every column, adds the draft id, and allows microsoft', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      const files = ['001_init.sql', '002_apify.sql', '003_csv_qualify.sql', '004_lookup_indexes.sql', '005_anthropic.sql', '006_model_call_markers.sql', '007_agentmail.sql', '008_send_intent_guards.sql', '009_model_providers.sql', '010_lead_capture.sql', '011_workspace_version.sql', '012_mail_providers.sql'];
      for (const file of files) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'One', 't');
      db.prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES ('con_1', '2026-01-01', 'wsp_1', 'gmail', '{\"emailAddress\":\"a@b.invalid\"}', '{\"clientSecret\":\"s\"}', 'error', '2026-01-02')").run();
      db.prepare("INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, updated_at) VALUES ('per_1', '2026-01-01', 'wsp_1', 1, 'A', 'B', '2026-01-01')").run();
      db.prepare(
        `INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, error, provider_message_id, provider_thread_id, submitted_at, updated_at, unknown_acknowledged, provider, message_id_header)
         VALUES ('snd_1', '2026-01-01', 'wsp_1', 'per_1', 'a@b.invalid', 'x@y.invalid', 's', 'b', 'h', 'unknown', 'Outcome unknown.', 'pm_1', 'th_1', '2026-01-01T01:00:00Z', '2026-01-02', 1, 'gmail', '<ac-1@x.invalid>')`,
      ).run();
      const connectorsBefore = db.prepare('SELECT * FROM connector').all();
      const intentBefore = db.prepare('SELECT * FROM send_intent').get() as Record<string, unknown>;

      expect(applyMigrations(db)).toEqual(['013_microsoft.sql', '014_imap.sql', '015_people_order_index.sql', '016_followup_rules.sql', '017_search_index.sql', '018_profile_urls.sql', '019_lifecycle.sql', '020_lifecycle_indexes.sql', '021_worker_lease.sql', '022_pipelines.sql', '023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql']);
      expect(db.prepare('SELECT * FROM connector').all()).toEqual(connectorsBefore);
      expect(db.prepare('SELECT * FROM send_intent').get()).toEqual({ ...intentBefore, provider_draft_id: null, send_attempted_at: null, no_resend: 0, followup_rule_id: null, followup_step: null, followup_reply_to: null });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%\\_new' ESCAPE '\\'").all()).toEqual([]);
      const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'send_intent' AND name LIKE 'idx_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
      expect(indexes).toEqual([
        'idx_send_intent_approval',
        'idx_send_intent_draft',
        'idx_send_intent_message',
        'idx_send_intent_message_id_header',
        'idx_send_intent_open_draft',
        'idx_send_intent_person',
        'idx_send_intent_provider_draft',
        'idx_send_intent_provider_message',
        'idx_send_intent_status',
        'idx_send_intent_thread',
      ]);

      db.prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES ('con_2', '2026-01-02', 'wsp_1', 'microsoft', '{}', '{}', 'connected', '2026-01-02')").run();
      expect(() =>
        db.prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES ('con_3', '2026-01-02', 'wsp_1', 'carrier_pigeon', '{}', '{}', 'connected', '2026-01-02')").run(),
      ).toThrow(/CHECK/);
      expect(() =>
        db.prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES ('con_4', '2026-01-02', 'wsp_1', 'microsoft', '{}', '{}', 'connected', '2026-01-02')").run(),
      ).toThrow(/UNIQUE/);
      db.prepare("UPDATE send_intent SET provider = 'microsoft', provider_draft_id = 'AAMk-draft-1'").run();
      expect(() => db.prepare("UPDATE send_intent SET provider = 'carrier_pigeon'").run()).toThrow(/CHECK/);

      // A draft id identifies one intent per workspace, and so does the internet message id.
      const insert = (id: string, extra: string, value: string): void => {
        db.prepare(
          `INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, updated_at, ${extra})
           VALUES (?, '2026-01-01', 'wsp_1', 'per_1', 'a@b.invalid', 'x@y.invalid', ?, 'b', 'h', 'queued', '2026-01-01', ?)`,
        ).run(id, id, value);
      };
      expect(() => insert('snd_2', 'provider_draft_id', 'AAMk-draft-1')).toThrow(/UNIQUE/);
      expect(() => insert('snd_3', 'message_id_header', '<ac-1@x.invalid>')).toThrow(/UNIQUE/);
      insert('snd_4', 'provider_draft_id', 'AAMk-draft-2');
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('migration 014', () => {
  it('keeps connectors and send intents with every column and index, and allows imap', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      const files = ['001_init.sql', '002_apify.sql', '003_csv_qualify.sql', '004_lookup_indexes.sql', '005_anthropic.sql', '006_model_call_markers.sql', '007_agentmail.sql', '008_send_intent_guards.sql', '009_model_providers.sql', '010_lead_capture.sql', '011_workspace_version.sql', '012_mail_providers.sql', '013_microsoft.sql'];
      for (const file of files) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'One', 't');
      db.prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES ('con_1', '2026-01-01', 'wsp_1', 'microsoft', '{\"emailAddress\":\"a@b.invalid\"}', '{}', 'error', '2026-01-02')").run();
      db.prepare("INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, updated_at) VALUES ('per_1', '2026-01-01', 'wsp_1', 1, 'A', 'B', '2026-01-01')").run();
      db.prepare(
        `INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, error, provider_message_id, provider_thread_id, submitted_at, updated_at, unknown_acknowledged, provider, message_id_header, provider_draft_id, send_attempted_at, no_resend)
         VALUES ('snd_1', '2026-01-01', 'wsp_1', 'per_1', 'a@b.invalid', 'x@y.invalid', 's', 'b', 'h', 'unknown', 'Outcome unknown.', 'pm_1', 'th_1', '2026-01-01T01:00:00Z', '2026-01-02', 1, 'microsoft', '<ac-1@x.invalid>', 'AAMk-1', '2026-01-01T01:00:01Z', 1)`,
      ).run();
      const connectorsBefore = db.prepare('SELECT * FROM connector').all();
      const intentBefore = db.prepare('SELECT * FROM send_intent').get();
      const indexesBefore = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name").all();

      expect(applyMigrations(db)).toEqual(['014_imap.sql', '015_people_order_index.sql', '016_followup_rules.sql', '017_search_index.sql', '018_profile_urls.sql', '019_lifecycle.sql', '020_lifecycle_indexes.sql', '021_worker_lease.sql', '022_pipelines.sql', '023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql']);
      expect(db.prepare('SELECT * FROM connector').all()).toEqual(connectorsBefore);
      // 016 adds three empty follow-up columns to the send intent.
      expect(db.prepare('SELECT * FROM send_intent').get()).toEqual({ ...(intentBefore as Record<string, unknown>), followup_rule_id: null, followup_step: null, followup_reply_to: null });
      // 015, 016, and 017 add one index each, 018 adds three, 019 one, 020 two, and 023 one, on top of what 014 preserves.
      const indexesAfter = [
        ...indexesBefore,
        { name: 'idx_person_order_name', sql: 'CREATE INDEX idx_person_order_name ON person (workspace_id, lower(last_name), lower(first_name), id)' },
        { name: 'idx_followup_rule_status', sql: 'CREATE INDEX idx_followup_rule_status ON followup_rule(workspace_id, status, next_due_at)' },
        { name: 'idx_opportunity_organization', sql: 'CREATE INDEX idx_opportunity_organization ON opportunity(workspace_id, organization_id)' },
        { name: 'idx_person_linkedin_url', sql: 'CREATE INDEX idx_person_linkedin_url ON person (workspace_id, linkedin_url)' },
        { name: 'idx_person_x_url', sql: 'CREATE INDEX idx_person_x_url ON person (workspace_id, x_url)' },
        { name: 'idx_organization_linkedin_url', sql: 'CREATE INDEX idx_organization_linkedin_url ON organization (workspace_id, linkedin_url)' },
        { name: 'idx_person_lifecycle', sql: 'CREATE INDEX idx_person_lifecycle ON person (workspace_id, lifecycle)' },
        { name: 'idx_person_organization_lifecycle', sql: 'CREATE INDEX idx_person_organization_lifecycle ON person (organization_id, lifecycle)' },
        { name: 'idx_opportunity_person', sql: 'CREATE INDEX idx_opportunity_person ON opportunity (workspace_id, person_id)' },
        { name: 'idx_list_member_person', sql: 'CREATE INDEX idx_list_member_person ON list_member(person_id)' },
        { name: 'idx_attribute_value_entity', sql: 'CREATE INDEX idx_attribute_value_entity ON attribute_value(entity_id)' },
      ].sort((left, right) => ((left as { name: string }).name < (right as { name: string }).name ? -1 : 1));
      expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name").all()).toEqual(indexesAfter);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%\\_new' ESCAPE '\\'").all()).toEqual([]);

      db.prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES ('con_2', '2026-01-02', 'wsp_1', 'imap', '{}', 'pw', 'connected', '2026-01-02')").run();
      expect(() =>
        db.prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES ('con_3', '2026-01-02', 'wsp_1', 'imap', '{}', 'pw', 'connected', '2026-01-02')").run(),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db.prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES ('con_4', '2026-01-02', 'wsp_1', 'carrier_pigeon', '{}', 'pw', 'connected', '2026-01-02')").run(),
      ).toThrow(/CHECK/);
      db.prepare("UPDATE send_intent SET provider = 'imap'").run();
      expect(() => db.prepare("UPDATE send_intent SET provider = 'carrier_pigeon'").run()).toThrow(/CHECK/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, updated_at, message_id_header)
             VALUES ('snd_2', '2026-01-01', 'wsp_1', 'per_1', 'a@b.invalid', 'x@y.invalid', 's2', 'b', 'h', 'queued', '2026-01-01', '<ac-1@x.invalid>')`,
          )
          .run(),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('migration 016', () => {
  it('keeps send intents, adds the follow-up columns and the rule table, and guards the rule status', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      const files = readdirSync(migrationsDirectory).filter((name) => /^\d+_.+\.sql$/.test(name) && name < '016').sort();
      expect(files.at(-1)).toBe('015_people_order_index.sql');
      for (const file of files) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'One', 't');
      db.prepare("INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, updated_at) VALUES ('per_1', '2026-01-01', 'wsp_1', 1, 'A', 'B', '2026-01-01')").run();
      db.prepare("INSERT INTO run (id, created_at, workspace_id, kind, title, status, scope, counts) VALUES ('run_1', '2026-01-01', 'wsp_1', 'send_outreach', 't', 'running', '{}', '{}')").run();
      db.prepare("INSERT INTO approval (id, created_at, workspace_id, run_id, kind, title, payload, payload_hash, status) VALUES ('apr_1', '2026-01-01', 'wsp_1', 'run_1', 'send_review', 't', '{}', 'h', 'approved')").run();
      db.prepare(
        `INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, approval_id, updated_at)
         VALUES ('snd_1', '2026-01-01', 'wsp_1', 'per_1', 'a@b.invalid', 'x@y.invalid', 's', 'b', 'h', 'accepted', 'apr_1', '2026-01-02')`,
      ).run();
      const intentBefore = db.prepare('SELECT * FROM send_intent').get() as Record<string, unknown>;

      expect(applyMigrations(db)).toEqual(['016_followup_rules.sql', '017_search_index.sql', '018_profile_urls.sql', '019_lifecycle.sql', '020_lifecycle_indexes.sql', '021_worker_lease.sql', '022_pipelines.sql', '023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql']);
      expect(db.prepare('SELECT * FROM send_intent').get()).toEqual({ ...intentBefore, followup_rule_id: null, followup_step: null, followup_reply_to: null });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect((db.pragma('index_info(idx_followup_rule_status)') as { name: string }[]).map((column) => column.name)).toEqual(['workspace_id', 'status', 'next_due_at']);

      const insertRule = (id: string, status: string, provider = 'gmail') =>
        db
          .prepare(
            `INSERT INTO followup_rule (id, created_at, workspace_id, person_id, intent_id, approval_id, provider, status, steps, updated_at)
             VALUES (?, '2026-01-02', 'wsp_1', 'per_1', 'snd_1', 'apr_1', ?, ?, '[]', '2026-01-02')`,
          )
          .run(id, provider, status);
      insertRule('fur_1', 'waiting');
      for (const status of ['armed', 'sending', 'done', 'stopped', 'expired']) insertRule(`fur_${status}`, status);
      expect(() => insertRule('fur_bad', 'paused')).toThrow(/CHECK/);
      expect(() => insertRule('fur_bad', 'waiting', 'carrier_pigeon')).toThrow(/CHECK/);
      expect(db.prepare("SELECT next_step, next_due_at, last_intent_id, stopped_reason FROM followup_rule WHERE id = 'fur_1'").get()).toEqual({
        next_step: 1,
        next_due_at: null,
        last_intent_id: null,
        stopped_reason: null,
      });
      db.prepare("UPDATE send_intent SET followup_rule_id = 'fur_1', followup_step = 1 WHERE id = 'snd_1'").run();
      expect(() => db.prepare("UPDATE send_intent SET followup_rule_id = 'fur_missing' WHERE id = 'snd_1'").run()).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
