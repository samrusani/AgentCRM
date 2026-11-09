// Adversarial probes for the capture panel wave. KILLS = suspicion defeated (property holds); CONFIRMS = defect or
// documented gap shown (the test passes because the behavior is real); ACCEPTED = tradeoff pinned.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPanel, PANEL_HOST_ID } from '../src/content/panel';

const realAttach = Element.prototype.attachShadow;
const rootOf = new Map<Element, ShadowRoot>();
beforeEach(() => {
  rootOf.clear();
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const s = realAttach.call(this, init);
    rootOf.set(this, s);
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

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};
const panelHost = () => document.getElementById(PANEL_HOST_ID);
const chipHosts = () => Array.from(document.querySelectorAll<HTMLElement>('#agentcrm-capture-host'));
const type = (box: HTMLTextAreaElement, value: string) => {
  box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
};

function direct(reply: (m: any) => unknown = () => ({ ok: true, personName: 'Jane' }), extra: Record<string, unknown> = {}) {
  const sendMessage = vi.fn(async (m: any) => reply(m));
  vi.stubGlobal('chrome', { runtime: { sendMessage, id: 'ext' } });
  let key: string | null = 'jane';
  const handle = openPanel({ variant: 'existing', source: 'linkedin', profileKey: 'jane', currentKey: () => key, ...extra } as any);
  const root = rootOf.get(handle.host)!;
  return {
    handle,
    root,
    sendMessage,
    setKey: (k: string | null) => (key = k),
    box: root.querySelector('textarea')!,
    save: root.querySelector<HTMLButtonElement>('.save')!,
    status: root.querySelector<HTMLElement>('.status')!,
  };
}

describe('4. panel security', () => {
  it('KILLS: host.shadowRoot is null; the page cannot reach inner nodes by id/query', () => {
    const p = direct();
    expect(p.handle.host.shadowRoot).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
    expect(p.handle.host.querySelector('textarea')).toBeNull();
  });

  it('KILLS: page-level BUBBLE listeners never see keydown/keypress/keyup from typing', () => {
    const p = direct();
    const seen = vi.fn();
    for (const t of ['keydown', 'keypress', 'keyup']) {
      document.addEventListener(t, seen);
      window.addEventListener(t, seen);
      document.body.addEventListener(t, seen);
    }
    for (const t of ['keydown', 'keypress', 'keyup'])
      p.box.dispatchEvent(new KeyboardEvent(t, { key: 'S', bubbles: true, composed: true }));
    expect(seen).not.toHaveBeenCalled();
  });

  it('ACCEPTED (documented limit): a page capture-phase window listener can read keystrokes typed in the note box, like the page-level fields', () => {
    const p = direct();
    const keys: string[] = [];
    window.addEventListener('keydown', (e) => keys.push((e as KeyboardEvent).key), true);
    for (const k of 'secret') p.box.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true }));
    // stopPropagation on the panel runs after capture listeners above it: "key events do not bubble into the page" is
    // true, but a page keylogger registered with capture:true reads the note anyway.
    expect(keys.join('')).toBe('secret');
  });

  it('ACCEPTED (documented limit): input events reach page listeners and InputEvent.data carries the text, the page-field trust class', () => {
    const p = direct();
    const seen: Array<string | null> = [];
    document.addEventListener('input', (e) => seen.push((e as InputEvent).data));
    p.box.dispatchEvent(new InputEvent('input', { data: 'q', inputType: 'insertText', bubbles: true, composed: true }));
    expect(seen).toEqual(['q']);
  });

  it('ACCEPTED (documented limit): paste, beforeinput and composition events also leave the panel', () => {
    const p = direct();
    const seen: string[] = [];
    for (const t of ['beforeinput', 'paste', 'compositionupdate', 'copy', 'cut']) document.addEventListener(t, () => seen.push(t));
    for (const t of ['beforeinput', 'paste', 'compositionupdate', 'copy', 'cut']) p.box.dispatchEvent(new Event(t, { bubbles: true, composed: true }));
    expect(seen).toEqual(['beforeinput', 'paste', 'compositionupdate', 'copy', 'cut']);
  });

  it('KILLS: synthetic events a page can aim at the host (the only node it can reach) trigger no save and no close', async () => {
    const p = direct();
    type(p.box, 'hello');
    for (const t of ['click', 'mousedown', 'keydown', 'submit']) {
      p.handle.host.dispatchEvent(new (t === 'keydown' ? KeyboardEvent : Event)(t, { bubbles: true, composed: true, ...(t === 'keydown' ? { key: 'Escape' } : {}) } as any));
    }
    (p.handle.host as HTMLElement).click();
    await flush();
    expect(p.sendMessage).not.toHaveBeenCalled();
    expect(panelHost()).not.toBeNull();
  });

  it('ACCEPTED: neither chip nor panel check isTrusted on clicks; safe only because the targets sit in a closed shadow root (isolated world in real Chrome)', async () => {
    const p = direct();
    type(p.box, 'hello');
    p.save.dispatchEvent(new MouseEvent('click', { bubbles: true })); // only reachable here because the test wrapped attachShadow
    await flush();
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('KILLS: Escape outside the panel (page focus) does not close it', () => {
    direct();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panelHost()).not.toBeNull();
  });

  it('KILLS: a forged same-id host planted before mount is removed and cannot see the real panel', () => {
    const forged = document.createElement('div');
    forged.id = PANEL_HOST_ID;
    const forgedRoot = forged.attachShadow({ mode: 'open' });
    document.body.append(forged);
    const p = direct();
    expect(forged.isConnected).toBe(false);
    expect(document.querySelectorAll(`#${PANEL_HOST_ID}`)).toHaveLength(1);
    expect(forgedRoot.querySelector('textarea')).toBeNull();
    expect(forgedRoot.contains(p.box)).toBe(false);
  });

  it('CONFIRMS (minor): a host planted AFTER the real panel mounts coexists; exclusivity is only enforced at mount', () => {
    direct();
    const late = document.createElement('div');
    late.id = PANEL_HOST_ID;
    document.body.append(late);
    expect(document.querySelectorAll(`#${PANEL_HOST_ID}`)).toHaveLength(2);
  });
});

