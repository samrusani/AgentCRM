-- A person is a lead until a relationship exists, then a relationship. Organizations carry no column: the app
-- derives their lifecycle from their people and opportunities at read time.
ALTER TABLE person ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'lead' CHECK (lifecycle IN ('lead', 'relationship'));

CREATE INDEX idx_person_lifecycle ON person (workspace_id, lifecycle);

-- Backfill once, from the signals that exist today: a linked inbound email, or an opportunity past the first stage.
-- After this, promotion only reacts to new events and never re-reads history.
UPDATE person SET lifecycle = 'relationship'
WHERE EXISTS (
    SELECT 1 FROM email_message m
    WHERE m.workspace_id = person.workspace_id AND m.person_id = person.id AND m.direction = 'in'
  )
  OR EXISTS (
    SELECT 1 FROM opportunity op JOIN stage s ON s.id = op.stage_id
    WHERE op.workspace_id = person.workspace_id AND op.person_id = person.id AND s.seq > 1
  );
