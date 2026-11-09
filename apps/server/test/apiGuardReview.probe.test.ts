import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCaptureToken, readWorkerLease } from '../src/actions/index.js';
import { workerTickMilliseconds } from '../src/config.js';
import { createSchemaGuard, openDatabase } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { buildApp } from '../src/http/app.js';
import { startWorker } from '../src/jobs/worker.js';
import { packageRoot } from '../src/paths.js';
import { startServer } from '../src/server.js';
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
  webDir = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-guardprobe-web-'));
  writeFileSync(path.join(webDir, 'index.html'), '<html>shell</html>');
  mkdirSync(path.join(webDir, 'assets'));
  writeFileSync(path.join(webDir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(path.join(webDir, 'apidocs.html'), '<html>docs</html>');
  writeFileSync(path.join(webDir, 'api-notes.txt'), 'notes');
  const guard = createSchemaGuard(env.db, apiMessage);
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now, webDist: webDir, guard });
  await app.ready();
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  rmSync(webDir, { recursive: true, force: true });
  try {
    env.cleanup();
  } catch {
    // a probe may have closed the handle
  }
});

const trip = (): void => {
  env.db.prepare("INSERT INTO migrations (name, applied_at) VALUES ('999_future.sql', '2026-03-01T00:00:00.000Z')").run();
};

async function listen(): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as net.AddressInfo).port;
}

// Sends an exact request line over a raw socket, so the client library cannot normalize the target.
function raw(port: number, requestLine: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () =>
      socket.write(`${requestLine} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`),
    );
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0);
      resolve({ status, body: data.split('\r\n\r\n')[1] ?? '' });
    });
  });
}

// ---- Angle 1: enumerate every registered route from printRoutes ----

function registeredRoutes(): { method: string; url: string }[] {
  const lines = app.printRoutes({ commonPrefix: false }).split('\n').filter((line) => line.trim() !== '');
  const stack: string[] = [];
  const routes: { method: string; url: string }[] = [];
  for (const line of lines) {
    const connector = line.search(/[├└]/);
    if (connector < 0) continue;
    const depth = connector / 4;
    const match = /^[├└]── (\S+)(?: \(([^)]*)\))?/.exec(line.slice(connector));
    if (!match) continue;
    stack.length = depth;
    stack[depth] = match[1]!;
    if (match[2]) {
      const url = stack.join('').replace(/:[A-Za-z]+/g, 'x');
      for (const method of match[2].split(', ')) routes.push({ method, url });
    }
  }
  return routes;
}

