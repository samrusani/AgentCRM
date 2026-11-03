-- Follow-up rules. A rule sends pre-approved nudges after a first message when the recipient has not replied.
-- The steps (wait days and exact text) are frozen from the approved send_review payload. The rule row is plain
-- state for the worker's follow-up lane; every change to it is audited.
CREATE TABLE followup_rule (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  -- The anchor intent: the first message of the sequence.
  intent_id TEXT NOT NULL REFERENCES send_intent(id),
  approval_id TEXT NOT NULL REFERENCES approval(id),
  provider TEXT NOT NULL CHECK (provider IN ('agentmail', 'gmail', 'microsoft', 'imap')),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'armed', 'sending', 'done', 'stopped', 'expired')),
  -- JSON array of { waitDays, body }, frozen at approval.
  steps TEXT NOT NULL,
  -- 1 based number of the step to send next (or the step in flight while sending).
  next_step INTEGER NOT NULL DEFAULT 1,
  next_due_at TEXT,
  last_intent_id TEXT REFERENCES send_intent(id),
  stopped_reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_followup_rule_status ON followup_rule(workspace_id, status, next_due_at);

-- The intent a rule created for one step carries the rule and the 1 based step number. followup_reply_to holds the
-- JSON thread reference ({ threadId, inReplyTo, references }) for Gmail and IMAP steps, or stays null.
ALTER TABLE send_intent ADD COLUMN followup_rule_id TEXT REFERENCES followup_rule(id);
ALTER TABLE send_intent ADD COLUMN followup_step INTEGER;
ALTER TABLE send_intent ADD COLUMN followup_reply_to TEXT;
