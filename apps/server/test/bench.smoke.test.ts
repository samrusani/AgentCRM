import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageRoot } from '../src/paths.js';

// Runs the whole benchmark at the small scale. Slow compared to the rest of the suite, so it only runs on request:
// AGENTCRM_BENCH_SMOKE=1 npm run test --prefix apps/server -- bench.smoke
describe.skipIf(!process.env.AGENTCRM_BENCH_SMOKE)('benchmark smoke run', () => {
  it('seeds, serves, measures, reports, and cleans up at --scale=small', { timeout: 180_000 }, () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', path.join('bench', 'bench.ts'), '--scale=small'], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 170_000,
    });
    expect(output).toContain('| Measurement | Samples | p50 (ms) | p95 (ms) | p99 (ms) | p95 budget (ms) | Result |');
    const rows = output.split('\n').filter((line) => /\| (pass|miss) \|$/.test(line));
    expect(rows).toHaveLength(9);
    expect(output).not.toMatch(/\| error:/);
    expect(output).toContain('Cold start');
    expect(output).toContain('Database file size');
    expect(output).toContain('Server process RSS');
    expect(output).not.toContain(['', 'Users', ''].join('/'));
    const scratch = path.join(packageRoot, 'bench', '.scratch');
    if (existsSync(scratch)) expect(readdirSync(scratch)).toEqual([]);
  });
});
