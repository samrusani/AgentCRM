import Database from 'better-sqlite3';
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';

export function canonicalDatabasePath(databasePath: string): string {
  const absolute = path.resolve(databasePath);
  // Resolve existing aliases, including a symlink in a parent of a database that has yet to be created.
  if (lstatSync(absolute, { throwIfNoEntry: false })) return realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonicalDatabasePath(parent), path.basename(absolute));
}

export function acquireDatabaseLock(databasePath: string, mode: 'shared' | 'exclusive'): () => void {
  const target = canonicalDatabasePath(databasePath);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat && stat.nlink > 1) throw new AppError('validation', 'Use a database file without hard links.');

  // A separate, empty SQLite file supplies OS locks without affecting the main database's WAL or transactions.
  // Never remove it. All processes must lock the same inode, and the OS releases a lock when its process exits.
  const lockPath = `${target}.lock.db`;
  closeSync(openSync(lockPath, 'a', 0o600));
  const lock = new Database(lockPath, { readonly: mode === 'shared', timeout: 0 });
  try {
    // BEGIN alone does not take a shared lock. The read takes it and the transaction holds it until close.
    lock.exec(mode === 'shared' ? 'BEGIN; SELECT name FROM sqlite_schema' : 'BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY') {
      throw new AppError('validation', mode === 'exclusive'
        ? 'This database is open or another restore is running. Close the desktop app, API server, and MCP sessions that use it, then try again.'
        : 'A restore is running for this database. Wait for it to finish, then try again.');
    }
    throw error;
  }
  return () => lock.close();
}

export function openLockedDatabase(databasePath: string, options: Database.Options = {}): Database.Database {
  if (databasePath === ':memory:') return new Database(databasePath, options);
  const target = canonicalDatabasePath(databasePath);
  const release = acquireDatabaseLock(target, 'shared');
  try {
    const db = new Database(target, options);
    const close = db.close.bind(db);
    db.close = () => {
      const result = close();
      release();
      return result;
    };
    return db;
  } catch (error) {
    release();
    throw error;
  }
}

export function restoreMarkerPath(databasePath: string): string {
  return `${canonicalDatabasePath(databasePath)}.restore-pending.db`;
}
