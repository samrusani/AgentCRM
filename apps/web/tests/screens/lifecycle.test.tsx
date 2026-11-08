import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Leads, Relationships } from '../../src/screens/Relationships';
import { AppShell } from '../../src/shell/AppShell';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({
    theme: 'system',
    setTheme: () => {},
    navCollapsed: false,
    setNavCollapsed: () => {},
    navNarrow: false,
    setSelectedRecord: () => {},
    setPaletteOpen: () => {},
    panelCollapsed: true,
    setPanelCollapsed: () => {},
    panelSheetOpen: false,
    setPanelSheetOpen: () => {},
    toasts: [],
    dismissToast: () => {},
    pushToast: () => {},
  }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../../src/api/events', () => ({
  useServerEvents: () => {},
  useEventConnection: () => 'open',
}));
vi.mock('../../src/shell/AgentPanel', () => ({ AgentPanel: () => null }));
vi.mock('../../src/shell/CommandPalette', () => ({ CommandPalette: () => null }));

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: any;
}

let calls: Call[];
let people: Record<string, any>;
let emptyLists: boolean;
let patchConflict: boolean;
let nextId: number;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function personRecord(id: string, lifecycle: 'lead' | 'relationship', first: string) {
  return {
    id,
    version: 1,
    lifecycle,
    firstName: first,
    lastName: 'Example',
    email: null,
    title: null,
    organizationId: null,
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

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, search: url.searchParams, body });
      if (url.pathname === '/api/people' && method === 'GET') {
        const wanted = url.searchParams.get('lifecycle');
        const items = emptyLists ? [] : Object.values(people).filter((p) => !wanted || p.lifecycle === wanted);
        return json(200, { items, nextCursor: null });
      }
      if (url.pathname === '/api/people' && method === 'POST') {
        const id = `person-new-${nextId++}`;
        people[id] = { ...personRecord(id, body.lifecycle ?? 'lead', body.firstName), ...body };
        return json(201, people[id]);
      }
      if (url.pathname === '/api/organizations' && method === 'GET') return json(200, { items: [], nextCursor: null });
      const match = url.pathname.match(/^\/api\/people\/([^/]+)$/);
      if (match && people[match[1]]) {
        const id = match[1];
        if (method === 'GET') return json(200, people[id]);
        if (method === 'PATCH') {
          if (patchConflict) {
            patchConflict = false;
            people[id] = { ...people[id], version: people[id].version + 1 };
            return json(409, { error: { code: 'version_conflict', message: 'Version conflict.' }, current: people[id] });
          }
          people[id] = { ...people[id], ...body.fields, version: people[id].version + 1 };
          return json(200, people[id]);
        }
      }
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function renderAt(entry: string) {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[entry]}>
        <Where />
        <Routes>
          <Route path="/leads" element={<Leads />} />
          <Route path="/relationships" element={<Relationships />} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

const LEADS_LINE = 'People you have imported or captured but not yet talked to.';
const RELATIONSHIPS_LINE = 'People you have a real interaction with: they replied, or a deal is moving.';

function listCalls(path: string) {
  return calls.filter((call) => call.method === 'GET' && call.path === path);
}

beforeEach(() => {
  calls = [];
  emptyLists = false;
  patchConflict = false;
  nextId = 1;
  people = {
    'lead-1': personRecord('lead-1', 'lead', 'Lena'),
    'rel-1': personRecord('rel-1', 'relationship', 'Ravi'),
  };
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Nav rail', () => {
  it('lists Leads between Today and Relationships and links to /leads', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Router initialEntries={['/today']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/today" element={<p>Today screen</p>} />
            </Route>
          </Routes>
        </Router>
      </QueryClientProvider>,
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const labels = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(labels).toEqual(['Today', 'Leads', 'Relationships', 'Pipeline', 'Meetings', 'Reports', 'Research', 'Settings']);
    expect(within(nav).getByRole('link', { name: 'Leads' })).toHaveAttribute('href', '/leads');
  });
});

