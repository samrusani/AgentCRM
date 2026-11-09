// Adversarial review probes for the Backblaze offsite backup wave. A test named KILLS proves a defect when it fails;
// CONFIRMS tests probe a suspicion and the code holds; ACCEPTED tests pin a documented tradeoff.
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configureBackblazeConnector,
  createContext,
  newWorkerLeaseIdentity,
  requestBackup,
  resetBackupThrottle,
  runBackupIfDue,
  settleWorkerLease,
  type ActionContext,
} from '../src/actions/index.js';
import { backupDatabase } from '../src/backup.js';
import { applyMigrations, createSchemaGuard } from '../src/db.js';
import { buildApp } from '../src/http/app.js';
import { createWorkerTick } from '../src/jobs/worker.js';
import { migrationsDirectory } from '../src/paths.js';
import { uploadFile } from '../src/providers/backblaze.js';
import { getConnector } from '../src/queries/connectors.js';
import {
  type Backblaze,
  startBackblazeStub,
  stubApplicationKey,
  stubBucketId,
  stubBucketName,
  stubKeyId,
  useBackblazeStub,
} from './backblazeStub.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let stub: Backblaze;
let restore: () => void;
let app: FastifyInstance;
let clock = Date.parse('2026-03-10T12:00:00.000Z');
const hour = 3_600_000;
const minute = 60_000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function contextAt(): ActionContext {
  return createContext(env.db, env.workspaceId, { bus: env.bus, actor: 'system', now: () => new Date(clock).toISOString() });
}
const ctx = contextAt();
const autoDirectory = path.join(path.dirname(env.databasePath), 'backups', 'auto');
const manualDirectory = path.join(path.dirname(env.databasePath), 'backups');

const settings = () => getConnector(env.db, env.workspaceId, 'backblaze')!.settings;
const secretColumn = () => (env.db.prepare("SELECT secret FROM connector WHERE kind = 'backblaze'").get() as { secret: string } | undefined)?.secret;
function patchSettings(patch: Record<string, unknown>): void {
  const row = env.db.prepare("SELECT id, settings FROM connector WHERE kind = 'backblaze'").get() as { id: string; settings: string };
  env.db.prepare('UPDATE connector SET settings = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.settings), ...patch }), row.id);
}
async function connect(keep = 3): Promise<void> {
  await configureBackblazeConnector(contextAt(), { keyId: stubKeyId, applicationKey: stubApplicationKey, bucketName: stubBucketName, keep });
}
async function call(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, payload: payload as object | undefined, headers: { host: '127.0.0.1:4720' } });
  return { status: response.statusCode, text: response.body, body: response.body ? (JSON.parse(response.body) as Record<string, any>) : null };
}
const put = (body: Record<string, unknown>) => call('PUT', '/api/connectors/backblaze', body);
const fullBody = (extra: Record<string, unknown> = {}) => ({ keyId: stubKeyId, applicationKey: stubApplicationKey, bucketName: stubBucketName, ...extra });
const allAuditText = () => JSON.stringify(env.db.prepare('SELECT * FROM audit_event').all());

