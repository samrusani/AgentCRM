import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  newWorkerLeaseIdentity,
  readWorkerLease,
  releaseWorkerLease,
  settleWorkerLease,
  type SettleWorkerLeaseOptions,
  type WorkerLeaseIdentity,
} from '../src/actions/index.js';
import { workerLeaseTimeoutMilliseconds } from '../src/config.js';
import { createWorkerTick, processJobs } from '../src/jobs/worker.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';

let env: TestEnvironment;

beforeEach(() => {
  env = createTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

const alive: SettleWorkerLeaseOptions = { isPidAlive: () => true };

function identity(kind: 'server' | 'mcp', pid: number, token: string): WorkerLeaseIdentity {
  return { holder: `${kind}:${pid}:${token}`, kind, pid };
}

const serverA = identity('server', 4001, 'aaaa');
const serverB = identity('server', 4002, 'bbbb');
const mcpA = identity('mcp', 5001, 'aaaa');
const mcpB = identity('mcp', 5002, 'bbbb');

function leaseRows(): unknown[] {
  return env.db.prepare('SELECT * FROM worker_lease').all();
}

describe('settleWorkerLease', () => {
  it('takes the lease when there is no row', () => {
    expect(readWorkerLease(env.ctx)).toBeNull();
    expect(settleWorkerLease(env.ctx, serverA, alive)).toBe(true);
    const lease = readWorkerLease(env.ctx)!;
    expect(lease.holder).toBe(serverA.holder);
    expect(lease.kind).toBe('server');
    expect(lease.pid).toBe(4001);
    expect(lease.acquiredAt).toMatch(/^2026-03-01T/);
    expect(lease.renewedAt).toBe(lease.acquiredAt);
  });

  it('renews without changing acquired_at when the same holder settles again', () => {
    settleWorkerLease(env.ctx, serverA, alive);
    const first = readWorkerLease(env.ctx)!;
    env.advance(500);
    expect(settleWorkerLease(env.ctx, serverA, alive)).toBe(true);
    const second = readWorkerLease(env.ctx)!;
    expect(second.acquiredAt).toBe(first.acquiredAt);
    expect(Date.parse(second.renewedAt)).toBeGreaterThan(Date.parse(first.renewedAt));
    expect(leaseRows()).toHaveLength(1);
  });

  it('refuses an mcp worker while a fresh server holds the lease, and writes nothing', () => {
    settleWorkerLease(env.ctx, serverA, alive);
    const before = leaseRows();
    env.advance(1000);
    expect(settleWorkerLease(env.ctx, mcpA, alive)).toBe(false);
    expect(leaseRows()).toEqual(before);
  });

  it('lets a server worker preempt a fresh mcp holder', () => {
    settleWorkerLease(env.ctx, mcpA, alive);
    env.advance(1000);
    expect(settleWorkerLease(env.ctx, serverA, alive)).toBe(true);
    const lease = readWorkerLease(env.ctx)!;
    expect(lease.holder).toBe(serverA.holder);
    expect(lease.kind).toBe('server');
    expect(lease.pid).toBe(4001);
    // The old holder now yields on its next tick.
    expect(settleWorkerLease(env.ctx, mcpA, alive)).toBe(false);
  });

  it('refuses a second server worker while a fresh server holds the lease', () => {
    settleWorkerLease(env.ctx, serverA, alive);
    const before = leaseRows();
    expect(settleWorkerLease(env.ctx, serverB, alive)).toBe(false);
    expect(leaseRows()).toEqual(before);
  });

  it('refuses a second mcp worker while a fresh mcp holds the lease', () => {
    settleWorkerLease(env.ctx, mcpA, alive);
    const before = leaseRows();
    expect(settleWorkerLease(env.ctx, mcpB, alive)).toBe(false);
    expect(leaseRows()).toEqual(before);
  });

  it('lets any worker take a stale lease', () => {
    settleWorkerLease(env.ctx, serverA, { ...alive, timeoutMilliseconds: 5000 });
    env.advance(4000);
    expect(settleWorkerLease(env.ctx, mcpA, { ...alive, timeoutMilliseconds: 5000 })).toBe(false);
    env.advance(2000);
    expect(settleWorkerLease(env.ctx, mcpA, { ...alive, timeoutMilliseconds: 5000 })).toBe(true);
    const lease = readWorkerLease(env.ctx)!;
    expect(lease.holder).toBe(mcpA.holder);
    expect(lease.acquiredAt).toBe(lease.renewedAt);
  });

  it('uses the configured timeout by default', () => {
    settleWorkerLease(env.ctx, serverA, alive);
    env.advance(workerLeaseTimeoutMilliseconds - 1000);
    expect(settleWorkerLease(env.ctx, serverB, alive)).toBe(false);
    env.advance(2000);
    expect(settleWorkerLease(env.ctx, serverB, alive)).toBe(true);
  });

  it('takes the lease at once when the holder pid is dead, even when it is fresh', () => {
    settleWorkerLease(env.ctx, serverA, alive);
    const checked: number[] = [];
    const dead: SettleWorkerLeaseOptions = {
      isPidAlive: (pid) => {
        checked.push(pid);
        return false;
      },
    };
    expect(settleWorkerLease(env.ctx, mcpA, dead)).toBe(true);
    expect(checked).toEqual([4001]);
    expect(readWorkerLease(env.ctx)!.holder).toBe(mcpA.holder);
  });

  it('treats a pid that does not exist as dead and a live pid as alive with the real check', () => {
    const own = newWorkerLeaseIdentity('mcp');
    expect(own.holder).toMatch(new RegExp(`^mcp:${process.pid}:[0-9a-f]+$`));
    expect(own.pid).toBe(process.pid);
    expect(newWorkerLeaseIdentity('mcp').holder).not.toBe(own.holder);

    // A fresh row held by this very process counts as alive, so a second mcp identity is refused.
    settleWorkerLease(env.ctx, own);
    expect(settleWorkerLease(env.ctx, newWorkerLeaseIdentity('mcp'))).toBe(false);

    // A pid above the platform maximum cannot exist, so the real check reads it as dead.
    env.db.prepare("UPDATE worker_lease SET holder = 'server:2147483647:dead', kind = 'server', pid = 2147483647").run();
    expect(settleWorkerLease(env.ctx, own)).toBe(true);
    expect(readWorkerLease(env.ctx)!.holder).toBe(own.holder);
  });

  it('writes no audit events', () => {
    const before = (env.db.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as { n: number }).n;
    settleWorkerLease(env.ctx, serverA, alive);
    settleWorkerLease(env.ctx, serverA, alive);
    settleWorkerLease(env.ctx, mcpA, alive);
    releaseWorkerLease(env.ctx, serverA);
    expect((env.db.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as { n: number }).n).toBe(before);
  });
});

describe('releaseWorkerLease', () => {
  it('removes the row only when the holder matches', () => {
    settleWorkerLease(env.ctx, serverA, alive);
    releaseWorkerLease(env.ctx, serverB);
    expect(readWorkerLease(env.ctx)!.holder).toBe(serverA.holder);
    releaseWorkerLease(env.ctx, serverA);
    expect(readWorkerLease(env.ctx)).toBeNull();
    // Releasing with no row is harmless.
    releaseWorkerLease(env.ctx, serverA);
  });

  it('lets another worker take the lease straight after a release', () => {
    settleWorkerLease(env.ctx, serverA, alive);
    releaseWorkerLease(env.ctx, serverA);
    expect(settleWorkerLease(env.ctx, mcpA, alive)).toBe(true);
  });
});

describe('worker tick gate', () => {
  function addDueJob(id: string): void {
    const now = env.ctx.now();
    env.db
      .prepare('INSERT INTO job (id, created_at, kind, payload, run_at, attempts, status, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
      .run(id, now, 'demo_run_step', JSON.stringify({ runId: `run_${id}`, workspaceId: env.workspaceId }), now, 'queued', now);
  }

  function attempts(id: string): number {
    return (env.db.prepare('SELECT attempts FROM job WHERE id = ?').get(id) as { attempts: number }).attempts;
  }

  async function lanesFinish(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('does nothing in a tick that does not hold the lease, and still lets direct calls process jobs', async () => {
    addDueJob('job_gate00000001');
    settleWorkerLease(env.ctx, serverA, alive);
    env.advance(10);
    const errors: unknown[] = [];
    const tick = createWorkerTick(env.ctx, mcpA, (error) => errors.push(error), { mail: false, lease: alive });
    tick();
    await lanesFinish();
    expect(attempts('job_gate00000001')).toBe(0);
    expect(readWorkerLease(env.ctx)!.holder).toBe(serverA.holder);

    // The lease scopes the ticking workers only. A direct call claims the job as before.
    expect(processJobs(env.ctx)).toBe(1);
    expect(attempts('job_gate00000001')).toBe(1);
    expect(errors).toEqual([]);
  });

  it('processes jobs in a tick that holds the lease and renews it', async () => {
    addDueJob('job_gate00000002');
    env.advance(10);
    const errors: unknown[] = [];
    const tick = createWorkerTick(env.ctx, mcpA, (error) => errors.push(error), { mail: false, lease: alive });
    tick();
    await lanesFinish();
    expect(readWorkerLease(env.ctx)!.holder).toBe(mcpA.holder);
    expect(attempts('job_gate00000002')).toBe(1);
    expect(errors).toEqual([]);
  });

  it('hands the work over when a server tick preempts an mcp holder', async () => {
    addDueJob('job_gate00000003');
    settleWorkerLease(env.ctx, mcpA, alive);
    env.advance(10);
    const mcpTick = createWorkerTick(env.ctx, mcpA, () => undefined, { mail: false, lease: alive });
    const serverTick = createWorkerTick(env.ctx, serverA, () => undefined, { mail: false, lease: alive });
    serverTick();
    mcpTick();
    await lanesFinish();
    // The server tick claimed the job once. The preempted mcp tick did not claim it again.
    expect(attempts('job_gate00000003')).toBe(1);
    expect(readWorkerLease(env.ctx)!.holder).toBe(serverA.holder);
  });
});
