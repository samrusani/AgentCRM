import { ensureWorkspace } from '../src/actions/index.js';
import { openDatabase } from '../src/db.js';
import { listPipelines } from '../src/queries/pipelines.js';
import {
  companyTitles,
  firstNames,
  fundTitles,
  lastNames,
  noteTemplates,
  organizations,
  owners,
  personTags,
} from '../src/seed/data.js';

// The size of the data set a run measures against.
export interface Profile {
  name: string;
  people: number;
  organizations: number;
  activities: number;
  opportunities: number;
  claims: number;
}

// The profile the product spec publishes its budgets for, plus the claims and opportunities the bench adds.
export const fullProfile: Profile = {
  name: 'full',
  people: 100_000,
  organizations: 25_000,
  activities: 1_000_000,
  opportunities: 5_000,
  claims: 100_000,
};

export const smallProfile: Profile = {
  name: 'small',
  people: 1_000,
  organizations: 250,
  activities: 10_000,
  opportunities: 50,
  claims: 1_000,
};

export interface SeedResult {
  workspaceId: string;
  counts: Record<'people' | 'organizations' | 'opportunities' | 'activities' | 'claims', number>;
  // People that have field claims. The record detail measurement reads these.
  claimedPersonIds: string[];
  // People the write measurements attach notes to.
  samplePersonIds: string[];
  seconds: number;
}

// Same generator the demo seed uses, so a run is repeatable.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ids keep the shape the API validates (three letters, an underscore, twelve hex digits). The low eight digits
// come from a bijection on the counter, so ids are unique per table and spread across the key space.
function makeId(prefix: string, tag: number, n: number): string {
  const mixed = Math.imul(n + 1, 0x9e3779b1) >>> 0;
  return `${prefix}_${(tag & 0xffff).toString(16).padStart(4, '0')}${mixed.toString(16).padStart(8, '0')}`;
}

const tags = { person: 0x1a01, organization: 0x2b02, opportunity: 0x3c03, activity: 0x4d04, claim: 0x5e05, stageEvent: 0x6f06 };

const dayMilliseconds = 86_400_000;
const baseTime = Date.UTC(2026, 0, 1);
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

const orgHeads = [
  'Amber', 'Birch', 'Cinder', 'Dune', 'Elm', 'Fable', 'Garnet', 'Heron', 'Indigo', 'Jasper',
  'Kelp', 'Linden', 'Moss', 'Nettle', 'Onyx', 'Pine', 'Quartz', 'Rowan', 'Sedge', 'Tansy',
  'Umber', 'Vale', 'Willow', 'Yarrow', 'Zinc', 'Alder', 'Bramble', 'Cedar', 'Drift', 'Ember',
  'Fern', 'Gorse', 'Hazel', 'Iris', 'Juniper', 'Knoll', 'Larch', 'Marsh', 'Nimbus', 'Ochre',
];
const orgTails = ['row', 'point', 'field', 'gate', 'mere', 'wick', 'hollow', 'quay', 'lane', 'crest', 'fold', 'leaf', 'mill', 'worth', 'dale', 'ford'];
const orgSuffixes = ['Capital', 'Ventures', 'Partners', 'Labs', 'Software', 'Systems', 'Health', 'Data'];
const cities = [...new Set(organizations.map((org) => org.location))];
const sourceTypes = ['web_page', 'directory', 'import', 'manual'];
const claimStatuses = ['imported', 'extracted', 'corroborated', 'human_confirmed'];

