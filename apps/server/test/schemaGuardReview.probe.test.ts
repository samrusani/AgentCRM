import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPerson, proposeChanges, readWorkerLease } from '../src/actions/index.js';
import { workerTickMilliseconds } from '../src/config.js';
import { createSchemaGuard } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { startWorker } from '../src/jobs/worker.js';
import { packageRoot } from '../src/paths.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';

let env: TestEnvironment;
beforeEach(() => {
  env = createTestEnvironment();
});
afterEach(() => {
  vi.useRealTimers();
  try {
    env.cleanup();
  } catch {
    // The db handle may already be closed by a probe.
  }
});

const code = (guard: { check(): void }): string | null => {
  try {
    guard.check();
    return null;
  } catch (error) {
    return error instanceof AppError ? error.code : `other:${String(error)}`;
  }
};
const insert = (name: string) =>
  env.db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, '2026-03-01T00:00:00.000Z');

function connect(databasePath: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), 'mcp'],
    cwd: packageRoot,
    env: { ...(process.env as Record<string, string>), AGENTCRM_DB: databasePath },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'guard-review', version: '1.0.0' });
  return { client, ready: client.connect(transport) };
}
const body = (result: unknown): { error?: { code: string; message: string } } =>
  JSON.parse((result as { content: { text: string }[] }).content[0]!.text);

