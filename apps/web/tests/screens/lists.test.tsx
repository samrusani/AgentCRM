import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes, useLocation } from 'react-router-dom';
import { useServerEvents } from '../../src/api/events';
import { Leads, Relationships } from '../../src/screens/Relationships';
import { Router } from '../helpers';

const pushToast = vi.fn();
vi.mock('../../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/ui')>()),
  useUI: () => ({ theme: 'system', setTheme: () => {}, setSelectedRecord: () => {}, pushToast }),
}));

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: any;
}

interface ListRow {
  id: string;
  name: string;
  version: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

interface World {
  calls: Call[];
  people: Record<string, any>;
  lists: ListRow[];
  // list id -> member person ids, oldest first.
  members: Record<string, string[]>;
  // Fails the next call to a path ending with this, with the given status and message.
  failNext: { suffix: string; method: string; status: number; code: string; message: string } | null;
  nextListId: number;
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

const listRow = (id: string, name: string, memberCount: number, version = 1): ListRow => ({
  id,
  name,
  version,
  memberCount,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
});

function freshWorld(): World {
  return {
    calls: [],
    people: {
      'lead-1': person('lead-1', 'lead', 'Lena'),
      'lead-2': person('lead-2', 'lead', 'Leo'),
      'lead-3': person('lead-3', 'lead', 'Lia'),
      'rel-1': person('rel-1', 'relationship', 'Ravi'),
    },
    lists: [listRow('lst-angels', 'UK Angels', 2), listRow('lst-energy', 'Energy investors', 0)],
    members: { 'lst-angels': ['lead-1', 'rel-1'], 'lst-energy': [] },
    failNext: null,
    nextListId: 1,
  };
}

const withCounts = () => world.lists.map((list) => ({ ...list, memberCount: world.members[list.id]!.length }));

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      world.calls.push({ method, path: url.pathname, search: url.searchParams, body });
      const failure = world.failNext;
      if (failure && url.pathname.endsWith(failure.suffix) && method === failure.method) {
        world.failNext = null;
        return json(failure.status, { error: { code: failure.code, message: failure.message } });
      }
      if (url.pathname === '/api/people' && method === 'GET') {
        const wantedLifecycle = url.searchParams.get('lifecycle');
        const wantedList = url.searchParams.get('list');
        const items = Object.values(world.people).filter(
          (p) =>
            (!wantedLifecycle || p.lifecycle === wantedLifecycle) &&
            (!wantedList || (world.members[wantedList] ?? []).includes(p.id)),
        );
        return json(200, { items, nextCursor: null });
      }
      if (url.pathname === '/api/organizations' && method === 'GET') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/lists' && method === 'GET') return json(200, { items: withCounts(), nextCursor: null });
      if (url.pathname === '/api/lists' && method === 'POST') {
        const id = `lst-new-${world.nextListId++}`;
        world.lists.unshift(listRow(id, body.name, 0));
        world.members[id] = [];
        return json(201, withCounts()[0]);
      }
      const memberMatch = url.pathname.match(/^\/api\/lists\/([^/]+)\/members(?:\/([^/]+))?$/);
      if (memberMatch) {
        const [, listId, personId] = memberMatch;
        const members = world.members[listId!]!;
        if (method === 'POST') {
          const added = (body.personIds as string[]).filter((id) => !members.includes(id));
          members.push(...added);
          return json(200, { added: added.length, already: body.personIds.length - added.length });
        }
        if (method === 'DELETE') {
          world.members[listId!] = members.filter((id) => id !== personId);
          return json(200, { removed: members.length - world.members[listId!]!.length });
        }
      }
      const listMatch = url.pathname.match(/^\/api\/lists\/([^/]+)$/);
      if (listMatch) {
        const list = world.lists.find((entry) => entry.id === listMatch[1])!;
        if (method === 'PATCH') {
          if (body.expectedVersion !== list.version) {
            return json(409, { error: { code: 'version_conflict', message: 'Version conflict.' }, current: list });
          }
          list.name = body.fields.name;
          list.version += 1;
          return json(200, { ...list, memberCount: world.members[list.id]!.length });
        }
        if (method === 'DELETE') {
          world.lists = world.lists.filter((entry) => entry.id !== list.id);
          delete world.members[list.id];
          return new Response(null, { status: 204 });
        }
      }
      const personMatch = url.pathname.match(/^\/api\/people\/([^/]+)$/);
      if (personMatch && world.people[personMatch[1]!] && method === 'GET') {
        const id = personMatch[1]!;
        const lists = world.lists
          .filter((entry) => world.members[entry.id]!.includes(id))
          .map((entry) => ({ id: entry.id, name: entry.name }))
          .reverse();
        return json(200, { ...world.people[id], lists });
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

function renderAt(entry: string) {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[entry]}>
        <Events />
        <Where />
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
const rowNames = () => screen.queryAllByRole('row', { hidden: true }).map((row) => row.textContent ?? '');
const hasRow = (name: string) => rowNames().some((text) => text.includes(name));
const rowBox = (name: string) => screen.getByRole('checkbox', { name: `Select ${name} Example` });
const pageBox = () => screen.getByRole('checkbox', { name: 'Select all people on this page' });
const listSelect = () => screen.getByRole('combobox', { name: 'List' });

beforeEach(() => {
  world = freshWorld();
  FakeEventSource.instances = [];
  pushToast.mockClear();
  installFetch();
  vi.stubGlobal('EventSource', FakeEventSource);
  stubLayout();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
});

describe('List select', () => {
  it('lists every list with its member count after All lists', async () => {
    renderAt('/leads');
    await waitFor(() => expect(within(listSelect()).getAllByRole('option')).toHaveLength(3));
    expect(within(listSelect()).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'All lists',
      'UK Angels (2)',
      'Energy investors (0)',
    ]);
    expect(listSelect()).toHaveValue('');
  });

  it('rides the URL, filters the table to members, and keeps the route lifecycle', async () => {
    const { user } = renderAt('/relationships');
    await waitFor(() => expect(hasRow('Ravi')).toBe(true));
    await waitFor(() => expect(within(listSelect()).getAllByRole('option')).toHaveLength(3));
    await user.selectOptions(listSelect(), 'lst-angels');
    expect(screen.getByTestId('where')).toHaveTextContent('/relationships?list=lst-angels');
    await waitFor(() => expect(peopleCalls().some((call) => call.search.get('list') === 'lst-angels')).toBe(true));
    const filtered = peopleCalls().filter((call) => call.search.get('list') === 'lst-angels');
    expect(filtered.every((call) => call.search.get('lifecycle') === 'relationship')).toBe(true);
    expect(screen.getByText(/Showing members of UK Angels\./)).toBeInTheDocument();
    // Lena is on the list but is a lead, so Relationships shows only Ravi.
    expect(hasRow('Lena')).toBe(false);
    expect(hasRow('Ravi')).toBe(true);

    await user.selectOptions(listSelect(), '');
    expect(screen.getByTestId('where')).toHaveTextContent('/relationships');
    expect(screen.getByTestId('where')).not.toHaveTextContent('list=');
  });

  it('opens a link with ?list= already filtered and falls back to All lists on an unknown id', async () => {
    renderAt('/leads?list=lst-angels');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    expect(hasRow('Leo')).toBe(false);
    expect(listSelect()).toHaveValue('lst-angels');
    document.body.innerHTML = '';

    world.calls = [];
    renderAt('/leads?list=lst-missing');
    await waitFor(() => expect(hasRow('Leo')).toBe(true));
    expect(listSelect()).toHaveValue('');
    expect(screen.queryByText(/Showing members of/)).not.toBeInTheDocument();
    // After the lists load, the unknown id is no longer sent.
    const last = peopleCalls().at(-1)!;
    expect(last.search.has('list')).toBe(false);
  });

  it('says what an empty list means for this screen', async () => {
    renderAt('/leads?list=lst-energy');
    expect(await screen.findByText(/^Nobody on Energy investors shows under Leads\./)).toBeInTheDocument();
  });
});

describe('Row selection', () => {
  it('swaps the header actions for a count, Add to list, and Clear, and back', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    expect(screen.getByRole('button', { name: 'Import CSV' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to list' })).not.toBeInTheDocument();

    await user.click(rowBox('Lena'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to list' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import CSV' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New person' })).not.toBeInTheDocument();
    // Ticking a box never opens the row's sheet.
    expect(screen.getByTestId('where')).not.toHaveTextContent('person=');

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import CSV' })).toBeInTheDocument();
    expect(rowBox('Lena')).not.toBeChecked();
  });

  it('selects and clears the whole page from the header box, with a mixed state in between', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lia')).toBe(true));
    await user.click(rowBox('Leo'));
    expect(pageBox()).toBePartiallyChecked();
    await user.click(pageBox());
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    expect(pageBox()).toBeChecked();
    await user.click(pageBox());
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('clears the selection when the list filter changes', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(rowBox('Leo'));
    await user.selectOptions(listSelect(), 'lst-angels');
    await waitFor(() => expect(screen.queryByText(/selected/)).not.toBeInTheDocument());
  });
});

describe('Add to list', () => {
  it('adds the selected people to a chosen list and toasts added and already counts', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(rowBox('Lena'));
    await user.click(rowBox('Leo'));
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    const menu = screen.getByRole('menu', { name: 'Add to list' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'UK Angels',
      'Energy investors',
      'New list',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'UK Angels' }));

    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    const post = world.calls.find((call) => call.method === 'POST' && call.path === '/api/lists/lst-angels/members')!;
    expect(post.body).toEqual({ personIds: ['lead-1', 'lead-2'] });
    expect(pushToast).toHaveBeenCalledWith('Added 1 person to UK Angels. 1 was already on it.');
    // The selection clears and the menu closes.
    await waitFor(() => expect(screen.queryByText(/selected/)).not.toBeInTheDocument());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(listSelect()).toHaveDisplayValue('All lists'));
    await waitFor(() => expect(within(listSelect()).getByRole('option', { name: 'UK Angels (3)' })).toBeInTheDocument());
  });

  it('says when everyone was already on the list', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(rowBox('Lena'));
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('menuitem', { name: 'UK Angels' }));
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('That person was already on UK Angels.'));
  });

