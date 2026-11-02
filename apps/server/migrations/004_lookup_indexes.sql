-- The email and domain uniqueness checks compare lower(email) and lower(domain). The plain indexes on those
-- columns cannot answer a lower() comparison, so every check scanned the whole table and an import of
-- thousands of rows took minutes to approve. These expression indexes match the checks exactly.
CREATE INDEX idx_person_email_lower ON person(workspace_id, lower(email));
CREATE INDEX idx_organization_domain_lower ON organization(workspace_id, lower(domain));
