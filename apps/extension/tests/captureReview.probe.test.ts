// Adversarial review probes for the browser capture extension. CONFIRMS: the bug is real and the test passes because
// it is. KILLS: a safety property holds. Nothing here changes application code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeBaseUrl, sendCapture, verifyConnection } from '../src/api';
import { extractLinkedinProfile } from '../src/extract/linkedin';
import { validEmail } from '../src/extract/common';
import { extractXProfile, isProfileView } from '../src/extract/x';

// node:fs is loaded through a variable so the extension tsconfig (browser types only) still typechecks this file.
const nodeFs: any = await import(/* @vite-ignore */ ['node', 'fs'].join(':'));
const { readFileSync, readdirSync } = nodeFs as { readFileSync: (p: string, enc: string) => string; readdirSync: (p: string) => string[] };
// vitest runs with the package folder as the working directory.
const root: string = (globalThis as any).process.cwd();
const join = (...parts: string[]) => parts.join('/');
const page = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

// Drives a real content script (chip.ts included) in jsdom. The chip lives in a closed shadow root, so
// attachShadow is wrapped to keep a handle on it. Nothing else about the script is altered.
interface Harness {
  button(): HTMLButtonElement | null;
  host(): HTMLElement | null;
  sendMessage: ReturnType<typeof vi.fn>;
  navigate(pathAndQuery: string): Promise<void>;
  settle(ms?: number): Promise<void>;
}

const roots: ShadowRoot[] = [];
const realAttach = Element.prototype.attachShadow;

async function boot(script: 'linkedin' | 'x', initialPath: string, html: string, reply: (msg: any) => unknown): Promise<Harness> {
  vi.resetModules();
  vi.useFakeTimers();
  roots.length = 0;
  document.documentElement.innerHTML = html;
  history.pushState({}, '', initialPath);
  const sendMessage = vi.fn(async (msg: any) => reply(msg));
  vi.stubGlobal('chrome', { runtime: { sendMessage, id: 'ext' } });
  await import(script === 'linkedin' ? '../src/content/linkedin' : '../src/content/x');
  const h: Harness = {
    sendMessage,
    host: () => document.getElementById('agentcrm-capture-host'),
    button: () => (roots.length > 0 ? (roots[roots.length - 1]!.querySelector('button') as HTMLButtonElement | null) : null),
    navigate: async (p) => {
      history.pushState({}, '', p);
    },
    settle: async (ms = 0) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
  return h;
}

beforeEach(() => {
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const shadow = realAttach.call(this, init);
    roots.push(shadow);
    return shadow;
  };
});
afterEach(() => {
  Element.prototype.attachShadow = realAttach;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.innerHTML = '<head></head><body></body>';
});

const ldPerson = (name: string, extra: Record<string, unknown> = {}) =>
  `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Person', name, ...extra })}</script>`;

