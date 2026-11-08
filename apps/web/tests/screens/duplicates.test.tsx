import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Duplicates } from '../../src/screens/Duplicates';
import { Leads } from '../../src/screens/Relationships';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {}, theme: 'system', setTheme: () => {} }),
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
  body: any;
}

let calls: Call[];
let scan: { pairs: any[]; capped: boolean };
let mergeFailure: { status: number; code: string; message: string } | null;

const json = (status: number, body: unknown): Response =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const summary = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  email: `${id}@example.com`,
  organizationName: 'Acme Capital',
  linkedinUrl: 'https://www.linkedin.com/in/example',
  lifecycle: 'lead',
  createdAt: '2026-10-01T10:00:00.000Z',
  version: 3,
  deals: 0,
  tasks: 0,
  activities: 0,
  ...over,
});

const pair = (a: any, b: any, over: Record<string, unknown> = {}) => ({
  personIds: [a.id, b.id],
  reason: 'email',
  reasonText: 'Same email address.',
  left: a,
  right: b,
  fillsIfKeepLeft: 2,
  fillsIfKeepRight: 1,
  ...over,
});

beforeEach(() => {
  calls = [];
  mergeFailure = null;
  scan = {
    capped: false,
    pairs: [
      pair(summary('per-a', 'Ann Ko', { version: 3 }), summary('per-b', 'Annie Ko', { version: 5, deals: 2, tasks: 1, activities: 3, lifecycle: 'relationship' })),
      pair(summary('per-c', 'Cy Lee'), summary('per-d', 'Cy Leigh'), { reason: 'name_organization', reasonText: 'Same name at the same organization.' }),
    ],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === '/api/duplicates' && method === 'GET') return json(200, scan);
      if (url.pathname === '/api/duplicates/dismiss') {
        scan = { ...scan, pairs: scan.pairs.filter((p) => p.personIds.join() !== body.personIds.join()) };
        return json(200, { personIds: body.personIds });
      }
      const merge = url.pathname.match(/^\/api\/people\/([^/]+)\/merge$/);
      if (merge) {
        if (mergeFailure) return json(mergeFailure.status, { error: { code: mergeFailure.code, message: mergeFailure.message } });
        scan = { ...scan, pairs: scan.pairs.filter((p) => !p.personIds.includes(merge[1]) || !p.personIds.includes(body.otherId)) };
        return json(200, { id: merge[1] });
      }
      if (url.pathname === '/api/people') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/organizations') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/lists') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/views') return json(200, { items: [], nextCursor: null });
      if (url.pathname.startsWith('/api/connectors')) return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDuplicates() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Router initialEntries={['/duplicates']}>
        <Duplicates />
      </Router>
    </QueryClientProvider>,
  );
}

const cards = () => within(screen.getByRole('list', { name: 'Duplicate candidates' })).getAllByRole('listitem');

