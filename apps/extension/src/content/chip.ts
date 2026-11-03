import { CONFIG_MESSAGE } from '../messages';
import type { CapturePayload, CaptureResponse, ExtensionRequest, LookupResponse } from '../messages';

// The chip lives in a shadow root on a host div so site styles never leak in. Tokens follow docs/design.md.
// Inline (next to the profile name) is the default look; the floating fallback adds fixed positioning.
const STYLE = `
:host { all: initial; }
.chip {
  --accent: #15685B; --on-accent: #FFFFFF; --danger: #B42318; --ink-muted: #5B6472; --surface: #FFFFFF; --line: #E3E6EB;
  --mark: #E7F2EF; --warn-bg: #FEF3C7; --warn-ink: #92400E; --warn-line: #D97706;
  position: static; box-sizing: border-box; margin: 0; white-space: nowrap;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  display: inline-block; min-width: 11em; text-align: center;
  padding: 3px 10px; border: 1px solid transparent; border-radius: 6px; cursor: pointer;
  background: var(--accent); color: var(--on-accent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}
.chip[data-placement="floating"] { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; padding: 8px 14px; }
.chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.chip[data-state="sending"] { background: var(--surface); color: var(--ink-muted); box-shadow: inset 0 0 0 1px var(--line); cursor: progress; }
.chip[data-state="error"] { background: var(--danger); }
.chip[data-state="inCrm"] { background: transparent; color: var(--ink-muted); border-color: var(--line); box-shadow: none; cursor: default; }
.chip[data-state="inCrm"][data-placement="floating"] { background: var(--surface); }
/* The inline presentation is a compact icon button: one 22px square in every state, the capture mark drawn as SVG. */
.chip[data-placement="inline"] {
  display: inline-flex; align-items: center; justify-content: center; vertical-align: middle;
  position: relative; width: 22px; height: 22px; min-width: 22px; padding: 0; line-height: 0; font-size: 0;
  color: var(--mark);
}
/* The state label for assistive tech: hidden visually, zero layout impact, so the live region announces changes. */
.chip[data-placement="inline"] .sr {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
.chip[data-placement="inline"] svg { display: block; width: 100%; height: 100%; pointer-events: none; }
.chip[data-placement="inline"][data-state="sending"] { background: var(--surface); color: var(--ink-muted); }
.chip[data-placement="inline"][data-state="error"] { background: var(--warn-bg); color: var(--warn-ink); border-color: var(--warn-line); box-shadow: none; }
.chip[data-placement="inline"][data-state="inCrm"] { background: transparent; color: var(--ink-muted); border-color: var(--ink-muted); box-shadow: none; }
@media (prefers-color-scheme: dark) {
  .chip { --accent: #43B39C; --on-accent: #15211E; --danger: #F0756A; --ink-muted: #959DAB; --surface: #1F232A; --line: #262B33;
    --mark: #15211E; --warn-bg: #3B2A0A; --warn-ink: #FBBF24; --warn-line: #F59E0B; }
}
`;

export type ChipState = 'idle' | 'sending' | 'added' | 'inCrm' | 'error';
export type ChipPlacement = 'inline' | 'floating';

const LABELS: Record<Exclude<ChipState, 'error'>, string> = {
  idle: 'Add to AgentCRM',
  sending: 'Adding',
  added: 'Added',
  inCrm: 'In CRM',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One filled rect in the 100 unit icon box. */
function rect(x: number, y: number, w: number, h: number): SVGRectElement {
  const el = document.createElementNS(SVG_NS, 'rect');
  for (const [name, value] of [['x', x], ['y', y], ['width', w], ['height', h]] as const) el.setAttribute(name, String(value));
  return el;
}

/**
 * The extension's capture mark (see scripts/icons.mjs): four corner brackets at 20% and 80% with arm 22% and
 * thickness 9%, and a centered 20% square dot. The field behind it is the button's own background. The `added`
 * state swaps the brackets for a check so the confirmation reads at a glance, in the same box.
 */
export function buildIcon(kind: 'mark' | 'check'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'currentColor');
  if (kind === 'check') {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M24 52 L43 70 L77 31');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '11');
    path.setAttribute('stroke-linecap', 'square');
    svg.append(path);
    return svg;
  }
  const lo = 20, hi = 80, arm = 22, t = 9;
  for (const [cx, sx] of [[lo, 1], [hi, -1]] as const) {
    for (const [cy, sy] of [[lo, 1], [hi, -1]] as const) {
      svg.append(rect(sx > 0 ? cx : cx - arm, sy > 0 ? cy : cy - t, arm, t));
      svg.append(rect(sx > 0 ? cx : cx - t, sy > 0 ? cy : cy - arm, t, arm));
    }
  }
  svg.append(rect(40, 40, 20, 20));
  return svg;
}

