-- Guards for send intents. A draft activity can have at most one open intent, so two clicks or two callers
-- cannot stage the same draft twice, whatever characters its subject holds. Lookups by draft, approval, and
-- provider message id get their own indexes.

-- A database that already holds duplicate open intents for one draft could not take the unique index below.
-- The extra intents that are still awaiting approval were never approved, so they are cancelled. An intent
-- that is further along is kept, and among equals the oldest is kept.
UPDATE send_intent
SET status = 'cancelled',
    error = 'Cancelled because another message for the same draft was already open.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'awaiting_approval'
  AND draft_activity_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM send_intent other
    WHERE other.workspace_id = send_intent.workspace_id
      AND other.draft_activity_id = send_intent.draft_activity_id
      AND other.id != send_intent.id
      AND other.status IN ('awaiting_approval', 'approved', 'queued', 'submitting', 'unknown')
      AND (other.status != 'awaiting_approval' OR other.created_at < send_intent.created_at
           OR (other.created_at = send_intent.created_at AND other.id < send_intent.id))
  );

-- Set when a person acknowledges an intent whose outcome was unknown. The message may have been sent, so
-- the draft stays excluded from new sends and the intent still counts against the daily cap.
ALTER TABLE send_intent ADD COLUMN unknown_acknowledged INTEGER NOT NULL DEFAULT 0;

UPDATE send_intent
SET unknown_acknowledged = 1
WHERE status = 'cancelled' AND error LIKE '%Whether this email was sent was never confirmed%';

CREATE UNIQUE INDEX idx_send_intent_open_draft ON send_intent(workspace_id, draft_activity_id)
  WHERE draft_activity_id IS NOT NULL AND status IN ('awaiting_approval', 'approved', 'queued', 'submitting', 'unknown');

CREATE INDEX idx_send_intent_draft ON send_intent(draft_activity_id);
CREATE INDEX idx_send_intent_approval ON send_intent(approval_id);
CREATE UNIQUE INDEX idx_send_intent_provider_message ON send_intent(workspace_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
