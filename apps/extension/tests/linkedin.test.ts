// Fixtures are hand-built approximations of the real pages, not captured markup. LinkedIn changes its markup often,
// so the point of these tests is that a failing selector layer must degrade the result and never throw.
import { describe, expect, it } from 'vitest';
import { extractLinkedinProfile, isProfilePath, parseTitle } from '../src/extract/linkedin';

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
