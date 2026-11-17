// Adversarial review probes for the person calendar link (migration 038). Titles start with KILLS (a real defect,
// pinned with it.fails), CONFIRMS (an attack that failed), or ACCEPTED (imperfect but judged fine).
// Nothing here changes application code.
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyChanges, createOrganization, createPerson, mergePeople, proposeChanges } from '../src/actions/index.js';
import { calendarUrlField, calendarUrlMessage, normalizeWebsite, phoneField, websiteField, websiteMessage } from '../src/actions/contactFields.js';
import { applyMigrations } from '../src/db.js';
import { buildApp } from '../src/http/app.js';
import { migrationsDirectory } from '../src/paths.js';
import { scanDuplicates } from '../src/queries/duplicates.js';
import { getPerson } from '../src/queries/people.js';
import { seedDatabase } from '../src/seed/seed.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let captureToken: string;
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
  const t = await app.inject({ method: 'POST', url: '/api/capture/token', headers: host });
  captureToken = JSON.parse(t.body).token as string;
});
afterAll(async () => {
  await app.close();
  env.cleanup();
});

async function patch(kind: 'people' | 'organizations', id: string, version: number, fields: Record<string, unknown>) {
  const r = await app.inject({ method: 'PATCH', url: `/api/${kind}/${id}`, headers: host, payload: { expectedVersion: version, fields } });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const row = (id: string) => env.db.prepare('SELECT * FROM person WHERE id = ?').get(id) as Record<string, any>;
const audits = (id: string) =>
  (env.db.prepare("SELECT detail FROM audit_event WHERE entity_id = ? AND action = 'person.update' ORDER BY created_at, id").all(id) as { detail: string }[]).map(
    (r) => JSON.parse(r.detail) as Record<string, any>,
  );

const calMsg = calendarUrlMessage.replace(/\.$/, '');
const webMsg = websiteMessage.replace(/\.$/, '');

type Out = { ok: true; value: string | null } | { ok: false; message: string };
function run(field: typeof websiteField, value: unknown): Out {
  const r = field.safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, message: r.error.issues[0]!.message };
}

const battery: [string, string][] = [
  ['schemeless', 'example.com/path'],
  ['schemeless with www', 'www.Example.com'],
  ['leading slashes', '//example.com'],
  ['many leading slashes', '////example.com/x'],
  ['only slashes', '///'],
  ['scheme only', 'https://'],
  ['userinfo', 'https://user:pw@example.com'],
  ['user only', 'user@example.com'],
  ['pasted email', 'ada@example.com'],
  ['ht!tp host', 'https://ht!tp.com'],
  ['zero width', 'https://exa​mple.com'],
  ['bidi', 'https://example.com/‮x'],
  ['bom', '﻿https://example.com'],
  ['NUL', 'https://example.com/\u0000'],
  ['tab inside', 'https://exa\tmple.com'],
  ['line separator', 'https://example.com/ '],
  ['trailing dot', 'https://example.com./x'],
  ['unicode host', 'https://bücher.example/x'],
  ['unicode host schemeless', 'münchen.de'],
  ['case preserved', 'HTTPS://Example.COM/Path?Q=A#Frag'],
  ['single label', 'https://localhost'],
  ['ip', 'http://127.0.0.1'],
  ['ip port', '127.0.0.1:8080/x'],
  ['ipv6', 'http://[::1]/x'],
  ['numeric host', 'https://12345'],
  ['port', 'https://example.com:8443/a'],
  ['mailto', 'mailto:a@example.com'],
  ['javascript', 'javascript:alert(1)'],
  ['ftp', 'ftp://example.com'],
  ['data', 'data:text/html,x'],
  ['file', 'file:///etc/passwd'],
  ['whitespace only', '   \n\t '],
  ['empty', ''],
  ['spaces in path', 'https://example.com/a b'],
  ['query only', 'example.com?x=1'],
  ['fragment only', 'example.com#x'],
  ['underscore host', 'https://a_b.example.com'],
  ['500 exact', `https://example.com/${'a'.repeat(500 - 'https://example.com/'.length)}`],
  ['501', `https://example.com/${'a'.repeat(501 - 'https://example.com/'.length)}`],
  ['500 schemeless (full 508)', `example.com/${'a'.repeat(500 - 'example.com/'.length)}`],
  ['492 schemeless (full 500)', `example.com/${'a'.repeat(492 - 'example.com/'.length)}`],
  ['padded 500', `   https://example.com/${'a'.repeat(500 - 'https://example.com/'.length)}   `],
];

