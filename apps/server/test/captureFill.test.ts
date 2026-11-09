import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import type { DomainEvent } from '../src/events.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
  const t = await app.inject({ method: 'POST', url: '/api/capture/token', headers: { host: 'localhost:4720' } });
  token = JSON.parse(t.body).token as string;
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

async function capture(payload: unknown) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/capture',
    headers: { host: 'localhost:4720', authorization: `Bearer ${token}` },
    payload: payload as object,
  });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

const person = (id: string) => env.db.prepare('SELECT * FROM person WHERE id = ?').get(id) as Record<string, any>;
const claimFields = (id: string) =>
  (env.db.prepare('SELECT field FROM field_claim WHERE entity_id = ? ORDER BY field').all(id) as { field: string }[]).map((c) => c.field);
const updates = (id: string) =>
  env.db.prepare("SELECT detail FROM audit_event WHERE entity_id = ? AND action = 'capture.update'").all(id) as { detail: string }[];

// A bare person created by the capture path, then stripped to the shape a test needs.
async function bare(url: string, name = 'Fill Target') {
  const created = await capture({ source: 'linkedin', url, name });
  expect(created.status).toBe(201);
  return created.body.person.id as string;
}

const full = {
  headline: 'Engineer at Acme',
  company: 'Acme',
  location: 'Berlin',
  website: 'https://acme.example',
  email: 'Fill@Example.com',
  phone: '+1 555 000 1111',
};

