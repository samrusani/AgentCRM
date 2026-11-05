import { domainHref, profileHref, profilePath } from '../../src/lib/links';

describe('profilePath', () => {
  it('shortens a LinkedIn person URL to the path form', () => {
    expect(profilePath('https://www.linkedin.com/in/jane-doe')).toBe('/in/jane-doe');
  });

  it('shortens a company URL and drops a trailing slash, query, and fragment', () => {
    expect(profilePath('https://linkedin.com/company/acme/?trk=x#top')).toBe('/company/acme');
  });

  it('reads a URL saved without a scheme', () => {
    expect(profilePath('linkedin.com/company/acme')).toBe('/company/acme');
  });

  it('shortens an X profile URL', () => {
    expect(profilePath('https://x.com/janedoe')).toBe('/janedoe');
  });

  it('returns the stored text when there is no path to show', () => {
    expect(profilePath('https://linkedin.com')).toBe('https://linkedin.com');
    expect(profilePath('not a url at all')).toBe('not a url at all');
  });

  it('returns an empty string for an empty value', () => {
    expect(profilePath(null)).toBe('');
    expect(profilePath('')).toBe('');
  });
});

describe('profileHref', () => {
  it('keeps an https URL', () => {
    expect(profileHref('https://www.linkedin.com/in/jane-doe')).toBe('https://www.linkedin.com/in/jane-doe');
  });

  it('adds https to a URL saved without a scheme', () => {
    expect(profileHref('linkedin.com/company/acme')).toBe('https://linkedin.com/company/acme');
  });

  it('refuses a link that is not http or https', () => {
    expect(profileHref('javascript:alert(1)')).toBeNull();
    expect(profileHref('')).toBeNull();
    expect(profileHref(null)).toBeNull();
  });
});

describe('domainHref', () => {
  it('links a stored domain over https', () => {
    expect(domainHref('acme.example.com')).toBe('https://acme.example.com');
  });

  it('trims surrounding space but refuses a stored scheme, path, or query outright', () => {
    expect(domainHref(' acme.example.com ')).toBe('https://acme.example.com');
    expect(domainHref('http://acme.example.com')).toBeNull();
    expect(domainHref('acme.example.com/about')).toBeNull();
    expect(domainHref('acme.example.com?x=1')).toBeNull();
  });

  it('refuses text that is not a bare host with a letter', () => {
    expect(domainHref('not a domain')).toBeNull();
    expect(domainHref('javascript:alert(1)')).toBeNull();
    expect(domainHref('127.1')).toBeNull();
    expect(domainHref(null)).toBeNull();
    expect(domainHref('')).toBeNull();
  });
});
