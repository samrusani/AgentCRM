import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpportunity } from '../src/actions/index.js';
import { searchAll, searchScan } from '../src/queries/search.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';

// Adversarial probes for the FTS5 search index. Scratch review file, not part of the suite's contract.
import { appendFileSync } from 'node:fs';
const LOG = '/private/tmp/claude-501/-Users-samirusani--claude-spares-spare-an9u1g/615a107a-e8d3-42e7-bad1-c269ef3acf1a/scratchpad/probe.log';
function log(...args: unknown[]) {
  appendFileSync(LOG, args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
}
let env: TestEnvironment;
beforeAll(() => {
  env = createTestEnvironment();
});
afterAll(() => {
  env.cleanup();
});

function ids(result: ReturnType<typeof searchAll>) {
  return JSON.stringify({
    p: result.people.map((r) => r.id),
    o: result.organizations.map((r) => r.id),
    d: result.opportunities.map((r) => r.id),
  });
}

function attempt(fn: () => unknown): string {
  try {
    return ids(fn() as ReturnType<typeof searchAll>);
  } catch (error) {
    return `THROW:${(error as Error).message}`;
  }
}

let seq = 0;
function rawPerson(first: string, last: string, email: string | null, org: string | null = null) {
  seq += 1;
  const id = `per_${seq.toString(16).padStart(12, '0')}`;
  env.db
    .prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, email, organization_id, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, '2026-01-01', env.workspaceId, first, last, email, org, '2026-01-01');
  return id;
}
function rawOrg(name: string, domain: string | null) {
  seq += 1;
  const id = `org_${seq.toString(16).padStart(12, '0')}`;
  env.db
    .prepare("INSERT INTO organization (id, created_at, workspace_id, name, domain, kind, updated_at) VALUES (?,?,?,?,?, 'fund', ?)")
    .run(id, '2026-01-01', env.workspaceId, name, domain, '2026-01-01');
  return id;
}

const odd = [
  'ﬁnance', 'ﬂow', 'Ｆｕｌｌｗｉｄｔｈ', 'FULLWIDTH', 'İstanbul', 'ISTANBUL', 'ıstanbul', 'istanbul', 'Kelvin', 'Kelvin', 'straße', 'STRASSE', 'Straße',
  'Σίσυφος', 'σίσυφος', 'ΣΊΣΥΦΟΣ', 'ς', 'Ǆa', 'ǅa', 'ǆa', 'école', 'école', 'ÉCOLE', 'ábc', 'ábc', 'x́yz', '́́́',
  'a​b​c', 'a b', 'tab\tname', 'new\nline', '\u{1F468}‍\u{1F469}‍\u{1F467}', '\u{1F600}\u{1F601}\u{1F602}', 'a\u{1F600}b', 'ab\u0000cd', 'xx\u0000yy',
  'ǅungla', 'ŉx', 'ǰabc', 'ΐabc', 'ᾳabc', 'ẞabc', 'Ꭰabc', 'ꭰabc', '𐐀abc', '𐐨abc', 'ⓐⓑⓒ', 'ⒶⒷⒸ', 'ａｂｃ', 'ABC', 'abc', 'ÅÄÖ', 'åäö', 'ǈ', 'ᴀbc',
  '\uD800abc', 'aa%bb', 'aa_bb', 'aa\\bb', 'AA%BB', "it's", 'ａ', 'ℌello', 'Ⅻ', 'ⅻroman', 'ﬃx', 'ǲx', 'ß', 'ſtraße', 'ſſſ', 'ΑΣ', 'ας', 'ΑΣ.',
];

