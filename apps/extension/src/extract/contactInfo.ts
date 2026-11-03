import { attempt, cleanText, compact, textLines, validEmail } from './common';

export interface ContactInfo {
  email?: string;
  phone?: string;
  website?: string;
}

const MAX_PHONE = 40;
const MAX_WEBSITE = 500;
// How far above the "Contact info" heading the overlay container is looked for.
const MAX_DEPTH = 8;
// The label lines of the overlay's sections. A value line that is itself a label means the value is missing.
const LABELS = new Set(['email', 'phone', 'website', 'websites', 'address', 'birthday', 'connected', 'im', 'twitter']);
// Lines whose presence marks an element as the overlay body rather than just its title bar.
const BODY_MARKERS = /^(?:(?:www\.)?linkedin\.com\/in\/|email$|phone$|websites?$|address$|birthday$|connected$)/i;

/** True when the element's own or an inherited opacity is zero. Needs a view for computed style; inline style is the fallback. */
function isTransparent(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const computed = view?.getComputedStyle(node).opacity;
    const inline = (node as HTMLElement).style?.opacity;
    for (const value of [computed, inline]) {
      if (typeof value === 'string' && value.trim() !== '' && Number.parseFloat(value) === 0) return true;
    }
  }
  return false;
}

/**
 * True when the element takes up space on screen and can be seen. Fixed position elements have a null offsetParent,
 * so layout is asked; a fully transparent element (own or inherited opacity 0) is not visible.
 */
function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
  return !isTransparent(el);
}

/**
 * The overlay container: for each visible `h2` reading "Contact info", the smallest visible ancestor that also holds
 * the overlay body (the profile link line or a section label). Among those candidates the last one in document order
 * wins, because the site appends the real overlay late. The role attribute is no help (the page carries other
 * hidden dialogs), so identity comes from the heading text and visibility alone.
 */
export function findContactInfoOverlay(doc: Document): Element | null {
  let found: Element | null = null;
  for (const heading of Array.from(doc.querySelectorAll('h2'))) {
    if ((heading.textContent ?? '').replace(/\s+/g, ' ').trim() !== 'Contact info') continue;
    if (!isVisible(heading)) continue;
    let node: Element | null = heading;
    for (let depth = 0; node && depth <= MAX_DEPTH && node !== doc.body && node !== doc.documentElement; depth += 1) {
      const lines = textLines(node);
      const hasBody = lines.some((line) => BODY_MARKERS.test(line)) || node.querySelector('a[href^="mailto:" i]') !== null;
      if (hasBody) {
        if (isVisible(node)) found = node;
        break;
      }
      node = node.parentElement;
    }
  }
  return found;
}

/** The id of `/in/<id>/overlay/contact-info/` for a pathname, lowercased and percent decoded, or null on any other path. */
function overlayPathId(pathname: string): string | null {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // Keep the raw path when it is not valid percent encoding.
  }
  const match = /^\/in\/([^/]+)\/overlay\/contact-info\/?$/i.exec(path);
  return match && match[1] ? match[1].toLowerCase() : null;
}

/** The profile id a line like "linkedin.com/in/<id>" names, lowercased and percent decoded, or null. */
function overlayProfileId(lines: string[]): string | null {
  for (const line of lines) {
    const match = /(?:^|\/\/|www\.)linkedin\.com\/in\/([^/?#\s]+)/i.exec(line);
    if (!match || !match[1]) continue;
    let id = match[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      // Keep the raw segment when it is not valid percent encoding.
    }
    return id.toLowerCase();
  }
  return null;
}

/** The value line right after an exact label line, or undefined when the label is missing or has no value. */
function valueAfter(lines: string[], labels: string[]): string | undefined {
  const at = lines.findIndex((line) => labels.includes(line));
  if (at < 0) return undefined;
  const value = lines[at + 1];
  if (value === undefined || LABELS.has(value.toLowerCase())) return undefined;
  return value;
}

function emailOf(container: Element, lines: string[]): string | undefined {
  const href = container.querySelector('a[href^="mailto:" i]')?.getAttribute('href');
  if (href) {
    let raw = href.replace(/^mailto:/i, '').split('?')[0] ?? '';
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // Keep the raw value when it is not valid percent encoding.
    }
    const email = validEmail(raw);
    if (email) return email;
  }
  return validEmail(valueAfter(lines, ['Email']));
}

function phoneOf(lines: string[]): string | undefined {
  const value = valueAfter(lines, ['Phone']);
  if (value === undefined) return undefined;
  // "555 010 1234 (Mobile)": the parenthetical kind is not part of the number.
  const phone = value.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return phone.length >= 1 && phone.length <= MAX_PHONE && /\d/.test(phone) ? phone : undefined;
}

function websiteOf(lines: string[]): string | undefined {
  const value = valueAfter(lines, ['Website', 'Websites']);
  if (value === undefined) return undefined;
  // The visible text is the source of truth: the link itself is wrapped in LinkedIn's redirect.
  const text = (value.split(' (')[0] ?? '').trim();
  if (text === '' || /\s/.test(text)) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme && !/^https?$/i.test(scheme[1]!)) return undefined;
  return cleanText(scheme ? text : `https://${text}`, MAX_WEBSITE);
}

/**
 * Reads the contact info overlay when it is open: email, phone, and website. Pure over the document and read only
 * (it never clicks, focuses, or navigates, so the capture can not open the overlay). "Open" requires both signals:
 * the address bar (`url`, a URL or `location`) is on `/in/<id>/overlay/contact-info/` and a visible container headed "Contact info"
 * exists. Returns an empty object otherwise, and when the container names a different profile than the address bar
 * (the SPA swapped pages and left the previous overlay behind). Never throws.
 */
export function parseContactInfo(doc: Document, url?: { pathname: string } | null): ContactInfo {
  return (
    attempt(() => {
      const ownId = url ? overlayPathId(url.pathname) : null;
      if (ownId === null) return {};
      const container = findContactInfoOverlay(doc);
      if (!container) return {};
      const lines = textLines(container);
      const named = overlayProfileId(lines);
      if (named !== null && named !== ownId) return {};
      return compact({ email: emailOf(container, lines), phone: phoneOf(lines), website: websiteOf(lines) });
    }) ?? {}
  );
}
