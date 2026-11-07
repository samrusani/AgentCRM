// Adversarial review probes for the people lists web wave. Names start with KILLS (the attack fails), CONFIRMS (a live
// bug: the test passes against today's code and the comment says what should happen), or ACCEPTED (a deliberate limit).
// Nothing here changes application code.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes, useLocation } from 'react-router-dom';
import { useServerEvents } from '../src/api/events';
import { Leads } from '../src/screens/Relationships';
import { Router } from './helpers';

const pushToast = vi.fn();
vi.mock('../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ui')>()),
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
  people: any[];
  lists: ListRow[];
  members: Record<string, string[]>;
  // Returns a response to short circuit a call, or null to let the fake server answer.
  fail: ((call: Call) => Response | null) | null;
  // Milliseconds each member DELETE takes, with a counter of how many ran at once.
  deleteDelayMs: number;
  inflight: number;
  maxInflight: number;
  nextListId: number;
}

let world: World;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const failure = (status: number, message: string) => json(status, { error: { code: status === 404 ? 'not_found' : 'internal', message } });

function person(id: string, first: string, lifecycle: 'lead' | 'relationship' = 'lead') {
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

const listRow = (id: string, name: string, version = 1): ListRow => ({
  id,
  name,
  version,
  memberCount: 0,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
});

function freshWorld(extraPeople = 0): World {
  const people = [person('lead-1', 'Lena'), person('lead-2', 'Leo'), person('lead-3', 'Lia')];
  for (let index = 0; index < extraPeople; index += 1) people.push(person(`bulk-${String(index).padStart(4, '0')}`, `Bulk${String(index).padStart(4, '0')}`));
  return {
    calls: [],
    people,
    lists: [listRow('lst-angels', 'UK Angels'), listRow('lst-energy', 'Energy investors')],
    members: { 'lst-angels': ['lead-1'], 'lst-energy': [] },
    fail: null,
    deleteDelayMs: 0,
    inflight: 0,
    maxInflight: 0,
    nextListId: 1,
  };
}

const withCounts = () => world.lists.map((list) => ({ ...list, memberCount: world.members[list.id]?.length ?? 0 }));

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const call: Call = { method, path: url.pathname, search: url.searchParams, body };
      world.calls.push(call);
      const forced = world.fail?.(call);
      if (forced) return forced;
      if (url.pathname === '/api/people' && method === 'GET') {
        const wantedList = url.searchParams.get('list');
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const items = world.people.filter(
          (p) =>
            (!url.searchParams.get('lifecycle') || p.lifecycle === url.searchParams.get('lifecycle')) &&
            (!wantedList || (world.members[wantedList] ?? []).includes(p.id)) &&
            (!q || `${p.firstName} ${p.lastName}`.toLowerCase().includes(q)),
        );
        return json(200, { items, nextCursor: null });
      }
      if (url.pathname === '/api/organizations' && method === 'GET') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/lists' && method === 'GET') return json(200, { items: withCounts(), nextCursor: null });
      if (url.pathname === '/api/lists' && method === 'POST') {
        const id = `lst-new-${world.nextListId++}`;
        world.lists.unshift(listRow(id, body.name));
        world.members[id] = [];
        return json(201, withCounts()[0]);
      }
      const memberMatch = url.pathname.match(/^\/api\/lists\/([^/]+)\/members(?:\/([^/]+))?$/);
      if (memberMatch) {
        const [, listId, personId] = memberMatch;
        const members = world.members[listId!];
        if (!members) return failure(404, 'List was not found.');
        if (method === 'POST') {
          const added = (body.personIds as string[]).filter((id) => !members.includes(id));
          members.push(...added);
          return json(200, { added: added.length, already: body.personIds.length - added.length });
        }
        if (method === 'DELETE') {
          world.inflight += 1;
          world.maxInflight = Math.max(world.maxInflight, world.inflight);
          if (world.deleteDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, world.deleteDelayMs));
          world.inflight -= 1;
          const before = members.length;
          world.members[listId!] = members.filter((id) => id !== personId);
          return json(200, { removed: before - world.members[listId!]!.length });
        }
      }
      const personMatch = url.pathname.match(/^\/api\/people\/([^/]+)$/);
      if (personMatch && method === 'GET') {
        const found = world.people.find((p) => p.id === personMatch[1]);
        if (!found) return failure(404, 'Person was not found.');
        const lists = world.lists.filter((entry) => world.members[entry.id]?.includes(found.id)).map((entry) => ({ id: entry.id, name: entry.name }));
        return json(200, { ...found, lists });
      }
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

