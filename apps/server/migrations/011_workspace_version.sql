-- The workspace carries a version like every other record, so a template switch can detect a concurrent change.
ALTER TABLE workspace ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