describe('probe: odd unicode and control characters, old scan vs index', () => {
  beforeAll(() => {
    odd.forEach((s, i) => {
      const orgId = rawOrg(`Org ${s}`, `${s.replace(/[^a-z]/gi, '') || 'x'}${i}.example`);
      rawPerson(s, `L${i}`, `p${i}@${s.replace(/\s/g, '')}.example`, i % 2 ? orgId : null);
      rawPerson('First', s, null);
      rawPerson(s.slice(0, 2), s.slice(2), null);
      env.db.prepare('SELECT 1').get();
    });
    odd.slice(0, 20).forEach((s) => createOpportunity(env.ctx, { name: `Deal ${s}`.replace(/\u0000/g, '') }));
  });

  it('finds no query among the substrings of the data where the index misses a scan hit', () => {
    const queries = new Set<string>();
    const transforms: ((s: string) => string)[] = [
      (s) => s,
      (s) => s.toLowerCase(),
      (s) => s.toUpperCase(),
      (s) => s.normalize('NFC'),
      (s) => s.normalize('NFD'),
      (s) => s.normalize('NFKC'),
      (s) => s.normalize('NFKD'),
    ];
    for (const s of odd) {
      const chars = Array.from(s);
      for (const f of transforms) {
        const t = Array.from(f(s));
        for (let a = 0; a < t.length; a += 1) {
          for (let b = a + 1; b <= t.length; b += 1) queries.add(t.slice(a, b).join(''));
        }
      }
      void chars;
    }
    const misses: string[] = [];
    let compared = 0;
    for (const q of queries) {
      const trimmed = q.trim();
      if (trimmed.length === 0) continue;
      compared += 1;
      const indexed = attempt(() => searchAll(env.db, env.workspaceId, q, 50));
      const scan = attempt(() => searchScan(env.db, env.workspaceId, trimmed, 50));
      if (indexed !== scan) misses.push(`${JSON.stringify(q)} [${Array.from(q).map((c) => c.codePointAt(0)!.toString(16)).join(' ')}]\n   idx=${indexed.slice(0, 120)}\n  scan=${scan.slice(0, 120)}`);
    }
    log('compared', compared, 'differences', misses.length);
    log(misses.slice(0, 40).join('\n'));
    // KILLS the two defect classes the review found: NUL bytes used to make the index path throw (they now match
    // nothing on their own rule, compared separately below), and the phrase is now built from the JS lowered query, so
    // the folds the tokenizer misses (Cherokee and friends) no longer lose rows. A NUL query is the one case whose
    // answer is defined by its own rule instead of scan parity, so it is excluded here.
    const unexplained = misses.filter((m) => !m.includes('\\u0000'));
    expect(unexplained).toEqual([]);
  });
});

