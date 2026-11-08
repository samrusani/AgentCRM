import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Duplicates } from '../../src/screens/Duplicates';
import { Leads } from '../../src/screens/Relationships';
import { formatDate } from '../../src/lib/format';
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
let orgScan: { pairs: any[]; capped: boolean };
let orgMergeFailure: { status: number; code: string; message: string } | null;
let orgScanFailure: boolean;
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

const orgSummary = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  domain: 'acme.com',
  linkedinUrl: 'https://www.linkedin.com/company/acme-capital/',
  kind: 'company',
  createdAt: '2026-09-01T10:00:00.000Z',
  version: 2,
  people: 0,
  deals: 0,
  tasks: 0,
  activities: 0,
  ...over,
});

const orgPair = (a: any, b: any, over: Record<string, unknown> = {}) => ({
  organizationIds: [a.id, b.id],
  reason: 'domain',
  reasonText: 'Same domain.',
  left: a,
  right: b,
  fillsIfKeepLeft: 3,
  fillsIfKeepRight: 0,
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
  orgMergeFailure = null;
  orgScanFailure = false;
  orgScan = {
    capped: false,
    pairs: [
      orgPair(orgSummary('org-a', 'Acme Capital', { version: 2 }), orgSummary('org-b', 'Acme Capital LLC', { version: 4, kind: 'fund', domain: null, linkedinUrl: null, people: 3, deals: 1, tasks: 2, activities: 5 })),
      orgPair(orgSummary('org-c', 'Beta'), orgSummary('org-d', 'Beta Inc'), { reason: 'name', reasonText: 'Same name.' }),
    ],
  };
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
      if (url.pathname === '/api/duplicates/organizations' && method === 'GET') {
        return orgScanFailure ? json(500, { error: { code: 'internal', message: 'Organization scan failed.' } }) : json(200, orgScan);
      }
      if (url.pathname === '/api/duplicates/organizations/dismiss') {
        orgScan = { ...orgScan, pairs: orgScan.pairs.filter((p) => p.organizationIds.join() !== body.organizationIds.join()) };
        return json(200, { organizationIds: body.organizationIds });
      }
      const orgMerge = url.pathname.match(/^\/api\/organizations\/([^/]+)\/merge$/);
      if (orgMerge) {
        if (orgMergeFailure) return json(orgMergeFailure.status, { error: { code: orgMergeFailure.code, message: orgMergeFailure.message } });
        orgScan = { ...orgScan, pairs: orgScan.pairs.filter((p) => !p.organizationIds.includes(orgMerge[1]) || !p.organizationIds.includes(body.otherId)) };
        return json(200, { id: orgMerge[1] });
      }
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
    expect(within(screen.getByRole('list', { name: 'Duplicate candidates' })).getByRole('button', { name: 'Keep left' })).toBeInTheDocument();
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

const orgCards = () => within(screen.getByRole('list', { name: 'Duplicate organizations' })).getAllByRole('listitem');
const twoOrgCards = () =>
  waitFor(() => {
    const found = orgCards();
    expect(found).toHaveLength(2);
    return found;
  });

describe('Duplicates screen, organizations section', () => {
  it('lists organization pairs below the people with reason, records, kind chips, and the three actions', async () => {
    renderDuplicates();
    expect(await screen.findByRole('heading', { name: 'Organizations' })).toBeInTheDocument();
    const [first, second] = await twoOrgCards();
    expect(within(first!).getByText('Same domain.')).toBeInTheDocument();
    expect(within(second!).getByText('Same name.')).toBeInTheDocument();
    const left = within(first!).getByRole('region', { name: 'Left record' });
    expect(within(left).getByRole('link', { name: 'Acme Capital' })).toHaveAttribute('href', '/relationships?tab=organizations&org=org-a');
    expect(within(left).getByText('acme.com')).toBeInTheDocument();
    expect(within(left).getByText('/company/acme-capital')).toBeInTheDocument();
    expect(within(left).getByText('Company')).toBeInTheDocument();
    expect(within(left).getByText(formatDate('2026-09-01T10:00:00.000Z'))).toBeInTheDocument();
    const right = within(first!).getByRole('region', { name: 'Right record' });
    expect(within(right).getByRole('link', { name: 'Acme Capital LLC' })).toHaveAttribute('href', '/relationships?tab=organizations&org=org-b');
    expect(within(right).getByText('Fund')).toBeInTheDocument();
    expect(within(right).getAllByText('None')).toHaveLength(2);
    for (const name of ['Keep left', 'Keep right', 'Not duplicates']) expect(within(first!).getByRole('button', { name })).toBeEnabled();
    // The people list is a separate list with its own cards.
    expect(cards()).toHaveLength(2);
  });

  it('builds the confirm sentence from the other record counts and the fill count', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    const [first] = await twoOrgCards();
    await user.click(within(first!).getByRole('button', { name: 'Keep left' }));
    expect(
      within(first!).getByText(/Moves 3 people, 1 deal, 2 tasks, and 5 activities, fills 3 empty fields, and deletes the other record\. This cannot be undone\./),
    ).toBeInTheDocument();
    expect(within(first!).getByText(/^Keep Acme Capital\./)).toBeInTheDocument();
    await user.click(within(first!).getByRole('button', { name: 'Cancel' }));
    await user.click(within(first!).getByRole('button', { name: 'Keep right' }));
    expect(within(first!).getByText(/Keep Acme Capital LLC\. Moves 0 people, 0 deals, 0 tasks, and 0 activities, fills 0 empty fields, and deletes/)).toBeInTheDocument();
  });

  it('uses singular forms at one', async () => {
    const user = userEvent.setup();
    orgScan = { capped: false, pairs: [orgPair(orgSummary('org-a', 'A', { people: 1 }), orgSummary('org-b', 'B', { people: 1, deals: 1, tasks: 1, activities: 1 }), { fillsIfKeepLeft: 1 })] };
    renderDuplicates();
    const [first] = await waitFor(() => orgCards());
    await user.click(within(first!).getByRole('button', { name: 'Keep left' }));
    expect(within(first!).getByText(/Moves 1 person, 1 deal, 1 task, and 1 activity, fills 1 empty field, and deletes/)).toBeInTheDocument();
  });

  it('merges with both versions through the organization route and removes the card', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    const [first] = await twoOrgCards();
    await user.click(within(first!).getByRole('button', { name: 'Keep right' }));
    await user.click(within(first!).getByRole('button', { name: 'Merge records' }));
    await waitFor(() => expect(orgCards()).toHaveLength(1));
    const merge = calls.find((call) => call.method === 'POST' && call.path === '/api/organizations/org-b/merge');
    expect(merge?.body).toEqual({ otherId: 'org-a', expectedVersion: 4, otherExpectedVersion: 2 });
    expect(calls.some((call) => call.path.startsWith('/api/people/') && call.path.endsWith('/merge'))).toBe(false);
    await waitFor(() => expect(calls.filter((call) => call.path === '/api/duplicates/organizations' && call.method === 'GET').length).toBeGreaterThan(1));
    expect(cards()).toHaveLength(2);
  });

  it('keep left sends the older record as survivor', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    const [first] = await twoOrgCards();
    await user.click(within(first!).getByRole('button', { name: 'Keep left' }));
    await user.click(within(first!).getByRole('button', { name: 'Merge records' }));
    await waitFor(() => expect(orgCards()).toHaveLength(1));
    const merge = calls.find((call) => call.method === 'POST' && call.path === '/api/organizations/org-a/merge');
    expect(merge?.body).toEqual({ otherId: 'org-b', expectedVersion: 2, otherExpectedVersion: 4 });
  });

  it('shows the server reason in place when a merge is refused and keeps the card', async () => {
    const user = userEvent.setup();
    orgMergeFailure = { status: 409, code: 'version_conflict', message: 'This record changed. Reload and try again.' };
    renderDuplicates();
    const [first, second] = await twoOrgCards();
    await user.click(within(first!).getByRole('button', { name: 'Keep left' }));
    await user.click(within(first!).getByRole('button', { name: 'Merge records' }));
    expect(await within(first!).findByRole('alert')).toHaveTextContent('This record changed. Reload and try again.');
    expect(within(second!).queryByRole('alert')).not.toBeInTheDocument();
    expect(orgCards()).toHaveLength(2);
  });

  it('resets an open confirm when the list refreshes underneath', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    const [first, second] = await twoOrgCards();
    await user.click(within(first!).getByRole('button', { name: 'Keep left' }));
    expect(within(first!).getByRole('button', { name: 'Merge records' })).toBeInTheDocument();
    await user.click(within(second!).getByRole('button', { name: 'Not duplicates' }));
    await waitFor(() => expect(orgCards()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Merge records' })).not.toBeInTheDocument());
  });

  it('dismisses a pair quietly and removes its card', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    const [first] = await twoOrgCards();
    await user.click(within(first!).getByRole('button', { name: 'Not duplicates' }));
    await waitFor(() => expect(orgCards()).toHaveLength(1));
    const dismiss = calls.find((call) => call.path === '/api/duplicates/organizations/dismiss');
    expect(dismiss?.body).toEqual({ organizationIds: ['org-a', 'org-b'] });
    expect(calls.some((call) => call.path === '/api/duplicates/dismiss')).toBe(false);
    expect(screen.queryByText('Same domain.')).not.toBeInTheDocument();
  });

  it('shows its own empty state without touching the people section', async () => {
    orgScan = { pairs: [], capped: false };
    renderDuplicates();
    expect(await screen.findByText('No duplicate organizations.')).toBeInTheDocument();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(screen.queryByText(/No duplicate candidates/)).not.toBeInTheDocument();
  });

  it('keeps the people empty state separate from a populated organizations section', async () => {
    scan = { pairs: [], capped: false };
    renderDuplicates();
    expect(await screen.findByText(/^No duplicate candidates\./)).toBeInTheDocument();
    await twoOrgCards();
    expect(screen.queryByText('No duplicate organizations.')).not.toBeInTheDocument();
  });

  it('says a capped organization list shows the first 200 pairs, only in that section', async () => {
    orgScan.capped = true;
    renderDuplicates();
    await twoOrgCards();
    expect(screen.getAllByText(/Showing the first 200 pairs\./)).toHaveLength(1);
    expect(within(screen.getByRole('region', { name: 'Organizations' })).getByText(/Showing the first 200 pairs\./)).toBeInTheDocument();
  });

  it('fails independently: an organization load failure leaves the people pairs, and the reverse', async () => {
    const user = userEvent.setup();
    orgScanFailure = true;
    renderDuplicates();
    expect(await screen.findByText('Organization scan failed.')).toBeInTheDocument();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const retry = screen.getByRole('button', { name: 'Retry' });
    orgScanFailure = false;
    await user.click(retry);
    await twoOrgCards();
    expect(screen.queryByText('Organization scan failed.')).not.toBeInTheDocument();
  });

  it('shows a people load failure while the organization pairs still render', async () => {
    const serve = (fetch as any).getMockImplementation();
    (fetch as any).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input), 'http://localhost').pathname === '/api/duplicates'
        ? json(500, { error: { code: 'internal', message: 'Scan failed.' } })
        : serve(input, init),
    );
    renderDuplicates();
    expect(await screen.findByText('Scan failed.')).toBeInTheDocument();
    await twoOrgCards();
  });

  it('renders hostile organization text as inert text', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1">';
    orgScan = { capped: false, pairs: [orgPair(orgSummary('org-a', hostile, { domain: '<script>window.__pwned=1</script>' }), orgSummary('org-b', 'B'), { reasonText: '<i>Same domain.</i>' })] };
    const { container } = renderDuplicates();
    const [first] = await waitFor(() => orgCards());
    expect(within(first!).getByText(hostile)).toBeInTheDocument();
    expect(within(first!).getByText('<script>window.__pwned=1</script>')).toBeInTheDocument();
    expect(container.querySelector('img, script, i')).toBeNull();
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
