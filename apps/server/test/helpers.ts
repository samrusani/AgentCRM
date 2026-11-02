import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, ensureWorkspace, type ActionContext } from '../src/actions/index.js';
import { openDatabase, type Db } from '../src/db.js';
import { EventBus } from '../src/events.js';
import { processAllJobs, processJobs } from '../src/jobs/worker.js';
import { getRun } from '../src/queries/runs.js';

export interface TestEnvironment {
  db: Db;
  bus: EventBus;
  ctx: ActionContext;
  workspaceId: string;
  databasePath: string;
  advance: (milliseconds: number) => void;
  cleanup: () => void;
}

// One temporary database per test file. The clock only moves when a test advances it.
export function createTestEnvironment(): TestEnvironment {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-test-'));
  const databasePath = path.join(directory, 'test.db');
  const db = openDatabase(databasePath);
  const bus = new EventBus();
  let clock = Date.parse('2026-03-01T09:00:00.000Z');
  const now = (): string => {
    clock += 1;
    return new Date(clock).toISOString();
  };
  const workspace = ensureWorkspace(db, { now });
  const ctx = createContext(db, workspace.id, { bus, now });
  return {
    db,
    bus,
    ctx,
    workspaceId: workspace.id,
    databasePath,
    advance: (milliseconds) => {
      clock += milliseconds;
    },
    cleanup: () => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function insertSecondWorkspace(db: Db): string {
  const id = 'wsp_aaaaaaaaaaaa';
  db.prepare('INSERT OR IGNORE INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run(
    id,
    '2026-03-02T00:00:00.000Z',
    'Other workspace',
    'startup-fundraising',
  );
  return id;
}

export function driveRun(env: TestEnvironment, runId: string, until: string[], maxTicks = 30): string {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    env.advance(1000);
    processJobs(env.ctx);
    const status = getRun(env.db, env.workspaceId, runId)?.status ?? 'missing';
    if (until.includes(status)) return status;
  }
  throw new Error(`Run ${runId} did not reach ${until.join(' or ')}.`);
}

// Same as driveRun, for runs whose steps call the network.
export async function driveRunAsync(env: TestEnvironment, runId: string, until: string[], maxTicks = 60): Promise<string> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    env.advance(1000);
    await processAllJobs(env.ctx);
    const status = getRun(env.db, env.workspaceId, runId)?.status ?? 'missing';
    if (until.includes(status)) return status;
  }
  throw new Error(`Run ${runId} did not reach ${until.join(' or ')}.`);
}
