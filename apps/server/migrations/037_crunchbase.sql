-- A Crunchbase organization page link on organizations. Plain text, canonical form https://www.crunchbase.com/organization/<slug>.
-- No backfill (no claim has carried this field) and no index (it is never a dedupe key).
ALTER TABLE organization ADD COLUMN crunchbase_url TEXT;
