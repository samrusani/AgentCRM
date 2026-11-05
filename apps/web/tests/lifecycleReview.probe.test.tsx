// Adversarial review probes for the lead and relationship screens. Names start with CONFIRMS (the bug is real, the
// test passes because it is) or KILLS (a safety property holds). Nothing here changes application code.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { useServerEvents } from '../src/api/events';
import { recordLink } from '../src/lib/links';
import { Leads, Relationships } from '../src/screens/Relationships';
import { Router } from './helpers';

vi.mock('../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ui')>()),
  useUI: () => ({ theme: 'system', setTheme: () => {}, setSelectedRecord: () => {} }),
}));

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: any;
}

interface World {
  calls: Call[];
  people: Record<string, any>;
  organizations: Array<Record<string, any>>;
  // While set, people list reads wait for it, like a slow server.
  gatePeople: Promise<void> | null;
  peopleStatus: number;
  patchStatus: number;
  patchGate: Promise<void> | null;
  postStatus: number;
}

let world: World;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function person(id: string, lifecycle: 'lead' | 'relationship', first: string) {
  return {
    id,
    version: 1,
    lifecycle,
    firstName: first,
    lastName: 'Example',
    email: null,
    title: null,
    organizationId: null,
    organizationName: null,
    location: null,
    tags: [],
    nextActionAt: null,
    claims: [],
    activities: [],
    tasks: [],
    opportunities: [],
    organization: null,
    createdAt: '2026-10-01T10:00:00',
    updatedAt: '2026-11-01T10:00:00',
  };
}

