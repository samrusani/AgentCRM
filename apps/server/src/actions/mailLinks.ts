import type { Tx } from './context.js';

export interface LinkedMessageCounts {
  inbound: number;
  outbound: number;
}

// Files stored messages that have no person yet under this person: inbound mail from the address, outbound mail to it,
// case folded, same workspace. Messages already filed under someone are left alone. This never touches the person's
// lifecycle: old mail becoming visible is not a signal arriving. Migration 024 runs the same two rules in SQL.
export function linkStoredMessagesToPerson(tx: Tx, personId: string, email: string): LinkedMessageCounts {
  const address = email.trim().toLowerCase();
  // Stored from addresses and recipients are already lowercase.
  const inbound = tx.db
    .prepare("UPDATE email_message SET person_id = ? WHERE workspace_id = ? AND person_id IS NULL AND direction = 'in' AND from_email = ?")
    .run(personId, tx.workspaceId, address).changes;
  const outbound = tx.db
    .prepare(
      `UPDATE email_message SET person_id = ?
       WHERE workspace_id = ? AND person_id IS NULL AND direction = 'out' AND json_valid("to")
         AND EXISTS (SELECT 1 FROM json_each(email_message."to") r WHERE lower(r.value) = ?)`,
    )
    .run(personId, tx.workspaceId, address).changes;
  return { inbound: Number(inbound), outbound: Number(outbound) };
}
