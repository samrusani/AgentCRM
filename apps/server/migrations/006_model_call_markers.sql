-- Cache write tokens bill at a higher rate than plain input, so they get their own count.
ALTER TABLE model_call ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;

-- A pending row is written just before a provider call and finalized with real usage after it.
-- A row that is still pending after a restart means the outcome of that call is unknown and it may have been billed.
-- subject_id names the record the call was made for, for example the person a draft was written for.
ALTER TABLE model_call ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_call ADD COLUMN subject_id TEXT;

CREATE INDEX idx_model_call_subject ON model_call(run_id, subject_id);
