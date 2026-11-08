// Chip placement, the lookup driven In CRM state, and the capture settle behavior. These drive the real content
// scripts (chip.ts included) in jsdom. The chip lives in a closed shadow root, so attachShadow is wrapped to keep a
// handle on every root created; the last one is the live chip.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findLinkedinNameAnchor } from '../src/extract/linkedin';
import { findXNameAnchor } from '../src/extract/x';
import { CAPTION_DIALOG, GHOST_OVERLAY, liveProfileHtml, overlayHtml, stubLayout } from './linkedinFixtures';

const page = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

// The chip's name: the accessible label on the inline icon chip, the visible text on the floating labeled chip.
const labelOf = (button: HTMLElement): string => button.getAttribute('aria-label') ?? button.textContent ?? '';

describe('anchor finders', () => {
  it('linkedin: finds the name heading, the same first h1 the extractor reads', () => {
    const doc = page('<body><main><div><h1 class="t">Jane Doe</h1></div><h1>Second</h1></main></body>');
    const anchor = findLinkedinNameAnchor(doc);
    expect(anchor?.tagName).toBe('H1');
    expect(anchor?.textContent).toBe('Jane Doe');
  });

  it('linkedin: returns null when there is no h1', () => {
    expect(findLinkedinNameAnchor(page('<body><h2>Jane Doe</h2></body>'))).toBeNull();
    expect(findLinkedinNameAnchor(page(''))).toBeNull();
  });

  it('linkedin: prefers the first heading in main whose text equals the extracted name over an earlier h1', () => {
    const doc = page('<body><h1>Jane Doe</h1><main><h2>Messaging</h2><div><h2 id="n">Jane Doe</h2></div></main></body>');
    const url = new URL('https://www.linkedin.com/in/jane-doe');
    expect(findLinkedinNameAnchor(doc, url)?.id).toBe('n');
  });

  it('linkedin: else the first h1 on the page, else the first heading in main, else null', () => {
    const url = new URL('https://www.linkedin.com/in/jane-doe');
    const h1 = page('<body><h1 id="a">Someone Else</h1><main><h2 id="b">Jane</h2></main></body>');
    expect(findLinkedinNameAnchor(h1, new URL('https://www.linkedin.com/in/zed'))?.id).toBe('a');
    const mainOnly = page('<body><main><h2 id="b">Totally Different</h2><h2>Other</h2></main></body>');
    expect(findLinkedinNameAnchor(mainOnly, new URL('https://www.linkedin.com/in/zed'))?.id).toBe('b');
    expect(findLinkedinNameAnchor(page('<body><main><div>no headings</div></main></body>'), url)).toBeNull();
    expect(findLinkedinNameAnchor(page('<body><h2>Outside main</h2></body>'), url)).toBeNull();
  });

  it('linkedin: the live structure anchors on the degree marker at the end of the name line, with no h1 on the page', () => {
    const doc = page(liveProfileHtml());
    const anchor = findLinkedinNameAnchor(doc, new URL('https://www.linkedin.com/in/satya-nadella/'));
    expect(anchor?.textContent?.trim()).toBe('· 2nd');
    expect(anchor?.closest('a')).toBeNull();
  });

  it('x: finds the UserName name row', () => {
    const doc = page('<body><div data-testid="UserName"><span>Jack</span><span>@jack</span></div></body>');
    expect(findXNameAnchor(doc)?.getAttribute('data-testid')).toBe('UserName');
  });

  it('x: returns null without the UserName test id', () => {
    expect(findXNameAnchor(page('<body><h1>Jack</h1><div data-testid="UserDescription">bio</div></body>'))).toBeNull();
    expect(findXNameAnchor(page(''))).toBeNull();
  });
});

