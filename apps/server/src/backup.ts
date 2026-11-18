import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acquireDatabaseLock, canonicalDatabasePath, openLockedDatabase, restoreMarkerPath } from './databaseLock.js';
import { AppError } from './errors.js';
import { listMigrationFiles } from './db.js';
import { displayDatabasePath, repoRoot } from './paths.js';

// The shape of a timestamp in file names: 20260301T090000Z, UTC, sortable, safe on every file system.
export function fileTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// A path for the user to read. Inside the repository it is relative to the repository root.
function shown(target: string): string {
  const relative = path.relative(repoRoot, target);
  return relative.startsWith('..') || path.isAbsolute(relative) ? target : displayDatabasePath(target);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function refuse(message: string): AppError {
  return new AppError('validation', message);
}

export interface BackupOptions {
  databasePath: string;
  // Defaults to a "backups" folder next to the database, which is data/backups for the default database.
  directory?: string;
  now?: () => Date;
}

export interface BackupResult {
  path: string;
  displayPath: string;
  bytes: number;
  message: string;
}

// Relative paths given to the CLI resolve against the folder the user ran npm from (INIT_CWD), not the
// server package, so "npm run restore -- data/backups/x.db" works from the repository root.
export function resolveUserPath(given: string): string {
  if (path.isAbsolute(given)) return given;
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), given);
}

