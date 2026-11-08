import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Pipeline } from '../../src/screens/Pipeline';
import { Leads, Relationships } from '../../src/screens/Relationships';
import { viewUrl } from '../../src/lib/views';
import { Router } from '../helpers';

const pushToast = vi.fn();
vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: (...args: unknown[]) => pushToast(...args), toasts: [], dismissToast: () => {}, theme: 'system', setTheme: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../../src/api/events', () => ({
  useServerEvents: () => {},
  useEventConnection: () => 'open',
}));

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: any;
}

interface Saved {
  id: string;
  name: string;
  screen: string;
  config: Record<string, string>;
  version: number;
}

let calls: Call[];
let views: Saved[];
let failure: { status: number; code: string; message: string } | null;

const json = (status: number, body: unknown): Response =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const pipelineRecord = (id: string, name: string) => ({
  id,
  workspaceId: 'ws-1',
  name,
  template: 'startup-fundraising',
  version: 1,
  stages: ['Research', 'Qualified'].map((stageName, index) => ({ id: `${id}-s${index + 1}`, pipelineId: id, name: stageName, seq: index + 1 })),
});

const opportunity = (id: string, name: string, pipelineId: string, status = 'open') => ({
  id, version: 1, name, pipelineId, stageId: `${pipelineId}-s1`, organizationId: null, personId: null, amountTarget: null, currency: 'USD',
  owner: null, status, reason: null, nextActionAt: null, stageChangedAt: null, createdAt: '2026-11-02T10:00:00', updatedAt: '2026-11-02T10:00:00',
});

beforeEach(() => {
  calls = [];
  failure = null;
  pushToast.mockClear();
  views = [
    { id: 'svw-1', name: 'UK angels', screen: 'leads', config: { q: 'fund', list: 'lst-1', sort: 'fit' }, version: 1 },
    { id: 'svw-2', name: 'Gone list', screen: 'leads', config: { list: 'lst-deleted', tab: 'organizations' }, version: 1 },
    { id: 'svw-3', name: 'Warm', screen: 'relationships', config: { q: 'warm' }, version: 1 },
    { id: 'svw-4', name: 'UK table', screen: 'pipeline', config: { pipeline: 'uk', status: 'all', view: 'table' }, version: 1 },
    { id: 'svw-5', name: 'Gone pipeline', screen: 'pipeline', config: { pipeline: 'pln-deleted', view: 'table' }, version: 1 },
  ];
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, search: url.searchParams, body: payload });
      const p = url.pathname;
      if (p === '/api/views' && method === 'GET') return json(200, { items: views.filter((view) => view.screen === url.searchParams.get('screen')), nextCursor: null });
      if (p.startsWith('/api/views') && method !== 'GET' && failure) return json(failure.status, { error: { code: failure.code, message: failure.message } });
      if (p === '/api/views' && method === 'POST') {
        const created = { id: `svw-new-${views.length}`, version: 1, ...payload };
        views = [...views, created];
        return json(201, created);
      }
      const match = /^\/api\/views\/([^/]+)$/.exec(p);
      if (match && method === 'PATCH') {
        const target = views.find((view) => view.id === match[1])!;
        if (payload.expectedVersion !== target.version) return json(409, { error: { code: 'version_conflict', message: 'This record changed since you loaded it.', current: target } });
        Object.assign(target, payload.fields, { version: target.version + 1 });
        return json(200, target);
      }
      if (match && method === 'DELETE') {
        views = views.filter((view) => view.id !== match[1]);
        return new Response(null, { status: 204 });
      }
      if (p === '/api/people' || p === '/api/organizations') return json(200, { items: [], nextCursor: null });
      if (p === '/api/lists') return json(200, { items: [{ id: 'lst-1', name: 'UK Angels', version: 1, memberCount: 0, createdAt: '2026-11-01T00:00:00', updatedAt: '2026-11-01T00:00:00' }], nextCursor: null });
      if (p === '/api/mail/provider' || p.startsWith('/api/connectors')) return json(200, { ready: false });
      if (p === '/api/pipelines') return json(200, { items: [pipelineRecord('us', 'US pipeline'), pipelineRecord('uk', 'UK pipeline')], nextCursor: null });
      if (p === '/api/opportunities') {
        const all = [opportunity('o1', 'Acme round', 'us'), opportunity('o2', 'Lantern fund', 'uk'), opportunity('o3', 'Old deal', 'uk', 'lost')];
        const status = url.searchParams.get('status');
        const pipelineId = url.searchParams.get('pipelineId');
        return json(200, { items: all.filter((item) => (!pipelineId || item.pipelineId === pipelineId) && (!status || item.status === status)), nextCursor: null });
      }
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}
const where = () => screen.getByTestId('where').textContent;

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
          <Route path="/pipeline" element={<Pipeline />} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

const viewsSelect = () => screen.getByRole('combobox', { name: 'Saved views' }) as HTMLSelectElement;
const posts = () => calls.filter((call) => call.method === 'POST' && call.path === '/api/views');

