import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addSuppression, decideApproval, startMailboxCapture, updatePerson } from '../src/actions/index.js';
import { linkStoredMessagesToPerson } from '../src/actions/mailLinks.js';
import { isMachineAddress } from '../src/actions/mailboxCapture.js';
import { mutate } from '../src/actions/context.js';
import { applyMigrations, listMigrationFiles } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { buildApp } from '../src/http/app.js';
import { parseDisplayName } from '../src/mail/rules.js';
import { migrationsDirectory } from '../src/paths.js';
import { getPersonDetail } from '../src/queries/people.js';
import { getRunDetail } from '../src/queries/runs.js';
import { createTestEnvironment, driveRun, insertSecondWorkspace, type TestEnvironment } from './helpers.js';
import { addPerson, connectMail } from './mailHelpers.js';
import { type AgentmailStub, startAgentmailStub, stubInboxId, useAgentmailStub } from './agentmailStub.js';

const host = { host: '127.0.0.1:4720' };
const environments: TestEnvironment[] = [];
const apps: FastifyInstance[] = [];

let stub: AgentmailStub;
let restoreStub: () => void;

beforeAll(async () => {
  stub = await startAgentmailStub();
  restoreStub = useAgentmailStub(stub);
});

afterAll(async () => {
  await stub.close();
  restoreStub();
  for (const app of apps) await app.close();
  for (const env of environments) env.cleanup();
});

function freshEnv(): TestEnvironment {
  const env = createTestEnvironment();
  environments.push(env);
  return env;
}

let sequence = 0;
interface StoredMessage {
  direction: 'in' | 'out';
  from?: string;
  fromName?: string | null;
  to?: string[];
  at: string;
  personId?: string | null;
  subject?: string;
  body?: string;
  workspaceId?: string;
}

function store(env: TestEnvironment, message: StoredMessage): void {
  sequence += 1;
  env.db
    .prepare(
      `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, direction, person_id, from_email, from_name, "to", subject, preview, body_text, labels, provider_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, '[]', ?)`,
    )
    .run(
      `msg_t${sequence}`,
      message.at,
      message.workspaceId ?? env.workspaceId,
      `pm_t${sequence}`,
      message.direction,
      message.personId ?? null,
      message.direction === 'in' ? (message.from ?? 'unknown@nowhere.invalid') : (message.from ?? stubInboxId),
      message.fromName ?? null,
      JSON.stringify(message.to ?? (message.direction === 'in' ? [stubInboxId] : [])),
      message.subject ?? 'SECRET SUBJECT',
      message.body ?? 'SECRET BODY',
      message.at,
    );
}

function daysAgo(env: TestEnvironment, days: number): string {
  // The test clock starts here and only moves by milliseconds, so offsets from it are stable.
  void env;
  return new Date(Date.parse('2026-03-01T09:00:00.000Z') - days * 86_400_000).toISOString();
}

function count(env: TestEnvironment, sql: string, ...params: unknown[]): number {
  return Number((env.db.prepare(sql).get(...params) as { n: number }).n);
}

function failure(work: () => unknown): AppError {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Expected the call to fail.');
}

function promotions(env: TestEnvironment, personId: string): string[] {
  return (env.db.prepare("SELECT detail FROM audit_event WHERE action = 'person.promote' AND entity_id = ?").all(personId) as { detail: string }[]).map(
    (row) => (JSON.parse(row.detail) as { reason: string }).reason,
  );
}

function stagedRows(env: TestEnvironment, runId: string) {
  const batch = env.db.prepare('SELECT * FROM import_batch WHERE run_id = ?').get(runId) as Record<string, string>;
  const rows = env.db.prepare('SELECT * FROM import_row WHERE batch_id = ? ORDER BY seq').all(batch.id) as Record<string, string>[];
  return { batch, rows };
}