describe('Leads and Relationships framing', () => {
  it('Leads shows its muted line and asks for lifecycle=lead for people', async () => {
    renderAt('/leads');
    expect(screen.getByRole('heading', { name: 'Leads', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(LEADS_LINE)).toBeInTheDocument();
    await waitFor(() => expect(listCalls('/api/people').length).toBeGreaterThan(0));
    expect(listCalls('/api/people').every((call) => call.search.get('lifecycle') === 'lead')).toBe(true);
  });

  it('Relationships shows its muted line and asks for lifecycle=relationship for people', async () => {
    renderAt('/relationships');
    expect(screen.getByRole('heading', { name: 'Relationships', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(RELATIONSHIPS_LINE)).toBeInTheDocument();
    await waitFor(() => expect(listCalls('/api/people').length).toBeGreaterThan(0));
    expect(listCalls('/api/people').every((call) => call.search.get('lifecycle') === 'relationship')).toBe(true);
  });

  it('filters organizations by the same lifecycle on the Organizations tab', async () => {
    renderAt('/leads?tab=organizations');
    await waitFor(() => expect(listCalls('/api/organizations').length).toBeGreaterThan(0));
    expect(listCalls('/api/organizations').every((call) => call.search.get('lifecycle') === 'lead')).toBe(true);
  });

  it('asks for relationship organizations on /relationships', async () => {
    renderAt('/relationships?tab=organizations');
    await waitFor(() => expect(listCalls('/api/organizations').length).toBeGreaterThan(0));
    expect(listCalls('/api/organizations').every((call) => call.search.get('lifecycle') === 'relationship')).toBe(true);
  });

  it('switches tabs and keeps the tab query param on both routes', async () => {
    const { user } = renderAt('/leads');
    await user.click(screen.getByRole('tab', { name: 'Organizations' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/leads?tab=organizations');
    expect(screen.getByRole('tab', { name: 'Organizations' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the CSV import sheet from the import query param on Leads', async () => {
    renderAt('/leads?import=csv');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('Empty states', () => {
  beforeEach(() => {
    emptyLists = true;
  });

  it('invites an import on an empty Leads screen', async () => {
    const { user } = renderAt('/leads');
    expect(await screen.findByText(/^No leads yet\./)).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Import CSV' });
    expect(buttons.length).toBe(2);
    await user.click(buttons[1]);
    expect(screen.getByTestId('where')).toHaveTextContent('/leads?tab=people&import=csv');
  });

  it('says leads graduate here on an empty Relationships screen', async () => {
    renderAt('/relationships');
    expect(
      await screen.findByText('No relationships yet. Leads graduate here when someone replies or a deal moves.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Import CSV' })).toHaveLength(1);
  });

  it('keeps the search message when a search finds nothing', async () => {
    const { user } = renderAt('/leads');
    await screen.findByText(/^No leads yet\./);
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(await screen.findByText(/No people match "zzz"/)).toBeInTheDocument();
  });
});

describe('Person sheet lifecycle row', () => {
  it('shows Lead with a Mark as relationship action and PATCHes the current version', async () => {
    const { user } = renderAt('/leads?tab=people&person=lead-1');
    const sheet = await screen.findByRole('dialog', { name: 'Lena Example' });
    const row = within(sheet).getByText('Lifecycle').closest('.field') as HTMLElement;
    expect(within(row).getByText('Lead')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Mark as relationship' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.path).toBe('/api/people/lead-1');
    expect(patch.body).toEqual({ expectedVersion: 1, fields: { lifecycle: 'relationship' } });
    expect(await within(row).findByText('Relationship')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Move to leads' })).toBeInTheDocument();
    // The sheet stays open and the lists refetch.
    expect(screen.getByRole('dialog', { name: 'Lena Example' })).toBeInTheDocument();
  });

  it('shows Relationship with a Move to leads action and PATCHes lifecycle lead', async () => {
    const { user } = renderAt('/relationships?tab=people&person=rel-1');
    const sheet = await screen.findByRole('dialog', { name: 'Ravi Example' });
    const row = within(sheet).getByText('Lifecycle').closest('.field') as HTMLElement;
    expect(within(row).getByText('Relationship')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Move to leads' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      expectedVersion: 1,
      fields: { lifecycle: 'lead' },
    });
    expect(await within(row).findByRole('button', { name: 'Mark as relationship' })).toBeInTheDocument();
  });

  it('refetches the people lists after a change so the tables move the row', async () => {
    const { user } = renderAt('/leads?tab=people&person=lead-1');
    await screen.findByRole('dialog', { name: 'Lena Example' });
    const before = listCalls('/api/people').length;
    await user.click(screen.getByRole('button', { name: 'Mark as relationship' }));
    await waitFor(() => expect(listCalls('/api/people').length).toBeGreaterThan(before));
  });

  it('explains a version conflict, loads the latest version, and succeeds on retry', async () => {
    patchConflict = true;
    const { user } = renderAt('/leads?tab=people&person=lead-1');
    await screen.findByRole('dialog', { name: 'Lena Example' });
    await user.click(screen.getByRole('button', { name: 'Mark as relationship' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed since you opened');
    await user.click(await screen.findByRole('button', { name: 'Mark as relationship' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2));
    expect(calls.filter((call) => call.method === 'PATCH')[1].body.expectedVersion).toBe(2);
  });
});

describe('Deep links', () => {
  it('opens a lead sheet from /relationships even though the table filters to relationships', async () => {
    renderAt('/relationships?tab=people&person=lead-1');
    const sheet = await screen.findByRole('dialog', { name: 'Lena Example' });
    expect(within(sheet).getByText('Mark as relationship')).toBeInTheDocument();
  });

  it('opens a relationship sheet from /leads', async () => {
    renderAt('/leads?tab=people&person=rel-1');
    const sheet = await screen.findByRole('dialog', { name: 'Ravi Example' });
    expect(within(sheet).getByText('Move to leads')).toBeInTheDocument();
  });
});

describe('New person form', () => {
  it('defaults Lifecycle to Relationship and offers Lead', async () => {
    const { user } = renderAt('/leads');
    await user.click(screen.getByRole('button', { name: 'New person' }));
    const select = screen.getByRole('combobox', { name: 'Lifecycle' });
    expect(select).toHaveValue('relationship');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Relationship', 'Lead']);
  });

  it('creates with the default lifecycle and opens the new person sheet', async () => {
    const { user } = renderAt('/leads');
    await user.click(screen.getByRole('button', { name: 'New person' }));
    await user.type(screen.getByLabelText('First name'), 'Nia');
    await user.type(screen.getByLabelText('Last name'), 'Sample');
    await user.click(screen.getByRole('button', { name: 'Create person' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.path).toBe('/api/people');
    expect(post.body).toEqual({ firstName: 'Nia', lastName: 'Sample', lifecycle: 'relationship' });
    // Opens even though a relationship is hidden from the Leads table.
    expect(await screen.findByRole('dialog', { name: 'Nia Sample' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('person=person-new-1');
  });

  it('creates a lead when Lead is chosen', async () => {
    const { user } = renderAt('/relationships');
    await user.click(screen.getByRole('button', { name: 'New person' }));
    await user.type(screen.getByLabelText('First name'), 'Omar');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Lifecycle' }), 'lead');
    await user.click(screen.getByRole('button', { name: 'Create person' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ firstName: 'Omar', lifecycle: 'lead' });
  });

  it('asks for a first name before sending anything', async () => {
    const { user } = renderAt('/leads');
    await user.click(screen.getByRole('button', { name: 'New person' }));
    await user.click(screen.getByRole('button', { name: 'Create person' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a first name.');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });
});
