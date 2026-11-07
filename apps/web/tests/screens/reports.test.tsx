import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Reports } from '../../src/screens/Reports';
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

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
}

let calls: Call[];
let reportBody: any;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const pipelines = [
  { id: 'us', workspaceId: 'ws', name: 'US investors', template: 'startup-fundraising', version: 1, stages: [] },
  { id: 'uk', workspaceId: 'ws', name: 'UK investors', template: 'fund-lp', version: 1, stages: [] },
];

const FULL = {
  pipeline: [
    { stageId: 's1', name: 'Research', seq: 1, openCount: 4, openAmounts: [{ currency: 'USD', amount: 2_000_000 }], passedCount: 0, passedAmounts: [], lostCount: 1, lostAmounts: [] },
    { stageId: 's2', name: 'Meeting', seq: 2, openCount: 2, openAmounts: [], passedCount: 1, passedAmounts: [{ currency: 'GBP', amount: 500_000 }], lostCount: 0, lostAmounts: [] },
  ],
  stageFlow: [
    { stageId: 's1', name: 'Research', seq: 1, entered: 6 },
    { stageId: 's2', name: 'Meeting', seq: 2, entered: 3 },
  ],
  intake: {
    weeks: [
      { weekStart: '2026-11-02', total: 5, bySource: { mailbox: 2, linkedin: 0, csv: 3, captured: 0, manual: 0 } },
      { weekStart: '2026-11-09', total: 1, bySource: { mailbox: 0, linkedin: 0, csv: 0, captured: 0, manual: 1 } },
    ],
  },
  outreach: { sends: 12, replies: 3, bounces: 1, optOuts: 2 },
  runs: {
    groups: [
      { kind: 'draft', status: 'succeeded', count: 2 },
      { kind: 'draft', status: 'failed', count: 1 },
    ],
    estimatedUsd: 0.75,
    runsWithEstimate: 2,
  },
};

const EMPTY = {
  pipeline: [{ stageId: 's1', name: 'Research', seq: 1, openCount: 0, openAmounts: [], passedCount: 0, passedAmounts: [], lostCount: 0, lostAmounts: [] }],
  stageFlow: [{ stageId: 's1', name: 'Research', seq: 1, entered: 0 }],
  intake: { weeks: [] },
  outreach: { sends: 0, replies: 0, bounces: 0, optOuts: 0 },
  runs: { groups: [], estimatedUsd: 0, runsWithEstimate: 0 },
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="url">{location.pathname + location.search}</output>;
}

