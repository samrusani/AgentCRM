import { z } from 'zod';
import { conflict, notFound, validationError } from '../errors.js';
import { isValidEmail, normalizeEmail } from '../mail/rules.js';
import { findSuppression, type Suppression, toSuppression } from '../queries/sendIntents.js';
import { type ActionContext, mutate, parseInput } from './context.js';
import { insertSuppressionIn } from './sendIntentState.js';

const addSchema = z
  .object({
    email: z.string().trim().min(1).max(254),
    reason: z.literal('manual').default('manual'),
  })
  .strict();

// A person adds an address to the list. Queued and approved messages to it are blocked at once.
export function addSuppression(ctx: ActionContext, input: unknown): Suppression {
  const data = parseInput(addSchema, input);
  const email = normalizeEmail(data.email);
  if (!isValidEmail(email)) throw validationError('email: Enter one plain email address.');
  mutate(ctx, (tx) => {
    const created = insertSuppressionIn(tx, { email, reason: 'manual', source: 'Added by a person.' });
    if (!created) throw conflict('That address is already suppressed.');
  });
  return findSuppression(ctx.db, ctx.workspaceId, email)!;
}

// Lifting is a human action and is audited. Messages that were blocked stay blocked and need a fresh decision.
export function liftSuppression(ctx: ActionContext, id: string): void {
  mutate(ctx, (tx) => {
    const row = tx.db.prepare('SELECT * FROM suppression WHERE id = ? AND workspace_id = ?').get(id, tx.workspaceId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw notFound('Suppression');
    const suppression = toSuppression(row);
    tx.db.prepare('DELETE FROM suppression WHERE id = ?').run(id);
    tx.audit('suppression.lift', 'suppression', id, { email: suppression.email, reason: suppression.reason, by: tx.actor });
  });
}
