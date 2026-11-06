import {
  ACCEPTED_POST_SHAPES,
  isLinkedinPostUrl,
  isLnkdInShortUrl,
  isPostLink,
  parseLimit,
  withHttps,
} from '../../src/lib/leads';

describe('isLnkdInShortUrl', () => {
  it('accepts the documented short link shape', () => {
    for (const url of [
      'https://lnkd.in/aBc-12_3',
      'http://lnkd.in/abc',
      'https://www.lnkd.in/abc',
      'https://LNKD.IN/abc',
      'https://lnkd.in/abc/',
      'https://lnkd.in/abc?trk=share#section',
      `https://lnkd.in/${'a'.repeat(64)}`,
      '  https://lnkd.in/abc  ',
    ]) {
      expect(isLnkdInShortUrl(url), url).toBe(true);
    }
  });

  it('rejects other hosts, odd slugs, userinfo, ports, and links over 500 characters', () => {
    for (const url of [
      '',
      'lnkd.in/abc',
      'https://lnkd.in',
      'https://lnkd.in/',
      'https://evil.example/abc',
      'https://lnkd.in.evil.example/abc',
      'https://sub.lnkd.in/abc',
      `https://lnkd.in/${'a'.repeat(65)}`,
      'https://lnkd.in/ab$c',
      'https://lnkd.in/ab/cd',
      'https://user@lnkd.in/abc',
      'https://lnkd.in:8443/abc',
      'ftp://lnkd.in/abc',
      `https://lnkd.in/abc?${'a'.repeat(500)}`,
    ]) {
      expect(isLnkdInShortUrl(url), url).toBe(false);
    }
  });

  it('is not a post link by itself and still counts as a post link for the form', () => {
    expect(isLinkedinPostUrl('https://lnkd.in/abc')).toBe(false);
    expect(isPostLink('https://lnkd.in/abc')).toBe(true);
    expect(isPostLink('https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001')).toBe(true);
    expect(isPostLink('https://example.com/abc')).toBe(false);
  });
});

describe('withHttps', () => {
  it('prepends https to a schemeless linkedin.com or lnkd.in paste', () => {
    expect(withHttps('lnkd.in/aBc-12_3')).toBe('https://lnkd.in/aBc-12_3');
    expect(withHttps('www.lnkd.in/abc')).toBe('https://www.lnkd.in/abc');
    expect(withHttps('  lnkd.in/abc?x=1  ')).toBe('https://lnkd.in/abc?x=1');
    expect(withHttps('linkedin.com/posts/x')).toBe('https://linkedin.com/posts/x');
    expect(withHttps('www.linkedin.com/feed/update/urn:li:activity:1')).toBe('https://www.linkedin.com/feed/update/urn:li:activity:1');
  });

  it('leaves everything else as typed', () => {
    expect(withHttps('https://lnkd.in/abc')).toBe('https://lnkd.in/abc');
    expect(withHttps('http://lnkd.in/abc')).toBe('http://lnkd.in/abc');
    expect(withHttps('notlnkd.in/abc')).toBe('notlnkd.in/abc');
    expect(withHttps('lnkd.in.evil.example/abc')).toBe('lnkd.in.evil.example/abc');
    expect(withHttps('example.com/abc')).toBe('example.com/abc');
  });
});

describe('the accepted shapes line', () => {
  it('names the short link', () => {
    expect(ACCEPTED_POST_SHAPES).toContain('lnkd.in short link');
  });
});

describe('parseLimit', () => {
  it('reads whole numbers inside the range only', () => {
    expect(parseLimit('50', 500)).toBe(50);
    expect(parseLimit('0', 500)).toBeNull();
    expect(parseLimit('501', 500)).toBeNull();
    expect(parseLimit('1.5', 500)).toBeNull();
  });
});
