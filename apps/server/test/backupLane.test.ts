import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getConnector } from '../src/queries/connectors.js';
import { configureBackblazeConnector, requestBackup, resetBackupThrottle, runBackupIfDue } from '../src/actions/index.js';
import { createContext, type ActionContext } from '../src/actions/index.js';
import { createWorkerTick } from '../src/jobs/worker.js';
import { newWorkerLeaseIdentity } from '../src/actions/index.js';
import {
  type Backblaze,
  startBackblazeStub,
  stubApplicationKey,
  stubBucketName,
  stubKeyId,
  useBackblazeStub,
} from './backblazeStub.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let stub: Backblaze;
let restore: () => void;
let clock = Date.parse('2026-03-10T12:00:00.000Z');
const hour = 3_600_000;

// A context with a clock the test sets directly.
function contextAt(): ActionContext {
  return createContext(env.db, env.workspaceId, { bus: env.bus, actor: 'system', now: () => new Date(clock).toISOString() });
}
const ctx = contextAt();
const autoDirectory = path.join(path.dirname(env.databasePath), 'backups', 'auto');

function settings() {
  return getConnector(env.db, env.workspaceId, 'backblaze')!.settings;
}

function patchSettings(patch: Record<string, unknown>): void {
  const row = env.db.prepare("SELECT id, settings FROM connector WHERE kind = 'backblaze'").get() as { id: string; settings: string };
  env.db.prepare('UPDATE connector SET settings = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.settings), ...patch }), row.id);
}

beforeAll(async () => {
  stub = await startBackblazeStub();
  restore = useBackblazeStub(stub);
});

beforeEach(async () => {
  clock = Date.parse('2026-03-10T12:00:00.000Z');
  resetBackupThrottle();
  await configureBackblazeConnector(contextAt(), { keyId: stubKeyId, applicationKey: stubApplicationKey, bucketName: stubBucketName, keep: 3 });
  stub.authorizations = 0;
});

afterEach(() => {
  stub.reset();
  rmSync(autoDirectory, { recursive: true, force: true });
  env.db.prepare('DELETE FROM connector').run();
  env.db.prepare('DELETE FROM audit_event').run();
  resetBackupThrottle();
});

afterAll(async () => {
  await stub.close();
  restore();
  env.cleanup();
});

describe('backup lane due logic', () => {
  it('runs when no backup has ever succeeded', async () => {
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(true);
    expect(stub.uploads).toHaveLength(1);
  });

  it('does not run when the last success is fresh', async () => {
    patchSettings({ lastSuccessAt: new Date(clock - 23 * hour).toISOString() });
    expect(await runBackupIfDue(ctx)).toBeNull();
    expect(stub.authorizations).toBe(0);
  });

  it('runs when the last success is 25 hours old', async () => {
    patchSettings({ lastSuccessAt: new Date(clock - 25 * hour).toISOString() });
    expect((await runBackupIfDue(ctx))?.ok).toBe(true);
  });

  it('treats an unparseable last success as due', async () => {
    patchSettings({ lastSuccessAt: 'not a date' });
    expect((await runBackupIfDue(ctx))?.ok).toBe(true);
  });

  it('waits an hour after a failure, then tries again', async () => {
    stub.uploadFailures = [400];
    const failed = await runBackupIfDue(ctx);
    expect(failed?.ok).toBe(false);
    expect(settings().lastResult?.ok).toBe(false);
    expect(settings().lastSuccessAt).toBeNull();
    resetBackupThrottle();
    clock += 59 * 60_000;
    expect(await runBackupIfDue(ctx)).toBeNull();
    resetBackupThrottle();
    clock += 2 * 60_000;
    expect((await runBackupIfDue(ctx))?.ok).toBe(true);
  });

  it('runs a requested backup even inside the failure backoff, and clears the request', async () => {
    stub.uploadFailures = [400];
    expect((await runBackupIfDue(ctx))?.ok).toBe(false);
    requestBackup(ctx);
    expect(settings().runRequestedAt).not.toBeNull();
    // requestBackup clears the throttle, and the request bypasses the backoff.
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(true);
    expect(settings().runRequestedAt).toBeNull();
  });

  it('clears the request after a failure too', async () => {
    requestBackup(ctx);
    stub.uploadFailures = [400];
    expect((await runBackupIfDue(ctx))?.ok).toBe(false);
    expect(settings().runRequestedAt).toBeNull();
  });

  it('checks at most once a minute', async () => {
    patchSettings({ lastSuccessAt: new Date(clock - 25 * hour).toISOString() });
    expect(await runBackupIfDue(ctx)).not.toBeNull();
    patchSettings({ lastSuccessAt: new Date(clock - 25 * hour).toISOString() });
    expect(await runBackupIfDue(ctx)).toBeNull();
  });

  it('does nothing without a connector or with a connector in error', async () => {
    env.db.prepare("UPDATE connector SET status = 'error'").run();
    expect(await runBackupIfDue(ctx)).toBeNull();
    env.db.prepare('DELETE FROM connector').run();
    resetBackupThrottle();
    expect(await runBackupIfDue(ctx)).toBeNull();
  });

  it('runs from a worker tick that holds the mail gate, and not without it', async () => {
    const errors: unknown[] = [];
    const identity = newWorkerLeaseIdentity('server');
    const gated = createWorkerTick(ctx, identity, (error) => errors.push(error), { mail: false });
    gated();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stub.uploads).toHaveLength(0);
    const tick = createWorkerTick(ctx, identity, (error) => errors.push(error), { mail: true });
    tick();
    for (let attempt = 0; attempt < 50 && stub.uploads.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stub.uploads).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

describe('backup lane run', () => {
  it('uploads the snapshot with a matching sha1 and the agentcrm/ file name', async () => {
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(true);
    const upload = stub.uploads[0]!;
    expect(upload.fileName).toMatch(/^agentcrm\/agentcrm-backup-20260310T120000Z(-\d+)?\.db$/);
    expect(upload.declaredSha1).toBe(upload.actualSha1);
    expect(upload.contentType).toBe('b2/x-auto');
    expect(upload.contentLength).toBe(String(upload.size));
    expect(upload.authorization).toBe('upload-token-1');
    expect(result?.fileName).toBe(upload.fileName);
    expect(result?.bytes).toBe(upload.size);
    // The file is a SQLite database.
    expect(stub.files[0]!.bytes.subarray(0, 15).toString()).toBe('SQLite format 3');
  });

  it('keeps the local snapshot in data/backups/auto next to the database', async () => {
    await runBackupIfDue(ctx);
    const files = readdirSync(autoDirectory);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(path.basename(stub.uploads[0]!.fileName));
    expect(readFileSync(path.join(autoDirectory, files[0]!)).length).toBe(stub.uploads[0]!.size);
  });

  it('records the result, the attempt, and the success, and audits without the key', async () => {
    const result = await runBackupIfDue(ctx);
    const saved = settings();
    expect(saved.lastAttemptAt).toBe(new Date(clock).toISOString());
    expect(saved.lastSuccessAt).toBe(new Date(clock).toISOString());
    expect(saved.lastResult).toEqual({ at: new Date(clock).toISOString(), ok: true, fileName: result!.fileName, bytes: result!.bytes });
    const audit = env.db.prepare("SELECT actor, detail FROM audit_event WHERE action = 'backup.run'").all() as { actor: string; detail: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe('system');
    expect(JSON.parse(audit[0]!.detail)).toEqual({ ok: true, fileName: result!.fileName, bytes: result!.bytes });
    for (const row of env.db.prepare('SELECT detail FROM audit_event').all() as { detail: string }[]) {
      expect(row.detail).not.toContain(stubApplicationKey);
    }
  });

  it('prunes remote and local files to keep, oldest first, and leaves other files alone', async () => {
    mkdirSync(autoDirectory, { recursive: true });
    const stamps = ['20260301T000000Z', '20260302T000000Z', '20260303T000000Z', '20260304T000000Z', '20260305T000000Z'];
    stamps.forEach((stamp, index) => {
      stub.files.push({ fileId: `old_${index}`, fileName: `agentcrm/agentcrm-backup-${stamp}.db`, bytes: Buffer.from('x') });
      writeFileSync(path.join(autoDirectory, `agentcrm-backup-${stamp}.db`), 'x');
    });
    stub.files.push({ fileId: 'other', fileName: 'agentcrm/notes.txt', bytes: Buffer.from('x') });
    writeFileSync(path.join(autoDirectory, 'keepme.txt'), 'x');
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(true);
    expect(result?.error).toBeUndefined();
    // keep is 3: the new upload plus the two newest old ones.
    const remote = stub.files.map((file) => file.fileName).sort();
    expect(remote).toEqual([
      'agentcrm/agentcrm-backup-20260304T000000Z.db',
      'agentcrm/agentcrm-backup-20260305T000000Z.db',
      stub.uploads[0]!.fileName,
      'agentcrm/notes.txt',
    ].sort());
    expect(readdirSync(autoDirectory).sort()).toEqual(
      ['agentcrm-backup-20260304T000000Z.db', 'agentcrm-backup-20260305T000000Z.db', path.basename(stub.uploads[0]!.fileName), 'keepme.txt'].sort(),
    );
  });

  it('counts a prune failure as a success and records the sentence', async () => {
    for (let index = 0; index < 4; index += 1) {
      stub.files.push({ fileId: `old_${index}`, fileName: `agentcrm/agentcrm-backup-2026030${index + 1}T000000Z.db`, bytes: Buffer.from('x') });
    }
    stub.failDeletes = true;
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(true);
    expect(result?.error).toContain('uploaded');
    const saved = settings();
    expect(saved.lastSuccessAt).not.toBeNull();
    expect(saved.lastResult).toMatchObject({ ok: true, error: expect.stringContaining('could not remove old uploads') });
    expect(saved.lastResult?.error).not.toContain(stubApplicationKey);
  });

  it('retries once with a fresh upload URL on an expired token or a 5xx', async () => {
    stub.uploadFailures = [401];
    expect((await runBackupIfDue(ctx))?.ok).toBe(true);
    expect(stub.uploadUrlRequests).toBe(2);
    expect(stub.authorizations).toBe(1);
    expect(stub.uploads[0]!.authorization).toBe('upload-token-2');
    stub.reset();
    resetBackupThrottle();
    env.db.prepare('DELETE FROM connector').run();
    await configureBackblazeConnector(ctx, { keyId: stubKeyId, applicationKey: stubApplicationKey, bucketName: stubBucketName });
    stub.uploadFailures = [503];
    expect((await runBackupIfDue(ctx))?.ok).toBe(true);
    expect(stub.uploadUrlRequests).toBe(2);
  });

  it('gives up after one retry, records the failure, and keeps the connector connected', async () => {
    stub.uploadFailures = [503, 503];
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(false);
    expect(stub.uploadUrlRequests).toBe(2);
    expect(getConnector(env.db, env.workspaceId, 'backblaze')!.status).toBe('connected');
    expect(settings().lastResult).toMatchObject({ ok: false, error: expect.any(String) });
    expect(settings().lastSuccessAt).toBeNull();
    expect(settings().lastAttemptAt).not.toBeNull();
    expect(existsSync(autoDirectory) ? readdirSync(autoDirectory) : []).toEqual([]);
    const audit = env.db.prepare("SELECT detail FROM audit_event WHERE action = 'backup.run'").get() as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ ok: false, error: expect.any(String) });
    expect(audit.detail).not.toContain(stubApplicationKey);
  });

  it('flips the connector to error when B2 rejects the key at authorize', async () => {
    stub.rejectAuthorize = true;
    const result = await runBackupIfDue(ctx);
    expect(result?.ok).toBe(false);
    const connector = getConnector(env.db, env.workspaceId, 'backblaze')!;
    expect(connector.status).toBe('error');
    expect(connector.statusMessage).toContain('Backblaze rejected the saved application key');
    expect(connector.settings.lastResult?.ok).toBe(false);
    expect(connector.settings.runRequestedAt).toBeNull();
    expect(JSON.stringify(connector)).not.toContain(stubApplicationKey);
    const rows = env.db.prepare('SELECT detail FROM audit_event').all() as { detail: string }[];
    for (const row of rows) expect(row.detail).not.toContain(stubApplicationKey);
  });
});
