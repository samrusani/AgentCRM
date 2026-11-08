import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { Router } from './helpers';

vi.mock('../src/lib/ui', () => ({
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
vi.mock('../src/shell/AgentPanel', () => ({ AgentPanel: () => null }));
vi.mock('../src/shell/CommandPalette', () => ({ CommandPalette: () => null }));

const copy = 'AgentCRM was updated while this window was open. Quit and reopen the app to continue.';
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const staleBody = { error: { code: 'stale_server', message: 'Quit and reopen the app.' } };

// The flag is module level and permanent, so every test loads a fresh copy of the modules (real events module here).
async function load() {
  vi.resetModules();
  const client = await import('../src/api/client');
  const shell = await import('../src/shell/AppShell');
  const events = await import('../src/api/events');
  return { client, AppShell: shell.AppShell, events };
}

function shellTree(AppShell: () => JSX.Element, queryClient: QueryClient, extra: JSX.Element | null = null) {
  return (
    <QueryClientProvider client={queryClient}>
      <Router initialEntries={['/today']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="today" element={<div><p>Today screen content</p>{extra}</div>} />
          </Route>
        </Routes>
      </Router>
    </QueryClientProvider>
  );
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CLOSED = 2;
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: unknown = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {
    this.readyState = 2;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('banner from any surface', () => {
  it('a mutation answering stale_server flips the banner, with exactly one fetch and no retry', async () => {
    const fetchMock = vi.fn(async () => json(503, staleBody));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', FakeEventSource);
    const { client, AppShell } = await load();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: client.shouldRetryQuery } } });
    function Writer() {
      const mutation = useMutation({ mutationFn: () => client.api.lists.create('x') });
      return <button type="button" onClick={() => mutation.mutate()}>write</button>;
    }
    render(shellTree(AppShell, queryClient, <Writer />));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: 'write' }).click();
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(copy);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock.mock.calls.filter((call) => String((call as unknown[])[0]).includes('/lists'))).toHaveLength(1);
  });

  it('a 503 with another code (not stale_server) does not raise the banner and still retries once', async () => {
    const fetchMock = vi.fn(async () => json(503, { error: { code: 'internal', message: 'down' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = await load();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: client.shouldRetryQuery, retryDelay: 1 } } });
    function Probe() {
      const query = useQuery({ queryKey: ['health'], queryFn: client.api.health });
      return <p>{query.isError ? 'failed' : 'loading'}</p>;
    }
    const { result } = renderHook(() => client.useServerStale());
    render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(false);
  });

  it('stale_server on a non-503 status (a hypothetical proxy 500) still never retries; a plain network failure neither flags nor changes retry', async () => {
    const { client } = await load();
    const stale500 = new client.ApiError(500, 'stale_server', 'x');
    expect(client.shouldRetryQuery(0, stale500)).toBe(false);
    expect(client.shouldRetryQuery(0, new client.ApiError(500, 'internal', 'x'))).toBe(true);
    expect(client.shouldRetryQuery(1, new client.ApiError(500, 'internal', 'x'))).toBe(false);
    expect(client.shouldRetryQuery(0, new client.ApiError(0, 'network', 'x'))).toBe(true);
    expect(client.shouldRetryQuery(0, new client.ApiError(409, 'version_conflict', 'x'))).toBe(false);
    expect(client.shouldRetryQuery(0, new Error('boom'))).toBe(true);
    expect(client.shouldRetryQuery(1, new Error('boom'))).toBe(false);
  });
});

describe('the flag is permanent', () => {
  it('exports no way to reset or dismiss it, survives later 200s, a shell remount, and a fresh QueryClient', async () => {
    const answers: Response[] = [json(503, staleBody)];
    const fetchMock = vi.fn(async () => answers.shift() ?? json(200, { ok: true, version: '1', dbPath: 'x', stale: false }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', FakeEventSource);
    const { client, AppShell } = await load();
    expect(Object.keys(client).filter((name) => /stale|reset|dismiss/i.test(name)).sort()).toEqual(['useServerStale']);

    const first = render(shellTree(AppShell, new QueryClient({ defaultOptions: { queries: { retry: false } } })));
    await act(async () => {
      await client.api.health().catch(() => undefined);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(copy);
    // A good answer afterwards (the server somehow healthy) does not clear it.
    await act(async () => {
      await client.api.health();
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    first.unmount();
    render(shellTree(AppShell, new QueryClient()));
    expect(await screen.findByRole('alert')).toHaveTextContent(copy);
    expect(screen.queryAllByRole('alert')).toHaveLength(1);
    expect(screen.getByText('Today screen content')).toBeInTheDocument();
  });

  it('banner coexists with a screen rendering cached data (the cache is not cleared by the failure)', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('/workspace') ? json(503, staleBody) : json(200, { ok: true, version: '1', dbPath: 'x' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { client, AppShell } = await load();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: client.shouldRetryQuery } } });
    queryClient.setQueryData(['health'], { ok: true, version: 'cached', dbPath: 'x' });
    function Cached() {
      const query = useQuery({ queryKey: ['health'], queryFn: client.api.health, staleTime: Infinity });
      return <p>cached version {query.data?.version}</p>;
    }
    render(shellTree(AppShell, queryClient, <Cached />));
    await act(async () => {
      await client.api.workspace().catch(() => undefined);
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('cached version cached')).toBeInTheDocument();
  });
});

describe('event stream against a stale server (REPORT ONLY)', () => {
  it('a 503 on /api/events makes EventSource close for good; the hook reopens with capped backoff (1,2,4,8,15,15 s) and connection reads down, banner absent until a query answers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {})));
    const { AppShell, events } = await load();
    const queryClient = new QueryClient();
    const states: string[] = [];
    function Conn() {
      states.push(events.useEventConnection());
      return null;
    }
    render(shellTree(AppShell, queryClient, <Conn />));
    expect(FakeEventSource.instances).toHaveLength(1);
    const failAndCount = async (waitMs: number, expectedInstances: number) => {
      const source = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
      source.readyState = 2; // the browser closes the stream for good on a non-200
      act(() => source.onerror?.());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(waitMs);
      });
      expect(FakeEventSource.instances).toHaveLength(expectedInstances);
    };
    await failAndCount(999, 1);
    await failAndCount(1, 2);
    await failAndCount(2000, 3);
    await failAndCount(4000, 4);
    await failAndCount(8000, 5);
    await failAndCount(15000, 6);
    await failAndCount(14999, 6);
    await failAndCount(1, 7);
    expect(events.useEventConnection).toBeTypeOf('function');
    expect(states).toContain('down');
    // The stream alone never raises the banner: EventSource cannot read the 503 body.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Report: once down, hooks with refetchInterval (e.g. useToday, 5 s) keep polling a stale server; each answers
    // 503 once, never retried by react-query, but the interval repeats while connection != open.
  });
});
