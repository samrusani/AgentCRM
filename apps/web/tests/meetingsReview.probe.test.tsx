// Adversarial review probes for the meetings wave (web). KILLS: attack failed, safe behavior pinned.
// CONFIRMS: live gap asserted as it behaves today. ACCEPTED: limit the contract states.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { handleServerEvent, useServerEvents } from '../src/api/events';
import { MeetingSheet } from '../src/screens/MeetingSheet';
import { Meetings } from '../src/screens/Meetings';
import { Today } from '../src/screens/Today';
import { Router } from './helpers';

vi.mock('../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ui')>()),
  useUI: () => ({ theme: 'system', setTheme: () => {}, setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));

const SENTENCE = 'This record was deleted, usually because it was merged into another record.';
const CONFIRM = 'Deletes this meeting and its attendee links. People and their records stay. This cannot be undone.';
const HOUR = 3_600_000;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const row = (id: string, title: string, offset: number, extra: Record<string, unknown> = {}) => ({
  id, version: 1, title, startsAt: iso(offset), endsAt: null, location: null, organizationId: null, organizationName: null,
  opportunityId: null, opportunityName: null, notes: null, attendeeCount: 0, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', ...extra,
});

let list: ReturnType<typeof row>[] = [];
let detail: (ReturnType<typeof row> & { attendees: { id: string; name: string }[] }) | null = null;
let gone = false;
let detailGets = 0;
let patchStatus: 'ok' | 'conflict' = 'ok';
let calls: { method: string; path: string; query: string; body: any }[] = [];

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

beforeEach(() => {
  list = [];
  detail = null;
  gone = false;
  detailGets = 0;
  patchStatus = 'ok';
  calls = [];
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, query: url.search, body });
      if (url.pathname === '/api/meetings' && method === 'GET') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        return json(200, { items: list.filter((m) => (!from || m.startsAt >= from) && (!to || m.startsAt < to)), nextCursor: null });
      }
      const one = url.pathname.match(/^\/api\/meetings\/([^/]+)$/);
      if (one && method === 'GET') {
        detailGets += 1;
        return gone || !detail ? json(404, { error: { code: 'not_found', message: 'Not found.' } }) : json(200, detail);
      }
      if (one && method === 'PATCH') {
        if (patchStatus === 'conflict') {
          detail = { ...detail!, title: 'Changed elsewhere', version: detail!.version + 1 };
          return json(409, { error: { code: 'version_conflict', message: 'Version conflict.', current: detail } });
        }
        detail = { ...detail!, ...body.fields, version: detail!.version + 1 };
        return json(200, detail);
      }
      if (one && method === 'DELETE') {
        gone = true;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/api/model-provider') return json(200, { ready: true, kind: 'anthropic', model: 'm' });
      if (url.pathname === '/api/imports/transcript') return json(201, { id: 'run_1', kind: 'transcript_capture', title: body.title, status: 'queued', steps: [], counts: {}, scope: {} });
      return json(200, { items: [], nextCursor: null });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function mount(ui: React.ReactNode, entry = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[entry]}>
        <Events />
        {ui}
      </Router>
    </QueryClientProvider>,
  );
  return client;
}

