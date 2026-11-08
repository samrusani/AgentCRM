// Adversarial probes for the orphan teardown and exclusive mount. KILLS = attack defeated; CONFIRMS = violation shown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PAGE = '<body><div id="row"><h1>Jane Doe</h1></div></body>';
const NOT_IN_CRM = { ok: true, exists: false };
const hosts = () => Array.from(document.querySelectorAll<HTMLElement>('#agentcrm-capture-host'));
const roots: ShadowRoot[] = [];
const realAttach = Element.prototype.attachShadow;

async function boot(reply: (m: any) => unknown, html = PAGE) {
  vi.resetModules();
  vi.useFakeTimers();
  roots.length = 0;
  document.documentElement.innerHTML = html;
  history.pushState({}, '', '/in/jane');
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (m: any) => reply(m)), id: 'ext' } });
  await import('../src/content/linkedin');
}
const kill = () => vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => undefined), id: undefined } });

beforeEach(() => {
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const s = realAttach.call(this, init);
    roots.push(s);
    return s;
  };
});
afterEach(() => {
  Element.prototype.attachShadow = realAttach;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('orphan teardown probes', () => {
  it('KILLS: a dead instance never sweeps (an orphan cannot remove a newer instance\'s host before dying)', async () => {
    await boot(() => NOT_IN_CRM);
    kill();
    const newer = document.createElement('div'); // stands for the fresh instance's host
    newer.id = 'agentcrm-capture-host';
    document.body.append(newer);
    await vi.advanceTimersByTimeAsync(900);
    expect(newer.isConnected).toBe(true); // alive check precedes the sweep; the dead path returns before it
    expect(hosts()).toEqual([newer]);
  });

  it('KILLS: two live instances in one context never leave zero chips at a tick boundary (worst case flicker, not permanent absence)', async () => {
    await boot(() => NOT_IN_CRM);
    vi.resetModules();
    await import('../src/content/linkedin'); // second live instance, same context
    const counts: number[] = [];
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(400);
      counts.push(hosts().length);
    }
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...counts)).toBe(1);
  });

  it('KILLS: an in-flight capture that resolves after death does not throw, revive a host, or paint', async () => {
    let resolveCapture: (v: unknown) => void = () => undefined;
    await boot((m) => (m.kind === 'lookup' ? NOT_IN_CRM : new Promise((r) => (resolveCapture = r))));
    const btn = roots[roots.length - 1]!.querySelector('button')!;
    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    kill();
    await vi.advanceTimersByTimeAsync(900);
    expect(hosts()).toHaveLength(0);
    resolveCapture({ ok: true, outcome: 'created', personName: 'Jane' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hosts()).toHaveLength(0);
  });

  it('KILLS: an in-flight lookup resolving after death does not revive or paint', async () => {
    let resolveLookup: (v: unknown) => void = () => undefined;
    await boot(() => new Promise((r) => (resolveLookup = r)));
    kill();
    await vi.advanceTimersByTimeAsync(900);
    resolveLookup({ ok: true, exists: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(hosts()).toHaveLength(0);
  });

  it('KILLS: SPA navigation off and back keeps exactly one host and it is the live reference (no self-sweep)', async () => {
    await boot(() => NOT_IN_CRM);
    for (let i = 0; i < 3; i++) {
      history.pushState({}, '', '/feed/');
      await vi.advanceTimersByTimeAsync(900);
      expect(hosts()).toHaveLength(0);
      history.pushState({}, '', '/in/jane');
      await vi.advanceTimersByTimeAsync(900);
      expect(hosts()).toHaveLength(1);
      // site re-render detaches the heading and rebuilds it
      document.getElementById('row')!.innerHTML = '<h1>Jane Doe</h1>';
      await vi.advanceTimersByTimeAsync(900);
      expect(hosts()).toHaveLength(1);
    }
  });

  it('KILLS: a document without a body does not make the sweep or mount throw', async () => {
    await boot(() => NOT_IN_CRM);
    document.body.remove();
    await expect(vi.advanceTimersByTimeAsync(2000)).resolves.not.toThrow();
  });

  it('KILLS: an instance that starts in an already dead context starts nothing, no poll and no host', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = PAGE;
    history.pushState({}, '', '/in/jane');
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(), id: undefined } });
    await import('../src/content/linkedin');
    // The first synchronous check() finds the context dead, and startChip then skips the poll and the listener.
    expect(vi.getTimerCount()).toBe(0);
    expect(hosts()).toHaveLength(0);
  });

  it('ACCEPTED: a click resolving after death arms one harmless 6s timer whose render no-ops (button is null)', async () => {
    let resolveCapture: (v: unknown) => void = () => undefined;
    await boot((m) => (m.kind === 'lookup' ? NOT_IN_CRM : new Promise((r) => (resolveCapture = r))));
    roots[roots.length - 1]!.querySelector('button')!.click();
    await vi.advanceTimersByTimeAsync(0);
    kill();
    await vi.advanceTimersByTimeAsync(900);
    resolveCapture(undefined);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(7000);
    expect(hosts()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