// Writes a consistent snapshot with the SQLite online backup API. Safe while the server runs, because the source is
// read through a read only connection and the snapshot is a separate file. An existing file is never overwritten.
export async function backupDatabase(options: BackupOptions): Promise<BackupResult> {
  const { databasePath } = options;
  if (databasePath === ':memory:' || !existsSync(databasePath)) {
    throw refuse('There is no database to back up yet. Run "npm run seed" or start the server once.');
  }
  const directory = options.directory
    ? resolveUserPath(options.directory)
    : path.resolve(path.join(path.dirname(databasePath), 'backups'));
  if (existsSync(directory) && !statSync(directory).isDirectory()) {
    throw refuse(`${shown(directory)} is a file, not a folder. Give a folder for the backup.`);
  }
  const created = mkdirSync(directory, { recursive: true }) !== undefined;
  if (created && process.platform !== 'win32') {
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Best effort, as for the database folder.
    }
  }

  const stagingDirectory = mkdtempSync(path.join(directory, '.agentcrm-backup-'));
  const staged = path.join(stagingDirectory, 'snapshot.db');
  const stamp = fileTimestamp((options.now ?? (() => new Date()))());
  let target: string;
  try {
    const source = openLockedDatabase(databasePath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(staged);
    } finally {
      source.close();
    }

    // Publish only a self-contained snapshot. A restore cannot open a half-written backup.
    const finished = new Database(staged);
    try {
      finished.pragma('journal_mode = DELETE');
    } finally {
      finished.close();
    }
    if (process.platform !== 'win32') chmodSync(staged, 0o600);
    for (let attempt = 1; ; attempt += 1) {
      target = path.join(directory, `agentcrm-backup-${stamp}${attempt === 1 ? '' : `-${attempt}`}.db`);
      try {
        linkSync(staged, target);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  } catch (error) {
    throw refuse(`The backup failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
  const bytes = statSync(target).size;
  return {
    path: target,
    displayPath: shown(target),
    bytes,
    message: [
      `Backed up the database to ${shown(target)} (${formatSize(bytes)}).`,
      'The backup holds everything, connector tokens included, so keep it private.',
    ].join('\n'),
  };
}

export interface RestoreOptions {
  snapshot: string;
  databasePath: string;
  now?: () => Date;
}

export interface RestoreResult {
  moved: { from: string; to: string }[];
  message: string;
}

// An AgentCRM snapshot must be readable, intact, and use migrations this build knows.
function inspectSnapshot(db: Database.Database, snapshot: string): void {
  try {
    const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    if (!hasTable('migrations') || !hasTable('workspace')) {
      throw refuse(`${shown(snapshot)} is not an AgentCRM database. Nothing was changed.`);
    }
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw refuse(`${shown(snapshot)} failed the integrity check (${String(check)}). Nothing was changed.`);
    const known = new Set(listMigrationFiles());
    const rows = db.prepare('SELECT name FROM migrations ORDER BY name').all() as { name: string }[];
    const unknown = rows.map((row) => row.name).filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw refuse(
        `This backup comes from a newer version of AgentCRM. It has migrations this version does not know: ${unknown.join(', ')}. Update AgentCRM, then restore. Nothing was changed.`,
      );
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw refuse(`${shown(snapshot)} is not an AgentCRM database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Hold the target lock until the snapshot and its mail hold marker are in place.
export async function restoreDatabase(options: RestoreOptions): Promise<RestoreResult> {
  if (options.databasePath === ':memory:') throw refuse('Restore needs a database file, not an in memory database.');
  const input = resolveUserPath(options.snapshot);
  if (!existsSync(input) || !statSync(input).isFile()) {
    throw refuse(`Cannot read ${shown(input)}. Check the path to the backup file.`);
  }
  const snapshot = canonicalDatabasePath(input);
  const databasePath = canonicalDatabasePath(options.databasePath);
  if (databasePath === snapshot) {
    throw refuse('That file is the live database. Give a backup file made by "crm backup".');
  }

  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const release = acquireDatabaseLock(databasePath, 'exclusive');
  try {
    const releaseSnapshot = acquireDatabaseLock(snapshot, 'exclusive');
    try {
      const source = new Database(snapshot, { readonly: true, fileMustExist: true });
      try {
        inspectSnapshot(source, snapshot);
        return await installSnapshot(databasePath, source, options.now?.() ?? new Date());
      } finally {
        source.close();
      }
    } finally {
      releaseSnapshot();
    }
  } finally {
    release();
  }
}

async function installSnapshot(databasePath: string, snapshot: Database.Database, now: Date): Promise<RestoreResult> {
  const parsed = path.parse(databasePath);
  const stamp = fileTimestamp(now);
  let asideBase = path.join(parsed.dir, `${parsed.name}.pre-restore-${stamp}`);
  for (let attempt = 2; existsSync(`${asideBase}.db`); attempt += 1) {
    asideBase = path.join(parsed.dir, `${parsed.name}.pre-restore-${stamp}-${attempt}`);
  }
  const moved: { from: string; to: string }[] = [];
  const pairs: [string, string][] = [
    [databasePath, `${asideBase}.db`],
    [`${databasePath}-wal`, `${asideBase}.db-wal`],
    [`${databasePath}-shm`, `${asideBase}.db-shm`],
  ];
  const token = randomUUID();
  const staged = `${databasePath}.restore-${token}.db`;
  const marker = restoreMarkerPath(databasePath);
  const stagedMarker = `${staged}.restore-pending.db`;
  try {
    writeFileSync(staged, '', { flag: 'wx', mode: 0o600 });
    await snapshot.backup(staged);
    if (process.platform !== 'win32') chmodSync(staged, 0o600);
    writeFileSync(stagedMarker, token, { flag: 'wx', mode: 0o600, flush: true });
    renameSync(stagedMarker, marker);
    for (const [from, to] of pairs) {
      if (!existsSync(from)) continue;
      renameSync(from, to);
      moved.push({ from, to });
    }
    renameSync(staged, databasePath);
  } catch (error) {
    for (const { from, to } of moved.reverse()) renameSync(to, from);
    throw refuse(`The restore could not install the snapshot: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(staged, { force: true });
    rmSync(stagedMarker, { force: true });
  }

  const lines = [`Restored the database from ${shown(snapshot.name)}.`];
  if (moved.length === 0) lines.push('There was no previous database to move aside.');
  else {
    lines.push('Moved the previous database aside, nothing was deleted:');
    for (const { from, to } of moved) lines.push(`  ${path.basename(from)} -> ${path.basename(to)}`);
  }
  lines.push('At startup, AgentCRM holds restored outbound messages and stops restored follow-up rules.');
  lines.push('Check the sending mailbox before preparing any replacement sends for fresh approval.');
  return { moved, message: lines.join('\n') };
}
