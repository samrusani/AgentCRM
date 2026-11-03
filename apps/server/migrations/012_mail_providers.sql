-- SQLite cannot change a CHECK constraint in place, so the connector table is rebuilt to allow the kind
-- 'gmail'. No other table references connector, so a plain copy, drop, and rename is safe.
CREATE TABLE connector_new (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL CHECK (kind IN ('apify', 'anthropic', 'openai', 'deepseek', 'zai', 'ollama', 'agentmail', 'gmail')),
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

-- Every send intent records the mail provider that staged it. It is submitted and reconciled only by that provider.
-- Rows from before this migration all belong to AgentMail.
ALTER TABLE send_intent ADD COLUMN provider TEXT NOT NULL DEFAULT 'agentmail' CHECK (provider IN ('agentmail', 'gmail'));

-- The self generated Message-ID header of a Gmail send. It is written in the same transaction that marks the intent
-- submitting, before the request leaves the process, so an unclear outcome can be checked by searching for it.
ALTER TABLE send_intent ADD COLUMN message_id_header TEXT;

CREATE UNIQUE INDEX idx_send_intent_message_id_header ON send_intent(workspace_id, message_id_header)
  WHERE message_id_header IS NOT NULL;
