// Adversarial probes for the saved views URL builder. KILLS / CONFIRMS / ACCEPTED as in the server probes.
import { describe, expect, it } from 'vitest';
import { peopleConfig, pipelineConfig, viewUrl } from '../src/lib/views';

const parse = (url: string) => new URL(url, 'http://localhost');

describe('viewUrl', () => {
  it('KILLS: keys outside the screen whitelist never reach the URL, including other screens keys and prototype names', () => {
    const url = viewUrl('leads', { q: 'a', person: 'per_1', import: 'csv', opportunity: 'o', pipeline: 'p', status: 'open', constructor: 'x', __proto__: 'y', toString: 'z' });
    expect([...parse(url).searchParams.keys()]).toEqual(['q']);
    expect([...parse(viewUrl('pipeline', { q: 'a', tab: 'people', view: 'table' })).searchParams.keys()]).toEqual(['view']);
  });
  it('KILLS: bad values are dropped (sort name, view kanban, q 257, non strings, empty ids, 65 char ids)', () => {
    expect(viewUrl('leads', { sort: 'name', tab: 'x', q: 'x'.repeat(257), list: '' })).toBe('/leads');
    expect(viewUrl('leads', { list: 'x'.repeat(65), q: { a: 1 } })).toBe('/leads');
    expect(viewUrl('pipeline', { view: 'kanban', status: 'won', pipeline: ['a'] })).toBe('/pipeline');
  });
  it('KILLS: q with &, #, ?, %, newline, quotes, and unicode round trips as exactly one parameter', () => {
    for (const q of ['a&person=per_1', 'a#frag', 'a?b=c', '100%', '%00%0a', 'l1\nl2', "o'rei\"lly", 'zürich 🇨🇭 日本', 'x'.repeat(256), 'a b+c']) {
      const url = viewUrl('relationships', { q });
      expect(url.startsWith('/relationships?q=')).toBe(true);
      expect(url).not.toMatch(/[#\s]/);
      const parsed = parse(url);
      expect([...parsed.searchParams.keys()]).toEqual(['q']);
      expect(parsed.searchParams.get('q')).toBe(q);
      expect(parsed.hash).toBe('');
      expect(parsed.pathname).toBe('/relationships');
    }
  });
  it('KILLS: a list id with hostile characters stays inside its own parameter', () => {
    const parsed = parse(viewUrl('leads', { list: 'l&import=csv#x?y=1' }));
    expect([...parsed.searchParams.keys()]).toEqual(['list']);
    expect(parsed.searchParams.get('list')).toBe('l&import=csv#x?y=1');
  });
  it('KILLS: the path is fixed per screen; a config cannot redirect elsewhere', () => {
    expect(parse(viewUrl('leads', { path: '//evil.com' })).pathname).toBe('/leads');
  });
});

describe('config builders', () => {
  it('KILLS: a q over 256 is cut to 256 on save and a whitespace q is dropped', () => {
    const base = { tab: 'people' as const, list: null, sort: 'default' as const };
    expect(peopleConfig({ ...base, q: `  ${'x'.repeat(300)}` }).q).toHaveLength(256);
    expect(peopleConfig({ ...base, q: '   ' })).toEqual({});
  });
  it('KILLS: pipeline config drops junk status and view values', () => {
    expect(pipelineConfig({ pipeline: null, status: 'junk', view: 'kanban' })).toEqual({});
  });
  it('ACCEPTED: the 256 cut can split a surrogate pair (slice by UTF-16 unit); the stored q is still valid for the server (max counts the same units)', () => {
    const base = { tab: 'people' as const, list: null, sort: 'default' as const };
    expect(peopleConfig({ ...base, q: '😀'.repeat(200) }).q).toHaveLength(256);
  });
});
