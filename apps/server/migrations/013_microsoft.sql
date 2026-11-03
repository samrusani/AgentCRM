-- SQLite cannot change a CHECK constraint in place, so two tables are rebuilt with a plain copy, drop, and rename:
-- connector, to allow the kind 'microsoft', and send_intent, to allow the provider 'microsoft'. No other table
-- references either of them.
CREATE TABLE connector_new (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL CHECK (kind IN ('apify', 'anthropic', 'openai', 'deepseek', 'zai', 'ollama', 'agentmail', 'gmail', 'microsoft')),
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

-- provider_draft_id is the immutable Outlook id of the draft that carries a Microsoft send. It is written in its own
-- transaction before the draft is sent, and a later check reads that draft to learn whether the send took effect.
-- message_id_header holds the internetMessageId Outlook assigned to the draft.
-- send_attempted_at is written in its own transaction right before every request that sends the draft. A later check
-- may send the same draft again only when this time is long past, and never when it is missing.
-- no_resend is set when the Microsoft connector is removed. A message with an unknown outcome that carries it is only
-- ever read afterward, never sent again.
CREATE TABLE send_intent_new (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  draft_activity_id TEXT REFERENCES activity(id),
  inbox_id TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK (status IN (
    'awaiting_approval', 'approved', 'queued', 'submitting', 'accepted', 'failed', 'unknown', 'blocked', 'cancelled', 'replied', 'bounced'
  )),
  approval_id TEXT REFERENCES approval(id),
  provider_message_id TEXT,
  provider_thread_id TEXT,
  error TEXT,
  submitted_at TEXT,
  updated_at TEXT NOT NULL,
  unknown_acknowledged INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'agentmail' CHECK (provider IN ('agentmail', 'gmail', 'microsoft')),
  message_id_header TEXT,
  provider_draft_id TEXT,
  send_attempted_at TEXT,
  no_resend INTEGER NOT NULL DEFAULT 0
);

INSERT INTO send_intent_new (
  id, created_at, workspace_id, person_id, draft_activity_id, inbox_id, to_email, subject, body, payload_hash, status, approval_id,
  provider_message_id, provider_thread_id, error, submitted_at, updated_at, unknown_acknowledged, provider, message_id_header
)
  SELECT
    id, created_at, workspace_id, person_id, draft_activity_id, inbox_id, to_email, subject, body, payload_hash, status, approval_id,
    provider_message_id, provider_thread_id, error, submitted_at, updated_at, unknown_acknowledged, provider, message_id_header
  FROM send_intent;

DROP TABLE send_intent;
ALTER TABLE send_intent_new RENAME TO send_intent;

CREATE INDEX idx_send_intent_status ON send_intent(workspace_id, status);
CREATE INDEX idx_send_intent_person ON send_intent(workspace_id, person_id);
CREATE INDEX idx_send_intent_thread ON send_intent(workspace_id, provider_thread_id);
CREATE INDEX idx_send_intent_message ON send_intent(workspace_id, provider_message_id);
CREATE UNIQUE INDEX idx_send_intent_open_draft ON send_intent(workspace_id, draft_activity_id)
  WHERE draft_activity_id IS NOT NULL AND status IN ('awaiting_approval', 'approved', 'queued', 'submitting', 'unknown');
CREATE INDEX idx_send_intent_draft ON send_intent(draft_activity_id);
CREATE INDEX idx_send_intent_approval ON send_intent(approval_id);
CREATE UNIQUE INDEX idx_send_intent_provider_message ON send_intent(workspace_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX idx_send_intent_message_id_header ON send_intent(workspace_id, message_id_header)
  WHERE message_id_header IS NOT NULL;
CREATE UNIQUE INDEX idx_send_intent_provider_draft ON send_intent(workspace_id, provider_draft_id)
  WHERE provider_draft_id IS NOT NULL;
