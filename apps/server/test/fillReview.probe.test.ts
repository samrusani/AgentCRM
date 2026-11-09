// Adversarial probes for recapture fill-in. Names start with KILLS (a safety property holds), CONFIRMS (suspicion
// real, test pins the behavior) or ACCEPTED (documented tradeoff, pinned).
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let token: string;
const host = { host: 'localhost:4720' };

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
  token = JSON.parse((await app.inject({ method: 'POST', url: '/api/capture/token', headers: host })).body).token as string;
});
afterAll(async () => {
  await app.close();
  env.cleanup();
});

async function capture(payload: unknown) {
  const r = await app.inject({ method: 'POST', url: '/api/capture', headers: { ...host, authorization: `Bearer ${token}` }, payload: payload as object });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const person = (id: string) => env.db.prepare('SELECT * FROM person WHERE id = ?').get(id) as Record<string, any>;
const claims = (id: string) => env.db.prepare('SELECT * FROM field_claim WHERE entity_id = ? ORDER BY id').all(id) as Record<string, any>[];
const audits = (id: string, action: string) => env.db.prepare('SELECT detail FROM audit_event WHERE entity_id = ? AND action = ?').all(id, action) as { detail: string }[];
const li = (slug: string) => `https://www.linkedin.com/in/${slug}`;
async function bare(slug: string, extra: Record<string, unknown> = {}) {
  const r = await capture({ source: 'linkedin', url: li(slug), name: 'Probe Person', ...extra });
  expect(r.status).toBe(201);
  return r.body.person.id as string;
}
function plant(id: string, field: string, status: string, value = 'planted') {
  env.db
    .prepare(
      "INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_url, source_type, observed_at, status) VALUES (?, ?, ?, 'person', ?, ?, ?, 'https://x', 'manual', ?, ?)",
    )
    .run(`clm_${Math.random().toString(36).slice(2)}`, new Date().toISOString(), env.workspaceId, id, field, value, new Date().toISOString(), status);
}

describe('1 overwrite paths', () => {
  it('ACCEPTED: a whitespace-only column counts as empty and is filled (nothing a user can type survives trim in the app)', async () => {
    const id = await bare('ws1');
    env.db.prepare("UPDATE person SET title = '   ', location = ' ' WHERE id = ?").run(id);
    const { body } = await capture({ source: 'linkedin', url: li('ws1'), name: 'x', headline: 'H', location: 'L' });
    expect(body.added).toEqual(['title', 'location']);
    expect(person(id).title).toBe('H');
  });

  for (const status of ['extracted', 'corroborated', 'human_confirmed', 'imported']) {
    it(`KILLS: a ${status} claim blocks the fill for every claim-gated field`, async () => {
      const id = await bare(`st-${status}`);
      for (const f of ['title', 'location', 'email', 'website', 'company', 'phone']) plant(id, f, status);
      const { body } = await capture({
        source: 'linkedin', url: li(`st-${status}`), name: 'x',
        headline: 'H', location: 'L', email: `st-${status}@example.com`, website: 'https://w.example', company: 'C', phone: '1 555',
      });
      expect(body.added).toEqual([]);
      expect(person(id).title).toBeNull();
      expect(person(id).email).toBeNull();
    });
  }

  it('CONFIRMS: a claim under a different field-key casing does NOT block (exact match) -- only reachable by hand-inserted rows', async () => {
    const id = await bare('case1');
    plant(id, 'Title', 'human_confirmed');
    const { body } = await capture({ source: 'linkedin', url: li('case1'), name: 'x', headline: 'H' });
    // Pinned honestly: field keys are exact. Flag only if the claim API can create 'Title'.
    expect(body.added).toEqual(['title']);
  });

  it('KILLS: an email-hit person with a different linkedin_url keeps it; x_url likewise', async () => {
    const a = await capture({ source: 'x', url: 'https://x.com/diffli', name: 'D', email: 'diffli@example.com' });
    const id = a.body.person.id as string;
    env.db.prepare("UPDATE person SET linkedin_url = 'https://www.linkedin.com/in/theirs' WHERE id = ?").run(id);
    const r = await capture({ source: 'linkedin', url: li('mine'), name: 'x', email: 'DIFFLI@example.com' });
    expect(r.body.added).toEqual([]);
    expect(person(id).linkedin_url).toBe('https://www.linkedin.com/in/theirs');
    const b = await capture({ source: 'linkedin', url: li('diffx'), name: 'D2', email: 'diffx@example.com' });
    env.db.prepare("UPDATE person SET x_url = 'https://x.com/theirs' WHERE id = ?").run(b.body.person.id);
    const r2 = await capture({ source: 'x', url: 'https://x.com/mine', name: 'x', email: 'diffx@example.com' });
    expect(r2.body.added).toEqual([]);
    expect(person(b.body.person.id).x_url).toBe('https://x.com/theirs');
  });

  it('KILLS: a profile-URL claim with empty column blocks the url fill', async () => {
    const a = await capture({ source: 'x', url: 'https://x.com/claimonly', name: 'C', email: 'claimonly@example.com' });
    const id = a.body.person.id as string;
    plant(id, 'linkedinUrl', 'imported', 'https://www.linkedin.com/in/old');
    const r = await capture({ source: 'linkedin', url: li('new'), name: 'x', email: 'claimonly@example.com' });
    expect(r.body.added).toEqual([]);
    expect(person(id).linkedin_url).toBeNull();
  });

  it('KILLS: name never changes even when payload name differs', async () => {
    const id = await bare('nm1');
    const before = person(id);
    await capture({ source: 'linkedin', url: li('nm1'), name: 'Totally Different', headline: 'H' });
    const after = person(id);
    expect([after.first_name, after.last_name]).toEqual([before.first_name, before.last_name]);
    expect(claims(id).filter((c) => c.field === 'name')).toHaveLength(1);
  });
});

describe('2 email guard', () => {
  it('KILLS: own email under case folding is a no-op, not in added', async () => {
    const id = await bare('own1', { email: 'Own@Example.com' });
    const r = await capture({ source: 'linkedin', url: li('own1'), name: 'x', email: 'OWN@example.COM' });
    expect(r.body.added).toEqual([]);
    expect(person(id).email).toBe('own@example.com');
  });

  it('KILLS: another person email with case + padding is skipped', async () => {
    await capture({ source: 'x', url: 'https://x.com/holder', name: 'Holder', email: 'holder@example.com' });
    const id = await bare('guard2');
    const r = await capture({ source: 'linkedin', url: li('guard2'), name: 'x', email: '  HoLdEr@Example.com ', headline: 'H' });
    expect(r.status).toBe(200);
    // email match => dedupe resolves to the holder (email hit), not guard2: so guard2 is untouched here.
    expect(r.body.person.id).toBe(id);
    expect(r.body.added).toEqual(['title']);
    expect(person(id).email).toBeNull();
  });

  it('CONFIRMS: guard is by COLUMN only; an email living only in another person\'s CLAIM is not guarded or deduped', async () => {
    const holder = await bare('claimholder');
    plant(holder, 'email', 'imported', 'claimheld@example.com'); // column stays empty
    const id = await bare('guard3');
    const r = await capture({ source: 'linkedin', url: li('guard3'), name: 'x', email: 'claimheld@example.com' });
    expect(r.body.added).toEqual(['email']);
    expect(person(id).email).toBe('claimheld@example.com');
    // Two people now carry the same email value (one as claim). Duplicates view will pair them; dedupe is column-based.
  });

  it('KILLS: concurrent same-email captures never 500 and never produce two email columns', async () => {
    const rs = await Promise.all([
      capture({ source: 'linkedin', url: li('race-a'), name: 'A', email: 'race@example.com' }),
      capture({ source: 'linkedin', url: li('race-b'), name: 'B', email: 'Race@example.com' }),
      capture({ source: 'x', url: 'https://x.com/racec', name: 'C', email: 'race@example.com' }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    const n = Number((env.db.prepare("SELECT COUNT(*) AS n FROM person WHERE lower(email) = 'race@example.com'").get() as { n: number }).n);
    expect(n).toBe(1);
  });
});

describe('3 dedupe-order interplay', () => {
  it('KILLS: URL matches A, email belongs to B: A filled sans email, B byte-identical', async () => {
    const b = await capture({ source: 'x', url: 'https://x.com/bperson', name: 'B Person', email: 'b@example.com', headline: 'B title' });
    const bid = b.body.person.id as string;
    const aid = await bare('aperson');
    const snap = () => JSON.stringify([person(bid), claims(bid), audits(bid, 'claim.create'), audits(bid, 'capture.update')]);
    const before = snap();
    const r = await capture({ source: 'linkedin', url: li('aperson'), name: 'x', email: 'B@example.com', headline: 'A title', location: 'Rome' });
    expect(r.body.outcome).toBe('existing');
    expect(r.body.person.id).toBe(aid);
    expect(r.body.added).toEqual(['title', 'location']);
    expect(person(aid).email).toBeNull();
    expect(snap()).toBe(before);
  });

  it('KILLS: email matches B, URL matches nobody: B gets profileUrl and missing fields, existing untouched', async () => {
    const b = await capture({ source: 'x', url: 'https://x.com/bhit', name: 'B Hit', email: 'bhit@example.com', headline: 'Keep Me' });
    const bid = b.body.person.id as string;
    const r = await capture({ source: 'linkedin', url: li('bhit'), name: 'x', email: 'bhit@example.com', headline: 'Overwrite?', location: 'Oslo', phone: '1 555' });
    expect(r.body.person.id).toBe(bid);
    expect(r.body.added).toEqual(['location', 'phone', 'profileUrl']);
    expect(person(bid)).toMatchObject({ title: 'Keep Me', linkedin_url: li('bhit'), location: 'Oslo' });
  });
});

describe('4 atomicity and signals', () => {
  it('KILLS: 5+ claims -> one version bump, one capture.update, one record_updated; zero fill -> zero of each', async () => {
    const id = await bare('atom1');
    const v = person(id).version;
    const ev: DomainEvent[] = [];
    const un = env.bus.subscribe((e) => ev.push(e));
    const r = await capture({ source: 'linkedin', url: li('atom1'), name: 'x', headline: 'H', location: 'L', email: 'atom1@example.com', website: 'https://w.example', company: 'C', phone: '1 555' });
    un();
    expect(r.body.added).toHaveLength(6);
    expect(person(id).version).toBe(v + 1);
    expect(audits(id, 'capture.update')).toHaveLength(1);
    expect(ev.filter((e) => e.type === 'record_updated')).toHaveLength(1);
    const ev2: DomainEvent[] = [];
    const un2 = env.bus.subscribe((e) => ev2.push(e));
    await capture({ source: 'linkedin', url: li('atom1'), name: 'x', headline: 'H2' });
    un2();
    expect(ev2).toHaveLength(0);
    expect(audits(id, 'capture.update')).toHaveLength(1);
  });

  it('KILLS: frame dedupe is scoped per-fill; a second capture in the next request emits its own frame', async () => {
    const id = await bare('atom2');
    const ev: DomainEvent[] = [];
    const un = env.bus.subscribe((e) => ev.push(e));
    await capture({ source: 'linkedin', url: li('atom2'), name: 'x', headline: 'H' });
    await capture({ source: 'linkedin', url: li('atom2'), name: 'x', location: 'L' });
    un();
    expect(ev.filter((e) => e.type === 'record_updated' && e.entityId === id)).toHaveLength(2);
  });

  it('KILLS: a failed fill rolls back everything (no partial column writes)', async () => {
    const id = await bare('atom3');
    env.db.exec("CREATE TRIGGER probe_fail BEFORE INSERT ON field_claim WHEN NEW.field = 'phone' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const before = JSON.stringify([person(id), claims(id)]);
    const r = await capture({ source: 'linkedin', url: li('atom3'), name: 'x', headline: 'H', phone: '1 555' });
    env.db.exec('DROP TRIGGER probe_fail');
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify([person(id), claims(id)])).toBe(before);
  });
});

describe('5 validation and scrub', () => {
  it('KILLS: invalid email/phone on a recapture is rejected like a first capture and writes nothing', async () => {
    const id = await bare('val1');
    const before = JSON.stringify([person(id), claims(id)]);
    for (const extra of [{ email: 'nope' }, { phone: 'abc' }, { headline: 'x'.repeat(201) }, { website: 'w'.repeat(501) }]) {
      const r = await capture({ source: 'linkedin', url: li('val1'), name: 'x', ...extra });
      expect(r.status).toBe(400);
    }
    expect(JSON.stringify([person(id), claims(id)])).toBe(before);
  });

  it('KILLS: hostile values are scrubbed on the fill path, identical to create', async () => {
    const id = await bare('val2');
    const hostile = 'Eng‮ineer​ at\u0000 X';
    const r = await capture({ source: 'linkedin', url: li('val2'), name: 'x', headline: hostile, location: '​‮', company: ' ​ ' });
    expect(r.body.added).toEqual(['title']);
    expect(person(id).title).toBe('Engineer at X');
    const created = await capture({ source: 'linkedin', url: li('val2b'), name: 'y', headline: hostile });
    expect(person(created.body.person.id).title).toBe('Engineer at X');
  });

  it('KILLS: 200-char title fills; added keys are only the documented seven', async () => {
    const id = await bare('val3');
    const r = await capture({ source: 'linkedin', url: li('val3'), name: 'x', headline: 't'.repeat(200), handle: 'h', bio: 'bio text', location: 'L', company: 'C', website: 'https://w.example', phone: '1 5', email: 'val3@example.com' });
    expect(person(id).title).toHaveLength(200);
    expect(new Set(r.body.added)).toEqual(new Set(['title', 'location', 'email', 'website', 'company', 'phone', 'profileUrl'].filter((k) => k !== 'profileUrl')));
    expect(Object.keys(r.body).sort()).toEqual(['added', 'outcome', 'person']);
    expect(Object.keys(r.body.person).sort()).toEqual(['id', 'name']);
  });

  it('CONFIRMS: handle and bio are accepted on a recapture and silently dropped (no note, no claim)', async () => {
    const id = await bare('val4');
    const notes = () => Number((env.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE entity_id = ?").get(id) as { n: number }).n);
    const n = notes();
    await capture({ source: 'linkedin', url: li('val4'), name: 'x', bio: 'new bio', handle: 'hh' });
    expect(notes()).toBe(n);
  });
});

describe('6 token scope', () => {
  it('ACCEPTED: capture.update has keys only; added is a one-bit-per-field emptiness oracle, covered by the token trust framing', async () => {
    const id = await bare('tok1', { headline: 'Secret' });
    const r = await capture({ source: 'linkedin', url: li('tok1'), name: 'x', headline: 'Guess', location: 'L' });
    // Oracle: 'title' absent from added reveals title is non-empty. Writes are additive only; reading values is impossible.
    expect(r.body.added).toEqual(['location']);
    expect(JSON.stringify(r.body)).not.toContain('Secret');
    expect(r.body).not.toHaveProperty('version');
    for (const a of audits(id, 'capture.update')) expect(Object.keys(JSON.parse(a.detail))).toEqual(['fields']);
  });
});

describe('8 regressions', () => {
  it('KILLS: first capture unchanged (created outcome, no added key, claims, capture.person audit)', async () => {
    const r = await capture({ source: 'linkedin', url: li('reg1'), name: 'Reg One', headline: 'H', company: 'C' });
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty('added');
    expect(audits(r.body.person.id, 'capture.person')).toHaveLength(1);
    expect(audits(r.body.person.id, 'capture.update')).toHaveLength(0);
    expect(claims(r.body.person.id).map((c) => c.field).sort()).toEqual(['company', 'linkedinUrl', 'name', 'title']);
  });

  it('KILLS: recapture on x with a different-case handle URL dedupes and does not rewrite x_url', async () => {
    const c = await capture({ source: 'x', url: 'https://x.com/CaseHandle', name: 'CH' });
    const r = await capture({ source: 'x', url: 'https://twitter.com/casehandle', name: 'CH', headline: 'H' });
    expect(r.body.person.id).toBe(c.body.person.id);
    expect(r.body.added).toEqual(['title']);
  });
});