describe('the Views select', () => {
  it('lists the screen\'s views after the placeholder, applies one by navigating, and returns to the placeholder', async () => {
    const { user } = renderAt('/leads?person=p1&import=csv');
    await within(viewsSelect()).findByRole('option', { name: 'UK angels' });
    const names = within(viewsSelect()).getAllByRole('option').map((option) => option.textContent);
    expect(names).toEqual(['Views', 'UK angels', 'Gone list', 'Manage']);
    expect(viewsSelect().value).toBe('');
    expect(calls.some((call) => call.path === '/api/views' && call.search.get('screen') === 'leads')).toBe(true);

    await user.selectOptions(viewsSelect(), 'UK angels');
    // Built from the whitelist only: the open person and the import sheet are gone.
    await waitFor(() => expect(where()).toBe('/leads?q=fund&list=lst-1&sort=fit'));
    expect(viewsSelect().value).toBe('');
    expect(screen.getByRole('searchbox')).toHaveValue('fund');
    expect(await screen.findByRole('combobox', { name: 'List' })).toHaveValue('lst-1');
  });

  it('applies a view whose list no longer exists without crashing, falling back to All lists', async () => {
    const { user } = renderAt('/leads');
    await within(viewsSelect()).findByRole('option', { name: 'Gone list' });
    await user.selectOptions(viewsSelect(), 'Gone list');
    await waitFor(() => expect(where()).toBe('/leads?tab=organizations&list=lst-deleted'));
    expect(await screen.findByRole('tab', { name: 'Organizations', selected: true })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'People' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'List' })).toHaveValue(''));
  });

  it('keeps each people screen to its own views', async () => {
    const { user } = renderAt('/relationships');
    await within(viewsSelect()).findByRole('option', { name: 'Warm' });
    expect(within(viewsSelect()).queryByRole('option', { name: 'UK angels' })).not.toBeInTheDocument();
    await user.selectOptions(viewsSelect(), 'Warm');
    await waitFor(() => expect(where()).toBe('/relationships?q=warm'));
  });

  it('only ever builds an address from the whitelist', () => {
    expect(viewUrl('leads', { q: 'a b&c', sort: 'fit', person: 'p1', import: 'csv', tab: 'deals', list: '' })).toBe('/leads?q=a+b%26c&sort=fit');
    expect(viewUrl('pipeline', { pipeline: 'uk', status: 'won', view: 'table', opportunity: 'o1' })).toBe('/pipeline?pipeline=uk&view=table');
    expect(viewUrl('relationships', {})).toBe('/relationships');
    expect(viewUrl('relationships', { q: 'x'.repeat(257) })).toBe('/relationships');
  });
});