class FakeEventSource {
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
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
  return { user, client };
}

const rowNames = () => screen.queryAllByRole('row', { hidden: true }).map((row) => row.textContent ?? '');
const hasRow = (name: string) => rowNames().some((text) => text.includes(name));
const rowBox = (name: string) => screen.getByRole('checkbox', { name: `Select ${name} Example` });
const pageBox = () => screen.getByRole('checkbox', { name: 'Select all people on this page' });
const listSelect = () => screen.getByRole('combobox', { name: 'List' });
const posts = (suffix: string) => world.calls.filter((call) => call.method === 'POST' && call.path.endsWith(suffix));

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

describe('honesty of the list framing', () => {
  it('KILLS: the Organizations tab with ?list= never says "Showing members of <list>", because the organization table is not filtered (the filter is people only)', async () => {
    renderAt('/leads?tab=organizations&list=lst-angels');
    await waitFor(() => expect(world.calls.some((call) => call.path === '/api/organizations')).toBe(true));
    expect(screen.queryByText(/Showing members of/)).not.toBeInTheDocument();
    expect(world.calls.filter((call) => call.path === '/api/organizations').every((call) => !call.search.has('list'))).toBe(true);
    // The select and the List actions menu are People tab controls and are absent here.
    expect(screen.queryByRole('combobox', { name: 'List' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'List actions' })).not.toBeInTheDocument();
  });

  it('KILLS: when the lists request fails, ?list= still filters the table and the select shows the filter as an unavailable entry beside Retry lists, never All lists', async () => {
    world.fail = (call) => (call.path === '/api/lists' && call.method === 'GET' ? failure(500, 'Lists are down.') : null);
    renderAt('/leads?list=lst-angels');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    expect(hasRow('Leo')).toBe(false);
    expect(listSelect()).toHaveValue('lst-angels');
    expect(within(listSelect()).getByRole('option', { name: 'Unavailable list' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry lists' })).toBeInTheDocument();
    // No List actions and no Remove from list either: the page cannot act on the list it is filtered to.
    expect(screen.queryByRole('button', { name: 'List actions' })).not.toBeInTheDocument();
  });

  it('KILLS: a list deleted in another tab does not crash the open filter: it falls back to everyone, All lists, and the sheet-free table', async () => {
    renderAt('/leads?list=lst-angels');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    expect(hasRow('Leo')).toBe(false);
    world.lists = world.lists.filter((list) => list.id !== 'lst-angels');
    delete world.members['lst-angels'];
    act(() => FakeEventSource.instances[0]!.fire('record_updated'));
    await waitFor(() => expect(hasRow('Leo')).toBe(true));
    expect(listSelect()).toHaveValue('');
    expect(screen.queryByText(/Showing members of/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'List actions' })).not.toBeInTheDocument();
    // ACCEPTED: the dead id stays in the address bar; it is harmless because an unknown id is never sent once lists loaded.
    expect(screen.getByTestId('where')).toHaveTextContent('list=lst-angels');
    expect(world.calls.filter((call) => call.path === '/api/people').at(-1)!.search.has('list')).toBe(false);
  });

  it('KILLS: a list name made of markup renders as text in the select, the menu, the person chips, and reaches the toast as a plain string', async () => {
    const hostile = '<img src=x onerror="document.title=\'pwned\'"><b>bold</b>';
    world.lists.unshift(listRow('lst-hostile', hostile));
    world.members['lst-hostile'] = ['lead-2'];
    const { user } = renderAt('/leads?list=lst-hostile');
    await waitFor(() => expect(hasRow('Leo')).toBe(true));
    expect(within(listSelect()).getByRole('option', { name: `${hostile} (1)` })).toBeInTheDocument();
    expect(screen.getByText(new RegExp('Showing members of <img'))).toBeInTheDocument();
    await user.click(rowBox('Leo'));
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    const menu = await screen.findByRole('menu', { name: 'Add to list' });
    expect(within(menu).getByRole('menuitem', { name: hostile })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: 'UK Angels' }));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    // The toast message is a plain string that the shell renders as a text node.
    expect(typeof pushToast.mock.calls[0]![0]).toBe('string');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
    expect(document.title).not.toBe('pwned');
    document.body.innerHTML = '';

    // The person sheet chip row.
    renderAt('/leads?person=lead-2');
    const sheet = await screen.findByRole('dialog', { name: 'Leo Example' });
    expect(await within(sheet).findByText(hostile)).toBeInTheDocument();
    expect(sheet.querySelector('img')).toBeNull();
  });
});

