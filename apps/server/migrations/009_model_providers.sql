-- SQLite cannot change a CHECK constraint in place, so the connector table is rebuilt to allow the kinds
-- 'openai', 'deepseek', 'zai', and 'ollama'. No other table references connector, so a plain copy, drop, and
-- rename is safe. The secret column stays NOT NULL. Ollama has no key, so its secret is stored as an empty string.
CREATE TABLE connector_new (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL CHECK (kind IN ('apify', 'anthropic', 'openai', 'deepseek', 'zai', 'ollama', 'agentmail')),
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

-- Every model call records which provider answered. Rows from before this migration all came from Anthropic.
ALTER TABLE model_call ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'
  CHECK (provider IN ('anthropic', 'openai', 'deepseek', 'zai', 'ollama'));
