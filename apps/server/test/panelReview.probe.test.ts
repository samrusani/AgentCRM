// Adversarial review probes for POST /api/capture/note (the capture panel wave). A passing probe either CONFIRMS a
// finding (the behavior is real) or KILLS a suspicion (the safety property holds). Nothing here changes app code.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { searchAll } from '../src/queries/search.js';
import { createTestEnvironment, insertSecondWorkspace } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let token: string;
const host = { host: 'localhost:4720' };

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
  token = (await app.inject({ method: 'POST', url: '/api/capture/token', headers: host })).json().token as string;
});
afterAll(async () => {
  await app.close();
  env.cleanup();
});

async function post(url: string, payload: unknown, headers: Record<string, string> = {}, auth: string | null = `Bearer ${token}`) {
  const h: Record<string, string> = { ...host, ...headers };
  if (auth !== null) h.authorization = auth;
  const r = await app.inject({ method: 'POST', url, headers: h, payload: payload as object });
  let body: any = null;
  try { body = JSON.parse(r.body); } catch { body = r.body; }
  return { status: r.statusCode, body, raw: r.body };
}
const note = (p: unknown, h?: Record<string, string>, a?: string | null) => post('/api/capture/note', p, h, a);
const capture = (p: unknown) => post('/api/capture', p);
const n = (sql: string, ...a: unknown[]) => Number((env.db.prepare(sql).get(...a) as { n: number }).n);
const noteBodies = (id: string) => (env.db.prepare("SELECT body FROM activity WHERE entity_id = ? AND kind='note' ORDER BY created_at, id").all(id) as { body: string }[]).map((r) => r.body);