interface Harness {
  button(): HTMLButtonElement | null;
  hosts(): HTMLElement[];
  host(): HTMLElement | null;
  sendMessage: ReturnType<typeof vi.fn>;
  navigate(pathAndQuery: string): void;
  settle(ms?: number): Promise<void>;
  sent(kind: string): Array<{ kind: string; payload: any }>;
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
  const hosts = () => Array.from(document.querySelectorAll<HTMLElement>('#agentcrm-capture-host'));
  return {
    sendMessage,
    hosts,
    host: () => hosts()[0] ?? null,
    button: () => (roots.length > 0 ? (roots[roots.length - 1]!.querySelector('button') as HTMLButtonElement | null) : null),
    navigate: (p) => history.pushState({}, '', p),
    settle: async (ms = 0) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
    sent: (kind) => sendMessage.mock.calls.map((c) => c[0]).filter((m) => m.kind === kind),
  };
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

const NOT_IN_CRM = { ok: true, exists: false };
const CREATED = { ok: true, outcome: 'created', personName: 'Jane' };
const EXISTING = { ok: true, outcome: 'existing', personName: 'Jane' };
const reply = (lookup: unknown, capture: unknown = CREATED) => (msg: any) => (msg.kind === 'lookup' ? lookup : capture);

describe('placement', () => {
  it('linkedin: mounts inline right after the name heading with explicit inline host styles', async () => {
    const h = await boot('linkedin', '/in/jane', '<body><div id="row"><h1>Jane Doe</h1></div></body>', reply(NOT_IN_CRM));
    const host = h.host()!;
    expect(h.hosts()).toHaveLength(1);
    expect(host.previousElementSibling?.tagName).toBe('H1');
    expect(host.parentElement?.id).toBe('row');
    expect(host.style.getPropertyValue('display')).toBe('inline-flex');
    expect(host.style.getPropertyPriority('display')).toBe('important');
    expect(host.style.getPropertyValue('vertical-align')).toBe('middle');
    expect(host.style.getPropertyValue('margin-left')).toBe('8px');
    expect(h.button()!.dataset.placement).toBe('inline');
  });

  it('linkedin: when the heading sits inside a link, the host goes after the link so the click cannot follow it', async () => {
    const h = await boot('linkedin', '/in/jane', '<body><span id="row"><a href="/in/jane/"><h1>Jane Doe</h1></a></span></body>', reply(NOT_IN_CRM));
    const host = h.host()!;
    expect(host.previousElementSibling?.tagName).toBe('A');
    expect(host.parentElement?.id).toBe('row');
  });

  it('x: mounts inline right after the UserName row', async () => {
    const h = await boot(
      'x',
      '/jack',
      '<body><div id="head"><div data-testid="UserName"><span>Jack</span><span>@jack</span></div></div></body>',
      reply(NOT_IN_CRM),
    );
    expect(h.host()!.previousElementSibling?.getAttribute('data-testid')).toBe('UserName');
    expect(h.host()!.style.getPropertyValue('display')).toBe('inline-flex');
    expect(h.button()!.dataset.placement).toBe('inline');
  });

  it('floats at the bottom right fallback when no anchor exists', async () => {
    const h = await boot('linkedin', '/in/jane', '<body><h2>Jane</h2></body>', reply(NOT_IN_CRM));
    expect(h.hosts()).toHaveLength(1);
    expect(h.host()!.parentElement).toBe(document.body);
    expect(h.button()!.dataset.placement).toBe('floating');
    expect(h.host()!.style.getPropertyValue('display')).toBe('inline');
  });

  it('re-mounts a host that a site re-render detached, on the next poll tick, without a second host', async () => {
    const h = await boot('linkedin', '/in/jane', '<body><div id="row"><h1>Jane Doe</h1></div></body>', reply(NOT_IN_CRM));
    const first = h.host()!;
    first.remove();
    expect(h.hosts()).toHaveLength(0);
    await h.settle(900);
    expect(h.hosts()).toHaveLength(1);
    expect(h.host()).not.toBe(first);
    expect(h.host()!.previousElementSibling?.tagName).toBe('H1');
    await h.settle(5000);
    expect(h.hosts()).toHaveLength(1);
  });

  it('re-mounts next to the new heading when the page replaces the heading but leaves the host behind', async () => {
    const h = await boot('linkedin', '/in/jane', '<body><div id="row"><h1>Jane Doe</h1></div></body>', reply(NOT_IN_CRM));
    document.body.innerHTML = '<section id="fresh"><h1>Jane Doe</h1></section>';
    await h.settle(900);
    expect(h.hosts()).toHaveLength(1);
    expect(h.host()!.parentElement?.id).toBe('fresh');
  });

  it('upgrades a floating chip to inline when the anchor appears later, keeping one host', async () => {
    const h = await boot('x', '/jack', '<body></body>', reply(NOT_IN_CRM));
    expect(h.button()!.dataset.placement).toBe('floating');
    document.body.innerHTML = '<div id="head"><div data-testid="UserName"><span>Jack</span><span>@jack</span></div></div>';
    await h.settle(900);
    expect(h.hosts()).toHaveLength(1);
    expect(h.button()!.dataset.placement).toBe('inline');
    expect(h.host()!.parentElement?.id).toBe('head');
  });

  it('keeps the state across a re-mount and does not send a second lookup', async () => {
    const h = await boot('linkedin', '/in/jane', '<body><h1>Jane Doe</h1></body>', reply({ ok: true, exists: true }));
    await h.settle(0);
    expect(labelOf(h.button()!)).toBe('In CRM');
    h.host()!.remove();
    await h.settle(900);
    expect(h.hosts()).toHaveLength(1);
    expect(labelOf(h.button()!)).toBe('In CRM');
    expect(h.sent('lookup')).toHaveLength(1);
  });

  it('removes the host when navigating off a profile page', async () => {
    const h = await boot('linkedin', '/in/jane', '<body><h1>Jane Doe</h1></body>', reply(NOT_IN_CRM));
    h.navigate('/feed/');
    await h.settle(900);
    expect(h.hosts()).toHaveLength(0);
  });
});

describe('lookup flow', () => {
  it('sends exactly one lookup on mount with source and the url without query or fragment', async () => {
    const h = await boot('linkedin', '/in/jane?miniProfileUrn=abc#top', '<body><h1>Jane Doe</h1></body>', reply(NOT_IN_CRM));
    await h.settle(5000);
    expect(h.sent('lookup')).toEqual([{ kind: 'lookup', payload: { source: 'linkedin', url: 'http://localhost:3000/in/jane' } }]);
    expect(h.sent('capture')).toHaveLength(0);
  });

  it('x sends source x', async () => {
    const h = await boot('x', '/jack', '<body></body>', reply(NOT_IN_CRM));
    expect(h.sent('lookup')[0]!.payload).toEqual({ source: 'x', url: 'http://localhost:3000/jack' });
  });

  it('exists true shows an inert In CRM state and a click sends no capture', async () => {
    const h = await boot('linkedin', '/in/jane', '<body><h1>Jane Doe</h1></body>', reply({ ok: true, exists: true }));
    await h.settle(0);
    expect(labelOf(h.button()!)).toBe('In CRM');
    expect(h.button()!.dataset.state).toBe('inCrm');
    h.button()!.click();
    await h.settle(100);
    expect(h.sent('capture')).toHaveLength(0);
    expect(h.sent('openOptions')).toHaveLength(0);
    expect(labelOf(h.button()!)).toBe('In CRM');
  });

  it('exists false leaves the chip idle', async () => {
    const h = await boot('linkedin', '/in/jane', '<body><h1>Jane Doe</h1></body>', reply(NOT_IN_CRM));
    await h.settle(0);
    expect(labelOf(h.button()!)).toBe('Add to AgentCRM');
  });

  const failures: Array<[string, unknown]> = [
    ['unconfigured', { ok: false, code: 'unconfigured', message: 'Open the extension options to set the token' }],
    ['401', { ok: false, code: 'unauthorized', message: 'Open the extension options to set the token' }],
    ['network', { ok: false, code: 'network', message: 'Could not reach the AgentCRM server. Is it running?' }],
    ['404 from an older server', { ok: false, code: 'http', message: 'The server answered 404.' }],
    ['no answer', undefined],
  ];
  it.each(failures)('a %s lookup failure is silent, leaves the chip idle, and a click still captures', async (_name, failure) => {
    const h = await boot('linkedin', '/in/jane', '<body><h1>Jane Doe</h1></body>', reply(failure));
    await h.settle(0);
    expect(labelOf(h.button()!)).toBe('Add to AgentCRM');
    h.button()!.click();
    await h.settle(0);
    expect(h.sent('capture')).toHaveLength(1);
    expect(labelOf(h.button()!)).toBe('Added');
  });

  it('a lookup reply that arrives after navigating away is dropped', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    const h = await boot('linkedin', '/in/aaa', '<body><h1>Aaa Person</h1></body>', (msg) =>
      msg.kind === 'lookup' ? new Promise((resolve) => resolvers.push(resolve)) : CREATED,
    );
    expect(resolvers).toHaveLength(1);
    h.navigate('/in/bbb');
    await h.settle(900);
    expect(resolvers).toHaveLength(2);
    resolvers[0]!({ ok: true, exists: true });
    await h.settle(0);
    expect(labelOf(h.button()!)).toBe('Add to AgentCRM');
    resolvers[1]!({ ok: true, exists: false });
    await h.settle(0);
    expect(labelOf(h.button()!)).toBe('Add to AgentCRM');
  });

  it('In CRM is per profile: navigating to another profile resets to idle and looks up again', async () => {
    const h = await boot('linkedin', '/in/aaa', '<body><h1>Aaa Person</h1></body>', (msg) =>
      msg.kind === 'lookup' ? { ok: true, exists: msg.payload.url.endsWith('/in/aaa') } : CREATED,
    );
    await h.settle(0);
    expect(labelOf(h.button()!)).toBe('In CRM');
    h.navigate('/in/bbb');
    await h.settle(900);
    expect(labelOf(h.button()!)).toBe('Add to AgentCRM');
    expect(h.sent('lookup').map((m) => m.payload.url)).toEqual(['http://localhost:3000/in/aaa', 'http://localhost:3000/in/bbb']);
  });

  it('a lookup reply that lands while a capture is in flight does not override the capture state', async () => {
    let resolveLookup: (v: unknown) => void = () => undefined;
    const h = await boot('linkedin', '/in/jane', '<body><h1>Jane Doe</h1></body>', (msg) =>
      msg.kind === 'lookup' ? new Promise((resolve) => (resolveLookup = resolve)) : new Promise(() => undefined),
    );
    h.button()!.click();
    await h.settle(0);
    expect(labelOf(h.button()!)).toBe('Adding');
    resolveLookup({ ok: true, exists: true });
    await h.settle(0);
    expect(labelOf(h.button()!)).toBe('Adding');
  });
});