describe('stale page data attached to the wrong profile', () => {
  it('KILLS: linkedin SPA navigation keeps the old head, so profile B degrades to the floor instead of taking profile A fields', async () => {
    const staleHead =
      ldPerson('Alice Alpha', { jobTitle: 'CEO', url: 'https://www.linkedin.com/in/alice-a' }) +
      '<meta property="og:url" content="https://www.linkedin.com/in/alice-a"><meta property="og:title" content="Alice Alpha - CEO | LinkedIn">';
    const h = await boot('linkedin', '/in/alice-a', `<head>${staleHead}</head><body><h1>Alice Alpha</h1></body>`, () => ({
      ok: true,
      outcome: 'created',
      personName: 'x',
    }));
    // The user follows an in-app link. The URL changes, LinkedIn has not rewritten JSON-LD / og tags yet (or ever).
    await h.navigate('/in/bob-b');
    await h.settle(900);
    h.button()!.click();
    await h.settle(0);
    const payload = h.sendMessage.mock.calls[0]![0].payload;
    expect(payload.url).toBe('http://localhost:3000/in/bob-b');
    expect(payload.name).toBe('bob b');
    expect(payload.headline).toBeUndefined();
  });

  it('KILLS: a JSON-LD Person whose url or sameAs names a different /in/ id is skipped, a matching or url-less one is kept', () => {
    const url = new URL('https://www.linkedin.com/in/Bob-B');
    const other = page(`<head>${ldPerson('Alice Alpha', { jobTitle: 'CEO', url: 'https://www.linkedin.com/in/alice-a' })}</head>`);
    expect(extractLinkedinProfile(other, url)).toEqual({ name: 'Bob B' });
    const sameAs = page(`<head>${ldPerson('Alice Alpha', { sameAs: ['https://twitter.com/alice', 'https://www.linkedin.com/in/alice-a/'] })}</head>`);
    expect(extractLinkedinProfile(sameAs, url).name).toBe('Bob B');
    const atId = page(`<head>${ldPerson('Alice Alpha', { '@id': 'https://www.linkedin.com/in/alice-a#person' })}</head>`);
    expect(extractLinkedinProfile(atId, url).name).toBe('Bob B');
    const same = page(`<head>${ldPerson('Bob Beta', { jobTitle: 'CTO', url: 'https://www.linkedin.com/in/bob-b' })}</head>`);
    expect(extractLinkedinProfile(same, url)).toEqual({ name: 'Bob Beta', headline: 'CTO' });
    const noUrl = page(`<head>${ldPerson('Bob Beta', { sameAs: ['https://twitter.com/bob'] })}</head>`);
    expect(extractLinkedinProfile(noUrl, url).name).toBe('Bob Beta');
  });

  it('KILLS: og:url or canonical naming a different /in/ id marks the whole head stale, so og:title and h1 are skipped', () => {
    const url = new URL('https://www.linkedin.com/in/bob-b');
    const head = (extra: string) => `<head><meta property="og:title" content="Alice Alpha - CEO | LinkedIn">${extra}</head><body><h1>Alice Alpha</h1></body>`;
    for (const extra of [
      '<meta property="og:url" content="https://www.linkedin.com/in/alice-a">',
      '<link rel="canonical" href="https://www.linkedin.com/in/alice-a/">',
    ]) {
      expect(extractLinkedinProfile(page(head(extra)), url)).toEqual({ name: 'bob b' });
    }
    const matching = extractLinkedinProfile(page(head('<meta property="og:url" content="https://www.linkedin.com/in/BOB-B">')), url);
    expect(matching).toEqual({ name: 'Alice Alpha', headline: 'CEO' });
    expect(extractLinkedinProfile(page(head('<meta property="og:url" content="https://www.linkedin.com/feed/">')), url).name).toBe('Alice Alpha');
  });

  it('KILLS: a click inside the 800 ms poll window sends the NEW url with floor data, never the OLD profile header', async () => {
    const h = await boot('x', '/alice', `<body><div data-testid="UserName"><span>Alice Alpha</span><span>@alice</span></div></body>`, () => ({ ok: true, outcome: 'created', personName: 'x' }));
    await h.navigate('/bob');
    // No timer tick yet: the chip still shows for the previous profile.
    h.button()!.click();
    await h.settle(0);
    const payload = h.sendMessage.mock.calls[0]![0].payload;
    expect(payload.url).toBe('http://localhost:3000/bob');
    expect(payload.name).toBe('bob');
    expect(payload.handle).toBe('bob');
  });

  it('KILLS: x header from another handle is skipped whole (name, bio, location, website), and the title must match too', () => {
    const header = `<div data-testid="UserName"><span>Alice Alpha</span><span>@alice</span></div>
      <div data-testid="UserDescription">Alice bio</div>
      <div data-testid="UserProfileHeader_Items"><span data-testid="UserLocation">Paris</span><a data-testid="UserUrl">alice.example</a></div>`;
    const doc = page(`<head><title>Alice Alpha (@alice) / X</title></head><body>${header}</body>`);
    expect(extractXProfile(doc, new URL('https://x.com/bob'))).toEqual({ name: 'bob', handle: 'bob' });
    // The title alone is used only when its handle matches the url handle, compared case insensitively.
    const titled = page('<head><title>Bob Beta (@BOB) / X</title></head><body></body>');
    expect(extractXProfile(titled, new URL('https://x.com/bob')).name).toBe('Bob Beta');
    const staleTitle = page('<head><title>Alice Alpha (@alice) / X</title></head><body></body>');
    expect(extractXProfile(staleTitle, new URL('https://x.com/bob')).name).toBe('bob');
    // A matching header keeps today's behavior, case insensitive.
    const own = page(`<body>${header.replace('@alice', '@BOB')}</body>`);
    expect(extractXProfile(own, new URL('https://x.com/bob'))).toMatchObject({ name: 'Alice Alpha', handle: 'BOB', bio: 'Alice bio', location: 'Paris' });
  });

  it('KILLS: linkedin never takes a name from a generic error or sign up title when the head names the same profile', () => {
    for (const title of ['Page not found | LinkedIn', 'Sign Up | LinkedIn', 'Sign In | LinkedIn', 'Join LinkedIn | LinkedIn', 'LinkedIn | LinkedIn', ' page NOT found | LinkedIn']) {
      const doc = page(`<head><title>${title}</title><meta property="og:url" content="https://www.linkedin.com/in/real-person-123"><meta property="og:title" content="${title}"></head><body></body>`);
      const profile = extractLinkedinProfile(doc, new URL('https://www.linkedin.com/in/real-person-123'));
      expect(profile.name, title).toBe('real person 123');
    }
  });

  it('KILLS: the profile not found title is rejected too and the capture degrades to the floor (fixed from CONFIRMS)', () => {
    const doc = page('<head><title>Profile Not Found | LinkedIn</title></head><body></body>');
    expect(extractLinkedinProfile(doc, new URL('https://www.linkedin.com/in/real-person-123')).name).toBe('real person 123');
  });
});

