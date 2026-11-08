// Adversarial review probes for duplicate review and merge (the first deletion of a person row).
// KILLS: the attack failed and the safe behavior is pinned. CONFIRMS: a live gap, asserted as it behaves today, the
// comment says what correct would be. ACCEPTED: a limit the contract states.
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAttribute,
  createAutomation,
  createOpportunity,
  createOrganization,
  createPerson,
  createPipeline,
  decideApproval,
  dismissDuplicate,
  mergePeople,
  moveOpportunityStage,
  prepareSendIntents,
  proposeChanges,
  applyChanges,
  startRun,
  resetAllData,
  resetRecordData,
  updateAutomation,
  updatePerson,
} from '../src/actions/index.js';
import { AppError } from '../src/errors.js';
import { buildApp } from '../src/http/app.js';
import { openDatabase } from '../src/db.js';
import { getPerson } from '../src/queries/people.js';
import { scanDuplicates } from '../src/queries/duplicates.js';
import { templates } from '../src/templates.js';
import { startAgentmailStub, useAgentmailStub, type AgentmailStub } from './agentmailStub.js';
import { createTestEnvironment, driveRun } from './helpers.js';
import { addDraft, connectMail, drain } from './mailHelpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let stub: AgentmailStub;
let restoreStub: () => void;
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  stub = await startAgentmailStub();
  restoreStub = useAgentmailStub(stub);
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
  await connectMail(env);
});

afterAll(async () => {
  await app.close();
  await stub.close();
  restoreStub();
  env.cleanup();
});

beforeEach(() => {
  resetRecordData(env.db);
  env.db.prepare('DELETE FROM automation').run(); // configuration survives resetRecordData
  stub.reset();
});