describe('migration 024', () => {
  it('adds from_name, widens source_kind, and links stored messages to existing people without promoting', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of listMigrationFiles().filter((name) => name < '024')) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      for (const id of ['wsp_1', 'wsp_2']) {
        db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run(id, '2026-01-01', id, 't');
      }
      const person = (id: string, workspace: string, email: string | null) =>
        db
          .prepare('INSERT INTO person (id, created_at, workspace_id, first_name, email, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, '2026-01-01', workspace, id, email, '2026-01-01');
      person('per_ada', 'wsp_1', 'Ada@Lanternrow.invalid');
      person('per_ben', 'wsp_1', 'ben@lanternrow.invalid');
      person('per_other', 'wsp_2', 'ada@lanternrow.invalid');
      person('per_noemail', 'wsp_1', null);
      const message = (id: string, workspace: string, direction: string, from: string, to: string[], personId: string | null) =>
        db
          .prepare(
            `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, direction, person_id, from_email, "to", provider_timestamp)
             VALUES (?, '2026-01-02', ?, ?, ?, ?, ?, ?, '2026-01-02T00:00:00.000Z')`,
          )
          .run(id, workspace, `pm_${id}`, direction, personId, from, JSON.stringify(to));
      message('in_ada', 'wsp_1', 'in', 'ada@lanternrow.invalid', ['me@mine.invalid'], null);
      message('in_stranger', 'wsp_1', 'in', 'stranger@nowhere.invalid', ['me@mine.invalid'], null);
      message('in_taken', 'wsp_1', 'in', 'ada@lanternrow.invalid', ['me@mine.invalid'], 'per_ben');
      message('out_ben', 'wsp_1', 'out', 'me@mine.invalid', ['someone@else.invalid', 'BEN@lanternrow.invalid'], null);
      message('out_none', 'wsp_1', 'out', 'me@mine.invalid', ['nobody@else.invalid'], null);
      message('in_other_ws', 'wsp_2', 'in', 'ben@lanternrow.invalid', ['me@mine.invalid'], null);
      message('out_other_ws', 'wsp_2', 'out', 'me@mine.invalid', ['ada@lanternrow.invalid'], null);
      const lifecycleBefore = db.prepare('SELECT id, lifecycle FROM person ORDER BY id').all();

      expect(applyMigrations(db)).toEqual(['024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql']);

      const linked = Object.fromEntries((db.prepare('SELECT id, person_id FROM email_message').all() as { id: string; person_id: string | null }[]).map((row) => [row.id, row.person_id]));
      expect(linked).toEqual({
        in_ada: 'per_ada',
        in_stranger: null,
        in_taken: 'per_ben',
        out_ben: 'per_ben',
        out_none: null,
        in_other_ws: null,
        out_other_ws: 'per_other',
      });
      expect(db.prepare('SELECT id, lifecycle FROM person ORDER BY id').all()).toEqual(lifecycleBefore);
      expect(db.prepare('SELECT from_name FROM email_message WHERE id = ?').get('in_ada')).toEqual({ from_name: null });
      db.prepare(
        "INSERT INTO run (id, created_at, workspace_id, kind, title, status) VALUES ('run_1', '2026-01-02', 'wsp_1', 'mailbox_capture', 'x', 'queued')",
      ).run();
      db.prepare(
        "INSERT INTO import_batch (id, created_at, workspace_id, run_id, source_kind, updated_at) VALUES ('imp_1', '2026-01-02', 'wsp_1', 'run_1', 'mailbox', '2026-01-02')",
      ).run();
      expect(() => db.prepare("UPDATE import_batch SET source_kind = 'imap' WHERE id = 'imp_1'").run()).toThrow(/CHECK/);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect((db.pragma('index_list(import_row)') as { name: string }[]).map((index) => index.name)).toContain('idx_import_row_batch');
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('display names', () => {
  it('reads the name before the angle address and drops invisible characters, bare addresses, and address names', () => {
    expect(parseDisplayName('Ada Quill <ada@x.invalid>')).toBe('Ada Quill');
    expect(parseDisplayName('"Quill, Ada" <ada@x.invalid>')).toBe('Quill, Ada');
    expect(parseDisplayName('"Ada‮ ​Quill" <ada@x.invalid>')).toBe('Ada Quill');
    expect(parseDisplayName('ada@x.invalid')).toBeNull();
    expect(parseDisplayName('<ada@x.invalid>')).toBeNull();
    expect(parseDisplayName('"ada@x.invalid" <ada@x.invalid>')).toBeNull();
    expect(parseDisplayName(`${'N'.repeat(500)} <ada@x.invalid>`)).toHaveLength(200);
  });

  it('matches machine local parts by the documented prefix list only', () => {
    for (const address of ['no-reply@x.invalid', 'NoReply@x.invalid', 'noreply+abc@x.invalid', 'bounce-1042@x.invalid', 'mailer-daemon@x.invalid', 'alerts@x.invalid']) {
      expect(isMachineAddress(address), address).toBe(true);
    }
    for (const address of ['alertson@x.invalid', 'bouncer@x.invalid', 'ada@x.invalid', 'newsletters-team@y.invalid']) {
      expect(isMachineAddress(address), address).toBe(false);
    }
  });
});

describe('scan and staging', () => {
  it('refuses with a reason when no mail is stored, when the window holds no one new, and for agent origin', () => {
    const env = freshEnv();
    expect(failure(() => startMailboxCapture(env.ctx, {})).message).toMatch(/No mail is stored/);
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', at: daysAgo(env, 200) });
    expect(failure(() => startMailboxCapture(env.ctx, { sinceDays: 30 })).message).toMatch(/No new correspondents/);
    expect(failure(() => startMailboxCapture(env.ctx, {}, { origin: 'agent' })).message).toMatch(/person in the app/);
    expect(count(env, "SELECT COUNT(*) AS n FROM run WHERE kind = 'mailbox_capture'")).toBe(0);
  });

  it('bounds sinceDays from 1 to 3650', () => {
    const env = freshEnv();
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', at: daysAgo(env, 1) });
    for (const sinceDays of [0, -1, 3651, 1.5, '30']) {
      expect(failure(() => startMailboxCapture(env.ctx, { sinceDays })).code).toBe('validation');
    }
    expect(failure(() => startMailboxCapture(env.ctx, { sinceDays: 30, extra: true })).code).toBe('validation');
    expect(startMailboxCapture(env.ctx, { sinceDays: 3650 }).status).toBe('queued');
  });

  it('aggregates one candidate per address with counts, first and last seen, and the most recent non empty name', async () => {
    const env = freshEnv();
    await connectMail(env);
    const known = addPerson(env, 'Known', 'known@lanternrow.invalid');
    addSuppression(env.ctx, { email: 'Blocked@lanternrow.invalid', reason: 'manual' });
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', fromName: 'Ada Old', at: daysAgo(env, 40) });
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', fromName: 'Ada Quill', at: daysAgo(env, 10) });
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', fromName: null, at: daysAgo(env, 2) });
    store(env, { direction: 'out', to: ['Ada@Lanternrow.invalid', 'ben@lanternrow.invalid'], at: daysAgo(env, 3) });
    // The same recipient twice on one message counts once.
    store(env, { direction: 'out', to: ['ben@lanternrow.invalid', 'BEN@lanternrow.invalid'], at: daysAgo(env, 5) });
    // Own inbox, a person, a suppressed address, machine senders, and junk are not candidates.
    store(env, { direction: 'in', from: stubInboxId, at: daysAgo(env, 1) });
    store(env, { direction: 'in', from: 'known@lanternrow.invalid', at: daysAgo(env, 1) });
    store(env, { direction: 'out', to: ['blocked@lanternrow.invalid'], at: daysAgo(env, 1) });
    store(env, { direction: 'in', from: 'no-reply@lanternrow.invalid', at: daysAgo(env, 1) });
    store(env, { direction: 'in', from: 'mailer-daemon@lanternrow.invalid', at: daysAgo(env, 1) });
    store(env, { direction: 'in', from: 'not an address', at: daysAgo(env, 1) });
    // Outside the window.
    store(env, { direction: 'in', from: 'old@lanternrow.invalid', at: daysAgo(env, 100) });

    const run = startMailboxCapture(env.ctx, { sinceDays: 90 });
    expect(run).toMatchObject({ kind: 'mailbox_capture', status: 'queued', title: 'Mailbox capture: last 90 days' });
    expect(run.scope).toEqual({ batchId: expect.any(String), sinceDays: 90, origin: 'user' });
    expect(run.steps.map((step) => step.title)).toEqual(['Scan stored mail and stage correspondents', 'Validate rows', 'Check for duplicates', 'Request import review']);
    expect(run.steps.map((step) => step.status)).toEqual(['done', 'pending', 'pending', 'pending']);
    expect(run.steps[0]!.detail).toBe('Scanned 11 stored messages and staged 2 correspondents.');

    const { batch, rows } = stagedRows(env, run.id);
    expect(batch.source_kind).toBe('mailbox');
    expect(JSON.parse(batch.source_ref)).toEqual({ sinceDays: 90, scannedMessages: 11, correspondents: 2 });
    expect(rows.map((row) => JSON.parse(row.mapped).email)).toEqual(['ada@lanternrow.invalid', 'ben@lanternrow.invalid']);
    expect(JSON.parse(rows[0]!.mapped)).toMatchObject({ email: 'ada@lanternrow.invalid', name: 'Ada Quill', tags: [] });
    expect(JSON.parse(rows[0]!.raw)).toEqual({
      email: 'ada@lanternrow.invalid',
      name: 'Ada Quill',
      inbound: 3,
      outbound: 1,
      firstSeenAt: daysAgo(env, 40),
      lastSeenAt: daysAgo(env, 2),
    });
    expect(JSON.parse(rows[1]!.raw)).toMatchObject({ name: null, inbound: 0, outbound: 2, firstSeenAt: daysAgo(env, 5), lastSeenAt: daysAgo(env, 3) });
    expect(known.email).toBe('known@lanternrow.invalid');
  });

  it('keeps subjects and body text out of the batch, rows, payload, scope, and audit trail', () => {
    const env = freshEnv();
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', fromName: 'Ada Quill', at: daysAgo(env, 1), subject: 'SECRET SUBJECT', body: 'SECRET BODY' });
    store(env, { direction: 'out', to: ['ben@lanternrow.invalid'], at: daysAgo(env, 1), subject: 'SECRET SUBJECT', body: 'SECRET BODY' });
    const run = startMailboxCapture(env.ctx, {});
    expect(driveRun(env, run.id, ['waiting_approval'])).toBe('waiting_approval');
    decideApproval(env.ctx, getRunDetail(env.db, env.workspaceId, run.id).approvals[0]!.id, { decision: 'approve' });
    for (const table of ['import_batch', 'import_row', 'approval', 'run', 'run_step', 'audit_event', 'field_claim', 'person', 'job']) {
      const dump = JSON.stringify(env.db.prepare(`SELECT * FROM ${table}`).all());
      expect(dump, table).not.toContain('SECRET');
    }
  });

  it('gives the review sample rows email, name, counts, and last seen', () => {
    const env = freshEnv();
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', fromName: 'Ada Quill', at: daysAgo(env, 4) });
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', fromName: 'Ada Quill', at: daysAgo(env, 3) });
    store(env, { direction: 'out', to: ['ada@lanternrow.invalid'], at: daysAgo(env, 2) });
    const run = startMailboxCapture(env.ctx, {});
    driveRun(env, run.id, ['waiting_approval']);
    const approval = getRunDetail(env.db, env.workspaceId, run.id).approvals[0]!;
    expect(approval).toMatchObject({ kind: 'import_review', title: 'Review 1 correspondent from all synced mail' });
    expect(approval.payload).toEqual({
      batchId: expect.any(String),
      sinceDays: null,
      counts: { fetched: 1, staged: 1, duplicates: 0, invalid: 0 },
      sample: [{ email: 'ada@lanternrow.invalid', name: 'Ada Quill', inbound: 2, outbound: 1, lastSeenAt: daysAgo(env, 2) }],
    });
    const steps = getRunDetail(env.db, env.workspaceId, run.id).steps;
    expect(steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('marks an address already staged in another pending mailbox import as a duplicate', () => {
    const env = freshEnv();
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', at: daysAgo(env, 4) });
    store(env, { direction: 'in', from: 'ben@lanternrow.invalid', at: daysAgo(env, 4) });
    const first = startMailboxCapture(env.ctx, {});
    driveRun(env, first.id, ['waiting_approval']);
    const second = startMailboxCapture(env.ctx, {});
    driveRun(env, second.id, ['partial']);
    const { rows } = stagedRows(env, second.id);
    expect(rows.map((row) => row.status)).toEqual(['duplicate', 'duplicate']);
    expect(rows[0]!.reason).toMatch(/Already staged in another pending import/);
    expect(getRunDetail(env.db, env.workspaceId, second.id).approvals).toHaveLength(0);
  });

  it('marks an address added as a person after the scan as a duplicate at the dedupe step', () => {
    const env = freshEnv();
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', at: daysAgo(env, 4) });
    const run = startMailboxCapture(env.ctx, {});
    addPerson(env, 'Ada', 'ada@lanternrow.invalid');
    driveRun(env, run.id, ['partial']);
    expect(stagedRows(env, run.id).rows[0]).toMatchObject({ status: 'duplicate', reason: 'Email matches an existing person.' });
  });
});

describe('accept', () => {
  it('creates leads with claims and tags, links messages in the same transaction, and promotes only those who wrote', () => {
    const env = freshEnv();
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', fromName: 'Ada Quill', at: daysAgo(env, 4) });
    store(env, { direction: 'out', to: ['ada@lanternrow.invalid'], at: daysAgo(env, 3) });
    store(env, { direction: 'out', to: ['ben@lanternrow.invalid'], at: daysAgo(env, 2) });
    const run = startMailboxCapture(env.ctx, {});
    driveRun(env, run.id, ['waiting_approval']);
    const approval = getRunDetail(env.db, env.workspaceId, run.id).approvals[0]!;
    expect(count(env, 'SELECT COUNT(*) AS n FROM person')).toBe(0);
    const decided = decideApproval(env.ctx, approval.id, { decision: 'approve' });
    expect(decided.run.status).toBe('succeeded');
    expect(decided.run.counts).toMatchObject({ accepted: 2 });

    const ada = env.db.prepare("SELECT * FROM person WHERE email = 'ada@lanternrow.invalid'").get() as Record<string, string>;
    const ben = env.db.prepare("SELECT * FROM person WHERE email = 'ben@lanternrow.invalid'").get() as Record<string, string>;
    expect(ada).toMatchObject({ first_name: 'Ada', last_name: 'Quill', lifecycle: 'relationship' });
    expect(ben).toMatchObject({ first_name: 'ben', lifecycle: 'lead' });
    expect(JSON.parse(ada.tags!)).toEqual(['mailbox-import', `via-${run.id}`]);
    const claims = env.db.prepare('SELECT field, value, source_type, source_url, extraction_method, status FROM field_claim WHERE entity_id = ? ORDER BY field').all(ada.id!) as Record<string, string | null>[];
    expect(claims.map((claim) => claim.field)).toEqual(['email', 'name']);
    for (const claim of claims) expect(claim).toMatchObject({ source_type: 'import', source_url: null, extraction_method: 'mailbox:scan', status: 'imported' });
    expect(env.db.prepare('SELECT person_id, direction FROM email_message ORDER BY provider_timestamp').all()).toEqual([
      { person_id: ada.id, direction: 'in' },
      { person_id: ada.id, direction: 'out' },
      { person_id: ben.id, direction: 'out' },
    ]);
    // Promotion happens for the one who wrote, with reason replied, and never for an outbound only correspondent.
    expect(promotions(env, ada.id!)).toEqual(['replied']);
    expect(promotions(env, ben.id!)).toEqual([]);
    expect(count(env, "SELECT COUNT(*) AS n FROM audit_event WHERE action = 'import.accept'")).toBe(1);
    expect((env.db.prepare('SELECT status FROM import_batch WHERE run_id = ?').get(run.id) as { status: string }).status).toBe('accepted');
  });

  it('leaves everything untouched when the review is rejected', () => {
    const env = freshEnv();
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', at: daysAgo(env, 4) });
    const run = startMailboxCapture(env.ctx, {});
    driveRun(env, run.id, ['waiting_approval']);
    decideApproval(env.ctx, getRunDetail(env.db, env.workspaceId, run.id).approvals[0]!.id, { decision: 'reject' });
    expect(count(env, 'SELECT COUNT(*) AS n FROM person')).toBe(0);
    expect(count(env, 'SELECT COUNT(*) AS n FROM email_message WHERE person_id IS NOT NULL')).toBe(0);
  });

  it('does not touch mail that already belongs to someone else', () => {
    const env = freshEnv();
    const holder = addPerson(env, 'Holder', 'holder@lanternrow.invalid');
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', at: daysAgo(env, 4), personId: holder.id });
    store(env, { direction: 'in', from: 'ben@lanternrow.invalid', at: daysAgo(env, 4) });
    const run = startMailboxCapture(env.ctx, {});
    driveRun(env, run.id, ['waiting_approval']);
    decideApproval(env.ctx, getRunDetail(env.db, env.workspaceId, run.id).approvals[0]!.id, { decision: 'approve' });
    expect(count(env, 'SELECT COUNT(*) AS n FROM email_message WHERE person_id = ?', holder.id)).toBe(1);
    const ada = env.db.prepare("SELECT lifecycle FROM person WHERE email = 'ada@lanternrow.invalid'").get() as { lifecycle: string };
    // Ada's only inbound row was filed under the holder, so no linked inbound exists for her and she stays a lead.
    expect(ada.lifecycle).toBe('lead');
  });
});

describe('linking on person create and email edit', () => {
  it('files stored mail under a new or re-addressed person and never promotes', () => {
    const env = freshEnv();
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', at: daysAgo(env, 4) });
    store(env, { direction: 'out', to: ['Cy <cy@lanternrow.invalid>'.toLowerCase(), 'ada@lanternrow.invalid'], at: daysAgo(env, 3) });
    store(env, { direction: 'in', from: 'ben@lanternrow.invalid', at: daysAgo(env, 2) });

    const ada = addPerson(env, 'Ada', 'Ada@Lanternrow.invalid');
    expect(count(env, 'SELECT COUNT(*) AS n FROM email_message WHERE person_id = ?', ada.id)).toBe(2);
    expect(ada.lifecycle).toBe('lead');
    expect(promotions(env, ada.id)).toEqual([]);

    const ben = addPerson(env, 'Ben', null);
    expect(count(env, 'SELECT COUNT(*) AS n FROM email_message WHERE person_id = ?', ben.id)).toBe(0);
    updatePerson(env.ctx, ben.id, { expectedVersion: ben.version, fields: { email: 'ben@lanternrow.invalid' } });
    expect(count(env, 'SELECT COUNT(*) AS n FROM email_message WHERE person_id = ?', ben.id)).toBe(1);
    expect(promotions(env, ben.id)).toEqual([]);
    expect((env.db.prepare('SELECT lifecycle FROM person WHERE id = ?').get(ben.id) as { lifecycle: string }).lifecycle).toBe('lead');
    // Changing a field other than the email links nothing and clearing the email is not an error.
    const after = env.db.prepare('SELECT version FROM person WHERE id = ?').get(ben.id) as { version: number };
    updatePerson(env.ctx, ben.id, { expectedVersion: after.version, fields: { email: null } });
    expect(count(env, 'SELECT COUNT(*) AS n FROM email_message WHERE person_id = ?', ben.id)).toBe(1);
  });

  it('stays inside the workspace', () => {
    const env = freshEnv();
    const other = insertSecondWorkspace(env.db);
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', at: daysAgo(env, 4), workspaceId: other });
    const ada = addPerson(env, 'Ada', 'ada@lanternrow.invalid');
    expect(count(env, 'SELECT COUNT(*) AS n FROM email_message WHERE person_id = ?', ada.id)).toBe(0);
    const linked = mutate(env.ctx, (tx) => linkStoredMessagesToPerson(tx, ada.id, 'ada@lanternrow.invalid'));
    expect(linked).toEqual({ inbound: 0, outbound: 0 });
  });
});

describe('interaction on the person', () => {
  async function appFor(env: TestEnvironment): Promise<FastifyInstance> {
    const app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
    apps.push(app);
    await app.ready();
    return app;
  }

  it('is null without linked mail, carries dates and counts with it, and is left out of model reads', async () => {
    const env = freshEnv();
    const app = await appFor(env);
    const person = addPerson(env, 'Ada', 'ada@lanternrow.invalid');
    const get = async (id: string) => (await app.inject({ method: 'GET', url: `/api/people/${id}`, headers: host })).json() as Record<string, any>;
    expect((await get(person.id)).interaction).toBeNull();

    store(env, { direction: 'in', personId: person.id, from: 'ada@lanternrow.invalid', at: '2026-02-01T10:00:00.000Z' });
    store(env, { direction: 'in', personId: person.id, from: 'ada@lanternrow.invalid', at: '2026-02-03T10:00:00.000Z' });
    store(env, { direction: 'out', personId: person.id, to: ['ada@lanternrow.invalid'], at: '2026-02-02T10:00:00.000Z' });
    expect((await get(person.id)).interaction).toEqual({
      lastInboundAt: '2026-02-03T10:00:00.000Z',
      lastOutboundAt: '2026-02-02T10:00:00.000Z',
      inbound: 2,
      outbound: 1,
    });

    const outboundOnly = addPerson(env, 'Ben', 'ben@lanternrow.invalid');
    store(env, { direction: 'out', personId: outboundOnly.id, to: ['ben@lanternrow.invalid'], at: '2026-02-04T10:00:00.000Z' });
    expect((await get(outboundOnly.id)).interaction).toEqual({ lastInboundAt: null, lastOutboundAt: '2026-02-04T10:00:00.000Z', inbound: 0, outbound: 1 });

    expect(getPersonDetail(env.db, env.workspaceId, person.id)).toHaveProperty('interaction');
    expect(getPersonDetail(env.db, env.workspaceId, person.id, { forModel: true })).not.toHaveProperty('interaction');
  });
});

describe('route and run kind', () => {
  it('answers 201 with the run, rejects bad input with 400, and offers no start through the generic run route', async () => {
    const env = freshEnv();
    const app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
    apps.push(app);
    await app.ready();
    store(env, { direction: 'in', from: 'ada@lanternrow.invalid', at: daysAgo(env, 4) });
    const bad = await app.inject({ method: 'POST', url: '/api/imports/mailbox', headers: host, payload: { sinceDays: 0 } });
    expect(bad.statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url: '/api/imports/mailbox', headers: host, payload: { sinceDays: 30 } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ kind: 'mailbox_capture', status: 'queued' });
    const noBody = await app.inject({ method: 'POST', url: '/api/imports/mailbox', headers: host });
    expect([201, 400]).toContain(noBody.statusCode);
    const generic = await app.inject({ method: 'POST', url: '/api/runs', headers: host, payload: { kind: 'mailbox_capture', scope: {} } });
    expect(generic.statusCode).toBe(400);
  });
});
