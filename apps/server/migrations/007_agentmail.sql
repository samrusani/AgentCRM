-- SQLite cannot change a CHECK constraint in place, so the connector table is rebuilt to allow kind
-- 'agentmail' and the activity table is rebuilt to allow the kinds 'email_out' and 'email_in'.
-- No other table references either of them yet, so a plain copy, drop, and rename is safe.
CREATE TABLE connector_new (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL CHECK (kind IN ('apify', 'anthropic', 'agentmail')),
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

CREATE TABLE activity_new (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'opportunity')),
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'email_draft', 'stage_change', 'agent', 'email_out', 'email_in')),
  body TEXT NOT NULL,
  actor TEXT NOT NULL
);

INSERT INTO activity_new (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor)
  SELECT id, created_at, workspace_id, entity_type, entity_id, kind, body, actor FROM activity;

DROP TABLE activity;
ALTER TABLE activity_new RENAME TO activity;

CREATE INDEX idx_activity_entity ON activity(workspace_id, entity_type, entity_id, created_at);

-- Every message the inbound sync has seen, sent or received. The provider message id is unique per
-- workspace, so a message that appears on two polls is stored once. body_text stays null until the full
-- text is fetched, and it is only fetched for inbound messages.
CREATE TABLE email_message (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  provider_message_id TEXT NOT NULL,
  provider_thread_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  person_id TEXT REFERENCES person(id),
  from_email TEXT NOT NULL,
  "to" TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  body_text TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  provider_timestamp TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_email_message_provider ON email_message(workspace_id, provider_message_id);
CREATE INDEX idx_email_message_person ON email_message(workspace_id, person_id, provider_timestamp);

-- One row per frozen outgoing message. The row id is also the provider idempotency key, so the same
-- intent can never produce a second email, however many times a submit is retried.
CREATE TABLE send_intent (
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
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_send_intent_status ON send_intent(workspace_id, status);
CREATE INDEX idx_send_intent_person ON send_intent(workspace_id, person_id);
CREATE INDEX idx_send_intent_thread ON send_intent(workspace_id, provider_thread_id);
CREATE INDEX idx_send_intent_message ON send_intent(workspace_id, provider_message_id);

-- Addresses that must never receive mail from this workspace. email is stored lowercase.
CREATE TABLE suppression (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  email TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('bounce', 'opt_out', 'manual', 'demo_address')),
  source TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX idx_suppression_email ON suppression(workspace_id, email);