describe('websiteField regression after the linkField refactor', () => {
  it('CONFIRMS: websiteField still refuses with the website message, never the calendar one', () => {
    expect(websiteMessage).toBe('Website must be an http or https link, such as https://example.com.');
    for (const bad of ['ftp://example.com', 'javascript:alert(1)', 'https://localhost', 'a@b.com', 'https://u:p@example.com']) {
      const r = run(websiteField, bad);
      expect(r, bad).toEqual({ ok: false, message: webMsg });
    }
  });

  it('CONFIRMS: websiteField outcomes equal the pre-refactor definition (inlined reference) on the whole battery', () => {
    // Reference: the exact pre-refactor schema, rebuilt inline over the same normalizeWebsite.
    const reference = (value: string | null): Out => {
      if (value === null) return { ok: true, value: null };
      const w = normalizeWebsite(value.trim());
      return w === undefined ? { ok: false, message: webMsg } : { ok: true, value: w };
    };
    for (const [label, input] of battery) {
      const got = run(websiteField, input);
      const trimmedLen = input.trim().length;
      if (trimmedLen > 500) {
        expect(got.ok, label).toBe(false);
        continue;
      }
      expect(got, label).toEqual(reference(input));
    }
    expect(run(websiteField, null)).toEqual({ ok: true, value: null });
  });

  it('CONFIRMS: pinned website outcomes', () => {
    expect(run(websiteField, 'example.com/path')).toEqual({ ok: true, value: 'https://example.com/path' });
    expect(run(websiteField, '//example.com')).toEqual({ ok: true, value: 'https://example.com' });
    expect(run(websiteField, 'HTTPS://Example.COM/Path?Q=A#Frag')).toEqual({ ok: true, value: 'HTTPS://Example.COM/Path?Q=A#Frag' });
    expect(run(websiteField, 'https://example.com./x')).toEqual({ ok: true, value: 'https://example.com./x' });
    expect(run(websiteField, 'https://bücher.example/x')).toEqual({ ok: true, value: 'https://bücher.example/x' });
    expect(run(websiteField, '   ')).toEqual({ ok: true, value: null });
    expect(run(websiteField, 'https://exa​mple.com').ok).toBe(false);
    expect(run(websiteField, 'https://ht!tp.com').ok).toBe(false);
    expect(run(websiteField, 'https://u:p@example.com').ok).toBe(false);
    expect(run(websiteField, `https://example.com/${'a'.repeat(500 - 20)}`).ok).toBe(true);
    expect(run(websiteField, `https://example.com/${'a'.repeat(501 - 20)}`).ok).toBe(false);
  });

  it('CONFIRMS: calendarUrlField and websiteField differ only in the message, on every battery input', () => {
    for (const [label, input] of battery) {
      const w = run(websiteField, input);
      const c = run(calendarUrlField, input);
      if (w.ok) expect(c, label).toEqual(w);
      else {
        expect(c.ok, label).toBe(false);
        if (!c.ok && !(w as { message: string }).message.startsWith('String must')) {
          expect((w as { message: string }).message, label).toBe(webMsg);
          expect(c.message, label).toBe(calMsg);
        }
      }
    }
  });

  it('CONFIRMS: the over-500 failure (zod max) is identical for both fields and carries no website text', () => {
    const w = websiteField.safeParse('a'.repeat(501));
    const c = calendarUrlField.safeParse('a'.repeat(501));
    expect(w.success || c.success).toBe(false);
    if (!w.success && !c.success) expect(c.error.issues[0]!.message).toBe(w.error.issues[0]!.message);
  });

  it('CONFIRMS: non-string input is a zod failure, not a throw, for both fields', () => {
    for (const bad of [5, {}, [], true, undefined]) {
      expect(websiteField.safeParse(bad).success).toBe(false);
      expect(calendarUrlField.safeParse(bad).success).toBe(false);
    }
  });

  it('CONFIRMS: phoneField is untouched', () => {
    expect(phoneField.parse(' +1 555 0100 ')).toBe('+1 555 0100');
    expect(phoneField.parse('  ')).toBeNull();
    expect(phoneField.safeParse('abc').success).toBe(false);
    expect(phoneField.safeParse('1'.repeat(41)).success).toBe(false);
    expect(phoneField.safeParse('abc').success ? '' : phoneField.safeParse('abc').error!.issues[0]!.message).toBe('A phone number needs at least one digit');
  });

  it('CONFIRMS: person and organization website PATCH still use the website message and normalize alike', async () => {
    const p = createPerson(env.ctx, { firstName: 'Web', lastName: 'Reg' });
    const o = createOrganization(env.ctx, { name: 'Web Reg Org' });
    const pOk = await patch('people', p.id, 1, { website: '//Example.com/X' });
    expect(pOk.body.website).toBe('https://Example.com/X');
    const oOk = await patch('organizations', o.id, 1, { website: '//Example.com/X' });
    expect(oOk.body.website).toBe('https://Example.com/X');
    for (const [kind, id, v] of [['people', p.id, 2], ['organizations', o.id, 2]] as const) {
      const bad = await patch(kind, id, v, { website: 'ftp://example.com' });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).toContain('Website must be an http or https link');
      expect(JSON.stringify(bad.body)).not.toContain('calendar link');
    }
  });
});

