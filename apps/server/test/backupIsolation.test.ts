import { readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { backupNamespace, configureBackblazeConnector, requestBackup, runBackupIfDue } from '../src/actions/backblazeConnector.js';
import { openDatabase } from '../src/db.js';
import type { B2FileVersion } from '../src/providers/backblaze.js';
import { createTestEnvironment } from './helpers.js';

const bucket = vi.hoisted(() => new Map<string, string>());

vi.mock('../src/providers/backblaze.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/backblaze.js')>()),
  authorizeAccount: async () => ({
    bucketId: 'fixture-bucket-id', bucketName: 'fixture-bucket',
    capabilities: ['writeFiles', 'listFiles', 'deleteFiles'],
  }),
  getUploadUrl: async () => ({ uploadUrl: 'https://example.com/upload', authorizationToken: 'fixture-auth' }),
  uploadFile: async (_target: unknown, name: string) => {
    const fileId = String(bucket.size + 1);
    bucket.set(name, fileId);
    return { fileId };
  },
  listFileNames: async (_auth: unknown, _id: string, prefix: string) =>
    [...bucket].filter(([name]) => name.startsWith(prefix)).map(([fileName, fileId]) => ({ fileName, fileId })),
  deleteFileVersion: async (_auth: unknown, { fileName }: B2FileVersion) => { bucket.delete(fileName); },
}));

it('prunes local and remote history only for the current database', async () => {
  const env = createTestEnvironment();
  const directory = path.dirname(env.databasePath);
  try {
    await configureBackblazeConnector(env.ctx, {
      bucketName: 'fixture-bucket', keep: 1, keyId: 'fixture-key-id', applicationKey: 'fixture-key-value',
    });
    const first = await runBackupIfDue(env.ctx);
    expect(first?.ok).toBe(true);
    const originalName = first!.fileName!;
    const originalDirectory = path.join(directory, 'backups', 'auto', backupNamespace(env.databasePath));

    // A copy has the same workspace and connector settings but gets its own backup identity.
    const copyPath = path.join(directory, 'copy.db');
    await env.db.backup(copyPath);
    const copy = openDatabase(copyPath);
    try {
      const context = { ...env.ctx, db: copy };
      bucket.set('agentcrm/agentcrm-backup-20200101T000000Z.db', 'legacy');
      requestBackup(context);
      const second = await runBackupIfDue(context);
      expect(second?.ok).toBe(true);
      const copyDirectory = path.join(directory, 'backups', 'auto', backupNamespace(copyPath));
      expect(copyDirectory).not.toBe(originalDirectory);
      expect(path.basename(second!.fileName!)).toBe(path.basename(originalName));

      env.advance(1000);
      requestBackup(context);
      const replacement = await runBackupIfDue(context);
      expect(replacement?.ok).toBe(true);
      expect([...bucket.keys()].sort()).toEqual([originalName, replacement!.fileName!, 'agentcrm/agentcrm-backup-20200101T000000Z.db'].sort());
      expect(readdirSync(originalDirectory)).toEqual([path.basename(originalName)]);
      expect(readdirSync(copyDirectory)).toEqual([path.basename(replacement!.fileName!)]);
    } finally {
      copy.close();
    }
  } finally {
    env.cleanup();
  }
});
