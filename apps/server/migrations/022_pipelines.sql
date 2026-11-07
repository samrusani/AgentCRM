-- A workspace holds many pipelines, each with its own template and its own version for optimistic concurrency.
-- workspace.template stays as a column but is no longer written: each pipeline records the template it runs.
ALTER TABLE pipeline ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pipeline ADD COLUMN template TEXT NOT NULL DEFAULT '';

-- Backfill once: the existing pipeline takes the workspace's template.
UPDATE pipeline SET template = COALESCE(
  (SELECT workspace.template FROM workspace WHERE workspace.id = pipeline.workspace_id),
  'startup-fundraising'
);
