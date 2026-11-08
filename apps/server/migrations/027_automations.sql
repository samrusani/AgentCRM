-- Automations. A user defined rule: when a trigger fires, create a task. The task is the whole effect. Triggers and
-- actions are JSON validated by the action service (stage_entered names a pipeline and a stage, person_promoted has an
-- empty config). Deleting a pipeline or stage that a config names disables the rule and stamps a note into its trigger
-- config, so the row survives and the list can say why it is off.
CREATE TABLE automation (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('stage_entered', 'person_promoted')),
  trigger_config TEXT NOT NULL DEFAULT '{}',
  action_config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);
