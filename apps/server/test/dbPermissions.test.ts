import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';

describe('database file permissions', () => {
  it.skipIf(process.platform === 'win32')('limits the database, its journal files, and a new data folder to the owner', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-perms-'));
    const directory = path.join(root, 'data');
    const databasePath = path.join(directory, 'agentcrm.db');
    const db = openDatabase(databasePath);
    try {
      db.prepare("INSERT INTO workspace (id, created_at, name, template) VALUES ('wsp_permissions', '2026-03-01T00:00:00.000Z', 'Permissions', 'startup-fundraising')").run();
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${databasePath}${suffix}`)) expect(statSync(`${databasePath}${suffix}`).mode & 0o777).toBe(0o600);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
