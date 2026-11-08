import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWorkerLease } from '../src/actions/index.js';
import { workerTickMilliseconds } from '../src/config.js';
import { createSchemaGuard } from '../src/db.js';
import { buildApp } from '../src/http/app.js';
import { startWorker } from '../src/jobs/worker.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';

const apiMessage =
  'The database schema changed after this server started, usually because AgentCRM was updated. Quit and reopen the app.';
const mcpMessage =
  'The database schema changed after this server started, usually because AgentCRM was updated. Start a new client session so a fresh server runs the current code.';
const headers = { host: '127.0.0.1:4720' };

let env: TestEnvironment;
let app: FastifyInstance;
let webDir: string;

beforeEach(async () => {
  env = createTestEnvironment();
  webDir = mkdtempSync(path.join(tmpdir(), 'agentcrm-guard-web-'));
  writeFileSync(path.join(webDir, 'index.html'), '<html>shell</html>');
  const guard = createSchemaGuard(env.db, apiMessage);
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now, webDist: webDir, guard });
  await app.ready();
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  rmSync(webDir, { recursive: true, force: true });
  env.cleanup();
});

const get = (url: string) => app.inject({ method: 'GET', url, headers });
const insertFutureMigration = (): void => {
  env.db.prepare("INSERT INTO migrations (name, applied_at) VALUES ('999_future.sql', '2026-03-01T00:00:00.000Z')").run();
};

describe('API server schema guard', () => {
  it('serves normally and reports stale false before any trip', async () => {
    expect((await get('/api/workspace')).statusCode).toBe(200);
    const health = await get('/api/health');
    expect(health.statusCode).toBe(200);
    expect(health.json().stale).toBe(false);
  });

  it('answers 503 stale_server with the app wording once a migration row appears', async () => {
    insertFutureMigration();
    const response = await get('/api/workspace');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: 'stale_server', message: apiMessage } });
    expect(apiMessage).not.toBe(mcpMessage);
    const post = await app.inject({ method: 'POST', url: '/api/lists', headers, payload: { name: 'x' } });
    expect(post.statusCode).toBe(503);
    expect(post.json().error.code).toBe('stale_server');
    const unknown = await get('/api/missing');
    expect(unknown.statusCode).toBe(503);
  });

  it('health stays 200 with stale true after a guarded route tripped the guard', async () => {
    insertFutureMigration();
    expect((await get('/api/workspace')).statusCode).toBe(503);
    const health = await get('/api/health');
    expect(health.statusCode).toBe(200);
    expect(health.json().stale).toBe(true);
  });

  it('health only reports the guard state: stale stays false until a guarded route runs the check', async () => {
    insertFutureMigration();
    expect((await get('/api/health')).json().stale).toBe(false);
    expect((await get('/api/health')).json().stale).toBe(false);
    expect((await get('/api/workspace')).statusCode).toBe(503);
    expect((await get('/api/health')).json().stale).toBe(true);
  });

  it('still serves the web page and the SPA fallback after the trip', async () => {
    insertFutureMigration();
    expect((await get('/api/workspace')).statusCode).toBe(503);
    const index = await get('/');
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('shell');
    expect((await get('/leads')).body).toContain('shell');
  });

  it('refuses a new event stream with 503 once tripped', async () => {
    insertFutureMigration();
    const response = await get('/api/events');
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('stale_server');
  });

  it('releases the worker lease when the same guard trips', async () => {
    vi.useFakeTimers();
    const guard = createSchemaGuard(env.db, apiMessage);
    const worker = startWorker(env.ctx, () => undefined, { recover: false, mail: false, guard });
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds);
    expect(readWorkerLease(env.ctx)?.kind).toBe('server');
    insertFutureMigration();
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds);
    expect(readWorkerLease(env.ctx)).toBeNull();
    expect(guard.tripped()).toBe(true);
    expect(() => worker.stop()).not.toThrow();
  });

  it('keeps the MCP wording as the default message', () => {
    const guard = createSchemaGuard(env.db);
    insertFutureMigration();
    expect(() => guard.check()).toThrow(mcpMessage);
  });
});
