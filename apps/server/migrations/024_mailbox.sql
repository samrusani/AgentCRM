-- Mailbox capture and interaction history. The display name from the From header is stored at sync time from now
-- on; rows synced before this migration have none.
ALTER TABLE email_message ADD COLUMN from_name TEXT;

-- SQLite cannot change a CHECK constraint in place, so the two import tables are rebuilt to allow
-- source_kind 'mailbox'. The child table is replaced first and the parent second, so no foreign key
-- violation exists at any point. Rows are copied unchanged.
CREATE TABLE import_batch_new (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  run_id TEXT NOT NULL REFERENCES run(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('apify', 'csv', 'lead_capture', 'mailbox')),
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

-- Link stored messages to the people they belong to: the from address for inbound mail, the first recipient who is a
-- person for outbound mail, case folded, in the same workspace. Only unlinked rows are touched. This never changes a
-- person's lifecycle: promotion stays tied to a signal arriving, not to old mail becoming visible.
UPDATE email_message
SET person_id = (
  SELECT p.id FROM person p
  WHERE p.workspace_id = email_message.workspace_id AND lower(p.email) = lower(email_message.from_email)
  ORDER BY p.created_at, p.id LIMIT 1
)
WHERE person_id IS NULL AND direction = 'in';

UPDATE email_message
SET person_id = (
  SELECT p.id FROM json_each(email_message."to") r
  JOIN person p ON p.workspace_id = email_message.workspace_id AND lower(p.email) = lower(r.value)
  ORDER BY r.key, p.created_at, p.id LIMIT 1
)
WHERE person_id IS NULL AND direction = 'out' AND json_valid("to");