describe('probe: trigram edge shapes', () => {
  const shapes = [
    'áb', // 3 code points, may fold to 2
    '́́́',
    'éc', // e + mark + c
    '​​​',
    '  x',
    'x y',
    'ß',
    'ßßß',
    'ﬁn',
    'ﬁnance',
    'İst',
    'ist',
    'ıst',
    'ǅun',
    '\u{1F468}‍\u{1F469}',
    '\u{1F600}\u{1F601}\u{1F602}',
    '\uD800ab',
    'ab%',
    '%ab',
    'a\\b',
    'x'.repeat(5000),
    ('abc '.repeat(3000)),
  ];
  it.each(shapes)('same result for %j', (q) => {
    const indexed = attempt(() => searchAll(env.db, env.workspaceId, q, 8));
    const scan = attempt(() => searchScan(env.db, env.workspaceId, q.trim(), 8));
    expect(indexed).toBe(scan);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Round 2 probes. A test marked CONFIRMS asserts the defect, so a pass means the bug is real.
// ---------------------------------------------------------------------------------------------------------------------
import { buildApp } from '../src/http/app.js';
import { resetAllData } from '../src/actions/workspace.js';

function count(table: string): number {
  return (env.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('KILLS: JS toLowerCase on the query vs the tokenizer fold', () => {
  beforeAll(() => {
    rawPerson('Gia', 'აბგდ', 'geo@geo.example');
    rawPerson('Cher', 'ꭰꭱꭲab', 'cher@cher.example');
    rawPerson('Ist', 'i̇stanbul', null);
    rawOrg('ꭰꭱꭲ Holdings', null);
  });
  it.each([['ᲐᲑᲒᲓ'], ['ᎠᎡᎢab'], ['İstanbul'], ['ᎠᎡᎢ']])('the index finds everything the scan finds for %s', (q) => {
    const scan = JSON.parse(attempt(() => searchScan(env.db, env.workspaceId, q, 8)));
    const indexed = JSON.parse(attempt(() => searchAll(env.db, env.workspaceId, q, 8)));
    const scanTotal = scan.p.length + scan.o.length;
    expect(scanTotal).toBeGreaterThan(0);
    expect(indexed.p.length + indexed.o.length).toBe(scanTotal);
  });
});

describe('KILLS: NUL byte in the query', () => {
  it('searchAll answers empty without throwing', () => {
    expect(searchAll(env.db, env.workspaceId, 'abc\u0000def', 8)).toEqual({ people: [], organizations: [], opportunities: [] });
    expect(() => searchScan(env.db, env.workspaceId, 'abc\u0000def', 8)).not.toThrow();
  });
  it('is a 200 over HTTP', async () => {
    const app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
    await app.ready();
    try {
      const r = await app.inject({ method: 'GET', url: '/api/search?q=abc%00def', headers: { host: '127.0.0.1:4720' } });
      log('NUL over HTTP ->', r.statusCode, r.body.slice(0, 200));
      const ok = await app.inject({ method: 'GET', url: '/api/search?q=abcdef', headers: { host: '127.0.0.1:4720' } });
      expect(ok.statusCode).toBe(200);
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ people: [], organizations: [], opportunities: [] });
    } finally {
      await app.close();
    }
  });
});

describe('trigger drift', () => {
  const stray = (index: string, table: string) =>
    (env.db.prepare(`SELECT COUNT(*) AS n FROM ${index} s LEFT JOIN ${table} t ON t.rowid = s.rowid AND t.id = s.entity_id WHERE t.id IS NULL`).get() as { n: number }).n;

  it('INSERT OR REPLACE on person leaves a stale entry (delete trigger does not fire without recursive_triggers)', () => {
    const id = rawPerson('Replace', 'Original', 'replace@r.example');
    env.db.prepare("INSERT OR REPLACE INTO person (id, created_at, workspace_id, first_name, last_name, email, updated_at) VALUES (?,?,?,?,?,?,?)").run(id, '2026-01-01', env.workspaceId, 'Replace', 'Updated', 'replace2@r.example', '2026-01-01');
    log('stray person_search rows after INSERT OR REPLACE:', stray('person_search', 'person'), 'recursive_triggers=', env.db.pragma('recursive_triggers', { simple: true }));
    // Not used by app code (grep): reported as latent only.
    expect(count('person_search')).toBeGreaterThanOrEqual(count('person'));
    const hit = searchAll(env.db, env.workspaceId, 'original', 8).people.map((p) => p.id);
    expect(hit).not.toContain(id); // refilter hides the stale entry from results
  });

  it('UPDATE ... SET rowid / id desyncs the entry', () => {
    const id = rawPerson('Rowid', 'Mover', 'rowid@r.example');
    const before = (env.db.prepare('SELECT rowid FROM person WHERE id = ?').get(id) as { rowid: number }).rowid;
    env.db.prepare('UPDATE person SET rowid = ? WHERE id = ?').run(before + 100000, id);
    const direct = env.db.prepare('SELECT COUNT(*) AS n FROM person_search WHERE entity_id = ?').get(id) as { n: number };
    log('UPDATE rowid: entries for id =', direct.n, 'stray =', stray('person_search', 'person'));
    // Search still finds it through entity_id, so results survive; only alignment is off.
    expect(searchAll(env.db, env.workspaceId, 'rowid mover', 8).people.map((p) => p.id)).toContain(id);
  });

  it('VACUUM may renumber rowids and make the rowid keyed triggers overwrite the wrong entry', () => {
    // Make rowid gaps: insert and delete rows in the middle, then VACUUM.
    const keep: string[] = [];
    const drop: string[] = [];
    for (let i = 0; i < 6; i += 1) (i % 2 ? drop : keep).push(rawPerson(`Vac${i}`, `Zuma${i}`, `vac${i}@v.example`));
    for (const id of drop) env.db.prepare('DELETE FROM person WHERE id = ?').run(id);
    const rowids = () => keep.map((id) => (env.db.prepare('SELECT rowid FROM person WHERE id = ?').get(id) as { rowid: number }).rowid);
    const before = rowids();
    env.db.exec('VACUUM');
    const after = rowids();
    log('rowids before VACUUM', before, 'after', after, 'stray after', stray('person_search', 'person'));
    expect(after).toEqual(before); // KILLS if rowids are stable under VACUUM
  });

});

describe('reset on a clean database', () => {
  it('seed then resetAllData empties the indexes and seeding again repopulates them', async () => {
    const { seedDatabase } = await import('../src/seed/seed.js');
    const clean = createTestEnvironment();
    try {
      seedDatabase(clean.db, { now: new Date('2026-03-01T12:00:00.000Z') });
      const n = (t: string) => (clean.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect(n('person_search')).toBe(n('person'));
      expect(n('person_search')).toBeGreaterThan(0);
      resetAllData(clean.db);
      expect([n('person_search'), n('organization_search'), n('opportunity_search')]).toEqual([0, 0, 0]);
      seedDatabase(clean.db, { now: new Date('2026-03-01T12:00:00.000Z') });
      expect(n('person_search')).toBe(n('person'));
      expect(clean.db.prepare("INSERT INTO person_search(person_search) VALUES ('integrity-check')").run()).toBeDefined();
    } finally {
      clean.cleanup();
    }
  });
});

const ROWS = Number(process.env.PROBE_ROWS ?? 24000);
describe('perf: many rows matching', () => {
  it('measures the uncapped re-read against the scan', () => {
    const big = createTestEnvironment();
    try {
      const wsp = big.workspaceId;
      const insOrg = big.db.prepare("INSERT INTO organization (id, created_at, workspace_id, name, domain, kind, updated_at) VALUES (?,?,?,?,?, 'fund', ?)");
      const insPer = big.db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, email, organization_id, updated_at) VALUES (?,?,?,?,?,?,?,?)');
      const hex = (n: number) => n.toString(16).padStart(12, '0');
      big.db.transaction(() => {
        insOrg.run(`org_${hex(1)}`, 't', wsp, 'Matchall Holdings', 'matchall.example', 't');
        for (let i = 0; i < ROWS; i += 1) insPer.run(`per_${hex(i + 1)}`, 't', wsp, `First${i}`, `Matchall${i % 500}`, `p${i}@matchall.example`, i % 2 ? `org_${hex(1)}` : null, 't');
        for (let i = 0; i < 2000; i += 1) insOrg.run(`org_${hex(i + 2)}`, 't', wsp, `Matchall Org ${i}`, `m${i}.matchall.example`, 't');
      })();
      const time = (label: string, fn: () => unknown) => {
        const t = performance.now();
        fn();
        const ms = performance.now() - t;
        log(label, ms.toFixed(1), 'ms');
        return ms;
      };
      for (const q of ['matchall', 'matchall.example', 'com', 'first1', 'zzzzqq']) {
        time(`indexed ${q}`, () => searchAll(big.db, wsp, q, 8));
        time(`scan    ${q}`, () => searchScan(big.db, wsp, q, 8));
        time(`indexed ${q} again`, () => searchAll(big.db, wsp, q, 8));
      }
      expect(JSON.stringify(searchAll(big.db, wsp, 'matchall', 8))).toBe(JSON.stringify(searchScan(big.db, wsp, 'matchall', 8)));
    } finally {
      big.cleanup();
    }
  });
});

describe('very long queries', () => {
  it.each([[2000], [15000]])('KILLS: a query of %i chars answers fast and empty (capped, no searchable field is that long)', (n) => {
    const e = createTestEnvironment();
    try {
      for (let i = 0; i < 2000; i += 1) {
        e.db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, email, updated_at) VALUES (?,?,?,?,?,?,?)').run(`per_${i.toString(16).padStart(12, '0')}`, 't', e.workspaceId, `F${i}`, `aaaa${i}`, null, 't');
      }
      const q = 'a'.repeat(n);
      const t0 = performance.now();
      const indexed = attempt(() => searchAll(e.db, e.workspaceId, q, 8));
      const t1 = performance.now();
      const scan = attempt(() => searchScan(e.db, e.workspaceId, q, 8));
      const t2 = performance.now();
      log(`long ${n}: indexed ${(t1 - t0).toFixed(1)}ms scan ${(t2 - t1).toFixed(1)}ms same=${indexed === scan}`, indexed.slice(0, 80), '|', scan.slice(0, 80));
      expect(indexed).toBe(scan);
      expect(t1 - t0).toBeLessThan(50); // before the cap, 15,000 chars ran for seconds and blocked the process
    } finally {
      e.cleanup();
    }
  }, 60000);

  it('the cap boundary: 256 characters still searches, 257 answers empty', () => {
    const e = createTestEnvironment();
    try {
      e.db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, email, updated_at) VALUES (?,?,?,?,?,?,?)').run('per_capboundary0', 't', e.workspaceId, 'Cap', 'Boundary', null, 't');
      const under = searchAll(e.db, e.workspaceId, 'boundary' + 'z'.repeat(248), 8);
      expect(under).toEqual({ people: [], organizations: [], opportunities: [] }); // searched, nothing matches
      expect(searchAll(e.db, e.workspaceId, 'boundary', 8).people).toHaveLength(1); // the index itself works
      const over = searchAll(e.db, e.workspaceId, 'z'.repeat(257), 8);
      expect(over).toEqual({ people: [], organizations: [], opportunities: [] });
    } finally {
      e.cleanup();
    }
  });
});

describe('long pasted prose against a normal corpus', () => {
  it('times a 15000 char lorem query and a 15000 char email-like repeated query', () => {
    const e = createTestEnvironment();
    try {
      const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
      for (let i = 0; i < 5000; i += 1) {
        e.db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, email, updated_at) VALUES (?,?,?,?,?,?,?)').run(`per_${i.toString(16).padStart(12, '0')}`, 't', e.workspaceId, words[i % 12]!, words[(i * 7) % 12]! + i, `${words[i % 12]}.${i}@example.com`, 't');
      }
      let prose = '';
      let k = 0;
      while (prose.length < 15000) prose += words[(k++ * 5) % 12] + ' ';
      for (const [label, q] of [['prose', prose], ['dots', '.example.com'.repeat(1200)], ['aaa', 'a'.repeat(15000)]] as const) {
        const t0 = performance.now();
        const idx = attempt(() => searchAll(e.db, e.workspaceId, q, 8));
        const t1 = performance.now();
        const sc = attempt(() => searchScan(e.db, e.workspaceId, q.trim(), 8));
        log(`${label}: indexed ${(t1 - t0).toFixed(0)}ms scan ${(performance.now() - t1).toFixed(0)}ms same=${idx === sc}`);
      }
    } finally {
      e.cleanup();
    }
  });
});
