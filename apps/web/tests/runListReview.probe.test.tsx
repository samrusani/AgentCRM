import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Link, Route, Routes } from 'react-router-dom';
import { Research } from '../src/screens/Research';
import { Router } from './helpers';

const conn = vi.hoisted(() => ({ state: 'open' as 'open' | 'closed' }));

vi.mock('../src/lib/ui', () => ({
  useUI: () => ({ pushToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../src/api/events', () => ({
  useServerEvents: () => {},
  useEventConnection: () => conn.state,
}));
vi.mock('../src/screens/LeadCaptureCard', () => ({ LeadCaptureCard: () => null }));
vi.mock('../src/screens/TranscriptCaptureCard', () => ({ TranscriptCaptureCard: () => null }));

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
let failCursor: string | null;
let postedRun: any | null;

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/runs' && init?.method === 'POST') {
        byId[postedRun.id] = postedRun;
        return json(201, postedRun);
      }
      if (url.pathname === '/api/runs') {
        listCalls.push(url.searchParams);
        const cursor = url.searchParams.get('cursor') ?? '';
        if (failCursor !== null && cursor === failCursor) {
          return json(500, { error: { code: 'internal', message: 'Server broke.' } });
        }
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
function opens(count: number, status: Status = 'running', prefix = 'o') {
  return Array.from({ length: count }, (_, i) => run(`${prefix}${i}`, status, 59 - i));
}

function renderAt(entry = '/research', extra?: React.ReactNode) {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[entry]}>
        {extra}
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
const titles = () => rows().map((row) => within(row).getByText(/^Run /).textContent);
const disclosure = () => within(list()).queryByRole('button', { name: 'Older runs' });
const more = () => within(list()).queryByRole('button', { name: /Show older runs|Loading|Try again/ });
const invalidate = async (client: QueryClient) =>
  act(async () => {
    await client.invalidateQueries({ queryKey: ['runs'] });
  });

beforeEach(() => {
  listCalls = [];
  failCursor = null;
  conn.state = 'open';
  postedRun = null;
  setPages([]);
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('partition under churn', () => {
  it('CONFIRMS: a run that flips to running while the history is expanded surfaces in the visible part, total unchanged', async () => {
    setPages(finished(10));
    const { user, client } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    await user.click(disclosure()!);
    expect(rows()).toHaveLength(10);
    pages[''].items[9] = { ...pages[''].items[9], status: 'running' };
    await invalidate(client);
    await waitFor(() => {
      const recent = within(list()).getAllByRole('list')[0];
      expect(within(recent).getByText('Run f9')).toBeInTheDocument();
    });
    const recent = within(list()).getAllByRole('list')[0];
    expect(within(recent).queryAllByRole('listitem')).toHaveLength(8);
    expect(within(recent).queryByText('Run f7')).toBeNull();
    expect(rows()).toHaveLength(10);
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
  });

  it('CONFIRMS: counts around exactly 8 (8 open, 8 open + 1 finished, 7 open + 5 finished, 9 finished)', async () => {
    setPages(opens(8));
    const a = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    expect(disclosure()).toBeNull();
    document.body.innerHTML = '';
    a.client.clear();

    setPages([...opens(8), ...finished(1)]);
    const b = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    expect(disclosure()).toBeInTheDocument();
    expect(within(list()).queryByText('Run f0')).toBeNull();
    document.body.innerHTML = '';
    b.client.clear();

    setPages([...opens(7), ...finished(5)]);
    const c = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    expect(within(list()).getByText('Run f0')).toBeInTheDocument();
    expect(within(list()).queryByText('Run f1')).toBeNull();
    document.body.innerHTML = '';
    c.client.clear();

    setPages(finished(9));
    renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    expect(disclosure()).toBeInTheDocument();
  });

  it('CONFIRMS: interleaved open and finished runs keep strict server order in the visible part', async () => {
    setPages([
      run('f0', 'succeeded', 59),
      run('o0', 'running', 58),
      run('f1', 'failed', 57),
      run('p0', 'paused', 56),
      run('f2', 'succeeded', 55),
      run('q0', 'queued', 54),
      ...finished(6, 3),
    ]);
    renderAt();
    // 3 open runs take 3 slots, so 5 finished runs fill the rest: f0 f1 f2 f3 f4.
    await waitFor(() => expect(rows()).toHaveLength(8));
    expect(titles()).toEqual(['Run f0', 'Run o0', 'Run f1', 'Run p0', 'Run f2', 'Run q0', 'Run f3', 'Run f4']);
  });

  it('ACCEPTED: an open run loaded with page 2 jumps into the visible part and pushes finished rows into the history', async () => {
    // Argument: the contract says every open run renders and the list fills to 8 with the newest finished,
    // so the finished rows that lose their slot must move. The move only happens after the user asked for
    // page 2, so the reflow is user initiated and the total row count never changes.
    setPages(finished(9), [run('o0', 'running', 1), run('o1', 'running', 0)]);
    const { user } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    await user.click(disclosure()!);
    await user.click(more()!);
    await waitFor(() => expect(rows()).toHaveLength(11));
    const recent = within(list()).getAllByRole('list')[0];
    const recentTitles = within(recent)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(recentTitles).toHaveLength(8);
    expect(within(recent).getByText('Run o0')).toBeInTheDocument();
    expect(within(recent).getByText('Run o1')).toBeInTheDocument();
    expect(within(recent).queryByText('Run f6')).toBeNull();
    // Open runs from a later page are appended after the finished runs that came from page 1.
    expect(within(recent).getByText('Run f5')).toBeInTheDocument();
  });

  it('ACCEPTED: a paused run on page 2 is not rendered until that page is loaded', async () => {
    // Argument: the API pages 50 at a time and the list cannot render what it has not fetched. The contract
    // sentence "Every open run ... renders" must read "every loaded open run" (see report).
    setPages(finished(9), [run('p0', 'paused', 1)]);
    const { user } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    expect(within(list()).queryByText('Run p0')).toBeNull();
    await user.click(disclosure()!);
    await user.click(more()!);
    await waitFor(() => expect(within(list()).getByText('Run p0')).toBeInTheDocument());
    const recent = within(list()).getAllByRole('list')[0];
    expect(within(recent).getByText('Run p0')).toBeInTheDocument();
  });

  it('KILLS, fixed: the default selection is the newest visible run, so the auto selected row is always on screen', async () => {
    // items[0] is hidden whenever 8 or more open runs sit below a finished newest run. The default
    // selection is then the newest VISIBLE run, so the selected row is always on screen.
    setPages([run('newest', 'succeeded', 59), ...opens(8)]);
    renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    const visible = rows().map((row) => within(row).getByText(/^Run /).textContent);
    expect(visible).not.toContain('Run newest');
    await screen.findByRole('article', { name: `Run: ${visible[0]}` });
    expect(within(list()).queryByText('Run newest')).toBeNull();
  });
});

describe('infinite query churn', () => {
  it('KILLS, fixed: a run created between page fetches renders once (items dedupe by id, first occurrence wins)', async () => {
    setPages(finished(10), finished(3, 10));
    const { user, client } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    await user.click(disclosure()!);
    await user.click(more()!);
    await waitFor(() => expect(rows()).toHaveLength(13));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A new run shifts the server window: page 1 now ends with f9 and the stored cursor page 2 starts at f9 too.
    pages[''] = { items: [run('new', 'running', 59), ...finished(10)], nextCursor: 'c2' };
    pages.c2 = { items: finished(4, 9), nextCursor: null };
    await invalidate(client);
    await waitFor(() => expect(within(list()).getByText('Run new')).toBeInTheDocument());
    const ids = titles();
    expect(new Set(ids).size).toBe(ids.length);
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
  });

  it('CONFIRMS: a refetch whose page 2 cursor now returns an empty page shrinks the list without error', async () => {
    setPages(finished(6), finished(5, 6));
    const { user, client } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(6));
    await user.click(disclosure()!);
    await user.click(more()!);
    await waitFor(() => expect(rows()).toHaveLength(11));
    pages.c2 = { items: [], nextCursor: null };
    await invalidate(client);
    await waitFor(() => expect(rows()).toHaveLength(6));
    expect(more()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('CONFIRMS: the detail survives when the selected hidden run leaves the loaded set after a refetch', async () => {
    setPages(finished(10));
    const { client } = renderAt('/research?run=f9');
    await screen.findByRole('article', { name: 'Run: Run f9' });
    await waitFor(() => expect(rows()).toHaveLength(10));
    pages[''] = { items: finished(9), nextCursor: null };
    await invalidate(client);
    await waitFor(() => expect(rows()).toHaveLength(9));
    expect(screen.getByRole('article', { name: 'Run: Run f9' })).toBeInTheDocument();
    expect(list().querySelector('[aria-current="true"]')).toBeNull();
  });

  it('ACCEPTED: while the event stream is down every loaded page is refetched every 5 seconds', async () => {
    // Argument: one request per loaded page per tick is the price of keeping every loaded run live (contract
    // "Live updates keep reaching every loaded run"). It is bounded by what the user chose to load and it
    // stops when the stream reconnects. A user who loads many pages pays N requests per tick.
    conn.state = 'closed';
    setPages(finished(6), finished(5, 6));
    const { user } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(6));
    await user.click(disclosure()!);
    await user.click(more()!);
    await waitFor(() => expect(rows()).toHaveLength(11));
    const before = listCalls.length;
    await waitFor(() => expect(listCalls.length).toBeGreaterThanOrEqual(before + 2), { timeout: 7000 });
    const tick = listCalls.slice(before);
    expect(tick.map((p) => p.get('cursor') ?? '').slice(0, 2)).toEqual(['', 'c2']);
  }, 15000);
});

describe('failed page fetch', () => {
  it('KILLS, fixed: a failed "Show older runs" fetch shows an inline alert and a Try again action', async () => {
    setPages(finished(10), finished(3, 10));
    const { user } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    await user.click(disclosure()!);
    failCursor = 'c2';
    await user.click(more()!);
    await waitFor(() => expect(listCalls.some((p) => p.get('cursor') === 'c2')).toBe(true));
    // The contract's fixed copy: one inline alert and the button offering the retry.
    await waitFor(() => expect(more()).toHaveTextContent('Try again'));
    const nav = list();
    expect(within(nav).getByRole('alert')).toHaveTextContent('Older runs did not load.');
  });

  it('KILLS, fixed: a failed page 2 fetch leaves the Research screen in place (the screen error needs no data at all)', async () => {
    setPages(finished(10), finished(3, 10));
    const { user } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    await user.click(disclosure()!);
    failCursor = 'c2';
    await user.click(more()!);
    await waitFor(() => expect(listCalls.some((p) => p.get('cursor') === 'c2')).toBe(true));
    // The list, the detail and the capture column should still be there.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByRole('navigation', { name: 'Runs' })).not.toBeNull();
  });
});

describe('deep link expansion', () => {
  it('CONFIRMS: a requested id that never appears leaves the history collapsed and the detail error visible', async () => {
    setPages(finished(10));
    renderAt('/research?run=ghost');
    await waitFor(() => expect(rows()).toHaveLength(8));
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect((await screen.findAllByText(/not found|could not/i)).length).toBeGreaterThan(0);
  });

  it('CONFIRMS: a requested id that arrives with page 2 expands the history when it first appears', async () => {
    setPages(finished(10), [run('late', 'succeeded', 1)]);
    const { user } = renderAt('/research?run=late');
    await waitFor(() => expect(rows()).toHaveLength(8));
    await user.click(disclosure()!);
    await user.click(more()!);
    const selected = await within(list()).findByText('Run late');
    expect(selected.closest('button')).toHaveAttribute('aria-current', 'true');
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
  });

  it('CONFIRMS: manual collapse sticks while the same deep link stays in the URL, even across refetches', async () => {
    setPages(finished(10));
    const { user, client } = renderAt('/research?run=f9');
    await waitFor(() => expect(rows()).toHaveLength(10));
    await user.click(disclosure()!);
    expect(rows()).toHaveLength(8);
    await invalidate(client);
    await waitFor(() => expect(rows()).toHaveLength(8));
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
  });

  it('KILLS, fixed: navigating away and back to the same hidden run expands the history again', async () => {
    // Contract: "Selecting a hidden run from a deep link expands the history so the selection is visible".
    // The ref remembers f9 forever, so the second deep link to f9 leaves the selection invisible.
    setPages(finished(10));
    const links = (
      <>
        <Link to="/research?run=f1">go f1</Link>
        <Link to="/research?run=f9">go f9</Link>
      </>
    );
    const { user } = renderAt('/research?run=f9', links);
    await waitFor(() => expect(rows()).toHaveLength(10));
    await user.click(disclosure()!);
    await user.click(screen.getByText('go f1'));
    await waitFor(() => expect(within(list()).getByText('Run f1').closest('button')).toHaveAttribute('aria-current', 'true'));
    await user.click(screen.getByText('go f9'));
    await waitFor(() => expect(screen.getByRole('article', { name: 'Run: Run f9' })).toBeInTheDocument());
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
  });

  it('ACCEPTED: while the URL keeps the same id, re-requesting it is a no-op and a manual collapse wins', async () => {
    // Argument: the URL does not change, so nothing was re-requested. Only a different id in between counts as
    // a new deep link (the KILLS probe above covers that case).
    setPages(finished(10));
    const { user } = renderAt('/research?run=f9');
    await waitFor(() => expect(rows()).toHaveLength(10));
    await user.click(disclosure()!);
    expect(rows()).toHaveLength(8);
    await user.click(disclosure()!);
    expect(rows()).toHaveLength(10);
    await user.click(disclosure()!);
    expect(rows()).toHaveLength(8);
    expect(screen.getByRole('article', { name: 'Run: Run f9' })).toBeInTheDocument();
  });
});

describe('disclosure with only another page', () => {
  it('CONFIRMS: zero older runs but hasNextPage shows only the Show older runs action when expanded, no empty list', async () => {
    setPages(finished(3), finished(2, 3));
    const { user } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(more()).toBeNull();
    await user.click(disclosure()!);
    expect(within(list()).getAllByRole('list')).toHaveLength(1);
    expect(more()).toHaveTextContent('Show older runs');
  });

  it('CONFIRMS: when everything is visible after paging, the disclosure is gone and a selected row is not orphaned', async () => {
    setPages(finished(3), []);
    pages.c2 = { items: [], nextCursor: null };
    const { user } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(3));
    await user.click(disclosure()!);
    await user.click(more()!);
    await waitFor(() => expect(more()).toBeNull());
    // An empty last page leaves the disclosure with nothing to show; it must not dangle.
    expect(disclosure()).toBeNull();
  });
});

describe('copy and a11y', () => {
  it('CONFIRMS: exact strings, aria-expanded, nav landmark, button elements', async () => {
    setPages(finished(10), finished(1, 10));
    const { user } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    const toggle = within(list()).getByRole('button', { name: 'Older runs' });
    expect(toggle.textContent).toBe('Older runs');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(list()).getByRole('button', { name: 'Show older runs' }).textContent).toBe('Show older runs');
    expect(screen.getAllByRole('navigation', { name: 'Runs' })).toHaveLength(1);
  });

  it('CONFIRMS: the new CSS block uses tokens only, no hex literals, and the tokens exist', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/screens.css'), 'utf8');
    const tokens = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');
    const start = css.indexOf('.run-list__older,');
    const end = css.indexOf('.run-list__title');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, end);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/\brgba?\(/);
    for (const name of new Set(block.match(/var\((--[a-z-]+)/g)?.map((v) => v.slice(4)) ?? [])) {
      expect(tokens).toContain(`${name}:`);
    }
  });

  it('CONFIRMS: new copy in Research.tsx has no em dash and is sentence case', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/screens/Research.tsx'), 'utf8');
    expect(src).not.toMatch(/—/);
    expect(src).toContain('<span>Older runs</span>');
    expect(src).toContain("'Show older runs'");
  });
});

describe('Research regressions', () => {
  it('CONFIRMS: the empty state still renders with zero runs, with no disclosure', async () => {
    setPages([]);
    renderAt();
    expect(await screen.findByText(/No research runs yet/)).toBeInTheDocument();
    expect(disclosure()).toBeNull();
  });

  it('CONFIRMS: starting a demo run selects it even when it is hidden behind the history until the refetch', async () => {
    setPages(finished(10));
    postedRun = run('fresh', 'queued', 59);
    const { user } = renderAt();
    await waitFor(() => expect(rows()).toHaveLength(8));
    pages[''] = { items: [postedRun, ...finished(10)], nextCursor: null };
    await user.click(screen.getByRole('button', { name: 'Start demo research' }));
    expect(await screen.findByRole('article', { name: 'Run: Run fresh' })).toBeInTheDocument();
    await waitFor(() => expect(within(list()).getByText('Run fresh').closest('button')).toHaveAttribute('aria-current', 'true'));
  });
});