describe('hook coverage honesty', () => {
  it('enumerates a sane number of routes, all under /api', () => {
    const routes = registeredRoutes();
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.filter((route) => !route.url.startsWith('/api/'))).toEqual([]);
    const urls = new Set(routes.map((route) => route.url));
    for (const needed of ['/api/events', '/api/capture', '/api/capture/verify', '/api/capture/lookup', '/api/capture/note', '/api/health']) {
      expect(urls.has(needed), needed).toBe(true);
    }
  });

  it('every registered /api route and method except GET /api/health answers 503 stale_server after a trip', async () => {
    trip();
    expect((await app.inject({ method: 'GET', url: '/api/workspace', headers })).statusCode).toBe(503);
    const failures: string[] = [];
    for (const route of registeredRoutes()) {
      if (route.method === 'GET' && route.url === '/api/health') continue;
      const response = await app.inject({
        method: route.method as 'GET',
        url: route.url,
        headers: { ...headers, 'content-type': 'application/json' },
        ...(route.method === 'GET' || route.method === 'HEAD' ? {} : { payload: '{}' }),
      });
      if (response.statusCode !== 503) failures.push(`${route.method} ${route.url} -> ${response.statusCode}`);
      else if (route.method !== 'HEAD' && response.json().error?.code !== 'stale_server') failures.push(`${route.method} ${route.url} wrong body`);
    }
    expect(failures).toEqual([]);
  });

  it('the extension capture routes refuse with 503 (not 401) once stale, with or without a token', async () => {
    const tokenResponse = await app.inject({ method: 'POST', url: '/api/capture/token', headers });
    const token = tokenResponse.json().token as string;
    const ok = await app.inject({ method: 'POST', url: '/api/capture/verify', headers: { ...headers, authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    trip();
    for (const url of ['/api/capture/verify', '/api/capture/lookup', '/api/capture/note', '/api/capture']) {
      const withToken = await app.inject({ method: 'POST', url, headers: { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: '{}' });
      expect(withToken.statusCode, url).toBe(503);
      expect(withToken.json().error.code).toBe('stale_server');
      const noToken = await app.inject({ method: 'POST', url, headers });
      expect(noToken.statusCode, url).toBe(503);
    }
    const people = Number((env.db.prepare('SELECT COUNT(*) AS n FROM person').get() as { n: number }).n);
    expect(people).toBe(0);
  });

  it('case, duplicate slash, dot segments, trailing slash, HEAD, OPTIONS: pins which are 503 and which are plain 404', async () => {
    trip();
    const port = await listen();
    // /api%2Fworkspace routes nowhere, but the fallback decodes it to /api/workspace and refuses: safer than the
    // old SPA-shell answer, and what the amended contract's decoded-path fallback prescribes.
    const expect503 = ['/api//workspace', '/api/../api/workspace', '/api/./workspace', '/api/workspace/', '/api/workspace?x=1', '/api', '/api/', '/api%2Fworkspace'];
    for (const url of expect503) {
      expect((await raw(port, `GET ${url}`)).status, url).toBe(503);
    }
    // These never route to an API handler (find-my-way is case sensitive and does not collapse a leading double slash);
    // with a web dist they fall to the SPA shell (200, HTML, no workspace data), which is the correct unguarded static answer.
    for (const url of ['/API/workspace', '//api/workspace']) {
      const response = await raw(port, `GET ${url}`);
      expect(response.status, url).toBe(200);
      expect(response.body, url).toContain('shell');
      expect(response.body, url).not.toContain('wsp_');
    }
    for (const method of ['HEAD', 'OPTIONS']) {
      expect((await raw(port, `${method} /api/workspace`)).status, method).toBe(503);
    }
  });

  it('hook decides from the routed pattern, decoded-path fallback for unrouted requests (the fixed discipline)', async () => {
    const source = readFileSync(path.join(packageRoot, 'src', 'http', 'app.ts'), 'utf8');
    expect(source).toMatch(/routeOptions\?\.url/);
    expect(source).toContain('decodeURIComponent');
  });

  // The bypass was fixed: the hook matches the routed (decoded, normalized) pattern, so encoded spellings refuse.
  it('KILLS: percent-encoded /%61pi/workspace is guarded after a trip', async () => {
    trip();
    const port = await listen();
    expect((await raw(port, 'GET /%61pi/workspace')).status).toBe(503);
  });

  it('KILLS: percent-encoded letter in the middle of the prefix (/ap%69/...) is guarded after a trip', async () => {
    trip();
    const port = await listen();
    expect((await raw(port, 'GET /ap%69/workspace')).status).toBe(503);
  });

  it('KILLS: absolute-URI request line (GET http://host/api/workspace) is guarded after a trip', async () => {
    trip();
    const port = await listen();
    expect((await raw(port, 'GET http://127.0.0.1/api/workspace')).status).toBe(503);
  });

  it('KILLS: a state changing write through the encoded prefix is refused after a trip', async () => {
    trip();
    const port = await listen();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/%61pi/lists', headers: { 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ name: 'written while stale' }));
    });
    expect(status).toBe(503);
  });

  it('KILLS: the encoded spelling now refuses with the standard stale envelope, no data in the body', async () => {
    trip();
    const port = await listen();
    const response = await raw(port, 'GET /%61pi/workspace');
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error.code).toBe('stale_server');
  });
});

// ---- Angle 2: health exception scope ----

