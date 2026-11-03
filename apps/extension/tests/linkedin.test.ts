// Fixtures are hand-built approximations of the real pages, not captured markup. LinkedIn changes its markup often,
// so the point of these tests is that a failing selector layer must degrade the result and never throw.
import { describe, expect, it } from 'vitest';
import { extractLinkedinProfile, findLinkedinNameAnchor, isProfilePath, parseTitle, parseTopCard } from '../src/extract/linkedin';
import { liveProfileHtml } from './linkedinFixtures';

function page(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}
const url = (path: string) => new URL(`https://www.linkedin.com${path}`);

describe('linkedin isProfilePath', () => {
  const cases: Array<[string, string | null]> = [
    ['/in/jane-doe', 'jane-doe'],
    ['/in/jane-doe/', 'jane-doe'],
    ['/in/Jane.Doe-1a2b3c/details/experience/', 'Jane.Doe-1a2b3c'],
    ['/in/j%C3%B6rg-m', 'jörg-m'],
    ['/in/', null],
    ['/in', null],
    ['/', null],
    ['/feed/', null],
    ['/company/acme', null],
    ['/school/acme', null],
    ['/pub/jane-doe/1/2/3', null],
    ['/jobs/view/123', null],
    ['/messaging/', null],
  ];
  it.each(cases)('%s -> %s', (path, expected) => {
    expect(isProfilePath(path)).toBe(expected);
  });
});

describe('extractLinkedinProfile', () => {
  it('reads JSON-LD Person first', () => {
    const doc = page(`<html><head>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'WebPage', name: 'ignore' },
          {
            '@type': 'Person',
            name: 'Jane Doe',
            jobTitle: ['Head of platform'],
            address: { addressLocality: 'Lisbon', addressCountry: 'PT' },
            worksFor: [{ '@type': 'Organization', name: 'Example Co' }],
            email: 'jane@example.com',
          },
        ],
      })}</script>
      <meta property="og:title" content="Other Name - Other title | LinkedIn"></head><body><h1>Heading Name</h1></body></html>`);
    expect(extractLinkedinProfile(doc, url('/in/jane-doe'))).toEqual({
      name: 'Jane Doe',
      headline: 'Head of platform',
      company: 'Example Co',
      location: 'Lisbon, PT',
      email: 'jane@example.com',
    });
  });

  it('drops a scraped email that does not look like one', () => {
    const doc = page(`<script type="application/ld+json">{"@type":"Person","name":"Jane Doe","email":"not an email"}</script>`);
    expect(extractLinkedinProfile(doc, url('/in/jane-doe'))).toEqual({ name: 'Jane Doe' });
  });

  it('falls back to og:title when there is no JSON-LD', () => {
    const doc = page(`<head><meta property="og:title" content="Jane Doe - Head of platform - Example Co | LinkedIn"></head><body></body>`);
    expect(extractLinkedinProfile(doc, url('/in/jane-doe'))).toEqual({ name: 'Jane Doe', headline: 'Head of platform - Example Co' });
  });

  it('reads an og:title with only a name', () => {
    const doc = page(`<head><meta property="og:title" content="(3) Jane Doe | LinkedIn"></head>`);
    expect(extractLinkedinProfile(doc, url('/in/jane-doe'))).toEqual({ name: 'Jane Doe' });
  });

  it('falls back to the page heading', () => {
    const doc = page(`<body><h1>
      Jane   Doe </h1></body>`);
    expect(extractLinkedinProfile(doc, url('/in/jane-doe'))).toEqual({ name: 'Jane Doe' });
  });

  it('skips malformed JSON-LD and keeps going', () => {
    const doc = page(`<head><script type="application/ld+json">{oops</script><meta property="og:title" content="Jane Doe | LinkedIn"></head>`);
    expect(extractLinkedinProfile(doc, url('/in/jane-doe')).name).toBe('Jane Doe');
  });

  it('floors to the id from the URL with dashes and dots as spaces', () => {
    expect(extractLinkedinProfile(page('<html></html>'), url('/in/jane-doe.smith'))).toEqual({ name: 'jane doe smith' });
  });

  it('never throws on an empty document', () => {
    const empty = document.implementation.createHTMLDocument('');
    expect(() => extractLinkedinProfile(empty, url('/in/x'))).not.toThrow();
    expect(extractLinkedinProfile(empty, url('/in/x')).name).toBe('x');
  });

  it('parseTitle ignores titles without the LinkedIn suffix', () => {
    expect(parseTitle('Jane Doe')).toEqual({});
  });
});

