import type { CapturePayload, ExtensionRequest, NoteResponse } from '../messages';
import { buildIcon } from './icon';

// The capture panel: a card in the bottom right corner that confirms what a capture sent and takes a note. It lives
// in a closed shadow root on its own host, like the button, so page scripts cannot read it. Tokens follow the
// options page, both appearances via prefers-color-scheme.
export const PANEL_HOST_ID = 'agentcrm-panel-host';

const STYLE = `
:host { all: initial; }
.panel {
  --surface: #FFFFFF; --ink: #1A1D23; --ink-muted: #5B6472; --line: #E3E6EB; --bg: #F6F7F9;
  --accent: #15685B; --on-accent: #FFFFFF; --warn-ink: #92400E;
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
  box-sizing: border-box; width: 320px; max-width: calc(100vw - 40px); padding: 16px; margin: 0;
  background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.12);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; text-align: left;
}
.panel * { box-sizing: border-box; }
.head { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; }
.mark { display: block; width: 16px; height: 16px; flex: none; color: var(--accent); }
.mark svg { display: block; width: 100%; height: 100%; }
.title { flex: 1; min-width: 0; margin: 0; font-size: 14px; font-weight: 600; line-height: 1.3; }
.close {
  flex: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: transparent;
  color: var(--ink-muted); font: 18px/1 system-ui, sans-serif; cursor: pointer;
}
.close:hover { background: var(--bg); color: var(--ink); }
.fields { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 4px 12px; margin: 0 0 12px; }
.fields dt { margin: 0; color: var(--ink-muted); }
.fields dd { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
textarea {
  display: block; width: 100%; margin: 0; padding: 8px 10px; resize: vertical; border: 1px solid var(--line);
  border-radius: 6px; background: var(--bg); color: var(--ink); font: inherit;
}
textarea::placeholder { color: var(--ink-muted); }
.row { display: flex; align-items: center; gap: 12px; margin: 8px 0 0; }
.save {
  flex: none; height: 32px; padding: 0 14px; border: 0; border-radius: 6px; background: var(--accent);
  color: var(--on-accent); font: inherit; font-weight: 550; cursor: pointer;
}
.save:disabled { opacity: 0.6; cursor: default; }
.status { flex: 1; min-width: 0; min-height: 18px; margin: 0; }
.status[data-tone="success"] { color: var(--accent); }
.status[data-tone="error"] { color: var(--warn-ink); }
.hint.added { margin: 0 0 8px; }
.hint { margin: 8px 0 0; color: var(--ink-muted); font-size: 12px; }
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  .panel { --surface: #191C21; --ink: #E7EAEE; --ink-muted: #959DAB; --line: #262B33; --bg: #121418;
    --accent: #43B39C; --on-accent: #15211E; --warn-ink: #FBBF24; }
}
`;

// The capture fields the panel lists, with their labels. The list follows the order of the payload that was sent.
const FIELD_LABELS: Partial<Record<keyof CapturePayload, string>> = {
  name: 'Name',
  headline: 'Title',
  company: 'Company',
  location: 'Location',
  website: 'Website',
  email: 'Email',
  phone: 'Phone',
};

// The server's filled-field keys, mapped to the sent payload field that holds the value and the label shown.
const ADDED_KEYS: Record<string, { field: keyof CapturePayload; label: string }> = {
  title: { field: 'headline', label: 'Title' },
  location: { field: 'location', label: 'Location' },
  email: { field: 'email', label: 'Email' },
  website: { field: 'website', label: 'Website' },
  company: { field: 'company', label: 'Company' },
  phone: { field: 'phone', label: 'Phone' },
  profileUrl: { field: 'url', label: 'Profile' },
};

export const OPTIONS_MESSAGE = 'Open the extension options page to finish setup.';
const NO_ANSWER_MESSAGE = 'No answer from the extension. Reload the page and try again.';

export interface PanelOptions {
  /** `created` lists the fields the capture sent; `existing` lists only the `added` fields, or none. */
  variant: 'created' | 'existing';
  /** The payload the capture sent. Supplies the values for the field list. */
  sent?: CapturePayload;
  /** Existing variant only: the field keys the server filled in. Empty or absent shows no list. */
  added?: string[];
  source: 'linkedin' | 'x';
  /** The identity of the profile the panel was opened for. */
  profileKey: string;
  /** The identity of the profile the address bar shows now, or null off a profile page. */
  currentKey(): string | null;
  /** Called once when the panel closes for any reason. */
  onClose?(): void;
}

export interface PanelHandle {
  host: HTMLElement;
  close(): void;
}