function renderAt(url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[url]}>
        <LocationProbe />
        <Routes>
          <Route path="/reports" element={<Reports />} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  reportBody = FULL;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push({ method: init?.method ?? 'GET', path: url.pathname, search: url.searchParams });
      if (url.pathname === '/api/pipelines') return json(200, { items: pipelines, nextCursor: null });
      if (url.pathname === '/api/reports') return json(200, reportBody);
      return json(404, { error: { code: 'not_found', message: 'No.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Reports nav entry', () => {
  it('sits between Pipeline and Research and links to /reports', () => {
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
    const labels = within(nav).getAllByRole('link').map((link) => link.textContent);
    expect(labels.slice(3, 6)).toEqual(['Pipeline', 'Reports', 'Research']);
    expect(within(nav).getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/reports');
  });
});

describe('Reports screen', () => {
  it('preselects 90 days and the first pipeline and asks for both', async () => {
    renderAt('/reports');
    await screen.findByRole('heading', { name: 'Pipeline now' });
    expect(screen.getByLabelText('Period')).toHaveValue('90');
    expect(screen.getByLabelText('Pipeline')).toHaveValue('us');
    const request = calls.filter((call) => call.path === '/api/reports').at(-1)!;
    expect(request.search.get('days')).toBe('90');
    expect(request.search.get('pipelineId')).toBe('us');
  });

  it('rides the URL for both selects and refetches', async () => {
    const user = userEvent.setup();
    renderAt('/reports');
    await screen.findByRole('heading', { name: 'Pipeline now' });
    await user.selectOptions(screen.getByLabelText('Period'), 'Last 30 days');
    expect(screen.getByTestId('url')).toHaveTextContent('days=30');
    await user.selectOptions(screen.getByLabelText('Pipeline'), 'UK investors');
    expect(screen.getByTestId('url').textContent).toMatch(/days=30/);
    expect(screen.getByTestId('url').textContent).toMatch(/pipeline=uk/);
    await waitFor(() => {
      const request = calls.filter((call) => call.path === '/api/reports').at(-1)!;
      expect(request.search.get('days')).toBe('30');
      expect(request.search.get('pipelineId')).toBe('uk');
    });
    await user.selectOptions(screen.getByLabelText('Period'), 'All time');
    expect(screen.getByTestId('url').textContent).toMatch(/days=all/);
    await waitFor(() => {
      const request = calls.filter((call) => call.path === '/api/reports').at(-1)!;
      expect(request.search.has('days')).toBe(false);
    });
  });

  it('reads the selection from a link and falls back for unknown values', async () => {
    renderAt('/reports?days=365&pipeline=uk');
    await screen.findByRole('heading', { name: 'Pipeline now' });
    expect(screen.getByLabelText('Period')).toHaveValue('365');
    expect(screen.getByLabelText('Pipeline')).toHaveValue('uk');
  });

  it('renders the five cards with their data, and every bar carries its value as text', async () => {
    renderAt('/reports');
    for (const name of ['Pipeline now', 'Stage flow', 'New people', 'Outreach', 'Runs']) {
      expect(await screen.findByRole('heading', { name, level: 2 })).toBeInTheDocument();
    }
    const pipeline = screen.getByRole('region', { name: 'Pipeline now' });
    expect(within(pipeline).getByText(/4 open, \$2(\.0)?M/)).toBeInTheDocument();
    expect(within(pipeline).getByText(/approximation/)).toBeInTheDocument();
    expect(within(pipeline).getByText(/1 passed \(£500(\.0)?K\) in this period/)).toBeInTheDocument();
    expect(within(pipeline).getByText(/1 lost in this period/)).toBeInTheDocument();
    const flow = screen.getByRole('region', { name: 'Stage flow' });
    expect(within(flow).getByText('6 entered')).toBeInTheDocument();
    expect(within(flow).getByText(/re-enters a stage counts again/)).toBeInTheDocument();
    const intake = screen.getByRole('region', { name: 'New people' });
    expect(within(intake).getByText('5 (Mailbox 2, CSV 3)')).toBeInTheDocument();
    expect(within(intake).getByText('1 (Manual 1)')).toBeInTheDocument();
    expect(within(intake).getByText('Week of 2 Nov')).toBeInTheDocument();
    for (const label of ['Mailbox', 'LinkedIn', 'CSV', 'Extension', 'Manual']) {
      expect(within(intake).getAllByText(label, { exact: false }).length).toBeGreaterThan(0);
    }
    const outreach = screen.getByRole('region', { name: 'Outreach' });
    expect(within(outreach).getByText('12')).toBeInTheDocument();
    expect(within(outreach).getByText('Opt outs')).toBeInTheDocument();
    const runs = screen.getByRole('region', { name: 'Runs' });
    expect(within(runs).getByText('3: 2 succeeded, 1 failed')).toBeInTheDocument();
    expect(within(runs).getByText(/Estimated spend \$0\.75 \(estimate/)).toBeInTheDocument();
    // Every bar row has a text value beside it.
    for (const row of document.querySelectorAll('.report-row')) {
      expect(row.querySelector('.report-row__value')?.textContent).toMatch(/\d/);
    }
  });

  it('says what each card will show when its period is empty', async () => {
    reportBody = EMPTY;
    renderAt('/reports');
    await screen.findByRole('heading', { name: 'Pipeline now' });
    expect(screen.getByText(/No deals in this pipeline yet/)).toBeInTheDocument();
    expect(screen.getByText(/No deals entered a stage in this period/)).toBeInTheDocument();
    expect(screen.getByText(/No people were added in this period/)).toBeInTheDocument();
    expect(screen.getByText(/No email activity in this period/)).toBeInTheDocument();
    expect(screen.getByText(/No runs finished in this period/)).toBeInTheDocument();
  });

  it('only reads: it never issues a POST, PATCH, PUT, or DELETE', async () => {
    const user = userEvent.setup();
    renderAt('/reports');
    await screen.findByRole('heading', { name: 'Pipeline now' });
    await user.selectOptions(screen.getByLabelText('Period'), 'Last 365 days');
    await user.selectOptions(screen.getByLabelText('Pipeline'), 'UK investors');
    await waitFor(() => expect(calls.filter((call) => call.path === '/api/reports').length).toBeGreaterThan(2));
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});
