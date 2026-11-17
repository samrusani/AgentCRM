-- A scheduling link (for example a Calendly page) on people. Plain text, stored as typed after normalization.
-- No backfill (no claim has carried this field) and no index (it is never a dedupe key).
ALTER TABLE person ADD COLUMN calendar_url TEXT;