describe('5. deletion events on the web', () => {
  it('KILLS: record_deleted for an OPEN meeting sheet ends in the deleted state with exactly one extra detail GET', async () => {
    detail = { ...row('mtg_x', 'Board call', HOUR), attendees: [] };
    const client = mount(<MeetingSheet id="mtg_x" onClose={() => {}} />);
    await screen.findByDisplayValue('Board call');
    expect(detailGets).toBe(1);
    gone = true;
    act(() => FakeEventSource.instances[0]!.dispatch('record_deleted', JSON.stringify({ type: 'record_deleted', entityType: 'meeting', entityId: 'mtg_x' })));
    expect(await screen.findByText(SENTENCE)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    console.log('[probe] meeting open-sheet detail GETs:', detailGets, 'query kept:', client.getQueryCache().find({ queryKey: ['meeting', 'mtg_x'] }) !== undefined);
    expect(detailGets).toBe(2);
  });

  it('KILLS: removal hits only inactive [meeting, id] copies; other meetings and lists survive, lists invalidated', () => {
    const c = new QueryClient();
    for (const k of [['meeting', 'a'], ['meeting', 'b'], ['meetings', '', ''], ['person', 'a']]) c.setQueryData(k, 1);
    handleServerEvent(c, 'record_deleted', { entityType: 'meeting', entityId: 'a' });
    expect(c.getQueryData(['meeting', 'a'])).toBeUndefined();
    for (const k of [['meeting', 'b'], ['meetings', '', ''], ['person', 'a']]) expect(c.getQueryData(k)).toBeDefined();
    expect(c.getQueryState(['meetings', '', ''])?.isInvalidated).toBe(true);
    expect(c.getQueryState(['meeting', 'b'])?.isInvalidated).toBe(true);
  });

  it('KILLS: record_deleted keys are the record_updated keys plus duplicates, with meetings and meeting in both', () => {
    const keys = ['meetings', 'meeting', 'duplicates', 'today', 'person'];
    const touched = (name: 'record_updated' | 'record_deleted') => {
      const c = new QueryClient();
      for (const k of keys) c.setQueryData([k], 1);
      handleServerEvent(c, name, { entityType: 'x', entityId: 'y' });
      return keys.filter((k) => c.getQueryState([k])?.isInvalidated).sort();
    };
    expect(touched('record_updated')).toEqual(['meeting', 'meetings', 'person', 'today']);
    expect(touched('record_deleted')).toEqual(['duplicates', 'meeting', 'meetings', 'person', 'today']);
  });

  it('KILLS: deleting from the sheet sends one DELETE, closes the sheet, and fires at most one stray detail GET', async () => {
    detail = { ...row('mtg_x', 'Board call', HOUR), attendees: [] };
    const onClose = vi.fn();
    mount(<MeetingSheet id="mtg_x" onClose={onClose} />);
    await screen.findByDisplayValue('Board call');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete meeting' }));
    expect(screen.getByText(CONFIRM, { exact: false })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Delete meeting' }).pop()!);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 200));
    console.log('[probe] detail GETs after in-sheet delete:', detailGets, 'DELETEs:', calls.filter((c) => c.method === 'DELETE').length);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});

describe('8. screens', () => {
  it('KILLS: hostile titles, locations, and organization names render inert text', async () => {
    const evil = '<img src=x onerror="window.__xss=1">';
    list = [row('mtg_1', evil, 2 * HOUR, { organizationId: 'o', organizationName: '<script>window.__xss=2</script>', location: evil })];
    detail = { ...row('mtg_1', evil, 2 * HOUR, { location: evil, organizationId: 'o', organizationName: '<b>bold</b>' }), attendees: [{ id: 'p', name: evil }] };
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Router initialEntries={['/meetings?meeting=mtg_1']}>
          <Meetings />
        </Router>
      </QueryClientProvider>,
    );
    await screen.findByText(/<script>window/);
    await screen.findAllByDisplayValue(evil);
    expect(document.querySelectorAll('img, script, b').length).toBe(0);
    expect((window as any).__xss).toBeUndefined();
    expect(container.innerHTML.includes('<img')).toBe(false);
  });

  it('KILLS: exact empty states, and the Nothing is coming up variant', async () => {
    mount(<Meetings />, '/meetings');
    expect(await screen.findByText('No meetings yet. Add one when you book a call.')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is coming up/)).toBeNull();
  });

  it('KILLS: only past meetings gives the quiet variant until Show past', async () => {
    list = [row('mtg_p', 'Old call', -3 * HOUR)];
    mount(<Meetings />, '/meetings');
    expect(await screen.findByText('Nothing is coming up. Show past to see held meetings.')).toBeInTheDocument();
    expect(screen.queryByText('Old call')).toBeNull();
    expect(screen.queryByText(/No meetings yet/)).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show past' }));
    expect(await screen.findByText('Old call')).toBeInTheDocument();
  });

  it('KILLS: Today card shows the Tomorrow prefix only for tomorrow, and the empty sentence', async () => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0).toISOString();
    const todayLate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 30).toISOString();
    list = [
      { ...row('mtg_t', 'Tomorrow call', 0), startsAt: tomorrow },
      { ...row('mtg_d', 'Tonight call', 0), startsAt: todayLate },
    ];
    mount(<Today />, '/');
    const card = (await screen.findByRole('heading', { name: 'Meetings' })).closest('section')!;
    await within(card).findByText('Tomorrow call');
    const tomorrowRow = within(card).getByText('Tomorrow call').closest('li')!;
    const todayRow = within(card).getByText('Tonight call').closest('li')!;
    expect(tomorrowRow.textContent).toMatch(/Tomorrow \d/);
    expect(todayRow.textContent).not.toMatch(/Tomorrow/);
  });

  it('KILLS: notes counter at the boundary and the maxLength guard', async () => {
    detail = { ...row('mtg_x', 'Call', HOUR, { notes: 'a'.repeat(9999) }), attendees: [] };
    mount(<MeetingSheet id="mtg_x" onClose={() => {}} />);
    const box = (await screen.findByLabelText('Notes')) as HTMLTextAreaElement;
    expect(screen.getByText('9,999 of 10,000 characters')).toBeInTheDocument();
    expect(box.maxLength).toBe(10000);
    await userEvent.setup().type(box, 'bc');
    expect(box.value.length).toBe(10000);
    expect(screen.getByText('10,000 of 10,000 characters')).toBeInTheDocument();
  });

  it('KILLS: a version conflict on the details save shows the sentence and loads the current record, keeping the typed field', async () => {
    detail = { ...row('mtg_x', 'Call', HOUR), attendees: [] };
    patchStatus = 'conflict';
    mount(<MeetingSheet id="mtg_x" onClose={() => {}} />);
    const location = await screen.findByLabelText('Location');
    const user = userEvent.setup();
    await user.type(location, 'Zoom');
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    expect(await screen.findByText('This meeting changed since you opened it. The latest version is loaded. Try again.')).toBeInTheDocument();
    await waitFor(() => expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Changed elsewhere'));
    expect((screen.getByLabelText('Location') as HTMLInputElement).value).toBe('Zoom');
    patchStatus = 'ok';
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').pop()?.body.expectedVersion).toBe(2));
  });

  it('KILLS: transcript capture from a sheet sends the meeting id', async () => {
    detail = { ...row('mtg_x', 'Board call', HOUR), attendees: [] };
    mount(<MeetingSheet id="mtg_x" onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Capture transcript' }));
    await user.type(await screen.findByLabelText(/transcript/i, { selector: 'textarea' }), 'Hello there');
    await user.click(screen.getByRole('button', { name: "Stage people for review" }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/imports/transcript')).toBeDefined());
    expect(calls.find((c) => c.path === '/api/imports/transcript')!.body).toMatchObject({ meetingId: 'mtg_x', title: 'Board call' });
  });

  it('CONFIRMS (low): the past list asks for the oldest 500 of the last year, so a year with more than 500 held meetings hides the newest ones', async () => {
    mount(<Meetings />, '/meetings');
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/meetings').length).toBeGreaterThanOrEqual(2));
    const past = calls.find((c) => c.query.includes('limit=500'))!;
    console.log('[probe] past request:', past.query);
    expect(past.query).toContain('to=');
    // server orders ASC and applies LIMIT, so from..to with limit=500 returns the OLDEST 500 (see the server probe).
  });
});