describe('capture settle', () => {
  it('created shows Added briefly and then settles to In CRM, not back to idle', async () => {
    const h = await boot('linkedin', '/in/jane', '<body><h1>Jane Doe</h1></body>', reply(NOT_IN_CRM, CREATED));
    await h.settle(0);
    h.button()!.click();
    await h.settle(0);
    expect(labelOf(h.button()!)).toBe('Added');
    await h.settle(2000);
    expect(labelOf(h.button()!)).toBe('Added');
    await h.settle(600);
    expect(labelOf(h.button()!)).toBe('In CRM');
    await h.settle(60_000);
    expect(labelOf(h.button()!)).toBe('In CRM');
    h.button()!.click();
    await h.settle(0);
    expect(h.sent('capture')).toHaveLength(1);
  });

  it('existing settles to In CRM directly, with no Already in CRM flash', async () => {
    const h = await boot('linkedin', '/in/jane', '<body><h1>Jane Doe</h1></body>', reply(NOT_IN_CRM, EXISTING));
    await h.settle(0);
    h.button()!.click();
    await h.settle(0);
    expect(labelOf(h.button()!)).toBe('In CRM');
    expect(h.button()!.dataset.state).toBe('inCrm');
  });

  it('an Added timer from profile A cannot paint In CRM onto profile B', async () => {
    const h = await boot('linkedin', '/in/aaa', '<body><h1>Aaa Person</h1></body>', reply(NOT_IN_CRM, CREATED));
    await h.settle(0);
    h.button()!.click();
    await h.settle(0);
    expect(labelOf(h.button()!)).toBe('Added');
    h.navigate('/in/bbb');
    await h.settle(900);
    expect(labelOf(h.button()!)).toBe('Add to AgentCRM');
    await h.settle(5000);
    expect(labelOf(h.button()!)).toBe('Add to AgentCRM');
  });

  it('error states are unchanged: a server error shows its text and returns to idle', async () => {
    const h = await boot('linkedin', '/in/jane', '<body><h1>Jane Doe</h1></body>', reply(NOT_IN_CRM, { ok: false, code: 'validation', message: 'Bad profile.' }));
    await h.settle(0);
    h.button()!.click();
    await h.settle(0);
    expect(labelOf(h.button()!)).toBe('Bad profile');
    await h.settle(6100);
    expect(labelOf(h.button()!)).toBe('Add to AgentCRM');
  });
});

