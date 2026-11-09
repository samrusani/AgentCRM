import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetBackupThrottle } from '../src/actions/index.js';
import { buildApp } from '../src/http/app.js';
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
let app: FastifyInstance;
let stub: Backblaze;
let restore: () => void;

beforeAll(async () => {
  stub = await startBackblazeStub();
  restore = useBackblazeStub(stub);
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterEach(() => {
  stub.reset();
  env.db.prepare('DELETE FROM connector').run();
  resetBackupThrottle();
});

afterAll(async () => {
  await app.close();
  await stub.close();
  restore();
  env.cleanup();
});

async function call(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, payload: payload as object | undefined, headers: { host: '127.0.0.1:4720' } });
  return { status: response.statusCode, text: response.body, body: response.body ? (JSON.parse(response.body) as Record<string, any>) : null };
}

const connect = (extra: Record<string, unknown> = {}) =>
  call('PUT', '/api/connectors/backblaze', { keyId: stubKeyId, applicationKey: stubApplicationKey, bucketName: stubBucketName, ...extra });

describe('backblaze connector', () => {
  it('connects with an unrestricted key, stores the bucket id, and masks the key', async () => {
    const created = await connect();
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'backblaze',
      status: 'connected',
      tokenMasked: '****1234',
      settings: {
        keyId: stubKeyId,
        bucketId: stubBucketId,
        bucketName: stubBucketName,
        keep: 14,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastResult: null,
        runRequestedAt: null,
      },
    });
    expect(created.text).not.toContain(stubApplicationKey);
    const stored = env.db.prepare("SELECT secret FROM connector WHERE kind = 'backblaze'").get() as { secret: string };
    expect(stored.secret).toBe(stubApplicationKey);
    const listed = await call('GET', '/api/connectors');
    expect(listed.text).not.toContain(stubApplicationKey);
    expect(listed.body!.items[0]).toMatchObject({ kind: 'backblaze', tokenMasked: '****1234' });
  });

  it('keeps the key and audit rows free of the application key', async () => {
    await connect();
    await call('PUT', '/api/connectors/backblaze', { keep: 5 });
    const rows = env.db.prepare('SELECT detail FROM audit_event').all() as { detail: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.detail).not.toContain(stubApplicationKey);
  });

  it('changes keep without calling B2, and validates the range', async () => {
    await connect();
    const before = stub.authorizations;
    const changed = await call('PUT', '/api/connectors/backblaze', { keep: 30 });
    expect(changed.status).toBe(200);
    expect(changed.body!.settings.keep).toBe(30);
    expect(stub.authorizations).toBe(before);
    for (const keep of [0, 366, 1.5, '7']) {
      expect((await call('PUT', '/api/connectors/backblaze', { keep })).status).toBe(400);
    }
    expect((await call('PUT', '/api/connectors/backblaze', {})).status).toBe(400);
  });

  it('refuses a first connect with missing fields', async () => {
    expect((await call('PUT', '/api/connectors/backblaze', { keep: 5 })).status).toBe(400);
    expect((await call('PUT', '/api/connectors/backblaze', { keyId: stubKeyId, applicationKey: stubApplicationKey })).status).toBe(400);
    expect((await call('PUT', '/api/connectors/backblaze', { keyId: stubKeyId, bucketName: stubBucketName })).status).toBe(400);
  });

  it('refuses a key B2 rejects without echoing it', async () => {
    const response = await connect({ applicationKey: 'K005wrongwrongwrongwrong' });
    expect(response.status).toBe(400);
    expect(response.text).not.toContain('wrongwrong');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM connector').get()).toEqual({ n: 0 });
  });

  it('uses the bucket of a restricted key and refuses a different name, naming both', async () => {
    stub.keys[0]!.bucket = { id: 'bkt_only', name: 'only-bucket' };
    const mismatch = await connect({ bucketName: 'other-bucket' });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body!.error.message).toContain('only-bucket');
    expect(mismatch.body!.error.message).toContain('other-bucket');
    const ok = await connect({ bucketName: 'only-bucket' });
    expect(ok.status).toBe(201);
    expect(ok.body!.settings).toMatchObject({ bucketId: 'bkt_only', bucketName: 'only-bucket' });
  });

  it('refuses a key that lacks capabilities and names the missing ones', async () => {
    stub.keys[0]!.capabilities = ['listFiles', 'readFiles'];
    const response = await connect();
    expect(response.status).toBe(400);
    expect(response.body!.error.message).toContain('writeFiles');
    expect(response.body!.error.message).toContain('deleteFiles');
    expect(response.body!.error.message).not.toContain('listFiles');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM connector').get()).toEqual({ n: 0 });
  });

  it('refuses a bucket name that does not exist with the server message', async () => {
    const response = await connect({ bucketName: 'no-such-bucket' });
    expect(response.status).toBe(400);
    expect(response.body!.error.message).toContain('Bucket no-such-bucket does not exist in this account.');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM connector').get()).toEqual({ n: 0 });
  });

  it('re-checks a changed bucket name against the saved key', async () => {
    await connect();
    stub.buckets.push({ id: 'bkt_second', name: 'second' });
    const changed = await call('PUT', '/api/connectors/backblaze', { bucketName: 'second' });
    expect(changed.status).toBe(200);
    expect(changed.body!.settings).toMatchObject({ bucketId: 'bkt_second', bucketName: 'second', lastResult: null });
    expect((await call('PUT', '/api/connectors/backblaze', { bucketName: 'missing' })).status).toBe(400);
  });

  it('removes the connector and touches nothing remote', async () => {
    expect((await call('DELETE', '/api/connectors/backblaze')).status).toBe(404);
    await connect();
    stub.files.push({ fileId: 'f1', fileName: 'agentcrm/agentcrm-backup-20260101T000000Z.db', bytes: Buffer.from('x') });
    const removed = await call('DELETE', '/api/connectors/backblaze');
    expect(removed.status).toBe(204);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM connector').get()).toEqual({ n: 0 });
    expect(stub.deletes).toEqual([]);
    expect(stub.files).toHaveLength(1);
  });

  it('queues a backup with 202 and refuses without a connector', async () => {
    const refused = await call('POST', '/api/backups/run');
    expect(refused.status).toBe(400);
    expect(refused.body!.error.code).toBe('validation');
    await connect();
    const accepted = await call('POST', '/api/backups/run');
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({ ok: true });
    const listed = await call('GET', '/api/connectors');
    expect(listed.body!.items[0].settings.runRequestedAt).toEqual(expect.any(String));
  });
});
