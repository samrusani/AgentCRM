import { afterAll, describe, expect, it } from 'vitest';
import { startRun } from '../src/actions/index.js';
import { createTestEnvironment, driveRun } from './helpers.js';

const env = createTestEnvironment();
afterAll(() => env.cleanup());

describe('run step audit rows', () => {
  it('writes an audit row for every step transition so other processes can relay progress', () => {
    const run = startRun(env.ctx, { kind: 'demo_research', title: 'Audit rows' });
    driveRun(env, run.id, ['waiting_approval']);
    const actions = (
      env.db
        .prepare("SELECT action FROM audit_event WHERE entity_type = 'run' AND entity_id = ? ORDER BY rowid")
        .all(run.id) as { action: string }[]
    ).map((row) => row.action);
    expect(actions.filter((action) => action === 'run.step_start')).toHaveLength(4);
    expect(actions.filter((action) => action === 'run.step_done')).toHaveLength(4);
  });
});
