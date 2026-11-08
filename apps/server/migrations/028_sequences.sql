-- Follow-up sequences. A saved, named preset of follow-up steps that prefills the prepare to send editor and nothing
-- more. steps is a JSON array of { waitDays, body } validated by the action service exactly like staged follow-ups. A
-- staged send never references this row: applying a sequence copies its steps into the editor, so editing or deleting
-- a sequence never touches sends or rules already staged.
CREATE TABLE sequence (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  steps TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