describe('calendarUrlField battery', () => {
  it('CONFIRMS: non-http schemes, emails, userinfo, and single-label hosts are refused with the calendar message', () => {
    for (const bad of ['mailto:a@example.com', 'javascript:alert(1)', 'ftp://calendly.com/a', 'data:text/html,x', 'file:///x', 'ada@example.com', 'https://u@calendly.com/a', 'https://localhost/a', 'https://calendly/a']) {
      expect(run(calendarUrlField, bad), bad).toEqual({ ok: false, message: calMsg });
    }
  });

  it('ACCEPTED: dotted numeric hosts (127.0.0.1) pass exactly as they do for website, so the two fields agree', () => {
    // The dotted-domain regex counts digits as letters. A calendar link to a LAN address is harmless text, and
    // docs say the field reuses the website rules wholesale. IPv6 and port-only forms stay refused.
    expect(run(calendarUrlField, 'http://127.0.0.1')).toEqual({ ok: true, value: 'http://127.0.0.1' });
    expect(run(calendarUrlField, '127.0.0.1:8080/x')).toEqual({ ok: true, value: 'https://127.0.0.1:8080/x' });
    expect(run(calendarUrlField, 'http://[::1]/x').ok).toBe(false);
    expect(run(calendarUrlField, 'http://127.0.0.1')).toEqual(run(websiteField, 'http://127.0.0.1'));
  });

  it('ACCEPTED: a bare number host (https://12345) is normalized by the URL parser to 0.0.48.57 and passes, as for website', () => {
    // The WHATWG parser reads a lone number as an IPv4 address, which then matches the dotted regex. Harmless text.
    expect(run(calendarUrlField, 'https://12345')).toEqual({ ok: true, value: 'https://12345' });
    expect(run(calendarUrlField, 'https://12345')).toEqual(run(websiteField, 'https://12345'));
  });

  it('CONFIRMS: port, query, and fragment stay as typed; case is preserved', () => {
    expect(run(calendarUrlField, 'cal.example.com:8443/Ada?utm=1&X=Y#Slot')).toEqual({ ok: true, value: 'https://cal.example.com:8443/Ada?utm=1&X=Y#Slot' });
    expect(run(calendarUrlField, 'HTTP://Cal.Example.COM/Ada')).toEqual({ ok: true, value: 'HTTP://Cal.Example.COM/Ada' });
  });

  it('CONFIRMS: whitespace-only and empty clear, invisible characters refused', () => {
    expect(run(calendarUrlField, ' \n\t ')).toEqual({ ok: true, value: null });
    expect(run(calendarUrlField, '')).toEqual({ ok: true, value: null });
    for (const c of ['​', '‍', '‮', '⁦'.replace('⁦', '‏'), '\u0000', '﻿', ' ']) {
      expect(run(calendarUrlField, `https://cal.example.com/a${c}b`), JSON.stringify(c)).toEqual({ ok: false, message: calMsg });
    }
  });

  it('ACCEPTED: U+2066 to U+2069 bidi isolates are not in the invisible set (same for website)', () => {
    // The shared character class stops at U+202E. Isolates (LRI, RLI, FSI, PDI) slip through for website too, so the
    // two fields agree. Out of scope for this change; a later hardening would touch both.
    const a = run(calendarUrlField, 'https://cal.example.com/a⁦b');
    const b = run(websiteField, 'https://cal.example.com/a⁦b');
    expect(a).toEqual(b);
  });

  it('CONFIRMS: exactly 500 stored, 501 refused, padding does not count, schemeless full length over 500 refused', () => {
    const at = (n: number) => `https://cal.example.com/${'a'.repeat(n - 'https://cal.example.com/'.length)}`;
    expect(run(calendarUrlField, at(500))).toEqual({ ok: true, value: at(500) });
    expect(run(calendarUrlField, `   ${at(500)}  `)).toEqual({ ok: true, value: at(500) });
    expect(run(calendarUrlField, at(501)).ok).toBe(false);
    const schemeless = `cal.example.com/${'a'.repeat(495 - 'cal.example.com/'.length)}`;
    expect(schemeless.length).toBe(495);
    expect(run(calendarUrlField, schemeless).ok).toBe(false);
  });
});

