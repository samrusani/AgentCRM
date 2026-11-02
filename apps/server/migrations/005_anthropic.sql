-- SQLite cannot change a CHECK constraint in place, so the connector table is rebuilt to allow kind
-- 'anthropic'. No other table references connector, so a plain copy, drop, and rename is safe.
CREATE TABLE connector_new (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL CHECK (kind IN ('apify', 'anthropic')),
  settings TEXT NOT NULL DEFAULT '{}',
  secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, kind)
);

INSERT INTO connector_new (id, created_at, workspace_id, kind, settings, secret, status, updated_at)
  SELECT id, created_at, workspace_id, kind, settings, secret, status, updated_at FROM connector;

DROP TABLE connector;
ALTER TABLE connector_new RENAME TO connector;

CREATE INDEX idx_connector_workspace ON connector(workspace_id, kind);

-- One row per provider call. Token counts come from the provider response. estimated_usd is an
-- estimate from list prices kept in code, not a bill.
CREATE TABLE model_call (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  run_id TEXT REFERENCES run(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('chat', 'draft')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_usd REAL NOT NULL DEFAULT 0
);

CREATE INDEX idx_model_call_workspace ON model_call(workspace_id, created_at);
CREATE INDEX idx_model_call_run ON model_call(run_id);