describe('angle 1: module-level guard in mcp/server.ts', () => {
  const source = readFileSync(path.join(packageRoot, 'src', 'mcp', 'server.ts'), 'utf8');

  // KILLS: the guard is assigned before the first tool is registered and before the worker starts, so no tool
  // handler can run with an undefined guard. Pinned by source order because startMcpServer owns stdio.
  it('assigns the guard before any tool registration or transport connect', () => {
    const assigned = source.indexOf('guard = createSchemaGuard(db)');
    expect(assigned).toBeGreaterThan(0);
    expect(source.indexOf('server.registerTool(')).toBeGreaterThan(assigned);
    expect(source.indexOf('startWorker(')).toBeGreaterThan(assigned);
    expect(source.indexOf('.connect(')).toBeGreaterThan(assigned);
  });

  // KILLS: every one of the 8 tools goes through guarded().
  it('routes all 8 tools through guarded()', () => {
    expect(source.match(/server\.registerTool\(/g)).toHaveLength(8);
    expect(source.match(/guarded\(/g)!.length - 1).toBeGreaterThanOrEqual(8); // minus the definition
  });

  // ACCEPTED: startMcpServer has exactly one caller (the `mcp` CLI command, one per process), so two calls cannot
  // cross guards in reality. A second call in one process would reassign the module variable and the first
  // server's tools would then consult the second guard. Unreachable, but not defended in code.
  it('has a single caller, so the shared module variable is never reassigned in practice', () => {
    const cli = readFileSync(path.join(packageRoot, 'src', 'cli.ts'), 'utf8');
    expect(cli.match(/startMcpServer\(\)/g)).toHaveLength(1);
  });
});

describe('angle 2: set comparison', () => {
  // KILLS: same count, different name.
  it('trips when one name is swapped for another of the same count', () => {
    const guard = createSchemaGuard(env.db);
    env.db.prepare("UPDATE migrations SET name = 'zzz_swapped.sql' WHERE name = (SELECT MIN(name) FROM migrations)").run();
    expect(code(guard)).toBe('stale_server');
  });

  // KILLS: renamed row differing only by case (SQLite TEXT PK is case sensitive, Set is too).
  it('trips on a case-only rename', () => {
    const guard = createSchemaGuard(env.db);
    env.db.prepare("UPDATE migrations SET name = UPPER(name) WHERE name = (SELECT MIN(name) FROM migrations)").run();
    expect(code(guard)).toBe('stale_server');
  });

  // KILLS: a case-variant duplicate of an existing name is a different row, so the count differs.
  it('trips on a case-variant duplicate-looking name', () => {
    const guard = createSchemaGuard(env.db);
    const first = (env.db.prepare('SELECT MIN(name) AS n FROM migrations').get() as { n: string }).n;
    insert(first.toUpperCase());
    expect(code(guard)).toBe('stale_server');
  });

  // KILLS: NUL and odd characters in a name do not crash the comparison.
  it('trips cleanly on names with NUL, newline, and non-BMP characters', () => {
    for (const weird of ['a\u0000b.sql', 'x\ny.sql', '\u{1F4A5}.sql', '']) {
      const guard = createSchemaGuard(env.db);
      insert(weird);
      expect(code(guard)).toBe('stale_server');
      env.db.prepare('DELETE FROM migrations WHERE name = ?').run(weird);
    }
  });

  // KILLS: a NULL-typed or blob name value cannot be inserted (NOT NULL PK), and a blob name is just another difference.
  it('trips when a blob-typed name is inserted', () => {
    const guard = createSchemaGuard(env.db);
    env.db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(Buffer.from([1, 2, 3]), 'x');
    expect(code(guard)).toBe('stale_server');
  });

  // KILLS: swap of two rows in place (same set of names, different applied_at) is NOT a schema change.
  it('does not trip when only applied_at values change', () => {
    const guard = createSchemaGuard(env.db);
    env.db.exec("UPDATE migrations SET applied_at = '2030-01-01T00:00:00.000Z'");
    expect(code(guard)).toBeNull();
  });
});

describe('angle 3: trip permanence', () => {
  // KILLS: restoring the exact snapshot after a trip does not un-trip it.
  it('stays tripped after the table is restored exactly', () => {
    const guard = createSchemaGuard(env.db);
    const rows = env.db.prepare('SELECT * FROM migrations').all() as { name: string; applied_at: string }[];
    env.db.exec('DELETE FROM migrations');
    expect(code(guard)).toBe('stale_server');
    for (const row of rows) env.db.prepare('INSERT INTO migrations VALUES (?, ?)').run(row.name, row.applied_at);
    expect(code(guard)).toBe('stale_server');
  });

  // KILLS: a tripped guard never touches the db again, even when the table is gone and the handle is closed.
  it('does not query again once tripped, even with the handle closed', () => {
    const guard = createSchemaGuard(env.db);
    insert('999_future.sql');
    expect(code(guard)).toBe('stale_server');
    env.db.exec('DROP TABLE migrations');
    env.db.close();
    expect(code(guard)).toBe('stale_server');
    expect(code(guard)).toBe('stale_server');
  });

  // ACCEPTED: any read error trips for good, including a closed handle on an untripped guard. A transient failure
  // therefore needs a client restart; the contract chooses fail-closed.
  it('fails closed permanently on a read error from a closed handle', () => {
    const guard = createSchemaGuard(env.db);
    env.db.close();
    expect(code(guard)).toBe('stale_server');
  });

  // KILLS: an empty-migrations snapshot (no migrations table at creation) compares sanely.
  it('handles a snapshot taken from a database with no migrations table', () => {
    const bare = new Database(':memory:');
    const guard = createSchemaGuard(bare);
    expect(code(guard)).toBeNull();
    bare.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    expect(code(guard)).toBeNull(); // empty table equals empty snapshot
    bare.exec("INSERT INTO migrations VALUES ('001_a.sql', 'x')");
    expect(code(guard)).toBe('stale_server');
    bare.close();
  });
});

describe('angle 4: worker', () => {
  const stale = () => ({
    check() {
      throw new AppError('stale_server', 'stale');
    },
  });

  // KILLS: stop() twice after a trip, and a stop() before any tick, are safe.
  it('survives stop() called twice after a trip', async () => {
    vi.useFakeTimers();
    const worker = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'mcp', guard: stale() });
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds * 2);
    expect(() => worker.stop()).not.toThrow();
    expect(() => worker.stop()).not.toThrow();
  });

  // KILLS: stop() after trip with the db file closed (and removed) does not throw, because tripped release is best effort.
  it('survives stop() after trip when the db handle is closed', async () => {
    vi.useFakeTimers();
    const worker = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'mcp', guard: stale() });
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds * 2);
    env.db.close();
    expect(() => worker.stop()).not.toThrow();
  });

  // KILLS: the release removes only this process's row; a lease another process took is left alone.
  it('does not clobber a lease another holder took', async () => {
    vi.useFakeTimers();
    let trip = false;
    const guard = {
      check() {
        if (trip) throw new AppError('stale_server', 'stale');
      },
    };
    const worker = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'mcp', guard });
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds);
    expect(readWorkerLease(env.ctx)?.kind).toBe('mcp');
    env.db.prepare("UPDATE worker_lease SET holder = 'server:1:other', kind = 'server' WHERE id = 'worker'").run();
    trip = true;
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds * 2);
    expect(readWorkerLease(env.ctx)?.holder).toBe('server:1:other');
    worker.stop();
    expect(readWorkerLease(env.ctx)?.holder).toBe('server:1:other');
  });

  // KILLS: once tripped, no tick runs: no job claim, no lease renewal, even with a due job queued.
  it('does no work after the trip and does not renew a lease', async () => {
    vi.useFakeTimers();
    let trip = false;
    const guard = {
      check() {
        if (trip) throw new AppError('stale_server', 'stale');
      },
    };
    const worker = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'mcp', guard });
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds);
    trip = true;
    const prepared = vi.spyOn(env.db, 'prepare');
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds * 5);
    const sqls = prepared.mock.calls.map((call) => String(call[0]));
    // Only the single best effort release touches the db after the trip.
    expect(sqls.filter((sql) => !sql.startsWith('DELETE FROM worker_lease'))).toEqual([]);
    expect(readWorkerLease(env.ctx)).toBeNull();
    worker.stop();
  });

  // KILLS: a guard whose check throws a non-AppError (a bug in the guard) also stops the worker rather than crashing the timer.
  it('treats any throw from check() as a trip', async () => {
    vi.useFakeTimers();
    const guard = {
      check() {
        throw new TypeError('boom');
      },
    };
    const worker = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'mcp', guard });
    await expect(vi.advanceTimersByTimeAsync(workerTickMilliseconds * 3)).resolves.not.toThrow();
    expect(readWorkerLease(env.ctx)).toBeNull();
    worker.stop();
  });

  // ACCEPTED: an async lane already in flight when the guard trips finishes its current batch. The guard only gates
  // new ticks; it cannot interrupt awaited work. The process must not crash while it finishes.
  it('lets an in-flight tick finish without crashing after a trip', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    let trip = false;
    const guard = {
      check() {
        if (trip) throw new AppError('stale_server', 'stale');
      },
    };
    const worker = startWorker(env.ctx, (e) => errors.push(e), { recover: false, mail: true, leaseKind: 'mcp', guard });
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds); // starts async lanes
    trip = true;
    await expect(vi.advanceTimersByTimeAsync(workerTickMilliseconds * 3)).resolves.not.toThrow();
    worker.stop();
    expect(errors).toEqual([]);
  });

  // ACCEPTED (pre-existing, not this feature): an UNtripped worker's stop() throws if the handle is already closed.
  it('untripped stop() with a closed handle still throws as before', () => {
    const worker = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'mcp', guard: { check() {} } });
    env.db.close();
    expect(() => worker.stop()).toThrow();
  });
});

