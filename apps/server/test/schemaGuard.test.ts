import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWorkerLease } from '../src/actions/index.js';
import { workerTickMilliseconds } from '../src/config.js';
import { createSchemaGuard } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { startWorker } from '../src/jobs/worker.js';
import { packageRoot } from '../src/paths.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';

const staleMessage =
  'The database schema changed after this server started, usually because AgentCRM was updated. Start a new client session so a fresh server runs the current code.';

let env: TestEnvironment;

beforeEach(() => {
  env = createTestEnvironment();
});

afterEach(() => {
  vi.useRealTimers();
  env.cleanup();
});

function trip(guard: { check(): void }): AppError {
  try {
    guard.check();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('The guard did not trip.');
}

describe('schema guard', () => {
  it('passes while the applied migrations are unchanged', () => {
    const guard = createSchemaGuard(env.db);
    expect(() => guard.check()).not.toThrow();
    expect(() => guard.check()).not.toThrow();
  });

  it('trips with stale_server when a migration row is added', () => {
    const guard = createSchemaGuard(env.db);
    env.db.prepare("INSERT INTO migrations (name, applied_at) VALUES ('999_future.sql', '2026-03-01T00:00:00.000Z')").run();
    const error = trip(guard);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('stale_server');
    expect(error.status).toBe(503);
    expect(error.message).toBe(staleMessage);
  });

  it('trips when a migration row is removed', () => {
    const guard = createSchemaGuard(env.db);
    env.db.prepare("DELETE FROM migrations WHERE name = (SELECT MAX(name) FROM migrations)").run();
    expect(trip(guard).code).toBe('stale_server');
  });

  it('trips when a migration is replaced by a different name', () => {
    const guard = createSchemaGuard(env.db);
    env.db.prepare("UPDATE migrations SET name = '998_other.sql' WHERE name = (SELECT MAX(name) FROM migrations)").run();
    expect(trip(guard).code).toBe('stale_server');
  });

  it('trips when the migrations table cannot be read', () => {
    const guard = createSchemaGuard(env.db);
    env.db.exec('DROP TABLE migrations');
    const error = trip(guard);
    expect(error.code).toBe('stale_server');
    expect(error.message).toBe(staleMessage);
  });

  it('stays tripped even after the table is restored', () => {
    const guard = createSchemaGuard(env.db);
    env.db.exec('ALTER TABLE migrations RENAME TO migrations_saved');
    trip(guard);
    env.db.exec('ALTER TABLE migrations_saved RENAME TO migrations');
    expect(trip(guard).message).toBe(staleMessage);
  });
});

describe('worker with a schema guard', () => {
  it('stops ticking and releases its lease when the guard trips, and stop() stays safe', async () => {
    vi.useFakeTimers();
    let tripped = false;
    let checks = 0;
    const guard = {
      check() {
        checks += 1;
        if (tripped) throw new AppError('stale_server', staleMessage);
      },
    };
    const worker = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'mcp', guard });
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds);
    expect(readWorkerLease(env.ctx)?.kind).toBe('mcp');
    tripped = true;
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds);
    expect(readWorkerLease(env.ctx)).toBeNull();
    const checksAtStop = checks;
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds * 5);
    expect(checks).toBe(checksAtStop);
    expect(readWorkerLease(env.ctx)).toBeNull();
    expect(() => worker.stop()).not.toThrow();
  });

  it('still stops when releasing the lease fails', async () => {
    vi.useFakeTimers();
    const guard = {
      check() {
        throw new AppError('stale_server', staleMessage);
      },
    };
    const worker = startWorker(env.ctx, () => undefined, { recover: false, mail: false, leaseKind: 'mcp', guard });
    env.db.exec('DROP TABLE worker_lease');
    await expect(vi.advanceTimersByTimeAsync(workerTickMilliseconds * 2)).resolves.not.toThrow();
    expect(() => worker.stop()).not.toThrow();
  });
});

describe('MCP server schema guard', () => {
  it('answers stale_server from every tool once the schema changes', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), 'mcp'],
      cwd: packageRoot,
      env: { ...(process.env as Record<string, string>), AGENTCRM_DB: env.databasePath },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'schema-guard-test', version: '1.0.0' });
    await client.connect(transport);
    const read = (result: unknown): { error?: { code: string; message: string } } =>
      JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
    try {
      const before = await client.callTool({ name: 'crm_describe', arguments: {} });
      expect(before.isError).toBeFalsy();

      const other = new Database(env.databasePath);
      try {
        other.prepare("INSERT INTO migrations (name, applied_at) VALUES ('999_future.sql', '2026-03-01T00:00:00.000Z')").run();
      } finally {
        other.close();
      }

      const describe = await client.callTool({ name: 'crm_describe', arguments: {} });
      expect(describe.isError).toBe(true);
      expect(read(describe).error).toEqual({ code: 'stale_server', message: staleMessage });

      const search = await client.callTool({ name: 'crm_search', arguments: { query: 'a' } });
      expect(search.isError).toBe(true);
      expect(read(search).error).toEqual({ code: 'stale_server', message: staleMessage });
    } finally {
      await client.close();
    }
  }, 30_000);
});