  it('creates a list inline, then adds the selection to it', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(pageBox());
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('menuitem', { name: 'New list' }));
    await user.type(screen.getByRole('textbox', { name: 'New list name' }), '  Family offices  {Enter}');

    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    const create = world.calls.find((call) => call.method === 'POST' && call.path === '/api/lists')!;
    expect(create.body).toEqual({ name: 'Family offices' });
    const add = world.calls.find((call) => call.method === 'POST' && call.path === '/api/lists/lst-new-1/members')!;
    expect(add.body).toEqual({ personIds: ['lead-1', 'lead-2', 'lead-3'] });
    expect(pushToast).toHaveBeenCalledWith('Created Family offices. Added 3 people to Family offices.');
    await waitFor(() => expect(screen.queryByText(/selected/)).not.toBeInTheDocument());
  });

  it('keeps the menu and the selection when the add fails, and says what to do next', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(rowBox('Leo'));
    world.failNext = { suffix: '/members', method: 'POST', status: 400, code: 'validation', message: '1 selected person was not found, so nobody was added.' };
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('menuitem', { name: 'UK Angels' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('1 selected person was not found, so nobody was added. Try again.');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(pushToast).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('shows a refused list name inline and creates nothing else', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(rowBox('Leo'));
    world.failNext = { suffix: '/api/lists', method: 'POST', status: 400, code: 'validation', message: 'name: String must contain at least 1 character(s).' };
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('menuitem', { name: 'New list' }));
    await user.type(screen.getByRole('textbox', { name: 'New list name' }), 'x{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('The list was not created. Fix the name and try again.');
    expect(world.calls.some((call) => call.path.endsWith('/members'))).toBe(false);
  });
});