describe('angle 5: window between check and work', () => {
  // ACCEPTED: guarded() checks once, then runs synchronously. A schema change landing mid-call is not seen by that call,
  // but nothing crashes, and the next call is refused.
  it('serves the in-flight call, then refuses the next', () => {
    const guard = createSchemaGuard(env.db);
    let result = 'unset';
    const work = () => {
      guard.check();
      insert('999_mid_call.sql'); // schema changes mid-work
      result = 'done';
    };
    expect(work).not.toThrow();
    expect(result).toBe('done');
    expect(code(guard)).toBe('stale_server');
  });
});

describe('angle 6: stdio server after a trip', () => {
  // KILLS: process stays alive, keeps answering stale_server on all 8 tools, and crm_apply_changes writes nothing.
  it('answers stale_server from all 8 tools, stays alive, and applies nothing', async () => {
    const person = createPerson(env.ctx, { firstName: 'Guard', lastName: 'Probe', email: 'probe@example.com' }) as { id: string; version: number };
    const changes = [{ entityType: 'person' as const, id: person.id, expectedVersion: person.version, fields: { title: 'Changed' } }];
    const proposal = proposeChanges(env.ctx, { changes }) as { proposalHash: string };
    const eventsBefore = (env.db.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as { n: number }).n;

    const { client, ready } = connect(env.databasePath);
    await ready;
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toHaveLength(8);
      expect((await client.callTool({ name: 'crm_describe', arguments: {} })).isError).toBeFalsy();

      const other = new Database(env.databasePath);
      try {
        other.prepare("INSERT INTO migrations (name, applied_at) VALUES ('999_future.sql', 'x')").run();
      } finally {
        other.close();
      }

      const args: Record<string, Record<string, unknown>> = {
        crm_apply_changes: { proposalHash: proposal.proposalHash, changes },
        crm_propose_changes: { changes },
        crm_search: { query: 'probe' },
        crm_start_research: {},
        crm_get_run: { runId: 'run_x' },
      };
      for (const name of tools) {
        const result = await client.callTool({ name, arguments: args[name] ?? {} });
        // Tools with required arguments may fail zod validation first; those that pass validation must be stale_server.
        if (result.isError && /validation|invalid|required/i.test(JSON.stringify(result.content)) && !args[name]) continue;
        expect(body(result).error?.code, name).toBe('stale_server');
      }
      // Explicit apply check with valid arguments.
      const applied = await client.callTool({ name: 'crm_apply_changes', arguments: { proposalHash: proposal.proposalHash, changes } });
      expect(applied.isError).toBe(true);
      expect(body(applied).error?.code).toBe('stale_server');
      const row = env.db.prepare('SELECT version FROM person WHERE id = ?').get(person.id) as { version: number };
      expect(row.version).toBe(person.version);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as { n: number }).n).toBe(eventsBefore);
      // Still alive and answering after several worker ticks' worth of time.
      await new Promise((resolve) => setTimeout(resolve, workerTickMilliseconds + 300));
      expect(body(await client.callTool({ name: 'crm_describe', arguments: {} })).error?.code).toBe('stale_server');
    } finally {
      await client.close();
    }
  }, 40_000);
});

describe('angle 7: API server path without a guard', () => {
  // KILLS: no guard means the lease is taken and released exactly as before (full lease suites are run separately).
  it('takes and releases the lease with no guard', async () => {
    vi.useFakeTimers();
    const worker = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'server' });
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds);
    expect(readWorkerLease(env.ctx)?.kind).toBe('server');
    worker.stop();
    expect(readWorkerLease(env.ctx)).toBeNull();
  });
});

describe('angle 8: errors', () => {
  // KILLS: stale_server maps to 503 and the code and message pass through the MCP failure shape (stdio test above
  // asserts the wire shape); the status is pinned here.
  it('maps stale_server to 503 and allows a status override', () => {
    expect(new AppError('stale_server', 'm').status).toBe(503);
    expect(new AppError('stale_server', 'm', { status: 500 }).status).toBe(500);
  });

  // KILLS: the guard error carries no `current` payload, so the failure shape is exactly {code, message}.
  it('carries no current payload', () => {
    const guard = createSchemaGuard(env.db);
    insert('999_future.sql');
    try {
      guard.check();
    } catch (error) {
      expect((error as AppError).current).toBeUndefined();
    }
  });
});
