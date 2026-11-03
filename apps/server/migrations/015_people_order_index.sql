-- The people list and its keyset pagination order by lower(last_name), lower(first_name), id.
-- Without a matching expression index SQLite sorts the whole table, which missed the 250 ms list
-- budget at 100,000 people in the published benchmark. This index lets the ordering walk the index.
CREATE INDEX idx_person_order_name ON person (workspace_id, lower(last_name), lower(first_name), id);