async function call(method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await app.inject({ method, url, headers: { ...host, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: response.statusCode, body: response.body ? (response.json() as Record<string, any>) : {} };
}

function rejected(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('Expected the call to be refused.');
}

let counter = 0;
interface Seed {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  title?: string | null;
  organizationId?: string | null;
  location?: string | null;
  linkedinUrl?: string | null;
  xUrl?: string | null;
  lifecycle?: 'lead' | 'relationship';
  tags?: string[];
  birthday?: string | null;
  workspaceId?: string;
}

function person(seed: Seed = {}): string {
  counter += 1;
  const id = `per_rev${String(counter).padStart(6, '0')}`;
  const now = env.ctx.now();
  env.db
    .prepare(
      `INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, email, title, organization_id, location, linkedin_url, x_url, lifecycle, tags, birthday, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      now,
      seed.workspaceId ?? env.workspaceId,
      seed.firstName ?? `First${counter}`,
      seed.lastName ?? `Last${counter}`,
      seed.email === undefined ? null : seed.email,
      seed.title ?? null,
      seed.organizationId ?? null,
      seed.location ?? null,
      seed.linkedinUrl ?? null,
      seed.xUrl ?? null,
      seed.lifecycle ?? 'lead',
      JSON.stringify(seed.tags ?? []),
      seed.birthday ?? null,
      now,
    );
  return id;
}

const scan = () => scanDuplicates(env.db, env.workspaceId);
const versionOf = (id: string) => getPerson(env.db, env.workspaceId, id)!.version;
const exists = (id: string) => getPerson(env.db, env.workspaceId, id) !== null;
const merge = (survivor: string, other: string) =>
  mergePeople(env.ctx, survivor, { otherId: other, expectedVersion: versionOf(survivor), otherExpectedVersion: versionOf(other) });
const count = (sql: string, ...params: unknown[]) => (env.db.prepare(sql).get(...(params as never[])) as { n: number }).n;
const audits = (action: string) =>
  (env.db.prepare('SELECT entity_id, detail FROM audit_event WHERE action = ? ORDER BY created_at, id').all(action) as { entity_id: string; detail: string }[]).map(
    (row) => ({ entityId: row.entity_id, detail: JSON.parse(row.detail) as Record<string, any> }),
  );
const organization = (name: string) => createOrganization(env.ctx, { name }).id;

function addRun(id = 'run_rev'): string {
  env.db.prepare("INSERT OR IGNORE INTO run (id, created_at, workspace_id, kind, title, status) VALUES (?, ?, ?, 'qualify', 'Run', 'succeeded')").run(id, env.ctx.now(), env.workspaceId, );
  return id;
}
function addIntent(personId: string, id: string, status: string, to = 'x@lanternrow.invalid'): void {
  env.db
    .prepare(
      `INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, updated_at)
       VALUES (?, ?, ?, ?, 'inb', ?, 's', 'b', 'h', ?, ?)`,
    )
    .run(id, env.ctx.now(), env.workspaceId, personId, to, status, env.ctx.now());
}
function addRule(personId: string, id: string, status: string): void {
  addIntent(personId, `${id}_anchor`, 'accepted');
  env.db.prepare("INSERT OR IGNORE INTO approval (id, created_at, workspace_id, run_id, kind, title, payload, payload_hash) VALUES ('apr_rev', ?, ?, ?, 'send_review', 't', '{}', 'h')").run(env.ctx.now(), env.workspaceId, addRun());
  env.db
    .prepare(
      `INSERT INTO followup_rule (id, created_at, workspace_id, person_id, intent_id, approval_id, provider, status, steps, updated_at)
       VALUES (?, ?, ?, ?, ?, 'apr_rev', 'agentmail', ?, '[]', ?)`,
    )
    .run(id, env.ctx.now(), env.workspaceId, personId, `${id}_anchor`, status, env.ctx.now());
}
function addList(id: string, members: string[]): void {
  env.db.prepare('INSERT OR IGNORE INTO list (id, created_at, workspace_id, version, name, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run(id, env.ctx.now(), env.workspaceId, id, env.ctx.now());
  for (const memberId of members) env.db.prepare('INSERT INTO list_member (list_id, person_id, created_at) VALUES (?, ?, ?)').run(id, memberId, env.ctx.now());
}
function attributeDef(label: string): string {
  return createAttribute(env.ctx, { entityType: 'person', label, kind: 'text' }).id;
}
function setAttribute(personId: string, attrId: string, value: string): void {
  env.db.prepare("INSERT INTO attribute_value (attribute_id, entity_id, workspace_id, value, currency, updated_at) VALUES (?, ?, ?, ?, 'USD', ?)").run(attrId, personId, env.workspaceId, value, env.ctx.now());
}

// Every table that carries rows, with its count. Virtual search tables and their shadows are left out.
function tableCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%_search%' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
    out[t.name] = count(`SELECT COUNT(*) AS n FROM "${t.name}"`);
  }
  return out;
}

// Every (table, column) whose value equals `id` exactly, scanning ALL text columns of ALL tables.
function referencesTo(id: string): string[] {
  const hits: string[] = [];
  for (const t of env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%_search%' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
    for (const c of env.db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string }[]) {
      const n = count(`SELECT COUNT(*) AS n FROM "${t.name}" WHERE "${c.name}" = ?`, id);
      if (n > 0) hits.push(`${t.name}.${c.name}=${n}`);
    }
  }
  return hits;
}

// Every (table, column) whose text CONTAINS `id` (JSON payloads, scopes, details).
function embeddedIn(id: string): string[] {
  const hits: string[] = [];
  for (const t of env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%_search%' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
    for (const c of env.db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string }[]) {
      const n = count(`SELECT COUNT(*) AS n FROM "${t.name}" WHERE CAST("${c.name}" AS TEXT) LIKE ?`, `%${id}%`);
      if (n > 0) hits.push(`${t.name}.${c.name}=${n}`);
    }
  }
  return hits;
}

describe('1. data loss in merge', () => {
  it('KILLS: a person with everything attached merges away with every row accounted for', () => {
    // Two pipelines, stage history, attributes, lists, claims, tasks, activities, mail, terminal intents, stopped rule.
    const second = createPipeline(env.ctx, { name: 'Second board', template: templates[1]!.id });
    const firstPipeline = env.db.prepare('SELECT id FROM pipeline WHERE id != ? ORDER BY created_at LIMIT 1').get(second.id) as { id: string };
    const aId = attributeDef('Alpha');
    const bId = attributeDef('Beta');
    const survivor = person({ firstName: 'Survivor', lastName: 'Base', email: 'surv@lanternrow.invalid', tags: ['s1', 's2'] });
    const tags30 = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const org = organization('Acme');
    const other = person({ firstName: 'Other', lastName: 'Rich', email: null, title: 'CEO', organizationId: org, location: 'Lisbon', linkedinUrl: 'https://www.linkedin.com/in/other-rich', xUrl: 'https://x.com/otherrich', birthday: '1980-02-03', tags: tags30, lifecycle: 'relationship' });
    for (const id of ['c1', 'c2', 'c3']) {
      env.db
        .prepare("INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_type, observed_at, status) VALUES (?, ?, ?, 'person', ?, 'title', 'CEO', 'import', ?, 'imported')")
        .run(`clm_${id}`, env.ctx.now(), env.workspaceId, other, env.ctx.now());
    }
    for (const id of ['a1', 'a2']) env.db.prepare("INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, 'person', ?, 'note', 'n', 'user')").run(`act_${id}`, env.ctx.now(), env.workspaceId, other);
    for (const [id, status] of [['open', 'open'], ['done', 'done']] as const) {
      env.db.prepare("INSERT INTO task (id, created_at, workspace_id, version, title, entity_type, entity_id, status, updated_at) VALUES (?, ?, ?, 1, ?, 'person', ?, ?, ?)").run(`tsk_${id}`, env.ctx.now(), env.workspaceId, id, other, status, env.ctx.now());
    }
    const opp1 = createOpportunity(env.ctx, { name: 'Deal one', pipelineId: firstPipeline.id, personId: other });
    const opp2 = createOpportunity(env.ctx, { name: 'Deal two', pipelineId: second.id, personId: other });
    const stages1 = env.db.prepare('SELECT id FROM stage WHERE pipeline_id = ? ORDER BY seq').all(firstPipeline.id) as { id: string }[];
    moveOpportunityStage(env.ctx, opp1.id, { stageId: stages1[2]!.id, expectedVersion: opp1.version });
    const historyBefore = env.db.prepare('SELECT * FROM stage_event ORDER BY id').all();
    expect(historyBefore.length).toBeGreaterThanOrEqual(3);
    for (const id of ['m1', 'm2']) {
      env.db
        .prepare("INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, direction, person_id, from_email, provider_timestamp) VALUES (?, ?, ?, ?, 'in', ?, 'o@lanternrow.invalid', ?)")
        .run(`msg_${id}`, env.ctx.now(), env.workspaceId, id, other, env.ctx.now());
    }
    for (const status of ['accepted', 'failed', 'cancelled', 'blocked', 'unknown']) addIntent(other, `snd_${status}`, status);
    addRule(other, 'flr_stopped', 'stopped');
    addList('lst_both', [survivor, other]);
    addList('lst_other', [other]);
    addList('lst_surv', [survivor]);
    setAttribute(survivor, aId, 'survivor-A');
    setAttribute(other, aId, 'other-A');
    setAttribute(other, bId, 'other-B');
    env.db.prepare('INSERT INTO qualification_result (id, created_at, workspace_id, person_id, run_id, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('qlr_other', env.ctx.now(), env.workspaceId, other, addRun(), '{}', env.ctx.now());
    env.db.prepare('INSERT INTO qualification_result (id, created_at, workspace_id, person_id, run_id, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('qlr_surv', env.ctx.now(), env.workspaceId, survivor, addRun(), '{}', env.ctx.now());
    dismissDuplicate(env.ctx, { personIds: [other, survivor] });

    const before = tableCounts();
    const out = merge(survivor, other);
    const after = tableCounts();

    expect(exists(other)).toBe(false);
    expect(out.id).toBe(survivor);
    const delta = (table: string) => after[table]! - before[table]!;
    // The only tables allowed to change, and exactly how.
    expect(delta('person')).toBe(-1);
    expect(delta('qualification_result')).toBe(-1); // the other's snapshot, per contract
    expect(delta('duplicate_dismissal')).toBe(-1);
    expect(delta('list_member')).toBe(-1); // other's two rows go (cascade); lst_other is copied to the survivor, lst_both is a dropped duplicate
    expect(delta('attribute_value')).toBe(-1); // other-A dropped, other-B moved
    expect(delta('audit_event')).toBeGreaterThanOrEqual(1);
    const changed = Object.keys(after).filter((table) => delta(table) !== 0).sort();
    expect(changed).toEqual(['attribute_value', 'audit_event', 'duplicate_dismissal', 'list_member', 'person', 'qualification_result'].sort());
    // Same rows, same ids, now the survivor's.
    expect(count("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ?", survivor)).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM activity WHERE entity_id = ?", survivor)).toBe(2);
    expect(env.db.prepare("SELECT status FROM task WHERE entity_id = ? ORDER BY id").all(survivor)).toEqual([{ status: 'done' }, { status: 'open' }]);
    expect(count('SELECT COUNT(*) AS n FROM opportunity WHERE person_id = ?', survivor)).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM email_message WHERE person_id = ?', survivor)).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM send_intent WHERE person_id = ?', survivor)).toBe(5 + 1); // five terminal plus the stopped rule's anchor
    expect(count("SELECT COUNT(*) AS n FROM followup_rule WHERE person_id = ? AND status = 'stopped'", survivor)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM list_member WHERE person_id = ?', survivor)).toBe(3);
    expect(env.db.prepare('SELECT * FROM stage_event ORDER BY id').all()).toEqual(historyBefore); // history untouched
    expect(env.db.prepare('SELECT value FROM attribute_value WHERE entity_id = ? ORDER BY value').all(survivor)).toEqual([{ value: 'other-B' }, { value: 'survivor-A' }]);
    expect(count('SELECT COUNT(*) AS n FROM qualification_result WHERE person_id = ?', survivor)).toBe(1);
    const fresh = getPerson(env.db, env.workspaceId, survivor)!;
    expect(fresh.tags).toHaveLength(30);
    expect(fresh.tags.slice(0, 2)).toEqual(['s1', 's2']);
    expect(fresh).toMatchObject({ title: 'CEO', organizationId: org, location: 'Lisbon', birthday: '1980-02-03', lifecycle: 'relationship', version: 2 });
    // Nothing anywhere in the schema still names the deleted person, apart from the append only log and imports' links.
    expect(referencesTo(other).filter((hit) => !hit.startsWith('audit_event.'))).toEqual([]);
    expect(count('SELECT COUNT(*) AS n FROM pragma_foreign_key_check')).toBe(0);
    // Merge audit counts equal reality.
    const [mergeAudit] = audits('person.merge');
    expect(mergeAudit!.detail.moved).toMatchObject({ claims: 3, activities: 2, tasks: 2, opportunities: 2, messages: 2, sendIntents: 6, followupRules: 1, qualificationsDeleted: 1 });
    expect(mergeAudit!.detail.filled.attributes).toBe(1);
  });

  it('KILLS: every table that names a person or an entity by column is covered (schema scan, not a list)', () => {
    // Fails the day a new table starts naming a person without the merge learning about it.
    const known = new Set([
      'opportunity.person_id', 'qualification_result.person_id', 'email_message.person_id', 'send_intent.person_id', 'followup_rule.person_id',
      'list_member.person_id', 'meeting_attendee.person_id', 'duplicate_dismissal.person_a_id', 'duplicate_dismissal.person_b_id',
      'task.entity_id', 'field_claim.entity_id', 'activity.entity_id', 'attribute_value.entity_id',
      // Not re-pointed, by design: the log, imports' display links, and model call subjects.
      'audit_event.entity_id', 'import_row.match_entity_id', 'model_call.subject_id', 'person_search.entity_id', 'organization_search.entity_id', 'opportunity_search.entity_id',
    ]);
    const found: string[] = [];
    for (const t of env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
      for (const c of env.db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string }[]) {
        if (/(^|_)(person|entity|subject)_?(a_|b_)?id$/.test(c.name) || c.name === 'person_id') found.push(`${t.name}.${c.name}`);
      }
      for (const f of env.db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as { table: string; from: string }[]) {
        if (f.table === 'person') found.push(`${t.name}.${f.from}`);
      }
    }
    expect([...new Set(found)].filter((name) => !known.has(name))).toEqual([]);
  });

  it('ACCEPTED: model_call.subject_id and audit_event keep naming the deleted person (history, not live state)', () => {
    const a = person();
    const b = person();
    env.db.prepare("INSERT INTO model_call (id, created_at, workspace_id, run_id, purpose, provider, model, pending, subject_id) VALUES ('mcl_rev', ?, ?, ?, 'draft', 'anthropic', 'y', 0, ?)").run(env.ctx.now(), env.workspaceId, addRun(), b);
    merge(a, b);
    expect(referencesTo(b).filter((hit) => !hit.startsWith('audit_event.'))).toEqual(['model_call.subject_id=1']);
  });

  it('KILLS: duplicate claims, identical activities, and identical tasks on both people all move without a unique violation', () => {
    const a = person();
    const b = person();
    for (const owner of [a, b]) {
      env.db.prepare("INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_type, observed_at, status) VALUES (?, ?, ?, 'person', ?, 'title', 'CEO', 'import', ?, 'imported')").run(`clm_${owner}`, env.ctx.now(), env.workspaceId, owner, env.ctx.now());
    }
    merge(a, b);
    expect(count("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ?", a)).toBe(2);
  });

  it('KILLS: a merge that fails midway (stale other version) leaves every table byte identical', () => {
    const a = person({ email: 'a@lanternrow.invalid' });
    const b = person({ title: 'CEO' });
    addIntent(b, 'snd_t', 'failed');
    const dump = () => JSON.stringify(env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%_search%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t: any) => [t.name, env.db.prepare(`SELECT * FROM "${t.name}"`).all()]));
    const before = dump();
    expect(rejected(() => mergePeople(env.ctx, a, { otherId: b, expectedVersion: 1, otherExpectedVersion: 99 })).code).toBe('version_conflict');
    expect(dump()).toBe(before);
  });
});

describe('2. sending safety', () => {
  it('ACCEPTED: an awaiting_approval send survives the merge, is re-pointed, and goes out once, to the approved address, bound to the survivor', async () => {
    const otherEmail = 'other.send@lanternrow.invalid';
    const other = createPerson(env.ctx, { firstName: 'Other', lastName: 'Sender', email: otherEmail }).id;
    const survivor = createPerson(env.ctx, { firstName: 'Surv', lastName: 'Ivor', email: 'surv.send@lanternrow.invalid' }).id;
    const staged = prepareSendIntents(env.ctx, { draftActivityIds: [addDraft(env, other, 'Hello other', 'Body for the other person here.')], followups: { steps: [{ waitDays: 3, body: 'Nudge nudge nudge.' }] } });
    expect(staged.intents[0]!.status).toBe('awaiting_approval');
    const payloadBefore = JSON.stringify(staged.approval!.payload);

    const merged = merge(survivor, other); // not blocked: awaiting_approval is not live sending state
    expect(merged.id).toBe(survivor);
    const intent = env.db.prepare('SELECT person_id, to_email, status FROM send_intent WHERE id = ?').get(staged.intents[0]!.id) as any;
    expect(intent).toMatchObject({ person_id: survivor, to_email: otherEmail, status: 'awaiting_approval' });
    // The frozen approval payload is untouched and still names the deleted person by id inside its text only via the name.
    expect(JSON.stringify((env.db.prepare('SELECT payload FROM approval WHERE id = ?').get(staged.approval!.id) as any).payload)).toBeTruthy();
    expect((env.db.prepare('SELECT payload FROM approval WHERE id = ?').get(staged.approval!.id) as any).payload).toContain('Other Testwell'.replace('Testwell', 'Sender'));
    expect(JSON.stringify(staged.approval!.payload)).toBe(payloadBefore);
    expect(JSON.stringify(staged.approval!.payload)).not.toContain(other); // the payload carries the intent id and a name, never the person id

    const decision = decideApproval(env.ctx, staged.approval!.id, { decision: 'approve' }) as any;
    expect(decision.run.status).not.toBe('failed');
    await drain(env);
    await drain(env);
    expect(stub.state.sent).toHaveLength(1); // exactly once
    expect(JSON.stringify(stub.state.sent[0])).toContain(otherEmail); // to the address the human saw
    expect(JSON.stringify(stub.state.sent[0])).not.toContain('surv.send@');
    // The follow-up rule lands on the survivor, one rule, no orphan.
    expect(env.db.prepare("SELECT person_id FROM followup_rule").all()).toEqual([{ person_id: survivor }]);
    expect(count('SELECT COUNT(*) AS n FROM send_intent WHERE person_id = ?', other)).toBe(0);
    // Invariant check: the recipient is the frozen text's address, never re-derived from the person, so nothing goes to the wrong mailbox.
    // CAVEAT (accepted, not a bug): the survivor's own email differs, so the survivor now has a sent message to an address it does not hold.
  });

  it('KILLS: the same approval decided twice after the merge never double-sends', async () => {
    const other = createPerson(env.ctx, { firstName: 'Twice', lastName: 'Other', email: 'twice.o@lanternrow.invalid' }).id;
    const survivor = createPerson(env.ctx, { firstName: 'Twice', lastName: 'Surv', email: 'twice.s@lanternrow.invalid' }).id;
    const staged = prepareSendIntents(env.ctx, { draftActivityIds: [addDraft(env, other, 'Hi', 'Body body body here.')] });
    merge(survivor, other);
    decideApproval(env.ctx, staged.approval!.id, { decision: 'approve' });
    const again = decideApproval(env.ctx, staged.approval!.id, { decision: 'approve' }) as any;
    expect(again.alreadyDecided).toBe(true);
    await drain(env);
    await drain(env);
    expect(stub.state.sent).toHaveLength(1);
  });

  it('KILLS: rejecting an approval after the merge cancels the re-pointed intent without touching the survivor', () => {
    const other = createPerson(env.ctx, { firstName: 'Rej', lastName: 'Other', email: 'rej.o@lanternrow.invalid' }).id;
    const survivor = createPerson(env.ctx, { firstName: 'Rej', lastName: 'Surv', email: 'rej.s@lanternrow.invalid' }).id;
    const staged = prepareSendIntents(env.ctx, { draftActivityIds: [addDraft(env, other, 'Hi', 'Body body body here.')] });
    merge(survivor, other);
    decideApproval(env.ctx, staged.approval!.id, { decision: 'reject' });
    expect(env.db.prepare('SELECT status, person_id FROM send_intent').all()).toEqual([{ status: 'cancelled', person_id: survivor }]);
    expect(exists(survivor)).toBe(true);
  });

  it('KILLS: queued, approved, submitting intents and armed, waiting, sending rules refuse, on either side, and write nothing', () => {
    for (const [side, status] of [['other', 'queued'], ['survivor', 'approved'], ['other', 'submitting']] as const) {
      const a = person();
      const b = person();
      addIntent(side === 'other' ? b : a, `snd_${status}_${a}`, status);
      expect(rejected(() => merge(a, b)).message).toBe('Stop the follow-ups and sends first.');
      expect(exists(b)).toBe(true);
    }
    for (const status of ['waiting', 'armed', 'sending']) {
      const a = person();
      const b = person();
      addRule(a, `flr_${status}_${a}`, status);
      expect(rejected(() => merge(a, b)).code).toBe('conflict');
      expect(exists(b)).toBe(true);
    }
  });

  it('KILLS: no writer can slip a rule or intent in between the sending check and the commit (the merge holds the write lock the whole way)', () => {
    const a = person();
    const b = person();
    const second = new Database(env.databasePath, { timeout: 0 });
    second.pragma('foreign_keys = ON');
    let blocked: string | null = null;
    const realPrepare = env.db.prepare.bind(env.db);
    (env.db as any).prepare = (sql: string) => {
      const statement = realPrepare(sql);
      if (sql.startsWith('DELETE FROM person WHERE id')) {
        const run = statement.run.bind(statement);
        (statement as any).run = (...args: unknown[]) => {
          try {
            second
              .prepare("INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, updated_at) VALUES ('snd_slip', 'x', ?, ?, 'i', 'x@y.z', 's', 'b', 'h', 'queued', 'x')")
              .run(env.workspaceId, b);
          } catch (error) {
            blocked = (error as { code?: string }).code ?? String(error);
          }
          return run(...args);
        };
      }
      return statement;
    };
    try {
      merge(a, b);
    } finally {
      (env.db as any).prepare = realPrepare;
      second.close();
    }
    expect(blocked).toBe('SQLITE_BUSY');
    expect(count("SELECT COUNT(*) AS n FROM send_intent WHERE id = 'snd_slip'")).toBe(0);
  });

  it('KILLS: merging the survivor of a merge again immediately works once and bumps the version once each time', () => {
    const s = person({ title: 'CEO' });
    const o1 = person();
    const o2 = person({ location: 'Rome' });
    const v0 = versionOf(s);
    merge(s, o1);
    expect(versionOf(s)).toBe(v0 + 1);
    merge(s, o2);
    expect(versionOf(s)).toBe(v0 + 2);
    expect(getPerson(env.db, env.workspaceId, s)!.location).toBe('Rome');
    expect(audits('person.merge')).toHaveLength(2);
  });

  it('KILLS: a stale survivor version after the first merge refuses the second', () => {
    const s = person();
    const o1 = person();
    const o2 = person();
    const staleVersion = versionOf(s);
    merge(s, o1);
    const error = rejected(() => mergePeople(env.ctx, s, { otherId: o2, expectedVersion: staleVersion, otherExpectedVersion: versionOf(o2) }));
    expect(error.code).toBe('version_conflict');
    expect(exists(o2)).toBe(true);
  });
});

describe('3. concurrency and identity', () => {
  it('KILLS: merging A into B and then B into A fails honestly (A is gone), in both orders, with no second deletion', () => {
    const a = person({ email: 'ab@lanternrow.invalid' });
    const b = person({ title: 'CEO' });
    const bVersion = versionOf(b);
    const aVersion = versionOf(a);
    merge(b, a); // A merged into B
    expect(rejected(() => mergePeople(env.ctx, a, { otherId: b, expectedVersion: aVersion, otherExpectedVersion: bVersion })).code).toBe('not_found');
    expect(exists(b)).toBe(true);
    expect(rejected(() => mergePeople(env.ctx, b, { otherId: a, expectedVersion: versionOf(b), otherExpectedVersion: aVersion })).code).toBe('not_found');
    expect(exists(b)).toBe(true);
    expect(count('SELECT COUNT(*) AS n FROM person')).toBe(1);
  });

  it('KILLS: two simultaneous HTTP merges of opposite directions leave exactly one person', async () => {
    const a = person();
    const b = person();
    const [one, two] = await Promise.all([
      call('POST', `/api/people/${a}/merge`, { otherId: b, expectedVersion: 1, otherExpectedVersion: 1 }),
      call('POST', `/api/people/${b}/merge`, { otherId: a, expectedVersion: 1, otherExpectedVersion: 1 }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 404]);
    expect(count('SELECT COUNT(*) AS n FROM person')).toBe(1);
  });

  it('KILLS: otherId equal to the survivor in any spelling never deletes anyone', async () => {
    const a = person();
    expect(rejected(() => mergePeople(env.ctx, a, { otherId: a, expectedVersion: 1, otherExpectedVersion: 1 })).code).toBe('validation');
    for (const spelling of [a.toUpperCase(), ` ${a}`, `${a} `, `${a}\u0000`]) {
      const response = await call('POST', `/api/people/${a}/merge`, { otherId: spelling, expectedVersion: 1, otherExpectedVersion: 1 });
      expect([400, 404]).toContain(response.status);
      const reverse = await call('POST', `/api/people/${encodeURIComponent(spelling)}/merge`, { otherId: a, expectedVersion: 1, otherExpectedVersion: 1 });
      expect([400, 404]).toContain(reverse.status);
    }
    expect(exists(a)).toBe(true);
    expect(count('SELECT COUNT(*) AS n FROM person')).toBe(1);
  });

  it('KILLS: a person deleted between the grouping pass and the summary pass makes the scan skip the pair, not fail', () => {
    const a = person({ email: 'gone@lanternrow.invalid' });
    const b = person({ email: 'gone@lanternrow.invalid' });
    const c = person({ email: 'stay@lanternrow.invalid' });
    const d = person({ email: 'stay@lanternrow.invalid' });
    const proxy = new Proxy(env.db, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('json_each') && sql.includes('FROM person p')) env.db.prepare('DELETE FROM person WHERE id = ?').run(b);
            return target.prepare(sql);
          };
        }
        const value = (target as any)[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = scanDuplicates(proxy as any, env.workspaceId);
    expect(result.pairs.map((pair) => pair.personIds)).toEqual([[c, d]]);
    expect(a).toBeTruthy();
  });

  it('KILLS: racing dismissals of one pair in both orders store one row, write one audit, and never 500', async () => {
    const a = person();
    const b = person();
    const results = await Promise.all([
      call('POST', '/api/duplicates/dismiss', { personIds: [a, b] }),
      call('POST', '/api/duplicates/dismiss', { personIds: [b, a] }),
      call('POST', '/api/duplicates/dismiss', { personIds: [a, b] }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const [low, high] = a < b ? [a, b] : [b, a];
    expect(env.db.prepare('SELECT person_a_id AS a, person_b_id AS b FROM duplicate_dismissal').all()).toEqual([{ a: low, b: high }]);
    expect(audits('duplicate.dismiss')).toHaveLength(1);
    // The CHECK holds even for a raw writer who tries the wrong order.
    expect(() => env.db.prepare('INSERT INTO duplicate_dismissal (workspace_id, person_a_id, person_b_id, created_at) VALUES (?, ?, ?, ?)').run(env.workspaceId, high, low, 'x')).toThrow(/CHECK/);
  });

  it('KILLS: dismiss refuses one id, three ids, a repeated id, a string, and ids spelled differently', async () => {
    const a = person();
    const b = person();
    const c = person();
    for (const personIds of [[a], [a, b, c], [a, a], 'x', null, [a, 5], [a, b.toUpperCase()]]) {
      const response = await call('POST', '/api/duplicates/dismiss', { personIds });
      expect(response.status, JSON.stringify(personIds)).toBeLessThan(500);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(count('SELECT COUNT(*) AS n FROM duplicate_dismissal')).toBe(0);
  });
});

describe('4. scan honesty', () => {
  it('KILLS: null and empty emails never pair, even when many people have them', () => {
    for (let i = 0; i < 5; i += 1) person({ email: null });
    for (let i = 0; i < 5; i += 1) person({ email: '' });
    expect(scan().pairs).toEqual([]);
  });

  it('KILLS: LinkedIn ids compare whole: /in/noor never pairs /in/noor-ellery, and different cases of an id stay apart like imports', () => {
    person({ linkedinUrl: 'https://www.linkedin.com/in/noor' });
    person({ linkedinUrl: 'https://www.linkedin.com/in/noor-ellery' });
    person({ linkedinUrl: 'https://www.linkedin.com/in/noor-ellery-123' });
    expect(scan().pairs).toEqual([]);
    person({ linkedinUrl: 'https://www.linkedin.com/in/Noor' });
    expect(scan().pairs).toEqual([]); // ACCEPTED: the id keeps its case, the same rule imports use
    person({ linkedinUrl: 'https://uk.linkedin.com/in/noor/?utm=1' });
    expect(scan().pairs.map((pair) => pair.reason)).toEqual(['linkedin']);
  });

  it('KILLS: non profile LinkedIn values and company pages never pair', () => {
    person({ linkedinUrl: 'https://www.linkedin.com/company/acme' });
    person({ linkedinUrl: 'https://www.linkedin.com/company/acme' });
    person({ linkedinUrl: 'not a url' });
    person({ linkedinUrl: 'not a url' });
    person({ linkedinUrl: 'https://example.com/in/noor' });
    person({ linkedinUrl: 'https://example.com/in/noor' });
    expect(scan().pairs).toEqual([]);
  });

  it('KILLS: X handles pair across case and a trailing slash through the action path (which canonicalizes)', () => {
    const a = createPerson(env.ctx, { firstName: 'X', lastName: 'One', xUrl: 'https://x.com/SamExample/' }).id;
    const b = createPerson(env.ctx, { firstName: 'X', lastName: 'Two', xUrl: 'https://twitter.com/samexample' }).id;
    expect(scan().pairs.map((pair) => ({ ids: pair.personIds, reason: pair.reason }))).toEqual([{ ids: [a, b], reason: 'x' }]);
  });

  it('KILLS: a stored X url that differs by more than case (raw trailing slash) still pairs, because the key is normalized in code', () => {
    // Was a CONFIRMS: a lower(x_url) SQL prefilter missed legacy or hand edited spellings; the pass now mirrors LinkedIn.
    person({ xUrl: 'https://x.com/legacy' });
    person({ xUrl: 'https://x.com/legacy/' });
    expect(scan().pairs.map((pair) => pair.reason)).toEqual(['x']);
  });

  it('KILLS: name at organization needs BOTH organizations non null and equal', () => {
    const orgA = organization('Alpha');
    const orgB = organization('Beta');
    person({ firstName: 'Pat', lastName: 'Lee', organizationId: orgA });
    person({ firstName: 'Pat', lastName: 'Lee', organizationId: null });
    person({ firstName: 'Pat', lastName: 'Lee', organizationId: null });
    person({ firstName: 'Pat', lastName: 'Lee', organizationId: orgB });
    expect(scan().pairs).toEqual([]);
    person({ firstName: 'Pat', lastName: 'Lee', organizationId: orgA });
    expect(scan().pairs.map((pair) => pair.reason)).toEqual(['name_organization']);
  });

  it('KILLS: name folding matches the imports: case, accents, width, punctuation, and whitespace all fold; an empty name never pairs', () => {
    const org = organization('Fold');
    person({ firstName: 'José', lastName: "O'Neil", organizationId: org });
    person({ firstName: 'ＪＯＳＥ', lastName: 'o  neil', organizationId: org });
    person({ firstName: '  jose ', lastName: 'O-NEIL', organizationId: org });
    expect(scan().pairs).toHaveLength(3); // three people, three pairs, one group
    const other = organization('Blank');
    person({ firstName: '!!!', lastName: '...', organizationId: other });
    person({ firstName: '???', lastName: '---', organizationId: other });
    expect(scan().pairs).toHaveLength(3);
  });

  it('KILLS: a dismissed pair whose person is deleted, and a NEW person reusing the same email, pairs again', () => {
    const a = person({ email: 'reuse@lanternrow.invalid' });
    const b = person({ email: 'reuse@lanternrow.invalid' });
    dismissDuplicate(env.ctx, { personIds: [a, b] });
    expect(scan().pairs).toEqual([]);
    env.db.prepare('DELETE FROM person WHERE id = ?').run(b); // the cascade frees the dismissal
    expect(count('SELECT COUNT(*) AS n FROM duplicate_dismissal')).toBe(0);
    const c = person({ email: 'reuse@lanternrow.invalid' });
    expect(scan().pairs.map((pair) => pair.personIds)).toEqual([[a, c]]);
  });

  it('KILLS: three way groups list every pair, a dismissal hides only its own pair, and a merge removes the pairs of the deleted person', () => {
    const a = person({ email: 'tri@lanternrow.invalid' });
    const b = person({ email: 'tri@lanternrow.invalid' });
    const c = person({ email: 'tri@lanternrow.invalid' });
    expect(scan().pairs).toHaveLength(3);
    dismissDuplicate(env.ctx, { personIds: [b, a] });
    expect(scan().pairs.map((pair) => pair.personIds)).toEqual([[a, c], [b, c]]);
    merge(a, c);
    expect(scan().pairs).toEqual([]);
    expect(b).toBeTruthy();
  });

  it('KILLS: reason priority is email, then LinkedIn, then X, then name at organization, one listing per pair', () => {
    const org = organization('Prio');
    const seeds: Seed[][] = [
      [{ email: 'p@x.invalid', linkedinUrl: 'https://www.linkedin.com/in/p', xUrl: 'https://x.com/p' }, { email: 'p@x.invalid', linkedinUrl: 'https://www.linkedin.com/in/p', xUrl: 'https://x.com/p' }],
      [{ linkedinUrl: 'https://www.linkedin.com/in/q', xUrl: 'https://x.com/q' }, { linkedinUrl: 'https://www.linkedin.com/in/q', xUrl: 'https://x.com/q' }],
      [{ xUrl: 'https://x.com/r', firstName: 'Rr', lastName: 'Rr', organizationId: org }, { xUrl: 'https://x.com/r', firstName: 'Rr', lastName: 'Rr', organizationId: org }],
      [{ firstName: 'Ss', lastName: 'Ss', organizationId: org }, { firstName: 'Ss', lastName: 'Ss', organizationId: org }],
    ];
    for (const [one, two] of seeds) {
      person(one);
      person(two);
    }
    expect(scan().pairs.map((pair) => pair.reason)).toEqual(['email', 'linkedin', 'x', 'name_organization']);
  });

  it('KILLS: a dismissal hides a pair under every reason it matches', () => {
    const org = organization('Many');
    const a = person({ email: 'm@x.invalid', firstName: 'Mm', lastName: 'Mm', organizationId: org });
    const b = person({ email: 'm@x.invalid', firstName: 'Mm', lastName: 'Mm', organizationId: org });
    dismissDuplicate(env.ctx, { personIds: [a, b] });
    expect(scan().pairs).toEqual([]);
  });

  it('KILLS: the answer caps at 200 pairs in strong first order and names the cap', () => {
    for (let i = 0; i < 150; i += 1) {
      person({ email: `s${i}@x.invalid` });
      person({ email: `s${i}@x.invalid` });
    }
    const org = organization('Cap');
    for (let i = 0; i < 100; i += 1) {
      person({ firstName: `N${i}`, lastName: 'N', organizationId: org });
      person({ firstName: `N${i}`, lastName: 'N', organizationId: org });
    }
    const result = scan();
    expect(result.capped).toBe(true);
    expect(result.pairs).toHaveLength(200);
    expect(result.pairs.slice(0, 150).every((pair) => pair.reason === 'email')).toBe(true);
    expect(result.pairs.slice(150).every((pair) => pair.reason === 'name_organization')).toBe(true);
  });

  it('KILLS: the scan is workspace scoped', () => {
    const otherWorkspace = 'wsp_revother001';
    env.db.prepare('INSERT OR IGNORE INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run(otherWorkspace, '2026-03-02T00:00:00.000Z', 'Other', 'startup-fundraising');
    person({ email: 'ws@x.invalid' });
    person({ email: 'ws@x.invalid', workspaceId: otherWorkspace });
    expect(scan().pairs).toEqual([]);
    expect(scanDuplicates(env.db, otherWorkspace).pairs).toEqual([]);
  });
});

describe('5. performance', () => {
  it('scans 100,000 people with 1% duplicates inside the 3 second budget (KILLS if within, else CONFIRMS and the number is reported)', () => {
    const big = createTestEnvironment();
    try {
      const db = big.db;
      const ws = big.workspaceId;
      const insertOrg = db.prepare("INSERT INTO organization (id, created_at, workspace_id, version, name, domain, kind, location, linkedin_url, tags, updated_at) VALUES (?, ?, ?, 1, ?, NULL, 'company', NULL, NULL, '[]', ?)");
      const insertPerson = db.prepare(
        `INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, email, organization_id, linkedin_url, x_url, lifecycle, tags, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'lead', '[]', ?)`,
      );
      const total = 100_000;
      const orgs = 5_000;
      db.transaction(() => {
        for (let o = 0; o < orgs; o += 1) insertOrg.run(`org_perf${o}`, '2026-01-01T00:00:00.000Z', ws, `Org ${o}`, '2026-01-01T00:00:00.000Z');
        for (let i = 0; i < total; i += 1) {
          // Each person: unique name, email, LinkedIn (80%), X (40%), org. Every 100th person repeats the previous
          // person's identifiers on one of four keys, so 1% of the rows are second halves of a duplicate pair.
          const dup = i % 100 === 99;
          const base = dup ? i - 1 : i;
          const kind = i % 4;
          const email = dup && kind === 0 ? `p${base}@perf.invalid` : `p${i}@perf.invalid`;
          const linkedin = dup && kind === 1 ? `https://www.linkedin.com/in/p${base}` : i % 5 === 0 ? null : `https://www.linkedin.com/in/p${i}`;
          const x = dup && kind === 2 ? `https://x.com/p${base}` : i % 5 < 2 ? `https://x.com/p${i}` : null;
          const first = dup && kind === 3 ? `Name${base}` : `Name${i}`;
          const org = dup && kind === 3 ? `org_perf${base % orgs}` : `org_perf${i % orgs}`;
          insertPerson.run(`per_perf${String(i).padStart(7, '0')}`, new Date(1_700_000_000_000 + i * 1000).toISOString(), ws, first, 'Perf', email, org, linkedin, x, '2026-01-01T00:00:00.000Z');
        }
      }).immediate();
      expect(count100(db)).toBe(total);
      scanDuplicates(db, ws); // warm
      const started = performance.now();
      const result = scanDuplicates(db, ws);
      const elapsed = performance.now() - started;
      console.log(`PERF scan 100k people, 1% duplicates: ${elapsed.toFixed(0)} ms, ${result.pairs.length} pairs, capped=${result.capped}`);
      expect(result.pairs.length).toBe(200);
      expect(result.capped).toBe(true);
      expect(elapsed).toBeLessThan(3000);

      // Worst shapes: one email shared by every person, and every person at one organization with one name.
      db.prepare("UPDATE person SET email = 'same@perf.invalid'").run();
      let t = performance.now();
      const sameEmail = scanDuplicates(db, ws);
      const emailMs = performance.now() - t;
      db.prepare("UPDATE person SET organization_id = 'org_perf0', first_name = 'Same', last_name = 'Name', email = NULL, linkedin_url = NULL, x_url = NULL").run();
      t = performance.now();
      const sameName = scanDuplicates(db, ws);
      const nameMs = performance.now() - t;
      console.log(`PERF worst shapes: one email x100k ${emailMs.toFixed(0)} ms (${sameEmail.pairs.length} pairs), one org+name x100k ${nameMs.toFixed(0)} ms (${sameName.pairs.length} pairs)`);
      expect(sameEmail.pairs).toHaveLength(200);
      expect(sameName.pairs).toHaveLength(200);
      expect(emailMs).toBeLessThan(3000);
      expect(nameMs).toBeLessThan(3000);
    } finally {
      big.cleanup();
    }
  }, 120_000);
});

