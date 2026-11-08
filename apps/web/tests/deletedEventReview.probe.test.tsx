// Adversarial review probes for the record_deleted wave (web). KILLS: attack failed, safe behavior pinned.
// The open-sheet CONFIRMS was fixed (inactive entries removed, active ones invalidated) and flipped to KILLS.
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { handleServerEvent, useServerEvents } from '../src/api/events';
import { OrganizationSheet, PersonSheet } from '../src/screens/RecordSheets';
import { Router } from './helpers';

vi.mock('../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ui')>()),
  useUI: () => ({ theme: 'system', setTheme: () => {}, setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
}));

const SENTENCE = 'This record was deleted, usually because it was merged into another record.';
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let gone = false;
let detailGets: string[] = [];

function personBody(id: string) {
  return {
    id, version: 1, lifecycle: 'lead', firstName: 'Lena', lastName: 'Example', email: null, title: null, organizationId: null,
    organizationName: null, location: null, tags: [], nextActionAt: null, claims: [], activities: [], tasks: [], opportunities: [],
    organization: null, createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00',
  };
}
function orgBody(id: string) {
  return {
    id, version: 1, name: 'Acme', kind: 'company', domain: null, location: null, linkedinUrl: null, tags: [], claims: [], people: [],
    opportunities: [], activities: [], tasks: [], createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00',
  };
}

beforeEach(() => {
  gone = false;
  detailGets = [];
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let m = url.pathname.match(/^\/api\/people\/([^/]+)$/);
      if (m) {
        detailGets.push(url.pathname);
        return gone ? json(404, { error: { code: 'not_found', message: 'Not found.' } }) : json(200, personBody(m[1]));
      }
      m = url.pathname.match(/^\/api\/organizations\/([^/]+)$/);
      if (m) {
        detailGets.push(url.pathname);
        return gone ? json(404, { error: { code: 'not_found', message: 'Not found.' } }) : json(200, orgBody(m[1]));
      }
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      return json(200, { items: [], nextCursor: null });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  listeners = new Map<string, Array<(m: MessageEvent<string>) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: (m: MessageEvent<string>) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close() {}
  dispatch(name: string, data: string) {
    for (const l of this.listeners.get(name) ?? []) l({ data } as MessageEvent<string>);
  }
}
function Events() {
  useServerEvents();
  return null;
}
function mount(kind: 'person' | 'organization') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <Events />
        {kind === 'person' ? (
          <PersonSheet id="per_x" onClose={() => {}} onOpenOrganization={() => {}} />
        ) : (
          <OrganizationSheet id="org_x" onClose={() => {}} onOpenPerson={() => {}} />
        )}
      </Router>
    </QueryClientProvider>,
  );
  return client;
}

describe.each([
  ['person', 'per_x'],
  ['organization', 'org_x'],
] as const)('active %s sheet when its record is deleted', (kind, id) => {
  it('KILLS: record_deleted event on an OPEN sheet ends in the deleted state with exactly one extra detail GET', async () => {
    const client = mount(kind);
    await waitFor(() => expect(detailGets.length).toBe(1));
    await screen.findByText(kind === 'person' ? /Lena/ : /Acme/, undefined, { timeout: 2000 }).catch(() => undefined);
    gone = true;
    act(() =>
      FakeEventSource.instances[0]!.dispatch('record_deleted', JSON.stringify({ type: 'record_deleted', entityType: kind, entityId: id })),
    );
    // Wait long enough for any refetch to land.
    await new Promise((r) => setTimeout(r, 400));
    const shown = screen.queryByText(SENTENCE) !== null;
    console.log(`[probe] ${kind}: deleted state shown after event = ${shown}; detail GETs = ${detailGets.length}; cache has query = ${client.getQueryCache().find({ queryKey: [kind, id] }) !== undefined}`);
    // KILLS: only inactive entries are removed; the active query is invalidated instead, so the mounted observer
    // refetches once, gets the honest 404, and the open sheet shows the deleted state.
    expect(detailGets.length).toBe(2);
    expect(shown).toBe(true);
  });

  it('control: invalidation alone (no removal) on the same open sheet DOES refetch once and reach the deleted state', async () => {
    const client = mount(kind);
    await waitFor(() => expect(detailGets.length).toBe(1));
    await screen.findByText(kind === 'person' ? /Lena/ : /Acme/, undefined, { timeout: 2000 }).catch(() => undefined);
    gone = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: [kind, id] });
    });
    expect(await screen.findByText(SENTENCE)).toBeInTheDocument();
    expect(detailGets.length).toBe(2);
  });
});

