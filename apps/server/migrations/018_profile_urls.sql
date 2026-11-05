-- Profile URLs become first class fields. Capture, lookup, and import dedupe match these columns instead of
-- scanning field claims. Each column holds a canonical URL: https://www.linkedin.com/in/<id> for a person,
-- https://x.com/<handle> for a person's X profile, https://www.linkedin.com/company/<slug> for an organization.
-- Claims stay as the evidence trail.
--
-- x_url compares without regard to case, because X handles are case insensitive. LinkedIn ids are case sensitive,
-- so linkedin_url compares exactly.
--
-- The backfill from the newest claim of each entity needs the app's URL normalization, so the migration runner
-- runs it right after this file (see applyMigrations in db.ts), inside the same transaction.
ALTER TABLE person ADD COLUMN linkedin_url TEXT;
ALTER TABLE person ADD COLUMN x_url TEXT COLLATE NOCASE;
ALTER TABLE organization ADD COLUMN linkedin_url TEXT;

CREATE INDEX idx_person_linkedin_url ON person (workspace_id, linkedin_url);
CREATE INDEX idx_person_x_url ON person (workspace_id, x_url);
CREATE INDEX idx_organization_linkedin_url ON organization (workspace_id, linkedin_url);