describe('icon chip (inline)', () => {
  const INLINE = '<body><div id="row"><h1>Jane Doe</h1></div></body>';
  const rects = (h: Harness) => Array.from(h.button()!.querySelectorAll('svg rect'));
  const css = () => roots[roots.length - 1]!.querySelector('style')!.textContent!;

  it('renders a 22px square icon button with the capture mark as SVG and only visually hidden text', async () => {
    const h = await boot('linkedin', '/in/jane', INLINE, reply(NOT_IN_CRM));
    const button = h.button()!;
    expect(button.dataset.placement).toBe('inline');
    // The only text is the visually hidden state label, so the aria-live region announces changes.
    expect(button.textContent).toBe('Add to AgentCRM');
    expect(button.querySelector('.sr')?.textContent).toBe('Add to AgentCRM');
    const svg = button.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 100 100');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    // Four corner brackets (two arms each) plus the center dot, at the same geometry as scripts/icons.mjs.
    const boxes = rects(h).map((r) => ['x', 'y', 'width', 'height'].map((a) => Number(r.getAttribute(a))).join(','));
    expect(boxes).toHaveLength(9);
    expect(boxes).toContain('20,20,22,9');
    expect(boxes).toContain('20,20,9,22');
    expect(boxes).toContain('58,71,22,9');
    expect(boxes).toContain('71,58,9,22');
    expect(boxes).toContain('40,40,20,20');
    expect(css()).toMatch(/\.chip\[data-placement="inline"\]\s*\{[^}]*width:\s*22px;\s*height:\s*22px/);
    expect(css()).toMatch(/\.chip\s*\{[^}]*border-radius:\s*6px/);
    // The size is set once for the placement, never per state.
    expect(css()).not.toMatch(/\[data-state[^{]*\{[^}]*(?:min-width|width|height):/);
  });

  it('names every state by aria-label and native tooltip, and never changes the icon box', async () => {
    const h = await boot('linkedin', '/in/jane', INLINE, reply(NOT_IN_CRM, CREATED));
    await h.settle(0);
    const seen: Array<[string, string | null, string]> = [];
    const snap = () => seen.push([h.button()!.dataset.state!, h.button()!.getAttribute('aria-label'), h.button()!.title]);
    snap();
    h.button()!.click();
    snap();
    await h.settle(0);
    snap();
    expect(h.button()!.querySelector('path')).not.toBeNull();
    await h.settle(2600);
    snap();
    expect(seen).toEqual([
      ['idle', 'Add to AgentCRM', 'Add to AgentCRM'],
      ['sending', 'Adding', 'Adding'],
      ['added', 'Added', 'Added'],
      ['inCrm', 'In CRM', 'In CRM'],
    ]);
    expect(h.button()!.textContent).toBe('In CRM');
    expect(rects(h)).toHaveLength(9);
    expect(h.hosts()).toHaveLength(1);
  });

  it('In CRM is aria-disabled and inert, and a click sends nothing', async () => {
    const h = await boot('linkedin', '/in/jane', INLINE, reply({ ok: true, exists: true }));
    await h.settle(0);
    const button = h.button()!;
    expect(button.dataset.state).toBe('inCrm');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.title).toBe('In CRM');
    button.click();
    await h.settle(100);
    expect(h.sent('capture')).toHaveLength(0);
    expect(h.sent('openOptions')).toHaveLength(0);
    expect(button.dataset.state).toBe('inCrm');
  });

  it('error: the tooltip and label are the error message, and a click opens the options page', async () => {
    const unauthorized = { ok: false, code: 'unauthorized', message: 'nope' };
    const h = await boot('linkedin', '/in/jane', INLINE, reply(NOT_IN_CRM, unauthorized));
    await h.settle(0);
    h.button()!.click();
    await h.settle(0);
    const button = h.button()!;
    expect(button.dataset.state).toBe('error');
    expect(button.getAttribute('aria-label')).toBe('Open the extension options to set the token');
    expect(button.title).toBe('Open the extension options to set the token');
    expect(button.textContent).toBe('Open the extension options to set the token');
    expect(rects(h)).toHaveLength(9);
    button.click();
    await h.settle(0);
    expect(h.sent('openOptions')).toHaveLength(1);
  });

  it('a transient error tooltip returns to idle', async () => {
    const h = await boot('linkedin', '/in/jane', INLINE, reply(NOT_IN_CRM, { ok: false, code: 'validation', message: 'Bad profile.' }));
    await h.settle(0);
    h.button()!.click();
    await h.settle(0);
    expect(h.button()!.title).toBe('Bad profile');
    await h.settle(6100);
    expect(h.button()!.title).toBe('Add to AgentCRM');
  });

  it('both color schemes are declared and the mark contrasts the field in each', async () => {
    const h = await boot('linkedin', '/in/jane', INLINE, reply(NOT_IN_CRM));
    expect(css()).toContain('prefers-color-scheme: dark');
    expect(css()).toMatch(/--mark:\s*#E7F2EF/i);
    expect(css()).toMatch(/--mark:\s*#15211E/i);
    expect(h.button()).not.toBeNull();
  });
});

describe('labeled chip (floating)', () => {
  it('keeps the full text label, no icon, and one min-width across states', async () => {
    const h = await boot('linkedin', '/in/jane', '<body><h2>Outside main</h2></body>', reply(NOT_IN_CRM, CREATED));
    await h.settle(0);
    const button = h.button()!;
    expect(button.dataset.placement).toBe('floating');
    expect(button.textContent).toBe('Add to AgentCRM');
    expect(button.querySelector('svg')).toBeNull();
    expect(button.hasAttribute('aria-label')).toBe(false);
    button.click();
    expect(button.textContent).toBe('Adding');
    await h.settle(0);
    expect(button.textContent).toBe('Added');
    await h.settle(2600);
    expect(button.textContent).toBe('In CRM');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const css = roots[roots.length - 1]!.querySelector('style')!.textContent!;
    expect(css).toMatch(/\.chip\s*\{[^}]*min-width:\s*11em/);
  });
});

describe('linkedin live structure end to end', () => {
  it('mounts the icon after the degree marker on the name line and captures name, headline, and location', async () => {
    const h = await boot('linkedin', '/in/satya-nadella/', liveProfileHtml(), reply(NOT_IN_CRM));
    await h.settle(0);
    const host = h.host()!;
    expect(host.previousElementSibling?.textContent?.trim()).toBe('· 2nd');
    expect(host.previousElementSibling?.className).toBe('djeDeg');
    expect(h.button()!.dataset.placement).toBe('inline');
    h.button()!.click();
    await h.settle(0);
    expect(h.sent('capture')[0]!.payload).toEqual({
      source: 'linkedin',
      url: 'http://localhost:3000/in/satya-nadella/',
      name: 'Satya Nadella',
      headline: 'Chairman and CEO at Microsoft',
      location: 'Redmond, Washington, United States',
    });
  });

  it('with the overlay open the payload carries email, phone, and website; the capture never opens the overlay', async () => {
    const restore = stubLayout();
    try {
      const h = await boot(
        'linkedin',
        '/in/satya-nadella/overlay/contact-info/',
        liveProfileHtml({ after: CAPTION_DIALOG + GHOST_OVERLAY + overlayHtml() }),
        reply(NOT_IN_CRM),
      );
      const link = document.querySelector('a.djeContact')!;
      const touched = vi.fn();
      link.addEventListener('click', touched);
      const pushes = vi.spyOn(history, 'pushState');
      await h.settle(0);
      h.button()!.click();
      await h.settle(0);
      expect(h.sent('capture')[0]!.payload).toMatchObject({
        name: 'Satya Nadella',
        email: 'satya@example.com',
        phone: '555 010 1234',
        website: 'https://snscratchpad.com',
      });
      expect(touched).not.toHaveBeenCalled();
      expect(pushes).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('without the overlay the payload has no phone key', async () => {
    const h = await boot('linkedin', '/in/satya-nadella/', liveProfileHtml({ after: CAPTION_DIALOG + GHOST_OVERLAY }), reply(NOT_IN_CRM));
    h.button()!.click();
    await h.settle(0);
    expect('phone' in h.sent('capture')[0]!.payload).toBe(false);
  });
});

describe('orphaned content script and exclusive mount', () => {
  const PAGE = '<body><div id="row"><h1>Jane Doe</h1></div></body>';

  it('tears down on the first tick after the extension id disappears, and later ticks do nothing', async () => {
    const h = await boot('linkedin', '/in/jane', PAGE, reply(NOT_IN_CRM));
    expect(h.hosts()).toHaveLength(1);
    vi.stubGlobal('chrome', { runtime: { sendMessage: h.sendMessage, id: undefined } });
    await h.settle(900);
    expect(h.hosts()).toHaveLength(0);
    // The interval is cleared: a removed anchor would otherwise bring the chip back.
    document.body.innerHTML = '<div id="row2"><h1>Jane Doe</h1></div>';
    await h.settle(5000);
    expect(h.hosts()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats an empty extension id as dead', async () => {
    const h = await boot('linkedin', '/in/jane', PAGE, reply(NOT_IN_CRM));
    vi.stubGlobal('chrome', { runtime: { sendMessage: h.sendMessage, id: '' } });
    await h.settle(900);
    expect(h.hosts()).toHaveLength(0);
  });

  it('treats a throwing chrome.runtime access as dead', async () => {
    const h = await boot('linkedin', '/in/jane', PAGE, reply(NOT_IN_CRM));
    expect(h.hosts()).toHaveLength(1);
    vi.stubGlobal('chrome', {
      get runtime(): never {
        throw new Error('Extension context invalidated.');
      },
    });
    await h.settle(900);
    expect(h.hosts()).toHaveLength(0);
    document.body.innerHTML = '<div id="row2"><h1>Jane Doe</h1></div>';
    await h.settle(5000);
    expect(h.hosts()).toHaveLength(0);
  });

  it('removes a stale host planted by an older instance, leaving exactly the live one', async () => {
    const h = await boot('linkedin', '/in/jane', PAGE, reply(NOT_IN_CRM));
    const own = h.host()!;
    const stale = document.createElement('div');
    stale.id = 'agentcrm-capture-host';
    document.body.append(stale);
    expect(h.hosts()).toHaveLength(2);
    await h.settle(900);
    expect(h.hosts()).toEqual([own]);
    expect(own.isConnected).toBe(true);
  });

  it('removes a stale host that was in the page before this instance mounted', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = '<body><div id="agentcrm-capture-host"></div><div id="row"><h1>Jane Doe</h1></div></body>';
    history.pushState({}, '', '/in/jane');
    const stale = document.getElementById('agentcrm-capture-host')!;
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => NOT_IN_CRM), id: 'ext' } });
    await import('../src/content/linkedin');
    await vi.advanceTimersByTimeAsync(900);
    const hosts = document.querySelectorAll('#agentcrm-capture-host');
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).not.toBe(stale);
  });
});