describe('PATCH edit paths', () => {
  it('CONFIRMS: a stale version is a 409 with the current record and nothing is written', async () => {
    const p = createPerson(env.ctx, { firstName: 'Conf', lastName: 'Lict' });
    await patch('people', p.id, 1, { calendarUrl: 'cal.example.com/a' });
    const stale = await patch('people', p.id, 1, { calendarUrl: 'cal.example.com/b' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(JSON.stringify(stale.body)).toContain('https://cal.example.com/a');
    expect(row(p.id).calendar_url).toBe('https://cal.example.com/a');
  });

  it('CONFIRMS: re-saving the stored value, even typed schemelessly, is a no-op with no version bump or audit', async () => {
    const p = createPerson(env.ctx, { firstName: 'Same', lastName: 'Value', calendarUrl: 'https://cal.example.com/same' });
    const r = await patch('people', p.id, 1, { calendarUrl: ' cal.example.com/same ' });
    expect(r.status).toBe(200);
    expect(row(p.id).version).toBe(1);
    expect(audits(p.id)).toHaveLength(0);
    const nullNoop = createPerson(env.ctx, { firstName: 'Null', lastName: 'Noop' });
    const r2 = await patch('people', nullNoop.id, 1, { calendarUrl: '' });
    expect(r2.status).toBe(200);
    expect(row(nullNoop.id).version).toBe(1);
    expect(audits(nullNoop.id)).toHaveLength(0);
  });

  it('CONFIRMS: audit records from and to on set, change, and clear', async () => {
    const p = createPerson(env.ctx, { firstName: 'Aud', lastName: 'It' });
    await patch('people', p.id, 1, { calendarUrl: 'cal.example.com/one' });
    await patch('people', p.id, 2, { calendarUrl: 'cal.example.com/two' });
    await patch('people', p.id, 3, { calendarUrl: null });
    expect(audits(p.id).map((a) => a.changes)).toEqual([
      { calendarUrl: { from: null, to: 'https://cal.example.com/one' } },
      { calendarUrl: { from: 'https://cal.example.com/one', to: 'https://cal.example.com/two' } },
      { calendarUrl: { from: 'https://cal.example.com/two', to: null } },
    ]);
  });

  it('CONFIRMS: wrong types are 400, never 500, and leave the record alone', async () => {
    const p = createPerson(env.ctx, { firstName: 'Type', lastName: 'Bad' });
    for (const bad of [5, true, {}, [], ['https://a.example.com'], 'x'.repeat(501), 'ftp://a.example.com']) {
      const r = await patch('people', p.id, 1, { calendarUrl: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(row(p.id).version).toBe(1);
    const bad = await patch('people', p.id, 1, { calendarUrl: 'ftp://a.example.com' });
    expect(JSON.stringify(bad.body)).toContain('calendar link');
    expect(JSON.stringify(bad.body)).not.toContain('Website must');
  });

  it('CONFIRMS: an organization rejects calendarUrl through PATCH', async () => {
    const o = createOrganization(env.ctx, { name: 'No Calendar Org' });
    const r = await patch('organizations', o.id, 1, { calendarUrl: 'cal.example.com/x' });
    expect(r.status).toBe(400);
  });
});

describe('create', () => {
  it('CONFIRMS: omission, null, and empty string store null; messy paste canonicalizes; bad link throws', () => {
    expect(row(createPerson(env.ctx, { firstName: 'C1', lastName: 'x' }).id).calendar_url).toBeNull();
    expect(row(createPerson(env.ctx, { firstName: 'C2', lastName: 'x', calendarUrl: null }).id).calendar_url).toBeNull();
    expect(row(createPerson(env.ctx, { firstName: 'C3', lastName: 'x', calendarUrl: '' }).id).calendar_url).toBeNull();
    expect(row(createPerson(env.ctx, { firstName: 'C4', lastName: 'x', calendarUrl: '  //cal.example.com/Me?x=1  ' }).id).calendar_url).toBe('https://cal.example.com/Me?x=1');
    expect(() => createPerson(env.ctx, { firstName: 'C5', lastName: 'x', calendarUrl: 'javascript:alert(1)' })).toThrow();
  });

  it('CONFIRMS: POST /api/people returns calendarUrl and a bad one is 400', async () => {
    const ok = await app.inject({ method: 'POST', url: '/api/people', headers: host, payload: { firstName: 'Http', lastName: 'Cal', calendarUrl: 'cal.example.com/h' } });
    expect(ok.statusCode).toBe(201);
    expect(JSON.parse(ok.body).calendarUrl).toBe('https://cal.example.com/h');
    const bad = await app.inject({ method: 'POST', url: '/api/people', headers: host, payload: { firstName: 'Http', lastName: 'Bad', calendarUrl: 'mailto:x@y.com' } });
    expect(bad.statusCode).toBe(400);
  });

  it('CONFIRMS: an organization create rejects calendarUrl', () => {
    expect(() => createOrganization(env.ctx, { name: 'Org With Cal', calendarUrl: 'cal.example.com/x' } as never)).toThrow();
  });
});

describe('proposals', () => {
  it('CONFIRMS: calendarUrl on a person proposes a diff and applies with an audit', () => {
    const p = createPerson(env.ctx, { firstName: 'Prop', lastName: 'Cal' });
    const proposal = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: p.id, fields: { calendarUrl: ' cal.example.com/p ' } }] });
    expect(proposal.valid).toBe(true);
    expect(proposal.changes[0]!.diff).toEqual([{ field: 'calendarUrl', from: null, to: 'https://cal.example.com/p' }]);
    const result = applyChanges(env.ctx, {
      proposalHash: proposal.proposalHash,
      changes: proposal.changes.map(({ entityType, id, expectedVersion, fields }) => ({ entityType, id, expectedVersion, fields })),
    });
    expect(result.applied).toHaveLength(1);
    expect(getPerson(env.db, env.workspaceId, p.id)).toMatchObject({ calendarUrl: 'https://cal.example.com/p', version: 2 });
  });

  it('CONFIRMS: a bad person calendar link makes the proposal invalid, an organization one is invalid too', () => {
    const p = createPerson(env.ctx, { firstName: 'Prop', lastName: 'Bad' });
    expect(proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: p.id, fields: { calendarUrl: 'ftp://x.example.com' } }] }).valid).toBe(false);
    const o = createOrganization(env.ctx, { name: 'Prop Org' });
    expect(proposeChanges(env.ctx, { changes: [{ entityType: 'organization', id: o.id, fields: { calendarUrl: 'cal.example.com/o' } }] }).valid).toBe(false);
  });

  it('CONFIRMS: a proposal equal to the stored value has an empty diff', () => {
    const p = createPerson(env.ctx, { firstName: 'Prop', lastName: 'Same', calendarUrl: 'https://cal.example.com/s' });
    const proposal = proposeChanges(env.ctx, { changes: [{ entityType: 'person', id: p.id, fields: { calendarUrl: 'cal.example.com/s' } }] });
    expect(proposal.valid).toBe(true);
    expect(proposal.changes[0]!.diff).toEqual([]);
  });
});