describe('chunked adds', () => {
  it('KILLS: when the second chunk of a 600 person add fails, the message says how many were added before the failure (500), and the retry reuses the list and reports them as already on it', async () => {
    world = freshWorld(597);
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(pageBox());
    expect(screen.getByText('600 selected')).toBeInTheDocument();
    let memberCalls = 0;
    world.fail = (call) => (call.method === 'POST' && call.path.endsWith('/members') && ++memberCalls === 2 ? failure(500, 'Something went wrong on the server.') : null);
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('menuitem', { name: 'New list' }));
    await user.type(screen.getByRole('textbox', { name: 'New list name' }), 'Big{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The list Big was created, but the add did not finish. 500 added before the failure.');
    const created = world.lists.find((list) => list.name === 'Big')!;
    expect(world.members[created.id]).toHaveLength(500);
    expect(pushToast).not.toHaveBeenCalled();
    expect(screen.getByText('600 selected')).toBeInTheDocument();
    // The retry reuses the created list: no second POST /lists, and the 500 that went in are reported as already on it.
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    expect(posts('/lists').map((call) => call.body.name)).toEqual(['Big']);
    expect(pushToast.mock.calls[0]![0]).toBe('Created Big. Added 100 people to Big. 500 were already on it.');
  }, 30_000);

  it('KILLS: a failing second chunk to an existing list reports how many were added before the failure', async () => {
    world = freshWorld(597);
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(pageBox());
    let memberCalls = 0;
    world.fail = (call) => (call.method === 'POST' && call.path.endsWith('/members') && ++memberCalls === 2 ? failure(500, 'Something went wrong on the server.') : null);
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('menuitem', { name: 'Energy investors' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('500 added before the failure. Try again.');
    expect(pushToast).not.toHaveBeenCalled();
  }, 30_000);

  it('KILLS: a 600 person add to an existing list goes in two calls of 500 and 100 and the toast sums added and already across them', async () => {
    world = freshWorld(597);
    world.members['lst-energy'] = ['bulk-0000', 'bulk-0001'];
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(pageBox());
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('menuitem', { name: 'Energy investors' }));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    expect(posts('/members').map((call) => call.body.personIds.length)).toEqual([500, 100]);
    expect(pushToast.mock.calls[0]![0]).toBe('Added 598 people to Energy investors. 2 were already on it.');
    expect(new Set(world.members['lst-energy']).size).toBe(600);
  }, 30_000);

  it('KILLS: after the new list was created but the add failed, the retry reuses the created list and never creates a second one of the same name', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Leo')).toBe(true));
    await user.click(rowBox('Leo'));
    let failed = false;
    world.fail = (call) => {
      if (!failed && call.method === 'POST' && call.path.endsWith('/members')) {
        failed = true;
        return failure(500, 'Something went wrong on the server.');
      }
      return null;
    };
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('menuitem', { name: 'New list' }));
    await user.type(screen.getByRole('textbox', { name: 'New list name' }), 'Fresh{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('The list Fresh was created, but nobody was added. Press Create again to retry, which reuses Fresh.');
    // The form stays with the name filled in, and Create again reuses the created list.
    expect(screen.getByRole('textbox', { name: 'New list name' })).toHaveValue('Fresh');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    expect(posts('/lists').map((call) => call.body.name)).toEqual(['Fresh']);
    expect(world.lists.filter((list) => list.name === 'Fresh')).toHaveLength(1);
  });

  it('KILLS: double clicking a list in the menu adds once', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Leo')).toBe(true));
    await user.click(rowBox('Leo'));
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    await user.dblClick(screen.getByRole('menuitem', { name: 'Energy investors' }));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    expect(posts('/members')).toHaveLength(1);
    expect(pushToast).toHaveBeenCalledTimes(1);
  });
});