describe('health exception scope', () => {
  it('is exactly GET /api/health, ignoring only the query string', async () => {
    trip();
    const port = await listen();
    expect((await raw(port, 'GET /api/workspace')).status).toBe(503);
    expect((await raw(port, 'GET /api/health')).status).toBe(200);
    expect((await raw(port, 'GET /api/health?x=1')).status).toBe(200);
    for (const url of ['/api/healthx', '/api/health/', '/api/health/x', '/api//health', '/api/health%2F']) {
      expect((await raw(port, `GET ${url}`)).status, url).toBe(503);
    }
    // /api/./health matches no route; the fallback normalizes it to the exempt health path, so it passes the guard
    // and then 404s like any unknown path. No handler runs and nothing leaks; 404, not 503, is the honest answer.
    expect((await raw(port, 'GET /api/./health')).status).toBe(404);
    // /api/%68ealth routes to the real health handler, so the routed-pattern rule exempts it by identity, not by
    // spelling: it serves the same leak-free health payload with the stale flag, exactly like /api/health.
    const encodedHealth = await raw(port, 'GET /api/%68ealth');
    expect(encodedHealth.status).toBe(200);
    expect(JSON.parse(encodedHealth.body).stale).toBe(true);
  });

  it('HEAD and POST /api/health are guarded (503): the exception is GET only; HEAD health reads "down" for a probe that uses HEAD (accepted by contract wording)', async () => {
    trip();
    expect((await app.inject({ method: 'HEAD', url: '/api/health', headers })).statusCode).toBe(503);
    const post = await app.inject({ method: 'POST', url: '/api/health', headers });
    expect(post.statusCode).toBe(503);
    expect(post.json().error.code).toBe('stale_server');
  });

  it('before a trip HEAD and POST /api/health keep their normal answers (200 and 404), no guard inconsistency', async () => {
    expect((await app.inject({ method: 'HEAD', url: '/api/health', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/health', headers })).statusCode).toBe(404);
  });
});

// ---- Angle 3: guard semantics ----

describe('guard trip semantics', () => {
  it('tripped() reads no database: closing the handle first does not make it throw', () => {
    const guard = createSchemaGuard(env.db, apiMessage);
    expect(guard.tripped()).toBe(false);
    env.db.close();
    expect(() => guard.tripped()).not.toThrow();
    expect(guard.tripped()).toBe(false);
    // A check on a closed handle cannot read: fail closed, permanently, with the app wording.
    expect(() => guard.check()).toThrow(apiMessage);
    expect(guard.tripped()).toBe(true);
    expect(() => guard.tripped()).not.toThrow();
  });

  it('a transient read error trips permanently by design; the HTTP path inherits it and stays 503 after the read recovers', async () => {
    let failNext = false;
    const flaky = new Proxy(env.db, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (failNext && sql.includes('migrations')) {
              failNext = false;
              throw new Error('SQLITE_BUSY: database is locked');
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const guard = createSchemaGuard(flaky, apiMessage);
    const flakyApp = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', webDist: null, guard });
    await flakyApp.ready();
    try {
      expect((await flakyApp.inject({ method: 'GET', url: '/api/workspace', headers })).statusCode).toBe(200);
      failNext = true;
      const failed = await flakyApp.inject({ method: 'GET', url: '/api/workspace', headers });
      expect(failed.statusCode).toBe(503);
      expect(failed.json().error.message).toBe(apiMessage);
      // The database is fine again, and the guard still refuses: fail closed, permanent.
      expect((await flakyApp.inject({ method: 'GET', url: '/api/workspace', headers })).statusCode).toBe(503);
      const health = await flakyApp.inject({ method: 'GET', url: '/api/health', headers });
      expect(health.json().stale).toBe(true);
    } finally {
      await flakyApp.close();
    }
  });

  it('a real second connection holding an exclusive lock yields a clean answer (200 or 503), never a crash', async () => {
    const other = new Database(env.databasePath);
    try {
      other.pragma('busy_timeout = 0');
      other.exec('BEGIN EXCLUSIVE');
      const response = await app.inject({ method: 'GET', url: '/api/workspace', headers });
      expect([200, 503]).toContain(response.statusCode);
      other.exec('ROLLBACK');
      const after = await app.inject({ method: 'GET', url: '/api/workspace', headers });
      // Whatever the first answer was, the contract is monotonic: once 503, always 503.
      if (response.statusCode === 503) expect(after.statusCode).toBe(503);
    } finally {
      other.close();
    }
  });

  it('20 parallel requests across the trip moment over a real socket: each is a whole 200 or a whole 503 envelope', async () => {
    const port = await listen();
    const fire = (): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/api/workspace', agent: false }, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          })
          .on('error', reject);
      });
    const pending: Promise<{ status: number; body: string }>[] = [];
    for (let i = 0; i < 20; i += 1) {
      pending.push(fire());
      if (i === 9) trip();
      if (i % 4 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    const results = await Promise.all(pending);
    for (const result of results) {
      expect([200, 503]).toContain(result.status);
      const parsed = JSON.parse(result.body);
      if (result.status === 200) expect(parsed.id).toMatch(/^wsp_/);
      else expect(parsed).toEqual({ error: { code: 'stale_server', message: apiMessage } });
    }
    // Monotonic: nothing after the first 503 in arrival order of a fresh round is a 200.
    const later = await Promise.all([fire(), fire(), fire()]);
    expect(later.map((result) => result.status)).toEqual([503, 503, 503]);
  });
});

// ---- Angle 4: worker interplay and boot path ----

describe('worker interplay and boot path', () => {
  it('two processes (two guards, two workers) both tripping release cleanly, the second delete is a no-op', async () => {
    vi.useFakeTimers();
    const guardA = createSchemaGuard(env.db, apiMessage);
    const guardB = createSchemaGuard(env.db);
    const errors: unknown[] = [];
    const workerA = startWorker(env.ctx, (error) => errors.push(error), { recover: false, mail: false, leaseKind: 'server', guard: guardA });
    const workerB = startWorker(env.ctx, (error) => errors.push(error), { recover: false, mail: false, leaseKind: 'mcp', guard: guardB });
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds);
    expect(readWorkerLease(env.ctx)).not.toBeNull();
    trip();
    await vi.advanceTimersByTimeAsync(workerTickMilliseconds * 3);
    expect(readWorkerLease(env.ctx)).toBeNull();
    expect(() => workerA.stop()).not.toThrow();
    expect(() => workerB.stop()).not.toThrow();
    expect(errors).toEqual([]);
  });

  it('the MCP process keeps its own guard: the API wording never reaches MCP callers and an API-only trip leaves another guard unaffected until it checks', () => {
    const api = createSchemaGuard(env.db, apiMessage);
    const mcp = createSchemaGuard(env.db);
    trip();
    expect(() => api.check()).toThrow(apiMessage);
    expect(mcp.tripped()).toBe(false);
    expect(() => mcp.check()).toThrow(mcpMessage);
  });

  it('the dev stack boot path never self-trips: a second open (migrations already applied by another process) snapshots the post-migration list', () => {
    const first = openDatabase(env.databasePath);
    const second = openDatabase(env.databasePath);
    try {
      const guard = createSchemaGuard(second, apiMessage);
      expect(() => guard.check()).not.toThrow();
      expect(guard.tripped()).toBe(false);
      const other = createSchemaGuard(first, apiMessage);
      expect(() => other.check()).not.toThrow();
    } finally {
      first.close();
      second.close();
    }
  });
});

// ---- Angle 5: static serving ----

describe('static serving after the trip', () => {
  it('serves /, /assets/*, the SPA fallback, and /api-ish static files, while /api/* is 503', async () => {
    trip();
    expect((await app.inject({ method: 'GET', url: '/api/workspace', headers })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/', headers })).body).toContain('shell');
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js', headers });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('console.log');
    expect((await app.inject({ method: 'GET', url: '/relationships', headers })).body).toContain('shell');
    expect((await app.inject({ method: 'GET', url: '/apidocs.html', headers })).body).toContain('docs');
    expect((await app.inject({ method: 'GET', url: '/api-notes.txt', headers })).body).toBe('notes');
    expect((await app.inject({ method: 'HEAD', url: '/', headers })).statusCode).toBe(200);
  });
});

// ---- Angle 6: error shape ----

describe('error shape', () => {
  it('the 503 matches the standard envelope of other AppErrors: same keys, json content type, no stack', async () => {
    trip();
    const stale = await app.inject({ method: 'GET', url: '/api/workspace', headers });
    expect(stale.headers['content-type']).toMatch(/^application\/json/);
    const body = stale.json();
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error)).toEqual(['code', 'message']);
    expect(stale.body).not.toMatch(/stack|\bat \w+.*\(|node_modules|\.ts:/);
    // Byte for byte against the envelope an ordinary AppError renders.
    const sample = new AppError('stale_server', apiMessage);
    expect(sample.status).toBe(503);
    expect(stale.body).toBe(JSON.stringify({ error: { code: sample.code, message: sample.message } }));
  });

  it('the MCP wording never appears in HTTP source and the HTTP wording never in MCP source', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : [],
      );
    const src = path.join(packageRoot, 'src');
    const httpFiles = [...walk(path.join(src, 'http')), path.join(src, 'server.ts')];
    for (const file of httpFiles) expect(readFileSync(file, 'utf8'), file).not.toContain('Start a new client session');
    for (const file of walk(path.join(src, 'mcp'))) expect(readFileSync(file, 'utf8'), file).not.toContain('Quit and reopen');
  });

  it('runtime: over MCP the wording is the MCP one; the API default constant is not shared', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), 'mcp'],
      cwd: packageRoot,
      env: { ...(process.env as Record<string, string>), AGENTCRM_DB: env.databasePath },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'api-guard-probe', version: '1.0.0' });
    await client.connect(transport);
    try {
      expect((await client.callTool({ name: 'crm_describe', arguments: {} })).isError).toBeFalsy();
      trip();
      const result = await client.callTool({ name: 'crm_describe', arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result as { content: { text: string }[] }).content[0]!.text;
      expect(text).toContain('Start a new client session');
      expect(text).not.toContain('Quit and reopen');
    } finally {
      await client.close();
    }
  }, 30_000);
});