describe('handleServerEvent', () => {
  function seeded() {
    const c = new QueryClient();
    for (const key of [['person', 'a'], ['person', 'b'], ['enrichment', 'a'], ['enrichment', 'b'], ['enrichment', 'organization', 'o1'], ['enrichment', 'organization', 'o2'], ['organization', 'o1'], ['organization', 'o2'], ['person', 'a', 'extra'], ['people', 'list'], ['organizations', 'q', 'all'], ['duplicates'], ['duplicates', 'organizations']]) {
      c.setQueryData(key, { k: key.join('/') });
    }
    return c;
  }
  const has = (c: QueryClient, key: unknown[]) => c.getQueryData(key) !== undefined;

  it('KILLS: person removal hits only that id (detail, enrichment, sub-keys); lists and others survive and are invalidated', () => {
    const c = seeded();
    handleServerEvent(c, 'record_deleted', { entityType: 'person', entityId: 'a' });
    expect(has(c, ['person', 'a'])).toBe(false);
    expect(has(c, ['person', 'a', 'extra'])).toBe(false);
    expect(has(c, ['enrichment', 'a'])).toBe(false);
    for (const k of [['person', 'b'], ['enrichment', 'b'], ['enrichment', 'organization', 'o1'], ['organization', 'o1'], ['people', 'list'], ['organizations', 'q', 'all']]) expect(has(c, k)).toBe(true);
    expect(c.getQueryState(['people', 'list'])?.isInvalidated).toBe(true);
    expect(c.getQueryState(['organizations', 'q', 'all'])?.isInvalidated).toBe(true);
    expect(c.getQueryState(['duplicates'])?.isInvalidated).toBe(true);
    expect(c.getQueryState(['duplicates', 'organizations'])?.isInvalidated).toBe(true);
  });

  it('KILLS: organization removal hits org detail and org enrichment only', () => {
    const c = seeded();
    handleServerEvent(c, 'record_deleted', { entityType: 'organization', entityId: 'o1' });
    expect(has(c, ['organization', 'o1'])).toBe(false);
    expect(has(c, ['enrichment', 'organization', 'o1'])).toBe(false);
    for (const k of [['organization', 'o2'], ['enrichment', 'organization', 'o2'], ['person', 'a'], ['enrichment', 'a']]) expect(has(c, k)).toBe(true);
  });

  it('ACCEPTED: a person id equal to the literal "organization" would prefix-collide with org enrichment caches (ids are server prefixed, unreachable)', () => {
    const c = seeded();
    handleServerEvent(c, 'record_deleted', { entityType: 'person', entityId: 'organization' });
    // removeQueries(['enrichment','organization']) would prefix-match org enrichment caches.
    expect(has(c, ['enrichment', 'organization', 'o1'])).toBe(false);
  });

  it.each([
    ['undefined', undefined], ['null', null], ['string', 'x'], ['number', 5], ['array', []],
    ['no entityType', { entityId: 'a' }], ['workspace', { entityType: 'workspace', entityId: 'a' }],
    ['empty id', { entityType: 'person', entityId: '' }], ['id object', { entityType: 'person', entityId: { a: 1 } }],
    ['id array', { entityType: 'person', entityId: ['a'] }], ['unknown type', { entityType: 'opportunity', entityId: 'a' }],
  ])('KILLS: malformed payload %s removes nothing, still invalidates, never throws', (_label, data) => {
    const c = seeded();
    expect(() => handleServerEvent(c, 'record_deleted', data)).not.toThrow();
    for (const k of [['person', 'a'], ['person', 'b'], ['organization', 'o1'], ['enrichment', 'a']]) expect(has(c, k)).toBe(true);
    expect(c.getQueryState(['duplicates'])?.isInvalidated).toBe(true);
    expect(c.getQueryState(['person', 'a'])?.isInvalidated).toBe(true);
  });

  it('KILLS: record_updated (and other events) never remove caches', () => {
    const c = seeded();
    handleServerEvent(c, 'record_updated', { entityType: 'person', entityId: 'a' });
    handleServerEvent(c, 'followup_updated', { entityType: 'person', entityId: 'a' });
    expect(has(c, ['person', 'a'])).toBe(true);
    expect(c.getQueryState(['duplicates'])?.isInvalidated).toBe(false);
  });

  it('KILLS: unnamed-message path also passes the payload (type field) and removes', () => {
    const c = seeded();
    const client = c;
    const Wrap = () => {
      useServerEvents();
      return null;
    };
    render(<QueryClientProvider client={client}><Wrap /></QueryClientProvider>);
    FakeEventSource.instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'record_deleted', entityType: 'person', entityId: 'a' }) } as MessageEvent<string>);
    expect(has(client, ['person', 'a'])).toBe(false);
  });

  it('KILLS: record_deleted keys equal record_updated keys + duplicates, as sets, at runtime and by source', () => {
    // Runtime: probe through invalidation on a client seeded with one key per name in the two lists.
    const source = readFileSync(path.join(__dirname, '..', 'src', 'api', 'events.ts'), 'utf8');
    const block = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    const updated = [...block('record_updated: [', '],').matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    // MAIL_KEYS spread is opaque to the regex; compare the invalidation behavior instead.
    const probeKeys = [...new Set([...updated, 'duplicates', 'today', 'nonexistent-key', 'followup-rules', 'send-intents'])];
    const touched = (name: 'record_updated' | 'record_deleted') => {
      const c = new QueryClient();
      for (const k of probeKeys) c.setQueryData([k], 1);
      handleServerEvent(c, name, { entityType: 'x', entityId: 'y' });
      return probeKeys.filter((k) => c.getQueryState([k])?.isInvalidated).sort();
    };
    const u = touched('record_updated');
    const d = touched('record_deleted');
    expect(d).toEqual([...new Set([...u, 'duplicates'])].sort());
    expect(u).not.toContain('duplicates');
  });
});
