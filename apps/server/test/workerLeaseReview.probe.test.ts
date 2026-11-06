import Database from 'better-sqlite3';
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apifyJobKind,
  claimDueJobs,
  createContext,
  draftJobKind,
  leadCaptureJobKind,
  mailReconcileJobKind,
  newWorkerLeaseIdentity,
  processQueuedIntents,
  readWorkerLease,
  releaseWorkerLease,
  settleWorkerLease,
  syncMailIfDue,
  tickFollowupRulesIfDue,
  type ActionContext,
  type SettleWorkerLeaseOptions,
  type WorkerLeaseIdentity,
  type WorkerLeaseKind,
  type WorkerLeaseRecord,
} from '../src/actions/index.js';
import { openDatabase } from '../src/db.js';
import { migrationsDirectory, packageRoot } from '../src/paths.js';
import { createWorkerTick, processAllJobs, processJobs, startWorker } from '../src/jobs/worker.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';

// Adversarial probes for the worker lease (docs/architecture.md, "The worker lease").
// "CONFIRMS:" tests demonstrate a live bug: they assert the CURRENT behavior so they pass, and the comment says what
// the correct behavior would be.
// "KILLS:" tests prove a suspected hole is closed.
// "ACCEPTED:" tests document a limit the contract states, or one it should state.

// Spies wrapped around the real functions, so a gated tick can be proven to call none of them.
vi.mock('../src/actions/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/actions/index.js')>();
  return {
    ...actual,
    claimDueJobs: vi.fn(actual.claimDueJobs),
    processQueuedIntents: vi.fn(actual.processQueuedIntents),
    tickFollowupRulesIfDue: vi.fn(actual.tickFollowupRulesIfDue),
    syncMailIfDue: vi.fn(actual.syncMailIfDue),
  };
});

const execFileAsync = promisify(execFile);
const tsxBinary = path.join(packageRoot, 'node_modules', '.bin', 'tsx');

let env: TestEnvironment;
const extraDatabases: { close: () => void }[] = [];

const spies = [claimDueJobs, processQueuedIntents, tickFollowupRulesIfDue, syncMailIfDue] as unknown as { mockClear: () => void }[];

beforeEach(() => {
  env = createTestEnvironment();
  for (const spy of spies) spy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  for (const database of extraDatabases.splice(0)) database.close();
  env.cleanup();
});

const alive: SettleWorkerLeaseOptions = { isPidAlive: () => true };
const dead: SettleWorkerLeaseOptions = { isPidAlive: () => false };

function identity(kind: WorkerLeaseKind, pid: number, token: string): WorkerLeaseIdentity {
  return { holder: `${kind}:${pid}:${token}`, kind, pid };
}

const serverA = identity('server', 4001, 'aaaa');
const serverB = identity('server', 4002, 'bbbb');
const mcpA = identity('mcp', 5001, 'aaaa');
const mcpB = identity('mcp', 5002, 'bbbb');

const baseTime = Date.parse('2026-03-01T09:00:00.000Z');

// A context whose clock is frozen at base + offset, so boundary tests control the exact millisecond.
function ctxAt(offsetMilliseconds: number, source: ActionContext = env.ctx): ActionContext {
  return { ...source, now: () => new Date(baseTime + offsetMilliseconds).toISOString() };
}

function insertLease(row: { holder: string; kind: WorkerLeaseKind; pid: number; renewedAt: string }): void {
  env.db.prepare('DELETE FROM worker_lease').run();
  env.db
    .prepare("INSERT INTO worker_lease (id, holder, kind, pid, acquired_at, renewed_at) VALUES ('worker', ?, ?, ?, ?, ?)")
    .run(row.holder, row.kind, row.pid, row.renewedAt, row.renewedAt);
}

function addJob(id: string, kind = 'demo_run_step', status = 'queued', attempts = 0): void {
  const now = env.ctx.now();
  env.db
    .prepare('INSERT INTO job (id, created_at, kind, payload, run_at, attempts, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, kind, JSON.stringify({ runId: `run_${id}`, workspaceId: env.workspaceId }), now, attempts, status, now);
}

function jobRow(id: string): { status: string; attempts: number } {
  return env.db.prepare('SELECT status, attempts FROM job WHERE id = ?').get(id) as { status: string; attempts: number };
}

function snapshot(): Record<string, unknown[]> {
  const tables = env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map((table) => [table.name, env.db.prepare(`SELECT * FROM "${table.name}"`).all()]));
}

const settle = (ctx: ActionContext, who: WorkerLeaseIdentity, options: SettleWorkerLeaseOptions = alive): boolean => settleWorkerLease(ctx, who, options);
const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

// ---------------------------------------------------------------------------------------------------------------
// 1. Mutual exclusion
// ---------------------------------------------------------------------------------------------------------------

