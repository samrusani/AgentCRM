CREATE TABLE connector (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL CHECK (kind IN ('apify')),
  settings TEXT NOT NULL DEFAULT '{}',
  secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, kind)
);

CREATE TABLE import_batch (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  run_id TEXT NOT NULL REFERENCES run(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('apify')),
  source_ref TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'staging' CHECK (status IN ('staging', 'awaiting_review', 'accepted', 'rejected', 'failed')),
  counts TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE import_row (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES import_batch(id),
  seq INTEGER NOT NULL,
  raw TEXT NOT NULL,
  mapped TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'duplicate', 'invalid', 'accepted', 'rejected')),
  match_entity_type TEXT CHECK (match_entity_type IN ('person', 'organization')),
  match_entity_id TEXT,
  reason TEXT,
  UNIQUE (batch_id, seq)
);

-- Records which method produced a claim. Import claims store the actor id here.
ALTER TABLE field_claim ADD COLUMN extraction_method TEXT;

CREATE INDEX idx_connector_workspace ON connector(workspace_id, kind);
CREATE INDEX idx_import_batch_run ON import_batch(workspace_id, run_id);
CREATE INDEX idx_import_row_batch ON import_row(batch_id, seq);
CREATE INDEX idx_import_row_status ON import_row(batch_id, status);
