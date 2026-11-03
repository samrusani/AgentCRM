-- Full text search for the command palette. Three ordinary FTS5 tables with the trigram tokenizer, which answers a
-- substring match (like LIKE '%q%') from an index instead of a scan. Case is folded by the tokenizer. A trigram index
-- cannot answer a query shorter than 3 characters, so the app keeps its old LIKE scan for those.
--
-- entity_id is the id of the row being indexed and is not itself indexed. Each search row also carries the rowid of its
-- source row, so a trigger can find and replace it directly instead of scanning the table. The people index holds the
-- person's own text only; the organization name is answered by the organization index and joined live at query time,
-- so renaming an organization never touches its members.
--
-- The triggers below key index rows on the source row's rowid, which makes deletes fast. The cost: an INSERT OR
-- REPLACE, or an UPDATE of a row's rowid, on person, organization, or opportunity would leave a stale index row,
-- because the delete trigger does not fire for those. No app code does either (every write goes through the create and
-- update functions); if an upsert path is ever added to these tables, revisit these triggers.
CREATE VIRTUAL TABLE person_search USING fts5(entity_id UNINDEXED, name, email, tokenize = 'trigram');
CREATE VIRTUAL TABLE organization_search USING fts5(entity_id UNINDEXED, name, domain, tokenize = 'trigram');
CREATE VIRTUAL TABLE opportunity_search USING fts5(entity_id UNINDEXED, name, tokenize = 'trigram');

INSERT INTO person_search (rowid, entity_id, name, email)
  SELECT rowid, id, first_name || ' ' || last_name, email FROM person;
INSERT INTO organization_search (rowid, entity_id, name, domain)
  SELECT rowid, id, name, domain FROM organization;
INSERT INTO opportunity_search (rowid, entity_id, name)
  SELECT rowid, id, name FROM opportunity;

-- Finds the opportunities of the organizations a query matched without scanning the workspace.
CREATE INDEX idx_opportunity_organization ON opportunity(workspace_id, organization_id);

CREATE TRIGGER person_search_insert AFTER INSERT ON person BEGIN
  INSERT OR REPLACE INTO person_search (rowid, entity_id, name, email)
    VALUES (new.rowid, new.id, new.first_name || ' ' || new.last_name, new.email);
END;
CREATE TRIGGER person_search_update AFTER UPDATE OF first_name, last_name, email ON person
  WHEN old.first_name IS NOT new.first_name OR old.last_name IS NOT new.last_name OR old.email IS NOT new.email BEGIN
  DELETE FROM person_search WHERE rowid = old.rowid;
  INSERT OR REPLACE INTO person_search (rowid, entity_id, name, email)
    VALUES (new.rowid, new.id, new.first_name || ' ' || new.last_name, new.email);
END;
CREATE TRIGGER person_search_delete AFTER DELETE ON person BEGIN
  DELETE FROM person_search WHERE rowid = old.rowid;
END;

CREATE TRIGGER organization_search_insert AFTER INSERT ON organization BEGIN
  INSERT OR REPLACE INTO organization_search (rowid, entity_id, name, domain)
    VALUES (new.rowid, new.id, new.name, new.domain);
END;
CREATE TRIGGER organization_search_update AFTER UPDATE OF name, domain ON organization
  WHEN old.name IS NOT new.name OR old.domain IS NOT new.domain BEGIN
  DELETE FROM organization_search WHERE rowid = old.rowid;
  INSERT OR REPLACE INTO organization_search (rowid, entity_id, name, domain)
    VALUES (new.rowid, new.id, new.name, new.domain);
END;
CREATE TRIGGER organization_search_delete AFTER DELETE ON organization BEGIN
  DELETE FROM organization_search WHERE rowid = old.rowid;
END;

CREATE TRIGGER opportunity_search_insert AFTER INSERT ON opportunity BEGIN
  INSERT OR REPLACE INTO opportunity_search (rowid, entity_id, name) VALUES (new.rowid, new.id, new.name);
END;
CREATE TRIGGER opportunity_search_update AFTER UPDATE OF name ON opportunity
  WHEN old.name IS NOT new.name BEGIN
  DELETE FROM opportunity_search WHERE rowid = old.rowid;
  INSERT OR REPLACE INTO opportunity_search (rowid, entity_id, name) VALUES (new.rowid, new.id, new.name);
END;
CREATE TRIGGER opportunity_search_delete AFTER DELETE ON opportunity BEGIN
  DELETE FROM opportunity_search WHERE rowid = old.rowid;
END;
