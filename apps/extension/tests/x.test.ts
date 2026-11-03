// Fixtures are hand-built approximations of the real pages, not captured markup. X changes its markup often,
// so the point of these tests is that a failing selector layer must degrade the result and never throw.
import { describe, expect, it } from 'vitest';
import { extractXProfile, isProfileView, isProfilePath } from '../src/extract/x';

function page(html: string, title = ''): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.title = title;
  return doc;
}
const url = (path: string) => new URL(`https://x.com${path}`);

describe('x isProfilePath', () => {
  const accept: Array<[string, string]> = [
    ['/jack', 'jack'],
    ['/jack/', 'jack'],
    ['/Jack_Dorsey', 'Jack_Dorsey'],
    ['/a', 'a'],
    ['/abcdefghijklmno', 'abcdefghijklmno'],
    ['/user_1/with_replies', 'user_1'],
    ['/user_1/status/123', 'user_1'],
    ['/homepage', 'homepage'],
    ['/sharer', 'sharer'],
  ];
  it.each(accept)('accepts %s', (path, handle) => expect(isProfilePath(path)).toBe(handle));

  const reject = [
    '/',
    '',
    '/abcdefghijklmnop',
    '/bad-handle',
    '/with.dot',
    '/%40jack',
    ...['home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i', 'compose', 'intent', 'login', 'signup', 'about', 'tos', 'privacy', 'jobs', 'hashtag', 'share', 'download'].map((s) => `/${s}`),
    '/Home',
    '/EXPLORE/tabs',
    '/i/flow/login',
  ];
  it.each(reject)('rejects %s', (path) => expect(isProfilePath(path)).toBeNull());
});

describe('x isProfileView', () => {
  it.each([
    ['/jack', 'jack'],
    ['/jack/with_replies', 'jack'],
    ['/jack/media', 'jack'],
    ['/jack/status/1', null],
    ['/jack/followers', null],
    ['/home', null],
  ])('%s -> %s', (path, expected) => expect(isProfileView(path)).toBe(expected));
});

describe('extractXProfile', () => {
  it('reads the profile header test ids', () => {
    const doc = page(
      `<div data-testid="UserName"><div><span><span>Jane Doe</span></span></div><div><span>@jane_doe</span></div><span>Follows you</span></div>
       <div data-testid="UserDescription"><span>Builds   tools</span> <span>for teams.</span></div>
       <div data-testid="UserProfileHeader_Items">
         <span data-testid="UserLocation"><span>Lisbon, Portugal</span></span>
         <a data-testid="UserUrl" href="https://t.co/x"><span>example.com</span></a>
         <span data-testid="UserJoinDate">Joined March 2012</span>
       </div>`,
      'Someone Else (@other) / X',
    );
    expect(extractXProfile(doc, url('/Jane_Doe'))).toEqual({
      name: 'Jane Doe',
      handle: 'jane_doe',
      bio: 'Builds tools for teams.',
      location: 'Lisbon, Portugal',
      website: 'example.com',
    });
  });

  it('takes the first plain text item as the location when there is no location test id', () => {
    const doc = page(
      `<div data-testid="UserName"><span>Jane Doe</span><span>@jane</span></div>
       <div data-testid="UserProfileHeader_Items"><span>Berlin</span><a data-testid="UserUrl"><span>example.com</span></a><span data-testid="UserJoinDate">Joined May 2020</span></div>`,
    );
    expect(extractXProfile(doc, url('/jane'))).toMatchObject({ location: 'Berlin', website: 'example.com' });
  });

  it('floors to the path handle and the document title', () => {
    expect(extractXProfile(page('', '(2) Jane Doe (@jane) / X'), url('/jane'))).toEqual({ name: 'Jane Doe', handle: 'jane' });
  });

  it('tolerates a leading notification count of any size in the title', () => {
    expect(extractXProfile(page('', '(1) Satya Nadella (@satyanadella) / X'), url('/satyanadella'))).toEqual({ name: 'Satya Nadella', handle: 'satyanadella' });
    expect(extractXProfile(page('', '(20+) Jane Doe (@jane) / X'), url('/jane')).name).toBe('Jane Doe');
    expect(extractXProfile(page('', '(1,204) Jane Doe (@jane) / X'), url('/jane')).name).toBe('Jane Doe');
    expect(extractXProfile(page('', '(12) Jane Doe (@jane) / X'), url('/jane')).name).toBe('Jane Doe');
    expect(extractXProfile(page('', '(1) Satya Nadella (@satyanadella) / X'), url('/other')).name).toBe('other');
  });

  it('floors the name to the handle when the title has no match', () => {
    expect(extractXProfile(page('', 'X'), url('/jane'))).toEqual({ name: 'jane', handle: 'jane' });
  });

  it('never throws on an empty document', () => {
    const empty = document.implementation.createHTMLDocument('');
    expect(() => extractXProfile(empty, url('/jane'))).not.toThrow();
    expect(extractXProfile(empty, url('/jane'))).toEqual({ name: 'jane', handle: 'jane' });
  });
});