let ada: string;
beforeAll(async () => {
  ada = (await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/AdaProbe', name: 'Ada Probe', email: 'ada.probe@example.com', headline: 'CTO' })).body.person.id;
});

describe('1. write surface', () => {
  it('KILLS: email is not a resolution path (person with email, no profile column, is not reachable)', async () => {
    const id = (await capture({ source: 'x', url: 'https://x.com/emailonly', name: 'Email Only', email: 'eo@example.com' })).body.person.id;
    env.db.prepare('UPDATE person SET x_url = NULL, linkedin_url = NULL WHERE id = ?').run(id);
    const before = n('SELECT COUNT(*) AS n FROM activity');
    for (const [source, url] of [['x', 'https://x.com/emailonly'], ['linkedin', 'https://www.linkedin.com/in/eo@example.com']] as const) {
      expect((await note({ source, url, note: 'x' })).status).toBe(404);
    }
    expect(n('SELECT COUNT(*) AS n FROM activity')).toBe(before);
  });

  it('KILLS: a claim without the column does not resolve (columns only)', async () => {
    const id = (await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/claimonly', name: 'Claim Only' })).body.person.id;
    expect(n("SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ? AND field = 'linkedinUrl'", id)).toBe(1);
    env.db.prepare('UPDATE person SET linkedin_url = NULL WHERE id = ?').run(id);
    expect((await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/claimonly', note: 'x' })).status).toBe(404);
    env.db.prepare("UPDATE person SET linkedin_url = '' WHERE id = ?").run(id);
    expect((await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/claimonly', note: 'x' })).status).toBe(404);
  });

  it('KILLS: the only write is one note activity (person row, claims, tags unchanged; reply is {ok, person:{name}})', async () => {
    const snap = () => JSON.stringify([env.db.prepare('SELECT * FROM person WHERE id = ?').get(ada), n('SELECT COUNT(*) AS n FROM field_claim WHERE entity_id = ?', ada), n('SELECT COUNT(*) AS n FROM person'), n('SELECT COUNT(*) AS n FROM organization')]);
    const before = snap();
    const acts = n('SELECT COUNT(*) AS n FROM activity');
    const r = await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/AdaProbe', note: 'hello' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['ok', 'person']);
    expect(Object.keys(r.body.person)).toEqual(['name']);
    expect(r.raw).not.toContain(ada);
    expect(r.raw).not.toContain('ada.probe@example.com');
    expect(snap()).toBe(before);
    expect(n('SELECT COUNT(*) AS n FROM activity')).toBe(acts + 1);
  });

  it('KILLS: payload cannot smuggle other writes (personId, fields, tags, kind all rejected by strict schema)', async () => {
    for (const extra of [{ personId: ada }, { entityId: ada }, { kind: 'call' }, { tags: ['x'] }, { email: 'a@b.co' }, { claims: [] }]) {
      expect((await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/AdaProbe', note: 'x', ...extra })).status).toBe(400);
    }
    // the stored kind is always note
    expect(n("SELECT COUNT(*) AS n FROM activity WHERE entity_id = ? AND kind <> 'note' AND body = 'x'", ada)).toBe(0);
  });

  it('KILLS: 404 for unknown profile is byte-identical to 404 for a profile that exists only in another workspace', async () => {
    const other = insertSecondWorkspace(env.db);
    env.db.prepare("INSERT INTO person (id, created_at, updated_at, workspace_id, first_name, last_name, linkedin_url, version) VALUES ('per_otherws000000', '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z', ?, 'Other', 'Ws', 'https://www.linkedin.com/in/otherws', 1)").run(other);
    const a = await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/otherws', note: 'x' });
    const b = await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/nobodyatall', note: 'x' });
    expect(a.status).toBe(404);
    expect(a.raw).toBe(b.raw);
    expect(n("SELECT COUNT(*) AS n FROM activity WHERE entity_id = 'per_otherws000000'")).toBe(0);
  });
});

describe('2. note content', () => {
  const url = 'https://www.linkedin.com/in/AdaProbe';
  const audits = () => (env.db.prepare('SELECT * FROM audit_event').all() as unknown[]).map((r) => JSON.stringify(r)).join('\n');

  it('KILLS: a 2000-char note of bidi/control/zero-width chars is rejected as empty, nothing written', async () => {
    const before = n('SELECT COUNT(*) AS n FROM activity');
    const r = await note({ source: 'linkedin', url, note: '‮​\u0000⁦\u0007'.repeat(400) });
    expect(r.status).toBe(400);
    expect(n('SELECT COUNT(*) AS n FROM activity')).toBe(before);
  });

  it('KILLS: bidi chars mixed into text are removed, NUL never reaches storage, search finds the note', async () => {
    const r = await note({ source: 'linkedin', url, note: 'zq\u0000x‮wv​markernul' });
    expect(r.status).toBe(201);
    const stored = noteBodies(ada).at(-1)!;
    expect(stored).toBe('zqxwvmarkernul');
    expect(stored.includes('\0')).toBe(false);
    const hits = searchAll(env.db, env.workspaceId, 'zqxwvmarkernul');
    expect(JSON.stringify(hits)).toContain('zqxwvmarkernul');
    const viaHttp = await app.inject({ method: 'GET', url: '/api/search?q=zqxwvmarkernul', headers: host });
    expect(viaHttp.body).toContain('zqxwvmarkernul');
  });

  it('KILLS: html/script is stored verbatim as text (web renders through React; no innerHTML in apps/web/src)', async () => {
    const t = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    expect((await note({ source: 'linkedin', url, note: t })).status).toBe(201);
    expect(noteBodies(ada).at(-1)).toBe(t);
  });

  it('KILLS: a 2000 char single line with no breaks is accepted; U+2028 survives as data', async () => {
    expect((await note({ source: 'linkedin', url, note: 'w'.repeat(2000) })).status).toBe(201);
    expect((await note({ source: 'linkedin', url, note: 'line sep' })).status).toBe(201);
  });

  it('CONFIRM (minor): length limit counts UTF-16 units, so 1001 astral emoji (1001 chars to a user) is refused', async () => {
    const ok = await note({ source: 'linkedin', url, note: '😀'.repeat(1000) });
    const over = await note({ source: 'linkedin', url, note: '😀'.repeat(1001) });
    expect(ok.status).toBe(201);
    expect(over.status).toBe(400);
  });

  it('KILLS: audit rows never hold note text on any path (success, validation failure, 404, 401)', async () => {
    const marker = 'SECRETMARKER-9f3a';
    await note({ source: 'linkedin', url, note: marker });
    await note({ source: 'linkedin', url, note: marker + 'x'.repeat(2100) });
    await note({ source: 'linkedin', url, note: marker, extra: 1 });
    await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/ghost', note: marker });
    await note({ source: 'linkedin', url, note: marker }, {}, 'Bearer cap_bad');
    await note({ source: 'x', url: 'https://x.com/home', note: marker });
    expect(audits()).not.toContain(marker);
    expect(JSON.stringify(env.db.prepare('SELECT * FROM job').all())).not.toContain(marker);
  });

  it('CONFIRM (docs gap): one save writes TWO audit rows, capture.note and the generic activity.create', async () => {
    const before = n("SELECT COUNT(*) AS n FROM audit_event WHERE entity_id = ? AND action IN ('capture.note','activity.create')", ada);
    await note({ source: 'linkedin', url, note: 'two audits' });
    const after = n("SELECT COUNT(*) AS n FROM audit_event WHERE entity_id = ? AND action IN ('capture.note','activity.create')", ada);
    expect(after - before).toBe(2);
  });
});

describe('3. cross-site surface', () => {
  const payload = { source: 'linkedin', url: 'https://www.linkedin.com/in/AdaProbe', note: 'origin test' };
  it('KILLS: non-loopback web Origin gets 403 and writes nothing; "null" origin too', async () => {
    const before = n('SELECT COUNT(*) AS n FROM activity');
    for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'null', 'https://www.linkedin.com', 'http://127.0.0.1.evil.com']) {
      const r = await note(payload, { origin });
      expect(r.status, origin).toBe(403);
    }
    expect(n('SELECT COUNT(*) AS n FROM activity')).toBe(before);
  });
  it('KILLS: extension origins, loopback origins, and no Origin pass', async () => {
    for (const origin of ['chrome-extension://abcdefghijklmnop', 'moz-extension://x', 'http://localhost:5173', 'http://127.0.0.1:4720']) {
      expect((await note(payload, { origin })).status, origin).toBe(201);
    }
    expect((await note(payload)).status).toBe(201);
  });
  it('KILLS: non-loopback Host refused', async () => {
    expect((await note(payload, { host: 'evil.example' })).status).toBe(403);
    expect((await note(payload, { host: 'localhost.evil.example' })).status).toBe(403);
  });
  it('KILLS: rotation invalidates the old token for notes', async () => {
    const old = token;
    const rotated = (await app.inject({ method: 'POST', url: '/api/capture/token', headers: host })).json().token as string;
    expect((await note(payload, {}, `Bearer ${old}`)).status).toBe(401);
    expect((await note(payload, {}, `Bearer ${rotated}`)).status).toBe(201);
    token = rotated;
  });
  it('KILLS: all four routes really are token guarded and the token cannot reach anything else (people list needs none, stays loopback)', async () => {
    for (const url of ['/api/capture', '/api/capture/verify', '/api/capture/lookup', '/api/capture/note']) {
      expect((await post(url, {}, {}, null)).status, url).toBe(401);
    }
  });
  it('KILLS: guard runs before body parse (malformed JSON without a token is 401 not 400)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/capture/note', headers: { ...host, 'content-type': 'application/json' }, payload: '{not json' });
    expect(r.statusCode).toBe(401);
  });
});

describe('7. server correctness', () => {
  it('KILLS: linkedin ids differing only in case are distinct people; a note never lands on the wrong one', async () => {
    const lower = (await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/casey', name: 'Casey Lower' })).body.person.id;
    const upper = (await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/CASEY', name: 'Casey Upper' })).body.person.id;
    expect(lower).not.toBe(upper);
    expect((await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/CASEY', note: 'to upper' })).body.person.name).toBe('Casey Upper');
    expect((await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/casey', note: 'to lower' })).body.person.name).toBe('Casey Lower');
    expect(noteBodies(upper)).toContain('to upper');
    expect(noteBodies(upper)).not.toContain('to lower');
    expect((await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/CaSeY', note: 'x' })).status).toBe(404);
  });
  it('KILLS: x handle case-insensitive, and an x profile does not resolve through a linkedin source', async () => {
    const id = (await capture({ source: 'x', url: 'https://x.com/XyZ_Probe', name: 'Xyz Probe' })).body.person.id;
    expect((await note({ source: 'x', url: 'https://twitter.com/xyz_PROBE', note: 'x1' })).status).toBe(201);
    expect(noteBodies(id)).toContain('x1');
    expect((await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/xyz_probe', note: 'x2' })).status).toBe(404);
  });
  it('KILLS: 25 concurrent notes to one person all land, none lost, person version unchanged', async () => {
    const v = n('SELECT version AS n FROM person WHERE id = ?', ada);
    const before = noteBodies(ada).length;
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => note({ source: 'linkedin', url: 'https://www.linkedin.com/in/AdaProbe', note: `concurrent ${i}` })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(noteBodies(ada).length).toBe(before + 25);
    expect(n('SELECT version AS n FROM person WHERE id = ?', ada)).toBe(v);
  });
  it('KILLS: a saved note appears in /api/search', async () => {
    await note({ source: 'linkedin', url: 'https://www.linkedin.com/in/AdaProbe', note: 'findable quokka phrase' });
    const r = await app.inject({ method: 'GET', url: '/api/search?q=quokka', headers: host });
    expect(r.body).toContain('quokka');
  });
});
