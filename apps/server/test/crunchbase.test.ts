import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganization } from '../src/actions/index.js';
import { canonicalCrunchbaseUrl, crunchbaseUrlMessage } from '../src/actions/profileUrls.js';
import { buildApp } from '../src/http/app.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
let app: FastifyInstance;
const host = { host: '127.0.0.1:4720' };

beforeAll(async () => {
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

async function patch(id: string, version: number, fields: Record<string, unknown>) {
  const r = await app.inject({ method: 'PATCH', url: `/api/organizations/${id}`, headers: host, payload: { expectedVersion: version, fields } });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

describe('canonicalCrunchbaseUrl', () => {
  const wanted = 'https://www.crunchbase.com/organization/acme-labs';

  it('accepts www, bare, and subdomain hosts, and a schemeless paste', () => {
    for (const input of [
      'https://www.crunchbase.com/organization/acme-labs',
      'http://crunchbase.com/organization/acme-labs',
      'https://app.crunchbase.com/organization/acme-labs',
      'HTTPS://WWW.CRUNCHBASE.COM/organization/acme-labs',
      'crunchbase.com/organization/acme-labs',
      '  www.crunchbase.com/organization/acme-labs  ',
    ]) {
      expect(canonicalCrunchbaseUrl(input), input).toBe(wanted);
    }
  });

  it('drops query, fragment, trailing slash, and a deeper path', () => {
    for (const input of [
      'https://www.crunchbase.com/organization/acme-labs/',
      'https://www.crunchbase.com/organization/acme-labs?utm_source=x',
      'https://www.crunchbase.com/organization/acme-labs#section',
      'https://www.crunchbase.com/organization/acme-labs/company_financials/?a=1#b',
    ]) {
      expect(canonicalCrunchbaseUrl(input), input).toBe(wanted);
    }
  });

  it('keeps the slug case and percent encoding', () => {
    expect(canonicalCrunchbaseUrl('https://www.crunchbase.com/organization/Acme_Labs-42')).toBe('https://www.crunchbase.com/organization/Acme_Labs-42');
    expect(canonicalCrunchbaseUrl('https://www.crunchbase.com/organization/caf%C3%A9-co/')).toBe('https://www.crunchbase.com/organization/caf%C3%A9-co');
  });

  it('refuses anything that is not an organization page', () => {
    for (const input of [
      'https://www.crunchbase.com/person/ada-quill',
      'https://www.crunchbase.com/organization/',
      'https://www.crunchbase.com/organization',
      'https://www.crunchbase.com/',
      'https://example.com/organization/acme',
      'https://notcrunchbase.com/organization/acme',
      'https://crunchbase.com.example.com/organization/acme',
      'https://user:pass@www.crunchbase.com/organization/acme',
      'https://www.crunchbase.com:8443/organization/acme',
      'ftp://www.crunchbase.com/organization/acme',
      `https://www.crunchbase.com/organization/${'a'.repeat(500)}`,
      '',
      '   ',
      'not a url',
      null,
      undefined,
      42,
    ]) {
      expect(canonicalCrunchbaseUrl(input), String(input)).toBeNull();
    }
  });

  it('accepts a canonical form of exactly 500 characters', () => {
    const prefix = 'https://www.crunchbase.com/organization/';
    const slug = 'a'.repeat(500 - prefix.length);
    expect(canonicalCrunchbaseUrl(`${prefix}${slug}`)).toBe(`${prefix}${slug}`);
  });
});

describe('organization Crunchbase link', () => {
  it('stores the canonical form from a messy paste, and null clears it', async () => {
    const organization = createOrganization(env.ctx, { name: 'Crunch Patch Co' });
    expect(organization.crunchbaseUrl).toBeNull();
    const set = await patch(organization.id, 1, { crunchbaseUrl: 'crunchbase.com/organization/Crunch-Patch/?utm=1#top' });
    expect(set.status).toBe(200);
    expect(set.body.crunchbaseUrl).toBe('https://www.crunchbase.com/organization/Crunch-Patch');
    const read = await app.inject({ method: 'GET', url: `/api/organizations/${organization.id}`, headers: host });
    expect(JSON.parse(read.body).crunchbaseUrl).toBe('https://www.crunchbase.com/organization/Crunch-Patch');
    const cleared = await patch(organization.id, 2, { crunchbaseUrl: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.crunchbaseUrl).toBeNull();
  });

  it('refuses a bad link with the message and leaves the record alone', async () => {
    const organization = createOrganization(env.ctx, { name: 'Crunch Bad Co' });
    const bad = await patch(organization.id, 1, { crunchbaseUrl: 'https://www.crunchbase.com/person/someone' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation');
    expect(JSON.stringify(bad.body)).toContain(crunchbaseUrlMessage);
    const row = env.db.prepare('SELECT crunchbase_url, version FROM organization WHERE id = ?').get(organization.id);
    expect(row).toEqual({ crunchbase_url: null, version: 1 });
  });

  it('creates an organization with a Crunchbase link, and refuses a bad one', () => {
    const organization = createOrganization(env.ctx, { name: 'Crunch Create Co', crunchbaseUrl: 'https://crunchbase.com/organization/crunch-create/' });
    expect(organization.crunchbaseUrl).toBe('https://www.crunchbase.com/organization/crunch-create');
    expect(() => createOrganization(env.ctx, { name: 'Crunch Nope Co', crunchbaseUrl: 'https://example.com/organization/x' })).toThrow();
  });
});