describe('Save view', () => {
  it('saves the current people state with a plain sentence and the whitelisted config', async () => {
    const { user } = renderAt('/leads?list=lst-1&sort=fit&person=p9');
    await within(screen.getByRole('combobox', { name: 'List' })).findByRole('option', { name: 'UK Angels (0)' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'List' })).toHaveValue('lst-1'));
    await user.type(screen.getByRole('searchbox'), 'fund');
    await user.click(screen.getByRole('button', { name: 'Save view' }));
    const sheet = await screen.findByRole('dialog', { name: 'Save view' });
    expect(within(sheet).getByText("People tab, search 'fund', filtered to UK Angels, sorted by fit.")).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText('Name'), '  Fund angels ');
    await user.click(within(sheet).getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ name: 'Fund angels', screen: 'leads', config: { q: 'fund', list: 'lst-1', sort: 'fit' } });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save view' })).not.toBeInTheDocument());
    expect(pushToast).toHaveBeenCalledWith('Saved view Fund angels.');
    expect(await within(viewsSelect()).findByRole('option', { name: 'Fund angels' })).toBeInTheDocument();
  });

  it('allows saving with no filters and says it opens the plain screen', async () => {
    const { user } = renderAt('/relationships');
    await user.click(screen.getByRole('button', { name: 'Save view' }));
    const sheet = await screen.findByRole('dialog', { name: 'Save view' });
    expect(within(sheet).getByText('Opens the plain Relationships screen.')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Save view' })).toBeDisabled();
    await user.type(within(sheet).getByLabelText('Name'), 'Everyone');
    await user.click(within(sheet).getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(posts()[0]!.body).toEqual({ name: 'Everyone', screen: 'relationships', config: {} }));
  });

  it('shows the server refusal and keeps the sheet open', async () => {
    failure = { status: 400, code: 'validation', message: 'The name cannot contain control characters' };
    const { user } = renderAt('/leads');
    await user.click(screen.getByRole('button', { name: 'Save view' }));
    const sheet = await screen.findByRole('dialog', { name: 'Save view' });
    await user.type(within(sheet).getByLabelText('Name'), 'Bad');
    await user.click(within(sheet).getByRole('button', { name: 'Save view' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('The view was not saved.');
    expect(screen.getByRole('dialog', { name: 'Save view' })).toBeInTheDocument();
  });
});

describe('Manage', () => {
  it('renames a view and deletes one after an inline confirm', async () => {
    const { user } = renderAt('/leads');
    await within(viewsSelect()).findByRole('option', { name: 'UK angels' });
    await user.selectOptions(viewsSelect(), 'Manage');
    const sheet = await screen.findByRole('dialog', { name: 'Manage views' });
    expect(viewsSelect().value).toBe('');
    expect(where()).toBe('/leads');

    await user.click(within(sheet).getByRole('button', { name: 'Rename UK angels' }));
    const input = within(sheet).getByLabelText('Name for UK angels');
    await user.clear(input);
    await user.type(input, 'EU angels');
    await user.click(within(sheet).getByRole('button', { name: 'Rename view' }));
    expect(await within(sheet).findByText('EU angels')).toBeInTheDocument();
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.path).toBe('/api/views/svw-1');
    expect(patch.body).toEqual({ expectedVersion: 1, fields: { name: 'EU angels' } });

    await user.click(within(sheet).getByRole('button', { name: 'Delete Gone list' }));
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(within(sheet).getByRole('alert')).toHaveTextContent('Delete Gone list? Only the view is removed.');
    await user.click(within(sheet).getByRole('button', { name: 'Keep view' }));
    expect(within(sheet).getByText('Gone list')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Delete Gone list' }));
    await user.click(within(sheet).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(within(sheet).queryByText('Gone list')).not.toBeInTheDocument());
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/api/views/svw-2']);
    expect(within(sheet).getByText('EU angels')).toBeInTheDocument();
  });

  it('names a version conflict on rename and writes nothing', async () => {
    const { user } = renderAt('/relationships');
    await within(viewsSelect()).findByRole('option', { name: 'Warm' });
    await user.selectOptions(viewsSelect(), 'Manage');
    const sheet = await screen.findByRole('dialog', { name: 'Manage views' });
    await user.click(within(sheet).getByRole('button', { name: 'Rename Warm' }));
    // Another tab bumped the version after the list loaded but before this rename started: the stale version conflicts.
    views = views.map((view) => (view.id === 'svw-3' ? { ...view, version: 5 } : view));
    const input = within(sheet).getByLabelText('Name for Warm');
    await user.clear(input);
    await user.type(input, 'Hot');
    await user.click(within(sheet).getByRole('button', { name: 'Rename view' }));
    expect(await within(sheet).findByText(/changed since you started/)).toBeInTheDocument();
  });
});

describe('Pipeline views and the URL', () => {
  it('rides the board or table choice and the status on the URL, falling back to board and Open', async () => {
    const { user } = renderAt('/pipeline?pipeline=uk&view=table&status=lost');
    const table = await screen.findByRole('grid', { name: 'Opportunities' });
    await waitFor(() => expect(table).toHaveAttribute('aria-rowcount', '2'));
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('lost');
    expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Board' }));
    expect(where()).toBe('/pipeline?pipeline=uk&view=board&status=lost');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'all');
    expect(where()).toBe('/pipeline?pipeline=uk&view=board&status=all');
  });

  it('treats unknown view and status values as the board and Open', async () => {
    renderAt('/pipeline?view=kanban&status=won');
    expect(await screen.findByRole('button', { name: 'Board' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('open');
  });

  it('saves the pipeline, status, and view and applies them', async () => {
    const { user } = renderAt('/pipeline?pipeline=uk&status=all&view=table');
    await screen.findByRole('grid', { name: 'Opportunities' });
    await user.click(screen.getByRole('button', { name: 'Save view' }));
    const sheet = await screen.findByRole('dialog', { name: 'Save view' });
    expect(within(sheet).getByText('UK pipeline, all statuses, table view.')).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText('Name'), 'Everything UK');
    await user.click(within(sheet).getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(posts()[0]!.body).toEqual({ name: 'Everything UK', screen: 'pipeline', config: { pipeline: 'uk', status: 'all', view: 'table' } }));

    await user.click(screen.getByRole('button', { name: 'Board' }));
    await user.selectOptions(viewsSelect(), 'UK table');
    await waitFor(() => expect(where()).toBe('/pipeline?pipeline=uk&status=all&view=table'));
    expect(viewsSelect().value).toBe('');
    expect(await screen.findByRole('grid', { name: 'Opportunities' })).toBeInTheDocument();
  });

  it('applies a view whose pipeline no longer exists by falling back to the first pipeline', async () => {
    const { user } = renderAt('/pipeline?pipeline=uk');
    await screen.findByRole('combobox', { name: 'Saved views' });
    await within(viewsSelect()).findByRole('option', { name: 'Gone pipeline' });
    await user.selectOptions(viewsSelect(), 'Gone pipeline');
    await waitFor(() => expect(where()).toBe('/pipeline?pipeline=pln-deleted&view=table'));
    expect(screen.getByRole('combobox', { name: 'Pipeline' })).toHaveValue('us');
    expect(await screen.findByRole('grid', { name: 'Opportunities' })).toBeInTheDocument();
  });
});
