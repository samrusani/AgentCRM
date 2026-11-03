// Shared fixtures for the LinkedIn tests, built from the structure verified live on the signed in SPA (2026-11):
// no JSON-LD, no og tags, no h1, obfuscated class names, the name as the first heading inside main (an h2 wrapped
// in a link), and a contact info overlay that is a plain div among other hidden dialogs.
import { vi } from 'vitest';

export interface LiveOptions {
  title?: string;
  name?: string;
  /** Extra markup appended to the body after main (overlay, noise). */
  after?: string;
}

/** The signed in profile page. The top card text lines are: name, degree marker, followers, headline, location, connections, dot, Contact info. */
export function liveProfileHtml(options: LiveOptions = {}): string {
  const name = options.name ?? 'Satya Nadella';
  const title = options.title ?? `(3) ${name} | LinkedIn`;
  return `<html><head><title>${title}</title></head><body>
    <div class="aXk2Qw">
      <nav class="djeNav"><ul><li>Home</li><li>Network</li></ul></nav>
      <main class="djeM1">
        <section class="djeS1">
          <div class="djeCard">
            <div class="djeRow"><a class="djeLink" href="/in/satya-nadella/"><h2 class="djeH9">${name}</h2></a></div>
            <div class="djeDeg">· 2nd</div>
            <div class="djeCnt">12,382,687 followers</div>
            <div class="djeHl">Chairman and CEO at Microsoft</div>
            <div class="djeLoc">Redmond, Washington, United States</div>
            <div class="djeCx">500+ connections</div>
            <div class="djeDot">·</div>
            <div><a class="djeContact" href="/in/satya-nadella/overlay/contact-info/">Contact info</a></div>
          </div>
        </section>
        <section class="djeS2"><h2 class="djeT">About</h2><div>Some about text</div></section>
        <section class="djeS3"><h2 class="djeT">Featured</h2></section>
        <section class="djeS4"><h2 class="djeT">Activity</h2></section>
      </main>
      <div class="djeAds" hidden><h2>Promoted</h2></div>
    </div>
    ${options.after ?? ''}
  </body></html>`;
}

export interface OverlayOptions {
  id?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  /** Mark the whole overlay hidden (zero sized) to prove visibility decides. */
  hidden?: boolean;
}

/** A hidden dialog like the video caption settings one: role=dialog exists on the page for dialogs that are not the overlay. */
export const CAPTION_DIALOG = `<div class="djeCap" role="dialog" aria-label="Caption settings" data-hidden="true"><h2>Caption settings</h2><div>Font size</div></div>`;

/** A hidden container that even carries a "Contact info" heading and an address; it must never be read. */
export const GHOST_OVERLAY = `<div class="djeGhost" role="dialog" data-hidden="true"><h2>Contact info</h2><div>Ghost Person's profile</div><div>linkedin.com/in/ghost-person</div><div>Email</div><a href="mailto:ghost@example.com">ghost@example.com</a><div>Phone</div><div>999 999 9999 (Mobile)</div></div>`;

/** The contact info overlay as a div with an h2, with the body sections a first degree connection shows. */
export function overlayHtml(options: OverlayOptions = {}): string {
  const id = options.id ?? 'satya-nadella';
  const name = options.name ?? 'Satya Nadella';
  const email = options.email === undefined ? 'satya@example.com?subject=Hello&body=Hi' : options.email;
  const phone = options.phone === undefined ? '555 010 1234 (Mobile)' : options.phone;
  const website = options.website === undefined ? 'snscratchpad.com (Company)' : options.website;
  const hidden = options.hidden ? ' data-hidden="true"' : '';
  return `<div class="djeOverlay"${hidden}>
    <div class="djeOHead"><h2 class="djeOT">Contact info</h2><button aria-label="Dismiss"></button></div>
    <div class="djeOBody">
      <div>${name}'s profile</div>
      <div><a href="https://www.linkedin.com/in/${id}">linkedin.com/in/${id}</a></div>
      ${website === null ? '' : `<div>Website</div><div><a href="https://www.linkedin.com/safety/go?url=https%3A%2F%2Fredirect.invalid">${website}</a></div>`}
      ${phone === null ? '' : `<div>Phone</div><div>${phone}</div>`}
      ${email === null ? '' : `<div>Email</div><div><a href="mailto:${email}">${email.split('?')[0]}</a></div>`}
      <div>Connected</div><div>March 3, 2020</div>
    </div>
  </div>`;
}

/**
 * jsdom has no layout, so every rect is empty. This gives anything outside a [data-hidden] subtree a real size,
 * which is what the overlay finder uses to tell a visible container from a hidden one. Returns the restore function.
 */
export function stubLayout(): () => void {
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const empty = this.closest('[data-hidden]') !== null || this.closest('[hidden]') !== null;
    const size = empty ? 0 : 100;
    return { x: 0, y: 0, left: 0, top: 0, right: size, bottom: size, width: size, height: size, toJSON: () => ({}) } as DOMRect;
  });
  return () => spy.mockRestore();
}
