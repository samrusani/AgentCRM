import { z } from 'zod';
import { conflict } from '../errors.js';
import { getRunDetail, listRunSteps, requireRun } from '../queries/runs.js';
import { dotSegmentMessage, hasDotSegment } from '../providers/apify.js';
import { getConnector } from '../queries/connectors.js';
import { terminalRunStatuses, type RunCounts } from '../records.js';
import { apifyKind, apifyStepTitles, defaultMaxItems, hardMaxItems, scheduleApifyRun } from './apifyScrape.js';
import { allowlistIncludes, connectApifyMessage } from './connectors.js';
import { type ActionContext, mutate, parseInput, type Tx } from './context.js';
import { defaultTargetCount, demoStepTitles, maxTargetCount, scheduleDemoRun } from './demoResearch.js';
import { closeImportBatchForRun } from './importReview.js';

const demoRunSchema = z
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

const apifyRunSchema = z
  .object({
    kind: z.literal('apify_scrape'),
    title: z.string().trim().min(1).max(200).optional(),
    scope: z
      .object({
        actorId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9_.~/-]+$/, 'Use an actor id like username/actor-name')
          .refine((value) => !hasDotSegment(value), dotSegmentMessage),
        input: z.record(z.unknown()),
        maxItems: z.number().int().min(1).max(hardMaxItems).default(defaultMaxItems),
      })
      .strict(),
  })
  .strict();

const startRunSchema = z.discriminatedUnion('kind', [demoRunSchema, apifyRunSchema]);

export interface StartRunOptions {
  // Runs started by an agent (MCP or the agent endpoint) may only use allowlisted Apify actors.
  origin?: 'user' | 'agent';
}

function assertApifyRunAllowed(ctx: ActionContext, actorId: string, origin: 'user' | 'agent'): void {
  const connector = getConnector(ctx.db, ctx.workspaceId, 'apify');
  if (!connector) throw conflict(connectApifyMessage);
  if (connector.status !== 'connected') throw conflict('Apify rejected the saved API token. Update it in Settings.');
  if (origin === 'agent' && !allowlistIncludes(connector, actorId)) {
    throw conflict(
      `Actor "${actorId}" is not on the Apify allowlist. Add it to the allowlist in Settings before an agent can run it.`,
    );
  }
}

export function scheduleRunJob(tx: Tx, kind: string, runId: string, runAt: string): void {
  if (kind === apifyKind) scheduleApifyRun(tx, runId, runAt);
  else scheduleDemoRun(tx, runId, runAt);
}

export function startRun(ctx: ActionContext, input: unknown, options: StartRunOptions = {}) {
  const data = parseInput(startRunSchema, input);
  const origin = options.origin ?? 'user';
  if (data.kind === 'apify_scrape') assertApifyRunAllowed(ctx, data.scope.actorId, origin);
  const runId = mutate(ctx, (tx) => {
    const id = tx.newId('run');
    const now = tx.now();
    let title: string;
    let stepTitles: readonly string[];
    let counts: RunCounts;
    let auditScope: Record<string, unknown>;
    let storedScope: Record<string, unknown> = data.scope;
    if (data.kind === 'apify_scrape') {
      if (origin === 'agent') {
        // Checked inside the write transaction so two processes cannot both pass it.
        const open = tx.db
          .prepare(
            "SELECT 1 FROM run WHERE workspace_id = ? AND kind = ? AND json_extract(scope, '$.origin') = 'agent' AND status IN ('queued', 'running', 'paused', 'waiting_approval') LIMIT 1",
          )
          .get(tx.workspaceId, apifyKind);
        if (open) {
          throw conflict(
            'One agent started import may run at a time. Approve, reject, or cancel the open agent import first.',
          );
        }
        storedScope = { ...data.scope, origin: 'agent' };
      }
      title = data.title ?? `Apify import: ${data.scope.actorId}`;
      stepTitles = apifyStepTitles;
      counts = {
        processed: 0,
        found: 0,
        flagged: 0,
        requested: data.scope.maxItems,
        fetched: 0,
        staged: 0,
        duplicates: 0,
        invalid: 0,
        accepted: 0,
      };
      auditScope = { actorId: data.scope.actorId, maxItems: data.scope.maxItems, origin };
    } else {
      title =
        data.title ??
        (data.scope.query ? `Simulated research: ${data.scope.query}` : 'Simulated research: investor shortlist');
      stepTitles = demoStepTitles;
      counts = { processed: 0, found: 0, flagged: 0 };
      auditScope = { scope: data.scope };
    }
    tx.db
      .prepare(
        `INSERT INTO run (id, created_at, workspace_id, kind, title, status, scope, counts)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(id, now, tx.workspaceId, data.kind, title, JSON.stringify(storedScope), JSON.stringify(counts));
    stepTitles.forEach((stepTitle, index) => {
      tx.db
        .prepare("INSERT INTO run_step (id, created_at, run_id, seq, title, status) VALUES (?, ?, ?, ?, ?, 'pending')")
        .run(tx.newId('stp'), now, id, index + 1, stepTitle);
    });
    scheduleRunJob(tx, data.kind, id, now);
    tx.audit('run.create', 'run', id, { kind: data.kind, ...auditScope });
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
      scheduleRunJob(tx, run.kind, runId, now);
    } else {
      if ((terminalRunStatuses as readonly string[]).includes(run.status)) {
        throw conflict(`A run that is ${run.status} cannot be cancelled.`);
      }
      cancelRunIn(tx, runId, 'Cancelled by a user action.');
      // A paused or idle run has no job left. Queue one so the worker asks Apify to stop the actor run.
      const scope = run.scope as { apifyRunId?: string; apifyFinished?: boolean; abortRequested?: boolean };
      if (run.kind === apifyKind && scope.apifyRunId && !scope.apifyFinished && !scope.abortRequested) {
        scheduleRunJob(tx, run.kind, runId, now);
      }
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
  closeImportBatchForRun(tx, runId, 'rejected', reason);
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
    closeImportBatchForRun(tx, runId, 'failed', message);
    tx.audit('run.failed', 'run', runId, { message });
    tx.emit({ type: 'run_updated', runId });
  });
}