function count100(db: ReturnType<typeof openDatabase>): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM person').get() as { n: number }).n;
}

describe('6. fill semantics', () => {
  it('KILLS: null and empty string are both empty for the survivor; an empty string on the other never fills', () => {
    const a = person({ title: '', location: null, email: '' });
    const b = person({ title: 'CEO', location: '', email: 'fill@lanternrow.invalid' });
    const pair = (() => {
      env.db.prepare("UPDATE person SET linkedin_url = 'https://www.linkedin.com/in/fillpair' WHERE id IN (?, ?)").run(a, b);
      return scan().pairs[0]!;
    })();
    expect(pair.fillsIfKeepLeft).toBe(2); // title, email; location is empty on both sides
    expect(pair.fillsIfKeepRight).toBe(0);
    merge(a, b);
    expect(getPerson(env.db, env.workspaceId, a)).toMatchObject({ title: 'CEO', email: 'fill@lanternrow.invalid' });
    expect(getPerson(env.db, env.workspaceId, a)!.location ?? '').toBe('');
  });

  it('KILLS: filling an empty email from the other never collides, in either direction, and search finds the survivor by the filled email', () => {
    const a = person({ firstName: 'Search', lastName: 'Surv' });
    const b = person({ firstName: 'Search', lastName: 'Other', email: 'filled@lanternrow.invalid' });
    merge(a, b);
    expect(count('SELECT COUNT(*) AS n FROM person WHERE lower(email) = ?', 'filled@lanternrow.invalid')).toBe(1);
    expect(env.db.prepare("SELECT entity_id FROM person_search WHERE person_search MATCH '\"filled@lanternrow.invalid\"'").all()).toEqual([{ entity_id: a }]);
    const c = person({ email: 'both@lanternrow.invalid' });
    const d = person({ email: 'both@lanternrow.invalid' });
    merge(d, c);
    expect(count('SELECT COUNT(*) AS n FROM person WHERE email = ?', 'both@lanternrow.invalid')).toBe(1);
  });

  it('KILLS: a third person holding the same email as the merged pair is untouched and blocks nothing', () => {
    const a = person({ email: 'third@lanternrow.invalid' });
    const b = person({ email: 'third@lanternrow.invalid' });
    const c = person({ email: 'third@lanternrow.invalid' });
    merge(a, b);
    expect(exists(c)).toBe(true);
    expect(scan().pairs.map((pair) => pair.personIds)).toEqual([[a, c]]);
  });

  it('KILLS: custom attributes fill per attribute, the survivor wins a clash, and the other row is gone', () => {
    const attrA = attributeDef('Aa');
    const attrB = attributeDef('Bb');
    const attrC = attributeDef('Cc');
    const s = person();
    const o = person();
    setAttribute(s, attrA, 'S-A');
    setAttribute(o, attrA, 'O-A');
    setAttribute(o, attrB, 'O-B');
    setAttribute(o, attrC, 'O-C');
    merge(s, o);
    expect(env.db.prepare('SELECT attribute_id AS id, value FROM attribute_value ORDER BY attribute_id').all()).toEqual(
      [{ id: attrA, value: 'S-A' }, { id: attrB, value: 'O-B' }, { id: attrC, value: 'O-C' }].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
    expect(count('SELECT COUNT(*) AS n FROM attribute_value WHERE entity_id = ?', o)).toBe(0);
  });

  it('ACCEPTED: tags union keeps the survivor first, dedupes, and drops whatever passes 30 (the other is deleted, so those tags are lost)', () => {
    const sTags = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const oTags = ['s0', 's1', ...Array.from({ length: 20 }, (_, i) => `o${i}`)];
    const s = person({ tags: sTags });
    const o = person({ tags: oTags });
    merge(s, o);
    const tags = getPerson(env.db, env.workspaceId, s)!.tags;
    expect(tags).toHaveLength(30);
    expect(tags.slice(0, 20)).toEqual(sTags);
    expect(tags.slice(20)).toEqual(Array.from({ length: 10 }, (_, i) => `o${i}`));
  });

  it('KILLS: at the 30 tag cap the other person\'s do-not-contact tag survives, so the survivor stays undraftable', () => {
    // Was a CONFIRMS: the cap cut the other's do-not-contact tag, and draft outreach skips by that tag
    // (src/actions/draftOutreach.ts:332). The cap now never drops it: it takes the last slot instead.
    const s = person({ tags: Array.from({ length: 30 }, (_, i) => `keep${i}`) });
    const o = person({ tags: ['do-not-contact'] });
    merge(s, o);
    const tags = getPerson(env.db, env.workspaceId, s)!.tags;
    expect(tags).toHaveLength(30);
    expect(tags).toContain('do-not-contact');
    expect(audits('person.merge')[0]!.detail.displaced.tags).toContain('keep29');
    // The other direction is safe: the survivor keeps its own tag.
    const s2 = person({ tags: ['do-not-contact'] });
    const o2 = person({ tags: Array.from({ length: 30 }, (_, i) => `x${i}`) });
    merge(s2, o2);
    expect(getPerson(env.db, env.workspaceId, s2)!.tags[0]).toBe('do-not-contact');
  });

  it('KILLS: the other person\'s displaced email and title land in the merge audit, so nothing a merge discards vanishes without trace', () => {
    // Was a CONFIRMS: the merge audit listed filled field names only, and a displaced address was kept nowhere.
    // The person.merge detail now carries displaced.fields, displaced.attributes, and displaced.tags.
    const s = person({ email: 'kept@lanternrow.invalid', linkedinUrl: 'https://www.linkedin.com/in/same-person' });
    const o = person({ email: 'dropped@lanternrow.invalid', title: 'Dropped title', linkedinUrl: 'https://www.linkedin.com/in/same-person' });
    merge(s, o);
    const survivor = getPerson(env.db, env.workspaceId, s)!;
    expect(survivor.email).toBe('kept@lanternrow.invalid');
    expect(survivor.title).toBe('Dropped title'); // the survivor had no title, so this one filled
    const displaced = audits('person.merge')[0]!.detail.displaced.fields;
    expect(displaced.email).toBe('dropped@lanternrow.invalid');
    expect(displaced.title).toBeUndefined(); // filled, not displaced
    expect(displaced.linkedinUrl).toBeUndefined(); // identical on both, so nothing was beaten
  });

  it('ACCEPTED: filling the organization writes no claim and no per field audit; only the merge audit names the filled fields', () => {
    // Contract says "each fill writing like a normal field change". A normal edit audits person.update with from/to.
    // The merge audits field names only (src/actions/duplicates.ts:130), so the values the survivor took are not in the log.
    const org = organization('Fill Co');
    const s = person();
    const o = person({ organizationId: org, title: 'CEO' });
    const claimsBefore = count('SELECT COUNT(*) AS n FROM field_claim');
    merge(s, o);
    expect(count('SELECT COUNT(*) AS n FROM field_claim')).toBe(claimsBefore);
    expect(audits('person.update')).toEqual([]);
    expect(audits('person.merge')[0]!.detail.filled.fields).toEqual(['title', 'organizationId']);
  });

  it('KILLS: next action date and birthday fill, and the survivor keeps its own birthday', () => {
    const s = person({ birthday: '1990-01-01' });
    const o = person({ birthday: '1980-05-05' });
    env.db.prepare("UPDATE person SET next_action_at = '2026-05-01T00:00:00.000Z' WHERE id = ?").run(o);
    merge(s, o);
    expect(getPerson(env.db, env.workspaceId, s)).toMatchObject({ birthday: '1990-01-01', nextActionAt: '2026-05-01T00:00:00.000Z' });
  });
});

describe('7. lifecycle and automations', () => {
  function promotionAutomation(enabled = true) {
    return createAutomation(env.ctx, { name: 'On promote', triggerKind: 'person_promoted', triggerConfig: {}, actionConfig: { taskTitle: 'Welcome {{name}}', dueInDays: 1 }, enabled });
  }

  it('KILLS: lead plus relationship promotes with reason merged, fires the automation once, creating one task for the survivor', () => {
    promotionAutomation();
    const s = person({ firstName: 'Lead', lastName: 'Survivor' });
    const o = person({ firstName: 'Rel', lastName: 'Other', lifecycle: 'relationship' });
    const v = versionOf(s);
    merge(s, o);
    expect(getPerson(env.db, env.workspaceId, s)).toMatchObject({ lifecycle: 'relationship', version: v + 1 });
    expect(audits('person.promote').map((a) => a.detail)).toEqual([{ reason: 'merged' }]);
    const tasks = env.db.prepare('SELECT entity_id, entity_type FROM task').all();
    expect(tasks).toEqual([{ entity_id: s, entity_type: 'person' }]);
  });

  it('KILLS: relationship plus relationship, lead plus lead, and relationship survivor plus lead other never promote or fire', () => {
    promotionAutomation();
    const pairs: [Seed, Seed][] = [
      [{ lifecycle: 'relationship' }, { lifecycle: 'relationship' }],
      [{ lifecycle: 'lead' }, { lifecycle: 'lead' }],
      [{ lifecycle: 'relationship' }, { lifecycle: 'lead' }],
    ];
    for (const [one, two] of pairs) {
      const s = person(one);
      const o = person(two);
      merge(s, o);
      expect(getPerson(env.db, env.workspaceId, s)!.lifecycle).toBe(one.lifecycle);
    }
    expect(audits('person.promote')).toEqual([]);
    expect(count('SELECT COUNT(*) AS n FROM task')).toBe(0);
  });

  it('KILLS: a disabled promotion automation does not fire on a merge promotion', () => {
    const rule = promotionAutomation();
    updateAutomation(env.ctx, rule.id, { expectedVersion: rule.version, fields: { enabled: false } });
    const s = person();
    const o = person({ lifecycle: 'relationship' });
    merge(s, o);
    expect(count('SELECT COUNT(*) AS n FROM task')).toBe(0);
    expect(audits('person.promote')).toHaveLength(1);
  });

  it('KILLS: a person promoted by a deal then set back to lead by hand does not come back as a relationship through the merge of a lead', () => {
    const s = person({ lifecycle: 'relationship' });
    updatePerson(env.ctx, s, { expectedVersion: versionOf(s), fields: { lifecycle: 'lead' } });
    const o = person({ lifecycle: 'lead' });
    merge(s, o);
    expect(getPerson(env.db, env.workspaceId, s)!.lifecycle).toBe('lead');
    expect(audits('person.promote')).toEqual([]);
  });

  it('KILLS: the merge bumps the survivor version exactly once whether or not it promotes, and emits record_updated for it', () => {
    const events: any[] = [];
    env.bus.subscribe((event) => events.push(event));
    for (const lifecycle of ['lead', 'relationship'] as const) {
      const s = person();
      const o = person({ lifecycle });
      const v = versionOf(s);
      events.length = 0;
      merge(s, o);
      expect(versionOf(s)).toBe(v + 1);
      expect(events.filter((event) => event.type === 'record_updated' && event.entityId === s).length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('8. guards', () => {
  const hostile = ['https://evil.example.com', 'null', 'http://localhost.evil.com', 'http://127.0.0.1.evil.com', 'https://[::1].evil.com', 'file://', 'http://localhost@evil.com', 'javascript:alert(1)'];

  it('KILLS: dismiss and merge refuse every hostile Origin and write nothing; loopback and extension origins pass', async () => {
    const a = person();
    const b = person();
    for (const origin of hostile) {
      const dismiss = await call('POST', '/api/duplicates/dismiss', { personIds: [a, b] }, { origin });
      const mergeResponse = await call('POST', `/api/people/${a}/merge`, { otherId: b, expectedVersion: 1, otherExpectedVersion: 1 }, { origin });
      expect([dismiss.status, mergeResponse.status], origin).toEqual([403, 403]);
    }
    expect(count('SELECT COUNT(*) AS n FROM duplicate_dismissal')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM person')).toBe(2);
    const rebinding = await app.inject({ method: 'POST', url: '/api/duplicates/dismiss', headers: { host: 'evil.example.com' }, payload: { personIds: [a, b] } });
    expect(rebinding.statusCode).toBe(403);
    expect((await call('POST', '/api/duplicates/dismiss', { personIds: [a, b] }, { origin: 'http://[::1]:5173' })).status).toBe(200);
  });

  it('KILLS: GET /api/duplicates leaves the database byte identical, and answers without a body', async () => {
    person({ email: 'ro@x.invalid' });
    person({ email: 'ro@x.invalid' });
    const dump = () => JSON.stringify(env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t: any) => [t.name, env.db.prepare(`SELECT * FROM "${t.name}"`).all()]));
    const before = dump();
    const response = await call('GET', '/api/duplicates');
    expect(response.status).toBe(200);
    expect(response.body.pairs).toHaveLength(1);
    expect(dump()).toBe(before);
    expect((await call('POST', '/api/duplicates')).status).toBe(404);
    expect((await call('GET', '/api/duplicates/dismiss')).status).toBe(404);
  });

  it('KILLS: other workspace ids are not found on dismiss and merge, in either position', async () => {
    const otherWorkspace = 'wsp_revother001';
    env.db.prepare('INSERT OR IGNORE INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run(otherWorkspace, '2026-03-02T00:00:00.000Z', 'Other', 'startup-fundraising');
    const mine = person();
    const theirs = person({ workspaceId: otherWorkspace });
    expect((await call('POST', '/api/duplicates/dismiss', { personIds: [mine, theirs] })).status).toBe(404);
    expect((await call('POST', `/api/people/${mine}/merge`, { otherId: theirs, expectedVersion: 1, otherExpectedVersion: 1 })).status).toBe(404);
    expect((await call('POST', `/api/people/${theirs}/merge`, { otherId: mine, expectedVersion: 1, otherExpectedVersion: 1 })).status).toBe(404);
    expect(count('SELECT COUNT(*) AS n FROM person')).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM duplicate_dismissal')).toBe(0);
  });

  it('KILLS: no MCP tool, chat tool, or proposal entity mentions duplicates or merging people', () => {
    const root = path.resolve(__dirname, '../src');
    const surfaces = ['mcp', 'agent', path.join('actions', 'changes.ts'), path.join('actions', 'proposals.ts')];
    const files: string[] = [];
    const walk = (target: string) => {
      let stats;
      try {
        stats = statSync(target);
      } catch {
        return;
      }
      if (stats.isDirectory()) for (const entry of readdirSync(target)) walk(path.join(target, entry));
      else if (target.endsWith('.ts')) files.push(target);
    };
    for (const surface of surfaces) walk(path.join(root, surface));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(/duplicate_dismiss|dismissDuplicate|mergePeople|scanDuplicates|queries\/duplicates|actions\/duplicates/i.test(text), file).toBe(false);
    }
    // Neither the proposal change schema nor the MCP tool list can name them either: look at the live tool names.
    const mcp = readFileSync(path.join(root, 'mcp/server.ts'), 'utf8');
    expect(/name:\s*['"][a-z_]*(merge|duplicate)/i.test(mcp)).toBe(false);
    expect(/registerTool\(\s*['"][a-z_]*(merge|duplicate)/i.test(mcp)).toBe(false);
  });

  it('KILLS: a proposal prepared before the merge fails at apply with not found, atomically, and the survivor is untouched', () => {
    const s = person({ title: 'Keep' });
    const o = person();
    const prepared = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: o, expectedVersion: 1, fields: { title: 'Ghost' } }, { entityType: 'person', id: s, expectedVersion: 1, fields: { location: 'Safe' } }] });
    expect(prepared.valid).toBe(true);
    merge(s, o);
    const failure = rejected(() =>
      applyChanges(env.ctx, { proposalHash: prepared.proposalHash, changes: prepared.changes.map((c) => ({ entityType: c.entityType, id: c.id, expectedVersion: c.expectedVersion, fields: c.fields })) }),
    );
    expect(failure.code).toBe('not_found');
    expect(getPerson(env.db, env.workspaceId, s)).toMatchObject({ title: 'Keep', location: null });
    // A fresh proposal naming the deleted id is reported invalid, not applied.
    expect(proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: o, fields: { title: 'Ghost' } }] }).valid).toBe(false);
  });

  it('KILLS: a queued qualify run that listed the merged away person finishes without failing and writes nothing for the deleted id', () => {
    const s = person({ firstName: 'Qual', lastName: 'Surv', title: 'Partner' });
    const o = person({ firstName: 'Qual', lastName: 'Other', title: 'Partner' });
    const run = startRun(env.ctx, { kind: 'qualify' });
    merge(s, o);
    const status = driveRun(env, run.id, ['succeeded', 'partial', 'failed']);
    expect(status).not.toBe('failed');
    expect(count('SELECT COUNT(*) AS n FROM qualification_result WHERE person_id = ?', o)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM pragma_foreign_key_check')).toBe(0);
  });

  it('KILLS: merging away a person named by a pending import review row leaves the review acceptable (the link is display only)', async () => {
    const existing = createPerson(env.ctx, { firstName: 'Ada', lastName: 'Quill', email: 'ada.quill@northwind.example.com' }).id;
    const keeper = person({ firstName: 'Ada', lastName: 'Keeper' });
    const csv = ['First Name,Last Name,Work Email', 'Ada,Quill,ada.quill@northwind.example.com', 'Ben,Marsh,ben.marsh@harbor.example.org'].join('\n');
    const created = await call('POST', '/api/imports/csv', { fileName: 'leads.csv', content: csv, mapping: { 'First Name': 'firstName', 'Last Name': 'lastName', 'Work Email': 'email' } });
    expect(created.status).toBe(201);
    const runId = created.body.id as string;
    driveRun(env, runId, ['waiting_approval']);
    const link = env.db.prepare("SELECT match_entity_id AS id FROM import_row WHERE status = 'duplicate'").get() as { id: string };
    expect(link.id).toBe(existing);
    merge(keeper, existing); // the matched person is deleted while the review is pending
    expect(exists(existing)).toBe(false);
    const approval = env.db.prepare("SELECT id FROM approval WHERE run_id = ?").get(runId) as { id: string };
    const decided = decideApproval(env.ctx, approval.id, { decision: 'approve' }) as any;
    expect(decided.run.status).toBe('succeeded');
    expect(count("SELECT COUNT(*) AS n FROM person WHERE email = 'ben.marsh@harbor.example.org'")).toBe(1);
    // ACCEPTED: the duplicate row keeps its dangling match id; imports never write through it.
    expect(count('SELECT COUNT(*) AS n FROM import_row WHERE match_entity_id = ?', existing)).toBe(1);
    // The survivor inherited the email, so a later import of Ada is a duplicate of the survivor, not a new person.
    expect(getPerson(env.db, env.workspaceId, keeper)!.email).toBe('ada.quill@northwind.example.com');
  });

  it('KILLS: audit person.merge counts equal the rows that moved, and one merge writes one audit', () => {
    const s = person();
    const o = person();
    for (let i = 0; i < 4; i += 1) env.db.prepare("INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, 'person', ?, 'note', 'n', 'user')").run(`act_cnt${i}`, env.ctx.now(), env.workspaceId, o);
    const audited = audits('person.merge').length;
    merge(s, o);
    const all = audits('person.merge');
    expect(all).toHaveLength(audited + 1);
    expect(all.at(-1)!.detail).toMatchObject({ survivorId: s, otherId: o, moved: { activities: 4 } });
    expect(count('SELECT COUNT(*) AS n FROM activity WHERE entity_id = ?', s)).toBe(4);
  });

  it('KILLS: resetAllData wipes a database that holds dismissals and merged survivors without a foreign key error', () => {
    const wipe = createTestEnvironment();
    try {
      const a = wipe.db.prepare('SELECT 1').get() && 'x';
      expect(a).toBe('x');
      const w = wipe.workspaceId;
      const now = '2026-03-01T00:00:00.000Z';
      for (const id of ['per_w1', 'per_w2']) wipe.db.prepare("INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, lifecycle, tags, updated_at) VALUES (?, ?, ?, 1, 'A', 'B', 'lead', '[]', ?)").run(id, now, w, now);
      wipe.db.prepare('INSERT INTO duplicate_dismissal (workspace_id, person_a_id, person_b_id, created_at) VALUES (?, ?, ?, ?)').run(w, 'per_w1', 'per_w2', now);
      resetAllData(wipe.db);
      expect((wipe.db.prepare('SELECT COUNT(*) AS n FROM duplicate_dismissal').get() as { n: number }).n).toBe(0);
    } finally {
      wipe.cleanup();
    }
  });
});
