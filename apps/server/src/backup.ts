import Database from 'better-sqlite3';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
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

  // Reserve the file name first with an exclusive create, so two backups in the same second never share a file.
  const stamp = fileTimestamp((options.now ?? (() => new Date()))());
  let target = '';
  for (let attempt = 1; ; attempt += 1) {
    target = path.join(directory, `agentcrm-backup-${stamp}${attempt === 1 ? '' : `-${attempt}`}.db`);
    try {
      closeSync(openSync(target, 'wx', 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw refuse(`Cannot write a backup in ${shown(directory)}: ${(error as Error).message}`);
      }
    }
  }

  const source = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(target);
  } catch (error) {
    rmSync(target, { force: true });
    throw refuse(`The backup failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    source.close();
  }
  // A snapshot is one self contained file. Rollback journal mode keeps -wal and -shm files from appearing beside it
  // when it is opened later. The server switches the database back to WAL when it opens the restored file.
  const finished = new Database(target);
  try {
    finished.pragma('journal_mode = DELETE');
  } finally {
    finished.close();
  }
  if (process.platform !== 'win32') chmodSync(target, 0o600);
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
  port: number;
  now?: () => Date;
  // Tests shorten the health check timeout.
  healthTimeoutMs?: number;
}

export interface RestoreResult {
  moved: { from: string; to: string }[];
  message: string;
}

async function serverAnswers(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

// Checks the snapshot is an AgentCRM database that this build can open, and returns the migrations it has applied.
function inspectSnapshot(snapshot: string): string[] {
  let db: Database.Database;
  try {
    db = new Database(snapshot, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw refuse(`${shown(snapshot)} cannot be opened as a database: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    let names: string[];
    try {
      const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
      if (!hasTable('migrations') || !hasTable('workspace')) {
        throw refuse(`${shown(snapshot)} is not an AgentCRM database. Nothing was changed.`);
      }
      names = (db.prepare('SELECT name FROM migrations ORDER BY name').all() as { name: string }[]).map((row) => row.name);
      const check = db.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw refuse(`${shown(snapshot)} failed the integrity check (${String(check)}). Nothing was changed.`);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw refuse(`${shown(snapshot)} is not an AgentCRM database: ${error instanceof Error ? error.message : String(error)}`);
    }
    return names;
  } finally {
    db.close();
  }
}

// Replaces the local database with a snapshot. Safety order: server check, snapshot check, move aside, copy in.
export async function restoreDatabase(options: RestoreOptions): Promise<RestoreResult> {
  const { databasePath } = options;
  const snapshot = resolveUserPath(options.snapshot);
  if (databasePath === ':memory:') throw refuse('Restore needs a database file, not an in memory database.');

  if (!existsSync(snapshot) || !statSync(snapshot).isFile()) {
    throw refuse(`Cannot read ${shown(snapshot)}. Check the path to the backup file.`);
  }
  if (path.resolve(databasePath) === snapshot) {
    throw refuse('That file is the live database. Give a backup file made by "crm backup".');
  }

  if (await serverAnswers(options.port, options.healthTimeoutMs ?? 1000)) {
    throw refuse(`The AgentCRM server is running on port ${options.port}. Stop it first, then restore. Nothing was changed.`);
  }

  const known = new Set(listMigrationFiles());
  const unknown = inspectSnapshot(snapshot).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw refuse(
      `This backup comes from a newer version of AgentCRM. It has migrations this version does not know: ${unknown.join(', ')}. Update AgentCRM, then restore. Nothing was changed.`,
    );
  }

  const parsed = path.parse(databasePath);
  const stamp = fileTimestamp((options.now ?? (() => new Date()))());
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
  const putBack = () => {
    for (const { from, to } of moved.reverse()) renameSync(to, from);
  };
  try {
    for (const [from, to] of pairs) {
      if (!existsSync(from)) continue;
      renameSync(from, to);
      moved.push({ from, to });
    }
    mkdirSync(parsed.dir, { recursive: true });
    copyFileSync(snapshot, databasePath);
    if (process.platform !== 'win32') chmodSync(databasePath, 0o600);
  } catch (error) {
    rmSync(databasePath, { force: true });
    putBack();
    throw refuse(`The restore failed and the previous database was put back: ${error instanceof Error ? error.message : String(error)}`);
  }

  const lines = [`Restored the database from ${shown(snapshot)}.`];
  if (moved.length === 0) lines.push('There was no previous database to move aside.');
  else {
    lines.push('Moved the previous database aside, nothing was deleted:');
    for (const { from, to } of moved) lines.push(`  ${path.basename(from)} -> ${path.basename(to)}`);
  }
  lines.push('Start the server to apply any pending migrations.');
  return { moved, message: lines.join('\n') };
}
