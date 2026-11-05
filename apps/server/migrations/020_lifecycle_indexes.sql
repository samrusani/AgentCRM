-- Read paths for the person lifecycle. The derived organization filter asks "does this organization have a
-- relationship person" per organization row, so the person probe must start from the organization.
CREATE INDEX idx_person_organization_lifecycle ON person (organization_id, lifecycle);

-- Person to opportunity lookups (promotion checks, the 019 style signal queries) no longer scan the workspace.
CREATE INDEX idx_opportunity_person ON opportunity (workspace_id, person_id);