describe('Duplicates screen', () => {
  it('lists each pair with its reason, both records, and the three actions', async () => {
    renderDuplicates();
    const [first, second] = await waitFor(() => {
      const found = cards();
      expect(found).toHaveLength(2);
      return found;
    });
    expect(within(first!).getByText('Same email address.')).toBeInTheDocument();
    expect(within(second!).getByText('Same name at the same organization.')).toBeInTheDocument();
    const left = within(first!).getByRole('region', { name: 'Left record' });
    expect(within(left).getByRole('link', { name: 'Ann Ko' })).toHaveAttribute('href', '/leads?tab=people&person=per-a');
    expect(within(left).getByText('per-a@example.com')).toBeInTheDocument();
    expect(within(left).getByText('Acme Capital')).toBeInTheDocument();
    expect(within(left).getByText('/in/example')).toBeInTheDocument();
    expect(within(left).getByText('lead')).toBeInTheDocument();
    const right = within(first!).getByRole('region', { name: 'Right record' });
    expect(within(right).getByRole('link', { name: 'Annie Ko' })).toHaveAttribute('href', '/relationships?tab=people&person=per-b');
    expect(within(right).getByText('relationship')).toBeInTheDocument();
    for (const name of ['Keep left', 'Keep right', 'Not duplicates']) expect(within(first!).getByRole('button', { name })).toBeEnabled();
  });

  it('builds the confirm sentence from the other record counts and the fill count', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    const [first] = await waitFor(() => {
      const found = cards();
      expect(found).toHaveLength(2);
      return found;
    });
    await user.click(within(first!).getByRole('button', { name: 'Keep left' }));
    expect(within(first!).getByText(/Moves 2 deals, 1 task, and 3 activities, fills 2 empty fields, and deletes the other record\. This cannot be undone\./)).toBeInTheDocument();
    await user.click(within(first!).getByRole('button', { name: 'Cancel' }));
    await user.click(within(first!).getByRole('button', { name: 'Keep right' }));
    expect(within(first!).getByText(/Moves 0 deals, 0 tasks, and 0 activities, fills 1 empty field, and deletes/)).toBeInTheDocument();
  });

  it('merges with both versions and removes the card', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    const [first] = await waitFor(() => {
      const found = cards();
      expect(found).toHaveLength(2);
      return found;
    });
    await user.click(within(first!).getByRole('button', { name: 'Keep right' }));
    await user.click(within(first!).getByRole('button', { name: 'Merge records' }));
    await waitFor(() => expect(cards()).toHaveLength(1));
    const merge = calls.find((call) => call.method === 'POST' && call.path === '/api/people/per-b/merge');
    expect(merge?.body).toEqual({ otherId: 'per-a', expectedVersion: 5, otherExpectedVersion: 3 });
    await waitFor(() => expect(calls.filter((call) => call.path === '/api/duplicates' && call.method === 'GET').length).toBeGreaterThan(1));
  });

  it('shows the server reason in place when a merge is refused and keeps the card', async () => {
    const user = userEvent.setup();
    mergeFailure = { status: 409, code: 'conflict', message: 'Stop the follow-ups and sends first.' };
    renderDuplicates();
    const [first] = await waitFor(() => {
      const found = cards();
      expect(found).toHaveLength(2);
      return found;
    });
    await user.click(within(first!).getByRole('button', { name: 'Keep left' }));
    await user.click(within(first!).getByRole('button', { name: 'Merge records' }));
    expect(await within(first!).findByRole('alert')).toHaveTextContent('Stop the follow-ups and sends first.');
    expect(cards()).toHaveLength(2);
  });

  it('resets an open confirm when the list refreshes underneath', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    const [first, second] = await waitFor(() => {
      const found = cards();
      expect(found).toHaveLength(2);
      return found;
    });
    await user.click(within(first!).getByRole('button', { name: 'Keep left' }));
    expect(within(first!).getByRole('button', { name: 'Merge records' })).toBeInTheDocument();
    await user.click(within(second!).getByRole('button', { name: 'Not duplicates' }));
    await waitFor(() => expect(cards()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Merge records' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Keep left' })).toBeInTheDocument();
  });

  it('dismisses a pair quietly and removes its card', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    const [first] = await waitFor(() => {
      const found = cards();
      expect(found).toHaveLength(2);
      return found;
    });
    await user.click(within(first!).getByRole('button', { name: 'Not duplicates' }));
    await waitFor(() => expect(cards()).toHaveLength(1));
    const dismiss = calls.find((call) => call.path === '/api/duplicates/dismiss');
    expect(dismiss?.body).toEqual({ personIds: ['per-a', 'per-b'] });
    expect(screen.queryByText('Same email address.')).not.toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    scan = { pairs: [], capped: false };
    renderDuplicates();
    expect(await screen.findByText('No duplicate candidates. New captures and imports are checked against existing records when they are staged.')).toBeInTheDocument();
  });

  it('says a capped list shows the first 200 pairs', async () => {
    scan.capped = true;
    renderDuplicates();
    expect(await screen.findByText(/Showing the first 200 pairs\./)).toBeInTheDocument();
  });

  it('shows a load failure with a retry', async () => {
    (fetch as any).mockImplementationOnce(async () => json(500, { error: { code: 'internal', message: 'Scan failed.' } }));
    renderDuplicates();
    expect(await screen.findByText('Scan failed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('Find duplicates button', () => {
  it('opens /duplicates from the People tab', async () => {
    const user = userEvent.setup();
    function Where() {
      const location = useLocation();
      return <p data-testid="where">{location.pathname}</p>;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Router initialEntries={['/leads']}>
          <Where />
          <Routes>
            <Route path="/leads" element={<Leads />} />
            <Route path="/duplicates" element={<p>Duplicates page</p>} />
          </Routes>
        </Router>
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Find duplicates' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/duplicates');
  });
});
