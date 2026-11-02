import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageRoot } from '../src/paths.js';

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

describe('writing rules', () => {
  const sources = ['src', 'test', 'migrations'].flatMap((folder) => files(path.join(packageRoot, folder)));
  const emDash = String.fromCharCode(0x2014);

  it('has no em dashes in source, tests, or migrations', () => {
    const offenders = sources.filter((file) => readFileSync(file, 'utf8').includes(emDash));
    expect(offenders).toEqual([]);
  });

  it('has no absolute local paths', () => {
    const marker = ['', 'Users', ''].join('/');
    const offenders = sources.filter((file) => readFileSync(file, 'utf8').includes(marker));
    expect(offenders).toEqual([]);
  });
});
