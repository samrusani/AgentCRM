-- People lists. A list is a named, hand curated set of people. Membership is curation, not a fact about the person:
-- adding or removing a member changes the list's version and nothing on the person. Deleting a list or a person
-- removes their memberships.
CREATE TABLE list (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE list_member (
  list_id TEXT NOT NULL REFERENCES list(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (list_id, person_id)
);

-- The person's own lists (sheet) and the people table filter read by person.
CREATE INDEX idx_list_member_person ON list_member(person_id);
