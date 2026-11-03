import { CONFIG_MESSAGE } from '../messages';
import type { CapturePayload, CaptureResponse, ExtensionRequest } from '../messages';

// The chip lives in a shadow root on a host div so site styles never leak in. Tokens follow docs/design.md.
const STYLE = `
:host { all: initial; }
.chip {
  --accent: #15685B; --on-accent: #FFFFFF; --danger: #B42318; --ink-muted: #5B6472; --surface: #FFFFFF; --line: #E3E6EB;
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 8px 14px; border: 0; border-radius: 6px; cursor: pointer;
  background: var(--accent); color: var(--on-accent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}
.chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.chip[data-state="sending"] { background: var(--surface); color: var(--ink-muted); box-shadow: inset 0 0 0 1px var(--line); cursor: progress; }
.chip[data-state="error"] { background: var(--danger); }
@media (prefers-color-scheme: dark) {
  .chip { --accent: #43B39C; --on-accent: #15211E; --danger: #F0756A; --ink-muted: #959DAB; --surface: #1F232A; --line: #262B33; }
}
`;

export type ChipState = 'idle' | 'sending' | 'added' | 'existing' | 'error';

const LABELS: Record<Exclude<ChipState, 'error'>, string> = {
  idle: 'Add to AgentCRM',
  sending: 'Adding',
  added: 'Added',
  existing: 'Already in CRM',
};

export interface ChipConfig {
  /** True when the URL is a page that shows a profile this script can capture. */
  isProfile(url: URL): boolean;
  /** Builds the request body. Must not throw; the extractors guarantee a name. */
  build(doc: Document, url: URL): CapturePayload;
}

function send(request: ExtensionRequest): Promise<CaptureResponse | undefined> {
  try {
    return Promise.resolve(chrome.runtime.sendMessage(request) as Promise<CaptureResponse | undefined>).catch(() => undefined);
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

export function startChip(config: ChipConfig): void {
  let host: HTMLDivElement | null = null;
  let button: HTMLButtonElement | null = null;
  let state: ChipState = 'idle';
  let errorNeedsOptions = false;
  let errorText = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastHref = '';
  let generation = 0;

  const render = (next: ChipState, text?: string) => {
    state = next;
    if (text !== undefined) errorText = text;
    if (!button) return;
    button.dataset.state = next;
    button.textContent = next === 'error' ? errorText : LABELS[next];
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

  const mount = () => {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.id = 'agentcrm-capture-host';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.setAttribute('aria-live', 'polite');
    button.addEventListener('click', () => void onClick());
    root.append(style, button);
    render(state);
    (document.body ?? document.documentElement).append(host);
  };

  const settle = (next: ChipState, ms: number) => {
    timer = setTimeout(() => render('idle'), ms);
    render(next);
  };

  const onClick = async () => {
    if (state === 'sending' || state === 'added' || state === 'existing') return;
    if (state === 'error') {
      await send({ kind: 'openOptions' });
      return;
    }
    const mine = generation;
    render('sending');
    let response: CaptureResponse | undefined;
    try {
      const url = new URL(location.href);
      response = await send({ kind: 'capture', payload: config.build(document, url) });
    } catch {
      response = undefined;
    }
    if (mine !== generation) return;
    if (response?.ok) {
      settle(response.outcome === 'existing' ? 'existing' : 'added', 2500);
      return;
    }
    const failure = messageFor(response);
    errorNeedsOptions = failure.needsOptions;
    render('error', failure.text);
    if (!errorNeedsOptions) timer = setTimeout(() => render('idle'), 6000);
  };

  const check = () => {
    const href = location.href;
    if (href !== lastHref) {
      lastHref = href;
      reset();
    }
    let profile = false;
    try {
      profile = config.isProfile(new URL(href));
    } catch {
      profile = false;
    }
    if (profile) mount();
    else unmount();
  };

  check();
  window.addEventListener('popstate', check);
  setInterval(check, 800);
}
