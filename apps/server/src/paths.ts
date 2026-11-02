import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Both src/ (tsx) and dist/ (tsc) sit one level below the package root.
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(packageRoot, '..', '..');
export const migrationsDirectory = path.join(packageRoot, 'migrations');

export function resolveDatabasePath(): string {
  const override = process.env.AGENTCRM_DB;
  if (override && override.length > 0) {
    return override === ':memory:' ? override : path.resolve(override);
  }
  return path.join(repoRoot, 'data', 'agentcrm.db');
}

// The health endpoint and the CLI never print absolute paths from the user's machine.
export function displayDatabasePath(absolutePath: string): string {
  if (absolutePath === ':memory:') return absolutePath;
  const relative = path.relative(repoRoot, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return path.basename(absolutePath);
  return relative.split(path.sep).join('/');
}
