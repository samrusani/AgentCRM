import { z } from 'zod';
import { conflict } from '../errors.js';
import { getRun, requireApproval, requireRun } from '../queries/runs.js';
import { type ActionContext, mutate, parseInput } from './context.js';
import { applyDrafts } from './draftOutreach.js';
import { acceptImportBatch } from './importReview.js';
import { applyShortlist, hashPayload } from './demoResearch.js';
import { cancelRunIn } from './runs.js';

const decisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

// Deciding the same way twice returns the stored decision and changes nothing.
// Deciding the opposite way after a decision is a conflict.
export function decideApproval(ctx: ActionContext, approvalId: string, input: unknown) {
  const data = parseInput(decisionSchema, input);
  const wanted = data.decision === 'approve' ? 'approved' : 'rejected';

  return mutate(ctx, (tx) => {
    const approval = requireApproval(tx.db, tx.workspaceId, approvalId);
    if (approval.status !== 'pending') {
      if (approval.status === wanted) {
        return { approval, run: requireRun(tx.db, tx.workspaceId, approval.runId), alreadyDecided: true };
      }
      throw conflict(`This approval was already ${approval.status}. A decision cannot be changed.`);
    }
    const run = requireRun(tx.db, tx.workspaceId, approval.runId);
    if (run.status !== 'waiting_approval') {
      throw conflict(`The run is ${run.status.replace('_', ' ')}, so this approval cannot be decided.`);
    }
    const stored = tx.db.prepare('SELECT payload, payload_hash FROM approval WHERE id = ?').get(approvalId) as {
      payload: string;
      payload_hash: string;
    };
    if (hashPayload(stored.payload) !== stored.payload_hash) {
      throw conflict('The approval payload changed after it was created, so it cannot be decided.');
    }

    const now = tx.now();
    tx.db
      .prepare('UPDATE approval SET status = ?, note = ?, decided_at = ?, decided_by = ? WHERE id = ?')
      .run(wanted, data.note ?? null, now, tx.actor, approvalId);
    tx.audit(`approval.${data.decision}`, 'approval', approvalId, { runId: run.id, note: data.note ?? null });

    if (approval.kind === 'import_review') {
      if (data.decision === 'approve') {
        const outcome = acceptImportBatch(tx, run.id, run.scope);
        const finalStatus = outcome.truncated ? 'partial' : 'succeeded';
        tx.db.prepare('UPDATE run SET status = ?, counts = ?, finished_at = ? WHERE id = ?').run(
          finalStatus,
          JSON.stringify({
            ...run.counts,
            processed: outcome.counts.fetched,
            found: outcome.counts.accepted,
            flagged: outcome.counts.duplicates + outcome.counts.invalid,
            ...outcome.counts,
            requested: run.counts.requested ?? Number(run.scope.maxItems ?? 0),
          }),
          now,
          run.id,
        );
        tx.audit(`run.${finalStatus}`, 'run', run.id, {
          accepted: outcome.accepted,
          skipped: outcome.skipped,
          organizationsCreated: outcome.organizationsCreated,
        });
      } else {
        cancelRunIn(tx, run.id, 'The import was rejected.');
        tx.audit('run.cancelled', 'run', run.id, { reason: 'approval_rejected' });
      }
    } else if (approval.kind === 'draft_review') {
      if (data.decision === 'approve') {
        const outcome = applyDrafts(tx, run.id, run.scope, approval.payload);
        const finalStatus = outcome.incomplete ? 'partial' : 'succeeded';
        tx.db.prepare('UPDATE run SET status = ?, finished_at = ? WHERE id = ?').run(finalStatus, now, run.id);
        tx.audit(`run.${finalStatus}`, 'run', run.id, { drafts: outcome.written, skipped: outcome.skipped });
      } else {
        cancelRunIn(tx, run.id, 'The drafts were rejected.');
        tx.audit('run.cancelled', 'run', run.id, { reason: 'approval_rejected' });
      }
    } else if (data.decision === 'approve') {
      const drafts = applyShortlist(tx, run.id, approval.payload);
      const requested = Number(run.scope.targetCount ?? run.counts.found);
      const finalStatus = run.counts.found < requested ? 'partial' : 'succeeded';
      tx.db.prepare('UPDATE run SET status = ?, finished_at = ? WHERE id = ?').run(finalStatus, now, run.id);
      tx.audit(`run.${finalStatus}`, 'run', run.id, { drafts });
    } else {
      cancelRunIn(tx, run.id, 'The shortlist was rejected.');
      tx.audit('run.cancelled', 'run', run.id, { reason: 'approval_rejected' });
    }
    tx.emit({ type: 'approval_updated', approvalId, runId: run.id });
    tx.emit({ type: 'run_updated', runId: run.id });
    return {
      approval: requireApproval(tx.db, tx.workspaceId, approvalId),
      run: getRun(tx.db, tx.workspaceId, run.id)!,
      alreadyDecided: false,
    };
  });
}