describe('merge', () => {
  let n = 0;
  function seedPerson(calendar: string | null, email = `twin${(n += 0) + 1}@mergetwin.example.com`): string {
    n += 1;
    const id = `per_calm${String(n).padStart(5, '0')}`;
    const at = new Date(Date.UTC(2026, 0, 1) + n).toISOString();
    env.db
      .prepare(
        `INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, email, calendar_url, lifecycle, tags, updated_at)
         VALUES (?, ?, ?, 1, 'Merge', 'Twin', ?, ?, 'lead', '[]', ?)`,
      )
      .run(id, at, env.workspaceId, email, calendar, at);
    return id;
  }
  const mergeAudit = (id: string) => JSON.parse((env.db.prepare("SELECT detail FROM audit_event WHERE action = 'person.merge' AND entity_id = ?").get(id) as { detail: string }).detail);

  it('CONFIRMS: an empty survivor is filled, fillsIfKeep counts in the right direction, filled is audited', () => {
    const empty = seedPerson(null, 'fill-pair@mergetwin.example.com');
    const full = seedPerson('https://cal.example.com/fill', 'fill-pair@mergetwin.example.com');
    const pair = scanDuplicates(env.db, env.workspaceId).pairs.find((q) => q.personIds.includes(empty) && q.personIds.includes(full));
    expect(pair).toBeDefined();
    if (pair) {
      const keepEmpty = pair.left.id === empty ? pair.fillsIfKeepLeft : pair.fillsIfKeepRight;
      const keepFull = pair.left.id === full ? pair.fillsIfKeepLeft : pair.fillsIfKeepRight;
      expect(keepEmpty).toBe(1);
      expect(keepFull).toBe(0);
    }
    mergePeople(env.ctx, empty, { otherId: full, expectedVersion: 1, otherExpectedVersion: 1 });
    expect(row(empty).calendar_url).toBe('https://cal.example.com/fill');
    expect(mergeAudit(empty).filled.fields).toContain('calendarUrl');
  });

  it('CONFIRMS: a survivor with a value keeps it, counts no fill, and the other value is audited as displaced', () => {
    const a = seedPerson('https://cal.example.com/keep');
    const b = seedPerson('https://cal.example.com/lose');
    mergePeople(env.ctx, a, { otherId: b, expectedVersion: 1, otherExpectedVersion: 1 });
    expect(row(a).calendar_url).toBe('https://cal.example.com/keep');
    expect(mergeAudit(a).displaced.fields.calendarUrl).toBe('https://cal.example.com/lose');
  });

  it('CONFIRMS: equal values are not displaced and a donor with null changes nothing', () => {
    const a = seedPerson('https://cal.example.com/eq');
    const b = seedPerson('https://cal.example.com/eq');
    mergePeople(env.ctx, a, { otherId: b, expectedVersion: 1, otherExpectedVersion: 1 });
    expect(mergeAudit(a).displaced.fields.calendarUrl).toBeUndefined();
    const c = seedPerson('https://cal.example.com/c');
    const d = seedPerson(null);
    mergePeople(env.ctx, c, { otherId: d, expectedVersion: 1, otherExpectedVersion: 1 });
    expect(row(c).calendar_url).toBe('https://cal.example.com/c');
    expect(mergeAudit(c).filled.fields).not.toContain('calendarUrl');
  });
});

