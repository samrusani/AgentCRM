import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganization, createPerson, decideApproval } from '../src/actions/index.js';
import { buildApp } from '../src/http/app.js';
import { getRunDetail } from '../src/queries/runs.js';
import { createTestEnvironment, driveRun } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

async function post(url: string, payload: unknown) {
  const response = await app.inject({ method: 'POST', url, payload: payload as object, headers: { host: '127.0.0.1:4720' } });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

async function get(url: string) {
  const response = await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4720' } });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

const leadsCsv = [
  'First Name,Last Name,Work Email,Company,Website,Job Title,City,Country,Tags,Notes',
  'Ada,Quill,Ada.Quill@northwind.example.com,Northwind Labs,https://www.northwind.example.com/about,Partner,Port Alder,Aurelia,"seed; warm-intro",Met at a demo day',
  'Ben,Marsh,ben.marsh@harbor.example.org,Harbor Row,harbor.example.org,Principal,Eastmarsh,,"angel, climate",',
  ',,,,,,,,,Row with nothing usable',
  'Cy,Dunn,ada.quill@northwind.example.com,Northwind Labs,,Associate,,,,Same email as row 1',
].join('\n');

const leadsMapping = {
  'First Name': 'firstName',
  'Last Name': 'lastName',
  'Work Email': 'email',
  Company: 'company',
  Website: 'domain',
  'Job Title': 'title',
  City: 'location',
  Country: 'location',
  Tags: 'tags',
  Notes: 'ignore',
};

function count(sql: string, ...params: unknown[]): number {
  return Number((env.db.prepare(sql).get(...params) as { n: number }).n);
}

describe('csv preview', () => {
  it('returns headers, delimiter, row count, a suggested mapping, and a sample without saving anything', async () => {
    const before = count('SELECT COUNT(*) AS n FROM import_batch');
    const response = await post('/api/imports/csv/preview', { fileName: 'leads.csv', content: leadsCsv });
    expect(response.status).toBe(200);
    expect(response.body.delimiter).toBe(',');
    expect(response.body.rowCount).toBe(4);
    expect(response.body.headers).toEqual(['First Name', 'Last Name', 'Work Email', 'Company', 'Website', 'Job Title', 'City', 'Country', 'Tags', 'Notes']);
    // A Website header suggests the person's website field now; the staged row still derives the organization domain from it.
    expect(response.body.suggestedMapping).toEqual({ ...leadsMapping, Website: 'website' });
    expect(response.body.sample).toHaveLength(4);
    expect(response.body.sample[0]['Work Email']).toBe('Ada.Quill@northwind.example.com');
    expect(count('SELECT COUNT(*) AS n FROM import_batch')).toBe(before);
    expect(count("SELECT COUNT(*) AS n FROM run WHERE kind = 'csv_import'")).toBe(0);
  });

  it('sniffs a semicolon delimiter, strips a byte order mark, and reads quoted fields', async () => {
    const content = '\uFEFFname;email;company\r\n"Quill; Ada";ada@example.com;"Northwind ""Labs"""\r\nBen Marsh;ben@example.org;"Harbor\nRow"\r\n';
    const response = await post('/api/imports/csv/preview', { fileName: 'semi.csv', content });
    expect(response.status).toBe(200);
    expect(response.body.delimiter).toBe(';');
    expect(response.body.headers).toEqual(['name', 'email', 'company']);
    expect(response.body.rowCount).toBe(2);
    expect(response.body.sample[0]).toEqual({ name: 'Quill; Ada', email: 'ada@example.com', company: 'Northwind "Labs"' });
    expect(response.body.sample[1].company).toBe('Harbor\nRow');
  });

  it('sniffs a tab delimiter and finds an email column by its values', async () => {
    const response = await post('/api/imports/csv/preview', { fileName: 'tabs.tsv', content: 'Who\tReach\nAda Quill\tada@example.com\nBen Marsh\tben@example.org\n' });
    expect(response.body.delimiter).toBe('\t');
    expect(response.body.suggestedMapping).toEqual({ Who: 'ignore', Reach: 'email' });
  });

  it('rejects a file with no header row, repeated column names, or no content', async () => {
    expect((await post('/api/imports/csv/preview', { fileName: 'a.csv', content: '   \n' })).status).toBe(400);
    const repeated = await post('/api/imports/csv/preview', { fileName: 'a.csv', content: 'name,name\nAda,Quill\n' });
    expect(repeated.status).toBe(400);
    expect(repeated.body.error.code).toBe('validation');
    expect(repeated.body.error.message).toContain('more than once');
    const unbalanced = await post('/api/imports/csv/preview', { fileName: 'a.csv', content: 'name,email\n"Ada,ada@example.com\n' });
    expect(unbalanced.status).toBe(400);
  });

  it('fails with a validation error beyond 20,000 rows and beyond 10 MB', async () => {
    const atLimit = `email\n${Array.from({ length: 20_000 }, (_, index) => `p${index}@example.com`).join('\n')}\n`;
    const accepted = await post('/api/imports/csv/preview', { fileName: 'big.csv', content: atLimit });
    expect(accepted.status).toBe(200);
    expect(accepted.body.rowCount).toBe(20_000);

    const tooManyRows = `email\n${Array.from({ length: 20_001 }, (_, index) => `p${index}@example.com`).join('\n')}\n`;
    const rows = await post('/api/imports/csv/preview', { fileName: 'big.csv', content: tooManyRows });
    expect(rows.status).toBe(400);
    expect(rows.body.error.code).toBe('validation');
    expect(rows.body.error.message).toBe('The file has more than 20,000 data rows. Split it into smaller files.');

    const tooLarge = `name\n${'x'.repeat(10 * 1024 * 1024 + 1)}\n`;
    const bytes = await post('/api/imports/csv/preview', { fileName: 'big.csv', content: tooLarge });
    expect(bytes.status).toBe(400);
    expect(bytes.body.error.message).toBe('The file is larger than 10 MB. Split it into smaller files.');
  });
});

describe('csv text encoding', () => {
  // Fastify decodes the body as UTF-8, so a stray Latin-1 byte reaches the server as U+FFFD.
  const latinBody = (withMapping: boolean): Buffer =>
    Buffer.concat([
      Buffer.from('{"fileName":"latin.csv","content":"name,email\\nJos'),
      Buffer.from([0xe9]),
      Buffer.from(`,jose@example.com\\n"${withMapping ? ',"mapping":{"name":"name","email":"email"}' : ''}}`),
    ]);
  const rawPost = async (url: string, withMapping: boolean) => {
    const response = await app.inject({
      method: 'POST',
      url,
      payload: latinBody(withMapping),
      headers: { host: '127.0.0.1:4720', 'content-type': 'application/json' },
    });
    return { status: response.statusCode, body: response.json() as Record<string, any> };
  };

  it('rejects an invalid byte sequence in preview and in staging, and stages nothing', async () => {
    const message = 'The file is not valid UTF-8 text. Save it as UTF-8 and try again.';
    const before = count('SELECT COUNT(*) AS n FROM import_batch');
    const preview = await rawPost('/api/imports/csv/preview', false);
    expect(preview.status).toBe(400);
    expect(preview.body.error).toMatchObject({ code: 'validation', message });
    const stage = await rawPost('/api/imports/csv', true);
    expect(stage.status).toBe(400);
    expect(stage.body.error).toMatchObject({ code: 'validation', message });
    expect(count('SELECT COUNT(*) AS n FROM import_batch')).toBe(before);
  });

  it('accepts accented text that is valid UTF-8', async () => {
    const response = await post('/api/imports/csv/preview', { fileName: 'utf8.csv', content: 'name,email\nJosé Núñez,jose@example.com\n' });
    expect(response.status).toBe(200);
    expect(response.body.sample[0].name).toBe('José Núñez');
  });
});

describe('csv staging', () => {
  it('rejects a mapping without an email or a name field, an unknown column, and an unknown field', async () => {
    const noIdentity = await post('/api/imports/csv', { fileName: 'leads.csv', content: leadsCsv, mapping: { Company: 'company', 'Job Title': 'title' } });
    expect(noIdentity.status).toBe(400);
    expect(noIdentity.body.error.message).toContain('email column or a name column');

    const unknownColumn = await post('/api/imports/csv', { fileName: 'leads.csv', content: leadsCsv, mapping: { 'Work Email': 'email', Missing: 'name' } });
    expect(unknownColumn.status).toBe(400);
    expect(unknownColumn.body.error.message).toBe('mapping: column "Missing" is not in the file.');

    const unknownField = await post('/api/imports/csv', { fileName: 'leads.csv', content: leadsCsv, mapping: { 'Work Email': 'fax' } });
    expect(unknownField.status).toBe(400);

    const missing = await post('/api/imports/csv', { fileName: 'leads.csv', content: leadsCsv });
    expect(missing.status).toBe(400);

    const headerOnly = await post('/api/imports/csv', { fileName: 'leads.csv', content: 'email\n', mapping: { email: 'email' } });
    expect(headerOnly.status).toBe(400);
    expect(count('SELECT COUNT(*) AS n FROM import_batch')).toBe(0);
  });

  it('stages rows, validates, dedupes, waits for approval, and creates records with csv claims on approval', async () => {
    const existingOrganization = createOrganization(env.ctx, { name: 'Harbor Row', domain: 'harbor.example.org', kind: 'fund' });
    const existing = createPerson(env.ctx, {
      firstName: 'Ada',
      lastName: 'Quill',
      email: 'ada.quill@northwind.example.com',
      organizationId: null,
      tags: [],
    });

    const created = await post('/api/imports/csv', { fileName: 'leads.csv', content: leadsCsv, mapping: leadsMapping });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'csv_import', status: 'queued', title: 'CSV import: leads.csv', scope: { fileName: 'leads.csv' } });
    const runId = created.body.id as string;
    const batchId = created.body.scope.batchId as string;

    const queued = await get(`/api/imports/${batchId}?withRaw=true`);
    expect(queued.body).toMatchObject({ sourceKind: 'csv', status: 'staging', sourceRef: { fileName: 'leads.csv', rowCount: 4, delimiter: ',' } });
    expect(queued.body.items).toHaveLength(4);
    expect(queued.body.items[0].raw).toMatchObject({ 'First Name': 'Ada', Notes: 'Met at a demo day', Tags: 'seed; warm-intro' });
    expect(queued.body.items[0].mapped).toMatchObject({
      name: 'Ada Quill',
      email: 'ada.quill@northwind.example.com',
      domain: 'northwind.example.com',
      location: 'Port Alder, Aurelia',
      tags: ['seed', 'warm-intro'],
    });
    expect(queued.body.items[1].mapped.tags).toEqual(['angel', 'climate']);
    expect(count('SELECT COUNT(*) AS n FROM person WHERE email = ?', 'ben.marsh@harbor.example.org')).toBe(0);

    expect(driveRun(env, runId, ['waiting_approval'])).toBe('waiting_approval');
    const waiting = getRunDetail(env.db, env.workspaceId, runId);
    expect(waiting.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done']);
    const approval = waiting.approvals[0]!;
    expect(approval).toMatchObject({ kind: 'import_review', status: 'pending', title: 'Review 1 imported row from leads.csv' });
    expect(approval.payload).toMatchObject({ batchId, fileName: 'leads.csv', counts: { fetched: 4, staged: 1, duplicates: 2, invalid: 1 } });
    expect(approval.payload).not.toHaveProperty('willPromote');

    const reviewed = await get(`/api/imports/${batchId}`);
    expect(reviewed.body.status).toBe('awaiting_review');
    const statuses = reviewed.body.items.map((row: { status: string }) => row.status);
    expect(statuses).toEqual(['duplicate', 'staged', 'invalid', 'duplicate']);
    expect(reviewed.body.items[0]).toMatchObject({ matchEntityType: 'person', matchEntityId: existing.id, reason: 'Email matches an existing person.' });
    expect(reviewed.body.items[2].reason).toBe('No name or email found in this row.');
    expect(reviewed.body.items[1]).toMatchObject({ status: 'staged', matchEntityType: 'organization', matchEntityId: existingOrganization.id });
    expect(waiting.counts).toMatchObject({ processed: 4, found: 1, flagged: 3, staged: 1, duplicates: 2, invalid: 1 });

    const decided = decideApproval(env.ctx, approval.id, { decision: 'approve' });
    expect(decided.run.status).toBe('succeeded');
    expect(decided.run.counts).toMatchObject({ accepted: 1, found: 1 });

    const person = env.db.prepare("SELECT * FROM person WHERE email = 'ben.marsh@harbor.example.org'").get() as Record<string, string>;
    expect(person).toBeTruthy();
    expect(JSON.parse(person.tags!)).toEqual(['csv-import', `via-${runId}`, 'angel', 'climate']);
    expect(person.organization_id).toBe(existingOrganization.id);
    expect(person.title).toBe('Principal');
    const claims = env.db.prepare("SELECT field, value, source_type, source_url, extraction_method, status FROM field_claim WHERE entity_id = ? ORDER BY field").all(person.id!) as Record<string, string | null>[];
    expect(claims.map((claim) => claim.field)).toEqual(['company', 'email', 'location', 'name', 'title']);
    for (const claim of claims) {
      expect(claim).toMatchObject({ source_type: 'import', source_url: null, extraction_method: 'csv:leads.csv', status: 'imported' });
    }
    expect(count('SELECT COUNT(*) AS n FROM person')).toBe(2);
    expect((await get(`/api/imports/${batchId}`)).body.status).toBe('accepted');
  });

  it('creates a new organization from a company and domain, with csv tags and claims, and splits a tags column on commas or semicolons', async () => {
    const content = 'Name,Email,Company,Site,Labels\nNova Reed,nova@orbit.example.com,Orbit Fund,orbit.example.com,"a, b;c ,a"\n';
    const created = await post('/api/imports/csv', {
      fileName: 'orbit.csv',
      content,
      mapping: { Name: 'name', Email: 'email', Company: 'company', Site: 'domain', Labels: 'tags' },
    });
    expect(created.status).toBe(201);
    const runId = created.body.id as string;
    driveRun(env, runId, ['waiting_approval']);
    const approval = getRunDetail(env.db, env.workspaceId, runId).approvals[0]!;
    decideApproval(env.ctx, approval.id, { decision: 'approve' });

    const person = env.db.prepare("SELECT * FROM person WHERE email = 'nova@orbit.example.com'").get() as Record<string, string>;
    expect(JSON.parse(person.tags!)).toEqual(['csv-import', `via-${runId}`, 'a', 'b', 'c']);
    const organization = env.db.prepare("SELECT * FROM organization WHERE domain = 'orbit.example.com'").get() as Record<string, string>;
    expect(organization.name).toBe('Orbit Fund');
    expect(JSON.parse(organization.tags!)).toEqual(['csv-import', `via-${runId}`]);
    const organizationClaims = env.db.prepare('SELECT source_type, source_url, extraction_method FROM field_claim WHERE entity_id = ?').all(organization.id!) as Record<string, unknown>[];
    expect(organizationClaims.length).toBe(2);
    expect(organizationClaims.every((claim) => claim.source_type === 'import' && claim.source_url === null && claim.extraction_method === 'csv:orbit.csv')).toBe(true);
  });

  it('approves several hundred rows, linking each person to the right organization', async () => {
    const acme = createOrganization(env.ctx, { name: 'Acme Capital', kind: 'fund' });
    const beta = createOrganization(env.ctx, { name: 'Beta Holdings', domain: 'beta.example.com', kind: 'company' });
    const organizationsBefore = count('SELECT COUNT(*) AS n FROM organization');

    // 50 groups of 10 rows. Rows with an even pass (k) carry a domain and create the organization. Rows with an
    // odd pass carry only the company name and must find the organization created earlier in the same approval.
    const lines = ['Name,Email,Company,Site'];
    const expected = new Map<string, string>();
    for (let index = 0; index < 500; index += 1) {
      const group = index % 50;
      const pass = Math.floor(index / 50);
      const email = `bulk${index}@people.example.com`;
      let company = '';
      let site = '';
      if (group < 10) {
        company = `Group ${group} Fund`;
        site = `group${group}.example.com`;
        expected.set(email, `domain:group${group}.example.com`);
      } else if (group < 20) {
        company = pass % 2 === 0 ? `Group ${group} Fund` : `"GROUP ${group}, fund"`;
        site = pass % 2 === 0 ? `group${group}.example.com` : '';
        expected.set(email, `domain:group${group}.example.com`);
      } else if (group < 30) {
        site = `https://www.Solo${group}.example.com/about`;
        expected.set(email, `domain:solo${group}.example.com`);
      } else if (group < 40) {
        company = pass % 2 === 0 ? 'ACME capital' : 'Acme  Capital.';
        expected.set(email, `id:${acme.id}`);
      } else if (group < 45) {
        company = `Renamed ${group}`;
        site = 'beta.example.com';
        expected.set(email, `id:${beta.id}`);
      } else {
        expected.set(email, 'none');
      }
      lines.push(`Bulk ${index},${email},${company},${site}`);
    }
    const created = await post('/api/imports/csv', {
      fileName: 'bulk.csv',
      content: lines.join('\n'),
      mapping: { Name: 'name', Email: 'email', Company: 'company', Site: 'domain' },
    });
    expect(created.status).toBe(201);
    const runId = created.body.id as string;
    expect(driveRun(env, runId, ['waiting_approval'])).toBe('waiting_approval');
    const approval = getRunDetail(env.db, env.workspaceId, runId).approvals[0]!;
    expect(approval.payload).toMatchObject({ counts: { fetched: 500, staged: 500, duplicates: 0, invalid: 0 } });

    const decided = decideApproval(env.ctx, approval.id, { decision: 'approve' });
    expect(decided.run.status).toBe('succeeded');
    expect(decided.run.counts).toMatchObject({ accepted: 500 });

    // 10 organizations with a domain and a company, 10 company groups that mix both, 10 domain-only groups.
    expect(count('SELECT COUNT(*) AS n FROM organization') - organizationsBefore).toBe(30);
    const people = env.db
      .prepare(
        `SELECT p.email, p.organization_id, o.domain AS domain FROM person p LEFT JOIN organization o ON o.id = p.organization_id
         WHERE p.email LIKE 'bulk%@people.example.com'`,
      )
      .all() as { email: string; organization_id: string | null; domain: string | null }[];
    expect(people).toHaveLength(500);
    for (const person of people) {
      const want = expected.get(person.email)!;
      if (want === 'none') expect(person.organization_id).toBeNull();
      else if (want.startsWith('id:')) expect(person.organization_id).toBe(want.slice(3));
      else expect(person.domain).toBe(want.slice('domain:'.length));
    }
    // Each new organization is shared by every row of its group, and keeps the first spelling of the name.
    expect(count("SELECT COUNT(DISTINCT organization_id) AS n FROM person WHERE email LIKE 'bulk%@people.example.com'")).toBe(32);
    const groupFifteen = env.db.prepare("SELECT name FROM organization WHERE domain = 'group15.example.com'").all() as { name: string }[];
    expect(groupFifteen).toEqual([{ name: 'Group 15 Fund' }]);
    expect(count("SELECT COUNT(*) AS n FROM organization WHERE domain = 'beta.example.com'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM organization WHERE lower(name) LIKE 'acme%'")).toBe(1);
  });

  it('creates nothing when the import is rejected', async () => {
    const before = count('SELECT COUNT(*) AS n FROM person');
    const created = await post('/api/imports/csv', {
      fileName: 'skip.csv',
      content: 'name,email\nRory Vale,rory@vale.example.com\n',
      mapping: { name: 'name', email: 'email' },
    });
    const runId = created.body.id as string;
    driveRun(env, runId, ['waiting_approval']);
    const approval = getRunDetail(env.db, env.workspaceId, runId).approvals[0]!;
    const decided = decideApproval(env.ctx, approval.id, { decision: 'reject' });
    expect(decided.run.status).toBe('cancelled');
    expect(count('SELECT COUNT(*) AS n FROM person')).toBe(before);
    expect((await get(`/api/imports/${created.body.scope.batchId}`)).body.status).toBe('rejected');
  });

  it('finishes partial with no approval when every row is invalid or a duplicate', async () => {
    const created = await post('/api/imports/csv', {
      fileName: 'empty.csv',
      content: 'name,email,notes\n,,nothing\n',
      mapping: { name: 'name', email: 'email', notes: 'ignore' },
    });
    const runId = created.body.id as string;
    expect(driveRun(env, runId, ['partial'])).toBe('partial');
    const detail = getRunDetail(env.db, env.workspaceId, runId);
    expect(detail.approvals).toEqual([]);
    expect(detail.counts).toMatchObject({ fetched: 1, invalid: 1, staged: 0 });
  });

  it('cannot be started through POST /api/runs', async () => {
    const response = await post('/api/runs', { kind: 'csv_import', scope: {} });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation');
  });
});
