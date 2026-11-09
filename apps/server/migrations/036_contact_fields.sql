-- Phone and website become ordinary editable text columns on people and organizations. They are plain text with no
-- index: neither is a dedupe key and neither joins a search index.
ALTER TABLE person ADD COLUMN phone TEXT;
ALTER TABLE person ADD COLUMN website TEXT;
ALTER TABLE organization ADD COLUMN phone TEXT;
ALTER TABLE organization ADD COLUMN website TEXT;

-- Backfill each empty column from that record's newest claim of the same field (newest by created_at, id breaks a tie).
-- The claims stay as the evidence trail. A column that already holds a value is never touched.
UPDATE person SET phone = (
  SELECT c.value FROM field_claim c
  WHERE c.workspace_id = person.workspace_id AND c.entity_type = 'person' AND c.entity_id = person.id AND c.field = 'phone'
  ORDER BY c.created_at DESC, c.id DESC LIMIT 1
) WHERE phone IS NULL;

UPDATE person SET website = (
  SELECT c.value FROM field_claim c
  WHERE c.workspace_id = person.workspace_id AND c.entity_type = 'person' AND c.entity_id = person.id AND c.field = 'website'
  ORDER BY c.created_at DESC, c.id DESC LIMIT 1
) WHERE website IS NULL;

UPDATE organization SET phone = (
  SELECT c.value FROM field_claim c
  WHERE c.workspace_id = organization.workspace_id AND c.entity_type = 'organization' AND c.entity_id = organization.id AND c.field = 'phone'
  ORDER BY c.created_at DESC, c.id DESC LIMIT 1
) WHERE phone IS NULL;

UPDATE organization SET website = (
  SELECT c.value FROM field_claim c
  WHERE c.workspace_id = organization.workspace_id AND c.entity_type = 'organization' AND c.entity_id = organization.id AND c.field = 'website'
  ORDER BY c.created_at DESC, c.id DESC LIMIT 1
) WHERE website IS NULL;