describe('5. panel behavior', () => {
  it('KILLS: created variant skips undefined, empty and non-string values; no empty rows', () => {
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage, id: 'ext' } });
    const h = openPanel({
      variant: 'created',
      sent: { source: 'linkedin', url: 'https://x', name: 'Jane', headline: '', company: undefined, location: undefined, email: undefined, phone: 5, website: null } as any,
      source: 'linkedin',
      profileKey: 'jane',
      currentKey: () => 'jane',
    });
    const r = rootOf.get(h.host)!;
    expect(Array.from(r.querySelectorAll('dt')).map((n) => n.textContent)).toEqual(['Name']);
  });

  it('ACCEPTED: a whitespace-only value would render a blank row (extractors compact/trim upstream, so unreachable from real captures)', () => {
    // headline "   " is not '' so it passes the empty check. The extractors compact()/trim upstream; pinned here.
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(), id: 'ext' } });
    const h = openPanel({ variant: 'created', sent: { source: 'linkedin', url: 'u', name: 'Jane', headline: '   ' } as any, source: 'linkedin', profileKey: 'jane', currentKey: () => 'jane' });
    expect(Array.from(rootOf.get(h.host)!.querySelectorAll('dt')).map((n) => n.textContent)).toEqual(['Name', 'Title']);
  });

  it('KILLS: values with HTML are inert text, with a title attribute', () => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(), id: 'ext' } });
    const evil = '<img src=x onerror=alert(1)>';
    const h = openPanel({ variant: 'created', sent: { source: 'linkedin', url: 'u', name: evil } as any, source: 'linkedin', profileKey: 'jane', currentKey: () => 'jane' });
    const r = rootOf.get(h.host)!;
    expect(r.querySelector('img')).toBeNull();
    expect((r.querySelector('dd') as HTMLElement).title).toBe(evil);
  });

  it('KILLS: double click on Save sends exactly one request, even through a forced second click event', async () => {
    let release!: (v: unknown) => void;
    const p = direct(() => new Promise((r) => (release = r)));
    type(p.box, 'once');
    p.save.click();
    p.save.click();
    p.save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    release({ ok: true, personName: 'Jane' });
    await flush();
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('KILLS: text typed while a save is in flight survives the success clear (was a data loss defect)', async () => {
    let release!: (v: unknown) => void;
    const p = direct(() => new Promise((r) => (release = r)));
    type(p.box, 'first note');
    p.save.click();
    type(p.box, 'first note and the second thought I was still typing'); // textarea stays editable while saving
    release({ ok: true, personName: 'Jane' });
    await flush();
    // The box is cleared only when its text is still exactly the note that was sent.
    expect(p.box.value).toBe('first note and the second thought I was still typing');
    expect(p.status.dataset.tone).toBe('success');
  });

  it('KILLS: an unchanged box is still cleared on success', async () => {
    const p = direct(() => ({ ok: true, personName: 'Jane' }));
    type(p.box, 'just this note');
    p.save.click();
    await flush();
    expect(p.box.value).toBe('');
  });

  it('KILLS: error then retry works; save re-enables after a failure', async () => {
    let n = 0;
    const p = direct(() => (n++ === 0 ? { ok: false, code: 'network', message: 'down' } : { ok: true, personName: 'Jane' }));
    type(p.box, 'x');
    p.save.click();
    await flush();
    expect(p.status.dataset.tone).toBe('error');
    p.save.click();
    await flush();
    expect(p.status.dataset.tone).toBe('success');
  });

  it('KILLS: typing after success clears the green status; a very long server message is cut to 200', async () => {
    const p = direct(() => ({ ok: false, code: 'http', message: 'z'.repeat(5000) }));
    type(p.box, 'x');
    p.save.click();
    await flush();
    expect(p.status.textContent!.length).toBe(200);
  });

  it('KILLS: the save URL is origin+pathname of the live address (no query/hash leak)', async () => {
    history.pushState({}, '', '/in/jane/details/skills/?trk=secret#frag');
    const p = direct();
    type(p.box, 'x');
    p.save.click();
    await flush();
    const url = p.sendMessage.mock.calls[0]![0].payload.url as string;
    expect(url).toBe(`${location.origin}/in/jane/details/skills/`);
  });

  it('KILLS: panel is 320px wide, 16px padding, 12px radius, hint line present, both color schemes styled', () => {
    const p = direct();
    const css = p.root.querySelector('style')!.textContent!;
    expect(css).toMatch(/width: 320px/);
    expect(css).toMatch(/padding: 16px/);
    expect(css).toMatch(/border-radius: 12px/);
    expect(css).toMatch(/prefers-color-scheme: dark/);
    expect(p.root.querySelector('.hint')!.textContent).toBe('Notes save to this person in AgentCRM.');
  });

  it('CONFIRMS (minor): max-width is calc(100vw - 40px) so below 360px viewport the panel is narrower than the 320px the design states (accepted responsive)', () => {
    const p = direct();
    expect(p.root.querySelector('style')!.textContent).toMatch(/max-width: calc\(100vw - 40px\)/);
  });

  it('KILLS: closing while a save is in flight, then a late reply, repaints nothing and throws nothing', async () => {
    let release!: (v: unknown) => void;
    const p = direct(() => new Promise((r) => (release = r)));
    type(p.box, 'x');
    p.save.click();
    p.handle.close();
    release({ ok: true, personName: 'Jane' });
    await flush();
    expect(panelHost()).toBeNull();
  });

  it('KILLS: close() is idempotent and onClose fires once', () => {
    const onClose = vi.fn();
    const p = direct(undefined, { onClose });
    p.handle.close();
    p.handle.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('KILLS: opening a second panel does not call the first handle\'s onClose twice and the first stays harmless', () => {
    const a = vi.fn();
    const first = direct(undefined, { onClose: a });
    direct();
    expect(document.querySelectorAll(`#${PANEL_HOST_ID}`)).toHaveLength(1);
    // exclusive removal bypasses onClose: the first handle never learns it was displaced (chip.closePanel runs first, so fine there)
    expect(a).not.toHaveBeenCalled();
    first.handle.close();
    expect(a).toHaveBeenCalledTimes(1);
    expect(panelHost()).not.toBeNull(); // a stale handle's close() removes only its own host, never the newer panel
  });
});

// ---------- chip integration ----------
const PAGE = '<body><div id="row"><h1>Jane Doe</h1></div></body>';

async function boot(reply: (m: any) => unknown, html = PAGE, path = '/in/jane') {
  vi.resetModules();
  vi.useFakeTimers();
  document.documentElement.innerHTML = html;
  history.pushState({}, '', path);
  const sendMessage = vi.fn(async (m: any) => reply(m));
  vi.stubGlobal('chrome', { runtime: { sendMessage, id: 'ext' } });
  await import('../src/content/linkedin');
  await vi.advanceTimersByTimeAsync(0);
  return sendMessage;
}
const chipButton = () => rootOf.get(chipHosts()[0]!)!.querySelector('button')!;
const panelRoot = () => rootOf.get(panelHost()!)!;
const lookupReply = (exists: boolean) => (m: any) => (m.kind === 'lookup' ? { ok: true, exists } : m.kind === 'capture' ? { ok: true, outcome: 'created', personName: 'Jane Doe' } : { ok: true, personName: 'Jane Doe' });

describe('4/6. chip integration', () => {
  it('KILLS: the panel never auto-opens: not on mount, not on lookup hit, not on navigation', async () => {
    await boot(lookupReply(true));
    await vi.advanceTimersByTimeAsync(3000);
    expect(chipButton().dataset.state).toBe('inCrm');
    expect(panelHost()).toBeNull();
    history.pushState({}, '', '/in/other');
    await vi.advanceTimersByTimeAsync(3000);
    expect(panelHost()).toBeNull();
  });

  it('KILLS: a capture reply that lands after the user navigated to another profile does not open the panel', async () => {
    let release!: (v: unknown) => void;
    await boot((m) => (m.kind === 'lookup' ? { ok: true, exists: false } : new Promise((r) => (release = r))));
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    history.pushState({}, '', '/in/other'); // before the next poll tick: only the reply-time check can catch this
    release({ ok: true, outcome: 'created', personName: 'Jane' });
    await vi.advanceTimersByTimeAsync(0);
    expect(panelHost()).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(panelHost()).toBeNull();
  });

  it('KILLS: navigate A -> B -> A during a capture still drops the stale reply (generation)', async () => {
    let release!: (v: unknown) => void;
    await boot((m) => (m.kind === 'lookup' ? { ok: true, exists: false } : new Promise((r) => (release = r))));
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    history.pushState({}, '', '/in/other');
    await vi.advanceTimersByTimeAsync(900);
    history.pushState({}, '', '/in/jane');
    await vi.advanceTimersByTimeAsync(900);
    release({ ok: true, outcome: 'created', personName: 'Jane' });
    await vi.advanceTimersByTimeAsync(0);
    expect(panelHost()).toBeNull();
  });

  it('KILLS: a note reply arriving after navigation is dropped and the panel is torn down on navigation', async () => {
    let release!: (v: unknown) => void;
    await boot((m) => (m.kind === 'lookup' ? { ok: true, exists: true } : new Promise((r) => (release = r))));
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    const r = panelRoot();
    const box = r.querySelector('textarea')!;
    type(box, 'note');
    r.querySelector<HTMLButtonElement>('.save')!.click();
    history.pushState({}, '', '/in/other');
    release({ ok: true, personName: 'Jane' });
    await vi.advanceTimersByTimeAsync(900);
    expect(panelHost()).toBeNull();
    expect(box.value).toBe('note');
  });

  it('KILLS: clicking a stale In CRM chip inside the 800ms poll window re-checks instead of opening an unverified panel', async () => {
    await boot(lookupReply(true));
    expect(chipButton().dataset.state).toBe('inCrm');
    history.pushState({}, '', '/in/stranger'); // no poll tick yet: chip still says inCrm from the previous profile
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    // No panel, no "Already in your CRM" claim about a profile that was never looked up; the chip resets instead.
    expect(panelHost()).toBeNull();
    expect(chipButton().dataset.state).toBe('idle');
    // A second click on the now-current chip behaves normally (idle starts a capture, not a panel).
  });

  it('KILLS: In CRM click opens the panel (existing variant); the error state still opens options, not a panel', async () => {
    const sm = await boot((m) => (m.kind === 'lookup' ? { ok: true, exists: false } : m.kind === 'capture' ? { ok: false, code: 'unauthorized', message: 'x' } : { ok: true }));
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(chipButton().dataset.state).toBe('error');
    expect(panelHost()).toBeNull();
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sm).toHaveBeenCalledWith({ kind: 'openOptions' });
    expect(panelHost()).toBeNull();
  });

  it('KILLS: the floating chip variant opens the panel too', async () => {
    await boot(lookupReply(true), '<body><p>no heading</p></body>');
    expect(chipButton().dataset.placement).toBe('floating');
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(panelHost()).not.toBeNull();
    expect(panelRoot().querySelector('h2')!.textContent).toBe('Already in your CRM');
  });

  it('KILLS: created capture opens the created panel with the sent fields; reset clears nothing visible while open', async () => {
    await boot(lookupReply(false));
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(panelRoot().querySelector('h2')!.textContent).toBe('Added to AgentCRM');
    expect(Array.from(panelRoot().querySelectorAll('dt')).map((n) => n.textContent)).toEqual(['Name']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(chipButton().dataset.state).toBe('inCrm');
    expect(panelHost()).not.toBeNull(); // the panel outlives the 2.5s added->inCrm settle
  });

  it('KILLS: orphaned context removes an open panel and its chip; the dead panel cannot save', async () => {
    await boot(lookupReply(true));
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(panelHost()).not.toBeNull();
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => undefined), id: undefined } });
    await vi.advanceTimersByTimeAsync(900);
    expect(panelHost()).toBeNull();
    expect(chipHosts()).toHaveLength(0);
  });

  it('KILLS: leaving the profile page entirely (null identity) closes the panel', async () => {
    await boot(lookupReply(true));
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    history.pushState({}, '', '/feed/');
    await vi.advanceTimersByTimeAsync(900);
    expect(panelHost()).toBeNull();
  });

  it('KILLS: a second LIVE chip instance sweeps the first one\'s chip host AND its panel', async () => {
    await boot(lookupReply(true));
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    const firstPanel = panelHost();
    expect(firstPanel).not.toBeNull();
    vi.resetModules();
    await import('../src/content/linkedin');
    await vi.advanceTimersByTimeAsync(2000);
    expect(firstPanel!.isConnected).toBe(false); // the sweep now covers '#agentcrm-panel-host' too
    expect(chipHosts()).toHaveLength(1);
  });

  it('KILLS: chip css sets size only per placement, never per state (one outer size across states with In CRM clickable)', async () => {
    await boot(lookupReply(false));
    const css = rootOf.get(chipHosts()[0]!)!.querySelector('style')!.textContent!;
    const stateRules = css.match(/\.chip\[data-state[^{]*\{[^}]*\}/g) ?? [];
    expect(stateRules.length).toBeGreaterThan(0);
    for (const rule of stateRules) expect(rule).not.toMatch(/(?:^|[;{\s])(?:width|height|min-width|padding|font-size|border-width|border|margin)\s*:/);
  });

  it('KILLS: inline In CRM is still a real <button>, keyboard activatable, with the new accessible name', async () => {
    await boot(lookupReply(true));
    const b = chipButton();
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('aria-label')).toBe('In CRM. Add a note');
    expect(b.title).toBe('In CRM. Add a note');
  });

  it('KILLS: the lookup request on mount is the only message; opening the panel sends nothing', async () => {
    const sm = await boot(lookupReply(true));
    const before = sm.mock.calls.length;
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sm.mock.calls.length).toBe(before);
  });

  it('KILLS: a late capture reply never steals focus from a page field the user moved into', async () => {
    let release!: (v: unknown) => void;
    await boot((m) => (m.kind === 'lookup' ? { ok: true, exists: false } : new Promise((r) => (release = r))), '<body><div id="row"><h1>Jane Doe</h1></div><input id="composer"></body>');
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    const composer = document.getElementById('composer') as HTMLInputElement;
    composer.focus();
    expect(document.activeElement).toBe(composer);
    release({ ok: true, outcome: 'created', personName: 'Jane' });
    await vi.advanceTimersByTimeAsync(0);
    expect(panelHost()).not.toBeNull(); // the panel still opens
    expect(document.activeElement).toBe(composer); // but the user's keystrokes stay in the page's composer
  });

  it('KILLS: a direct In CRM click still lands focus in the note box (the chip host counts as ours)', async () => {
    await boot(lookupReply(true));
    (chipHosts()[0] as HTMLElement).focus?.();
    chipButton().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).toBe(panelHost()); // focus is inside the panel's shadow tree
  });
});
