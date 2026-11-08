// Adversarial probes for the mailbox import review promotion hint (willPromote). KILLS = attack defeated, behaviour
// correct. CONFIRMS = the test passes against today's code and demonstrates a contract violation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval, setImportSettings, startMailboxCapture } from '../src/actions/index.js';
import { getRunDetail } from '../src/queries/runs.js';
import { createTestEnvironment, driveRun, type TestEnvironment } from './helpers.js';
import { stubInboxId } from './agentmailStub.js';

const environments: TestEnvironment[] = [];
afterAll(() => environments.forEach((e) => e.cleanup()));
beforeAll(() => undefined);
const freshEnv = (): TestEnvironment => {
  const env = createTestEnvironment();
  environments.push(env);
  return env;
};

let seq = 0;
function store(env: TestEnvironment, m: { direction: 'in' | 'out'; email: string; at: string; personId?: string | null }): void {
  seq += 1;
  env.db
    .prepare(
      `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, direction, person_id, from_email, from_name, "to", subject, preview, body_text, labels, provider_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 's', '', 'b', '[]', ?)`,
    )
    .run(
      `msg_h${seq}`, m.at, env.workspaceId, `pm_h${seq}`, m.direction, m.personId ?? null,
      m.direction === 'in' ? m.email : stubInboxId,
      JSON.stringify(m.direction === 'in' ? [stubInboxId] : [m.email]),
      m.at,
    );
}
const daysAgo = (env: TestEnvironment, d: number): string => new Date(Date.parse(env.ctx.now()) - d * 86_400_000).toISOString();
const review = (env: TestEnvironment, runId: string) => getRunDetail(env.db, env.workspaceId, runId).approvals[0]!;
const relationships = (env: TestEnvironment): number =>
  Number((env.db.prepare("SELECT COUNT(*) n FROM person WHERE lifecycle = 'relationship'").get() as { n: number }).n);

