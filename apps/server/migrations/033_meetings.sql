-- Meetings. A meeting is a record of a conversation that happened or is scheduled: when, who was there, which
-- organization and deal it concerns, and the notes taken. The end time after the start time is checked in the action,
-- not here. Attendees mirror list membership: a pair row, added twice changes nothing, removed without a version.
-- Deleting a meeting or a person removes the attendee rows.
CREATE TABLE meeting (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  location TEXT,
  organization_id TEXT REFERENCES organization(id),
  opportunity_id TEXT REFERENCES opportunity(id),
  notes TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_meeting_starts ON meeting(workspace_id, starts_at);

CREATE TABLE meeting_attendee (
  meeting_id TEXT NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (meeting_id, person_id)
);

-- The person's own meetings (the people filter on the meetings list) read by person.
CREATE INDEX idx_meeting_attendee_person ON meeting_attendee(person_id);
