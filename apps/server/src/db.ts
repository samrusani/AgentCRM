import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { migrationsDirectory, resolveDatabasePath } from './paths.js';

export type Db = Database.Database;

export function openDatabase(databasePath: string = resolveDatabasePath()): Db {
  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  return db;
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

export function applyMigrations(db: Db): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(appliedMigrations(db));
  const applied: string[] = [];
  for (const file of listMigrationFiles()) {
    if (done.has(file)) continue;
    const sql = readFileSync(path.join(migrationsDirectory, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        new Date().toISOString(),
      );
    }).immediate();
    applied.push(file);
  }
  return applied;
}
