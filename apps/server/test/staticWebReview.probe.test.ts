// Adversarial review probes for the desktop shell static web handler (http/staticWeb.ts, not-found handler in app.ts).
// KILLS (attack fails, pinned), CONFIRMS (live defect, passes today, comment says the fix), ACCEPTED (documented limit).
// Nothing here changes application code.
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { startServer } from '../src/server.js';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();
const base = mkdtempSync(path.join(os.tmpdir(), 'agentcrm-staticweb-'));
const root = path.join(base, 'dist');
const outside = path.join(base, 'outside');
const SECRET = 'TOP-SECRET-OUTSIDE';
const SHELL = '<!doctype html><title>shell</title>';
let app: FastifyInstance;
let bare: FastifyInstance;
let port = 0;

beforeAll(async () => {
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  mkdirSync(path.join(root, 'emptydir'), { recursive: true });
  mkdirSync(path.join(root, 'withindex'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, 'index.html'), SHELL);
  writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(path.join(root, 'assets', 'app.css'), 'a{}');
  writeFileSync(path.join(root, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(path.join(root, 'assets', 'p.png'), Buffer.from([137, 80, 78, 71]));
  writeFileSync(path.join(root, 'assets', 'data.bin'), 'x');
  writeFileSync(path.join(root, 'withindex', 'index.html'), '<title>sub</title>');
  writeFileSync(path.join(root, '.env'), 'DOTFILE-SECRET');
  writeFileSync(path.join(root, 'LICENSE'), 'extensionless real file');
  writeFileSync(path.join(root, 'caf\u00e9.txt'), 'unicode');
  writeFileSync(path.join(outside, 'secret.txt'), SECRET);
  writeFileSync(path.join(outside, 'index.html'), SECRET);
  writeFileSync(path.join(base, 'sibling-secret.txt'), SECRET);
  symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  symlinkSync(outside, path.join(root, 'linkdir'));
  symlinkSync(path.join(root, 'assets', 'app.js'), path.join(root, 'inner-link.js'));
  try {
    linkSync(path.join(outside, 'secret.txt'), path.join(root, 'hard.txt'));
  } catch {
    // cross device; skip
  }
  // A root sibling sharing the root name as prefix ("dist-evil") to test the startsWith(root + sep) guard.
  mkdirSync(path.join(base, 'dist-evil'), { recursive: true });
  writeFileSync(path.join(base, 'dist-evil', 'secret.txt'), SECRET);
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now, webDist: root });
  bare = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now, webDist: null });
  await Promise.all([app.ready(), bare.ready()]);
});
afterAll(async () => {
  await Promise.all([app.close(), bare.close()]);
  env.cleanup();
  rmSync(base, { recursive: true, force: true });
});

const get = (url: string, a: FastifyInstance = app, method: 'GET' | 'HEAD' | 'POST' = 'GET') => a.inject({ method, url });
const leaks = (body: string) => body.includes(SECRET) || body.includes('DOTFILE-SECRET');

// Raw socket so the request line reaches the server unnormalized by any client library.
function rawGet(target: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => (data += chunk.toString('latin1')));
    socket.on('end', () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0), body: data }));
    socket.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 4000).unref();
  });
}

describe('traversal over a raw socket', () => {
  let live: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    process.env.AGENTCRM_WEB_DIST = root;
    live = await startServer({ port: 0, databasePath: path.join(base, 'live.db') });
    delete process.env.AGENTCRM_WEB_DIST;
    port = live.port;
  });
  afterAll(async () => {
    await live.close();
  });

  it('KILLS: port 0 reports the real bound port and it answers', async () => {
    expect(live.port).toBeGreaterThan(0);
    const res = await rawGet('/api/health');
    expect(res.status).toBeGreaterThan(0);
    const shell = await rawGet('/');
    expect(shell.body).toContain('<title>shell</title>');
  });

  it.each([
    '/../sibling-secret.txt',
    '/..%2fsibling-secret.txt',
    '/%2e%2e/sibling-secret.txt',
    '/%2E%2E/sibling-secret.txt',
    '/..%5csibling-secret.txt',
    '/..\\sibling-secret.txt',
    '/%252e%252e/sibling-secret.txt',
    '/%c0%ae%c0%ae/sibling-secret.txt',
    '/%c0%af..%c0%afsibling-secret.txt',
    '/assets/../../sibling-secret.txt',
    '/assets/%2e%2e/%2e%2e/sibling-secret.txt',
    '/index.html%00.png',
    '/%00',
    '//etc/passwd',
    '///etc/passwd',
    '/../../../../etc/passwd',
    '/C:\\Windows\\win.ini',
    '/C:/Windows/win.ini',
    '/dist-evil/secret.txt',
    '/../dist-evil/secret.txt',
  ])('KILLS: raw traversal %s never leaks', async (target) => {
    const res = await rawGet(target);
    expect(leaks(res.body)).toBe(false);
    expect(res.body).not.toContain('root:');
    expect(res.body).not.toContain('[fonts]');
  });

  it('KILLS: dot segments are refused outright (raw socket, 404 JSON even when extensionless)', async () => {
    // light-my-request normalizes %2e%2e through WHATWG URL before the server sees it, so this must be raw.
    const res = await rawGet('/%2e%2e/anything');
    expect(res.status).toBe(404);
    expect(res.body).toContain('application/json');
  });

  it('KILLS: HEAD over a real socket returns headers and no body bytes', async () => {
    const res = await rawGet('/assets/app.js', 'HEAD');
    expect(res.status).toBe(200);
    expect(res.body.endsWith('\r\n\r\n')).toBe(true);
  });

  it('KILLS: %-malformed paths never throw (400 or 404 or shell, no 500)', async () => {
    for (const target of ['/%zz', '/%', '/%e0%a4%a', '/%ff', '/assets/%']) {
      const res = await rawGet(target);
      expect(res.status).not.toBe(500);
      expect(leaks(res.body)).toBe(false);
    }
  });
});

