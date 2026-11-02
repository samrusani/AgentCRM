import { type ActionContext, type Tx } from './context.js';

export interface JobRecord {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  runAt: string;
  attempts: number;
}

interface JobRow {
  id: string;
  kind: string;
  payload: string;
  run_at: string;
  attempts: number;
}

export const maxJobAttempts = 3;

// A run has at most one queued or running job, so pause and resume cannot double step it.
export function enqueueJobIn(tx: Tx, kind: string, payload: Record<string, unknown>, runAt: string): string | null {
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  if (runId) {
    const existing = tx.db
      .prepare(
        "SELECT id FROM job WHERE kind = ? AND status IN ('queued', 'running') AND json_extract(payload, '$.runId') = ?",
      )
      .get(kind, runId);
    if (existing) return null;
  }
  const id = tx.newId('job');
  const now = tx.now();
  tx.db
    .prepare('INSERT INTO job (id, created_at, kind, payload, run_at, attempts, status, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
    .run(id, now, kind, JSON.stringify(payload), runAt, 'queued', now);
  return id;
}

export function claimDueJobs(ctx: ActionContext, limit = 10): JobRecord[] {
  return ctx.db
    .transaction(() => {
      const now = ctx.now();
      const rows = ctx.db
        .prepare("SELECT * FROM job WHERE status = 'queued' AND run_at <= ? ORDER BY run_at, id LIMIT ?")
        .all(now, limit) as JobRow[];
      for (const row of rows) {
        ctx.db
          .prepare("UPDATE job SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
          .run(now, row.id);
      }
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        runAt: row.run_at,
        attempts: row.attempts + 1,
      }));
    })
    .immediate();
}

export function completeJob(ctx: ActionContext, jobId: string): void {
  ctx.db.prepare("UPDATE job SET status = 'done', updated_at = ? WHERE id = ?").run(ctx.now(), jobId);
}

export function rescheduleJob(ctx: ActionContext, jobId: string, runAt: string, resetAttempts: boolean): void {
  ctx.db
    .prepare(
      `UPDATE job SET status = 'queued', run_at = ?, updated_at = ?${resetAttempts ? ', attempts = 0' : ''} WHERE id = ?`,
    )
    .run(runAt, ctx.now(), jobId);
}

export function failJob(ctx: ActionContext, jobId: string): void {
  ctx.db.prepare("UPDATE job SET status = 'failed', updated_at = ? WHERE id = ?").run(ctx.now(), jobId);
}

// A job left in "running" means the process stopped mid-step. Steps are idempotent per run state, so retry it.
export function recoverStaleJobs(ctx: ActionContext): number {
  const result = ctx.db
    .prepare("UPDATE job SET status = 'queued', updated_at = ? WHERE status = 'running'")
    .run(ctx.now());
  return result.changes;
}
