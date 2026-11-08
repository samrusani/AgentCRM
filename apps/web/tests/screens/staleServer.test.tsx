import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
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

const copy = 'AgentCRM was updated while this window was open. Quit and reopen the app to continue.';
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const staleBody = { error: { code: 'stale_server', message: 'Quit and reopen the app.' } };

// The flag is module level and permanent, so every test loads a fresh copy of the modules.
async function load() {
  vi.resetModules();
  const client = await import('../../src/api/client');
  const shell = await import('../../src/shell/AppShell');
  return { client, AppShell: shell.AppShell };
}

function renderShell(AppShell: () => JSX.Element, queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Router initialEntries={['/today']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="today" element={<p>Today screen content</p>} />
          </Route>
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stale server banner', () => {
  it('shows nothing before any stale_server answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { id: 'w', name: 'Workspace', version: 1 })));
    const { client, AppShell } = await load();
    renderShell(AppShell, new QueryClient({ defaultOptions: { queries: { retry: client.shouldRetryQuery } } }));
    expect(screen.getByText('Today screen content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the exact copy as an alert with no dismiss control once a request answers stale_server, and keeps the screen', async () => {
    const fetchMock = vi.fn(async () => json(503, staleBody));
    vi.stubGlobal('fetch', fetchMock);
    const { client, AppShell } = await load();
    renderShell(AppShell, new QueryClient({ defaultOptions: { queries: { retry: client.shouldRetryQuery } } }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy);
    expect(alert.textContent).toBe(copy);
    expect(alert.querySelector('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /dismiss|close/i })).not.toBeInTheDocument();
    expect(screen.getByText('Today screen content')).toBeInTheDocument();
  });

  it('sets the flag when a query error carries stale_server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(503, staleBody)));
    const { client, AppShell } = await load();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderShell(AppShell, queryClient);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => {
      await queryClient.fetchQuery({ queryKey: ['health'], queryFn: client.api.health }).catch(() => undefined);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(copy);
  });

  it('does not retry a query that answers stale_server', async () => {
    const fetchMock = vi.fn(async () => json(503, staleBody));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = await load();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: client.shouldRetryQuery, retryDelay: 1 } } });
    function Probe() {
      const query = useQuery({ queryKey: ['health'], queryFn: client.api.health });
      return <p>{query.isError ? 'failed' : 'loading'}</p>;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries other server errors once', async () => {
    const fetchMock = vi.fn(async () => json(500, { error: { code: 'internal', message: 'Something went wrong on the server.' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = await load();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: client.shouldRetryQuery, retryDelay: 1 } } });
    function Probe() {
      const query = useQuery({ queryKey: ['health'], queryFn: client.api.health });
      return <p>{query.isError ? 'failed' : 'loading'}</p>;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry 4xx answers', async () => {
    const fetchMock = vi.fn(async () => json(404, { error: { code: 'not_found', message: 'Not found.' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = await load();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: client.shouldRetryQuery, retryDelay: 1 } } });
    await queryClient.fetchQuery({ queryKey: ['health'], queryFn: client.api.health, retry: client.shouldRetryQuery, retryDelay: 1 }).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
