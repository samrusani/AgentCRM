import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { Research } from '../../src/screens/Research';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({ pushToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../../src/api/events', () => ({
  useServerEvents: () => {},
  useEventConnection: () => 'open',
}));
vi.mock('../../src/screens/LeadCaptureCard', () => ({ LeadCaptureCard: () => null }));
vi.mock('../../src/screens/TranscriptCaptureCard', () => ({ TranscriptCaptureCard: () => null }));

type Status = 'queued' | 'running' | 'waiting_approval' | 'paused' | 'succeeded' | 'failed';

function run(id: string, status: Status, minute: number) {
  return {
    id,
    kind: 'demo_research',
    title: `Run ${id}`,
    status,
    scope: {},
    counts: { processed: 0, found: 0, flagged: 0 },
    startedAt: `2026-11-01T10:${String(minute).padStart(2, '0')}:00`,
    finishedAt: null,
    createdAt: `2026-11-01T10:${String(minute).padStart(2, '0')}:00`,
    steps: [],
    approvals: [],
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let pages: Record<string, { items: any[]; nextCursor: string | null }>;
let byId: Record<string, any>;
let listCalls: URLSearchParams[];
let holdSecond: Promise<void> | null;

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/runs') {
        listCalls.push(url.searchParams);
        const cursor = url.searchParams.get('cursor') ?? '';
        if (cursor && holdSecond) await holdSecond;
        return json(200, pages[cursor]);
      }
      const match = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (match && byId[match[1]]) return json(200, byId[match[1]]);
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

function setPages(first: any[], second?: any[]) {
  pages = { '': { items: first, nextCursor: second ? 'c2' : null } };
  if (second) pages.c2 = { items: second, nextCursor: null };
  byId = Object.fromEntries([...first, ...(second ?? [])].map((r) => [r.id, r]));
}

function finished(count: number, from = 0) {
  return Array.from({ length: count }, (_, i) => run(`f${from + i}`, 'succeeded', 50 - from - i));
}

function renderAt(entry = '/research') {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[entry]}>
        <Routes>
          <Route path="/research" element={<Research />} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
  return { user, client };
}

const list = () => screen.getByRole('navigation', { name: 'Runs' });
const rows = () => within(list()).queryAllByRole('listitem');
const disclosure = () => within(list()).queryByRole('button', { name: 'Older runs' });
const more = () => within(list()).queryByRole('button', { name: /Show older runs|Loading/ });

beforeEach(() => {
  listCalls = [];
  holdSecond = null;
  setPages([]);
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('run list partition', () => {
  it('shows 8 finished runs and a collapsed Older runs row for 10 finished runs', async () => {
    setPages(finished(10));
    const { user } = renderAt();
    await screen.findByRole('navigation', { name: 'Runs' });
    await waitFor(() => expect(rows()).toHaveLength(8));
    const toggle = disclosure();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(more()).toBeNull();
    await user.click(toggle!);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(rows()).toHaveLength(10);
    await user.click(toggle!);
    expect(rows()).toHaveLength(8);
  });

  it('has no disclosure when everything fits in 8 rows', async () => {
    setPages(finished(8));
    renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    expect(disclosure()).toBeNull();
  });

  it('renders every open run beyond 8 and hides all finished runs', async () => {
    setPages([...Array.from({ length: 9 }, (_, i) => run(`o${i}`, 'running', 59 - i)), ...finished(3)]);
    const { user } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(9));
    expect(within(list()).queryByText('Run f0')).toBeNull();
    await user.click(disclosure()!);
    expect(rows()).toHaveLength(12);
  });

  it('never hides an open run, even one listed after many finished runs', async () => {
    setPages([...finished(9), run('q1', 'queued', 5), run('w1', 'waiting_approval', 4), run('p1', 'paused', 3)]);
    renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    expect(within(list()).getByText('Run q1')).toBeInTheDocument();
    expect(within(list()).getByText('Run w1')).toBeInTheDocument();
    // A paused run needs the user, so it is open too and never folds into the history.
    expect(within(list()).getByText('Run p1')).toBeInTheDocument();
    // Three open runs take three slots, so five finished runs fill the rest, in newest first order.
    expect(within(list()).getByText('Run f4')).toBeInTheDocument();
    expect(within(list()).queryByText('Run f5')).toBeNull();
  });

  it('keeps the list in server order', async () => {
    setPages([run('a', 'succeeded', 9), run('b', 'running', 8), run('c', 'succeeded', 7)]);
    renderAt();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().map((row) => within(row).getByText(/^Run /).textContent)).toEqual(['Run a', 'Run b', 'Run c']);
  });
});

