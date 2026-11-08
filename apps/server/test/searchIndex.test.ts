import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createContext,
  createOpportunity,
  createOrganization,
  createPerson,
  updateOpportunity,
  updateOrganization,
  updatePerson,
} from '../src/actions/index.js';
import { applyMigrations } from '../src/db.js';
import { migrationsDirectory } from '../src/paths.js';
import { ftsPhrase, searchAll, searchScan } from '../src/queries/search.js';
import { createTestEnvironment, insertSecondWorkspace, type TestEnvironment } from './helpers.js';

let env: TestEnvironment;

beforeAll(() => {
  env = createTestEnvironment();
});

afterAll(() => {
  env.cleanup();
});

function ids(result: ReturnType<typeof searchAll>) {
  return {
    people: result.people.map((row) => row.id),
    organizations: result.organizations.map((row) => row.id),
    opportunities: result.opportunities.map((row) => row.id),
  };
}

// The indexed path and the scan it replaced, for the same query.
function bothWays(query: string, limit = 8, workspaceId = env.workspaceId) {
  return { indexed: ids(searchAll(env.db, workspaceId, query, limit)), scan: ids(searchScan(env.db, workspaceId, query.trim(), limit)) };
}

function count(table: string): number {
  return (env.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('the search index setup', () => {
  it('has the trigram tokenizer and one search row per source row', () => {
    const sql = (env.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'person_search'").get() as { sql: string }).sql;
    expect(sql).toContain("tokenize = 'trigram'");
    for (const [index, table] of [
      ['person_search', 'person'],
      ['organization_search', 'organization'],
      ['opportunity_search', 'opportunity'],
    ] as const) {
      expect(count(index)).toBe(count(table));
    }
  });

  it('quotes a query as one FTS5 string and doubles inside double quotes', () => {
    expect(ftsPhrase('ada quill')).toBe('"ada quill"');
    expect(ftsPhrase('say "hi"')).toBe('"say ""hi"""');
    expect(ftsPhrase('NEAR(a b) OR *')).toBe('"NEAR(a b) OR *"');
    expect(ftsPhrase('"')).toBe('""""');
  });
});

// A seeded workspace that covers the shapes the old LIKE search had to handle.
const surnames = ['Quill', 'Stone', 'Marsh', 'Fields', 'Hart', 'Nakamura', 'Okafor', 'Lindqvist', 'Brandt', 'Castellano'];
const givens = ['Ada', 'Bo', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kit', 'Lena'];
const orgNames = ['Northwind Capital', 'Northern Lights Fund', 'Lantern Row', 'Acme (US) Ltd', 'NEAR Labs', 'A-B* Corp', 'Fifty%_Off Co', 'Quill & Co', 'Östergren Partners', 'Éclair Ventures', 'Stone Harbor', 'Marsh Mellow'];
const oddPeople: [string, string, string | null][] = [
  ['Émile', 'Zola', 'emile.zola@paris.example.com'],
  ['émile', 'Dupont', 'edupont@paris.example.com'],
  ['José', 'Núñez', 'jose.nunez@madrid.example.com'],
  ['JOSÉ', 'NÚÑEZ', null],
  ['Zoë', 'Ångström', 'zoe@uppsala.example.com'],
  ['Renée', "O'Brien", 'renee.obrien@dublin.example.com'],
  ['Quentin "Q" ', 'Quote', 'q.quote@quotes.example.com'],
  ['Near', 'Miss', 'near@miss.example.com'],
  ['Dash', 'A-B', 'a-b@dash.example.com'],
  ['Star', 'Star*', 'star@star.example.com'],
  ['Paren', '(Ltd)', 'paren@ltd.example.com'],
  ['Pct', '100%', 'pct@pct.example.com'],
  ['Under', 'Score_Name', 'under@score.example.com'],
  ['Back', 'Slash\\Name', 'back@slash.example.com'],
  ['Emoji', '😀😀😀 Smith', 'emoji@smile.example.com'],
  ['Sole', '', 'sole@single.example.com'],
  ['Ångström', 'Lowercase', null],
];

const orgIds: string[] = [];
const personIds: string[] = [];
const opportunityIds: string[] = [];

describe('the indexed search matches the old scan', () => {
  beforeAll(() => {
    orgNames.forEach((name, index) => {
      const slug = name.toLowerCase().replace(/[^a-z]+/g, '');
      const org = createOrganization(env.ctx, { name, domain: index % 3 === 0 ? null : `${slug || 'x' + index}.example.com` });
      orgIds.push(org.id);
    });
    let n = 0;
    for (const given of givens) {
      for (const surname of surnames) {
        n += 1;
        if (n % 2 === 0) continue;
        const person = createPerson(env.ctx, {
          firstName: given,
          lastName: surname,
          email: `${given}.${surname}${n}@mail${n % 5}.example.com`.toLowerCase(),
          organizationId: n % 7 === 0 ? null : orgIds[n % orgIds.length]!,
        });
        personIds.push(person.id);
      }
    }
    oddPeople.forEach(([firstName, lastName, email], index) => {
      const person = createPerson(env.ctx, { firstName, lastName, email, organizationId: index % 3 === 0 ? orgIds[index % orgIds.length]! : null });
      personIds.push(person.id);
    });
    [
      'Quill seed round',
      'Northwind follow-on',
      'Series A: Stone Harbor',
      'NEAR Labs pilot',
      'Émile intro',
      '100% committed',
      'Lantern "Row" bridge',
      'A-B* extension',
      'Marsh Mellow secondary',
    ].forEach((name, index) => {
      opportunityIds.push(createOpportunity(env.ctx, { name, organizationId: index % 2 === 0 ? orgIds[index % orgIds.length]! : null }).id);
    });
    for (let index = 0; index < 12; index += 1) {
      opportunityIds.push(createOpportunity(env.ctx, { name: `Plain deal ${index}`, organizationId: orgIds[index % orgIds.length]! }).id);
    }
  });

  const queries = [
    // names, parts of names, and mixed case
    'ada', 'ADA', 'Ada Quill', 'ada quill', 'quill', 'QUILL', 'Qui', 'stone', 'hart', 'a quill', 'ada  quill', '  ada  ', 'lena m', 'nakamura',
    // email and domains
    'mail1', '@mail2', '.example.com', 'ada.quill', 'example.com', 'paris.example', 'emile.zola', 'northwind', 'lanternrow',
    // organization names reaching people and opportunities
    'northwind capital', 'northern', 'lantern', 'acme', 'quill & co', 'Stone Harbor', 'marsh mel', 'fifty', 'ostergren',
    // unicode with diacritics, including the cases the old lower() does not fold
    'émile', 'ÉMILE', 'Émile', 'emile', 'josé', 'JOSÉ', 'José', 'núñez', 'NÚÑEZ', 'nunez', 'ångström', 'Ångström', 'zoë', 'Östergren', 'östergren', 'éclair', 'Éclair', 'renée', 'ren', '😀😀😀', '😀😀', '😀',
    // quotes and FTS syntax characters
    '"', '""', '"""', '"q"', 'Quentin "Q"', 'bo" ', '"ada', 'ada"', "o'br", "'", '*', 'a*', 'star*', '**', '(us)', '(', ')', 'ltd)', '(ltd', '-', 'a-b', '-b', 'a-b*', '--x', 'near', 'NEAR', 'NEAR/3', 'near miss', 'near(', 'AND', 'OR', 'NOT', 'ada OR bo', 'ada AND quill', 'NOT ada', '^ada', '^', 'name:ada', 'email: ada', '{name}', '{name email} : ada', 'ada*', ':', ',', '+', 'x:y', '[', ']', '{', '}',
    // LIKE wildcards and escapes
    '%', '_', '100%', '%off', 'off_co', 'score_name', 'a_b', '\\', 'slash\\name', '\\%',
    // short queries keep the old path
    'a', 'ad', 'ab', 'é', 'bo', '%_',
    // no match
    'zzzzzz', 'qqqqqq',
  ];

  it('returns identical ids in identical order for a wide list of queries', () => {
    const differences: string[] = [];
    let compared = 0;
    for (const query of queries) {
      for (const limit of [8, 3, 50]) {
        const { indexed, scan } = bothWays(query, limit);
        compared += 1;
        if (JSON.stringify(indexed) !== JSON.stringify(scan)) differences.push(`${query} @ ${limit}`);
      }
    }
    expect(compared).toBeGreaterThan(300);
    expect(differences).toEqual([]);
  });

  it('finds real hits for the interesting queries, so the comparison is not vacuous', () => {
    const expectHits = (query: string, kind: 'people' | 'organizations' | 'opportunities') => {
      expect(bothWays(query).indexed[kind].length, `${query} ${kind}`).toBeGreaterThan(0);
    };
    expectHits('ada quill', 'people');
    expectHits('northwind', 'organizations');
    expectHits('northwind', 'people');
    expectHits('northwind', 'opportunities');
    expectHits('example.com', 'organizations');
    expectHits('mail1', 'people');
    expectHits('josé', 'people');
    expectHits('Quentin "Q"', 'people');
    expectHits('(us)', 'organizations');
    expectHits('100%', 'people');
    expectHits('100%', 'opportunities');
    expectHits('score_name', 'people');
    expectHits('slash\\name', 'people');
    expectHits('star*', 'people');
    expectHits('a-b*', 'organizations');
    expectHits('😀😀😀', 'people');
    expectHits('Lantern "Row"', 'opportunities');
    // Queries made only of syntax do not throw and do not turn into operators.
    expect(() => searchAll(env.db, env.workspaceId, 'NEAR(')).not.toThrow();
    expect(bothWays('NOT ada').indexed.people).toEqual([]);
  });

  it('ranks with the old ordering: pattern matches first, then last name, first name, id', () => {
    const result = searchAll(env.db, env.workspaceId, 'quill');
    const flags = result.people.map((person) => {
      const full = `${person.firstName} ${person.lastName}`.toLowerCase();
      return full.endsWith('quill') || person.lastName.toLowerCase().endsWith('quill');
    });
    expect(flags[0]).toBe(true);
    expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    expect(result.organizations[0]?.name).toBe('Quill & Co');
    expect(ids(result)).toEqual(ids(searchScan(env.db, env.workspaceId, 'quill', 8)));
  });

  it('keeps the response shape', () => {
    const result = searchAll(env.db, env.workspaceId, 'northwind');
    expect(Object.keys(result)).toEqual(['people', 'organizations', 'opportunities']);
    expect(result.people[0]).toMatchObject({ id: expect.any(String), firstName: expect.any(String), organizationName: 'Northwind Capital' });
    expect(result.opportunities[0]).toMatchObject({ stageName: expect.any(String) });
    expect(searchAll(env.db, env.workspaceId, '   ')).toEqual({ people: [], organizations: [], opportunities: [] });
    expect(searchAll(env.db, env.workspaceId, 'northwind', 1).people).toHaveLength(1);
  });

  it('still matches the scan when more than 50 candidates match, by reading the full leg', () => {
    // Many people share one surname, so the index leg fills its 50 candidate cap. Their ranking must still be the old one.
    const cap = createContext(env.db, env.workspaceId, { bus: env.bus, now: env.ctx.now });
    for (let index = 0; index < 70; index += 1) createPerson(cap, { firstName: `Crowd${69 - index}`, lastName: 'Zebracrowd', email: `crowd${index}@zebracrowd.example.com` });
    const result = searchAll(env.db, env.workspaceId, 'zebracrowd');
    expect(result.people).toHaveLength(8);
    expect(result.people.map((person) => person.firstName)).toEqual(['Crowd0', 'Crowd1', 'Crowd10', 'Crowd11', 'Crowd12', 'Crowd13', 'Crowd14', 'Crowd15']);
    for (const limit of [8, 3, 50]) {
      const { indexed, scan } = bothWays('zebracrowd', limit);
      expect(indexed).toEqual(scan);
    }
    expect(bothWays('example.com').indexed).toEqual(bothWays('example.com').scan);
  });
});

describe('triggers keep the indexes in sync', () => {
  const find = (query: string) => ids(searchAll(env.db, env.workspaceId, query));
  const alignedWithSources = () => {
    for (const [index, table] of [
      ['person_search', 'person'],
      ['organization_search', 'organization'],
      ['opportunity_search', 'opportunity'],
    ] as const) {
      expect(count(index)).toBe(count(table));
      const strays = env.db.prepare(`SELECT COUNT(*) AS n FROM ${index} s LEFT JOIN ${table} t ON t.rowid = s.rowid AND t.id = s.entity_id WHERE t.id IS NULL`).get() as { n: number };
      expect(strays.n).toBe(0);
    }
  };

  it('indexes a created person, and follows a rename and an email change', () => {
    const person = createPerson(env.ctx, { firstName: 'Trigger', lastName: 'Original', email: 'trigger.one@trig.example.com' });
    expect(find('trigger original').people).toEqual([person.id]);
    expect(find('trig.example').people).toContain(person.id);
    const renamed = updatePerson(env.ctx, person.id, { expectedVersion: person.version, fields: { firstName: 'Renamedfirst', lastName: 'Renamedlast' } });
    expect(find('trigger original').people).toEqual([]);
    expect(find('renamedfirst renamedlast').people).toEqual([person.id]);
    const moved = updatePerson(env.ctx, person.id, { expectedVersion: renamed.version, fields: { email: 'moved.address@elsewhere.example.com' } });
    expect(find('trig.example').people).not.toContain(person.id);
    expect(find('elsewhere.example').people).toEqual([person.id]);
    // An update that touches other columns leaves the entry alone.
    updatePerson(env.ctx, person.id, { expectedVersion: moved.version, fields: { title: 'Head of Triggers' } });
    expect(find('renamedfirst renamedlast').people).toEqual([person.id]);
    expect(find('elsewhere.example').people).toEqual([person.id]);
    alignedWithSources();
    // The email can be cleared.
    updatePerson(env.ctx, person.id, { expectedVersion: moved.version + 1, fields: { email: null } });
    expect(find('elsewhere.example').people).toEqual([]);
    expect(find('renamedfirst').people).toEqual([person.id]);
    alignedWithSources();
  });

  it('drops a deleted person, organization, and opportunity', () => {
    const org = createOrganization(env.ctx, { name: 'Deletable Holdings', domain: 'deletable.example.org' });
    const person = createPerson(env.ctx, { firstName: 'Deleta', lastName: 'Ble', email: 'deleta@deletable.example.org', organizationId: org.id });
    const deal = createOpportunity(env.ctx, { name: 'Deletable deal', organizationId: org.id });
    expect(find('deletable').organizations).toEqual([org.id]);
    expect(find('deletable').opportunities).toEqual([deal.id]);
    expect(find('deletable').people).toEqual([person.id]);
    env.db.prepare('DELETE FROM stage_event WHERE opportunity_id = ?').run(deal.id);
    env.db.prepare('DELETE FROM opportunity WHERE id = ?').run(deal.id);
    env.db.prepare('DELETE FROM person WHERE id = ?').run(person.id);
    env.db.prepare('DELETE FROM organization WHERE id = ?').run(org.id);
    expect(find('deletable')).toEqual({ people: [], organizations: [], opportunities: [] });
    alignedWithSources();
  });

  it('shows an organization rename in its members and opportunities at once, without touching their entries', () => {
    const org = createOrganization(env.ctx, { name: 'Oldname Industries', domain: 'oldname.example.net' });
    const person = createPerson(env.ctx, { firstName: 'Mem', lastName: 'Ber', email: 'mem@personal.example.net', organizationId: org.id });
    const deal = createOpportunity(env.ctx, { name: 'Unrelated title', organizationId: org.id });
    expect(find('oldname')).toEqual({ people: [person.id], organizations: [org.id], opportunities: [deal.id] });
    const personEntry = env.db.prepare('SELECT rowid, name, email FROM person_search WHERE entity_id = ?').get(person.id);
    const dealEntry = env.db.prepare('SELECT rowid, name FROM opportunity_search WHERE entity_id = ?').get(deal.id);
    const renamed = updateOrganization(env.ctx, org.id, { expectedVersion: org.version, fields: { name: 'Freshname Group' } });
    // The old name is gone from the members. The organization itself still matches through its unchanged domain.
    expect(find('oldname')).toEqual({ people: [], organizations: [org.id], opportunities: [] });
    expect(find('oldname industries')).toEqual({ people: [], organizations: [], opportunities: [] });
    expect(find('freshname')).toEqual({ people: [person.id], organizations: [org.id], opportunities: [deal.id] });
    // The member entries were never rewritten.
    expect(env.db.prepare('SELECT rowid, name, email FROM person_search WHERE entity_id = ?').get(person.id)).toEqual(personEntry);
    expect(env.db.prepare('SELECT rowid, name FROM opportunity_search WHERE entity_id = ?').get(deal.id)).toEqual(dealEntry);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM person_search WHERE person_search MATCH '\"freshname\"'").get()).toEqual({ n: 0 });
    // A domain change is followed too, and a domain search finds the organization, not its members.
    updateOrganization(env.ctx, org.id, { expectedVersion: renamed.version, fields: { domain: 'newdomain.example.net' } });
    expect(find('newdomain').organizations).toEqual([org.id]);
    expect(find('newdomain').people).toEqual([]);
    expect(find('oldname')).toEqual({ people: [], organizations: [], opportunities: [] });
    alignedWithSources();
  });

  it('follows an opportunity rename and keeps matching on its organization', () => {
    const org = createOrganization(env.ctx, { name: 'Renameme Partners' });
    const deal = createOpportunity(env.ctx, { name: 'Initial label', organizationId: org.id });
    expect(find('initial label').opportunities).toEqual([deal.id]);
    updateOpportunity(env.ctx, deal.id, { expectedVersion: deal.version, fields: { name: 'Second label' } });
    expect(find('initial label').opportunities).toEqual([]);
    expect(find('second label').opportunities).toEqual([deal.id]);
    expect(find('renameme').opportunities).toEqual([deal.id]);
    alignedWithSources();
  });

  it('scopes every leg to the workspace', () => {
    const otherId = insertSecondWorkspace(env.db);
    const other = createContext(env.db, otherId, { bus: env.bus, now: env.ctx.now });
    const org = createOrganization(other, { name: 'Scopetest Group', domain: 'scopetest.example.io' });
    createPerson(other, { firstName: 'Scopey', lastName: 'Person', email: 'scopey@scopetest.example.io', organizationId: org.id });
    const pipeline = env.db.prepare('INSERT INTO pipeline (id, created_at, workspace_id, name) VALUES (?, ?, ?, ?)');
    pipeline.run('pip_scopetest01', env.ctx.now(), otherId, 'Other pipeline');
    env.db.prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, ?)').run('stg_scopetest01', env.ctx.now(), 'pip_scopetest01', 'Only', 0);
    createOpportunity(other, { name: 'Scopetest deal', organizationId: org.id });
    const mine = createOrganization(env.ctx, { name: 'Scopetest Mine' });
    createPerson(env.ctx, { firstName: 'Mine', lastName: 'Scopetest', organizationId: mine.id });

    const theirs = ids(searchAll(env.db, otherId, 'scopetest'));
    expect(theirs.people).toHaveLength(1);
    expect(theirs.organizations).toHaveLength(1);
    expect(theirs.opportunities).toHaveLength(1);
    const ours = searchAll(env.db, env.workspaceId, 'scopetest');
    expect(ours.organizations.map((row) => row.name)).toEqual(['Scopetest Mine']);
    expect(ours.people.map((row) => row.firstName)).toEqual(['Mine']);
    expect(ours.opportunities).toEqual([]);
    expect(searchAll(env.db, env.workspaceId, 'scopey').people).toEqual([]);
    expect(searchAll(env.db, otherId, 'mine scopetest').people).toEqual([]);
    expect(bothWays('scopetest', 8, otherId).indexed).toEqual(bothWays('scopetest', 8, otherId).scan);
    expect(bothWays('scopetest').indexed).toEqual(bothWays('scopetest').scan);
  });

  it('is not crowded out by another workspace that has many more matches', () => {
    const otherId = insertSecondWorkspace(env.db);
    const other = createContext(env.db, otherId, { bus: env.bus, now: env.ctx.now });
    for (let index = 0; index < 60; index += 1) createPerson(other, { firstName: `Noise${index}`, lastName: 'Crowdedout' });
    createPerson(env.ctx, { firstName: 'Quiet', lastName: 'Crowdedout' });
    expect(searchAll(env.db, env.workspaceId, 'crowdedout').people.map((row) => row.firstName)).toEqual(['Quiet']);
  });
});

describe('migration 017 on an existing database', () => {
  it('backfills the indexes from the rows that were there and installs the triggers', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-search-migration-'));
    const db = new Database(path.join(directory, 'old.db'));
    db.pragma('foreign_keys = ON');
    try {
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of ['001_init.sql', '002_apify.sql', '003_csv_qualify.sql', '004_lookup_indexes.sql', '005_anthropic.sql', '006_model_call_markers.sql', '007_agentmail.sql', '008_send_intent_guards.sql', '009_model_providers.sql', '010_lead_capture.sql', '011_workspace_version.sql', '012_mail_providers.sql', '013_microsoft.sql', '014_imap.sql', '015_people_order_index.sql', '016_followup_rules.sql']) {
        db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'));
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00.000Z');
      }
      db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run('wsp_1', '2026-01-01', 'W', 't');
      db.prepare('INSERT INTO organization (id, created_at, workspace_id, name, domain, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('org_aaaaaaaaaaaa', '2026-01-01', 'wsp_1', 'Legacy Capital', 'legacy.example.com', 'fund', '2026-01-01');
      db.prepare('INSERT INTO person (id, created_at, workspace_id, first_name, last_name, email, organization_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('per_aaaaaaaaaaaa', '2026-01-01', 'wsp_1', 'Old', 'Timer', 'old@legacy.example.com', 'org_aaaaaaaaaaaa', '2026-01-01');
      db.prepare('INSERT INTO pipeline (id, created_at, workspace_id, name) VALUES (?, ?, ?, ?)').run('pip_aaaaaaaaaaaa', '2026-01-01', 'wsp_1', 'P');
      db.prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, ?)').run('stg_aaaaaaaaaaaa', '2026-01-01', 'pip_aaaaaaaaaaaa', 'S', 0);
      db.prepare('INSERT INTO opportunity (id, created_at, workspace_id, name, pipeline_id, stage_id, organization_id, stage_changed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('opp_aaaaaaaaaaaa', '2026-01-01', 'wsp_1', 'Legacy round', 'pip_aaaaaaaaaaaa', 'stg_aaaaaaaaaaaa', 'org_aaaaaaaaaaaa', '2026-01-01', '2026-01-01');

      expect(applyMigrations(db)).toEqual(['017_search_index.sql', '018_profile_urls.sql', '019_lifecycle.sql', '020_lifecycle_indexes.sql', '021_worker_lease.sql', '022_pipelines.sql', '023_lists.sql', '024_mailbox.sql', '025_attributes.sql', '026_birthday.sql', '027_automations.sql', '028_sequences.sql', '029_saved_views.sql', '030_transcript.sql']);
      const found = searchAll(db, 'wsp_1', 'legacy');
      expect(found.people.map((row) => row.id)).toEqual(['per_aaaaaaaaaaaa']);
      expect(found.organizations.map((row) => row.id)).toEqual(['org_aaaaaaaaaaaa']);
      expect(found.opportunities.map((row) => row.id)).toEqual(['opp_aaaaaaaaaaaa']);
      expect(searchAll(db, 'wsp_1', 'timer').people).toHaveLength(1);
      expect(ids(searchAll(db, 'wsp_1', 'legacy'))).toEqual(ids(searchScan(db, 'wsp_1', 'legacy', 8)));

      // Writes after the migration are indexed.
      db.prepare("UPDATE person SET last_name = 'Newbie' WHERE id = 'per_aaaaaaaaaaaa'").run();
      expect(searchAll(db, 'wsp_1', 'timer').people).toHaveLength(0);
      expect(searchAll(db, 'wsp_1', 'old newbie').people).toHaveLength(1);
      expect(applyMigrations(db)).toEqual([]);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