// The host carries inline styles only, set with !important so a site reset or a broad selector cannot zero it out.
const HOST_STYLES: Record<ChipPlacement, Array<[string, string]>> = {
  inline: [
    ['display', 'inline-flex'],
    ['vertical-align', 'middle'],
    ['margin-left', '8px'],
    ['visibility', 'visible'],
  ],
  // The fixed positioning lives on the chip inside the shadow root; the host only has to stay renderable.
  floating: [
    ['display', 'inline'],
    ['visibility', 'visible'],
  ],
};

export interface ChipConfig {
  /** Which site this script runs on; sent with the profile URL in the lookup. */
  source: 'linkedin' | 'x';
  /** The element the chip sits next to, or null when the page has not rendered it (the chip then floats). Must not throw. */
  findAnchor(doc: Document): Element | null;
  /**
   * The canonical identity of the profile the URL shows, or null when it is not a profile page this script can
   * capture. Query, hash, and subpages of one profile yield the same key (LinkedIn: the raw `/in/` id; X: the
   * lowercased handle).
   */
  profileKey(url: URL): string | null;
  /** Builds the request body. Must not throw; the extractors guarantee a name. */
  build(doc: Document, url: URL): CapturePayload;
}

function send<T>(request: ExtensionRequest): Promise<T | undefined> {
  try {
    return Promise.resolve(chrome.runtime.sendMessage(request) as Promise<T | undefined>).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

export function messageFor(response: CaptureResponse | undefined): { text: string; needsOptions: boolean } {
  if (!response) return { text: 'No answer from the extension. Reload the page and try again', needsOptions: false };
  if (response.ok) return { text: '', needsOptions: false };
  if (response.code === 'unauthorized' || response.code === 'unconfigured') {
    return { text: CONFIG_MESSAGE, needsOptions: true };
  }
  const text = response.message.trim().replace(/\.$/, '');
  return { text: text === '' ? 'Could not add this profile' : text.slice(0, 140), needsOptions: false };
}

const INTERACTIVE = 'a, button, [role="link"], [role="button"]';

/**
 * Where the host goes: after the anchor, or after the outermost interactive ancestor wrapping it (a link, a
 * button, or an element with either role) so a click or key press on the chip never reaches one.
 */
function insertionPoint(anchor: Element): Element {
  let point: Element = anchor;
  for (let wrapper = point.closest(INTERACTIVE); wrapper; wrapper = point.parentElement?.closest(INTERACTIVE) ?? null) {
    point = wrapper;
  }
  return point;
}

export function startChip(config: ChipConfig): void {
  let host: HTMLDivElement | null = null;
  let button: HTMLButtonElement | null = null;
  let placement: ChipPlacement = 'floating';
  let state: ChipState = 'idle';
  let errorNeedsOptions = false;
  let errorText = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastKey: string | null = null;
  let generation = 0;
  let lookedUp = -1;

  // The identity of the profile the address bar shows right now, or null off a profile page.
  const currentKey = (): string | null => {
    try {
      return config.profileKey(new URL(location.href));
    } catch {
      return null;
    }
  };

  const render = (next: ChipState, text?: string) => {
    state = next;
    if (text !== undefined) errorText = text;
    if (!button) return;
    button.dataset.state = next;
    const label = next === 'error' ? errorText : LABELS[next];
    if (placement === 'floating') {
      // The floating chip is the full labeled chip: its text is its name.
      button.textContent = label;
      button.removeAttribute('aria-label');
      button.removeAttribute('title');
    } else {
      // The inline chip is an icon: the state lives in its accessible name, native tooltip, and a visually hidden
      // text node (so the live region announces a change), never in its size.
      const hidden = document.createElement('span');
      hidden.className = 'sr';
      hidden.textContent = label;
      button.replaceChildren(buildIcon(next === 'added' ? 'check' : 'mark'), hidden);
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    if (next === 'inCrm') button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
  };

  const reset = () => {
    generation += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    errorNeedsOptions = false;
    render('idle');
  };

  const unmount = () => {
    host?.remove();
    host = null;
    button = null;
  };

  const findAnchor = (): Element | null => {
    try {
      return config.findAnchor(document);
    } catch {
      return null;
    }
  };

  const build = (where: ChipPlacement): HTMLDivElement => {
    const el = document.createElement('div');
    el.id = 'agentcrm-capture-host';
    for (const [name, value] of HOST_STYLES[where]) el.style.setProperty(name, value, 'important');
    const root = el.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.placement = where;
    button.setAttribute('aria-live', 'polite');
    button.addEventListener('click', (event) => {
      // The inline chip can sit inside a heading or link on the page; the click is ours alone.
      event.preventDefault();
      event.stopPropagation();
      void onClick();
    });
    // Key presses on the chip are the chip's alone: the page's handlers never see them.
    for (const type of ['keydown', 'keyup'] as const) button.addEventListener(type, (event) => event.stopPropagation());
    root.append(style, button);
    return el;
  };

  // True when the live host already sits where the current page wants it.
  const inPlace = (anchor: Element | null): boolean => {
    if (!host || !host.isConnected) return false;
    if (anchor === null) return placement === 'floating';
    return placement === 'inline' && host.parentNode === insertionPoint(anchor).parentNode;
  };

  const mount = () => {
    const anchor = findAnchor();
    if (inPlace(anchor)) return;
    // Never two hosts: the old one goes before the new one is built, whether it was detached or misplaced.
    unmount();
    placement = anchor ? 'inline' : 'floating';
    host = build(placement);
    render(state);
    if (anchor) insertionPoint(anchor).after(host);
    else (document.body ?? document.documentElement).append(host);
  };

  const onClick = async () => {
    if (state === 'sending' || state === 'added' || state === 'inCrm') return;
    if (state === 'error') {
      await send({ kind: 'openOptions' });
      return;
    }
    const mine = generation;
    const key = currentKey();
    render('sending');
    let response: CaptureResponse | undefined;
    try {
      const url = new URL(location.href);
      response = await send<CaptureResponse>({ kind: 'capture', payload: config.build(document, url) });
    } catch {
      response = undefined;
    }
    if (mine !== generation || currentKey() !== key) return;
    if (response?.ok) {
      if (response.outcome === 'existing') {
        render('inCrm');
      } else {
        render('added');
        timer = setTimeout(() => render('inCrm'), 2500);
      }
      return;
    }
    const failure = messageFor(response);
    errorNeedsOptions = failure.needsOptions;
    render('error', failure.text);
    if (!errorNeedsOptions) timer = setTimeout(() => render('idle'), 6000);
  };

  // One lookup per profile page. Every failure is silent: capture stays the authority and the chip stays idle.
  const lookup = async (url: URL, key: string) => {
    const mine = generation;
    const response = await send<LookupResponse>({
      kind: 'lookup',
      payload: { source: config.source, url: url.origin + url.pathname },
    });
    // Checked at reply time against the address bar, so a reply for one profile never paints another, even
    // between two poll ticks.
    if (mine !== generation || currentKey() !== key) return;
    // A capture the user started meanwhile owns the state.
    if (state === 'idle' && response?.ok === true && response.exists === true) render('inCrm');
  };

  const check = () => {
    const key = currentKey();
    if (key !== lastKey) {
      lastKey = key;
      reset();
    }
    if (key === null) {
      unmount();
      return;
    }
    mount();
    if (lookedUp !== generation) {
      lookedUp = generation;
      void lookup(new URL(location.href), key);
    }
  };

  check();
  // A page script can dispatch a synthetic popstate; only the browser's own (trusted) ones count. The poll covers the rest.
  window.addEventListener('popstate', (event) => {
    if (event.isTrusted) check();
  });
  setInterval(check, 800);
}