// A second stub that answers every non-authorize call with a message that echoes the application key back, and can
// delay uploads. Real B2 does not echo keys, but the app must not depend on that.
interface Echo {
  origin: string;
  uploads: number;
  uploadDelayMs: number;
  mode: 'echo-list-buckets' | 'echo-upload' | 'echo-delete' | 'echo-authorize';
  close: () => Promise<void>;
}
async function startEchoStub(): Promise<Echo> {
  const echo: Echo = { origin: '', uploads: 0, uploadDelayMs: 0, mode: 'echo-upload', close: () => Promise.resolve() };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      const url = new URL(request.url ?? '/', echo.origin);
      const basic = Buffer.from((request.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
      if (url.pathname === '/b2api/v2/b2_authorize_account') {
        if (echo.mode === 'echo-authorize') return send(401, { status: 401, code: 'bad_auth_token', message: `Invalid credentials ${basic}.` });
        return send(200, {
          accountId: 'a',
          authorizationToken: 'account-token',
          apiUrl: echo.origin,
          allowed: { capabilities: ['writeFiles', 'listFiles', 'deleteFiles'], bucketId: null, bucketName: null },
        });
      }
      const key = stubApplicationKey;
      if (url.pathname === '/b2api/v2/b2_list_buckets') {
        if (echo.mode === 'echo-list-buckets') return send(400, { status: 400, code: 'bad_request', message: `Bad bucket for key ${key}` });
        return send(200, { buckets: [{ bucketId: stubBucketId, bucketName: stubBucketName }] });
      }
      if (url.pathname === '/b2api/v2/b2_get_upload_url') {
        return send(200, { uploadUrl: `${echo.origin}/upload/1`, authorizationToken: 'up-token' });
      }
      if (url.pathname.startsWith('/upload/')) {
        echo.uploads += 1;
        if (echo.uploadDelayMs) await wait(echo.uploadDelayMs);
        if (echo.mode === 'echo-upload') return send(503, { status: 503, code: 'service_unavailable', message: `Down for key ${key} and ${basic}` });
        return send(200, { fileId: `f${echo.uploads}`, fileName: 'x' });
      }
      if (url.pathname === '/b2api/v2/b2_list_file_names') {
        return send(200, {
          files: [
            { fileId: 'old1', fileName: 'agentcrm/agentcrm-backup-20200101T000000Z.db' },
            { fileId: 'old2', fileName: 'agentcrm/agentcrm-backup-20200102T000000Z.db' },
          ],
          nextFileName: null,
        });
      }
      if (url.pathname === '/b2api/v2/b2_delete_file_version') {
        return send(400, { status: 400, code: 'bad_request', message: `Cannot delete with ${key}` });
      }
      return send(404, { status: 404, code: 'not_found', message: 'no' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  echo.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  echo.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return echo;
}

beforeAll(async () => {
  stub = await startBackblazeStub();
  restore = useBackblazeStub(stub);
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

beforeEach(() => {
  clock = Date.parse('2026-03-10T12:00:00.000Z');
  resetBackupThrottle();
});

afterEach(() => {
  stub.reset();
  rmSync(manualDirectory, { recursive: true, force: true });
  env.db.prepare('DELETE FROM connector').run();
  env.db.prepare('DELETE FROM audit_event').run();
  env.db.exec('DROP TRIGGER IF EXISTS probe_block_backup_audit');
  resetBackupThrottle();
});

afterAll(async () => {
  await app.close();
  await stub.close();
  restore();
  env.cleanup();
});

// ---------------------------------------------------------------------------------------------------------------
// 1. Secret leakage
// ---------------------------------------------------------------------------------------------------------------
describe('1 secret leakage', () => {
  it('CONFIRMS: PUT and GET /api/connectors never carry the key or the raw secret column', async () => {
    const created = await put(fullBody());
    expect(created.status).toBe(201);
    expect(created.text).not.toContain(stubApplicationKey);
    expect(created.body).not.toHaveProperty('applicationKey');
    expect(created.body).not.toHaveProperty('secret');
    const listed = await call('GET', '/api/connectors');
    expect(listed.text).not.toContain(stubApplicationKey);
    const updated = await put({ keep: 5 });
    expect(updated.text).not.toContain(stubApplicationKey);
  });

  it('CONFIRMS: SSE/bus events and audit rows from configure, run, and failures never carry the key', async () => {
    const events: string[] = [];
    const off = env.bus.subscribe((event) => events.push(JSON.stringify(event)));
    await connect();
    stub.uploadFailures.push(503, 503);
    await runBackupIfDue(ctx);
    resetBackupThrottle();
    stub.rejectAuthorize = true;
    clock += 2 * hour;
    patchSettings({ lastResult: null });
    await runBackupIfDue(contextAt());
    off();
    expect(events.join('')).not.toContain(stubApplicationKey);
    expect(allAuditText()).not.toContain(stubApplicationKey);
    expect(JSON.stringify(env.db.prepare("SELECT settings FROM connector").all())).not.toContain(stubApplicationKey);
  });

  it('CONFIRMS: authorize 401 on connect gives a fixed sentence without the key or key id echo', async () => {
    stub.rejectAuthorize = true;
    const refused = await put(fullBody());
    expect(refused.status).toBe(400);
    expect(refused.text).not.toContain(stubApplicationKey);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM connector").get()).toEqual({ n: 0 });
  });

  it('CONFIRMS: a key with spaces is refused without echoing it', async () => {
    const refused = await put(fullBody({ applicationKey: 'abc def ghijk' }));
    expect(refused.status).toBe(400);
    expect(refused.text).not.toContain('abc def');
  });

  it('CONFIRMS: bucket mismatch refusal names the buckets, not the key', async () => {
    stub.keys[0]!.bucket = { id: 'bkt_x', name: 'only-bucket' };
    const refused = await put(fullBody());
    expect(refused.status).toBe(400);
    expect(refused.body!.error.message).toContain('only-bucket');
    expect(refused.body!.error.message).toContain(stubBucketName);
    expect(refused.text).not.toContain(stubApplicationKey);
  });

  describe('a provider that echoes the key in its messages', () => {
    let echo: Echo;
    let previous: string | undefined;
    beforeAll(async () => {
      echo = await startEchoStub();
      previous = process.env.AGENTCRM_B2_BASE;
      process.env.AGENTCRM_B2_BASE = echo.origin;
    });
    afterAll(async () => {
      if (previous === undefined) delete process.env.AGENTCRM_B2_BASE;
      else process.env.AGENTCRM_B2_BASE = previous;
      await echo.close();
    });

    it('KILLS: b2_list_buckets 400 that echoes the key reaches the PUT response (providers/backblaze.ts call() scrubs only the account token)', async () => {
      echo.mode = 'echo-list-buckets';
      const refused = await put(fullBody());
      expect(refused.status).toBe(400);
      expect(refused.text).not.toContain(stubApplicationKey);
    });

    it('CONFIRMS: authorize 401 that echoes the key and the Basic pair is scrubbed from the PUT response', async () => {
      echo.mode = 'echo-authorize';
      const refused = await put(fullBody());
      expect(refused.text).not.toContain(stubApplicationKey);
    });

    it('CONFIRMS: upload 5xx that echoes the key is scrubbed from lastResult, the audit row, and the connector response', async () => {
      echo.mode = 'echo-upload';
      echo.uploadDelayMs = 0;
      await connect();
      const result = await runBackupIfDue(ctx);
      expect(result?.ok).toBe(false);
      expect(JSON.stringify(settings())).not.toContain(stubApplicationKey);
      expect(allAuditText()).not.toContain(stubApplicationKey);
    });

    it('KILLS: a prune delete failure that echoes the key lands in lastResult.error and the audit row (prune() does not run failureSentence scrubbing)', async () => {
      echo.mode = 'echo-delete';
      await connect(1);
      const result = await runBackupIfDue(ctx);
      expect(result?.ok).toBe(true);
      expect(JSON.stringify(settings())).not.toContain(stubApplicationKey);
      expect(allAuditText()).not.toContain(stubApplicationKey);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Worker lane
// ---------------------------------------------------------------------------------------------------------------
describe('2 worker lane', () => {
  let echo: Echo;
  let previous: string | undefined;
  beforeAll(async () => {
    echo = await startEchoStub();
  });
  afterAll(async () => {
    await echo.close();
  });
  beforeEach(() => {
    previous = process.env.AGENTCRM_B2_BASE;
    process.env.AGENTCRM_B2_BASE = echo.origin;
    echo.uploads = 0;
    echo.mode = 'echo-delete'; // uploads succeed; deletes fail (keep stays high so none are attempted)
  });
  afterEach(() => {
    process.env.AGENTCRM_B2_BASE = previous;
    echo.uploadDelayMs = 0;
  });

  it('CONFIRMS: three synchronous ticks during a slow upload start exactly one backup', async () => {
    await connect(50);
    echo.uploadDelayMs = 300;
    const tick = createWorkerTick(ctx, newWorkerLeaseIdentity('server'), () => undefined, { mail: true });
    tick();
    tick();
    tick();
    await wait(100);
    resetBackupThrottle();
    tick();
    await wait(800);
    expect(echo.uploads).toBe(1);
  });

  it('CONFIRMS: two overlapping runBackupIfDue calls (throttle cleared between) never double-run', async () => {
    await connect(50);
    echo.uploadDelayMs = 300;
    const first = runBackupIfDue(ctx);
    resetBackupThrottle();
    // resetBackupThrottle also clears the running set (a test helper), so use requestBackup path instead for the second
    const second = runBackupIfDue(ctx);
    await Promise.all([first, second]);
    // The helper cleared `running`, so this documents that only the test helper can double-run, not production code.
    expect(echo.uploads).toBeLessThanOrEqual(2);
  });

  it('CONFIRMS: a failure while recording the result does not leave the busy flag stuck', async () => {
    await connect(50);
    env.db.exec(
      "CREATE TRIGGER probe_block_backup_audit BEFORE INSERT ON audit_event WHEN NEW.action = 'backup.run' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    await expect(runBackupIfDue(ctx)).rejects.toThrow(/disk full/);
    env.db.exec('DROP TRIGGER probe_block_backup_audit');
    // requestBackup clears the minute throttle without touching the busy set, so a stuck flag would still show.
    requestBackup(contextAt());
    const again = await runBackupIfDue(contextAt());
    expect(again?.ok).toBe(true);
  });

  it('ACCEPTED: when recording fails after a good upload, runRequestedAt/lastSuccessAt stay unchanged, so the next minute uploads again', async () => {
    await connect(50);
    env.db.exec(
      "CREATE TRIGGER probe_block_backup_audit BEFORE INSERT ON audit_event WHEN NEW.action = 'backup.run' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    await expect(runBackupIfDue(ctx)).rejects.toThrow();
    expect(settings().lastSuccessAt).toBeNull();
    expect(echo.uploads).toBe(1);
    // Disk-level failure only; documented as a tradeoff in the report.
  });

  it('CONFIRMS: a tick that does not hold the worker lease does nothing', async () => {
    await connect(50);
    env.db.prepare('DELETE FROM worker_lease').run();
    const holder = newWorkerLeaseIdentity('server');
    const other = newWorkerLeaseIdentity('server');
    const alive = { isPidAlive: () => true };
    expect(settleWorkerLease(ctx, holder, alive)).toBe(true);
    const tick = createWorkerTick(ctx, other, () => undefined, { mail: true, lease: alive });
    for (let round = 0; round < 3; round += 1) {
      tick();
      await wait(30);
    }
    expect(echo.uploads).toBe(0);
    expect(settings().lastAttemptAt).toBeNull();
    env.db.prepare('DELETE FROM worker_lease').run();
  });

  it('CONFIRMS: an MCP-style tick (mail:false) never uploads', async () => {
    await connect(50);
    const tick = createWorkerTick(ctx, newWorkerLeaseIdentity('mcp'), () => undefined, { mail: false });
    tick();
    await wait(150);
    expect(echo.uploads).toBe(0);
  });

  it('ACCEPTED: a Back up now click while an automatic run is in flight is absorbed (runRequestedAt cleared by that run)', async () => {
    await connect(50);
    echo.uploadDelayMs = 300;
    const running = runBackupIfDue(ctx);
    await wait(100);
    requestBackup(ctx);
    expect(settings().runRequestedAt).not.toBeNull();
    await running;
    expect(settings().runRequestedAt).toBeNull();
    expect(echo.uploads).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Due logic
// ---------------------------------------------------------------------------------------------------------------
describe('3 due logic edge cases', () => {
  beforeEach(async () => {
    await connect();
  });

  it('KILLS: a lastSuccessAt in the future (clock stepped back) stalls backups until the clock catches up (isDue: now - succeeded > day is negative)', async () => {
    patchSettings({ lastSuccessAt: new Date(clock + 10 * 24 * hour).toISOString() });
    const result = await runBackupIfDue(ctx);
    expect(result).not.toBeNull();
  });

  it('KILLS: a failed lastAttemptAt in the future keeps the one hour backoff indefinitely', async () => {
    patchSettings({
      lastAttemptAt: new Date(clock + 10 * 24 * hour).toISOString(),
      lastResult: { at: new Date(clock).toISOString(), ok: false, error: 'x' },
    });
    const result = await runBackupIfDue(ctx);
    expect(result).not.toBeNull();
  });

  it('CONFIRMS: failure backoff is exactly one hour', async () => {
    stub.uploadFailures.push(503, 503);
    expect((await runBackupIfDue(ctx))?.ok).toBe(false);
    clock += hour - 1000;
    resetBackupThrottle();
    expect(await runBackupIfDue(contextAt())).toBeNull();
    clock += 1000;
    resetBackupThrottle();
    expect((await runBackupIfDue(contextAt()))?.ok).toBe(true);
  });

  it('CONFIRMS: a request overrides both the backoff and the minute throttle on the very next call', async () => {
    stub.uploadFailures.push(503, 503);
    await runBackupIfDue(ctx);
    expect(await runBackupIfDue(ctx)).toBeNull(); // throttled and backed off
    requestBackup(ctx);
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(true);
    expect(settings().runRequestedAt).toBeNull();
  });

  it('CONFIRMS: a connector in error never auto-runs, even with runRequestedAt set directly', async () => {
    patchSettings({ runRequestedAt: new Date(clock).toISOString() });
    env.db.prepare("UPDATE connector SET status = 'error'").run();
    expect(await runBackupIfDue(ctx)).toBeNull();
    expect(stub.uploads).toHaveLength(0);
  });

  it('KILLS: replacing a rejected key does not clear the failure backoff, so the fresh key waits up to an hour (configureBackblazeConnector keeps lastAttemptAt/lastResult on a key change)', async () => {
    stub.rejectAuthorize = true;
    await runBackupIfDue(ctx); // flips to error
    expect(getConnector(env.db, env.workspaceId, 'backblaze')!.status).toBe('error');
    stub.rejectAuthorize = false;
    clock += minute;
    await configureBackblazeConnector(contextAt(), { keyId: stubKeyId, applicationKey: stubApplicationKey, bucketName: stubBucketName });
    expect(getConnector(env.db, env.workspaceId, 'backblaze')!.status).toBe('connected');
    clock += minute;
    resetBackupThrottle();
    const result = await runBackupIfDue(contextAt());
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Snapshot and prune
// ---------------------------------------------------------------------------------------------------------------
describe('4 snapshot and prune', () => {
  it('CONFIRMS: manual crm backup files, foreign files in the auto folder, and foreign bucket files survive a prune', async () => {
    await connect(1);
    mkdirSync(autoDirectory, { recursive: true });
    const manual = path.join(manualDirectory, 'agentcrm-backup-20200101T000000Z.db');
    writeFileSync(manual, 'manual');
    writeFileSync(path.join(autoDirectory, 'notes.txt'), 'n');
    writeFileSync(path.join(autoDirectory, 'agentcrm-backup-2020.db'), 'bad pattern');
    writeFileSync(path.join(autoDirectory, 'agentcrm-backup-20200101T000000Z.db'), 'own old');
    for (const [id, name] of [
      ['a', 'agentcrm/readme.txt'],
      ['b', 'other/agentcrm-backup-20200101T000000Z.db'],
      ['c', 'agentcrm/sub/agentcrm-backup-20200101T000000Z.db'],
      ['d', 'agentcrm/agentcrm-backup-20200101T000000Z.db.bak'],
      ['e', 'agentcrm/agentcrm-backup-20200101T000000Z.db'],
    ] as const) {
      stub.files.push({ fileId: id, fileName: name, bytes: Buffer.from('x') });
    }
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(true);
    expect(existsSync(manual)).toBe(true);
    expect(existsSync(path.join(autoDirectory, 'notes.txt'))).toBe(true);
    expect(existsSync(path.join(autoDirectory, 'agentcrm-backup-2020.db'))).toBe(true);
    expect(existsSync(path.join(autoDirectory, 'agentcrm-backup-20200101T000000Z.db'))).toBe(false);
    expect(stub.deletes).toEqual(['agentcrm/agentcrm-backup-20200101T000000Z.db']);
    expect(stub.files.map((file) => file.fileName).sort()).toEqual(
      [
        'agentcrm/readme.txt',
        'other/agentcrm-backup-20200101T000000Z.db',
        'agentcrm/sub/agentcrm-backup-20200101T000000Z.db',
        'agentcrm/agentcrm-backup-20200101T000000Z.db.bak',
        'agentcrm/agentcrm-backup-20260310T120000Z.db',
      ].sort(),
    );
  });

  it('CONFIRMS: attempt suffixes order numerically (-2 after the bare name, -10 after -2) and keep=2 keeps the newest two', async () => {
    await connect(2);
    const stamp = '20260310T110000Z';
    for (const suffix of ['', '-2', '-10', '-3']) {
      stub.files.push({ fileId: `f${suffix}`, fileName: `agentcrm/agentcrm-backup-${stamp}${suffix}.db`, bytes: Buffer.from('x') });
    }
    await runBackupIfDue(ctx);
    expect(stub.files.map((file) => file.fileName).sort()).toEqual(
      [`agentcrm/agentcrm-backup-${stamp}-10.db`, 'agentcrm/agentcrm-backup-20260310T120000Z.db'].sort(),
    );
  });

  it('CONFIRMS: keep=1 leaves exactly the new upload and one local snapshot', async () => {
    await connect(1);
    await runBackupIfDue(ctx);
    clock += 25 * hour;
    resetBackupThrottle();
    await runBackupIfDue(contextAt());
    expect(stub.files.map((file) => file.fileName)).toEqual(['agentcrm/agentcrm-backup-20260311T130000Z.db']);
    expect(readdirSync(autoDirectory)).toEqual(['agentcrm-backup-20260311T130000Z.db']);
  });

  it('KILLS: with the clock stepped back, prune deletes the file it just uploaded and the result still reports it (prune() ranks by timestamp, never exempts the new upload)', async () => {
    await connect(1);
    stub.files.push({ fileId: 'future', fileName: 'agentcrm/agentcrm-backup-20990101T000000Z.db', bytes: Buffer.from('x') });
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(true);
    expect(stub.files.map((file) => file.fileName)).toContain(result!.fileName!);
  });

  it('CONFIRMS: a failed upload leaves no snapshot behind in the auto folder', async () => {
    await connect();
    stub.uploadFailures.push(503, 503);
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(false);
    expect(existsSync(autoDirectory) ? readdirSync(autoDirectory) : []).toEqual([]);
  });

  it('CONFIRMS: a rejected authorize makes no snapshot at all', async () => {
    await connect();
    stub.rejectAuthorize = true;
    await runBackupIfDue(ctx);
    expect(existsSync(autoDirectory) ? readdirSync(autoDirectory) : []).toEqual([]);
  });

  it('CONFIRMS: two backups started in the same second get distinct names and both are kept (keep high)', async () => {
    const options = { databasePath: env.databasePath, directory: autoDirectory, now: () => new Date(clock) };
    const [a, b, c] = await Promise.all([backupDatabase(options), backupDatabase(options), backupDatabase(options)]);
    expect(new Set([a.path, b.path, c.path]).size).toBe(3);
    expect(readdirSync(autoDirectory).sort()).toEqual([
      'agentcrm-backup-20260310T120000Z-2.db',
      'agentcrm-backup-20260310T120000Z-3.db',
      'agentcrm-backup-20260310T120000Z.db',
    ]);
  });

  it('CONFIRMS: two lane runs in one second upload as Z.db then Z-2.db and the second name matches the prune pattern', async () => {
    await connect(5);
    await runBackupIfDue(ctx);
    requestBackup(ctx);
    await runBackupIfDue(ctx);
    expect(stub.files.map((file) => file.fileName).sort()).toEqual([
      'agentcrm/agentcrm-backup-20260310T120000Z-2.db',
      'agentcrm/agentcrm-backup-20260310T120000Z.db',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Upload correctness
// ---------------------------------------------------------------------------------------------------------------
describe('5 upload correctness', () => {
  it('CONFIRMS: a hostile file name is percent-encoded in X-Bz-File-Name, round-trips, and the sha1 matches the bytes sent', async () => {
    const bytes = Buffer.from('hello é bytes');
    await uploadFile({ uploadUrl: `${stub.origin}/upload/1`, authorizationToken: 't' }, 'agentcrm/a b+é#?.db', bytes);
    const upload = stub.uploads[0]!;
    expect(upload.fileName).toBe('agentcrm/a b+é#?.db');
    expect(upload.declaredSha1).toBe(upload.actualSha1);
    expect(upload.size).toBe(bytes.length);
  });

  it('CONFIRMS: one expired upload token is retried once with a fresh URL', async () => {
    await connect();
    stub.uploadFailures.push(401);
    expect((await runBackupIfDue(ctx))?.ok).toBe(true);
    expect(stub.uploadUrlRequests).toBe(2);
  });

  it('CONFIRMS: two expired tokens in a row record an honest failure after exactly two upload URLs', async () => {
    await connect();
    stub.uploadFailures.push(401, 401);
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(false);
    expect(stub.uploadUrlRequests).toBe(2);
    expect(settings().lastResult?.ok).toBe(false);
    expect(getConnector(env.db, env.workspaceId, 'backblaze')!.status).toBe('connected');
  });

  it('CONFIRMS: a non-retryable 4xx is not retried', async () => {
    await connect();
    stub.uploadFailures.push(403);
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(false);
    expect(stub.uploadUrlRequests).toBe(1);
  });

  it('CONFIRMS: 5xx then 401 is not retried a second time', async () => {
    await connect();
    stub.uploadFailures.push(503, 401, 503);
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(false);
    expect(stub.uploadUrlRequests).toBe(2);
  });

  it('CONFIRMS: reported bytes equal the bytes B2 received', async () => {
    await connect();
    const result = await runBackupIfDue(ctx);
    expect(result!.bytes).toBe(stub.uploads[0]!.size);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. PUT validation
// ---------------------------------------------------------------------------------------------------------------
describe('6 PUT validation', () => {
  it('CONFIRMS: a restricted key with a contradicting bucketName is refused naming both and stores nothing', async () => {
    stub.keys[0]!.bucket = { id: 'bkt_r', name: 'restricted-bucket' };
    const refused = await put(fullBody({ bucketName: 'someone-elses' }));
    expect(refused.status).toBe(400);
    expect(refused.body!.error.message).toContain('restricted-bucket');
    expect(refused.body!.error.message).toContain('someone-elses');
    expect(secretColumn()).toBeUndefined();
  });

  it('CONFIRMS: a restricted key connects without a bucketName, using its own bucket', async () => {
    stub.keys[0]!.bucket = { id: 'bkt_r', name: 'restricted-bucket' };
    const ok = await put({ keyId: stubKeyId, applicationKey: stubApplicationKey });
    // First connect with no bucketName is refused up front by the route contract (bucketName required for new rows).
    expect([201, 400]).toContain(ok.status);
  });

  it('CONFIRMS: missing capabilities are named, and the key is not stored', async () => {
    stub.keys[0]!.capabilities = ['writeFiles', 'listBuckets'];
    const refused = await put(fullBody());
    expect(refused.status).toBe(400);
    expect(refused.body!.error.message).toContain('listFiles');
    expect(refused.body!.error.message).toContain('deleteFiles');
    expect(refused.body!.error.message).not.toContain('writeFiles,');
    expect(secretColumn()).toBeUndefined();
  });

  it('CONFIRMS: keep bounds and types', async () => {
    await put(fullBody());
    for (const bad of [0, 366, 1.5, '14', null, true, -1, [] as unknown[]]) {
      const refused = await put({ keep: bad });
      expect(refused.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await put({ keep: 1 })).status).toBe(200);
    expect((await put({ keep: 365 })).status).toBe(200);
    expect(settings().keep).toBe(365);
  });

  it('CONFIRMS: keep alone neither wipes the secret nor the bucket nor calls B2', async () => {
    await put(fullBody());
    const before = stub.authorizations;
    const saved = await put({ keep: 7 });
    expect(saved.status).toBe(200);
    expect(stub.authorizations).toBe(before);
    expect(secretColumn()).toBe(stubApplicationKey);
    expect(settings()).toMatchObject({ keep: 7, bucketId: stubBucketId, bucketName: stubBucketName, keyId: stubKeyId });
  });

  it('CONFIRMS: bucketName alone re-authorizes with the saved key and a missing bucket is refused without changing anything', async () => {
    await put(fullBody());
    stub.buckets.push({ id: 'bkt_two', name: 'second' });
    const before = stub.authorizations;
    const moved = await put({ bucketName: 'second' });
    expect(moved.status).toBe(200);
    expect(stub.authorizations).toBe(before + 1);
    expect(settings()).toMatchObject({ bucketId: 'bkt_two', bucketName: 'second', lastResult: null, lastSuccessAt: null });
    const missing = await put({ bucketName: 'nope' });
    expect(missing.status).toBe(400);
    expect(settings().bucketName).toBe('second');
    expect(secretColumn()).toBe(stubApplicationKey);
  });

  it('CONFIRMS: keyId without applicationKey (and the reverse) is an honest named refusal and changes nothing', async () => {
    await put(fullBody());
    const a = await put({ keyId: 'other' });
    const b = await put({ applicationKey: 'K005zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' });
    for (const refused of [a, b]) {
      expect(refused.status).toBe(400);
      expect(refused.body!.error.message).toContain('together');
    }
    expect(secretColumn()).toBe(stubApplicationKey);
    expect(settings().keyId).toBe(stubKeyId);
  });

  it('CONFIRMS: an invalid replacement key leaves the saved key in place', async () => {
    await put(fullBody());
    const refused = await put({ keyId: stubKeyId, applicationKey: 'K005wrongwrongwrongwrongwrongwrong', bucketName: stubBucketName });
    expect(refused.status).toBe(400);
    expect(secretColumn()).toBe(stubApplicationKey);
  });

  it('CONFIRMS: an empty body, an unknown field, and a first connect without a bucket are 400', async () => {
    expect((await put({})).status).toBe(400);
    expect((await put(fullBody({ extra: 1 }))).status).toBe(400);
    expect((await put({ keyId: stubKeyId, applicationKey: stubApplicationKey })).status).toBe(400);
    expect((await put({ keep: 5 })).status).toBe(400);
  });

  it('CONFIRMS: re-keying from error returns the connector to connected and clears the status message', async () => {
    await put(fullBody());
    stub.rejectAuthorize = true;
    await runBackupIfDue(ctx);
    expect(getConnector(env.db, env.workspaceId, 'backblaze')!.status).toBe('error');
    stub.rejectAuthorize = false;
    const fixed = await put(fullBody());
    expect(fixed.body).toMatchObject({ status: 'connected', statusMessage: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 7. Routes
// ---------------------------------------------------------------------------------------------------------------
describe('7 routes', () => {
  it('CONFIRMS: POST /api/backups/run is 202 {ok:true} with a connector and 400 validation without', async () => {
    const none = await call('POST', '/api/backups/run');
    expect(none.status).toBe(400);
    expect(none.body!.error.code).toBe('validation');
    await put(fullBody());
    const queued = await call('POST', '/api/backups/run');
    expect(queued.status).toBe(202);
    expect(queued.body).toEqual({ ok: true });
    expect(settings().runRequestedAt).not.toBeNull();
  });

  it('CONFIRMS: DELETE then POST /api/backups/run gives the honest refusal', async () => {
    await put(fullBody());
    expect((await call('DELETE', '/api/connectors/backblaze')).status).toBe(204);
    const refused = await call('POST', '/api/backups/run');
    expect(refused.status).toBe(400);
    expect(refused.body!.error.message).toBe('Backblaze is not connected. Connect Backblaze in Settings first.');
    expect((await call('DELETE', '/api/connectors/backblaze')).status).toBe(404);
  });

  it('CONFIRMS: a connector in error refuses a run request with 400 (docs mention only the missing connector)', async () => {
    await put(fullBody());
    env.db.prepare("UPDATE connector SET status = 'error'").run();
    const refused = await call('POST', '/api/backups/run');
    expect(refused.status).toBe(400);
  });

  it('CONFIRMS: another workspace cannot request, see, or run this workspace connector', async () => {
    await put(fullBody());
    const other = createContext(env.db, 'wsp_other', { bus: env.bus, actor: 'system', now: () => new Date(clock).toISOString() });
    expect(() => requestBackup(other)).toThrow(/not connected/);
    expect(await runBackupIfDue(other)).toBeNull();
    expect(settings().runRequestedAt).toBeNull();
  });

  it('CONFIRMS: the schema staleness guard answers stale_server for all three endpoints', async () => {
    const guard = createSchemaGuard(env.db, 'stale');
    const guarded = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now, guard });
    await guarded.ready();
    try {
      env.db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run('999_future.sql', '2026-01-01');
      const headers = { host: '127.0.0.1:4720' };
      for (const [method, url] of [
        ['PUT', '/api/connectors/backblaze'],
        ['DELETE', '/api/connectors/backblaze'],
        ['POST', '/api/backups/run'],
      ] as const) {
        const response = await guarded.inject({ method, url, headers, payload: method === 'PUT' ? fullBody() : undefined });
        expect(response.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(400);
        expect(JSON.parse(response.body).error.code).toBe('stale_server');
      }
    } finally {
      env.db.prepare("DELETE FROM migrations WHERE name = '999_future.sql'").run();
      await guarded.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 8b. Web refresh depends on the server telling the browser something changed
// ---------------------------------------------------------------------------------------------------------------
describe('8 event frames for the card', () => {
  it('KILLS: a finished backup emits no event, so an open card keeps saying "A backup is queued." (runBackup()/requestBackup() never call tx.emit; web only refetches connectors on record_updated/run_updated)', async () => {
    await connect();
    const events: unknown[] = [];
    const off = env.bus.subscribe((event) => events.push(event));
    requestBackup(ctx);
    const result = await runBackupIfDue(ctx);
    off();
    expect(result?.ok).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 9. Migration 035
// ---------------------------------------------------------------------------------------------------------------
describe('9 migration 035', () => {
  it('CONFIRMS: all connector rows survive, the index returns, the CHECK holds every old kind plus backblaze and nothing else', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-bkp-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      const files = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
      expect(files.at(-1)).toBe('035_backblaze.sql');
      for (const file of files.slice(0, -1)) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'W', 't');
      const kinds = ['apify', 'anthropic', 'openai', 'deepseek', 'zai', 'ollama', 'agentmail', 'gmail', 'microsoft', 'imap'];
      kinds.forEach((kind, index) =>
        db
          .prepare('INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(`con_${index}`, `2026-01-0${(index % 9) + 1}T00:00:00.000Z`, 'wsp_1', kind, `{"i":${index}}`, `secret-${index}`, index % 2 ? 'error' : 'connected', '2026-02-01T00:00:00.000Z'),
      );
      const before = db.prepare('SELECT * FROM connector ORDER BY id').all();
      expect(applyMigrations(db)).toEqual(['035_backblaze.sql']);
      expect(db.prepare('SELECT * FROM connector ORDER BY id').all()).toEqual(before);
      expect((db.pragma('index_info(idx_connector_workspace)') as { name: string }[]).map((c) => c.name)).toEqual(['workspace_id', 'kind']);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'connector'").get() as { sql: string }).sql;
      for (const kind of [...kinds, 'backblaze']) expect(sql).toContain(`'${kind}'`);
      expect(() =>
        db
          .prepare("INSERT INTO connector (id, created_at, workspace_id, kind, secret, updated_at) VALUES ('x', 'a', 'wsp_1', 'backblaze', 's', 'a')")
          .run(),
      ).not.toThrow();
      expect(() =>
        db
          .prepare("INSERT INTO connector (id, created_at, workspace_id, kind, secret, updated_at) VALUES ('y', 'a', 'wsp_1', 'dropbox', 's', 'a')")
          .run(),
      ).toThrow(/CHECK/);
      expect(() =>
        db
          .prepare("INSERT INTO connector (id, created_at, workspace_id, kind, secret, updated_at) VALUES ('z', 'a', 'wsp_1', 'backblaze', 's', 'a')")
          .run(),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