describe('payload shape against the server limits', () => {
  it('KILLS: the url sent is origin plus pathname only, so a long tracking query or hash never reaches the server limit', async () => {
    const tracking = '?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACoAAB' + 'x'.repeat(200) + '&lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_all%3B' + 'y'.repeat(260);
    const h = await boot('linkedin', `/in/jane-doe${tracking}`, `<body><h1>Jane Doe</h1></body>`, () => ({ ok: true, outcome: 'created', personName: 'x' }));
    h.button()!.click();
    await h.settle(0);
    const payload = h.sendMessage.mock.calls[0]![0].payload;
    expect(payload.url).toBe('http://localhost:3000/in/jane-doe');
    expect(payload.url).not.toMatch(/[?#]/);
    expect(payload.url.length).toBeLessThanOrEqual(500);
  });

  it('KILLS: the x content script also sends origin plus pathname only', async () => {
    const h = await boot('x', '/jack/with_replies?s=20&t=abc#frag', `<body></body>`, () => ({ ok: true, outcome: 'created', personName: 'x' }));
    h.button()!.click();
    await h.settle(0);
    expect(h.sendMessage.mock.calls[0]![0].payload.url).toBe('http://localhost:3000/jack/with_replies');
  });

  it('KILLS: every string the extension accepts as an email also passes the server (zod) email check', async () => {
    const { z } = await import('../../server/node_modules/zod');
    const leaking = ['a.@b.co', '.a@b.co', 'a..b@c.co', 'a@-b.co', 'a@b.c', 'a@b.123', 'üser@b.co'];
    for (const c of leaking) expect(validEmail(c), c).toBeUndefined();
    const candidates = [...leaking, 'a@b-.co', "a'b@c.co", 'a@b..co', 'jane@example.com', 'mailto:Jane.Doe+x@sub.example.co.uk', ' a_b-c@d-e.io ', 'a@b', 'a b@c.co', '<a@b.co>', 'x@y.z.com', '"a"@b.co'];
    for (const c of candidates) {
      const accepted = validEmail(c);
      if (accepted !== undefined) expect(z.string().email().safeParse(accepted).success, c).toBe(true);
    }
    expect(validEmail('jane@example.com')).toBe('jane@example.com');
    expect(validEmail('mailto:Jane.Doe+x@sub.example.co.uk')).toBe('Jane.Doe+x@sub.example.co.uk');
  });
});

describe('chip behavior', () => {
  const ok = () => ({ ok: true, outcome: 'created', personName: 'x' });

  it('KILLS: a response for profile A cannot paint Added onto profile B after fast navigation (generation counter)', async () => {
    let resolveA: (v: unknown) => void = () => undefined;
    const h = await boot('linkedin', '/in/aaa', `<body><h1>Aaa Person</h1></body>`, () => new Promise((r) => (resolveA = r)));
    h.button()!.click();
    await h.settle(0);
    expect(h.button()!.textContent).toBe('Adding');
    await h.navigate('/in/bbb');
    await h.settle(900);
    expect(h.button()!.textContent).toBe('Add to AgentCRM');
    resolveA(ok());
    await h.settle(0);
    expect(h.button()!.textContent).toBe('Add to AgentCRM');
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('KILLS: a page cannot trigger a capture by clicking, focusing, or dispatching events on the chip host', async () => {
    const h = await boot('linkedin', '/in/victim', `<body><h1>Victim</h1></body>`, ok);
    const host = h.host()!;
    expect(host.shadowRoot).toBeNull();
    host.click();
    host.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await h.settle(100);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('CONFIRMS: the host element has a fixed id in the page DOM, so any page script can detect the extension and restyle or hide it', async () => {
    const h = await boot('x', '/someone', `<body></body>`, ok);
    expect(document.getElementById('agentcrm-capture-host')).not.toBeNull();
    const style = document.createElement('style');
    style.textContent = '#agentcrm-capture-host{opacity:0 !important}';
    document.head.append(style);
    expect(h.host()!.isConnected).toBe(true);
  });

  it('CONFIRMS: the unauthorized error state is sticky until navigation and a click only opens options', async () => {
    const h = await boot('x', '/someone', `<body></body>`, (msg) => (msg.kind === 'capture' ? { ok: false, code: 'unauthorized', message: 'nope' } : { ok: true }));
    h.button()!.click();
    await h.settle(0);
    expect(h.button()!.textContent).toBe('Open the extension options to set the token');
    await h.settle(60_000);
    expect(h.button()!.textContent).toBe('Open the extension options to set the token');
    h.button()!.click();
    await h.settle(0);
    expect(h.sendMessage.mock.calls.map((c) => c[0].kind)).toEqual(['capture', 'openOptions']);
  });

  it('KILLS: server text shown on the chip is rendered as text, not markup', async () => {
    const h = await boot('x', '/someone', `<body></body>`, () => ({ ok: false, code: 'validation', message: '<img src=x onerror=alert(1)> bad' }));
    h.button()!.click();
    await h.settle(0);
    const root = roots[roots.length - 1]!;
    expect(root.querySelector('img')).toBeNull();
    expect(h.button()!.textContent).toContain('<img');
  });

  it('KILLS: build() never throws on empty, hostile, or deeply nested documents (the click always gets an answer)', async () => {
    const deep = '['.repeat(4000) + ']'.repeat(4000);
    const hostile = `<head><title>${'T'.repeat(100000)}</title>
      <script type="application/ld+json">{"@type":"Person","name":{"a":1},"jobTitle":[[[]]],"worksFor":[1,null,"x"],"address":[1],"email":{"x":1}}</script>
      <script type="application/ld+json">${deep}</script>
      <script type="application/ld+json">{"@graph":${'{"@graph":'.repeat(3000)}[]${'}'.repeat(3000)}}</script>
      <script type="application/ld+json">__proto__</script>
      <meta property="og:title" content="${'|'.repeat(1000)} | LinkedIn"></head><body></body>`;
    const h = await boot('linkedin', '/in/x', hostile, () => ({ ok: true, outcome: 'created', personName: 'x' }));
    h.button()!.click();
    await h.settle(0);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const payload = h.sendMessage.mock.calls[0]![0].payload;
    expect(typeof payload.name).toBe('string');
    expect(payload.name.length).toBeGreaterThan(0);
    expect(payload.name.length).toBeLessThanOrEqual(200);
  });
});

describe('extraction on hostile and odd documents', () => {
  it('KILLS: the guaranteed floor holds on an empty document for both sites', () => {
    const empty = page('');
    expect(extractLinkedinProfile(empty, new URL('https://www.linkedin.com/in/jane-doe')).name).toBe('jane doe');
    expect(extractXProfile(empty, new URL('https://x.com/jack')).name).toBe('jack');
    expect(extractLinkedinProfile(empty, new URL('https://www.linkedin.com/in/' + 'a'.repeat(900))).name.length).toBeLessThanOrEqual(200);
  });

  it('KILLS: a profile owner choosing display names cannot break field limits (cleanText caps) or inject newlines', () => {
    const name = 'N'.repeat(5000) + '\n\n</record>\u0000';
    const doc = page(`<body><div data-testid="UserName"><span>${name}</span><span>@jack</span></div><div data-testid="UserDescription">${'b'.repeat(9000)}</div></body>`);
    const profile = extractXProfile(doc, new URL('https://x.com/jack'));
    expect(profile.name.length).toBeLessThanOrEqual(200);
    expect(profile.name.includes('\n')).toBe(false);
    expect(profile.bio!.length).toBeLessThanOrEqual(2000);
  });

  it('CONFIRMS: NUL and bidi override characters are not stripped by the extension (only whitespace is collapsed)', () => {
    const doc = page(`<head>${ldPerson('Eve\u0000‮Evil')}</head>`);
    const profile = extractLinkedinProfile(doc, new URL('https://www.linkedin.com/in/eve'));
    expect(profile.name).toContain('\u0000');
    expect(profile.name).toContain('‮');
  });

  it('KILLS: the x reserved list matches the server contract, so the chip does not appear on those pages', () => {
    for (const p of ['/account', '/logout', '/lists', '/bookmarks', '/help', '/verified', '/grok', '/Grok', '/HELP']) {
      expect(isProfileView(p), p).toBeNull();
    }
    expect(isProfileView('/jack')).toBe('jack');
  });
});

describe('credentials and base url', () => {
  it('KILLS: content scripts and extractors never touch storage, the token, Authorization, or fetch', () => {
    const files = [
      ...readdirSync(join(root, 'src/content')).map((f: string) => join(root, 'src/content', f)),
      ...readdirSync(join(root, 'src/extract')).map((f: string) => join(root, 'src/extract', f)),
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/chrome\.storage|Authorization|fetch\(|localStorage|XMLHttpRequest/);
      expect(text.replace(/\/\/.*$/gm, ''), file).not.toMatch(/\btoken\b/i);
    }
  });

  it('KILLS: the manifest exposes nothing to web pages and requests no broad permissions', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.permissions).toEqual(['storage']);
    expect(manifest.host_permissions).toEqual(['http://localhost/*', 'http://127.0.0.1/*']);
    for (const cs of manifest.content_scripts) {
      expect(cs.all_frames).toBeUndefined();
      for (const m of cs.matches) expect(m.startsWith('https://')).toBe(true);
    }
  });

  it('KILLS: content script match patterns cover every host the server accepts for x', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    const x = manifest.content_scripts.flatMap((c: any) => c.matches) as string[];
    for (const host of ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']) {
      expect(x).toContain(`https://${host}/*`);
    }
  });

  it('CONFIRMS: a non local base url receives the bearer token with no warning or validation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    await sendCapture({ baseUrl: 'https://evil.example', token: 'cap_secret' }, { source: 'x', url: 'https://x.com/a', name: 'A' }, fetchImpl);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://evil.example/api/capture');
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer cap_secret' });
    await verifyConnection('http://localhost@evil.example', 'cap_secret', fetchImpl).catch(() => undefined);
  });

  it('CONFIRMS: a base url with a path or query is concatenated blindly', () => {
    expect(`${normalizeBaseUrl('http://localhost:4720/?x=1')}/api/capture`).toBe('http://localhost:4720/?x=1/api/capture');
    expect(`${normalizeBaseUrl('http://localhost:4720/api')}/api/capture`).toBe('http://localhost:4720/api/api/capture');
  });

  it('KILLS: a failing fetch, a non JSON reply, and a 500 all come back as results, never throw, and never echo the token', async () => {
    const payload = { source: 'x' as const, url: 'https://x.com/a', name: 'A' };
    const cases: Array<() => Promise<Response>> = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(new Response('<html>oops</html>', { status: 500 })),
      () => Promise.resolve(new Response('not json', { status: 200 })),
      () => Promise.resolve(new Response('', { status: 204 })),
    ];
    for (const make of cases) {
      const result = await sendCapture({ baseUrl: '', token: 'cap_secret_value' }, payload, make as never);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('cap_secret_value');
    }
  });
});

describe('background worker', () => {
  async function bootBackground(stored: Record<string, unknown>, fetchImpl: (...a: any[]) => Promise<Response>) {
    vi.resetModules();
    let listener: ((m: unknown, sender: { id?: string }, respond: (r: unknown) => void) => boolean) | undefined;
    let actionListener: (() => void) | undefined;
    const openOptionsPage = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: { id: 'ext', openOptionsPage, onMessage: { addListener: (l: typeof listener) => (listener = l) } },
      action: { onClicked: { addListener: (l: () => void) => (actionListener = l) } },
      storage: { local: { get: vi.fn(async (defaults: Record<string, unknown>) => ({ ...defaults, ...stored })) } },
    });
    vi.stubGlobal('fetch', fetchImpl);
    await import('../src/background');
    return { listener: listener!, actionListener: actionListener!, openOptionsPage };
  }

  it('KILLS: clicking the toolbar icon opens the options page, the only way in from the toolbar since there is no popup', async () => {
    const { actionListener, openOptionsPage } = await bootBackground({}, vi.fn());
    expect(actionListener).toBeTypeOf('function');
    actionListener();
    expect(openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it('KILLS: messages from another extension or a web page sender, and unknown kinds, are ignored without a response', async () => {
    const fetchImpl = vi.fn();
    const { listener, openOptionsPage } = await bootBackground({ token: 'cap_secret', baseUrl: 'http://localhost:4720' }, fetchImpl);
    const respond = vi.fn();
    const payload = { source: 'x', url: 'https://x.com/a', name: 'A' };
    for (const sender of [{ id: 'other-extension' }, {}, { id: undefined }]) {
      expect(listener({ kind: 'capture', payload }, sender, respond)).toBe(false);
      expect(listener({ kind: 'openOptions' }, sender, respond)).toBe(false);
    }
    expect(listener({ kind: 'dump-token' }, { id: 'ext' }, respond)).toBe(false);
    expect(listener(null, { id: 'ext' }, respond)).toBe(false);
    expect(listener('capture', { id: 'ext' }, respond)).toBe(false);
    await Promise.resolve();
    expect(respond).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(openOptionsPage).not.toHaveBeenCalled();
  });

  it('KILLS: an accepted capture sends the stored token only to the stored base url and never returns it', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ outcome: 'created', person: { id: 'p', name: 'A' } }), { status: 201 }));
    const { listener } = await bootBackground({ token: ' cap_secret ', baseUrl: 'http://127.0.0.1:5000/' }, fetchImpl);
    const response = await new Promise<unknown>((resolve) => {
      expect(listener({ kind: 'capture', payload: { source: 'x', url: 'https://x.com/a', name: 'A' } }, { id: 'ext' }, resolve)).toBe(true);
    });
    expect(response).toEqual({ ok: true, outcome: 'created', personName: 'A' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe('http://127.0.0.1:5000/api/capture');
    expect(JSON.stringify(response)).not.toContain('cap_secret');
  });
});