describe('selection', () => {
  it('KILLS: the selection clears on a search change and on a tab change, and survives opening a person sheet', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(rowBox('Leo'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    // Opening a sheet from another row does not clear what was ticked.
    await user.click(screen.getByRole('row', { name: /Lia/ }));
    await screen.findByRole('dialog', { name: 'Lia Example' });
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: /Search people/ }), 'Le');
    await waitFor(() => expect(screen.queryByText(/selected/)).not.toBeInTheDocument());
    await user.clear(screen.getByRole('searchbox', { name: /Search people/ }));
    await waitFor(() => expect(hasRow('Lia')).toBe(true));

    await user.click(rowBox('Leo'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Organizations' }));
    await user.click(screen.getByRole('tab', { name: 'People' }));
    await waitFor(() => expect(hasRow('Leo')).toBe(true));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    expect(rowBox('Leo')).not.toBeChecked();
  });

  it('KILLS: a selected person who leaves the table (removed elsewhere) leaves the selection too, so the count never counts invisible rows', async () => {
    const { user } = renderAt('/leads?list=lst-angels');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(rowBox('Lena'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    world.members['lst-angels'] = [];
    act(() => FakeEventSource.instances[0]!.fire('record_updated'));
    await waitFor(() => expect(hasRow('Lena')).toBe(false));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });
});

describe('removing from a list', () => {
  it('KILLS: removing eight people runs at most six requests at once, a failure keeps exactly the failed rows selected, and the toast counts them', async () => {
    world = freshWorld(5);
    world.members['lst-angels'] = world.people.map((p) => p.id);
    world.deleteDelayMs = 15;
    const { user } = renderAt('/leads?list=lst-angels');
    await waitFor(() => expect(hasRow('Bulk0004')).toBe(true));
    world.fail = (call) =>
      call.method === 'DELETE' && (call.path.endsWith('/bulk-0001') || call.path.endsWith('/bulk-0003')) ? failure(500, 'Something went wrong on the server.') : null;
    await user.click(pageBox());
    expect(screen.getByText('8 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove from list' }));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    expect(world.maxInflight).toBeLessThanOrEqual(6);
    expect(world.maxInflight).toBeGreaterThan(1);
    expect(pushToast.mock.calls[0]).toEqual([
      'Removed 6 of 8 people from UK Angels. 2 could not be removed and stay selected. Try again.',
      'error',
    ]);
    await waitFor(() => expect(screen.getByText('2 selected')).toBeInTheDocument());
    expect(rowBox('Bulk0001')).toBeChecked();
    expect(rowBox('Bulk0003')).toBeChecked();
  }, 20_000);

  it('KILLS: removing from a list that was deleted elsewhere fails every row, keeps them all selected, and says so without throwing', async () => {
    const { user } = renderAt('/leads?list=lst-angels');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(rowBox('Lena'));
    delete world.members['lst-angels'];
    await user.click(screen.getByRole('button', { name: 'Remove from list' }));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    expect(pushToast.mock.calls[0]![0]).toMatch(/^Removed 0 of 1 person from UK Angels\. 1 could not be removed and stay selected/);
  });
});

describe('keyboard', () => {
  it('KILLS: the checkbox column keeps the grid one tab stop per row: only the active row box is tabbable, arrows move rows from a focused box, Space ticks without opening, Enter on the row opens', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Lia')).toBe(true));
    const boxes = () => ['Lena', 'Leo', 'Lia'].map((name) => rowBox(name).tabIndex);
    expect(boxes()).toEqual([0, -1, -1]);
    expect(pageBox().tabIndex).toBe(0);

    rowBox('Lena').focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('row', { name: /Leo/ }));
    expect(boxes()).toEqual([-1, 0, -1]);

    await user.tab();
    expect(document.activeElement).toBe(rowBox('Leo'));
    await user.keyboard(' ');
    expect(rowBox('Leo')).toBeChecked();
    expect(screen.getByTestId('where')).not.toHaveTextContent('person=');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('row', { name: /Lia/ }));
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('person=lead-3');
  });

  it('KILLS: Escape in the person sheet menu closes the menu and leaves the sheet open; a second Escape closes the sheet', async () => {
    const { user } = renderAt('/leads?person=lead-2');
    const sheet = await screen.findByRole('dialog', { name: 'Leo Example' });
    const row = within(sheet).getByText('Lists').closest('.field') as HTMLElement;
    await within(row).findByText('None');
    await user.click(within(row).getByRole('button', { name: 'Add to list' }));
    expect(await screen.findByRole('menu', { name: 'Add to list' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Leo Example' })).toBeInTheDocument();
    expect(document.activeElement).toBe(within(row).getByRole('button', { name: 'Add to list' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Leo Example' })).not.toBeInTheDocument());
  });

  it('KILLS: Escape in the New list form returns to the menu with focus on the New list item, so a second Escape closes the menu', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Leo')).toBe(true));
    await user.click(rowBox('Leo'));
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('menuitem', { name: 'New list' }));
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'New list name' }), '   ');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'New list name' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'New list' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(posts('/lists')).toHaveLength(0);
  });

  it('ACCEPTED: after a successful add from the header the menu button leaves with the selection, so focus falls to the page body. Moving focus to the table or the select would be kinder, but nothing in the contract asks for it', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Leo')).toBe(true));
    await user.click(rowBox('Leo'));
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('menuitem', { name: 'Energy investors' }));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(document.body);
  });

  it('KILLS: a list deleted in another tab while its rename sheet is open closes the sheet without a crash and without sending a rename', async () => {
    const { user } = renderAt('/leads?list=lst-angels');
    await waitFor(() => expect(hasRow('Lena')).toBe(true));
    await user.click(await screen.findByRole('button', { name: 'List actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename list' }));
    const sheet = await screen.findByRole('dialog', { name: 'Rename list' });
    await user.clear(within(sheet).getByRole('textbox', { name: 'Name' }));
    await user.type(within(sheet).getByRole('textbox', { name: 'Name' }), 'Typed but lost');
    world.lists = world.lists.filter((list) => list.id !== 'lst-angels');
    delete world.members['lst-angels'];
    act(() => FakeEventSource.instances[0]!.fire('record_updated'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename list' })).not.toBeInTheDocument());
    expect(world.calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(listSelect()).toHaveValue('');
  });

  it('ACCEPTED: a list name of only invisible characters enables Create (the server accepts it too), so a blank looking list can be made from the menu', async () => {
    const { user } = renderAt('/leads');
    await waitFor(() => expect(hasRow('Leo')).toBe(true));
    await user.click(rowBox('Leo'));
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('menuitem', { name: 'New list' }));
    await user.type(screen.getByRole('textbox', { name: 'New list name' }), '\u200B');
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });
});