function send<T>(request: ExtensionRequest): Promise<T | undefined> {
  try {
    return Promise.resolve(chrome.runtime.sendMessage(request) as Promise<T | undefined>).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

export function noteErrorText(response: NoteResponse | undefined): string {
  if (!response) return NO_ANSWER_MESSAGE;
  if (response.ok) return '';
  if (response.code === 'unauthorized' || response.code === 'unconfigured') return OPTIONS_MESSAGE;
  const text = response.message.trim();
  return text === '' ? 'Could not save the note.' : text.slice(0, 200);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function openPanel(options: PanelOptions): PanelHandle {
  // Exclusive: a panel an orphaned script left behind never sits next to this one.
  for (const node of Array.from(document.querySelectorAll(`#${PANEL_HOST_ID}`))) node.remove();

  const host = document.createElement('div');
  host.id = PANEL_HOST_ID;
  host.style.setProperty('display', 'block', 'important');
  host.style.setProperty('visibility', 'visible', 'important');
  const root = host.attachShadow({ mode: 'closed' });
  const style = el('style');
  style.textContent = STYLE;

  const panel = el('div', 'panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'heading');

  const head = el('div', 'head');
  const mark = el('span', 'mark');
  mark.append(buildIcon('mark'));
  const title = el('h2', 'title', options.variant === 'created' ? 'Added to AgentCRM' : 'Already in your CRM');
  title.id = 'heading';
  const closeButton = el('button', 'close', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  head.append(mark, title, closeButton);
  panel.append(head);

  const list = el('dl', 'fields');
  if (options.variant === 'created' && options.sent) {
    for (const [key, value] of Object.entries(options.sent)) {
      const label = FIELD_LABELS[key as keyof CapturePayload];
      if (label === undefined || typeof value !== 'string' || value === '') continue;
      const detail = el('dd', undefined, value);
      detail.title = value;
      list.append(el('dt', undefined, label), detail);
    }
    panel.append(list);
  } else if (options.variant === 'existing' && options.sent && options.added && options.added.length > 0) {
    const wanted = new Map<string, string>();
    for (const key of options.added) {
      const entry = ADDED_KEYS[key];
      if (entry) wanted.set(entry.field, entry.label);
    }
    // Sent payload order, like the created variant; a key with no sent value is skipped without a blank row.
    for (const [key, value] of Object.entries(options.sent)) {
      const label = wanted.get(key);
      if (label === undefined || typeof value !== 'string' || value === '') continue;
      const detail = el('dd', undefined, value);
      detail.title = value;
      list.append(el('dt', undefined, label), detail);
    }
    if (list.childElementCount > 0) panel.append(el('p', 'hint added', 'Added to the record:'), list);
  }

  const box = el('textarea');
  box.rows = 3;
  box.maxLength = 2000;
  box.placeholder = 'Add a note';
  box.setAttribute('aria-label', 'Note');
  const save = el('button', 'save', 'Save note');
  save.type = 'button';
  save.disabled = true;
  const status = el('p', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const row = el('div', 'row');
  row.append(save, status);
  panel.append(box, row, el('p', 'hint', 'Notes save to this person in AgentCRM.'));

  let closed = false;
  let saving = false;

  const close = () => {
    if (closed) return;
    closed = true;
    host.remove();
    options.onClose?.();
  };

  const sync = () => {
    save.disabled = saving || box.value.trim() === '';
  };
  const setStatus = (text: string, tone: 'success' | 'error' | '') => {
    status.textContent = text;
    if (tone === '') status.removeAttribute('data-tone');
    else status.dataset.tone = tone;
  };

  box.addEventListener('input', () => {
    if (status.dataset.tone === 'success') setStatus('', '');
    sync();
  });
  closeButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  save.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const note = box.value.trim();
    if (saving || note === '' || options.currentKey() !== options.profileKey) return;
    saving = true;
    sync();
    setStatus('Saving.', '');
    const url = new URL(location.href);
    const response = await send<NoteResponse>({
      kind: 'note',
      payload: { source: options.source, url: url.origin + url.pathname, note },
    });
    saving = false;
    // Applied only while the address bar still shows the profile the note was written for.
    if (closed || options.currentKey() !== options.profileKey) return;
    if (response?.ok === true) {
      // Cleared only when the text is still exactly the note that was sent: words typed during a slow save stay.
      if (box.value.trim() === note) box.value = '';
      setStatus(response.personName ? `Saved to ${response.personName}.` : 'Saved.', 'success');
      sync();
      focusBox();
      return;
    }
    setStatus(noteErrorText(response), 'error');
    sync();
  });

  // Focus moves into the note box only when the user is not already typing somewhere else: a late capture reply
  // never steals keystrokes from a page field. The extension's own hosts count as "not elsewhere", so a click on
  // the capture button or inside the panel still lands focus in the box.
  const focusBox = () => {
    const active = document.activeElement;
    const ours = active === null || active === document.body || active === document.documentElement
      || active === host || active.id === 'agentcrm-capture-host' || active.id === PANEL_HOST_ID;
    if (ours) box.focus();
  };

  // Keys typed in the panel belong to the panel: the page's handlers never see them.
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    panel.addEventListener(type, (event) => {
      event.stopPropagation();
      if (type === 'keydown' && (event as KeyboardEvent).key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
  }

  root.append(style, panel);
  (document.body ?? document.documentElement).append(host);
  focusBox();
  return { host, close };
}
