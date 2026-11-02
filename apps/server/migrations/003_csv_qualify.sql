-- Workspace settings hold the qualification config as JSON under the "qualification" key.
ALTER TABLE workspace ADD COLUMN settings TEXT;

-- SQLite cannot change a CHECK constraint in place, so the two import tables are rebuilt to allow
-- source_kind 'csv'. The child table is replaced first and the parent second, so no foreign key
-- violation exists at any point. Rows are copied unchanged.
CREATE TABLE import_batch_new (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  run_id TEXT NOT NULL REFERENCES run(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('apify', 'csv')),
  source_ref TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'staging' CHECK (status IN ('staging', 'awaiting_review', 'accepted', 'rejected', 'failed')),
  counts TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

INSERT INTO import_batch_new (id, created_at, workspace_id, run_id, source_kind, source_ref, status, counts, updated_at)
  SELECT id, created_at, workspace_id, run_id, source_kind, source_ref, status, counts, updated_at FROM import_batch;

CREATE TABLE import_row_new (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES import_batch_new(id),
  seq INTEGER NOT NULL,
  raw TEXT NOT NULL,
  mapped TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'duplicate', 'invalid', 'accepted', 'rejected')),
  match_entity_type TEXT CHECK (match_entity_type IN ('person', 'organization')),
  match_entity_id TEXT,
  reason TEXT,
  UNIQUE (batch_id, seq)
);

INSERT INTO import_row_new (id, created_at, batch_id, seq, raw, mapped, status, match_entity_type, match_entity_id, reason)
  SELECT id, created_at, batch_id, seq, raw, mapped, status, match_entity_type, match_entity_id, reason FROM import_row;

DROP TABLE import_row;
DROP TABLE import_batch;
ALTER TABLE import_batch_new RENAME TO import_batch;
ALTER TABLE import_row_new RENAME TO import_row;

CREATE INDEX idx_import_batch_run ON import_batch(workspace_id, run_id);
CREATE INDEX idx_import_row_batch ON import_row(batch_id, seq);
CREATE INDEX idx_import_row_status ON import_row(batch_id, status);

CREATE TABLE qualification_result (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  run_id TEXT NOT NULL REFERENCES run(id),
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_qualification_result_person ON qualification_result(workspace_id, person_id);
CREATE INDEX idx_qualification_result_updated ON qualification_result(workspace_id, updated_at);
