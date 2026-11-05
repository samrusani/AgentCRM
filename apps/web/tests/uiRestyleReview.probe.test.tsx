// Adversarial review probes for the layered depth restyle (Today card grid, EmptyState icon and framed props).
// Names start with CONFIRMS (the defect is real, the test passes because it is) or KILLS (a safety property holds).
// Nothing here changes application code.
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { EmptyState } from '../src/components/common';
import { Today } from '../src/screens/Today';
import { Router } from './helpers';

vi.mock('../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ui')>()),
  useUI: () => ({ theme: 'system', setTheme: () => {}, pushToast: () => {}, setSelectedRecord: () => {} }),
}));

interface World {
  calls: string[];
  today: Record<string, unknown> | 'error';
  intents: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
}

let world: World;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const task = (id: string, dueAt: string) => ({
  id,
  version: 1,
  title: `Task ${id}`,
  entityType: null,
  entityId: null,
  dueAt,
  status: 'open',
  createdAt: '2026-11-01T10:00:00',
  updatedAt: '2026-11-01T10:00:00',
});

const intent = (id: string, status: string) => ({
  id,
  personId: null,
  personName: `Person ${id}`,
  toEmail: `${id}@example.com`,
  subject: `Subject ${id}`,
  status,
});

const rule = (id: string, status: string) => ({
  id,
  personId: null,
  personName: `Person ${id}`,
  status,
  steps: [{ waitDays: 5, body: 'Checking in again, thanks.' }],
  nextStep: 1,
  nextDueAt: '2026-11-10T10:00:00',
  provider: 'gmail',
});

const reply = (id: string) => ({
  id,
  personId: null,
  personName: `Replier ${id}`,
  fromEmail: `${id}@example.com`,
  subject: `Re ${id}`,
  receivedAt: '2026-11-04T10:00:00',
});

