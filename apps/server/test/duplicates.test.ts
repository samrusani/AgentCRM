import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAutomation,
  createOrganization,
  dismissDuplicate,
  mergePeople,
  resetAllData,
  resetRecordData,
} from '../src/actions/index.js';
import { AppError } from '../src/errors.js';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { getPerson } from '../src/queries/people.js';
import { scanDuplicates } from '../src/queries/duplicates.js';
import { createTestEnvironment, insertSecondWorkspace } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
const events: DomainEvent[] = [];
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  env.bus.subscribe((event) => events.push(event));
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

beforeEach(() => {
  resetRecordData(env.db);
  events.length = 0;
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
interface PersonSeed {
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

// Raw inserts, because the action path refuses the very duplicates these tests need to hold.
function person(seed: PersonSeed = {}): string {
  counter += 1;
  const id = `per_dup${String(counter).padStart(6, '0')}`;
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
      seed.email ?? null,
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
const body = (survivorId: string, otherId: string, over: Record<string, unknown> = {}) => ({
  otherId,
  expectedVersion: versionOf(survivorId),
  otherExpectedVersion: versionOf(otherId),
  ...over,
});
const count = (sql: string, ...params: unknown[]) => (env.db.prepare(sql).get(...(params as never[])) as { n: number }).n;
const audits = (action: string) =>
  (env.db.prepare('SELECT entity_id, detail FROM audit_event WHERE action = ? ORDER BY created_at, id').all(action) as { entity_id: string; detail: string }[]).map(
    (row) => ({ entityId: row.entity_id, detail: JSON.parse(row.detail) as Record<string, any> }),
  );

function organization(name: string): string {
  return createOrganization(env.ctx, { name }).id;
}

function task(personId: string, title: string): void {
  const now = env.ctx.now();
  env.db
    .prepare("INSERT INTO task (id, created_at, workspace_id, version, title, entity_type, entity_id, status, updated_at) VALUES (?, ?, ?, 1, ?, 'person', ?, 'open', ?)")
    .run(`tsk_${title}`, now, env.workspaceId, title, personId, now);
}

function activity(personId: string, id: string): void {
  env.db
    .prepare("INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, 'person', ?, 'note', 'n', 'user')")
    .run(id, env.ctx.now(), env.workspaceId, personId);
}

function claim(personId: string, id: string): void {
  env.db
    .prepare(
      "INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_type, observed_at, status) VALUES (?, ?, ?, 'person', ?, 'title', 'CEO', 'import', ?, 'imported')",
    )
    .run(id, env.ctx.now(), env.workspaceId, personId, env.ctx.now());
}

function deal(personId: string, id: string): void {
  const stage = env.db.prepare('SELECT s.id AS stageId, s.pipeline_id AS pipelineId FROM stage s ORDER BY s.seq LIMIT 1').get() as { stageId: string; pipelineId: string };
  const now = env.ctx.now();
  env.db
    .prepare(
      "INSERT INTO opportunity (id, created_at, workspace_id, version, name, pipeline_id, stage_id, person_id, stage_changed_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, now, env.workspaceId, `Deal ${id}`, stage.pipelineId, stage.stageId, personId, now, now);
}

function message(personId: string, id: string): void {
  env.db
    .prepare(
      `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, direction, person_id, from_email, provider_timestamp) VALUES (?, ?, ?, ?, 'out', ?, 'me@example.com', ?)`,
    )
    .run(id, env.ctx.now(), env.workspaceId, id, personId, env.ctx.now());
}

function run(id = 'run_dup'): string {
  env.db.prepare("INSERT OR IGNORE INTO run (id, created_at, workspace_id, kind, title, status) VALUES (?, ?, ?, 'qualify', 'Run', 'succeeded')").run(id, env.ctx.now(), env.workspaceId);
  return id;
}

function qualification(personId: string, id: string): void {
  env.db
    .prepare('INSERT INTO qualification_result (id, created_at, workspace_id, person_id, run_id, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, env.ctx.now(), env.workspaceId, personId, run(), '{}', env.ctx.now());
}

function intent(personId: string, id: string, status: string): void {
  env.db
    .prepare(
      `INSERT INTO send_intent (id, created_at, workspace_id, person_id, inbox_id, to_email, subject, body, payload_hash, status, updated_at)
       VALUES (?, ?, ?, ?, 'inb', 'x@example.com', 's', 'b', 'h', ?, ?)`,
    )
    .run(id, env.ctx.now(), env.workspaceId, personId, status, env.ctx.now());
}

function rule(personId: string, id: string, status: string): void {
  const anchor = `${id}_intent`;
  intent(personId, anchor, 'accepted');
  env.db
    .prepare("INSERT OR IGNORE INTO approval (id, created_at, workspace_id, run_id, kind, title, payload, payload_hash) VALUES ('apr_dup', ?, ?, ?, 'send_review', 't', '{}', 'h')")
    .run(env.ctx.now(), env.workspaceId, run());
  env.db
    .prepare(
      `INSERT INTO followup_rule (id, created_at, workspace_id, person_id, intent_id, approval_id, provider, status, steps, updated_at)
       VALUES (?, ?, ?, ?, ?, 'apr_dup', 'agentmail', ?, '[]', ?)`,
    )
    .run(id, env.ctx.now(), env.workspaceId, personId, anchor, status, env.ctx.now());
}

function attributeId(key: string): string {
  return (env.db.prepare("SELECT id FROM attribute_def WHERE workspace_id = ? AND entity_type = 'person' AND key = ?").get(env.workspaceId, key) as { id: string }).id;
}

function attribute(personId: string, key: string, value: string): void {
  env.db
    .prepare("INSERT INTO attribute_value (attribute_id, entity_id, workspace_id, value, currency, updated_at) VALUES (?, ?, ?, ?, 'USD', ?)")
    .run(attributeId(key), personId, env.workspaceId, value, env.ctx.now());
}

function list(id: string, memberIds: string[]): void {
  env.db.prepare('INSERT OR IGNORE INTO list (id, created_at, workspace_id, version, name, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run(id, env.ctx.now(), env.workspaceId, id, env.ctx.now());
  for (const memberId of memberIds) env.db.prepare('INSERT INTO list_member (list_id, person_id, created_at) VALUES (?, ?, ?)').run(id, memberId, env.ctx.now());
}

describe('duplicate scan', () => {
  it('finds a pair that shares an email, ignoring case', () => {
    const a = person({ email: 'sam@example.com' });
    const b = person({ email: 'SAM@Example.com' });
    const result = scan();
    expect(result.capped).toBe(false);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ reason: 'email', reasonText: 'Same email address.', personIds: [a, b] });
    expect(result.pairs[0]!.left.id).toBe(a);
    expect(result.pairs[0]!.right.id).toBe(b);
  });

  it('finds a pair that shares a LinkedIn profile across host, case of the host, query, and trailing slash spellings', () => {
    const a = person({ linkedinUrl: 'https://www.linkedin.com/in/sam-example' });
    const b = person({ linkedinUrl: 'https://LinkedIn.com/in/sam-example/?trk=x' });
    const result = scan();
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ reason: 'linkedin', reasonText: 'Same LinkedIn profile.', personIds: [a, b] });
  });

  it('compares LinkedIn ids after decoding percent escapes', () => {
    person({ linkedinUrl: 'https://www.linkedin.com/in/%7Esam' });
    person({ linkedinUrl: 'https://www.linkedin.com/in/~sam' });
    expect(scan().pairs.map((pair) => pair.reason)).toEqual(['linkedin']);
  });

  it('keeps different LinkedIn profiles apart', () => {
    person({ linkedinUrl: 'https://www.linkedin.com/in/one' });
    person({ linkedinUrl: 'https://www.linkedin.com/in/two' });
    expect(scan().pairs).toEqual([]);
  });

  it('finds a pair that shares an X handle regardless of case', () => {
    const a = person({ xUrl: 'https://x.com/SamExample' });
    const b = person({ xUrl: 'https://x.com/samexample' });
    const result = scan();
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ reason: 'x', reasonText: 'Same X handle.', personIds: [a, b] });
  });

  it('finds a pair with the same folded name at the same organization', () => {
    const org = organization('Acme Capital');
    const a = person({ firstName: 'José', lastName: "O'Neil", organizationId: org });
    const b = person({ firstName: 'jose', lastName: 'o neil', organizationId: org });
    const result = scan();
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ reason: 'name_organization', reasonText: 'Same name at the same organization.', personIds: [a, b] });
    expect(result.pairs[0]!.left.organizationName).toBe('Acme Capital');
  });

  it('does not list a pair that shares only a name', () => {
    person({ firstName: 'Sam', lastName: 'Rowe' });
    person({ firstName: 'Sam', lastName: 'Rowe' });
    const orgA = organization('Alpha');
    const orgB = organization('Beta');
    person({ firstName: 'Pat', lastName: 'Lee', organizationId: orgA });
    person({ firstName: 'Pat', lastName: 'Lee', organizationId: orgB });
    expect(scan().pairs).toEqual([]);
  });

  it('does not match a name when either organization is missing', () => {
    const org = organization('Alpha');
    person({ firstName: 'Pat', lastName: 'Lee', organizationId: org });
    person({ firstName: 'Pat', lastName: 'Lee' });
    person({ firstName: 'Kim', lastName: 'Ray' });
    person({ firstName: 'Kim', lastName: 'Ray' });
    expect(scan().pairs).toEqual([]);
  });

  it('lists a pair once under the strongest reason when several match', () => {
    const org = organization('Alpha');
    person({ firstName: 'Pat', lastName: 'Lee', organizationId: org, email: 'pat@example.com', xUrl: 'https://x.com/pat' });
    person({ firstName: 'Pat', lastName: 'Lee', organizationId: org, email: 'pat@example.com', xUrl: 'https://x.com/pat' });
    const result = scan();
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]!.reason).toBe('email');
  });

  it('lists strong identifier pairs before name pairs, oldest pair first inside each group', () => {
    const org = organization('Alpha');
    const n1 = person({ firstName: 'Ann', lastName: 'Ko', organizationId: org });
    const n2 = person({ firstName: 'Ann', lastName: 'Ko', organizationId: org });
    const e1 = person({ email: 'late@example.com' });
    const e2 = person({ email: 'late@example.com' });
    const x1 = person({ xUrl: 'https://x.com/early' });
    const x2 = person({ xUrl: 'https://x.com/early' });
    const result = scan();
    expect(result.pairs.map((pair) => pair.personIds)).toEqual([
      [e1, e2],
      [x1, x2],
      [n1, n2],
    ]);
  });

  it('excludes dismissed pairs and brings the rest', () => {
    const a = person({ email: 'a@example.com' });
    const b = person({ email: 'a@example.com' });
    const c = person({ email: 'c@example.com' });
    const d = person({ email: 'c@example.com' });
    dismissDuplicate(env.ctx, { personIds: [b, a] });
    expect(scan().pairs.map((pair) => pair.personIds)).toEqual([[c, d]]);
  });

  it('carries the summary fields and per person counts', () => {
    const org = organization('Alpha');
    const a = person({ firstName: 'Ann', lastName: 'Ko', email: 'ann@example.com', organizationId: org, linkedinUrl: 'https://www.linkedin.com/in/ann', lifecycle: 'relationship' });
    const b = person({ firstName: 'Ann', lastName: 'Ko', email: 'ann@example.com', title: 'CEO' });
    deal(a, 'opp_1');
    deal(a, 'opp_2');
    task(a, 'one');
    activity(b, 'act_1');
    activity(b, 'act_2');
    activity(b, 'act_3');
    const pair = scan().pairs[0]!;
    expect(pair.left).toMatchObject({
      id: a,
      name: 'Ann Ko',
      email: 'ann@example.com',
      organizationName: 'Alpha',
      linkedinUrl: 'https://www.linkedin.com/in/ann',
      lifecycle: 'relationship',
      version: 1,
      deals: 2,
      tasks: 1,
      activities: 0,
    });
    expect(pair.left.createdAt).toEqual(expect.any(String));
    expect(pair.right).toMatchObject({ id: b, deals: 0, tasks: 0, activities: 3 });
    expect(pair.fillsIfKeepLeft).toBe(1);
    expect(pair.fillsIfKeepRight).toBe(2);
  });

  it('caps the answer at 200 pairs and says so', () => {
    for (let i = 0; i < 201; i += 1) {
      person({ email: `pair${i}@example.com` });
      person({ email: `pair${i}@example.com` });
    }
    const result = scan();
    expect(result.pairs).toHaveLength(200);
    expect(result.capped).toBe(true);
  });

  it('is not capped at exactly 200 pairs', () => {
    for (let i = 0; i < 200; i += 1) {
      person({ email: `pair${i}@example.com` });
      person({ email: `pair${i}@example.com` });
    }
    const result = scan();
    expect(result.pairs).toHaveLength(200);
    expect(result.capped).toBe(false);
  });

  it('never crosses workspaces', () => {
    const other = insertSecondWorkspace(env.db);
    person({ email: 'same@example.com' });
    person({ email: 'same@example.com', workspaceId: other });
    expect(scan().pairs).toEqual([]);
    expect(scanDuplicates(env.db, other).pairs).toEqual([]);
  });
});