describe('signed in SPA structure (verified live, 2026-11)', () => {
  const live = new URL('https://www.linkedin.com/in/satya-nadella/');

  it('extracts name, headline, and location from the top card with no JSON-LD, og tags, or h1', () => {
    const doc = page(liveProfileHtml());
    expect(doc.querySelector('h1')).toBeNull();
    expect(doc.querySelector('script[type="application/ld+json"], meta[property^="og:"]')).toBeNull();
    expect(extractLinkedinProfile(doc, live)).toEqual({
      name: 'Satya Nadella',
      headline: 'Chairman and CEO at Microsoft',
      location: 'Redmond, Washington, United States',
    });
  });

  it('keeps the top card when it links mutual connections, because the Contact info link still names this profile', () => {
    const withMutual = liveProfileHtml().replace(
      'Contact info</a></div>',
      'Contact info</a></div><div class="djeMut"><a href="/in/ashwini-helper/">Ashwini is a mutual connection</a></div>',
    );
    expect(extractLinkedinProfile(page(withMutual), live)).toEqual({
      name: 'Satya Nadella',
      headline: 'Chairman and CEO at Microsoft',
      location: 'Redmond, Washington, United States',
    });
  });

  it('the anchor is the name h2 inside main, which sits inside a link', () => {
    const doc = page(liveProfileHtml());
    const anchor = findLinkedinNameAnchor(doc, live);
    expect(anchor?.tagName).toBe('H2');
    expect(anchor?.textContent).toBe('Satya Nadella');
    expect(anchor?.closest('a')).not.toBeNull();
    expect(anchor).toBe(doc.querySelector('main h2'));
  });

  it('does not take a later section title or a hidden ad heading as the name', () => {
    const profile = extractLinkedinProfile(page(liveProfileHtml({ title: 'Satya Nadella | LinkedIn' })), live);
    expect(profile.name).toBe('Satya Nadella');
  });

  it('prefers a heading the title corroborates over an earlier unrelated one', () => {
    const html = liveProfileHtml().replace('<main class="djeM1">', '<main class="djeM1"><h2 class="djeJunk">Messaging</h2>');
    const doc = page(html);
    const profile = extractLinkedinProfile(doc, live);
    expect(profile.name).toBe('Satya Nadella');
    expect(profile.headline).toBe('Chairman and CEO at Microsoft');
    expect(findLinkedinNameAnchor(doc, live)?.textContent).toBe('Satya Nadella');
  });

  it('without a corroborating title the first heading in main is the name', () => {
    const doc = page(liveProfileHtml({ title: 'LinkedIn' }));
    expect(extractLinkedinProfile(doc, live).name).toBe('Satya Nadella');
  });

  it('a rejected first heading is not a name and falls through to the title', () => {
    const html = liveProfileHtml({ name: 'Page not found', title: '(2) Satya Nadella | LinkedIn' });
    const doc = page(html);
    expect(extractLinkedinProfile(doc, live).name).toBe('Satya Nadella');
  });

  it('skips degree markers, counts, and the bare dot, and stops at Contact info', () => {
    const doc = page(liveProfileHtml());
    const heading = doc.querySelector('main h2')!;
    expect(parseTopCard(doc, heading)).toEqual({ headline: 'Chairman and CEO at Microsoft', location: 'Redmond, Washington, United States' });
  });

  it('a degree marker without the dot and a 1st or 3rd connection are skipped too', () => {
    for (const marker of ['2nd', '· 1st', '3rd', '·  3rd+']) {
      const html = liveProfileHtml().replace('· 2nd', marker);
      const doc = page(html);
      expect(parseTopCard(doc, doc.querySelector('main h2')!), marker).toEqual({
        headline: 'Chairman and CEO at Microsoft',
        location: 'Redmond, Washington, United States',
      });
    }
  });

  it('the location is the last remaining line, and counts filter by shape in any language', () => {
    const html = liveProfileHtml()
      .replace('<div class="djeLoc">', '<div>Acme</div><div class="djeLoc">')
      .replace('12,382,687 followers', '12 382 687 abonnés');
    const doc = page(html);
    expect(parseTopCard(doc, doc.querySelector('main h2')!)).toEqual({
      headline: 'Chairman and CEO at Microsoft',
      location: 'Redmond, Washington, United States',
    });
  });

  it('a headline that starts with an ordinal or a number is kept', () => {
    for (const headline of ['3rd year PhD student at MIT', '20 years of experience']) {
      const doc = page(liveProfileHtml().replace('Chairman and CEO at Microsoft', headline));
      expect(parseTopCard(doc, doc.querySelector('main h2')!).headline).toBe(headline);
    }
  });

  it('headline alone when the card has just one substantive line', () => {
    const html = liveProfileHtml().replace('<div class="djeLoc">Redmond, Washington, United States</div>', '');
    const doc = page(html);
    expect(parseTopCard(doc, doc.querySelector('main h2')!)).toEqual({ headline: 'Chairman and CEO at Microsoft' });
  });

  it('caps headline and location to the server limits', () => {
    const html = liveProfileHtml().replace('Chairman and CEO at Microsoft', 'H'.repeat(500)).replace('Redmond, Washington, United States', 'L'.repeat(500));
    const doc = page(html);
    const card = parseTopCard(doc, doc.querySelector('main h2')!);
    expect(card.headline).toHaveLength(200);
    expect(card.location).toHaveLength(200);
  });

  it('falls back to the heading third ancestor when the card has no Contact info link', () => {
    const doc = page(
      `<body><main><div class="a"><div class="b"><div class="c"><h2>Jane Doe</h2><div>Staff engineer</div><div>Lisbon</div></div></div></div></main></body>`,
    );
    expect(parseTopCard(doc, doc.querySelector('h2')!)).toEqual({ headline: 'Staff engineer', location: 'Lisbon' });
  });

  it('never climbs to the body in the fallback and never throws', () => {
    const doc = page('<body><main><h2>Jane Doe</h2></main></body>');
    expect(parseTopCard(doc, doc.querySelector('h2')!)).toEqual({});
  });

  it('uses innerText lines when the environment provides them', () => {
    const doc = page(liveProfileHtml());
    const card = doc.querySelector('.djeCard')!;
    Object.defineProperty(card, 'innerText', { value: 'Satya Nadella\n· 2nd\nCEO of Everything\nMars\n·\nContact info\nIgnored' });
    expect(parseTopCard(doc, doc.querySelector('main h2')!)).toEqual({ headline: 'CEO of Everything', location: 'Mars' });
  });

  it('does not read the top card on a stale head: the capture degrades to the floor', () => {
    const html = liveProfileHtml().replace('<head>', '<head><meta property="og:url" content="https://www.linkedin.com/in/someone-else">');
    expect(extractLinkedinProfile(page(html), live)).toEqual({ name: 'satya nadella' });
  });
});

