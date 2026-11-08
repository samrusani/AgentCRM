-- A pair of people the user said are not duplicates. The pair is stored once, ordered so person_a_id sorts before person_b_id.
-- Deleting either person removes the pair.
CREATE TABLE duplicate_dismissal (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  person_a_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  person_b_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, person_a_id, person_b_id),
  CHECK (person_a_id < person_b_id)
);

CREATE INDEX idx_duplicate_dismissal_b ON duplicate_dismissal(person_b_id);
