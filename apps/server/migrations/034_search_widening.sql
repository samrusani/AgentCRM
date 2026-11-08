-- Retrieval widening. The command palette's search gains notes, tasks, and meetings, and a person's job title becomes
-- searchable. Same machinery as migration 017: ordinary FTS5 tables with the trigram tokenizer, entity_id carried but
-- not indexed, and triggers that key every index row on the source row's rowid so a delete or an update finds its row
-- directly instead of scanning the index.
--
-- The same caveat as 017 applies: an INSERT OR REPLACE, or an UPDATE of a row's rowid, on activity, task, meeting, or
-- person would leave a stale index row, because the delete trigger does not fire for those. A kind-only UPDATE on
-- activity is likewise untracked: the update trigger fires on body changes, and no app path ever changes a kind, so a
-- raw SQL kind change leaves a stale or missing index row; the result query's kind re-check hides stale rows, so the
-- cost is dead weight, never leakage. No app code does either of these
-- (every write goes through the create and update functions); if an upsert path is ever added to these tables, revisit
-- these triggers.

-- Notes only. Email drafts, stage changes, and agent rows are machine noise and stay out of the index: the triggers
-- filter on kind, and so does the seed.
CREATE VIRTUAL TABLE activity_search USING fts5(entity_id UNINDEXED, body, tokenize = 'trigram');
INSERT INTO activity_search (rowid, entity_id, body)
  SELECT rowid, id, body FROM activity WHERE kind = 'note';

CREATE TRIGGER activity_search_insert AFTER INSERT ON activity WHEN new.kind = 'note' BEGIN
  INSERT OR REPLACE INTO activity_search (rowid, entity_id, body) VALUES (new.rowid, new.id, new.body);
END;
CREATE TRIGGER activity_search_update AFTER UPDATE OF body ON activity
  WHEN old.body IS NOT new.body AND new.kind = 'note' BEGIN
  DELETE FROM activity_search WHERE rowid = old.rowid;
  INSERT OR REPLACE INTO activity_search (rowid, entity_id, body) VALUES (new.rowid, new.id, new.body);
END;
-- Unconditional: cheap, and correct for a row of another kind that was never indexed (the delete matches nothing).
CREATE TRIGGER activity_search_delete AFTER DELETE ON activity BEGIN
  DELETE FROM activity_search WHERE rowid = old.rowid;
END;

CREATE VIRTUAL TABLE task_search USING fts5(entity_id UNINDEXED, title, tokenize = 'trigram');
INSERT INTO task_search (rowid, entity_id, title) SELECT rowid, id, title FROM task;

CREATE TRIGGER task_search_insert AFTER INSERT ON task BEGIN
  INSERT OR REPLACE INTO task_search (rowid, entity_id, title) VALUES (new.rowid, new.id, new.title);
END;
CREATE TRIGGER task_search_update AFTER UPDATE OF title ON task
  WHEN old.title IS NOT new.title BEGIN
  DELETE FROM task_search WHERE rowid = old.rowid;
  INSERT OR REPLACE INTO task_search (rowid, entity_id, title) VALUES (new.rowid, new.id, new.title);
END;
CREATE TRIGGER task_search_delete AFTER DELETE ON task BEGIN
  DELETE FROM task_search WHERE rowid = old.rowid;
END;

CREATE VIRTUAL TABLE meeting_search USING fts5(entity_id UNINDEXED, title, location, notes, tokenize = 'trigram');
INSERT INTO meeting_search (rowid, entity_id, title, location, notes)
  SELECT rowid, id, title, location, notes FROM meeting;

CREATE TRIGGER meeting_search_insert AFTER INSERT ON meeting BEGIN
  INSERT OR REPLACE INTO meeting_search (rowid, entity_id, title, location, notes)
    VALUES (new.rowid, new.id, new.title, new.location, new.notes);
END;
CREATE TRIGGER meeting_search_update AFTER UPDATE OF title, location, notes ON meeting
  WHEN old.title IS NOT new.title OR old.location IS NOT new.location OR old.notes IS NOT new.notes BEGIN
  DELETE FROM meeting_search WHERE rowid = old.rowid;
  INSERT OR REPLACE INTO meeting_search (rowid, entity_id, title, location, notes)
    VALUES (new.rowid, new.id, new.title, new.location, new.notes);
END;
CREATE TRIGGER meeting_search_delete AFTER DELETE ON meeting BEGIN
  DELETE FROM meeting_search WHERE rowid = old.rowid;
END;

-- person_search is rebuilt to carry the job title as a third searchable column. An FTS5 table cannot gain a column in
-- place, so the table and its three triggers are dropped, the table is recreated and reseeded from person, and the
-- triggers are recreated with title in the UPDATE OF list and in the WHEN clause. Rows are keyed on person.rowid exactly
-- as before, with the same upsert caveat as above.
DROP TRIGGER person_search_insert;
DROP TRIGGER person_search_update;
DROP TRIGGER person_search_delete;
DROP TABLE person_search;

CREATE VIRTUAL TABLE person_search USING fts5(entity_id UNINDEXED, name, email, title, tokenize = 'trigram');
INSERT INTO person_search (rowid, entity_id, name, email, title)
  SELECT rowid, id, first_name || ' ' || last_name, email, title FROM person;

CREATE TRIGGER person_search_insert AFTER INSERT ON person BEGIN
  INSERT OR REPLACE INTO person_search (rowid, entity_id, name, email, title)
    VALUES (new.rowid, new.id, new.first_name || ' ' || new.last_name, new.email, new.title);
END;
CREATE TRIGGER person_search_update AFTER UPDATE OF first_name, last_name, email, title ON person
  WHEN old.first_name IS NOT new.first_name OR old.last_name IS NOT new.last_name OR old.email IS NOT new.email
    OR old.title IS NOT new.title BEGIN
  DELETE FROM person_search WHERE rowid = old.rowid;
  INSERT OR REPLACE INTO person_search (rowid, entity_id, name, email, title)
    VALUES (new.rowid, new.id, new.first_name || ' ' || new.last_name, new.email, new.title);
END;
CREATE TRIGGER person_search_delete AFTER DELETE ON person BEGIN
  DELETE FROM person_search WHERE rowid = old.rowid;
END;