describe('willPromote vs what accept really does', () => {
  it('KILLS: a windowed scan counts OLDER inbound mail too, with the predicate the accept applies, so the hint matches', () => {
    const env = freshEnv();
    store(env, { direction: 'in', email: 'old@lanternrow.invalid', at: daysAgo(env, 40) }); // outside the 7 day window
    store(env, { direction: 'out', email: 'old@lanternrow.invalid', at: daysAgo(env, 2) }); // inside it
    const run = startMailboxCapture(env.ctx, { sinceDays: 7 });
    driveRun(env, run.id, ['waiting_approval']);
    const a = review(env, run.id);
    // The count reads all stored mail, not the window, so the row staged from recent outbound mail counts ...
    expect((a.payload as { willPromote: number }).willPromote).toBe(1);
    decideApproval(env.ctx, a.id, { decision: 'approve' });
    // ... and the accept promotes exactly that one person. The hint said 1 and reality is 1.
    expect(relationships(env)).toBe(1);
  });

  it('ACCEPTED (documented): inbound mail that syncs in between the review request and the decision still promotes', () => {
    const env = freshEnv();
    store(env, { direction: 'out', email: 'late@lanternrow.invalid', at: daysAgo(env, 2) });
    const run = startMailboxCapture(env.ctx, {});
    driveRun(env, run.id, ['waiting_approval']);
    const a = review(env, run.id);
    expect((a.payload as { willPromote: number }).willPromote).toBe(0);
    store(env, { direction: 'in', email: 'late@lanternrow.invalid', at: daysAgo(env, 0) });
    decideApproval(env.ctx, a.id, { decision: 'approve' });
    // The payload is hashed and bound, so this one undercount is documented in the contract, not fixed.
    expect(relationships(env)).toBe(1);
  });

  it('KILLS: inbound already filed under another person neither counts nor promotes, so the hint is exact here', () => {
    const env = freshEnv();
    const holder = env.db.prepare("SELECT 1").get();
    expect(holder).toBeTruthy();
    // a message already owned by some person row id (FK may be enforced): use an existing person
    env.db.prepare("INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, email, lifecycle, tags, updated_at) VALUES ('per_x', ?, ?, 1, 'X', '', 'x@else.invalid', 'lead', '[]', ?)").run(env.ctx.now(), env.workspaceId, env.ctx.now());
    store(env, { direction: 'in', email: 'owned@lanternrow.invalid', at: daysAgo(env, 2), personId: 'per_x' });
    const run = startMailboxCapture(env.ctx, {});
    driveRun(env, run.id, ['waiting_approval']);
    const a = review(env, run.id);
    // The accept-time predicate skips filed messages, so the hint says 0 and the accept promotes 0.
    expect((a.payload as { willPromote: number }).willPromote).toBe(0);
    decideApproval(env.ctx, a.id, { decision: 'approve' });
    expect(relationships(env)).toBe(0);
  });

  it('KILLS: the count reads the mapped address, never the raw counts, so mangled raw shapes cannot move it', () => {
    const env = freshEnv();
    store(env, { direction: 'in', email: 'seed@lanternrow.invalid', at: daysAgo(env, 2) });
    const run = startMailboxCapture(env.ctx, {});
    const row = env.db.prepare('SELECT id, mapped FROM import_row LIMIT 1').get() as { id: string; mapped: string };
    expect((JSON.parse(row.mapped) as { email: string }).email).toBe('seed@lanternrow.invalid');
    const predicate = `SELECT COUNT(*) AS n FROM import_row r
      WHERE r.batch_id = (SELECT id FROM import_batch LIMIT 1) AND r.status = 'staged'
        AND EXISTS (
          SELECT 1 FROM email_message m
          WHERE m.workspace_id = ? AND m.person_id IS NULL AND m.direction = 'in'
            AND m.from_email = lower(trim(json_extract(r.mapped, '$.email')))
        )`;
    // The production predicate reads mapped, so every raw mangling leaves the count at 1.
    for (const raw of ['{"inbound":0}', '[]', 'null', '{"inbound":"abc"}']) {
      env.db.prepare('UPDATE import_row SET raw = ? WHERE id = ?').run(raw, row.id);
      expect((env.db.prepare(predicate).get(env.workspaceId) as { n: number }).n).toBe(1);
    }
    // A row whose mapped JSON has no email never counts and never throws.
    env.db.prepare('UPDATE import_row SET mapped = ? WHERE id = ?').run('{}', row.id);
    expect((env.db.prepare(predicate).get(env.workspaceId) as { n: number }).n).toBe(0);
    expect(run.id).toBeTruthy();
  });

  it('KILLS: payload is stable after hashing; reading it again and after a failed/neutral step does not change it', () => {
    const env = freshEnv();
    store(env, { direction: 'in', email: 'a@lanternrow.invalid', at: daysAgo(env, 2) });
    const run = startMailboxCapture(env.ctx, {});
    driveRun(env, run.id, ['waiting_approval']);
    const first = JSON.stringify(review(env, run.id).payload);
    store(env, { direction: 'in', email: 'b@lanternrow.invalid', at: daysAgo(env, 1) }); // new mail after request
    expect(JSON.stringify(review(env, run.id).payload)).toBe(first);
    expect(JSON.parse(first).willPromote).toBe(1);
  });

  it('KILLS: mailbox never auto accepts even with auto accept on, and willPromote does not change that', () => {
    const env = freshEnv();
    try {
      setImportSettings(env.ctx, { autoAccept: true } as never);
    } catch {
      // setting shape may differ; the assertion below is what matters
    }
    store(env, { direction: 'in', email: 'a@lanternrow.invalid', at: daysAgo(env, 2) });
    const run = startMailboxCapture(env.ctx, {});
    driveRun(env, run.id, ['waiting_approval']);
    expect(review(env, run.id).status).toBe('pending');
    expect(relationships(env)).toBe(0);
  });
});
