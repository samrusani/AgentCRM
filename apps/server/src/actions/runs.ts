import { z } from 'zod';
import { conflict } from '../errors.js';
import { getRunDetail, listRunSteps, requireRun } from '../queries/runs.js';
import { terminalRunStatuses } from '../records.js';
import { type ActionContext, mutate, parseInput, type Tx } from './context.js';
import { defaultTargetCount, demoStepTitles, maxTargetCount, scheduleDemoRun } from './demoResearch.js';

const startRunSchema = z
  .object({
    kind: z.literal('demo_research'),
    title: z.string().trim().min(1).max(200).optional(),
    scope: z
      .object({
        targetCount: z.number().int().min(1).max(maxTargetCount).default(defaultTargetCount),
        query: z.string().trim().max(200).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export function startRun(ctx: ActionContext, input: unknown) {
  const data = parseInput(startRunSchema, input);
  const runId = mutate(ctx, (tx) => {
    const id = tx.newId('run');
    const now = tx.now();
    const title =
      data.title ??
      (data.scope.query ? `Simulated research: ${data.scope.query}` : 'Simulated research: investor shortlist');
    tx.db
      .prepare(
        `INSERT INTO run (id, created_at, workspace_id, kind, title, status, scope, counts)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        id,
        now,
        tx.workspaceId,
        data.kind,
        title,
        JSON.stringify(data.scope),
        JSON.stringify({ processed: 0, found: 0, flagged: 0 }),
      );
    demoStepTitles.forEach((stepTitle, index) => {
      tx.db
        .prepare("INSERT INTO run_step (id, created_at, run_id, seq, title, status) VALUES (?, ?, ?, ?, ?, 'pending')")
        .run(tx.newId('stp'), now, id, index + 1, stepTitle);
    });
    scheduleDemoRun(tx, id, now);
    tx.audit('run.create', 'run', id, { kind: data.kind, scope: data.scope });
    tx.emit({ type: 'run_updated', runId: id });
    return id;
  });
  return getRunDetail(ctx.db, ctx.workspaceId, runId);
}

const controlSchema = z.object({ action: z.enum(['pause', 'resume', 'cancel']) }).strict();

export function controlRun(ctx: ActionContext, runId: string, input: unknown) {
  const { action } = parseInput(controlSchema, input);
  mutate(ctx, (tx) => {
    const run = requireRun(tx.db, tx.workspaceId, runId);
    const now = tx.now();
    if (action === 'pause') {
      if (run.status !== 'running' && run.status !== 'queued') {
        throw conflict(`A run that is ${run.status.replace('_', ' ')} cannot be paused.`);
      }
      tx.db.prepare("UPDATE run SET status = 'paused' WHERE id = ?").run(runId);
    } else if (action === 'resume') {
      if (run.status !== 'paused') {
        throw conflict(`A run that is ${run.status.replace('_', ' ')} cannot be resumed.`);
      }
      tx.db.prepare('UPDATE run SET status = ? WHERE id = ?').run(run.startedAt ? 'running' : 'queued', runId);
      scheduleDemoRun(tx, runId, now);
    } else {
      if ((terminalRunStatuses as readonly string[]).includes(run.status)) {
        throw conflict(`A run that is ${run.status} cannot be cancelled.`);
      }
      cancelRunIn(tx, runId, 'Cancelled by a user action.');
    }
    tx.audit(`run.${action}`, 'run', runId);
    tx.emit({ type: 'run_updated', runId });
  });
  return getRunDetail(ctx.db, ctx.workspaceId, runId);
}

// Cancel is final: unfinished steps are skipped and any pending approval is closed as rejected.
export function cancelRunIn(tx: Tx, runId: string, reason: string): void {
  const now = tx.now();
  tx.db.prepare("UPDATE run SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now, runId);
  for (const step of listRunSteps(tx.db, runId)) {
    if (step.status === 'pending' || step.status === 'running') {
      tx.db
        .prepare("UPDATE run_step SET status = 'skipped', detail = COALESCE(detail, ?), finished_at = ? WHERE id = ?")
        .run(reason, now, step.id);
    }
  }
  const pending = tx.db
    .prepare("SELECT id FROM approval WHERE run_id = ? AND status = 'pending'")
    .all(runId) as { id: string }[];
  for (const approval of pending) {
    tx.db
      .prepare("UPDATE approval SET status = 'rejected', note = ?, decided_at = ?, decided_by = 'system' WHERE id = ?")
      .run(reason, now, approval.id);
    tx.audit('approval.reject', 'approval', approval.id, { runId, reason });
    tx.emit({ type: 'approval_updated', approvalId: approval.id, runId });
  }
}

export function failRun(ctx: ActionContext, runId: string, message: string): void {
  mutate(ctx, (tx) => {
    const run = requireRun(tx.db, tx.workspaceId, runId);
    if ((terminalRunStatuses as readonly string[]).includes(run.status)) return;
    const now = tx.now();
    tx.db.prepare("UPDATE run SET status = 'failed', finished_at = ? WHERE id = ?").run(now, runId);
    for (const step of listRunSteps(tx.db, runId)) {
      if (step.status === 'running') {
        tx.db
          .prepare("UPDATE run_step SET status = 'failed', detail = ?, finished_at = ? WHERE id = ?")
          .run(message, now, step.id);
      } else if (step.status === 'pending') {
        tx.db.prepare("UPDATE run_step SET status = 'skipped', finished_at = ? WHERE id = ?").run(now, step.id);
      }
    }
    tx.audit('run.failed', 'run', runId, { message });
    tx.emit({ type: 'run_updated', runId });
  });
}
