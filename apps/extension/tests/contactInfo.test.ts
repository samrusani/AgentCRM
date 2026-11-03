// The LinkedIn contact info overlay: parsed from the live structure (a plain div headed by an h2, among other
// hidden dialogs), read only, and merged into the capture payload.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findContactInfoOverlay, parseContactInfo } from '../src/extract/contactInfo';
import { extractLinkedinProfile } from '../src/extract/linkedin';
import { textLines } from '../src/extract/common';
import { CAPTION_DIALOG, GHOST_OVERLAY, liveProfileHtml, overlayHtml, stubLayout } from './linkedinFixtures';

const page = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');
const url = new URL('https://www.linkedin.com/in/satya-nadella/overlay/contact-info/');
const withOverlay = (overlay: string, title?: string) => page(liveProfileHtml({ title, after: CAPTION_DIALOG + GHOST_OVERLAY + overlay }));

let restore: () => void = () => undefined;
beforeEach(() => {
  restore = stubLayout();
});
afterEach(() => restore());

describe('parseContactInfo', () => {
  it('reads email (query stripped), phone (kind dropped), and website (qualifier dropped, https prepended)', () => {
    const doc = withOverlay(overlayHtml());
    expect(parseContactInfo(doc, url)).toEqual({
      email: 'satya@example.com',
      phone: '555 010 1234',
      website: 'https://snscratchpad.com',
    });
  });

  it('identifies the overlay by its visible Contact info h2, ignoring role=dialog noise and a hidden decoy', () => {
    const doc = withOverlay(overlayHtml());
    const container = findContactInfoOverlay(doc);
    expect(container?.className).toBe('djeOverlay');
    const parsed = parseContactInfo(doc, url);
    expect(JSON.stringify(parsed)).not.toContain('ghost');
    expect(JSON.stringify(parsed)).not.toContain('999');
  });

  it('returns nothing when the overlay is not open (only the hidden noise is on the page)', () => {
    const doc = page(liveProfileHtml({ after: CAPTION_DIALOG + GHOST_OVERLAY }));
    expect(findContactInfoOverlay(doc)).toBeNull();
    expect(parseContactInfo(doc, url)).toEqual({});
  });

  it('returns nothing when the overlay container is hidden', () => {
    expect(parseContactInfo(withOverlay(overlayHtml({ hidden: true })), url)).toEqual({});
  });

  it('the top card Contact info link alone is not an overlay', () => {
    expect(parseContactInfo(page(liveProfileHtml()), url)).toEqual({});
  });

  it('a non first degree overlay (profile link and a website only) yields just the website', () => {
    const doc = withOverlay(overlayHtml({ email: null, phone: null }));
    expect(parseContactInfo(doc, url)).toEqual({ website: 'https://snscratchpad.com' });
  });

  it('drops a phone over 40 characters, an empty one, and one that is really the next label', () => {
    expect(parseContactInfo(withOverlay(overlayHtml({ phone: '1'.repeat(41) })), url).phone).toBeUndefined();
    expect(parseContactInfo(withOverlay(overlayHtml({ phone: '1'.repeat(40) })), url).phone).toBe('1'.repeat(40));
    expect(parseContactInfo(withOverlay(overlayHtml({ phone: '   ' })), url).phone).toBeUndefined();
    expect(parseContactInfo(withOverlay(overlayHtml({ phone: 'Email' })), url).phone).toBeUndefined();
  });

  it('keeps a scheme when the visible website text has one, accepts Websites, and rejects other schemes', () => {
    const web = (text: string) => parseContactInfo(withOverlay(overlayHtml({ website: text })), url).website;
    expect(web('http://example.org/about (Personal)')).toBe('http://example.org/about');
    expect(web('example.org')).toBe('https://example.org');
    expect(web('javascript://alert(1)')).toBeUndefined();
    const plural = withOverlay(overlayHtml()).body.innerHTML.replace('<div>Website</div>', '<div>Websites</div>');
    expect(parseContactInfo(page(`<body>${plural}</body>`), url).website).toBe('https://snscratchpad.com');
  });

  it('ignores an overlay that names another profile (the SPA left the previous one behind)', () => {
    const doc = withOverlay(overlayHtml({ id: 'someone-else', name: 'Someone Else' }));
    expect(parseContactInfo(doc, url)).toEqual({});
    // Without an address bar to compare against, nothing is read.
    expect(parseContactInfo(doc)).toEqual({});
  });

  it('drops an email that does not look like one', () => {
    expect(parseContactInfo(withOverlay(overlayHtml({ email: 'not an email' })), url).email).toBeUndefined();
  });

  it('never throws on an empty document', () => {
    const empty = document.implementation.createHTMLDocument('');
    expect(parseContactInfo(empty, url)).toEqual({});
  });
});