function freshWorld(): World {
  return {
    calls: [],
    people: { 'lead-1': person('lead-1', 'lead', 'Lena'), 'rel-1': person('rel-1', 'relationship', 'Ravi') },
    organizations: [],
    gatePeople: null,
    peopleStatus: 200,
    patchStatus: 200,
    patchGate: null,
    postStatus: 201,
  };
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      world.calls.push({ method, path: url.pathname, search: url.searchParams, body });
      if (url.pathname === '/api/people' && method === 'GET') {
        if (world.gatePeople) await world.gatePeople;
        if (world.peopleStatus !== 200) return json(world.peopleStatus, { error: { code: 'internal', message: 'Something went wrong on the server.' } });
        const wanted = url.searchParams.get('lifecycle');
        return json(200, { items: Object.values(world.people).filter((p) => !wanted || p.lifecycle === wanted), nextCursor: null });
      }
      if (url.pathname === '/api/people' && method === 'POST') {
        if (world.postStatus !== 201) return json(world.postStatus, { error: { code: 'conflict', message: 'A person with this email address already exists.' } });
        const id = `new-${world.calls.length}`;
        world.people[id] = { ...person(id, body.lifecycle, body.firstName), ...body };
        return json(201, world.people[id]);
      }
      if (url.pathname === '/api/organizations' && method === 'GET') return json(200, { items: world.organizations, nextCursor: null });
      const match = url.pathname.match(/^\/api\/people\/([^/]+)$/);
      if (match && world.people[match[1]]) {
        const id = match[1];
        if (method === 'GET') return json(200, world.people[id]);
        if (method === 'PATCH') {
          if (world.patchGate) await world.patchGate;
          if (world.patchStatus !== 200) return json(world.patchStatus, { error: { code: 'internal', message: 'Something went wrong on the server.' } });
          if (body.expectedVersion !== world.people[id].version) {
            return json(409, { error: { code: 'version_conflict', message: 'Version conflict.' }, current: world.people[id] });
          }
          world.people[id] = { ...world.people[id], ...body.fields, version: world.people[id].version + 1 };
          return json(200, world.people[id]);
        }
      }
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  listeners = new Map<string, Array<() => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close() {}
  fire(name: string) {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}

// jsdom has no layout, so the virtual table would render no rows. Give every element a viewport.
function stubLayout() {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function Events() {
  useServerEvents();
  return null;
}

function renderAt(entry: string, extra?: React.ReactNode) {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[entry]}>
        <Events />
        <Where />
        {extra}
        <Routes>
          <Route path="/leads" element={<Leads />} />
          <Route path="/relationships" element={<Relationships />} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
  return { user, client };
}

const peopleCalls = () => world.calls.filter((call) => call.method === 'GET' && call.path === '/api/people');
const orgCalls = () => world.calls.filter((call) => call.method === 'GET' && call.path === '/api/organizations');
const rowNames = () => screen.queryAllByRole('row', { hidden: true }).map((row) => row.textContent ?? '');
const hasRow = (name: string) => rowNames().some((text) => text.includes(name));

beforeEach(() => {
  world = freshWorld();
  FakeEventSource.instances = [];
  installFetch();
  vi.stubGlobal('EventSource', FakeEventSource);
  stubLayout();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
});

describe('server events', () => {
  it('KILLS: a promotion event drops the person from the open Leads table without a reload', async () => {
    renderAt('/leads');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    expect(hasRow('Ravi')).toBe(false);
    // The server promotes Lena (mail sync or a stage move) and broadcasts record_updated.
    world.people['lead-1'] = { ...world.people['lead-1'], lifecycle: 'relationship', version: 2 };
    act(() => FakeEventSource.instances[0]!.fire('record_updated'));
    await waitFor(() => expect(hasRow('Lena')).toBe(false));
    expect(await screen.findByText(/^No leads yet\./)).toBeInTheDocument();
  });

  it('KILLS: the same event adds the person to the open Relationships table', async () => {
    renderAt('/relationships');
    await waitFor(() => expect(hasRow('Ravi')).toBe(true));
    expect(hasRow('Lena')).toBe(false);
    world.people['lead-1'] = { ...world.people['lead-1'], lifecycle: 'relationship', version: 2 };
    act(() => FakeEventSource.instances[0]!.fire('record_updated'));
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    expect(hasRow('Ravi')).toBe(true);
  });

  it('KILLS: the event also refetches the open organizations tab with the same lifecycle, so a derived organization moves too', async () => {
    renderAt('/leads?tab=organizations');
    await waitFor(() => expect(orgCalls().length).toBeGreaterThan(0));
    const before = orgCalls().length;
    act(() => FakeEventSource.instances[0]!.fire('record_updated'));
    await waitFor(() => expect(orgCalls().length).toBeGreaterThan(before));
    expect(orgCalls().every((call) => call.search.get('lifecycle') === 'lead')).toBe(true);
  });

  it('KILLS: an open person sheet picks up a promotion by event and then saves with the new version instead of a stale one', async () => {
    const { user } = renderAt('/leads?tab=people&person=lead-1');
    const sheet = await screen.findByRole('dialog', { name: 'Lena Example' });
    expect(within(sheet).getByRole('button', { name: 'Mark as relationship' })).toBeInTheDocument();
    world.people['lead-1'] = { ...world.people['lead-1'], lifecycle: 'relationship', version: 2 };
    act(() => FakeEventSource.instances[0]!.fire('record_updated'));
    const demote = await within(sheet).findByRole('button', { name: 'Move to leads' });
    await user.click(demote);
    await waitFor(() => expect(world.people['lead-1'].lifecycle).toBe('lead'));
    expect(world.calls.filter((call) => call.method === 'PATCH').map((call) => call.body.expectedVersion)).toEqual([2]);
  });
});

describe('list fetches', () => {
  it('KILLS: search, the fit sort, and switching tabs back and forth keep the route lifecycle on every request, on both routes', async () => {
    for (const [route, wanted] of [
      ['/leads', 'lead'],
      ['/relationships', 'relationship'],
    ] as const) {
      world.calls = [];
      const { user } = renderAt(route);
      await waitFor(() => expect(peopleCalls().length).toBeGreaterThan(0));
      await user.type(screen.getByRole('searchbox'), 'le');
      await waitFor(() => expect(peopleCalls().some((call) => call.search.get('q') === 'le')).toBe(true));
      await user.click(screen.getByRole('button', { name: /^Fit/ }));
      await waitFor(() => expect(peopleCalls().some((call) => call.search.get('sort') === 'fit')).toBe(true));
      await user.click(screen.getByRole('tab', { name: 'Organizations' }));
      await waitFor(() => expect(orgCalls().length).toBeGreaterThan(0));
      await user.click(screen.getByRole('tab', { name: 'People' }));
      // The organization name lookup inside the people table reads every organization on purpose and is the only call allowed to omit it.
      const lookups = orgCalls().filter((call) => !call.search.has('lifecycle') && call.search.get('q') === null);
      expect(peopleCalls().every((call) => call.search.get('lifecycle') === wanted)).toBe(true);
      expect(orgCalls().filter((call) => call.search.has('lifecycle')).every((call) => call.search.get('lifecycle') === wanted)).toBe(true);
      expect(lookups.length).toBe(orgCalls().filter((call) => !call.search.has('lifecycle')).length);
      document.body.innerHTML = '';
    }
  });

  it('KILLS: moving from Leads to Relationships through a link shows only relationship rows and never the lead rows of the screen it left', async () => {
    const { user } = renderAt('/leads', <Link to="/relationships">go to relationships</Link>);
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    world.calls = [];
    await user.click(screen.getByRole('link', { name: 'go to relationships' }));
    expect(screen.getByRole('heading', { name: 'Relationships', level: 1 })).toBeInTheDocument();
    expect(hasRow('Lena')).toBe(false);
    await waitFor(() => expect(hasRow('Ravi')).toBe(true));
    expect(hasRow('Lena')).toBe(false);
    expect(peopleCalls().every((call) => call.search.get('lifecycle') === 'relationship')).toBe(true);
  });

  it('KILLS: while the first people read is pending the empty state does not show, and a failed read shows the error rather than the empty invitation', async () => {
    let release: () => void = () => {};
    world.gatePeople = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.people = {};
    renderAt('/leads');
    await waitFor(() => expect(peopleCalls().length).toBeGreaterThan(0));
    expect(screen.getByText('Loading people')).toBeInTheDocument();
    expect(screen.queryByText(/^No leads yet\./)).not.toBeInTheDocument();
    release();
    expect(await screen.findByText(/^No leads yet\./)).toBeInTheDocument();
    document.body.innerHTML = '';

    world.gatePeople = null;
    world.peopleStatus = 500;
    renderAt('/relationships');
    expect(await screen.findByText('Could not load people')).toBeInTheDocument();
    expect(screen.queryByText(/^No relationships yet\./)).not.toBeInTheDocument();
  });
});

describe('lifecycle sheet row', () => {
  it('KILLS: a double click on the lifecycle action sends one PATCH while the first is still in flight', async () => {
    let release: () => void = () => {};
    world.patchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = renderAt('/leads?tab=people&person=lead-1');
    const sheet = await screen.findByRole('dialog', { name: 'Lena Example' });
    await user.dblClick(within(sheet).getByRole('button', { name: 'Mark as relationship' }));
    expect(world.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    release();
    expect(await within(sheet).findByRole('button', { name: 'Move to leads' })).toBeInTheDocument();
    expect(world.people['lead-1'].version).toBe(2);
  });

  it('KILLS: a server failure on the lifecycle change says it was not changed and keeps the old value and action', async () => {
    world.patchStatus = 500;
    const { user } = renderAt('/relationships?tab=people&person=rel-1');
    const sheet = await screen.findByRole('dialog', { name: 'Ravi Example' });
    await user.click(within(sheet).getByRole('button', { name: 'Move to leads' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('The lifecycle was not changed.');
    expect(within(sheet).getByRole('button', { name: 'Move to leads' })).toBeInTheDocument();
    expect(world.people['rel-1'].lifecycle).toBe('relationship');
  });

  // Documented in design.md: record links open the sheet on /relationships whatever the lifecycle;
  // the sheet loads by id and the table behind it keeps its own filter.
  it('documented: every in-app link to a person lands on /relationships, where the sheet opens by id while the table keeps its own filter', async () => {
    expect(recordLink('person', 'lead-1')).toBe('/relationships?tab=people&person=lead-1');
    renderAt(recordLink('person', 'lead-1')!);
    await screen.findByRole('dialog', { name: 'Lena Example' });
    expect(screen.getByRole('heading', { name: 'Relationships', level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(hasRow('Ravi')).toBe(true));
    expect(hasRow('Lena')).toBe(false);
  });
});

describe('new person form', () => {
  it('KILLS: a rejected create keeps the sheet open with the reason, sends only the strict body with trimmed values, and a retry then succeeds', async () => {
    world.postStatus = 409;
    const { user } = renderAt('/leads');
    await user.click(screen.getByRole('button', { name: 'New person' }));
    await user.type(screen.getByLabelText('First name'), '  Nia  ');
    await user.type(screen.getByLabelText('Last name'), '   ');
    await user.type(screen.getByLabelText('Email'), 'nia@example.org');
    await user.type(screen.getByLabelText('Title'), '  ');
    await user.click(screen.getByRole('button', { name: 'Create person' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A person with this email address already exists. The person was not created.');
    expect(screen.getByRole('dialog', { name: 'New person' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/leads');
    expect(screen.getByTestId('where')).not.toHaveTextContent('person=');
    const posts = world.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ firstName: 'Nia', email: 'nia@example.org', lifecycle: 'relationship' });

    world.postStatus = 201;
    await user.click(screen.getByRole('button', { name: 'Create person' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('person=new-'));
    expect(world.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });

  it('KILLS: a first name of spaces only sends nothing', async () => {
    const { user } = renderAt('/relationships');
    await user.click(screen.getByRole('button', { name: 'New person' }));
    await user.type(screen.getByLabelText('First name'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create person' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a first name.');
    expect(world.calls.some((call) => call.method === 'POST')).toBe(false);
  });
});