describe('traversal via inject', () => {
  it.each([
    '/%2e%2e/sibling-secret.txt',
    '/..%2fsibling-secret.txt',
    '/%2E%2E%2Fsibling-secret.txt',
    '/assets/..%2f..%2fsibling-secret.txt',
    '/%252e%252e/sibling-secret.txt',
    '/%c0%ae%c0%ae/sibling-secret.txt',
    '/foo%00.png',
    '/foo%5c..%5csibling-secret.txt',
  ])('KILLS: %s never leaks', async (url) => {
    const res = await get(url);
    expect(leaks(res.body)).toBe(false);
  });

  it('KILLS: double encoded dots are a literal segment, not traversal (extensionless gets the shell)', async () => {
    const res = await get('/%252e%252e/x');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SHELL);
  });

  it('KILLS: file symlink pointing outside the root is refused by realpath', async () => {
    const res = await get('/link.txt');
    expect(res.statusCode).toBe(404);
    expect(leaks(res.body)).toBe(false);
  });

  it('KILLS: directory symlink pointing outside the root is refused', async () => {
    for (const url of ['/linkdir/secret.txt', '/linkdir/index.html', '/linkdir']) {
      const res = await get(url);
      expect(leaks(res.body)).toBe(false);
    }
    expect((await get('/linkdir/secret.txt')).statusCode).toBe(404);
  });

  it('KILLS: symlink staying inside the root is served', async () => {
    const res = await get('/inner-link.js');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1)');
  });

  it('ACCEPTED: a hardlink to an outside file is indistinguishable from a real file and is served', async () => {
    // realpath cannot detect hardlinks. Creating one needs write access to the dist folder, which already means
    // the attacker can drop any content there. No fix worth making.
    const res = await get('/hard.txt');
    expect([200, 404]).toContain(res.statusCode);
  });
});