describe('overlay gating', () => {
  const profileUrl = new URL('https://www.linkedin.com/in/satya-nadella/');

  it('reads nothing off the overlay path, even when a visible overlay is on the page', () => {
    const doc = withOverlay(overlayHtml());
    expect(parseContactInfo(doc, profileUrl)).toEqual({});
    expect(parseContactInfo(doc, new URL('https://www.linkedin.com/in/satya-nadella/details/experience/'))).toEqual({});
    expect(extractLinkedinProfile(doc, profileUrl)).toEqual({
      name: 'Satya Nadella',
      headline: 'Chairman and CEO at Microsoft',
      location: 'Redmond, Washington, United States',
    });
  });

  it('reads nothing when the path names another profile than the overlay, and accepts a location object and a missing trailing slash', () => {
    const doc = withOverlay(overlayHtml());
    expect(parseContactInfo(doc, new URL('https://www.linkedin.com/in/someone-else/overlay/contact-info/'))).toEqual({});
    expect(parseContactInfo(doc, { pathname: '/in/Satya-Nadella/overlay/contact-info' }).email).toBe('satya@example.com');
  });

  it('with two visible overlays the last in document order wins', () => {
    const early = overlayHtml({ email: 'early@example.com', phone: null, website: null });
    const doc = page(liveProfileHtml({ after: overlayHtml() }).replace('<main', early + '<main'));
    expect(parseContactInfo(doc, url).email).toBe('satya@example.com');
  });

  it('a fully transparent overlay is not visible, own or inherited opacity, on a document with a view', () => {
    for (const style of ['opacity:0', 'opacity:0;position:fixed;left:-9999px']) {
      document.documentElement.innerHTML = liveProfileHtml({ after: `<div style="${style}">${overlayHtml()}</div>` });
      expect(parseContactInfo(document, url), style).toEqual({});
    }
    document.documentElement.innerHTML = liveProfileHtml({ after: `<div style="opacity:0.9">${overlayHtml()}</div>` });
    expect(parseContactInfo(document, url).email).toBe('satya@example.com');
    document.documentElement.innerHTML = '<head></head><body></body>';
  });
});

describe('overlay values in the capture payload', () => {
  it('merges email, phone, and website into the profile', () => {
    const doc = withOverlay(overlayHtml());
    expect(extractLinkedinProfile(doc, url)).toMatchObject({
      name: 'Satya Nadella',
      headline: 'Chairman and CEO at Microsoft',
      location: 'Redmond, Washington, United States',
      email: 'satya@example.com',
      phone: '555 010 1234',
      website: 'https://snscratchpad.com',
    });
  });

  it('the overlay email wins over a page email, the page email stays when the overlay has none', () => {
    const ld = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Person', name: 'Satya Nadella', email: 'page@example.com' })}</script>`;
    const withLd = (overlay: string) => page(liveProfileHtml({ after: overlay }).replace('<head>', `<head>${ld}`));
    expect(extractLinkedinProfile(withLd(overlayHtml()), url).email).toBe('satya@example.com');
    expect(extractLinkedinProfile(withLd(overlayHtml({ email: null })), url).email).toBe('page@example.com');
    expect(extractLinkedinProfile(withLd(''), url).email).toBe('page@example.com');
  });

  it('with no overlay there is no phone key (or website key) at all', () => {
    const profile = extractLinkedinProfile(page(liveProfileHtml({ after: CAPTION_DIALOG + GHOST_OVERLAY })), url);
    expect('phone' in profile).toBe(false);
    expect('website' in profile).toBe(false);
    expect(Object.keys(profile).sort()).toEqual(['headline', 'location', 'name']);
  });

  it('a phone over 40 characters is not in the profile', () => {
    const profile = extractLinkedinProfile(withOverlay(overlayHtml({ phone: '9'.repeat(41) })), url);
    expect('phone' in profile).toBe(false);
  });

  it('reading never clicks, focuses, or navigates: the Contact info link is not touched', () => {
    const doc = withOverlay(overlayHtml());
    const link = doc.querySelector<HTMLAnchorElement>('a.djeContact')!;
    const onClick = vi.fn();
    link.addEventListener('click', onClick);
    link.addEventListener('focus', onClick);
    const before = location.href;
    extractLinkedinProfile(doc, url);
    parseContactInfo(doc, url);
    expect(onClick).not.toHaveBeenCalled();
    expect(location.href).toBe(before);
  });
});

describe('textLines', () => {
  it('prefers innerText when the environment has layout', () => {
    const el = document.createElement('div');
    el.innerHTML = '<span>ignored</span>';
    Object.defineProperty(el, 'innerText', { value: 'one\n\n  two  \r\nthree' });
    expect(textLines(el)).toEqual(['one', 'two', 'three']);
  });

  it('falls back to a block aware walk: blocks break lines, inline elements do not, hidden is skipped', () => {
    const el = document.createElement('div');
    el.innerHTML = '<div>Chairman <b>and</b> CEO</div><p>Redmond</p><span>a</span><span>b</span><div hidden>secret</div><br>last<script>x()</script>';
    expect(textLines(el)).toEqual(['Chairman and CEO', 'Redmond', 'ab', 'last']);
  });
});
