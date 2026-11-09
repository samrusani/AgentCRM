// The capture panel, driven directly. The shadow root is closed, so attachShadow is wrapped to keep a handle on it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPanel, PANEL_HOST_ID, type PanelHandle } from '../src/content/panel';
import type { CapturePayload } from '../src/messages';

const realAttach = Element.prototype.attachShadow;
let roots: ShadowRoot[] = [];

beforeEach(() => {
  roots = [];
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const shadow = realAttach.call(this, init);
    roots.push(shadow);
    return shadow;
  };
  history.pushState({}, '', '/in/jane');
});
afterEach(() => {
  Element.prototype.attachShadow = realAttach;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const sent: CapturePayload = {
  source: 'linkedin',
  url: 'https://www.linkedin.com/in/jane',
  name: 'Jane Doe',
  headline: 'Founder at Acme',
  location: 'Berlin',
  email: 'jane@example.com',
  bio: 'Not listed in the panel.',
  handle: 'jane',
};

function open(reply: (msg: any) => unknown = () => ({ ok: true, personName: 'Jane Doe' }), variant: 'created' | 'existing' = 'existing', extra: { sent?: CapturePayload; added?: string[] } = {}) {
  const sendMessage = vi.fn(async (msg: any) => reply(msg));
  vi.stubGlobal('chrome', { runtime: { sendMessage, id: 'ext' } });
  const onClose = vi.fn();
  let key: string | null = 'jane';
  const handle: PanelHandle = openPanel({
    variant,
    ...(variant === 'created' ? { sent } : {}),
    ...extra,
    source: 'linkedin',
    profileKey: 'jane',
    currentKey: () => key,
    onClose,
  });
  const root = roots[roots.length - 1]!;
  return {
    handle,
    root,
    sendMessage,
    onClose,
    leave: () => (key = 'other'),
    box: root.querySelector('textarea')!,
    save: root.querySelector<HTMLButtonElement>('.save')!,
    status: root.querySelector<HTMLElement>('.status')!,
    close: root.querySelector<HTMLButtonElement>('.close')!,
  };
}

const type = (box: HTMLTextAreaElement, value: string) => {
  box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
};
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('capture panel', () => {
  it('uses a closed shadow root', () => {
    const p = open();
    expect(p.handle.host.id).toBe(PANEL_HOST_ID);
    expect(p.handle.host.shadowRoot).toBeNull();
    expect(document.body.contains(p.handle.host)).toBe(true);
  });

  it('created variant lists exactly the fields that were sent, in payload order, with full text in a title', () => {
    const p = open(undefined, 'created');
    expect(p.root.querySelector('h2')!.textContent).toBe('Added to AgentCRM');
    const labels = Array.from(p.root.querySelectorAll('dt')).map((n) => n.textContent);
    const values = Array.from(p.root.querySelectorAll('dd')).map((n) => n.textContent);
    expect(labels).toEqual(['Name', 'Title', 'Location', 'Email']);
    expect(values).toEqual(['Jane Doe', 'Founder at Acme', 'Berlin', 'jane@example.com']);
    expect(Array.from(p.root.querySelectorAll('dd')).map((n) => (n as HTMLElement).title)).toEqual(values);
    expect(p.root.textContent).not.toContain('Not listed in the panel');
  });

  it('existing variant has the other heading and no field list', () => {
    const p = open();
    expect(p.root.querySelector('h2')!.textContent).toBe('Already in your CRM');
    expect(p.root.querySelector('dl')).toBeNull();
    expect(p.root.querySelector('textarea')!.placeholder).toBe('Add a note');
    expect(p.root.querySelector('textarea')!.rows).toBe(3);
    expect(p.root.querySelector('.hint')!.textContent).toBe('Notes save to this person in AgentCRM.');
  });

  it('existing variant with an added list shows exactly those fields under the muted line', () => {
    const full: CapturePayload = { ...sent, company: 'Acme', website: 'https://acme.example', phone: '555 0100' };
    const p = open(undefined, 'existing', { sent: full, added: ['location', 'profileUrl', 'phone'] });
    expect(p.root.querySelector('h2')!.textContent).toBe('Already in your CRM');
    const line = p.root.querySelector('.hint.added')!;
    expect(line.textContent).toBe('Added to the record:');
    expect(Array.from(p.root.querySelectorAll('dt')).map((n) => n.textContent)).toEqual(['Profile', 'Location', 'Phone']);
    expect(Array.from(p.root.querySelectorAll('dd')).map((n) => n.textContent)).toEqual([
      'https://www.linkedin.com/in/jane',
      'Berlin',
      '555 0100',
    ]);
    expect(p.root.textContent).not.toContain('Jane Doe');
  });

  it('existing variant maps title to the headline', () => {
    const p = open(undefined, 'existing', { sent, added: ['title'] });
    expect(Array.from(p.root.querySelectorAll('dt')).map((n) => n.textContent)).toEqual(['Title']);
    expect(p.root.querySelector('dd')!.textContent).toBe('Founder at Acme');
  });

  it('existing variant with added [] or no list shows no list and no muted line', () => {
    const empty = open(undefined, 'existing', { sent, added: [] });
    expect(empty.root.querySelector('dl')).toBeNull();
    expect(empty.root.querySelector('.hint.added')).toBeNull();
    const click = open();
    expect(click.root.querySelector('dl')).toBeNull();
    expect(click.root.textContent).not.toContain('Added to the record');
  });

  it('skips an added key the sent payload does not carry, with no blank row', () => {
    const p = open(undefined, 'existing', { sent, added: ['website', 'location'] });
    expect(Array.from(p.root.querySelectorAll('dt')).map((n) => n.textContent)).toEqual(['Location']);
    const none = open(undefined, 'existing', { sent, added: ['website', 'bogus'] });
    expect(none.root.querySelector('dl')).toBeNull();
    expect(none.root.querySelector('.hint.added')).toBeNull();
  });

  it('moves focus into the panel on open', () => {
    const p = open();
    expect(p.root.activeElement).toBe(p.box);
  });

  it('Escape closes the panel', () => {
    const p = open();
    p.box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull();
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('the close control removes the panel', () => {
    const p = open();
    p.close.click();
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull();
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('exclusive mount removes a leftover host it did not create', () => {
    const leftover = document.createElement('div');
    leftover.id = PANEL_HOST_ID;
    document.body.append(leftover);
    const p = open();
    expect(document.querySelectorAll(`#${PANEL_HOST_ID}`)).toHaveLength(1);
    expect(leftover.isConnected).toBe(false);
    expect(p.handle.host.isConnected).toBe(true);
  });

  it('Save note is disabled while empty and while saving', async () => {
    let release!: (value: unknown) => void;
    const p = open(() => new Promise((resolve) => (release = resolve)));
    expect(p.save.disabled).toBe(true);
    type(p.box, '   ');
    expect(p.save.disabled).toBe(true);
    type(p.box, 'Met at the summit');
    expect(p.save.disabled).toBe(false);
    p.save.click();
    expect(p.save.disabled).toBe(true);
    release({ ok: true, personName: 'Jane Doe' });
    await flush();
    expect(p.save.disabled).toBe(true);
  });

  it('a successful save sends the profile identity, shows "Saved to <name>." and clears the box', async () => {
    const p = open();
    type(p.box, '  Met at the summit  ');
    p.save.click();
    await flush();
    expect(p.sendMessage).toHaveBeenCalledWith({
      kind: 'note',
      payload: { source: 'linkedin', url: `${location.origin}/in/jane`, note: 'Met at the summit' },
    });
    expect(p.status.textContent).toBe('Saved to Jane Doe.');
    expect(p.status.dataset.tone).toBe('success');
    expect(p.box.value).toBe('');
    expect(p.save.disabled).toBe(true);
  });

  it('an error shows an amber line and keeps the text', async () => {
    const p = open(() => ({ ok: false, code: 'not_found', message: 'No one in the CRM matches this profile. Capture it first.' }));
    type(p.box, 'Keep me');
    p.save.click();
    await flush();
    expect(p.status.textContent).toBe('No one in the CRM matches this profile. Capture it first.');
    expect(p.status.dataset.tone).toBe('error');
    expect(p.box.value).toBe('Keep me');
    expect(p.save.disabled).toBe(false);
  });

  it('401 and unconfigured errors name the options page', async () => {
    for (const code of ['unauthorized', 'unconfigured']) {
      const p = open(() => ({ ok: false, code, message: 'whatever' }));
      type(p.box, 'Hello');
      p.save.click();
      await flush();
      expect(p.status.textContent).toContain('options page');
      expect(p.status.dataset.tone).toBe('error');
    }
  });

  it('no answer from the extension shows a plain error', async () => {
    const p = open(() => undefined);
    type(p.box, 'Hello');
    p.save.click();
    await flush();
    expect(p.status.dataset.tone).toBe('error');
    expect(p.status.textContent).toContain('Reload the page');
  });

  it('a reply that lands after the address bar left the profile is dropped', async () => {
    let release!: (value: unknown) => void;
    const p = open(() => new Promise((resolve) => (release = resolve)));
    type(p.box, 'Hello');
    p.save.click();
    p.leave();
    release({ ok: true, personName: 'Jane Doe' });
    await flush();
    expect(p.status.dataset.tone).toBeUndefined();
    expect(p.box.value).toBe('Hello');
  });

  it('key events inside the panel do not reach a page level listener', () => {
    const p = open();
    const seen = vi.fn();
    for (const type of ['keydown', 'keyup', 'keypress']) {
      document.addEventListener(type, seen);
      window.addEventListener(type, seen);
      document.body.addEventListener(type, seen);
    }
    for (const type of ['keydown', 'keyup', 'keypress']) {
      p.box.dispatchEvent(new KeyboardEvent(type, { key: 'a', bubbles: true, composed: true }));
    }
    expect(seen).not.toHaveBeenCalled();
  });
});