export function seedProfile(databasePath: string, profile: Profile, log: (line: string) => void): SeedResult {
  const started = performance.now();
  const db = openDatabase(databasePath);
  // The server reopens the file with its own settings. These only make the bulk load fast.
  db.pragma('synchronous = OFF');
  db.pragma('foreign_keys = OFF');
  const workspace = ensureWorkspace(db);
  const workspaceId = workspace.id;
  const pipeline = listPipelines(db, workspaceId)[0]!;
  const stages = pipeline.stages;
  const random = mulberry32(20260101);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

  const insertAll = (label: string, total: number, chunkSize: number, sql: string, row: (index: number) => unknown[]): void => {
    const statement = db.prepare(sql);
    const step = Math.min(chunkSize, Math.max(1, total));
    const printEvery = Math.max(step, Math.floor(total / 10 / step) * step);
    const t0 = performance.now();
    for (let from = 0; from < total; from += step) {
      const to = Math.min(total, from + step);
      db.transaction(() => {
        for (let index = from; index < to; index += 1) statement.run(...row(index));
      }).immediate();
      if (to === total || to % printEvery === 0) {
        log(`  ${label}: ${to.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
      }
    }
  };

  // Organizations: the demo seed's 30 first, then generated ones.
  const orgNames: string[] = [];
  const orgDomains: string[] = [];
  const orgKinds: ('fund' | 'company')[] = [];
  const orgLocations: string[] = [];
  const fundIndexes: number[] = [];
  for (let index = 0; index < profile.organizations; index += 1) {
    const demo = organizations[index];
    if (demo) {
      orgNames.push(demo.name);
      orgDomains.push(`${demo.slug}${index}.example.com`);
      orgKinds.push(demo.kind);
      orgLocations.push(demo.location);
    } else {
      orgNames.push(`${pick(orgHeads)}${pick(orgTails)} ${pick(orgSuffixes)}`);
      orgDomains.push(`${slug(orgNames[index]!)}${index}.${index % 3 === 2 ? 'example.org' : 'example.com'}`);
      orgKinds.push(index % 8 === 0 ? 'fund' : 'company');
      orgLocations.push(pick(cities));
    }
    if (orgKinds[index] === 'fund') fundIndexes.push(index);
  }
  log(`Seeding ${profile.name} profile`);
  insertAll(
    'organizations',
    profile.organizations,
    25_000,
    'INSERT INTO organization (id, created_at, workspace_id, version, name, domain, kind, location, tags, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
    (index) => {
      const created = iso(baseTime + (index % 200) * dayMilliseconds);
      return [
        makeId('org', tags.organization, index),
        created,
        workspaceId,
        orgNames[index],
        orgDomains[index],
        orgKinds[index],
        orgLocations[index],
        orgKinds[index] === 'fund' ? '["investor"]' : '["company"]',
        created,
      ];
    },
  );

  // People
  const personEmails: string[] = [];
  const personTitles: string[] = [];
  const personLocations: string[] = [];
  const personIds: string[] = [];
  insertAll(
    'people',
    profile.people,
    50_000,
    'INSERT INTO person (id, created_at, workspace_id, version, first_name, last_name, email, title, organization_id, location, tags, next_action_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    (index) => {
      const firstName = pick(firstNames);
      const lastName = pick(lastNames);
      const orgIndex = random() < 0.92 ? Math.floor(random() * profile.organizations) : -1;
      const email = `${slug(firstName)}.${slug(lastName)}${index}@${orgIndex >= 0 ? orgDomains[orgIndex] : 'independent.example.com'}`;
      const title = orgIndex >= 0 ? pick(orgKinds[orgIndex] === 'fund' ? fundTitles : companyTitles) : 'Independent angel';
      const location = orgIndex >= 0 ? orgLocations[orgIndex]! : pick(cities);
      const tagList = random() > 0.6 ? [pick(personTags), pick(personTags)] : [pick(personTags)];
      const created = iso(baseTime + (index % 300) * dayMilliseconds);
      const id = makeId('per', tags.person, index);
      personIds.push(id);
      personEmails.push(email);
      personTitles.push(title);
      personLocations.push(location);
      return [
        id,
        created,
        workspaceId,
        firstName,
        lastName,
        email,
        title,
        orgIndex >= 0 ? makeId('org', tags.organization, orgIndex) : null,
        location,
        JSON.stringify([...new Set(tagList)]),
        index % 10 === 0 ? iso(baseTime + (300 + (index % 30)) * dayMilliseconds) : null,
        created,
      ];
    },
  );

  // Opportunities, each with one stage event
  const opportunityIds: string[] = [];
  const opportunityRows: { stageId: string; created: string }[] = [];
  insertAll(
    'opportunities',
    profile.opportunities,
    5_000,
    `INSERT INTO opportunity (id, created_at, workspace_id, version, name, pipeline_id, stage_id, organization_id, person_id, amount_target, currency, owner, status, reason, next_action_at, stage_changed_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)`,
    (index) => {
      const fundIndex = fundIndexes[index % fundIndexes.length]!;
      const stage = stages[Math.floor(random() * stages.length)]!;
      const created = iso(baseTime + (index % 250) * dayMilliseconds);
      const roll = random();
      const status = roll < 0.8 ? 'open' : roll < 0.88 ? 'passed' : roll < 0.92 ? 'lost' : 'nurture';
      const id = makeId('opp', tags.opportunity, index);
      opportunityIds.push(id);
      opportunityRows.push({ stageId: stage.id, created });
      return [
        id,
        created,
        workspaceId,
        index < fundIndexes.length ? `${orgNames[fundIndex]} seed round` : `${orgNames[fundIndex]} extension ${index}`,
        pipeline.id,
        stage.id,
        makeId('org', tags.organization, fundIndex),
        makeId('per', tags.person, Math.floor(random() * profile.people)),
        (4 + Math.floor(random() * 96)) * 25_000,
        pick(owners),
        status,
        status === 'open' ? null : 'Closed by the bench profile.',
        index % 3 === 0 ? iso(baseTime + (300 + (index % 20)) * dayMilliseconds) : null,
        created,
        created,
      ];
    },
  );
  insertAll(
    'stage events',
    profile.opportunities,
    5_000,
    'INSERT INTO stage_event (id, created_at, opportunity_id, from_stage_id, to_stage_id, at, actor) VALUES (?, ?, ?, NULL, ?, ?, ?)',
    (index) => [makeId('evt', tags.stageEvent, index), opportunityRows[index]!.created, opportunityIds[index], opportunityRows[index]!.stageId, opportunityRows[index]!.created, 'seed'],
  );

  // Field claims on a slice of people: about two and a half per claimed person.
  const claimedCount = Math.max(1, Math.round(profile.claims * 0.4));
  const claimedIndexes: number[] = [];
  for (let slot = 0; slot < claimedCount; slot += 1) claimedIndexes.push(Math.floor((slot * profile.people) / claimedCount));
  const claimFields = ['email', 'title', 'location'] as const;
  insertAll(
    'field claims',
    profile.claims,
    50_000,
    `INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_url, source_type, observed_at, status, extraction_method)
     VALUES (?, ?, ?, 'person', ?, ?, ?, ?, ?, ?, ?, NULL)`,
    (index) => {
      const personIndex = claimedIndexes[index % claimedCount]!;
      const field = claimFields[Math.floor(index / claimedCount) % claimFields.length]!;
      const value = field === 'email' ? personEmails[personIndex]! : field === 'title' ? personTitles[personIndex]! : personLocations[personIndex]!;
      const observed = iso(baseTime + (index % 320) * dayMilliseconds + 36_000_000);
      return [
        makeId('clm', tags.claim, index),
        observed,
        workspaceId,
        personIds[personIndex],
        field,
        value,
        `https://example.com/people/${slug(value)}${personIndex}`,
        sourceTypes[index % sourceTypes.length],
        observed,
        claimStatuses[index % claimStatuses.length],
      ];
    },
  );

  // Activities: notes and stage changes, mostly on people.
  insertAll(
    'activities',
    profile.activities,
    50_000,
    'INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    (index) => {
      const target = random();
      let entityType: string;
      let entityId: string;
      if (target < 0.9) {
        entityType = 'person';
        entityId = personIds[Math.floor(random() * profile.people)]!;
      } else if (target < 0.95) {
        entityType = 'organization';
        entityId = makeId('org', tags.organization, Math.floor(random() * profile.organizations));
      } else {
        entityType = 'opportunity';
        entityId = opportunityIds[Math.floor(random() * opportunityIds.length)]!;
      }
      const stageChange = random() < 0.12;
      const created = iso(baseTime + Math.floor(random() * 330 * dayMilliseconds));
      return [
        makeId('act', tags.activity, index),
        created,
        workspaceId,
        entityType,
        entityId,
        stageChange ? 'stage_change' : 'note',
        stageChange ? `Moved to ${pick(stages).name}.` : pick(noteTemplates),
        pick(owners),
      ];
    },
  );

  const counts = {
    people: (db.prepare('SELECT COUNT(*) AS n FROM person').get() as { n: number }).n,
    organizations: (db.prepare('SELECT COUNT(*) AS n FROM organization').get() as { n: number }).n,
    opportunities: (db.prepare('SELECT COUNT(*) AS n FROM opportunity').get() as { n: number }).n,
    activities: (db.prepare('SELECT COUNT(*) AS n FROM activity').get() as { n: number }).n,
    claims: (db.prepare('SELECT COUNT(*) AS n FROM field_claim').get() as { n: number }).n,
  };
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const samplePersonIds = Array.from({ length: 64 }, (_, slot) => personIds[Math.floor((slot * profile.people) / 64)]!);
  return {
    workspaceId,
    counts,
    claimedPersonIds: claimedIndexes.map((index) => personIds[index]!),
    samplePersonIds,
    seconds: (performance.now() - started) / 1000,
  };
}