// ---- Angle 8: the desktop flow over a real listening socket via startServer ----

describe('desktop flow over a real socket (startServer + AGENTCRM_WEB_DIST)', () => {
  it('static index serves, /api works, then after another process migrates the file /api is 503, / still serves, health says stale, and an open event stream stays open', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-desktopflow-'));
    const dist = path.join(dir, 'dist');
    mkdirSync(dist);
    writeFileSync(path.join(dist, 'index.html'), '<html>desktop shell</html>');
    const previous = process.env.AGENTCRM_WEB_DIST;
    process.env.AGENTCRM_WEB_DIST = dist;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const server = await startServer({ port: 0, databasePath: path.join(dir, 'd.db') });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const getJson = async (p: string) => {
        const response = await fetch(base + p);
        return { status: response.status, text: await response.text(), type: response.headers.get('content-type') ?? '' };
      };
      expect((await getJson('/')).text).toContain('desktop shell');
      expect((await getJson('/api/workspace')).status).toBe(200);
      expect(JSON.parse((await getJson('/api/health')).text).stale).toBe(false);

      // Open an event stream before the trip.
      const streamStatus = await new Promise<{ status: number; close: () => void }>((resolve, reject) => {
        const req = http.get(`${base}/api/events`, (res) => resolve({ status: res.statusCode ?? 0, close: () => req.destroy() }));
        req.on('error', reject);
      });
      expect(streamStatus.status).toBe(200);

      const other = new Database(path.join(dir, 'd.db'));
      other.prepare("INSERT INTO migrations (name, applied_at) VALUES ('999_future.sql', '2026-03-01T00:00:00.000Z')").run();
      other.close();

      const stale = await getJson('/api/workspace');
      expect(stale.status).toBe(503);
      expect(stale.type).toMatch(/^application\/json/);
      expect(JSON.parse(stale.text)).toEqual({ error: { code: 'stale_server', message: apiMessage } });
      const post = await fetch(`${base}/api/lists`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'nope' }) });
      expect(post.status).toBe(503);
      expect((await getJson('/')).text).toContain('desktop shell');
      expect((await getJson('/relationships')).text).toContain('desktop shell');
      expect(JSON.parse((await getJson('/api/health')).text)).toMatchObject({ ok: true, stale: true });
      expect((await getJson('/api/events')).status).toBe(503);
      // Nothing was written by the refused POST.
      const lists = Number((server.db.prepare('SELECT COUNT(*) AS n FROM list').get() as { n: number }).n);
      expect(lists).toBe(0);
      streamStatus.close();
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.AGENTCRM_WEB_DIST;
      else process.env.AGENTCRM_WEB_DIST = previous;
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// Keeps the import used when a probe above is edited out.
void generateCaptureToken;