describe('mutual exclusion', () => {
  it('KILLS: every interleaving of two identities in every kind pairing obeys the contract rules and never leaves two holders', () => {
    const memory = new Database(':memory:');
    extraDatabases.push(memory);
    memory.exec(readFileSync(path.join(migrationsDirectory, '021_worker_lease.sql'), 'utf8'));
    const kinds: WorkerLeaseKind[] = ['server', 'mcp'];
    const deltas = [0, 6000, 10000, 10001];
    const timeout = 10_000;
    let settles = 0;
    let takeovers = 0;

    for (const kindX of kinds) {
      for (const kindY of kinds) {
        const x = identity(kindX, 4001, 'xxxx');
        const y = identity(kindY, 4002, 'yyyy');
        // Liveness dimension: the pid of x and of y may each be alive or dead.
        for (const xAlive of [true, false]) {
          for (const yAlive of [true, false]) {
            const isPidAlive = (pid: number): boolean => (pid === 4001 ? xAlive : yAlive);
            const choices = kinds.length * deltas.length;
            for (let code = 0; code < choices ** 4; code += 1) {
              memory.prepare('DELETE FROM worker_lease').run();
              let clock = 0;
              let rest = code;
              for (let step = 0; step < 4; step += 1) {
                const choice = rest % choices;
                rest = Math.floor(rest / choices);
                const who = choice % 2 === 0 ? x : y;
                clock += deltas[Math.floor(choice / 2)]!;
                const ctx = { db: memory, now: () => new Date(baseTime + clock).toISOString() } as unknown as ActionContext;
                const before = readWorkerLease(ctx);
                const result = settleWorkerLease(ctx, who, { isPidAlive, timeoutMilliseconds: timeout });
                const after = readWorkerLease(ctx);
                settles += 1;
                // At most one holder ever exists, and whoever got true is exactly that holder.
                expect(after).not.toBeNull();
                if (result) expect(after!.holder).toBe(who.holder);
                if (!before) {
                  expect(result).toBe(true);
                  continue;
                }
                if (before.holder === who.holder) {
                  expect(result).toBe(true);
                  expect(after!.acquiredAt).toBe(before.acquiredAt);
                  continue;
                }
                const holderPidAlive = isPidAlive(before.pid);
                const stale = clock - (Date.parse(before.renewedAt) - baseTime) > timeout;
                const preferred = who.kind === 'server' && before.kind === 'mcp';
                const mayTake = stale || !holderPidAlive || preferred;
                expect(result).toBe(mayTake);
                if (result) {
                  takeovers += 1;
                } else {
                  // A refused settle writes nothing.
                  expect(after).toEqual(before);
                }
              }
            }
          }
        }
      }
    }
    expect(settles).toBeGreaterThan(100_000);
    expect(takeovers).toBeGreaterThan(1000);
  });

  it('KILLS: a stale holder renewing cannot resurrect a lease another connection just took (no lost update across connections)', () => {
    const second = openDatabase(env.databasePath);
    extraDatabases.push(second);
    const otherCtx = createContext(second, env.workspaceId, { now: () => new Date(baseTime + 1000).toISOString() });
    expect(settle(ctxAt(0), mcpA)).toBe(true);
    expect(settle(otherCtx, serverA)).toBe(true);
    // The old holder's renew arrives after the takeover, with a later clock. It must not touch the row.
    expect(settle(ctxAt(2000), mcpA)).toBe(false);
    const lease = readWorkerLease(env.ctx)!;
    expect(lease.holder).toBe(serverA.holder);
    expect(lease.renewedAt).toBe(new Date(baseTime + 1000).toISOString());
    // And the renew guard is in SQL too: the UPDATE carries the holder, so a bare renew cannot hit another holder's row.
    expect(releaseWorkerLease(ctxAt(3000), mcpA)).toBeUndefined();
    expect(readWorkerLease(env.ctx)!.holder).toBe(serverA.holder);
  });

  it('KILLS: the settle transaction holds the write lock before it reads the row (immediate, not deferred)', () => {
    const second = openDatabase(env.databasePath);
    second.pragma('busy_timeout = 0');
    extraDatabases.push(second);
    settle(ctxAt(0), mcpA);
    let competingWriteError: NodeJS.ErrnoException | undefined;
    let competingReadWorked = false;
    // The liveness callback runs inside the settle transaction, after the row was read.
    const result = settleWorkerLease(ctxAt(100), mcpB, {
      isPidAlive: () => {
        try {
          second.prepare("UPDATE worker_lease SET renewed_at = renewed_at WHERE id = 'worker'").run();
        } catch (error) {
          competingWriteError = error as NodeJS.ErrnoException;
        }
        competingReadWorked = second.prepare('SELECT COUNT(*) AS n FROM worker_lease').get() !== undefined;
        return true;
      },
    });
    expect(result).toBe(false);
    // A second process cannot write between this settle's read and write: it gets SQLITE_BUSY, so the read cannot go stale.
    expect(competingWriteError?.code).toBe('SQLITE_BUSY');
    // WAL readers are never blocked, so doctor and readWorkerLease stay available.
    expect(competingReadWorked).toBe(true);
  });

  it('KILLS: three real processes (two servers, one mcp) settling every few milliseconds never lose the lease once won and never error', async () => {
    const childSource = `
(async () => {
  const root = process.env.HAMMER_ROOT;
  const { openDatabase } = await import(root + '/src/db.ts');
  const { createContext } = await import(root + '/src/actions/context.ts');
  const { newWorkerLeaseIdentity, settleWorkerLease } = await import(root + '/src/actions/workerLease.ts');
  const db = openDatabase(process.env.HAMMER_DB);
  const ctx = createContext(db, process.env.HAMMER_WORKSPACE);
  const me = newWorkerLeaseIdentity(process.env.HAMMER_KIND);
  const startAt = Number(process.env.HAMMER_START);
  const endAt = startAt + Number(process.env.HAMMER_DURATION);
  while (Date.now() < startAt) { /* spin until the shared start */ }
  let first = 0, last = 0, wins = 0, falseAfterWin = 0, attempts = 0;
  const errors = [];
  while (Date.now() < endAt) {
    attempts += 1;
    try {
      const got = settleWorkerLease(ctx, me);
      const at = Date.now();
      if (got) { if (!first) first = at; last = at; wins += 1; }
      else if (first) falseAfterWin += 1;
    } catch (error) { errors.push(String(error && error.message)); }
    await new Promise((r) => setTimeout(r, 2));
  }
  db.close();
  console.log('RESULT' + JSON.stringify({ kind: process.env.HAMMER_KIND, pid: process.pid, first, last, wins, falseAfterWin, attempts, errors }));
})();`;
    const startAt = Date.now() + 2500;
    const run = async (kind: WorkerLeaseKind): Promise<{ kind: string; pid: number; first: number; last: number; wins: number; falseAfterWin: number; attempts: number; errors: string[] }> => {
      const { stdout } = await execFileAsync(tsxBinary, ['-e', childSource], {
        cwd: packageRoot,
        env: {
          ...process.env,
          HAMMER_ROOT: packageRoot,
          HAMMER_DB: env.databasePath,
          HAMMER_WORKSPACE: env.workspaceId,
          HAMMER_KIND: kind,
          HAMMER_START: String(startAt),
          HAMMER_DURATION: '1500',
        },
        timeout: 30_000,
      });
      const line = stdout.split('\n').find((candidate) => candidate.startsWith('RESULT'))!;
      return JSON.parse(line.slice('RESULT'.length));
    };
    const results = await Promise.all([run('server'), run('server'), run('mcp')]);
    const servers = results.filter((result) => result.kind === 'server');
    const mcp = results.find((result) => result.kind === 'mcp')!;
    for (const result of results) {
      expect(result.errors).toEqual([]);
      expect(result.attempts).toBeGreaterThan(50);
    }
    // Exactly one server ever won, because a server never takes a fresh lease from a server and nobody was stale.
    const winners = servers.filter((result) => result.wins > 0);
    expect(winners).toHaveLength(1);
    const winner = winners[0]!;
    // The winner never lost the lease afterwards: no false after its first win.
    expect(winner.falseAfterWin).toBe(0);
    // The mcp may have held it before the server arrived but never after (small tolerance for timestamp capture order).
    expect(mcp.last).toBeLessThanOrEqual(winner.first + 5);
    const lease = readWorkerLease(env.ctx)!;
    expect(lease.kind).toBe('server');
    expect(lease.pid).toBe(winner.pid);
  }, 40_000);
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Preemption and flapping
// ---------------------------------------------------------------------------------------------------------------

describe('preemption', () => {
  it('KILLS: after a server takes a fresh mcp lease the mcp refuses on every later settle and the lease never flaps', () => {
    settle(ctxAt(0), mcpA);
    expect(settle(ctxAt(300), serverA)).toBe(true);
    const acquired = readWorkerLease(env.ctx)!.acquiredAt;
    for (let tick = 1; tick <= 100; tick += 1) {
      expect(settle(ctxAt(300 + tick * 300), mcpA)).toBe(false);
      expect(settle(ctxAt(300 + tick * 300 + 1), serverA)).toBe(true);
      expect(settle(ctxAt(300 + tick * 300 + 2), mcpB)).toBe(false);
    }
    const lease = readWorkerLease(env.ctx)!;
    expect(lease.holder).toBe(serverA.holder);
    expect(lease.acquiredAt).toBe(acquired);
  });

  it('KILLS: two servers and two mcps alternating ticks never swap the lease while the holder renews', () => {
    for (const [first, second] of [
      [serverA, serverB],
      [mcpA, mcpB],
    ]) {
      env.db.prepare('DELETE FROM worker_lease').run();
      expect(settle(ctxAt(0), first!)).toBe(true);
      const acquired = readWorkerLease(env.ctx)!.acquiredAt;
      for (let tick = 1; tick <= 200; tick += 1) {
        expect(settle(ctxAt(tick * 300), second!)).toBe(false);
        expect(settle(ctxAt(tick * 300 + 1), first!)).toBe(true);
      }
      expect(readWorkerLease(env.ctx)!.acquiredAt).toBe(acquired);
      expect(readWorkerLease(env.ctx)!.holder).toBe(first!.holder);
    }
  });

  it('KILLS: three way round robin (mcp, server, server) settles to the first server within one round and stays there', () => {
    const holders: string[] = [];
    for (let tick = 0; tick < 100; tick += 1) {
      settle(ctxAt(tick * 300), mcpA);
      settle(ctxAt(tick * 300 + 1), serverA);
      settle(ctxAt(tick * 300 + 2), serverB);
      holders.push(readWorkerLease(env.ctx)!.holder);
    }
    expect(new Set(holders)).toEqual(new Set([serverA.holder]));
  });

  it('ACCEPTED: a server stalled past the timeout loses the lease to an mcp, and takes it back on its next tick (one bounded handover each way)', () => {
    settle(ctxAt(0), serverA);
    // The server's event loop is blocked for 11 seconds. The mcp sees a stale lease.
    expect(settle(ctxAt(11_000), mcpA)).toBe(true);
    // The server wakes and, as the preferred worker, takes it straight back. Two handovers, then stable.
    expect(settle(ctxAt(11_300), serverA)).toBe(true);
    expect(settle(ctxAt(11_600), mcpA)).toBe(false);
    expect(readWorkerLease(env.ctx)!.holder).toBe(serverA.holder);
  });

  it('ACCEPTED: when processes disagree about pid liveness (pid namespaces) a server and an mcp take the lease from each other every tick, both ticking as holder', () => {
    // The contract assumes every process sees the same pid table. Suppose the server runs in a container (pid 4242 there)
    // and the mcp on the host, where 4242 does not exist. The mcp reads the server's pid as dead and takes the fresh
    // lease; the server, being preferred, takes it back. Both settle calls return true every round, so both claim jobs.
    const hostSeesServerDead: SettleWorkerLeaseOptions = { isPidAlive: () => false };
    const containerSeesMcpAlive: SettleWorkerLeaseOptions = { isPidAlive: () => true };
    const containerServer = identity('server', 4242, 'cont');
    const hostMcp = identity('mcp', 7000, 'host');
    const holders: string[] = [];
    for (let tick = 0; tick < 10; tick += 1) {
      expect(settle(ctxAt(tick * 300), containerServer, containerSeesMcpAlive)).toBe(true);
      holders.push(readWorkerLease(env.ctx)!.kind);
      expect(settle(ctxAt(tick * 300 + 1), hostMcp, hostSeesServerDead)).toBe(true);
      holders.push(readWorkerLease(env.ctx)!.kind);
    }
    expect(holders).toEqual(Array.from({ length: 10 }, () => ['server', 'mcp']).flat());
    // Correct fix if this ever matters: add the host name to the row and only trust the pid check when it matches.
    // The contract should say processes must share a pid namespace.
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Timeout boundaries
// ---------------------------------------------------------------------------------------------------------------

describe('timeout boundaries', () => {
  const timeout = 10_000;

  it('KILLS: a renewal exactly at the timeout is still fresh, one millisecond later it is stale (strict "older than")', () => {
    settle(ctxAt(0), serverA);
    expect(settleWorkerLease(ctxAt(timeout), mcpA, { ...alive, timeoutMilliseconds: timeout })).toBe(false);
    expect(settleWorkerLease(ctxAt(timeout), serverB, { ...alive, timeoutMilliseconds: timeout })).toBe(false);
    expect(settleWorkerLease(ctxAt(timeout + 1), serverB, { ...alive, timeoutMilliseconds: timeout })).toBe(true);
  });

  it('KILLS: the production constant is the contract value of 10 seconds', async () => {
    const { workerLeaseTimeoutMilliseconds, workerTickMilliseconds } = await import('../src/config.js');
    expect(workerLeaseTimeoutMilliseconds).toBe(10_000);
    // The holder renews every tick, so a healthy holder has more than thirty renewals inside the timeout.
    expect(workerLeaseTimeoutMilliseconds / workerTickMilliseconds).toBeGreaterThan(30);
  });

  it('KILLS: a renewed_at in the future (clock stepped backward) is stale once it is further ahead than the timeout, so a live reused pid delays the handover by the timeout at most', () => {
    // Holder pid is alive (reused by an unrelated process) and the clock stepped back one hour after its last renewal.
    insertLease({ holder: 'server:4001:ghost', kind: 'server', pid: 4001, renewedAt: new Date(baseTime + 3_600_000).toISOString() });
    expect(settle(ctxAt(0), serverB)).toBe(true);
    // A stamp within the timeout of now, in either direction, stays fresh: small skew is tolerated.
    insertLease({ holder: 'server:4001:ghost', kind: 'server', pid: 4001, renewedAt: new Date(baseTime + timeout).toISOString() });
    expect(settle(ctxAt(0), serverB)).toBe(false);
    expect(settle(ctxAt(0), mcpA)).toBe(false);
    insertLease({ holder: 'server:4001:ghost', kind: 'server', pid: 4001, renewedAt: new Date(baseTime + timeout + 1).toISOString() });
    expect(settle(ctxAt(0), mcpA)).toBe(true);
  });

  it('KILLS: an unparseable renewed_at counts as stale, so a corrupted row never blocks the queue', () => {
    for (const garbage of ['', 'garbage', 'NaN', '0000-00-00']) {
      insertLease({ holder: 'server:4001:ghost', kind: 'server', pid: 4001, renewedAt: garbage });
      expect(settle(ctxAt(0), serverB), garbage).toBe(true);
      insertLease({ holder: 'server:4001:ghost', kind: 'server', pid: 4001, renewedAt: garbage });
      expect(settle(ctxAt(0), mcpA), garbage).toBe(true);
    }
  });

  it('KILLS: an unparseable renewed_at on an mcp row is stale for every kind, and a dead pid always heals any bad row', () => {
    insertLease({ holder: 'mcp:5001:ghost', kind: 'mcp', pid: 5001, renewedAt: 'garbage' });
    expect(settle(ctxAt(0), mcpB)).toBe(true);
    insertLease({ holder: 'mcp:5001:ghost', kind: 'mcp', pid: 5001, renewedAt: '' });
    expect(settle(ctxAt(2), serverA, dead)).toBe(true);
  });

  it('KILLS: the holder itself renewing overwrites a corrupted renewed_at, so a live ticking holder always heals its own row', () => {
    insertLease({ holder: serverA.holder, kind: 'server', pid: serverA.pid, renewedAt: 'garbage' });
    expect(settle(ctxAt(0), serverA)).toBe(true);
    expect(readWorkerLease(env.ctx)!.renewedAt).toBe(new Date(baseTime).toISOString());
  });

  it('ACCEPTED: with a timeout of 0 any other worker takes the lease one millisecond after the last renewal (tests only; production uses 10 seconds)', () => {
    const zero = { ...alive, timeoutMilliseconds: 0 };
    settle(ctxAt(0), serverA);
    // Same millisecond: not older than zero.
    expect(settleWorkerLease(ctxAt(0), mcpA, zero)).toBe(false);
    // One millisecond later even an mcp steals from a fresh server, which is exactly why the knob is not exposed to production.
    expect(settleWorkerLease(ctxAt(1), mcpA, zero)).toBe(true);
    // The server preempts back, and so on. Nothing in production can set the timeout, so this cannot flap there.
    expect(settleWorkerLease(ctxAt(2), serverA, zero)).toBe(true);
  });

  it('KILLS: a timeout override is per call and never persisted, so one test knob cannot leak into the next settle', () => {
    settle(ctxAt(0), serverA);
    expect(settleWorkerLease(ctxAt(500), serverB, { ...alive, timeoutMilliseconds: 100 })).toBe(true);
    // The default applies again straight afterwards.
    expect(settleWorkerLease(ctxAt(600), serverA, alive)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Pid liveness
// ---------------------------------------------------------------------------------------------------------------

describe('pid liveness', () => {
  it('KILLS: a fresh lease whose holder pid is dead is taken at once by every kind, including an mcp from a server', () => {
    for (const [holderKind, taker] of [
      ['server', mcpA],
      ['server', serverB],
      ['mcp', mcpB],
      ['mcp', serverA],
    ] as const) {
      insertLease({ holder: `${holderKind}:9999:old`, kind: holderKind, pid: 9999, renewedAt: new Date(baseTime).toISOString() });
      expect(settle(ctxAt(1), taker, dead)).toBe(true);
      const lease = readWorkerLease(env.ctx)!;
      expect(lease.holder).toBe(taker.holder);
      expect(lease.acquiredAt).toBe(new Date(baseTime + 1).toISOString());
    }
  });

  it('KILLS: pid reuse (liveness says alive for a dead holder) waits for the timeout and then hands over', () => {
    settle(ctxAt(0), serverA);
    const reused: SettleWorkerLeaseOptions = { isPidAlive: () => true, timeoutMilliseconds: 10_000 };
    expect(settleWorkerLease(ctxAt(9_999), mcpA, reused)).toBe(false);
    expect(settleWorkerLease(ctxAt(10_000), mcpA, reused)).toBe(false);
    expect(settleWorkerLease(ctxAt(10_001), mcpA, reused)).toBe(true);
  });

  it('KILLS: the pid check is skipped for the holder itself and for stale rows, so it is never consulted needlessly', () => {
    const calls: number[] = [];
    const spy: SettleWorkerLeaseOptions = {
      isPidAlive: (pid) => {
        calls.push(pid);
        return true;
      },
    };
    settle(ctxAt(0), serverA, spy);
    settle(ctxAt(1), serverA, spy);
    expect(calls).toEqual([]);
    settleWorkerLease(ctxAt(20_000), mcpA, { ...spy, timeoutMilliseconds: 10_000 });
    expect(calls).toEqual([]);
    settle(ctxAt(20_001), mcpB, spy);
    expect(calls).toEqual([mcpA.pid]);
  });

  it('KILLS: with the real check, this very process is alive, so a second identity in the same process is refused', () => {
    const first = newWorkerLeaseIdentity('mcp');
    const second = newWorkerLeaseIdentity('mcp');
    expect(settleWorkerLease(ctxAt(0), first)).toBe(true);
    expect(settleWorkerLease(ctxAt(1), second)).toBe(false);
  });

  it('KILLS: with the real check, EPERM counts as alive (pid 1 is never ours), so the lease is kept', () => {
    // On macOS and Linux a non root user gets EPERM from kill(1, 0); root gets success. Either way the pid is alive.
    insertLease({ holder: 'server:1:init', kind: 'server', pid: 1, renewedAt: new Date(baseTime).toISOString() });
    expect(settleWorkerLease(ctxAt(1), mcpA)).toBe(false);
    expect(settleWorkerLease(ctxAt(2), serverB)).toBe(false);
  });

  it('KILLS: with the real check, a pid that really exited is dead and is taken over at once', () => {
    const child = spawnSync(process.execPath, ['-e', '0']);
    expect(child.pid).toBeGreaterThan(0);
    insertLease({ holder: `server:${child.pid}:gone`, kind: 'server', pid: child.pid!, renewedAt: new Date(baseTime).toISOString() });
    expect(settleWorkerLease(ctxAt(1), mcpA)).toBe(true);
  });

  it('ACCEPTED: a row with pid 0 reads as alive forever (kill(0, 0) signals our own group), so only the timeout can free it', () => {
    // Nothing writes pid 0: identities carry process.pid. This documents that a hand edited row degrades to the timeout path.
    insertLease({ holder: 'server:0:odd', kind: 'server', pid: 0, renewedAt: new Date(baseTime).toISOString() });
    expect(settleWorkerLease(ctxAt(1), mcpA)).toBe(false);
    expect(settleWorkerLease(ctxAt(10_001), mcpA)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. The tick gate
// ---------------------------------------------------------------------------------------------------------------

describe('tick gate', () => {
  const laneKinds = ['demo_run_step', apifyJobKind, leadCaptureJobKind, draftJobKind, mailReconcileJobKind];

  function addJobsOfEveryLane(): void {
    laneKinds.forEach((kind, index) => addJob(`job_gate_${index}`, kind));
  }

  it('KILLS: a tick with a foreign fresh lease touches nothing: no claim, no mail, no follow-up, no sync, no row written', async () => {
    addJobsOfEveryLane();
    settle(env.ctx, serverA);
    // The tick below uses a real context whose clock sits just after the lease.
    env.advance(10);
    const before = snapshot();
    const errors: unknown[] = [];
    const tick = createWorkerTick(env.ctx, mcpA, (error) => errors.push(error), { mail: true, lease: alive });
    for (let round = 0; round < 5; round += 1) {
      env.advance(300);
      tick();
    }
    await wait(50);
    expect(claimDueJobs).not.toHaveBeenCalled();
    expect(processQueuedIntents).not.toHaveBeenCalled();
    expect(tickFollowupRulesIfDue).not.toHaveBeenCalled();
    expect(syncMailIfDue).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    laneKinds.forEach((_, index) => expect(jobRow(`job_gate_${index}`)).toEqual({ status: 'queued', attempts: 0 }));
    expect(errors).toEqual([]);
  });

  it('KILLS: a holding tick does reach every lane (control for the test above, so the spies are live)', async () => {
    addJobsOfEveryLane();
    env.advance(10);
    const tick = createWorkerTick(env.ctx, serverA, () => undefined, { mail: true, lease: alive });
    tick();
    await wait(80);
    expect(claimDueJobs).toHaveBeenCalled();
    expect(processQueuedIntents).toHaveBeenCalled();
    expect(tickFollowupRulesIfDue).toHaveBeenCalled();
    expect(syncMailIfDue).toHaveBeenCalled();
    expect(jobRow('job_gate_0').attempts).toBeGreaterThan(0);
  });

  it('KILLS: gated ticks leave no latched busy flag, so the first tick after the lease frees up processes every lane', async () => {
    addJobsOfEveryLane();
    settle(env.ctx, serverA);
    const tick = createWorkerTick(env.ctx, mcpA, () => undefined, { mail: false, lease: alive });
    for (let round = 0; round < 3; round += 1) tick();
    expect(claimDueJobs).not.toHaveBeenCalled();
    releaseWorkerLease(env.ctx, serverA);
    env.advance(10);
    tick();
    await wait(50);
    expect(readWorkerLease(env.ctx)!.holder).toBe(mcpA.holder);
    expect(jobRow('job_gate_0').attempts).toBeGreaterThan(0);
    expect(jobRow('job_gate_1').attempts).toBeGreaterThan(0);
  });

  it('KILLS: a settle that throws mid transaction rolls back, reports once, claims nothing, and the next tick recovers', async () => {
    addJob('job_gate_throw');
    settle(env.ctx, serverA);
    env.advance(10);
    const before = snapshot();
    const errors: unknown[] = [];
    const exploding: SettleWorkerLeaseOptions = {
      isPidAlive: () => {
        throw new Error('liveness probe failed');
      },
    };
    createWorkerTick(env.ctx, mcpA, (error) => errors.push(error), { mail: true, lease: exploding })();
    await wait(30);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('liveness probe failed');
    expect(claimDueJobs).not.toHaveBeenCalled();
    expect(syncMailIfDue).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    // The failure did not wedge the connection: a working settle afterwards succeeds as a normal refusal.
    expect(settle(env.ctx, mcpA)).toBe(false);
    expect(readWorkerLease(env.ctx)!.holder).toBe(serverA.holder);
  });

  it('KILLS: a missing worker_lease table (old schema) fails closed: error reported every tick, no job ever claimed', async () => {
    addJob('job_gate_old');
    env.db.exec('ALTER TABLE worker_lease RENAME TO worker_lease_gone');
    const errors: unknown[] = [];
    const tick = createWorkerTick(env.ctx, serverA, (error) => errors.push(error), { mail: false });
    tick();
    tick();
    await wait(30);
    expect(errors).toHaveLength(2);
    expect(claimDueJobs).not.toHaveBeenCalled();
    expect(jobRow('job_gate_old')).toEqual({ status: 'queued', attempts: 0 });
    env.db.exec('ALTER TABLE worker_lease_gone RENAME TO worker_lease');
  });

  it('ACCEPTED: a tick that settled true can still claim after another process takes the lease a moment later (settle and claim are separate transactions)', () => {
    // The contract scopes the lease to "the start of every tick" and says preemption "only stops the old holder claiming
    // new jobs": it does not promise the claim is atomic with the settle. The window is the few microseconds between the
    // two synchronous calls in one tick, and the next settle returns false. The atomic claim still prevents double execution.
    addJob('job_gate_race');
    expect(settle(ctxAt(0), mcpA)).toBe(true);
    // A server process takes the lease right here, between the mcp's settle and its claim.
    expect(settle(ctxAt(1), serverA)).toBe(true);
    expect(processJobs(env.ctx)).toBe(1);
    expect(jobRow('job_gate_race').attempts).toBe(1);
    expect(settle(ctxAt(2), mcpA)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Release
// ---------------------------------------------------------------------------------------------------------------

describe('release', () => {
  it('KILLS: releasing with a wrong holder never deletes, whatever shares its kind, pid, or token', () => {
    settle(ctxAt(0), serverA);
    for (const impostor of [
      identity('server', 4001, 'zzzz'),
      identity('mcp', 4001, 'aaaa'),
      identity('server', 4002, 'aaaa'),
      { holder: '', kind: 'server', pid: 4001 } as WorkerLeaseIdentity,
      { holder: '%', kind: 'server', pid: 4001 } as WorkerLeaseIdentity,
      { holder: "server:4001:aaaa' OR '1'='1", kind: 'server', pid: 4001 } as WorkerLeaseIdentity,
    ]) {
      releaseWorkerLease(env.ctx, impostor);
      expect(readWorkerLease(env.ctx)!.holder).toBe(serverA.holder);
    }
  });

  it('KILLS: stop() of a worker that never held the lease leaves another worker row alone; the holder stop removes it; a second stop is harmless', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const errors: unknown[] = [];
    const holder = startWorker(env.ctx, (error) => errors.push(error), { recover: false, mail: false, leaseKind: 'server' });
    const bystander = startWorker(env.ctx, (error) => errors.push(error), { recover: false, mail: false, leaseKind: 'mcp' });
    await vi.advanceTimersByTimeAsync(900);
    const lease = readWorkerLease(env.ctx)!;
    expect(lease.kind).toBe('server');
    bystander.stop();
    bystander.stop();
    expect(readWorkerLease(env.ctx)!.holder).toBe(lease.holder);
    holder.stop();
    expect(readWorkerLease(env.ctx)).toBeNull();
    holder.stop();
    expect(errors).toEqual([]);
  });

  it('KILLS: stop() of a preempted mcp worker does not delete the server lease that replaced it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const mcp = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'mcp' });
    await vi.advanceTimersByTimeAsync(300);
    expect(readWorkerLease(env.ctx)!.kind).toBe('mcp');
    const server = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'server' });
    await vi.advanceTimersByTimeAsync(300);
    expect(readWorkerLease(env.ctx)!.kind).toBe('server');
    mcp.stop();
    expect(readWorkerLease(env.ctx)!.kind).toBe('server');
    server.stop();
    expect(readWorkerLease(env.ctx)).toBeNull();
  });

  it('KILLS: a clean stop hands the work to a waiting mcp on its very next tick, without waiting for the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'server' });
    const mcp = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'mcp' });
    await vi.advanceTimersByTimeAsync(600);
    addJob('job_release_handover');
    server.stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(readWorkerLease(env.ctx)!.kind).toBe('mcp');
    expect(jobRow('job_release_handover').attempts).toBeGreaterThan(0);
    mcp.stop();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 7. Direct claims stay ungated
// ---------------------------------------------------------------------------------------------------------------

describe('scope', () => {
  it('KILLS: direct claimDueJobs, processJobs and processAllJobs still claim while a foreign fresh lease exists', async () => {
    settle(ctxAt(0), serverA);
    addJob('job_scope_1');
    addJob('job_scope_2');
    addJob('job_scope_3');
    expect(claimDueJobs(env.ctx, 1)).toHaveLength(1);
    expect(processJobs(env.ctx)).toBe(2);
    addJob('job_scope_4');
    expect(await processAllJobs(env.ctx)).toBeGreaterThanOrEqual(1);
    // None of these touched the lease row.
    expect(readWorkerLease(env.ctx)!.holder).toBe(serverA.holder);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 8. Crash recovery interplay
// ---------------------------------------------------------------------------------------------------------------

describe('crash recovery', () => {
  it('ACCEPTED: a starting server re-queues a job an mcp holder is still running, then claims it, so both execute that step (documented step idempotence, but the contract wording is too strong)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // The mcp is the holder and is mid-job: its claim left the job in "running" (as claimDueJobs does).
    const mcp = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'mcp' });
    await vi.advanceTimersByTimeAsync(300);
    expect(readWorkerLease(env.ctx)!.kind).toBe('mcp');
    addJob('job_recover_midflight', 'demo_run_step', 'running', 1);

    // The server starts. recoverStaleJobs runs inside startWorker, before any lease settle, and cannot tell whose job it is.
    const server = startWorker(env.ctx, () => undefined, { recover: true, mail: false, leaseKind: 'server' });
    expect(jobRow('job_recover_midflight').status).toBe('queued');

    // The server's first tick preempts the fresh mcp lease and claims the job the mcp has not finished.
    await vi.advanceTimersByTimeAsync(300);
    expect(readWorkerLease(env.ctx)!.kind).toBe('server');
    expect(jobRow('job_recover_midflight').attempts).toBe(2);
    mcp.stop();
    server.stop();
    // Reasoning: jobs.ts says "Steps are idempotent per run state, so retry it", and recovery has always re-queued every
    // running row regardless of owner, so this predates the lease and is the same exposure two plain servers had.
    // It is not a lease defect. But the contract sentence "jobs it already claimed finish on it, and the atomic claim
    // keeps double execution impossible either way" is false across a recovery start: recovery un-claims the job.
    // The contract should say: recovery at server startup re-queues running jobs, so a step in flight on another
    // process can run twice; steps are written to tolerate that.
  });

  it('KILLS: an mcp worker (recover false) never re-queues running jobs at start', () => {
    addJob('job_recover_mcp', 'demo_run_step', 'running', 1);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const mcp = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'mcp' });
    expect(jobRow('job_recover_mcp').status).toBe('running');
    mcp.stop();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 9. The holder token
// ---------------------------------------------------------------------------------------------------------------

describe('holder token', () => {
  it('KILLS: tokens are unique across many process starts and always carry kind and pid', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 20_000; index += 1) {
      const who = newWorkerLeaseIdentity(index % 2 === 0 ? 'server' : 'mcp');
      expect(who.holder).toMatch(new RegExp(`^(server|mcp):${process.pid}:[0-9a-f]{12}$`));
      seen.add(who.holder);
    }
    expect(seen.size).toBe(20_000);
  });

  it('KILLS: different kinds or different pids can never collide even with the same random part', () => {
    const tokens = new Set([identity('server', 4001, 'aaaa').holder, identity('mcp', 4001, 'aaaa').holder, identity('server', 4002, 'aaaa').holder]);
    expect(tokens.size).toBe(3);
    settle(ctxAt(0), identity('server', 4001, 'aaaa'));
    expect(settle(ctxAt(1), identity('mcp', 4001, 'aaaa'))).toBe(false);
    expect(settle(ctxAt(2), identity('server', 4002, 'aaaa'))).toBe(false);
  });

  it('ACCEPTED: an identity with a byte equal holder string is the holder (48 bits of randomness plus pid and kind is the only guard)', () => {
    settle(ctxAt(0), serverA);
    const twin: WorkerLeaseIdentity = { holder: serverA.holder, kind: 'server', pid: serverA.pid };
    // Both believe they hold it, and both would claim. A collision needs the same kind, same pid and same 48 bit token.
    expect(settle(ctxAt(1), serverA)).toBe(true);
    expect(settle(ctxAt(2), twin)).toBe(true);
    // The kind in the identity is not re-checked against the row either: a mismatched kind with the same string renews.
    const forged: WorkerLeaseIdentity = { holder: serverA.holder, kind: 'mcp', pid: 1 };
    expect(settle(ctxAt(3), forged)).toBe(true);
    const lease = readWorkerLease(env.ctx)!;
    expect(lease.kind).toBe('server');
    expect(lease.pid).toBe(4001);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 10. Doctor
// ---------------------------------------------------------------------------------------------------------------

describe('doctor', () => {
  interface Check {
    name: string;
    status: string;
    detail: string;
  }

  async function doctorLease(): Promise<Check | undefined> {
    const { stdout } = await execFileAsync(tsxBinary, ['src/cli.ts', 'doctor', '--json'], {
      cwd: packageRoot,
      env: { ...process.env, AGENTCRM_DB: env.databasePath },
      timeout: 30_000,
    }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
    const parsed = JSON.parse(stdout) as { checks: Check[] };
    return parsed.checks.find((check) => check.name === 'Worker lease');
  }

  const agoIso = (milliseconds: number): string => new Date(Date.now() - milliseconds).toISOString();

  it('KILLS: doctor reports no holder, a fresh holder, and a stale holder with the right status', async () => {
    const none = await doctorLease();
    expect(none).toMatchObject({ status: 'ok' });
    expect(none!.detail).toContain('No process holds it');

    insertLease({ holder: 'server:4001:x', kind: 'server', pid: 4001, renewedAt: agoIso(9000) });
    const fresh = await doctorLease();
    expect(fresh!.status).toBe('ok');
    expect(fresh!.detail).toMatch(/^Held by the server process with pid 4001, renewed (9|10) seconds ago\.$/);

    insertLease({ holder: 'mcp:5001:x', kind: 'mcp', pid: 5001, renewedAt: agoIso(11_000) });
    const stale = await doctorLease();
    expect(stale!.status).toBe('warn');
    expect(stale!.detail).toMatch(/^Held by the mcp process with pid 5001, last renewed (11|12) seconds ago, so it is stale and the next worker will take it\.$/);
  }, 60_000);

  it('KILLS: doctor warns on an unreadable or future dated renewed_at and names the problem, by the same freshness rule as the workers', async () => {
    insertLease({ holder: 'server:4001:x', kind: 'server', pid: 4001, renewedAt: 'garbage' });
    const garbage = await doctorLease();
    expect(garbage!.status).toBe('warn');
    expect(garbage!.detail).toContain('renewal time is unreadable');

    insertLease({ holder: 'server:4001:x', kind: 'server', pid: 4001, renewedAt: agoIso(-60_000) });
    const future = await doctorLease();
    expect(future!.status).toBe('warn');
    expect(future!.detail).toMatch(/renewal time is (59|60) seconds in the future/);
  }, 60_000);

  it('ACCEPTED: doctor judges by age only, so a fresh row whose pid is dead reads ok although the next worker takes it at once; the contract says so', async () => {
    insertLease({ holder: 'server:2147483647:x', kind: 'server', pid: 2147483647, renewedAt: agoIso(1000) });
    const deadButFresh = await doctorLease();
    expect(deadButFresh!.status).toBe('ok');
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------
// 11. SQLite specifics
// ---------------------------------------------------------------------------------------------------------------

describe('sqlite specifics', () => {
  it('KILLS: settle is synchronous and returns a plain boolean (nothing awaits inside the transaction)', () => {
    const result = settleWorkerLease(ctxAt(0), serverA, alive);
    expect(result).toBe(true);
    expect(typeof (result as unknown as { then?: unknown }).then).toBe('undefined');
  });

  it('KILLS: a failed settle (constraint violation) rolls back completely and leaves the connection usable', () => {
    settle(ctxAt(0), serverA);
    const before = readWorkerLease(env.ctx);
    // The kind CHECK constraint rejects this identity during the take. The old row must survive untouched.
    const bad = { holder: 'worker:1:x', kind: 'worker', pid: 1 } as unknown as WorkerLeaseIdentity;
    expect(() => settleWorkerLease(ctxAt(20_000), bad, alive)).toThrow(/CHECK constraint/);
    expect(readWorkerLease(env.ctx)).toEqual(before as WorkerLeaseRecord);
    expect(settle(ctxAt(20_001), serverA)).toBe(true);
  });

  it('ACCEPTED: the lease table has no CHECK on pid or timestamps, so a bad row can be written by hand; only the code path validates', () => {
    expect(() => insertLease({ holder: 'x', kind: 'server', pid: -5, renewedAt: 'not a date' })).not.toThrow();
  });

  it('ACCEPTED: migration 021 is not idempotent (no IF NOT EXISTS), so two processes opening an unmigrated database at the same instant can make the loser throw at startup', () => {
    // applyMigrations reads the applied list outside the migration transaction, like every earlier migration, so this is
    // a pre-existing pattern and not specific to the lease. It matters once: the first launch after an upgrade where an
    // API server and an MCP server start together. The second one throws "table worker_lease already exists" and exits.
    const sql = readFileSync(path.join(migrationsDirectory, '021_worker_lease.sql'), 'utf8');
    expect(() => env.db.exec(sql)).toThrow(/already exists/);
  });
});
