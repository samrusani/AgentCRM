-- Custom attributes. A definition adds one typed field to people or organizations for a workspace; a value holds that
-- field for one record. The key is slugified from the label at creation and never changes, because agents and the
-- fields envelope address a value as attr:<key>. Kind is immutable too. Deleting a definition deletes its values.
CREATE TABLE attribute_def (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  version INTEGER NOT NULL DEFAULT 1,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization')),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'number', 'money')),
  description TEXT,
  seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, entity_type, key)
);

-- The value is stored as written (text as trimmed text, number and money as their decimal digits). Money rows carry
-- their currency. entity_id names a person or organization depending on the definition's entity type.
CREATE TABLE attribute_value (
  attribute_id TEXT NOT NULL REFERENCES attribute_def(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  value TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (attribute_id, entity_id)
);

-- A record's own values (sheet and model reads) look up by entity.
CREATE INDEX idx_attribute_value_entity ON attribute_value(entity_id);

-- Five person attributes for every existing workspace. They are ordinary rows the user may rename or delete.
INSERT INTO attribute_def (id, created_at, workspace_id, version, entity_type, key, label, kind, description, seq, updated_at)
SELECT 'atd_' || lower(hex(randomblob(6))),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       w.id,
       1,
       'person',
       s.key,
       s.label,
       s.kind,
       s.description,
       s.seq,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM workspace w
CROSS JOIN (
  SELECT 'message-angle' AS key, 'Message angle' AS label, 'text' AS kind, 'The outreach angle to lead with for this person.' AS description, 1 AS seq
  UNION ALL SELECT 'fit-notes', 'Fit notes', 'text', 'If and how this investor fits what you are raising for.', 2
  UNION ALL SELECT 'research-notes', 'Research notes', 'text', 'Free form research notes.', 3
  UNION ALL SELECT 'minimum-check-size', 'Minimum check size', 'money', 'The smallest check this investor writes.', 4
  UNION ALL SELECT 'maximum-check-size', 'Maximum check size', 'money', 'The largest check this investor writes.', 5
) s;