describe('dismissDuplicate', () => {
  it('stores the pair once, ordered, with an audit row, and is idempotent', () => {
    const a = person({ email: 'a@example.com' });
    const b = person({ email: 'a@example.com' });
    const [low, high] = [a, b].sort();
    dismissDuplicate(env.ctx, { personIds: [high, low] });
    dismissDuplicate(env.ctx, { personIds: [low, high] });
    expect(env.db.prepare('SELECT person_a_id, person_b_id FROM duplicate_dismissal').all()).toEqual([{ person_a_id: low, person_b_id: high }]);
    expect(audits('duplicate.dismiss')).toEqual([{ entityId: low, detail: { personIds: [low, high] } }]);
  });

  it('refuses the same person twice, an unknown person, a wrong count, and another workspace', () => {
    const a = person();
    const other = insertSecondWorkspace(env.db);
    const foreign = person({ workspaceId: other });
    expect(rejected(() => dismissDuplicate(env.ctx, { personIds: [a, a] })).code).toBe('validation');
    expect(rejected(() => dismissDuplicate(env.ctx, { personIds: [a, 'per_missing'] })).code).toBe('not_found');
    expect(rejected(() => dismissDuplicate(env.ctx, { personIds: [a, foreign] })).code).toBe('not_found');
    expect(rejected(() => dismissDuplicate(env.ctx, { personIds: [a] })).code).toBe('validation');
    expect(rejected(() => dismissDuplicate(env.ctx, { personIds: [a, 'x', 'y'] })).code).toBe('validation');
    expect(count('SELECT COUNT(*) AS n FROM duplicate_dismissal')).toBe(0);
  });

  it('clears the dismissal when either person is deleted', () => {
    const a = person();
    const b = person();
    dismissDuplicate(env.ctx, { personIds: [a, b] });
    env.db.prepare('DELETE FROM person WHERE id = ?').run(a);
    expect(count('SELECT COUNT(*) AS n FROM duplicate_dismissal')).toBe(0);
  });

  it('lets resetAllData wipe a database that holds a dismissal', () => {
    const wipe = createTestEnvironment();
    try {
      const insert = (id: string) =>
        wipe.db
          .prepare("INSERT INTO person (id, created_at, workspace_id, first_name, updated_at) VALUES (?, '2026-03-01', ?, 'P', '2026-03-01')")
          .run(id, wipe.workspaceId);
      insert('per_wipe_a');
      insert('per_wipe_b');
      dismissDuplicate(wipe.ctx, { personIds: ['per_wipe_a', 'per_wipe_b'] });
      expect(wipe.db.prepare('SELECT COUNT(*) AS n FROM duplicate_dismissal').get()).toEqual({ n: 1 });
      expect(() => resetAllData(wipe.db)).not.toThrow();
      for (const table of ['duplicate_dismissal', 'person', 'workspace']) {
        expect(wipe.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
    } finally {
      wipe.cleanup();
    }
  });
});

describe('mergePeople', () => {
  it('emits record_updated for the survivor and record_deleted for the deleted person, after commit', () => {
    const survivor = person({ firstName: 'Ann', email: 'ann@example.com' });
    const other = person({ firstName: 'Annie', email: 'annie@example.com' });
    events.length = 0;
    mergePeople(env.ctx, survivor, body(survivor, other));
    expect(events).toContainEqual({ type: 'record_updated', entityType: 'person', entityId: survivor });
    expect(events).toContainEqual({ type: 'record_deleted', entityType: 'person', entityId: other });
    expect(events.filter((event) => event.type === 'record_deleted')).toHaveLength(1);
  });

  it('emits nothing when the merge is refused', () => {
    const survivor = person({ firstName: 'Ann' });
    const other = person({ firstName: 'Annie' });
    events.length = 0;
    rejected(() => mergePeople(env.ctx, survivor, body(survivor, other, { otherExpectedVersion: 99 })));
    expect(events).toEqual([]);
  });

  it('merges the happy path: fills only empty fields, unions tags and lists, re-points records, deletes the other', () => {
    const survivor = person({ firstName: 'Ann', lastName: '', email: 'ann@example.com', title: 'Partner', tags: ['a', 'b'], location: '' });
    const other = person({ firstName: 'Annie', lastName: 'Ko', email: 'ann@example.com'.replace('ann', 'annie'), title: 'Intern', location: 'London', linkedinUrl: 'https://www.linkedin.com/in/ann', xUrl: 'https://x.com/ann', birthday: '03-04', tags: ['b', 'c'] });
    list('lst_one', [survivor, other]);
    list('lst_two', [other]);
    claim(other, 'clm_1');
    activity(other, 'act_1');
    task(other, 'follow up');
    deal(other, 'opp_1');
    message(other, 'msg_1');
    qualification(other, 'qlr_other');
    qualification(survivor, 'qlr_survivor');
    intent(other, 'sin_old', 'accepted');
    rule(other, 'fru_old', 'stopped');
    const before = versionOf(survivor);

    const merged = mergePeople(env.ctx, survivor, body(survivor, other));

    expect(merged).toMatchObject({
      id: survivor,
      firstName: 'Ann',
      lastName: 'Ko',
      email: 'ann@example.com',
      title: 'Partner',
      location: 'London',
      linkedinUrl: 'https://www.linkedin.com/in/ann',
      xUrl: 'https://x.com/ann',
      birthday: '03-04',
      tags: ['a', 'b', 'c'],
      version: before + 1,
    });
    expect(getPerson(env.db, env.workspaceId, other)).toBeNull();
    expect(env.db.prepare('SELECT list_id FROM list_member WHERE person_id = ? ORDER BY list_id').all(survivor)).toEqual([{ list_id: 'lst_one' }, { list_id: 'lst_two' }]);
    expect(count('SELECT COUNT(*) AS n FROM list_member WHERE person_id = ?', other)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ? AND entity_type = 'person'", survivor)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM activity WHERE entity_id = ?", survivor)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM task WHERE entity_id = ?", survivor)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM opportunity WHERE person_id = ?', survivor)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM email_message WHERE person_id = ?', survivor)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM send_intent WHERE person_id = ?', survivor)).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM followup_rule WHERE person_id = ?', survivor)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM qualification_result WHERE person_id = ?', survivor)).toBe(1);
    expect(env.db.prepare('SELECT id FROM qualification_result').all()).toEqual([{ id: 'qlr_survivor' }]);
    expect(env.db.pragma('foreign_key_check')).toEqual([]);

    const [audit] = audits('person.merge');
    expect(audits('person.merge')).toHaveLength(1);
    expect(audit!.entityId).toBe(survivor);
    expect(audit!.detail).toMatchObject({
      survivorId: survivor,
      otherId: other,
      promoted: false,
      moved: { claims: 1, activities: 1, tasks: 1, opportunities: 1, messages: 1, sendIntents: 2, followupRules: 1, lists: 1, qualificationsDeleted: 1 },
    });
    expect(audit!.detail.filled.fields).toEqual(['lastName', 'location', 'linkedinUrl', 'xUrl', 'birthday']);
    expect(events).toContainEqual({ type: 'record_updated', entityType: 'person', entityId: survivor });
  });

  it('keeps a populated survivor field and a survivor that has the same email without a conflict', () => {
    const survivor = person({ firstName: 'Ann', title: 'Partner' });
    const other = person({ firstName: 'Ann', email: 'ann@example.com', title: 'Intern' });
    const merged = mergePeople(env.ctx, survivor, body(survivor, other));
    expect(merged.title).toBe('Partner');
    expect(merged.email).toBe('ann@example.com');
  });

  it('caps the merged tags at 30, survivor first', () => {
    const survivorTags = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const otherTags = Array.from({ length: 20 }, (_, i) => `o${i}`);
    const survivor = person({ tags: survivorTags });
    const other = person({ tags: otherTags });
    const merged = mergePeople(env.ctx, survivor, body(survivor, other));
    expect(merged.tags).toHaveLength(30);
    expect(merged.tags.slice(0, 20)).toEqual(survivorTags);
    expect(merged.tags.slice(20)).toEqual(otherTags.slice(0, 10));
  });

  it('fills custom attributes per attribute: survivor wins, empty ones fill, the rest go', () => {
    const survivor = person();
    const other = person();
    attribute(survivor, 'message-angle', 'keep me');
    attribute(other, 'message-angle', 'drop me');
    attribute(other, 'fit-notes', 'fill me');
    mergePeople(env.ctx, survivor, body(survivor, other));
    const rows = env.db.prepare('SELECT entity_id, attribute_id, value FROM attribute_value ORDER BY value').all();
    expect(rows).toEqual([
      { entity_id: survivor, attribute_id: attributeId('fit-notes'), value: 'fill me' },
      { entity_id: survivor, attribute_id: attributeId('message-angle'), value: 'keep me' },
    ]);
    expect(audits('person.merge')[0]!.detail.filled.attributes).toBe(1);
  });

  it('removes dismissals that name the other person', () => {
    const survivor = person();
    const other = person();
    const third = person();
    dismissDuplicate(env.ctx, { personIds: [other, third] });
    dismissDuplicate(env.ctx, { personIds: [survivor, other] });
    mergePeople(env.ctx, survivor, body(survivor, other));
    expect(count('SELECT COUNT(*) AS n FROM duplicate_dismissal')).toBe(0);
  });

  it('refuses a stale survivor version with the current record', () => {
    const survivor = person();
    const other = person();
    const error = rejected(() => mergePeople(env.ctx, survivor, body(survivor, other, { expectedVersion: 7 })));
    expect(error.code).toBe('version_conflict');
    expect(error.status).toBe(409);
    expect((error.current as { id: string }).id).toBe(survivor);
    expect(getPerson(env.db, env.workspaceId, other)).not.toBeNull();
  });

  it('refuses a stale other version with the other record', () => {
    const survivor = person();
    const other = person();
    const error = rejected(() => mergePeople(env.ctx, survivor, body(survivor, other, { otherExpectedVersion: 7 })));
    expect(error.code).toBe('version_conflict');
    expect((error.current as { id: string }).id).toBe(other);
  });

  it('refuses a person merged into themselves, an unknown id, and another workspace', () => {
    const survivor = person();
    const other = insertSecondWorkspace(env.db);
    const foreign = person({ workspaceId: other });
    expect(rejected(() => mergePeople(env.ctx, survivor, { otherId: survivor, expectedVersion: 1, otherExpectedVersion: 1 })).code).toBe('validation');
    expect(rejected(() => mergePeople(env.ctx, survivor, { otherId: 'per_missing', expectedVersion: 1, otherExpectedVersion: 1 })).code).toBe('not_found');
    expect(rejected(() => mergePeople(env.ctx, 'per_missing', { otherId: survivor, expectedVersion: 1, otherExpectedVersion: 1 })).code).toBe('not_found');
    expect(rejected(() => mergePeople(env.ctx, survivor, { otherId: foreign, expectedVersion: 1, otherExpectedVersion: 1 })).code).toBe('not_found');
    expect(count('SELECT COUNT(*) AS n FROM person')).toBe(2);
  });

  it('refuses an unknown body field', () => {
    const survivor = person();
    const other = person();
    expect(rejected(() => mergePeople(env.ctx, survivor, body(survivor, other, { extra: 1 }))).code).toBe('validation');
  });

  for (const status of ['waiting', 'armed', 'sending']) {
    it(`refuses while the other person has a ${status} follow-up rule`, () => {
      const survivor = person();
      const other = person();
      rule(other, 'fru_live', status);
      const error = rejected(() => mergePeople(env.ctx, survivor, body(survivor, other)));
      expect(error.code).toBe('conflict');
      expect(error.status).toBe(409);
      expect(error.message).toBe('Stop the follow-ups and sends first.');
      expect(getPerson(env.db, env.workspaceId, other)).not.toBeNull();
    });
  }

  it('refuses while the survivor has an active follow-up rule', () => {
    const survivor = person();
    const other = person();
    rule(survivor, 'fru_live', 'armed');
    expect(rejected(() => mergePeople(env.ctx, survivor, body(survivor, other))).message).toBe('Stop the follow-ups and sends first.');
  });

  for (const status of ['queued', 'approved', 'submitting']) {
    it(`refuses while either person has a ${status} send intent`, () => {
      const survivor = person();
      const other = person();
      intent(other, 'sin_live', status);
      expect(rejected(() => mergePeople(env.ctx, survivor, body(survivor, other))).message).toBe('Stop the follow-ups and sends first.');
      env.db.prepare('UPDATE send_intent SET person_id = ?').run(survivor);
      expect(rejected(() => mergePeople(env.ctx, survivor, body(survivor, other))).code).toBe('conflict');
      expect(count('SELECT COUNT(*) AS n FROM person')).toBe(2);
    });
  }

  it('does not refuse for a stopped rule or terminal intents, and re-points them', () => {
    const survivor = person();
    const other = person();
    rule(other, 'fru_done', 'done');
    rule(other, 'fru_stopped', 'stopped');
    rule(other, 'fru_expired', 'expired');
    for (const status of ['accepted', 'failed', 'cancelled', 'blocked', 'replied', 'bounced']) intent(other, `sin_${status}`, status);
    mergePeople(env.ctx, survivor, body(survivor, other));
    expect(count('SELECT COUNT(*) AS n FROM followup_rule WHERE person_id = ?', survivor)).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM send_intent WHERE person_id = ?', survivor)).toBe(9);
    expect(count('SELECT COUNT(*) AS n FROM send_intent WHERE person_id = ?', other)).toBe(0);
  });

  it('promotes a lead survivor with reason merged and fires person_promoted automations', () => {
    createAutomation(env.ctx, {
      name: 'Welcome a relationship',
      triggerKind: 'person_promoted',
      triggerConfig: {},
      actionConfig: { taskTitle: 'Say hello to {name}', dueInDays: 0 },
    });
    const survivor = person({ firstName: 'Ann', lastName: 'Ko', lifecycle: 'lead' });
    const other = person({ firstName: 'Ann', lastName: 'Ko', lifecycle: 'relationship' });
    const merged = mergePeople(env.ctx, survivor, body(survivor, other));
    expect(merged.lifecycle).toBe('relationship');
    expect(merged.version).toBe(2);
    expect(audits('person.promote')).toEqual([{ entityId: survivor, detail: { reason: 'merged' } }]);
    expect(audits('person.merge')[0]!.detail.promoted).toBe(true);
    expect(env.db.prepare("SELECT title, entity_id FROM task WHERE title LIKE 'Say hello%'").all()).toEqual([{ title: 'Say hello to Ann Ko', entity_id: survivor }]);
    expect(count("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'automation.fire'")).toBe(1);
  });

  it('does not promote or fire anything when the survivor is already a relationship', () => {
    createAutomation(env.ctx, {
      name: 'Welcome a relationship',
      triggerKind: 'person_promoted',
      triggerConfig: {},
      actionConfig: { taskTitle: 'Say hello to {name}', dueInDays: 0 },
    });
    const survivor = person({ lifecycle: 'relationship' });
    const other = person({ lifecycle: 'lead' });
    const merged = mergePeople(env.ctx, survivor, body(survivor, other));
    expect(merged.lifecycle).toBe('relationship');
    expect(merged.version).toBe(2);
    expect(audits('person.promote')).toEqual([]);
    expect(count('SELECT COUNT(*) AS n FROM task')).toBe(0);
  });

  it('keeps a lead survivor a lead when the other is a lead too', () => {
    const survivor = person();
    const other = person();
    expect(mergePeople(env.ctx, survivor, body(survivor, other)).lifecycle).toBe('lead');
  });

  it('writes nothing when it is refused partway', () => {
    const survivor = person({ title: null });
    const other = person({ title: 'CEO' });
    claim(other, 'clm_x');
    rule(other, 'fru_live', 'armed');
    expect(() => mergePeople(env.ctx, survivor, body(survivor, other))).toThrow();
    expect(count("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ?", other)).toBe(1);
    expect(getPerson(env.db, env.workspaceId, survivor)!.title).toBeNull();
    expect(audits('person.merge')).toEqual([]);
  });
});

describe('duplicate routes', () => {
  it('serves GET /api/duplicates without writing anything', async () => {
    person({ email: 'a@example.com' });
    person({ email: 'a@example.com' });
    const tables = ['person', 'audit_event', 'duplicate_dismissal', 'activity', 'task', 'job'];
    const snapshot = () => JSON.stringify(tables.map((table) => env.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    const before = snapshot();
    const response = await call('GET', '/api/duplicates');
    expect(response.status).toBe(200);
    expect(response.body.capped).toBe(false);
    expect(response.body.pairs).toHaveLength(1);
    expect(response.body.pairs[0].reasonText).toBe('Same email address.');
    expect(snapshot()).toBe(before);
  });

  it('dismisses and merges over HTTP', async () => {
    const a = person({ email: 'a@example.com' });
    const b = person({ email: 'a@example.com' });
    const c = person({ email: 'c@example.com' });
    const d = person({ email: 'c@example.com' });
    expect((await call('POST', '/api/duplicates/dismiss', { personIds: [a, b] })).status).toBe(200);
    expect((await call('GET', '/api/duplicates')).body.pairs).toHaveLength(1);
    const merged = await call('POST', `/api/people/${c}/merge`, { otherId: d, expectedVersion: 1, otherExpectedVersion: 1 });
    expect(merged.status).toBe(200);
    expect(merged.body.id).toBe(c);
    expect((await call('GET', '/api/duplicates')).body.pairs).toHaveLength(0);
  });

  it('answers a stale version with 409 version_conflict and a refused sending state with 409 conflict', async () => {
    const a = person();
    const b = person();
    const stale = await call('POST', `/api/people/${a}/merge`, { otherId: b, expectedVersion: 5, otherExpectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    rule(b, 'fru_live', 'waiting');
    const live = await call('POST', `/api/people/${a}/merge`, { otherId: b, expectedVersion: 1, otherExpectedVersion: 1 });
    expect(live.status).toBe(409);
    expect(live.body.error).toMatchObject({ code: 'conflict', message: 'Stop the follow-ups and sends first.' });
  });

  it('refuses both writes from a web page on another origin', async () => {
    const a = person();
    const b = person();
    const origin = { origin: 'https://evil.example.com' };
    const dismiss = await call('POST', '/api/duplicates/dismiss', { personIds: [a, b] }, origin);
    const merge = await call('POST', `/api/people/${a}/merge`, { otherId: b, expectedVersion: 1, otherExpectedVersion: 1 }, origin);
    expect(dismiss.status).toBe(403);
    expect(merge.status).toBe(403);
    expect(count('SELECT COUNT(*) AS n FROM duplicate_dismissal')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM person')).toBe(2);
    const local = await call('POST', '/api/duplicates/dismiss', { personIds: [a, b] }, { origin: 'http://localhost:5173' });
    expect(local.status).toBe(200);
  });
});