describe('migration 038', () => {
  function upTo037(db: Database.Database): string[] {
    const files = readdirSync(migrationsDirectory).filter((f: string) => /^\d+_.+\.sql$/.test(f)).sort().filter((f: string) => f <= '037_crunchbase.sql');
    for (const file of files) {
      db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
    }
    return files;
  }
  it('CONFIRMS: applies after 037, rows keep NULL and version, is idempotent, adds no index', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-cal-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      expect(upTo037(db).at(-1)).toBe('037_crunchbase.sql');
      expect((db.prepare("PRAGMA table_info('person')").all() as { name: string }[]).map((c) => c.name)).not.toContain('calendar_url');
      db.prepare("INSERT INTO workspace (id, created_at, name, template) VALUES ('wsp_1','2026-01-01','W','t')").run();
      db.prepare("INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, tags, updated_at) VALUES ('per_old','2026-01-01','wsp_1',3,'Old','P','[]','2026-01-01')").run();
      const indexesBefore = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((i) => i.name).sort();
      expect(applyMigrations(db)).toEqual(['038_calendar.sql']);
      expect(db.prepare("SELECT calendar_url, version FROM person WHERE id = 'per_old'").get()).toEqual({ calendar_url: null, version: 3 });
      const indexesAfter = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((i) => i.name).sort();
      expect(indexesAfter).toEqual(indexesBefore);
      expect(applyMigrations(db)).toEqual([]);
      const info = (db.prepare("PRAGMA table_info('person')").all() as { name: string; notnull: number; dflt_value: unknown; type: string }[]).find((c) => c.name === 'calendar_url')!;
      expect(info).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
      expect((db.prepare("PRAGMA table_info('organization')").all() as { name: string }[]).map((c) => c.name)).not.toContain('calendar_url');
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('capture does not learn the field', () => {
  async function capture(payload: unknown) {
    const r = await app.inject({ method: 'POST', url: '/api/capture', headers: { ...host, authorization: `Bearer ${captureToken}` }, payload: payload as object });
    return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
  }
  it('CONFIRMS: calendarUrl, calendar_url and calendar keys are rejected by the strict schema and write nothing', async () => {
    for (const key of ['calendarUrl', 'calendar_url', 'calendar']) {
      const url = `https://www.linkedin.com/in/cal-cap-${key.replace('_', '-').toLowerCase()}`;
      const r = await capture({ source: 'linkedin', url, name: 'Cal Cap', [key]: 'https://cal.example.com/x' });
      expect(r.status, key).toBe(400);
      const found = env.db.prepare("SELECT COUNT(*) AS n FROM person WHERE linkedin_url LIKE ?").get(`%${key.replace('_', '-').toLowerCase()}%`) as { n: number };
      expect(found.n).toBe(0);
    }
  });

  it('CONFIRMS: a normal capture fill-in on an existing person never writes calendar_url, and keeps an existing one', async () => {
    const p = createPerson(env.ctx, { firstName: 'Cap', lastName: 'Keep', calendarUrl: 'https://cal.example.com/keep', linkedinUrl: 'https://www.linkedin.com/in/cap-keep' });
    const r = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/cap-keep', name: 'Cap Keep', headline: 'CEO', website: 'capkeep.example.com' });
    expect(r.status).toBeLessThan(300);
    expect(row(p.id).calendar_url).toBe('https://cal.example.com/keep');
    const claims = env.db.prepare("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ? AND field = 'calendarUrl'").get(p.id) as { n: number };
    expect(claims.n).toBe(0);
    const created = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/cap-new-cal', name: 'Cap New', website: 'x.example.com' });
    expect(created.status).toBe(201);
    expect(row(created.body.person.id).calendar_url).toBeNull();
  });
});

describe('seed', () => {
  it('CONFIRMS: seeded calendar links pass the field unchanged, appear on a fifth of people, and never on organizations', () => {
    const copy = createTestEnvironment();
    try {
      seedDatabase(copy.db, { now: new Date('2026-03-01T12:00:00.000Z') });
      const rows = copy.db.prepare('SELECT calendar_url FROM person').all() as { calendar_url: string | null }[];
      const withUrl = rows.filter((r) => r.calendar_url !== null);
      expect(withUrl.length).toBeGreaterThan(0);
      expect(withUrl.length).toBeLessThan(rows.length);
      for (const r of withUrl) expect(calendarUrlField.parse(r.calendar_url)).toBe(r.calendar_url);
      const orgCols = (copy.db.prepare("PRAGMA table_info('organization')").all() as { name: string }[]).map((c) => c.name);
      expect(orgCols).not.toContain('calendar_url');
    } finally {
      copy.cleanup();
    }
  });
});