function freshWorld(): World {
  return {
    calls: [],
    today: { tasksDue: [], approvalsPending: [], runsActive: [], counts: {} },
    intents: [],
    rules: [],
    summary: { counts: {}, dailyCap: 50, remainingDailyCap: 50, lastSyncAt: null, repliesNeedingAttention: { count: 0, items: [] } },
  };
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      world.calls.push(url.pathname);
      if (url.pathname === '/api/today') {
        return world.today === 'error' ? json(500, { error: { code: 'internal', message: 'Something went wrong.' } }) : json(200, world.today);
      }
      if (url.pathname === '/api/send-intents') return json(200, { items: world.intents, nextCursor: null });
      if (url.pathname === '/api/followup-rules') return json(200, { items: world.rules, nextCursor: null });
      if (url.pathname === '/api/mail/summary') return json(200, world.summary);
      if (url.pathname === '/api/suppressions') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/mail-provider' || url.pathname.includes('provider')) return json(200, { kind: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

function renderToday() {
  // Same defaults as src/main.tsx: with a 15 second stale time, a child mounting later does not refetch the parent's data.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={['/today']}>
        <Routes>
          <Route path="/today" element={<Today />} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
}

const TITLES = ['Approvals waiting', 'Outbox', 'Follow-ups', 'Replies', 'Tasks due and overdue', 'Active runs'];

const countOf = (title: string): string | null => {
  const heading = screen.getByRole('heading', { level: 2, name: title });
  return heading.parentElement?.querySelector('.today-card__count')?.textContent ?? null;
};

beforeEach(() => {
  world = freshWorld();
  installFetch();
  vi.stubGlobal(
    'EventSource',
    class {
      readyState = 1;
      addEventListener() {}
      close() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Today card headers', () => {
  it('KILLS: empty sections render no count, and every section keeps an h2 wired to its region by aria-labelledby', async () => {
    renderToday();
    await screen.findByRole('heading', { level: 2, name: 'Approvals waiting' });
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(TITLES);
    expect(document.querySelectorAll('.today-card__count')).toHaveLength(0);
    for (const title of TITLES) {
      const heading = screen.getByRole('heading', { level: 2, name: title });
      const region = screen.getByRole('region', { name: title });
      expect(region.getAttribute('aria-labelledby')).toBe(heading.id);
      // The count sits beside the heading, so the heading's accessible name is only the title.
      expect(heading.textContent).toBe(title);
    }
  });

  it('KILLS: counts show only when nonzero and match the rows each section lists', async () => {
    world.today = { tasksDue: [task('a', '2026-11-01T09:00:00'), task('b', '2026-11-02T09:00:00')], approvalsPending: [], runsActive: [], counts: {} };
    world.intents = [intent('i1', 'queued'), intent('i2', 'accepted'), intent('i3', 'failed'), intent('i4', 'cancelled')];
    world.rules = [rule('r1', 'waiting'), rule('r2', 'armed'), rule('r3', 'stopped')];
    world.summary = {
      counts: {},
      dailyCap: 50,
      remainingDailyCap: 40,
      lastSyncAt: null,
      repliesNeedingAttention: { count: 2, items: [reply('x'), reply('y')] },
    };
    renderToday();
    await waitFor(() => expect(countOf('Outbox')).toBe('3'));
    await waitFor(() => expect(countOf('Follow-ups')).toBe('2'));
    await waitFor(() => expect(countOf('Replies')).toBe('2'));
    expect(countOf('Tasks due and overdue')).toBe('2');
    expect(countOf('Approvals waiting')).toBeNull();
    expect(countOf('Active runs')).toBeNull();

    const region = (name: string) => screen.getByRole('region', { name });
    await waitFor(() => expect(region('Outbox').querySelectorAll('.outbox-row')).toHaveLength(3));
    expect(region('Follow-ups').querySelectorAll('.today-card__body > .followup-list > li')).toHaveLength(2);
    expect(region('Replies').querySelectorAll('.reply-row')).toHaveLength(2);
    expect(region('Tasks due and overdue').querySelectorAll('.task')).toHaveLength(2);
    // The Replies body states the same number in words.
    expect(within(region('Replies')).getByText(/2 replies need attention/)).toBeInTheDocument();
  });

  it('KILLS: a cancelled-only outbox shows no count and the section lists nothing', async () => {
    world.intents = [intent('c1', 'cancelled'), intent('c2', 'cancelled')];
    renderToday();
    await waitFor(() => expect(screen.getByRole('region', { name: 'Outbox' }).textContent).toMatch(/2 cancelled messages are not\s+listed/));
    expect(countOf('Outbox')).toBeNull();
  });

  it('KILLS: finished follow-up rules are not counted, and sit only in the history group', async () => {
    world.rules = [rule('f1', 'stopped'), rule('f2', 'completed')];
    renderToday();
    await screen.findByText(/No follow-ups are active/);
    expect(countOf('Follow-ups')).toBeNull();
  });

  it('KILLS: when the Today request fails, the three count queries never fire', async () => {
    world.today = 'error';
    renderToday();
    await screen.findByRole('button', { name: /retry|try again/i }).catch(() => undefined);
    await waitFor(() => expect(world.calls).toContain('/api/today'));
    // Give any stray query a chance to start before asserting that none did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(world.calls).not.toContain('/api/send-intents');
    expect(world.calls).not.toContain('/api/followup-rules');
    expect(world.calls).not.toContain('/api/mail/summary');
    expect(screen.queryByRole('heading', { level: 2, name: 'Outbox' })).not.toBeInTheDocument();
  });

  it('KILLS: the card grid sits inside a dedicated size container, and counts carry hidden context', async () => {
    world.today = { tasksDue: [task('a', '2026-11-01T09:00:00')], approvalsPending: [], runsActive: [], counts: {} };
    renderToday();
    await screen.findByRole('heading', { level: 2, name: 'Tasks due and overdue' });
    // jsdom has no container queries, so assert the structure the stylesheet keys on.
    const grid = document.querySelector('.today');
    expect(grid?.parentElement?.className).toBe('today-area');
    expect(document.querySelector('.content')).toBeNull();
    const count = document.querySelector('.today-card__count');
    expect(count?.nextElementSibling?.className).toBe('sr-only');
    expect(count?.nextElementSibling?.textContent).toBe(' items');
  });

  it('KILLS: the count queries share keys with the child sections, so a loaded Today asks each endpoint once', async () => {
    renderToday();
    await screen.findByRole('heading', { level: 2, name: 'Outbox' });
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    for (const path of ['/api/send-intents', '/api/followup-rules', '/api/mail/summary']) {
      expect(world.calls.filter((call) => call === path)).toHaveLength(1);
    }
  });
});

describe('EmptyState with an icon', () => {
  it('KILLS: the icon is decorative and the accessible sentence and action survive', () => {
    const onAction = vi.fn();
    const { container } = render(
      <EmptyState framed icon="people" message="No people yet. Import a CSV to start." actionLabel="Import CSV" onAction={onAction} />,
    );
    expect(screen.getByText('No people yet. Import a CSV to start.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import CSV' })).toBeEnabled();
    const svg = container.querySelector('.state__icon svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.state')?.className).toBe('state state--centered state--framed');
  });

  it('KILLS: without an icon the state stays a plain, uncentered sentence', () => {
    const { container } = render(<EmptyState message="Nothing here." />);
    expect(container.querySelector('.state')?.className).toBe('state');
    expect(container.querySelector('.state__icon')).toBeNull();
  });

  it('CONFIRMS: framed without an icon still gets the card frame but not the centering', () => {
    const { container } = render(<EmptyState framed message="Nothing here." />);
    expect(container.querySelector('.state')?.className).toBe('state state--framed');
    expect(container.querySelector('.state--centered')).toBeNull();
  });
});
