import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
const host = { host: '127.0.0.1:4720' };
let workDir: string;
let withWeb: FastifyInstance;
let withoutWeb: FastifyInstance;

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'agentcrm-static-'));
  const dist = path.join(workDir, 'dist');
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), '<html>shell</html>');
  writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(path.join(workDir, 'secret.txt'), 'TOPSECRETCONTENT');
  const base = { db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now };
  withWeb = buildApp({ ...base, webDist: dist });
  withoutWeb = buildApp({ ...base, webDist: null });
  await withWeb.ready();
  await withoutWeb.ready();
});

afterAll(async () => {
  await withWeb.close();
  await withoutWeb.close();
  rmSync(workDir, { recursive: true, force: true });
  env.cleanup();
});

const get = (app: FastifyInstance, url: string) => app.inject({ method: 'GET', url, headers: host });

describe('static web serving', () => {
  it('serves nothing at / without a web folder', async () => {
    expect((await get(withoutWeb, '/')).statusCode).toBe(404);
    expect((await get(withoutWeb, '/assets/app.js')).statusCode).toBe(404);
  });

  it('serves index and assets with a web folder', async () => {
    const index = await get(withWeb, '/');
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.body).toContain('shell');
    const asset = await get(withWeb, '/assets/app.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
  });

  it('lets API routes win', async () => {
    const health = await get(withWeb, '/api/health');
    expect(health.statusCode).toBe(200);
    expect(health.headers['content-type']).toContain('application/json');
  });

  it('refuses traversal, plain and encoded', async () => {
    for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/..%5csecret.txt', '/%00']) {
      const response = await get(withWeb, url);
      expect(response.body, url).not.toContain('TOPSECRETCONTENT');
      expect(response.statusCode, url).not.toBe(200);
    }
  });

  it('falls back to the app shell for route paths only', async () => {
    const leads = await get(withWeb, '/leads');
    expect(leads.statusCode).toBe(200);
    expect(leads.body).toContain('shell');
    const missingApi = await get(withWeb, '/api/missing');
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.body).toContain('not_found');
    expect((await get(withWeb, '/assets/missing.js')).statusCode).toBe(404);
    expect((await get(withWeb, '/missing.js')).statusCode).toBe(404);
  });
});
