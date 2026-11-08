-- A pair of organizations the user said are not duplicates. The pair is stored once, ordered so organization_a_id sorts before organization_b_id.
-- Deleting either organization removes the pair.
CREATE TABLE organization_duplicate_dismissal (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  organization_a_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  organization_b_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, organization_a_id, organization_b_id),
  CHECK (organization_a_id < organization_b_id)
);

CREATE INDEX idx_organization_duplicate_dismissal_b ON organization_duplicate_dismissal(workspace_id, organization_b_id);
