import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { packageRoot } from '../src/paths.js';
import { getRunDetail } from '../src/queries/runs.js';
import { createTestEnvironment, driveRun } from './helpers.js';

const env = createTestEnvironment();
const folder = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-cli-'));

afterAll(() => {
  env.cleanup();
  rmSync(folder, { recursive: true, force: true });
});

function crm(...args: string[]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), ...args], {
    cwd: packageRoot,
    env: { ...process.env, AGENTCRM_DB: env.databasePath },
    encoding: 'utf8',
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const csvPath = path.join(folder, 'people.csv');
writeFileSync(
  csvPath,
  'Full name;E-mail;Employer;Position\nMira Stone;mira@stone.example.com;Stone Capital;Partner\nJude Park;jude@park.example.org;Park Ventures;Scout\n',
);

describe('crm import', () => {
  it('prints the parse result and suggested mapping with --preview and stages nothing', () => {
    const text = crm('import', csvPath, '--preview');
    expect(text.code).toBe(0);
    expect(text.out).toContain('people.csv: 2 rows, semicolon separated');
    expect(text.out).toContain('Full name -> name');
    expect(text.out).toContain('E-mail -> email');
    expect(text.out).toContain('Employer -> company');
    expect(text.out).toContain('Position -> title');
    expect(text.out).toContain('Mira Stone | mira@stone.example.com | Stone Capital | Partner');

    const json = crm('import', csvPath, '--preview', '--json');
    const parsed = JSON.parse(json.out);
    expect(parsed).toMatchObject({ delimiter: ';', rowCount: 2, suggestedMapping: { 'Full name': 'name', 'E-mail': 'email' } });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM import_batch').get()).toEqual({ n: 0 });
  });

  it('stages the file with the suggested mapping and prints the run and batch ids', () => {
    const result = crm('import', csvPath, '--json');
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out);
    expect(parsed.run).toMatchObject({ kind: 'csv_import', status: 'queued', title: 'CSV import: people.csv' });
    expect(parsed.batchId).toBe(parsed.run.scope.batchId);
    const batch = env.db.prepare('SELECT source_kind, source_ref FROM import_batch WHERE id = ?').get(parsed.batchId) as { source_kind: string; source_ref: string };
    expect(batch.source_kind).toBe('csv');
    expect(JSON.parse(batch.source_ref)).toEqual({ fileName: 'people.csv', rowCount: 2, delimiter: ';' });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM person').get()).toEqual({ n: 0 });
    expect(env.db.prepare("SELECT actor FROM audit_event WHERE action = 'run.create'").get()).toEqual({ actor: 'user' });

    const text = crm('import', csvPath);
    expect(text.out).toMatch(/Run:\s+run_[0-9a-f]{12}/);
    expect(text.out).toMatch(/Batch:\s+imp_[0-9a-f]{12}/);
  });

  it('lists approvals and decides one as the local user', () => {
    const runs = env.db.prepare("SELECT id FROM run WHERE kind = 'csv_import' ORDER BY created_at").all() as { id: string }[];
    const runId = runs[0]!.id;
    // The CLI process used the real clock and the test clock is fixed in the past.
    env.db.prepare("UPDATE job SET run_at = '2000-01-01T00:00:00.000Z'").run();
    driveRun(env, runId, ['waiting_approval']);
    const approval = getRunDetail(env.db, env.workspaceId, runId).approvals[0]!;

    const listed = crm('approvals', 'list', '--json');
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out).items.map((item: { id: string }) => item.id)).toContain(approval.id);
    expect(crm('approvals', 'list').out).toContain(`${approval.id}  pending`);

    const decided = crm('approvals', 'decide', approval.id, 'approve', '--note', 'Looks right', '--json');
    expect(decided.code).toBe(0);
    const parsed = JSON.parse(decided.out);
    expect(parsed.alreadyDecided).toBe(false);
    expect(parsed.approval).toMatchObject({ status: 'approved', note: 'Looks right', decidedBy: 'user' });
    expect(parsed.run.status).toBe('succeeded');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM person').get()).toEqual({ n: 2 });

    const repeated = crm('approvals', 'decide', approval.id, 'approve');
    expect(repeated.code).toBe(0);
    expect(repeated.out).toContain('already approved');
    const opposite = crm('approvals', 'decide', approval.id, 'reject');
    expect(opposite.code).toBe(1);
    expect(opposite.err).toContain('already approved');
  });

  it('uses exit code 1 for expected failures and 2 for usage errors', () => {
    expect(crm('import', path.join(folder, 'missing.csv')).code).toBe(1);
    expect(crm('import').code).toBe(2);
    expect(crm('approvals', 'decide', 'apr_000000000000').code).toBe(2);
    expect(crm('approvals', 'decide', 'apr_000000000000', 'maybe').code).toBe(2);
    expect(crm('approvals', 'decide', 'apr_000000000000', 'approve').code).toBe(1);
    expect(crm('approvals', 'bogus').code).toBe(2);
    const noMapping = path.join(folder, 'notes.csv');
    writeFileSync(noMapping, 'topic,detail\nA,B\n');
    const result = crm('import', noMapping);
    expect(result.code).toBe(1);
    expect(result.err).toContain('email column or a name column');
  });

  it('refuses a file that is not UTF-8 text, for both preview and staging', () => {
    const latin = path.join(folder, 'latin1.csv');
    // 0xE9 is "e with acute" in Latin-1 and an invalid byte sequence in UTF-8.
    writeFileSync(latin, Buffer.concat([Buffer.from('name,email\nJos'), Buffer.from([0xe9]), Buffer.from(',jose@example.com\n')]));
    const before = env.db.prepare('SELECT COUNT(*) AS n FROM import_batch').get();
    for (const args of [['import', latin], ['import', latin, '--preview']]) {
      const result = crm(...args);
      expect(result.code).toBe(1);
      expect(result.err).toContain('The file is not valid UTF-8 text. Save it as UTF-8 and try again.');
    }
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM import_batch').get()).toEqual(before);
  });

  it('says when the approvals list is cut at 200', () => {
    const runId = (env.db.prepare("SELECT id FROM run WHERE kind = 'csv_import' ORDER BY created_at").get() as { id: string }).id;
    const existing = (env.db.prepare('SELECT COUNT(*) AS n FROM approval').get() as { n: number }).n;
    const insert = env.db.prepare(
      "INSERT INTO approval (id, created_at, workspace_id, run_id, kind, title, payload, payload_hash, status) VALUES (?, ?, ?, ?, 'test', 'Filler', '{}', 'hash', 'pending')",
    );
    const add = (total: number) => {
      const have = (env.db.prepare('SELECT COUNT(*) AS n FROM approval').get() as { n: number }).n;
      for (let index = have; index < total; index += 1) {
        insert.run(`apr_${index.toString(16).padStart(12, '0')}`, '2026-03-02T00:00:00.000Z', env.workspaceId, runId);
      }
    };
    const note = 'Only the first 200 approvals are shown (newest first).';
    add(199);
    expect(existing).toBeLessThanOrEqual(199);
    expect(crm('approvals', 'list').out).not.toContain(note);
    add(200);
    const full = crm('approvals', 'list');
    expect(full.out.trim().split('\n')).toHaveLength(201);
    expect(full.out.trim().split('\n').at(-1)).toBe(note);
    add(201);
    expect(crm('approvals', 'list').out.trim().split('\n').at(-1)).toBe(note);
  });
});