describe('Remove from list', () => {
  it('is offered only while a list filter is active and removes the selected members', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(rowBox('Lena'));
    expect(screen.queryByRole('button', { name: 'Remove from list' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    await user.selectOptions(listSelect(), 'lst-angels');
    await waitFor(() => expect(hasRow('Leo')).toBe(false));
    await user.click(rowBox('Lena'));
    await user.click(screen.getByRole('button', { name: 'Remove from list' }));

    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('Removed 1 person from UK Angels.', 'info'));
    expect(world.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([
      '/api/lists/lst-angels/members/lead-1',
    ]);
    // The removed person leaves the filtered table and the selection with it.
    await waitFor(() => expect(hasRow('Lena')).toBe(false));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('keeps people it could not remove selected and says so', async () => {
    const { user } = renderAt('/leads?list=lst-angels');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(rowBox('Lena'));
    world.failNext = { suffix: '/members/lead-1', method: 'DELETE', status: 500, code: 'internal', message: 'Something went wrong on the server.' };
    await user.click(screen.getByRole('button', { name: 'Remove from list' }));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    expect(pushToast.mock.calls[0]![0]).toBe('Removed 0 of 1 person from UK Angels. 1 could not be removed and stay selected. Try again.');
    expect(pushToast.mock.calls[0]![1]).toBe('error');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
});

describe('List actions', () => {
  it('offers Rename list and Delete list only for an active list', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(within(listSelect()).getAllByRole('option')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'List actions' })).not.toBeInTheDocument();
    await user.selectOptions(listSelect(), 'lst-angels');
    await user.click(await screen.findByRole('button', { name: 'List actions' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Rename list', 'Delete list']);
  });

  it('renames with the loaded version and refreshes the select', async () => {
    const { user } = renderAt('/leads?list=lst-angels');
    await user.click(await screen.findByRole('button', { name: 'List actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename list' }));
    const sheet = await screen.findByRole('dialog', { name: 'Rename list' });
    const input = within(sheet).getByRole('textbox', { name: 'Name' });
    expect(input).toHaveValue('UK Angels');
    await user.clear(input);
    await user.type(input, 'British angels');
    await user.click(within(sheet).getByRole('button', { name: 'Rename list' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename list' })).not.toBeInTheDocument());
    const patch = world.calls.find((call) => call.method === 'PATCH')!;
    expect(patch.path).toBe('/api/lists/lst-angels');
    expect(patch.body).toEqual({ expectedVersion: 1, fields: { name: 'British angels' } });
    expect(await screen.findByText(/Showing members of British angels\./)).toBeInTheDocument();
  });

  it('explains a rename conflict without renaming', async () => {
    const { user } = renderAt('/leads?list=lst-angels');
    await user.click(await screen.findByRole('button', { name: 'List actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename list' }));
    const sheet = await screen.findByRole('dialog', { name: 'Rename list' });
    world.lists[0]!.version = 2;
    const input = within(sheet).getByRole('textbox', { name: 'Name' });
    await user.clear(input);
    await user.type(input, 'Late name');
    await user.click(within(sheet).getByRole('button', { name: 'Rename list' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('This list changed since you opened this sheet.');
    expect(world.lists[0]!.name).toBe('UK Angels');
  });

  it('confirms a delete in words that keep the members, then returns to All lists', async () => {
    const { user } = renderAt('/leads?list=lst-angels');
    await user.click(await screen.findByRole('button', { name: 'List actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete list' }));
    const confirm = screen.getByRole('alert');
    expect(confirm).toHaveTextContent('Delete UK Angels? Its 2 members are not deleted, only the list.');
    expect(world.calls.some((call) => call.method === 'DELETE')).toBe(false);

    await user.click(within(confirm).getByRole('button', { name: 'Keep list' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'List actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete list' }));
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Delete list' }));
    await waitFor(() => expect(world.calls.some((call) => call.method === 'DELETE' && call.path === '/api/lists/lst-angels')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('where')).not.toHaveTextContent('list='));
    expect(pushToast).toHaveBeenCalledWith('Deleted UK Angels. Its members were not deleted.');
    await waitFor(() => expect(listSelect()).toHaveValue(''));
    expect(world.people['lead-1']).toBeDefined();
  });
});

describe('Person sheet Lists row', () => {
  it('shows None for a person on no list', async () => {
    renderAt('/leads?tab=people&person=lead-2');
    const sheet = await screen.findByRole('dialog', { name: 'Leo Example' });
    const row = within(sheet).getByText('Lists').closest('.field') as HTMLElement;
    expect(await within(row).findByText('None')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Add to list' })).toBeInTheDocument();
  });

  it('shows chips, adds through the menu, and removes with the chip control', async () => {
    const { user } = renderAt('/leads?tab=people&person=lead-1');
    const sheet = await screen.findByRole('dialog', { name: 'Lena Example' });
    const row = within(sheet).getByText('Lists').closest('.field') as HTMLElement;
    expect(await within(row).findByText('UK Angels')).toBeInTheDocument();
    expect(within(row).queryByText('None')).not.toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Add to list' }));
    const menu = screen.getByRole('menu', { name: 'Add to list' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Energy investors' }));
    await waitFor(() => expect(within(row).getByText('Energy investors')).toBeInTheDocument());
    const add = world.calls.find((call) => call.method === 'POST' && call.path === '/api/lists/lst-energy/members')!;
    expect(add.body).toEqual({ personIds: ['lead-1'] });

    await user.click(within(row).getByRole('button', { name: 'Remove from UK Angels' }));
    await waitFor(() => expect(within(row).queryByText('UK Angels')).not.toBeInTheDocument());
    expect(world.calls.some((call) => call.method === 'DELETE' && call.path === '/api/lists/lst-angels/members/lead-1')).toBe(true);
    // Membership never writes the person.
    expect(world.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('creates a list from the menu and puts the person on it', async () => {
    const { user } = renderAt('/leads?tab=people&person=lead-2');
    const sheet = await screen.findByRole('dialog', { name: 'Leo Example' });
    const row = within(sheet).getByText('Lists').closest('.field') as HTMLElement;
    await within(row).findByText('None');
    await user.click(within(row).getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('menuitem', { name: 'New list' }));
    await user.type(screen.getByRole('textbox', { name: 'New list name' }), 'Seed funds{Enter}');
    await waitFor(() => expect(within(row).getByText('Seed funds')).toBeInTheDocument());
    expect(world.calls.find((call) => call.method === 'POST' && call.path === '/api/lists')!.body).toEqual({ name: 'Seed funds' });
  });

  it('shows a failed remove inline with what to do next and keeps the chip', async () => {
    const { user } = renderAt('/leads?tab=people&person=lead-1');
    const sheet = await screen.findByRole('dialog', { name: 'Lena Example' });
    const row = within(sheet).getByText('Lists').closest('.field') as HTMLElement;
    await within(row).findByText('UK Angels');
    world.failNext = { suffix: '/members/lead-1', method: 'DELETE', status: 500, code: 'internal', message: 'Something went wrong on the server.' };
    await user.click(within(row).getByRole('button', { name: 'Remove from UK Angels' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Something went wrong on the server. This person is still on UK Angels. Try again.');
    expect(within(row).getByText('UK Angels')).toBeInTheDocument();
  });

  it('shows a failed add inline in the menu and keeps it open', async () => {
    const { user } = renderAt('/leads?tab=people&person=lead-2');
    const sheet = await screen.findByRole('dialog', { name: 'Leo Example' });
    const row = within(sheet).getByText('Lists').closest('.field') as HTMLElement;
    await within(row).findByText('None');
    world.failNext = { suffix: '/members', method: 'POST', status: 404, code: 'not_found', message: 'List was not found.' };
    await user.click(within(row).getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('menuitem', { name: 'UK Angels' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('List was not found. This person was not added to UK Angels. Try again.');
    expect(within(row).getByText('None')).toBeInTheDocument();
  });
});

describe('server events', () => {
  it('refetches the lists, the people table, and the open person sheet on record_updated', async () => {
    renderAt('/leads?tab=people&person=lead-2');
    await screen.findByRole('dialog', { name: 'Leo Example' });
    await waitFor(() => expect(world.calls.some((call) => call.path === '/api/lists')).toBe(true));
    const count = (path: string) => world.calls.filter((call) => call.method === 'GET' && call.path === path).length;
    const before = { lists: count('/api/lists'), people: count('/api/people'), person: count('/api/people/lead-2') };

    // Another tab puts Leo on a list; the server broadcasts record_updated for the list.
    world.members['lst-energy'] = ['lead-2'];
    act(() => FakeEventSource.instances[0]!.fire('record_updated'));

    await waitFor(() => expect(count('/api/lists')).toBeGreaterThan(before.lists));
    await waitFor(() => expect(count('/api/people')).toBeGreaterThan(before.people));
    await waitFor(() => expect(count('/api/people/lead-2')).toBeGreaterThan(before.person));
    const sheet = screen.getByRole('dialog', { name: 'Leo Example' });
    expect(await within(sheet).findByText('Energy investors')).toBeInTheDocument();
    expect(await within(listSelect()).findByRole('option', { name: 'Energy investors (1)' })).toBeInTheDocument();
  });
});
