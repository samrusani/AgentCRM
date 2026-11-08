-- Saved views. A named shortcut to a screen state on Leads, Relationships, or Pipeline. config is a JSON object of
-- whitelisted URL state for that screen (validated by the action service, re-filtered at read). A view stores no data
-- and no query: applying one only navigates. A list or pipeline id inside a config may point at a record that no longer
-- exists; the screens fall back like they do for any unknown URL value.
CREATE TABLE saved_view (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  screen TEXT NOT NULL CHECK (screen IN ('leads', 'relationships', 'pipeline')),
  config TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE INDEX saved_view_screen ON saved_view(workspace_id, screen, created_at);
