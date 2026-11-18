import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureWorkspace } from '../src/actions/index.js';
import { backupDatabase, fileTimestamp, restoreDatabase } from '../src/backup.js';
import { openDatabase } from '../src/db.js';
import { acquireDatabaseLock } from '../src/databaseLock.js';
import { startServer } from '../src/server.js';
import { packageRoot } from '../src/paths.js';
import { seedDatabase } from '../src/seed/seed.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-backup-'));
const sourcePath = path.join(root, 'source', 'agentcrm.db');
const fixedNow = () => new Date('2026-03-01T09:00:00.000Z');
let sourceDb: ReturnType<typeof openDatabase>;
let peopleInSource = 0;
let health: http.Server;
let healthPort = 0;

const countPeople = (file: string): number => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM person').get() as { n: number }).n);
  } finally {
    db.close();
  }
};

beforeAll(async () => {
  sourceDb = openDatabase(sourcePath);
  seedDatabase(sourceDb, { now: new Date('2026-03-01T12:00:00.000Z') });
  peopleInSource = Number((sourceDb.prepare('SELECT COUNT(*) AS n FROM person').get() as { n: number }).n);
  health = http.createServer((request, response) => {
    if (request.url === '/api/health') {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => health.listen(0, '127.0.0.1', resolve));
  healthPort = (health.address() as AddressInfo).port;
});

afterAll(async () => {
  sourceDb.close();
  await new Promise((resolve) => health.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

function makeLiveDatabase(name: string): string {
  const directory = path.join(root, name);
  const databasePath = path.join(directory, 'agentcrm.db');
  const db = openDatabase(databasePath);
  ensureWorkspace(db);
  db.close();
  return databasePath;
}

describe('backup', () => {
  it('writes a readable snapshot of a live database and prints the path, size, and a secrets warning', async () => {
    const directory = path.join(root, 'out');
    const result = await backupDatabase({ databasePath: sourcePath, directory, now: fixedNow });
    expect(path.basename(result.path)).toBe('agentcrm-backup-20260301T090000Z.db');
    expect(fileTimestamp(fixedNow())).toBe('20260301T090000Z');
    expect(result.bytes).toBe(statSync(result.path).size);
    expect(result.message).toContain(result.path.startsWith(root) ? result.path : 'agentcrm-backup-20260301T090000Z.db');
    expect(result.message).toContain('connector tokens included');
    expect(countPeople(result.path)).toBe(peopleInSource);
    expect(peopleInSource).toBeGreaterThan(0);
  });

  it('never overwrites an existing backup', async () => {
    const directory = path.join(root, 'out');
    const first = path.join(directory, 'agentcrm-backup-20260301T090000Z.db');
    const before = readFileSync(first);
    const second = await backupDatabase({ databasePath: sourcePath, directory, now: fixedNow });
    expect(second.path).not.toBe(first);
    expect(path.basename(second.path)).toBe('agentcrm-backup-20260301T090000Z-2.db');
    expect(readFileSync(first).equals(before)).toBe(true);
    expect(readdirSync(directory)).toHaveLength(2);
  });

  it('defaults to a backups folder next to the database', async () => {
    const result = await backupDatabase({ databasePath: sourcePath, now: fixedNow });
    expect(path.dirname(result.path)).toBe(path.join(path.dirname(sourcePath), 'backups'));
  });

  it('refuses clearly when there is no database or the target is a file', async () => {
    await expect(backupDatabase({ databasePath: path.join(root, 'missing', 'agentcrm.db') })).rejects.toThrow(/no database to back up/);
    const file = path.join(root, 'plain.txt');
    writeFileSync(file, 'x');
    await expect(backupDatabase({ databasePath: sourcePath, directory: file })).rejects.toThrow(/is a file, not a folder/);
  });
});

describe('restore', () => {
  let snapshot = '';

  beforeAll(async () => {
    snapshot = (await backupDatabase({ databasePath: sourcePath, directory: path.join(root, 'snapshots'), now: fixedNow })).path;
  });

  it('refuses to replace a database open on a dynamically assigned HTTP port', async () => {
    const live = makeLiveDatabase('live-running');
    const server = await startServer({ databasePath: live, port: 0 });
    try {
      const before = readFileSync(live);
      await expect(restoreDatabase({ snapshot, databasePath: live })).rejects.toThrow(/This database is open/);
      expect(readFileSync(live).equals(before)).toBe(true);
    } finally {
      await server.close();
    }
    await expect(restoreDatabase({ snapshot, databasePath: live })).resolves.toMatchObject({ moved: expect.any(Array) });
  });

  it('refuses to replace a database open by a separate stdio MCP process', async () => {
    const live = makeLiveDatabase('live-mcp');
    const client = new Client({ name: 'restore-lock-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), 'mcp'],
      cwd: packageRoot,
      env: { ...(process.env as Record<string, string>), AGENTCRM_DB: live },
      stderr: 'ignore',
    });
    await client.connect(transport);
    try {
      await expect(restoreDatabase({ snapshot, databasePath: live })).rejects.toThrow(/This database is open/);
      expect(countPeople(live)).toBe(0);
    } finally {
      await client.close();
    }
    await expect(restoreDatabase({ snapshot, databasePath: live })).resolves.toMatchObject({ moved: expect.any(Array) });
  });

  it('allows shared openers but blocks openers and other restores while restore holds the lock', async () => {
    const live = makeLiveDatabase('live-locked');
    const a = openDatabase(live);
    const b = openDatabase(live);
    try {
      await expect(restoreDatabase({ snapshot, databasePath: live })).rejects.toThrow(/This database is open/);
    } finally {
      a.close();
      b.close();
    }
    const release = acquireDatabaseLock(live, 'exclusive');
    try {
      expect(() => openDatabase(live)).toThrow(/A restore is running/);
      await expect(backupDatabase({ databasePath: live })).rejects.toThrow(/A restore is running/);
      await expect(restoreDatabase({ snapshot, databasePath: live })).rejects.toThrow(/another restore is running/);
    } finally {
      release();
    }
  });

  it('refuses a snapshot with a migration this build does not know, naming it', async () => {
    const live = makeLiveDatabase('live-newer');
    const newer = path.join(root, 'newer.db');
    const db = new Database(snapshot);
    await db.backup(newer);
    db.close();
    const edit = new Database(newer);
    edit.prepare("INSERT INTO migrations (name, applied_at) VALUES ('999_from_the_future.sql', '2030-01-01T00:00:00.000Z')").run();
    edit.close();
    await expect(restoreDatabase({ snapshot: newer, databasePath: live })).rejects.toThrow(
      /newer version of AgentCRM.*999_from_the_future\.sql/,
    );
    expect(countPeople(live)).toBe(0);
    expect(readdirSync(path.dirname(live)).filter((name) => name.includes('pre-restore'))).toEqual([]);
  });

  it('refuses files that are not AgentCRM databases', async () => {
    const live = makeLiveDatabase('live-bad');
    const text = path.join(root, 'notes.txt');
    writeFileSync(text, 'not a database, just some text that is longer than a header would be.'.repeat(5));
    await expect(restoreDatabase({ snapshot: text, databasePath: live })).rejects.toThrow(/not an AgentCRM database|cannot be opened/);
    const other = path.join(root, 'other.db');
    const db = new Database(other);
    db.exec('CREATE TABLE things (id INTEGER)');
    db.close();
    await expect(restoreDatabase({ snapshot: other, databasePath: live })).rejects.toThrow(/is not an AgentCRM database/);
    await expect(restoreDatabase({ snapshot: path.join(root, 'nope.db'), databasePath: live })).rejects.toThrow(/Cannot read/);
    await expect(restoreDatabase({ snapshot: live, databasePath: live })).rejects.toThrow(/live database/);
  });

  it('moves the current files aside and swaps the snapshot in', async () => {
    const liveDirectory = path.join(root, 'live-ok');
    const live = path.join(liveDirectory, 'agentcrm.db');
    const db = openDatabase(live);
    ensureWorkspace(db);
    db.prepare("INSERT INTO person (id, created_at, workspace_id, first_name, updated_at) SELECT 'per_marker000', '2026-03-01T00:00:00.000Z', id, 'Marker', '2026-03-01T00:00:00.000Z' FROM workspace").run();
    db.close();
    // Stand in for the files a crashed server leaves behind.
    writeFileSync(`${live}-wal`, 'wal');
    writeFileSync(`${live}-shm`, 'shm');
    const result = await restoreDatabase({ snapshot, databasePath: live, now: fixedNow });

    const asideDb = path.join(liveDirectory, 'agentcrm.pre-restore-20260301T090000Z.db');
    expect(existsSync(asideDb)).toBe(true);
    expect(result.moved.map((entry) => path.basename(entry.to))).toContain('agentcrm.pre-restore-20260301T090000Z.db');
    expect(result.message).toContain('Moved the previous database aside');
    expect(result.message).toContain('agentcrm.pre-restore-20260301T090000Z.db');
    expect(countPeople(live)).toBe(peopleInSource);
    expect(readFileSync(`${asideDb}-wal`, 'utf8')).toBe('wal');
    expect(readFileSync(`${asideDb}-shm`, 'utf8')).toBe('shm');
    expect(statSync(asideDb).size).toBeGreaterThan(0);
    expect(result.moved).toHaveLength(3);
    expect(existsSync(`${live}-wal`)).toBe(false);
    expect(existsSync(`${live}-shm`)).toBe(false);

    // The restored database opens with the normal path and is current.
    const reopened = openDatabase(live);
    expect(Number((reopened.prepare('SELECT COUNT(*) AS n FROM person').get() as { n: number }).n)).toBe(peopleInSource);
    reopened.close();
  });

  it('works when there is no current database', async () => {
    const live = path.join(root, 'live-empty', 'agentcrm.db');
    const result = await restoreDatabase({ snapshot, databasePath: live });
    expect(result.moved).toEqual([]);
    expect(result.message).toContain('no previous database');
    expect(countPeople(live)).toBe(peopleInSource);
  });
});

describe('crm backup and crm restore', () => {
  function crm(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), ...args],
        { cwd: packageRoot, env: { ...process.env, ...env } },
        (error, stdout, stderr) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr }),
      );
    });
  }

  it('backs up and restores from the command line while an unrelated service answers on the configured port', async () => {
    const directory = path.join(root, 'cli-backups');
    const backup = await crm(['backup', directory], { AGENTCRM_DB: sourcePath });
    expect(backup.code).toBe(0);
    expect(backup.out).toContain('Backed up the database to');
    expect(backup.out).toContain('connector tokens included');
    const file = path.join(directory, readdirSync(directory)[0]!);
    expect(countPeople(file)).toBe(peopleInSource);

    const live = makeLiveDatabase('cli-live');
    const open = openDatabase(live);
    try {
      const refused = await crm(['restore', file], { AGENTCRM_DB: live, AGENTCRM_PORT: String(healthPort) });
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('Close the desktop app, API server, and MCP sessions');
      expect(countPeople(live)).toBe(0);
    } finally {
      open.close();
    }

    const restored = await crm(['restore', file], { AGENTCRM_DB: live, AGENTCRM_PORT: String(healthPort) });
    expect(restored.code).toBe(0);
    expect(restored.out).toContain('Restored the database from');
    expect(countPeople(live)).toBe(peopleInSource);

    const usage = await crm(['restore'], { AGENTCRM_DB: live });
    expect(usage.code).toBe(2);
  });
});