describe('older runs disclosure and paging', () => {
  it('collapses on every mount', async () => {
    setPages(finished(10));
    const first = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    await first.user.click(disclosure()!);
    expect(rows()).toHaveLength(10);
    document.body.innerHTML = '';
    renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the disclosure when only another page exists, and appends the next page on click', async () => {
    setPages(finished(6), finished(5, 6));
    const { user } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(6));
    expect(disclosure()).toBeInTheDocument();
    expect(more()).toBeNull();
    await user.click(disclosure()!);
    expect(listCalls).toHaveLength(1);
    await user.click(more()!);
    await waitFor(() => expect(rows()).toHaveLength(11));
    expect(listCalls[1]?.get('cursor')).toBe('c2');
    expect(more()).toBeNull();
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
  });

  it('disables the button with Loading... while the next page is in flight', async () => {
    setPages(finished(10), finished(2, 10));
    let release!: () => void;
    holdSecond = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    await user.click(disclosure()!);
    await user.click(more()!);
    const busy = await within(list()).findByRole('button', { name: 'Loading...' });
    expect(busy).toBeDisabled();
    await act(async () => release());
    await waitFor(() => expect(rows()).toHaveLength(12));
    expect(more()).toBeNull();
  });
});

describe('deep link to a hidden run', () => {
  it('expands the history, and collapsing keeps the selection and the detail', async () => {
    setPages(finished(10));
    const { user } = renderAt('/research?run=f9');
    await waitFor(() => expect(rows()).toHaveLength(10));
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    const selected = within(list()).getByText('Run f9').closest('button');
    expect(selected).toHaveAttribute('aria-current', 'true');
    expect(await screen.findByRole('article', { name: 'Run: Run f9' })).toBeInTheDocument();
    await user.click(disclosure()!);
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(rows()).toHaveLength(8);
    expect(screen.getByRole('article', { name: 'Run: Run f9' })).toBeInTheDocument();
  });

  it('keeps the history collapsed for a deep link to a visible run', async () => {
    setPages(finished(10));
    renderAt('/research?run=f2');
    await waitFor(() => expect(rows()).toHaveLength(8));
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
  });

  it('still renders the detail for a run older than every loaded page', async () => {
    setPages(finished(10));
    byId.ancient = run('ancient', 'succeeded', 1);
    renderAt('/research?run=ancient');
    expect(await screen.findByRole('article', { name: 'Run: Run ancient' })).toBeInTheDocument();
    expect(rows()).toHaveLength(8);
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('live updates', () => {
  it('refetches every loaded page when the runs query is invalidated', async () => {
    setPages(finished(6), finished(5, 6));
    const { user, client } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(6));
    await user.click(disclosure()!);
    await user.click(more()!);
    await waitFor(() => expect(rows()).toHaveLength(11));
    const before = listCalls.length;
    pages[''].items[0] = { ...pages[''].items[0], status: 'failed', title: 'Renamed first' };
    pages.c2.items[0] = { ...pages.c2.items[0], title: 'Renamed older' };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['runs'] });
    });
    await waitFor(() => expect(listCalls.length).toBe(before + 2));
    expect(await within(list()).findByText('Renamed first')).toBeInTheDocument();
    expect(await within(list()).findByText('Renamed older')).toBeInTheDocument();
  });

  it('moves a run that opens into the visible part', async () => {
    setPages(finished(10));
    const { client } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    pages[''].items[9] = { ...pages[''].items[9], status: 'running', title: 'Now running' };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['runs'] });
    });
    expect(await within(list()).findByText('Now running')).toBeInTheDocument();
    expect(rows()).toHaveLength(8);
  });
});
