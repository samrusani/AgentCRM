// Shared helpers for the pure extraction layers. Nothing here touches the network or storage.

// Mirrors zod v3 (3.25.x) z.string().email(), which the server's capture schema uses, so an address the server
// would reject is dropped here instead of failing the whole capture.
export const EMAIL = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

/** Collapse whitespace, trim, and cap length. Returns undefined for empty input. */
export function cleanText(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') return undefined;
  return text.length > max ? text.slice(0, max).trimEnd() : text;
}

/** Returns the trimmed address when it looks like an email, otherwise undefined. Mirrors the server's email check. */
export function validEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/^mailto:/i, '');
  if (text.length === 0 || text.length > 254) return undefined;
  return EMAIL.test(text) ? text : undefined;
}

/** Text content of every non-empty text node under an element, in document order. */
export function textPieces(el: Element): string[] {
  const pieces: string[] = [];
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text !== '') pieces.push(text);
  }
  return pieces;
}

/** Drop undefined keys so request bodies stay minimal. */
export function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = item;
  return out as T;
}

/** Run a selector layer and swallow any failure: a broken layer degrades, it never throws. */
export function attempt<T>(layer: () => T): T | undefined {
  try {
    return layer();
  } catch {
    return undefined;
  }
}

// Elements that start and end a visual line in `innerText`. Used only by the layout free fallback below.
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN',
  'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL',
]);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);

/**
 * The visible text of an element as trimmed, non empty lines. Uses `innerText` (which follows the page's layout, so
 * it survives obfuscated class names) and falls back to a block aware walk of the text nodes where the environment
 * has no layout (jsdom has no `innerText`). Never throws on a plain element; a hostile deeply nested tree can throw
 * a RangeError, which callers wrap in `attempt`.
 */
export function textLines(el: Element): string[] {
  const inner = (el as HTMLElement).innerText;
  if (typeof inner === 'string') {
    return inner.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line !== '');
  }
  const lines: string[] = [];
  let current = '';
  const flush = () => {
    const text = current.replace(/\s+/g, ' ').trim();
    if (text !== '') lines.push(text);
    current = '';
  };
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      current += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== 1) return;
    const child = node as HTMLElement;
    if (SKIP_TAGS.has(child.tagName) || child.hasAttribute('hidden') || child.style?.display === 'none') return;
    const block = BLOCK_TAGS.has(child.tagName);
    if (block) flush();
    for (let next = child.firstChild; next; next = next.nextSibling) walk(next);
    if (block) flush();
  };
  walk(el);
  flush();
  return lines;
}