describe('document.title layer', () => {
  const jane = new URL('https://www.linkedin.com/in/jane-doe');
  const titled = (title: string, body = '<body></body>') => page(`<head><title>${title}</title></head>${body}`);

  it('strips a leading notification count and the LinkedIn suffix', () => {
    expect(extractLinkedinProfile(titled('(3) Jane Doe | LinkedIn'), jane)).toEqual({ name: 'Jane Doe' });
    expect(extractLinkedinProfile(titled('(120) Jane Doe | LinkedIn'), jane)).toEqual({ name: 'Jane Doe' });
    expect(extractLinkedinProfile(titled('(99+) Jane Doe | LinkedIn'), jane)).toEqual({ name: 'Jane Doe' });
    expect(extractLinkedinProfile(titled('Jane Doe | LinkedIn'), jane)).toEqual({ name: 'Jane Doe' });
  });

  it('a title without the suffix gives nothing', () => {
    expect(extractLinkedinProfile(titled('Jane Doe'), jane).name).toBe('jane doe');
    expect(extractLinkedinProfile(titled('(3) Jane Doe'), jane).name).toBe('jane doe');
  });

  it('rejects interstitial titles', () => {
    for (const title of ['Profile Not Found | LinkedIn', '(1) Page not found | LinkedIn', 'Sign Up | LinkedIn']) {
      expect(extractLinkedinProfile(titled(title), jane).name, title).toBe('jane doe');
    }
  });

  it('ranks below the h1 and the top card heading', () => {
    expect(extractLinkedinProfile(titled('Other Person | LinkedIn', '<body><h1>Jane Doe</h1></body>'), jane).name).toBe('Jane Doe');
    expect(extractLinkedinProfile(titled('LinkedIn', '<body><main><h2>Jane Doe</h2></main></body>'), jane).name).toBe('Jane Doe');
    // A title name that no heading in main matches wins over a heading that is not the person (a subpage section title).
    expect(extractLinkedinProfile(titled('Other Person | LinkedIn', '<body><main><h2>Jane Doe</h2></main></body>'), jane).name).toBe('Other Person');
  });

  it('is never split on a spaced hyphen, while og:title keeps the Name - Headline split', () => {
    expect(extractLinkedinProfile(titled('Jean - Luc Picard | LinkedIn', '<body></body>'), jane)).toEqual({ name: 'Jean - Luc Picard' });
  });
});
