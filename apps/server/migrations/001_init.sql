CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  template TEXT NOT NULL
);

CREATE TABLE organization (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  domain TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('fund', 'company')),
  location TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE person (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  version INTEGER NOT NULL DEFAULT 1,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT,
  title TEXT,
  organization_id TEXT REFERENCES organization(id),
  location TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  next_action_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE pipeline (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  name TEXT NOT NULL
);

CREATE TABLE stage (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  pipeline_id TEXT NOT NULL REFERENCES pipeline(id),
  name TEXT NOT NULL,
  seq INTEGER NOT NULL
);

CREATE TABLE opportunity (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  pipeline_id TEXT NOT NULL REFERENCES pipeline(id),
  stage_id TEXT NOT NULL REFERENCES stage(id),
  organization_id TEXT REFERENCES organization(id),
  person_id TEXT REFERENCES person(id),
  amount_target INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'passed', 'lost', 'nurture')),
  reason TEXT,
  next_action_at TEXT,
  stage_changed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE stage_event (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  opportunity_id TEXT NOT NULL REFERENCES opportunity(id),
  from_stage_id TEXT REFERENCES stage(id),
  to_stage_id TEXT NOT NULL REFERENCES stage(id),
  at TEXT NOT NULL,
  actor TEXT NOT NULL
);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'opportunity')),
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'email_draft', 'stage_change', 'agent')),
  body TEXT NOT NULL,
  actor TEXT NOT NULL
);

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  entity_type TEXT CHECK (entity_type IN ('person', 'organization', 'opportunity')),
  entity_id TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  updated_at TEXT NOT NULL
);

CREATE TABLE field_claim (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'opportunity')),
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  source_url TEXT,
  source_type TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('imported', 'extracted', 'corroborated', 'human_confirmed'))
);

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'paused', 'succeeded', 'partial', 'failed', 'cancelled')),
  scope TEXT NOT NULL DEFAULT '{}',
  counts TEXT NOT NULL DEFAULT '{"processed":0,"found":0,"flagged":0}',
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE run_step (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES run(id),
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'skipped', 'failed')),
  detail TEXT,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  run_id TEXT NOT NULL REFERENCES run(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  note TEXT,
  decided_at TEXT,
  decided_by TEXT
);

CREATE TABLE job (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  run_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_event (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_person_last_name ON person(workspace_id, last_name);
CREATE INDEX idx_person_email ON person(workspace_id, email);
CREATE INDEX idx_person_organization ON person(workspace_id, organization_id);
CREATE INDEX idx_organization_domain ON organization(workspace_id, domain);
CREATE INDEX idx_organization_name ON organization(workspace_id, name);
CREATE INDEX idx_opportunity_stage ON opportunity(workspace_id, pipeline_id, stage_id);
CREATE INDEX idx_opportunity_status ON opportunity(workspace_id, status);
CREATE INDEX idx_stage_pipeline ON stage(pipeline_id, seq);
CREATE INDEX idx_stage_event_opportunity ON stage_event(opportunity_id, at);
CREATE INDEX idx_task_status_due ON task(workspace_id, status, due_at);
CREATE INDEX idx_task_entity ON task(workspace_id, entity_type, entity_id);
CREATE INDEX idx_activity_entity ON activity(workspace_id, entity_type, entity_id, created_at);
CREATE INDEX idx_field_claim_entity ON field_claim(workspace_id, entity_type, entity_id);
CREATE INDEX idx_run_status ON run(workspace_id, status, created_at);
CREATE INDEX idx_run_step_run ON run_step(run_id, seq);
CREATE INDEX idx_approval_status ON approval(workspace_id, status, created_at);
CREATE INDEX idx_approval_run ON approval(run_id);
CREATE INDEX idx_job_status_run_at ON job(status, run_at);
CREATE INDEX idx_audit_entity ON audit_event(workspace_id, entity_type, entity_id);