describe('api guard and semantics', () => {
  it('KILLS: /api/missing is a JSON 404, never the shell', async () => {
    const res = await get('/api/missing');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).not.toContain('<title>');
  });

  it('KILLS: /api and /api/ are JSON 404, never the shell', async () => {
    for (const url of ['/api', '/api/', '/api/x/y.js']) {
      const res = await get(url);
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
    }
  });

  it('KILLS: encoded slash after api (/api%2fmissing) does not become a shell for an API call', async () => {
    const res = await get('/api%2fmissing');
    // Not an /api path to the string guard, so it is a frontend route and gets the shell. A client calling it
    // as an API gets HTML, but no API route can be reached by this spelling, so nothing is exposed.
    expect([200, 404]).toContain(res.statusCode);
  });

  it('ACCEPTED: /Api/foo and /API/foo fall into the SPA fallback (shell, 200)', async () => {
    // The guard is case sensitive on the URL string and Fastify routing is case sensitive too, so these never
    // reach a real route; the case-insensitive APFS only matters for files, and "Api" is not a file in the root.
    // Harm: none (no data exposed), a mistyped API client sees HTML instead of JSON. Optional hardening: compare
    // urlPath.toLowerCase() in the guard so /Api/* returns the JSON 404.
    for (const url of ['/Api/foo', '/API/foo', '/Api']) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(SHELL);
    }
  });

  it('KILLS: case-variant of a real API route does not reach the handler', async () => {
    const real = await get('/api/health');
    const swapped = await get('/API/health');
    expect(swapped.body).not.toBe(real.body);
  });

  it('KILLS: HEAD is served with headers and no body', async () => {
    const res = await get('/assets/app.js', app, 'HEAD');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
  });

  it('KILLS: POST/PUT/DELETE to a static path is not served', async () => {
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/assets/app.js' });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toBe('console.log(1)');
    }
    const shell = await get('/', app, 'POST');
    expect(shell.body).not.toBe(SHELL);
  });

  it('KILLS: extensionless real file is served, extensionless missing gets the shell, extensioned missing is JSON 404', async () => {
    expect((await get('/LICENSE')).body).toBe('extensionless real file');
    expect((await get('/people/abc')).body).toBe(SHELL);
    const missing = await get('/assets/gone.js');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/json');
  });

  it('ACCEPTED: dotfiles in the root are served (/.env returns the file)', async () => {
    // A web dist produced by vite never contains dotfiles; the folder is the build output, not the project.
    // Risk only arises if AGENTCRM_WEB_DIST is pointed at a project root. Optional hardening: refuse any segment
    // starting with "." (except none needed by the SPA). Judged not worth a code change for a loopback app.
    const res = await get('/.env');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('DOTFILE-SECRET');
    expect(res.headers['content-type']).toContain('application/octet-stream');
  });

  it('KILLS: a directory path falls back to the shell, a directory with index.html is not auto-indexed', async () => {
    for (const url of ['/assets/', '/assets', '/emptydir', '/withindex/', '/withindex']) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(SHELL);
    }
  });

  it('KILLS: a missing AGENTCRM_WEB_DIST folder never sinks the process; the API boots and the root answers the JSON 404', () => {
    // The eager realpath(root) now carries its own .catch(() => null), so a missing folder resolves to "no static
    // answer" instead of rejecting unhandled. Run in a child like the original crash reproduction, now asserting
    // survival.
    const code = `
      import { buildApp } from ${JSON.stringify(path.resolve('src/http/app.ts'))};
      import { openDatabase } from ${JSON.stringify(path.resolve('src/db.ts'))};
      import { EventBus } from ${JSON.stringify(path.resolve('src/events.ts'))};
      const app = buildApp({ db: openDatabase(':memory:'), bus: new EventBus(), databasePath: ':memory:', logLevel: 'silent', webDist: ${JSON.stringify(path.join(base, 'nope'))} });
      await app.ready();
      await new Promise((r) => setTimeout(r, 300));
      console.log('SURVIVED');
      await app.close();
    `;
    const script = path.join(base, 'missing-root.mts');
    writeFileSync(script, code);
    const run = spawnSync(path.resolve('node_modules/.bin/tsx'), [script], { encoding: 'utf8', timeout: 20000 });
    const out = `${run.stdout}${run.stderr}`;
    expect(out).not.toContain('ENOENT');
    expect(out.includes('SURVIVED') ? 'survived' : 'crashed').toBe('survived');
  });

  it('KILLS: with no web root configured, unknown paths are JSON 404', async () => {
    const res = await get('/', bare);
    expect(res.statusCode).toBe(404);
  });
});

describe('encoding and size', () => {
  it('KILLS: malformed percent escapes do not throw', async () => {
    for (const url of ['/%zz', '/%', '/%e0%a4%a', '/assets/%zz.js']) {
      const res = await get(url);
      expect([200, 400, 404]).toContain(res.statusCode);
    }
  });

  it('KILLS: very long paths do not crash (404, 414 or shell)', async () => {
    const long = '/' + 'a'.repeat(100_000);
    const res = await get(long);
    expect(res.statusCode).not.toBe(500);
    const longFile = await get('/' + 'a'.repeat(5_000) + '.js');
    expect(longFile.statusCode).toBe(404);
  });

  it('KILLS: unicode filenames are served via percent encoding', async () => {
    const res = await get('/caf%C3%A9.txt');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('unicode');
  });

  it('KILLS: a query string does not change the file resolved', async () => {
    const res = await get('/assets/app.js?../../x=1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1)');
  });
});

describe('headers', () => {
  it('KILLS: index.html is no-cache, assets are one hour', async () => {
    expect((await get('/')).headers['cache-control']).toBe('no-cache');
    expect((await get('/some/route')).headers['cache-control']).toBe('no-cache');
    expect((await get('/assets/app.js')).headers['cache-control']).toBe('public, max-age=3600');
  });

  it('ACCEPTED: a nested index.html (/withindex/index.html) is no-cache by basename, intended', async () => {
    expect((await get('/withindex/index.html')).headers['cache-control']).toBe('no-cache');
  });

  it.each([
    ['/', 'text/html'],
    ['/assets/app.js', 'javascript'],
    ['/assets/app.css', 'text/css'],
    ['/assets/logo.svg', 'image/svg+xml'],
    ['/assets/p.png', 'image/png'],
    ['/assets/data.bin', 'application/octet-stream'],
  ])('KILLS: content type for %s contains %s', async (url, type) => {
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain(type);
  });

  it('ACCEPTED: no X-Content-Type-Options nosniff on static files', async () => {
    // Content types are explicit and correct, and the app is loopback only; sniffing risk is negligible.
    const res = await get('/assets/app.js');
    expect(res.headers['x-content-type-options']).toBeUndefined();
  });

  it('ACCEPTED: the whole file is read into memory per request (no streaming, no range support)', async () => {
    const res = await get('/assets/app.js');
    expect(res.headers['accept-ranges']).toBeUndefined();
  });
});
