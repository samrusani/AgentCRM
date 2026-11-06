import { randomBytes } from 'node:crypto';
import { workerLeaseTimeoutMilliseconds } from '../config.js';
import type { Db } from '../db.js';
import type { ActionContext } from './context.js';

export type WorkerLeaseKind = 'server' | 'mcp';

export interface WorkerLeaseIdentity {
  holder: string;
  kind: WorkerLeaseKind;
  pid: number;
}

export interface WorkerLeaseRecord {
  holder: string;
  kind: WorkerLeaseKind;
  pid: number;
  acquiredAt: string;
  renewedAt: string;
}

interface WorkerLeaseRow {
  holder: string;
  kind: WorkerLeaseKind;
  pid: number;
  acquired_at: string;
  renewed_at: string;
}

export interface SettleWorkerLeaseOptions {
  // Tests replace the pid check and shorten the timeout. Production uses process.kill and the configured timeout.
  isPidAlive?: (pid: number) => boolean;
  timeoutMilliseconds?: number;
}

// The holder token is unique per process start, so a restarted process never mistakes an old row for its own.
export function newWorkerLeaseIdentity(kind: WorkerLeaseKind): WorkerLeaseIdentity {
  return { holder: `${kind}:${process.pid}:${randomBytes(6).toString('hex')}`, kind, pid: process.pid };
}

// Signal 0 only checks that the pid exists. EPERM means it exists under another user, so it counts as alive.
function isPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

// Returns true when this process holds the lease after the call. One immediate transaction, like claimDueJobs.
// Lease settling is plumbing and writes no audit events.
export function settleWorkerLease(
  ctx: ActionContext,
  identity: WorkerLeaseIdentity,
  options: SettleWorkerLeaseOptions = {},
): boolean {
  const pidAlive = options.isPidAlive ?? isPidAlive;
  const timeout = options.timeoutMilliseconds ?? workerLeaseTimeoutMilliseconds;
  return ctx.db
    .transaction(() => {
      const now = ctx.now();
      const row = ctx.db.prepare("SELECT * FROM worker_lease WHERE id = 'worker'").get() as WorkerLeaseRow | undefined;
      const take = (): boolean => {
        ctx.db
          .prepare(
            "INSERT INTO worker_lease (id, holder, kind, pid, acquired_at, renewed_at) VALUES ('worker', ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, kind = excluded.kind, pid = excluded.pid, acquired_at = excluded.acquired_at, renewed_at = excluded.renewed_at",
          )
          .run(identity.holder, identity.kind, identity.pid, now, now);
        return true;
      };
      if (!row) return take();
      if (row.holder === identity.holder) {
        ctx.db.prepare("UPDATE worker_lease SET renewed_at = ? WHERE id = 'worker' AND holder = ?").run(now, identity.holder);
        return true;
      }
      // Fresh only when the age is a number whose absolute value fits the timeout. A stamp in the future (a stepped
      // clock) or one that does not parse must count as stale, so a corrupted or future dated row can never block the
      // queue for longer than the timeout.
      const age = Date.parse(now) - Date.parse(row.renewed_at);
      const fresh = Math.abs(age) <= timeout;
      if (!fresh || !pidAlive(row.pid)) return take();
      // The API server is the preferred worker, so it takes a fresh lease from an mcp process and from nobody else.
      if (identity.kind === 'server' && row.kind === 'mcp') return take();
      return false;
    })
    .immediate();
}

// A clean stop hands the lease over on the next tick. A row held by someone else is left alone.
export function releaseWorkerLease(ctx: ActionContext, identity: WorkerLeaseIdentity): void {
  ctx.db.prepare("DELETE FROM worker_lease WHERE id = 'worker' AND holder = ?").run(identity.holder);
}

export function readWorkerLease(ctx: { db: Db }): WorkerLeaseRecord | null {
  const row = ctx.db.prepare("SELECT * FROM worker_lease WHERE id = 'worker'").get() as WorkerLeaseRow | undefined;
  if (!row) return null;
  return { holder: row.holder, kind: row.kind, pid: row.pid, acquiredAt: row.acquired_at, renewedAt: row.renewed_at };
}
