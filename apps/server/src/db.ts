import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { backfillProfileUrls } from './actions/profileUrls.js';
import { migrationsDirectory, repoRoot, resolveDatabasePath } from './paths.js';

export type Db = Database.Database;

export function openDatabase(databasePath: string = resolveDatabasePath()): Db {
  let directoryCreated = false;
  if (databasePath !== ':memory:') {
    directoryCreated = mkdirSync(path.dirname(databasePath), { recursive: true }) !== undefined;
  }
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  if (databasePath !== ':memory:') restrictPermissions(databasePath, directoryCreated);
  return db;
}

// The database holds connector secrets (the Apify token and the Anthropic key) in plain text, so only the owner
// may read it. Best effort: some file systems do not support modes, and Windows ignores them. The directory is tightened only
// when this call created it or it is the default data directory, never a shared folder the user chose.
function restrictPermissions(databasePath: string, directoryCreated: boolean): void {
  if (process.platform === 'win32') return;
  const directory = path.dirname(path.resolve(databasePath));
  const targets: [string, number][] = [];
  if (directoryCreated || directory === path.join(repoRoot, 'data')) targets.push([directory, 0o700]);
  for (const suffix of ['', '-wal', '-shm']) targets.push([`${databasePath}${suffix}`, 0o600]);
  for (const [target, mode] of targets) {
    try {
      if (existsSync(target)) chmodSync(target, mode);
    } catch {
      // Keep going. The app works without tighter modes.
    }
  }
}

export function listMigrationFiles(): string[] {
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
}

export function appliedMigrations(db: Db): string[] {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'")
    .get();
  if (!table) return [];
  return (db.prepare('SELECT name FROM migrations ORDER BY name').all() as { name: string }[]).map(
    (row) => row.name,
  );
}

// Data work a migration cannot do in plain SQL runs right after its file, in the same transaction.
const migrationHooks: Record<string, (db: Db) => void> = {
  '018_profile_urls.sql': backfillProfileUrls,
};

export function applyMigrations(db: Db): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(appliedMigrations(db));
  const applied: string[] = [];
  for (const file of listMigrationFiles()) {
    if (done.has(file)) continue;
    const sql = readFileSync(path.join(migrationsDirectory, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      migrationHooks[file]?.(db);
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        new Date().toISOString(),
      );
    }).immediate();
    applied.push(file);
  }
  return applied;
}
