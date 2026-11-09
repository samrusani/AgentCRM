-- SQLite cannot change a CHECK constraint in place, so the connector table is rebuilt with a plain copy, drop, and
-- rename to allow the kind 'backblaze'. No other table references it. Every column and the index are kept, as in
-- migration 014.
CREATE TABLE connector_new (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL CHECK (kind IN ('apify', 'anthropic', 'openai', 'deepseek', 'zai', 'ollama', 'agentmail', 'gmail', 'microsoft', 'imap', 'backblaze')),
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
