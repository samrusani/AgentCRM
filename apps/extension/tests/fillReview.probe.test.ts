// Adversarial probes for recapture fill-in on the extension side. KILLS = property holds; CONFIRMS/ACCEPTED = pinned.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendCapture as apiCapture } from '../src/api';
import { openPanel } from '../src/content/panel';

const realAttach = Element.prototype.attachShadow;
const rootOf = new Map<Element, ShadowRoot>();
const chipRoots: ShadowRoot[] = [];
const panelRoots: ShadowRoot[] = [];
beforeEach(() => {
  rootOf.clear();
  chipRoots.length = 0;
  panelRoots.length = 0;
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const s = realAttach.call(this, init);
    rootOf.set(this, s);
    if (this.id === 'agentcrm-panel-host') panelRoots.push(s);
    else chipRoots.push(s);
    return s;
  };
  history.pushState({}, '', '/in/jane');
});
afterEach(() => {
  Element.prototype.attachShadow = realAttach;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.innerHTML = '<head></head><body></body>';
});

function panel(added: string[] | undefined, sent: any) {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(), id: 'ext' } });
  const h = openPanel({ variant: 'existing', source: 'linkedin', profileKey: 'jane', currentKey: () => 'jane', sent, ...(added ? { added } : {}) } as any);
  const root = rootOf.get(h.host)!;
  const rows = () => Array.from(root.querySelectorAll('dt')).map((dt) => [dt.textContent, (dt.nextElementSibling as HTMLElement).textContent]);
  return { root, rows };
}
const SENT = { source: 'linkedin', url: 'https://www.linkedin.com/in/jane', name: 'Jane', headline: 'Eng', location: 'Berlin', email: 'j@x.com', phone: '1 555', website: 'https://w.example', company: 'Acme' };

describe('7 panel', () => {
  it('KILLS: only added keys render, with sent values, profileUrl -> sent url labelled Profile, in sent payload order', () => {
    const p = panel(['profileUrl', 'title', 'phone'], SENT);
    expect(p.rows()).toEqual([['Profile', 'https://www.linkedin.com/in/jane'], ['Title', 'Eng'], ['Phone', '1 555']]);
    expect(p.root.querySelector('.hint.added')!.textContent).toBe('Added to the record:');
  });

  it('KILLS: name is never listed even if the server (wrongly) says "name"; unknown keys ignored', () => {
    const p = panel(['name', 'bogus', 'constructor', '__proto__', 'toString'], SENT);
    expect(p.rows()).toEqual([]);
    expect(p.root.querySelector('.hint.added')).toBeNull();
    expect(p.root.querySelector('dl')?.childElementCount ?? 0).toBe(0);
  });

  it('KILLS: an added key missing from the sent payload renders no blank row and no heading when nothing else shows', () => {
    const { headline, ...rest } = SENT;
    const p = panel(['title'], rest);
    expect(p.rows()).toEqual([]);
    expect(p.root.querySelector('.hint.added')).toBeNull();
    const q = panel(['title', 'location'], { ...rest, location: '' });
    expect(q.rows()).toEqual([]);
  });

  it('KILLS: added [] / undefined renders no list and no heading', () => {
    for (const a of [[], undefined]) {
      const p = panel(a as any, SENT);
      expect(p.root.querySelector('dl')).toBeNull();
      expect(p.root.querySelector('.hint.added')).toBeNull();
    }
  });

  it('KILLS: values render as text, not markup', () => {
    const p = panel(['title'], { ...SENT, headline: '<img src=x onerror=alert(1)>' });
    expect(p.root.querySelector('img')).toBeNull();
    expect(p.rows()).toEqual([['Title', '<img src=x onerror=alert(1)>']]);
  });
});

describe('api', () => {
  const settings = { baseUrl: 'http://localhost:4720', token: 'cap_x' } as any;
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as any;
  it('KILLS: non-string added items are filtered; non-array added on existing is dropped; created never carries added', async () => {
    const a = await apiCapture(settings, SENT as any, reply({ outcome: 'existing', person: { name: 'J' }, added: ['title', 3, null, { x: 1 }] }));
    expect(a).toEqual({ ok: true, outcome: 'existing', personName: 'J', added: ['title'] });
    const b = await apiCapture(settings, SENT as any, reply({ outcome: 'existing', person: { name: 'J' }, added: 'title' }));
    expect(b).toEqual({ ok: true, outcome: 'existing', personName: 'J' });
    const c = await apiCapture(settings, SENT as any, reply({ outcome: 'created', person: { name: 'J' }, added: ['title'] }, 201));
    expect(c).toEqual({ ok: true, outcome: 'created', personName: 'J' });
  });
});

describe('chip flow', () => {
  const HTML = '<body><div id="row"><h1>Jane Doe</h1></div></body>';
  async function boot(reply: (m: any) => unknown) {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = HTML;
    history.pushState({}, '', '/in/jane');
    const sendMessage = vi.fn(async (m: any) => reply(m));
    vi.stubGlobal('chrome', { runtime: { sendMessage, id: 'ext' } });
    await import('../src/content/linkedin');
    await vi.advanceTimersByTimeAsync(0);
    return { sendMessage, button: () => chipRoots[chipRoots.length - 1]!.querySelector('button') as HTMLButtonElement, settle: (ms = 0) => vi.advanceTimersByTimeAsync(ms) };
  }
  const panelHosts = () => document.querySelectorAll('#agentcrm-panel-host');

  it('KILLS: panel never auto-opens: a lookup hit that is existing opens nothing; an In CRM click sends no capture and shows no list', async () => {
    const h = await boot((m) => (m.kind === 'lookup' ? { ok: true, exists: true } : { ok: true, outcome: 'existing', personName: 'J', added: ['title'] }));
    await h.settle(100);
    expect(panelHosts()).toHaveLength(0);
    h.button().click();
    await h.settle(0);
    expect(h.sendMessage.mock.calls.filter((c) => c[0].kind === 'capture')).toHaveLength(0);
    expect(panelRoots[0]!.querySelector('dl')).toBeNull();
    expect(panelRoots[0]!.querySelector('.hint.added')).toBeNull();
  });

  it('KILLS: an existing capture reply that lands after navigation opens nothing (even with added keys)', async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    const h = await boot((m) => (m.kind === 'lookup' ? { ok: true, exists: false } : gate));
    h.button().click();
    await h.settle(0);
    history.pushState({}, '', '/in/other');
    release({ ok: true, outcome: 'existing', personName: 'J', added: ['title', 'profileUrl'] });
    await h.settle(2000);
    expect(panelHosts()).toHaveLength(0);
  });

  it('KILLS: existing reply with added renders only added keys from the built payload, no "created" rows', async () => {
    const h = await boot((m) => (m.kind === 'lookup' ? { ok: true, exists: false } : { ok: true, outcome: 'existing', personName: 'J', added: ['profileUrl'] }));
    h.button().click();
    await h.settle(0);
    const rows = Array.from(panelRoots[0]!.querySelectorAll('dt')).map((n) => n.textContent);
    expect(rows).toEqual(['Profile']);
    expect(panelRoots[0]!.querySelector('h2')!.textContent).toBe('Already in your CRM');
  });
});
