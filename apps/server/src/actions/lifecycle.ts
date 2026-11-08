import { firePromotionAutomationsIn } from './automations.js';
import { emitRecord, type Tx } from './context.js';

export type PromotionReason = 'replied' | 'opportunity';

// Moves a lead to relationship inside the transaction that carries the signal. Only a current lead is touched, so a
// person who is already a relationship (or was set back to lead by hand and has no new signal) is never changed here.
// Returns true when the person was promoted.
export function promotePersonIn(tx: Tx, personId: string, reason: PromotionReason): boolean {
  const result = tx.db
    .prepare(
      "UPDATE person SET lifecycle = 'relationship', version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND lifecycle = 'lead'",
    )
    .run(tx.now(), personId, tx.workspaceId);
  if (result.changes !== 1) return false;
  tx.audit('person.promote', 'person', personId, { reason });
  emitRecord(tx, 'person', personId);
  firePromotionAutomationsIn(tx, personId);
  return true;
}

// An opportunity sitting in a stage past the first is a relationship signal for the person it names. Callers use this
// when the opportunity is created in the stage or is re-pointed at the person while there.
export function promoteForStageIn(tx: Tx, personId: string, stageId: string): boolean {
  const stage = tx.db.prepare('SELECT seq FROM stage WHERE id = ?').get(stageId) as { seq: number } | undefined;
  return stage !== undefined && stage.seq > 1 ? promotePersonIn(tx, personId, 'opportunity') : false;
}
