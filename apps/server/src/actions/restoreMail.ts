import { readFileSync, rmSync } from 'node:fs';
import { restoreMarkerPath } from '../databaseLock.js';
import type { Db } from '../db.js';
import type { IntentStatus } from '../queries/sendIntents.js';
import { createContext, mutate } from './context.js';
import { stopRestoredFollowupRulesIn } from './followupRules.js';
import { mailReconcileJobKind, transitionIntentIn } from './sendIntentState.js';

const heldStatuses: readonly IntentStatus[] = ['awaiting_approval', 'approved', 'queued', 'submitting', 'unknown'];
const holdMessage = 'Held after a backup restore. This message may already have been sent. Check the sending mailbox before preparing a new send.';

export function holdRestoredMail(db: Db, databasePath: string): void {
  if (databasePath === ':memory:') return;
  const marker = restoreMarkerPath(databasePath);
  let token: string;
  try {
    token = readFileSync(marker, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const workspaces = db.prepare('SELECT id FROM workspace').all() as { id: string }[];
  for (const { id } of workspaces) {
    mutate(createContext(db, id, { actor: 'system' }), (tx) => {
      const receipt = tx.db.prepare("SELECT 1 FROM audit_event WHERE workspace_id = ? AND action = 'restore.hold_mail' AND entity_id = ?")
        .get(tx.workspaceId, token);
      if (receipt) return;
      const intents = tx.db.prepare(`SELECT id FROM send_intent WHERE workspace_id = ? AND status IN (${heldStatuses.map(() => '?').join(', ')})`)
        .all(tx.workspaceId, ...heldStatuses) as { id: string }[];
      for (const intent of intents) {
        transitionIntentIn(tx, intent.id, heldStatuses, 'unknown', { error: holdMessage, restoreHeld: true }, 'restore_hold');
      }
      stopRestoredFollowupRulesIn(tx);
      tx.db.prepare("UPDATE job SET status = 'done', updated_at = ? WHERE kind = ? AND status IN ('queued', 'running') AND json_extract(payload, '$.workspaceId') = ?")
        .run(tx.now(), mailReconcileJobKind, tx.workspaceId);
      // A second startup that read the same marker skips a hold that already committed.
      tx.audit('restore.hold_mail', 'database_restore', token, { intents: intents.length });
    });
  }
  rmSync(marker, { force: true });
}