describe('recapture fill-in', () => {
  it('fills empty title, location, email, and claim only fields on a URL hit, with one version bump', async () => {
    const url = 'https://www.linkedin.com/in/fill-one';
    const id = await bare(url);
    const before = person(id);
    const events: DomainEvent[] = [];
    const unsubscribe = env.bus.subscribe((event) => events.push(event));
    const { status, body } = await capture({ source: 'linkedin', url, name: 'Ignored Name', ...full });
    unsubscribe();
    expect(status).toBe(200);
    expect(body).toEqual({
      outcome: 'existing',
      person: { id, name: 'Fill Target' },
      added: ['title', 'location', 'email', 'website', 'company', 'phone'],
    });
    const after = person(id);
    expect(after).toMatchObject({ title: 'Engineer at Acme', location: 'Berlin', email: 'fill@example.com', first_name: before.first_name });
    expect(after.version).toBe(before.version + 1);
    expect(claimFields(id)).toEqual(['company', 'email', 'linkedinUrl', 'location', 'name', 'phone', 'title', 'website']);
    expect(events.filter((e) => e.type === 'record_updated' && e.entityId === id)).toHaveLength(1);
    expect(
      Number((env.db.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE entity_id = ? AND action = 'claim.create'").get(id) as { n: number }).n),
    ).toBe(2 + 6);
    // The same capture again fills nothing.
    const again = await capture({ source: 'linkedin', url, name: 'Fill Target', ...full });
    expect(again.body.added).toEqual([]);
    expect(person(id).version).toBe(after.version);
    expect(updates(id)).toHaveLength(1);
  });

  it('records keys and never values in the capture.update audit row', async () => {
    const id = await bare('https://www.linkedin.com/in/fill-audit');
    await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/fill-audit', name: 'x', headline: 'Secret Title', phone: '+1 555 222 3333' });
    const rows = updates(id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.detail)).toEqual({ fields: ['title', 'phone'] });
    expect(rows[0]!.detail).not.toContain('Secret Title');
    expect(rows[0]!.detail).not.toContain('555');
  });

  it('does not touch a column that has a value but no claim', async () => {
    const url = 'https://www.linkedin.com/in/fill-column';
    const id = await bare(url);
    env.db.prepare("UPDATE person SET title = 'Typed in the app' WHERE id = ?").run(id);
    const { body } = await capture({ source: 'linkedin', url, name: 'x', headline: 'From capture', location: 'Oslo' });
    expect(body.added).toEqual(['location']);
    expect(person(id).title).toBe('Typed in the app');
    expect(claimFields(id)).not.toContain('title');
  });

  it('does not touch a field that has a claim but an empty column', async () => {
    const url = 'https://www.linkedin.com/in/fill-claim';
    const id = await bare(url);
    env.db
      .prepare(
        "INSERT INTO field_claim (id, created_at, workspace_id, entity_type, entity_id, field, value, source_url, source_type, observed_at, status) VALUES ('clm_fill1', ?, ?, 'person', ?, 'location', 'Paris', 'https://x', 'manual', ?, 'human_confirmed')",
      )
      .run(new Date().toISOString(), env.workspaceId, id, new Date().toISOString());
    const { body } = await capture({ source: 'linkedin', url, name: 'x', location: 'Oslo', headline: 'Head' });
    expect(body.added).toEqual(['title']);
    expect(person(id).location).toBeNull();
  });

  it('fills claim only fields once and never twice', async () => {
    const url = 'https://www.linkedin.com/in/fill-claim-only';
    const id = await bare(url);
    const first = await capture({ source: 'linkedin', url, name: 'x', website: 'https://a.example', company: 'A', phone: '1 555' });
    expect(first.body.added).toEqual(['website', 'company', 'phone']);
    const second = await capture({ source: 'linkedin', url, name: 'x', website: 'https://b.example', company: 'B', phone: '2 555' });
    expect(second.body.added).toEqual([]);
    expect(claimFields(id).filter((f) => f === 'website')).toHaveLength(1);
  });

  it('skips an email that belongs to another person, silently', async () => {
    const other = await capture({ source: 'x', url: 'https://x.com/emailtaken', name: 'Taken', email: 'taken@example.com' });
    expect(other.status).toBe(201);
    const url = 'https://www.linkedin.com/in/fill-email-guard';
    const id = await bare(url);
    const { status, body } = await capture({ source: 'linkedin', url, name: 'x', email: 'TAKEN@example.com', headline: 'Head' });
    expect(status).toBe(200);
    expect(body.added).toEqual(['title']);
    expect(person(id).email).toBeNull();
    expect(person(other.body.person.id).email).toBe('taken@example.com');
  });

  it('gives an email-hit person the profile URL through the same rule', async () => {
    const first = await capture({ source: 'x', url: 'https://x.com/emailhit', name: 'Email Hit', email: 'hit@example.com' });
    const id = first.body.person.id as string;
    const { status, body } = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/emailhit', name: 'x', email: 'HIT@example.com' });
    expect(status).toBe(200);
    expect(body).toEqual({ outcome: 'existing', person: { id, name: 'Email Hit' }, added: ['profileUrl'] });
    expect(person(id).linkedin_url).toBe('https://www.linkedin.com/in/emailhit');
    expect(claimFields(id)).toContain('linkedinUrl');
  });

  it('does not overwrite a different profile URL already in the column', async () => {
    const first = await capture({ source: 'x', url: 'https://x.com/haslinkedin', name: 'Has Li', email: 'hasli@example.com' });
    const id = first.body.person.id as string;
    env.db.prepare("UPDATE person SET linkedin_url = 'https://www.linkedin.com/in/other' WHERE id = ?").run(id);
    const { body } = await capture({ source: 'linkedin', url: 'https://www.linkedin.com/in/mine', name: 'x', email: 'hasli@example.com' });
    expect(body.added).toEqual([]);
    expect(person(id).linkedin_url).toBe('https://www.linkedin.com/in/other');
  });

  it('writes nothing when nothing is filled', async () => {
    const url = 'https://www.linkedin.com/in/fill-nothing';
    const id = await bare(url);
    const before = person(id);
    const audits = Number((env.db.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as { n: number }).n);
    const events: DomainEvent[] = [];
    const unsubscribe = env.bus.subscribe((event) => events.push(event));
    const { status, body } = await capture({ source: 'linkedin', url, name: 'Fill Target' });
    unsubscribe();
    expect(status).toBe(200);
    expect(body).toEqual({ outcome: 'existing', person: { id, name: 'Fill Target' }, added: [] });
    expect(person(id).version).toBe(before.version);
    expect(person(id).updated_at).toBe(before.updated_at);
    expect(Number((env.db.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as { n: number }).n)).toBe(audits);
    expect(updates(id)).toHaveLength(0);
    expect(events.filter((e) => e.type === 'record_updated' && e.entityId === id)).toHaveLength(0);
  });

  it('fills on an x-source recapture and writes the xUrl column', async () => {
    const created = await capture({ source: 'x', url: 'https://x.com/fillx', name: 'Fill X' });
    const id = created.body.person.id as string;
    const { body } = await capture({ source: 'x', url: 'https://x.com/FillX', name: 'x', headline: 'Builder', location: 'Lisbon' });
    expect(body).toEqual({ outcome: 'existing', person: { id, name: 'Fill X' }, added: ['title', 'location'] });
    expect(person(id)).toMatchObject({ title: 'Builder', location: 'Lisbon' });
  });
});
