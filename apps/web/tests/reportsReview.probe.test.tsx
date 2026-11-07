// Adversarial review probes for the Reports screen. Names start with KILLS (the attack fails and the test pins that),
// CONFIRMS (a live bug: the test passes against today's code and the comment says what should happen instead), or
// ACCEPTED (a documented limit). Nothing here changes application code.
import { Component, type ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { Reports } from '../src/screens/Reports';
import { Router } from './helpers';

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
}
let calls: Call[];
let reportBody: any;
let pipelineItems: any[];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const PIPELINES = [
  { id: 'us', workspaceId: 'ws', name: 'US investors', template: 'startup-fundraising', version: 1, stages: [] },
  { id: 'uk', workspaceId: 'ws', name: 'UK investors', template: 'fund-lp', version: 1, stages: [] },
];
const stage = (over: Record<string, unknown> = {}) => ({ stageId: 's1', name: 'Research', seq: 1, openCount: 0, openAmounts: [], passedCount: 0, passedAmounts: [], lostCount: 0, lostAmounts: [], ...over });
const BASE = () => ({
  pipeline: [stage({ openCount: 3 })],
  stageFlow: [{ stageId: 's1', name: 'Research', seq: 1, entered: 2 }],
  intake: { weeks: [{ weekStart: '2026-11-02', total: 2, bySource: { mailbox: 1, linkedin: 0, csv: 0, captured: 0, manual: 1 } }] },
  outreach: { sends: 1, replies: 1, bounces: 0, optOuts: 0 },
  runs: { groups: [{ kind: 'draft', status: 'succeeded', count: 1 }], estimatedUsd: 0, runsWithEstimate: 0 },
});

function renderAt(url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[url]}>
        <Routes>
          <Route path="/reports" element={<Reports />} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
}
const reportCalls = () => calls.filter((call) => call.path === '/api/reports');

beforeEach(() => {
  calls = [];
  reportBody = BASE();
  pipelineItems = PIPELINES;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push({ method: init?.method ?? 'GET', path: url.pathname, search: url.searchParams });
      if (url.pathname === '/api/pipelines') return json(200, { items: pipelineItems, nextCursor: null });
      if (url.pathname === '/api/reports') return json(200, reportBody);
      return json(404, { error: { code: 'not_found', message: 'No.' } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('hostile URL parameters', () => {
  const hostileDays = ['__proto__', 'constructor', 'toString', '0', '-1', '31', 'ALL', 'all%20', '%00', '<b>', '9'.repeat(400), '', '90&days=1'];
  it('KILLS: every hostile ?days= falls back to 90 days, issues exactly one reports GET, and never a mutation', async () => {
    for (const value of hostileDays) {
      calls = [];
      const view = renderAt(`/reports?days=${encodeURIComponent(value)}`);
      await screen.findByRole('heading', { name: 'Pipeline now' });
      expect(screen.getByLabelText('Period')).toHaveValue('90');
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(reportCalls()).toHaveLength(1);
      expect(reportCalls()[0]!.search.get('days')).toBe('90');
      expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
      view.unmount();
    }
  });

  it('KILLS: every hostile ?pipeline= falls back to the first pipeline and the request names a real pipeline id only', async () => {
    for (const value of ['__proto__', 'nope', 'US', ' us', 'us ', "us' OR '1'='1", '<script>', '%00', 'us&pipeline=uk', 'x'.repeat(5000), '']) {
      calls = [];
      const view = renderAt(`/reports?pipeline=${encodeURIComponent(value)}`);
      await screen.findByRole('heading', { name: 'Pipeline now' });
      expect(screen.getByLabelText('Pipeline')).toHaveValue('us');
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(reportCalls()).toHaveLength(1);
      expect(reportCalls()[0]!.search.get('pipelineId')).toBe('us');
      view.unmount();
    }
  });

  it('KILLS: repeated parameters use the first value and still make one request', async () => {
    renderAt('/reports?days=30&days=365&pipeline=uk&pipeline=us');
    await screen.findByRole('heading', { name: 'Pipeline now' });
    expect(screen.getByLabelText('Period')).toHaveValue('30');
    expect(screen.getByLabelText('Pipeline')).toHaveValue('uk');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(reportCalls()).toHaveLength(1);
  });

  it('KILLS: with no pipelines at all the screen still renders, offers no pipeline select, and asks without a pipelineId', async () => {
    pipelineItems = [];
    renderAt('/reports?pipeline=ghost');
    await screen.findByRole('heading', { name: 'Pipeline now' });
    expect(screen.queryByLabelText('Pipeline')).toBeNull();
    expect(reportCalls()).toHaveLength(1);
    expect(reportCalls()[0]!.search.has('pipelineId')).toBe(false);
  });
});

describe('hostile data', () => {
  it('KILLS: stage, pipeline, and run kind names render as inert text, never markup', async () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    pipelineItems = [{ ...PIPELINES[0], name: evil }];
    reportBody = {
      ...BASE(),
      pipeline: [stage({ name: evil, openCount: 1 })],
      stageFlow: [{ stageId: 's1', name: evil, seq: 1, entered: 1 }],
      runs: { groups: [{ kind: evil, status: evil, count: 1 }], estimatedUsd: 0, runsWithEstimate: 0 },
    };
    const view = renderAt('/reports');
    await screen.findByRole('heading', { name: 'Pipeline now' });
    expect(view.container.querySelector('img, script')).toBeNull();
    expect((window as any).__pwned).toBeUndefined();
    expect(within(screen.getByRole('region', { name: 'Stage flow' })).getByText(evil)).toBeInTheDocument();
  });

  it('KILLS: bars on an all zero pipeline card are width 0 percent, never NaN or Infinity', async () => {
    reportBody = { ...BASE(), pipeline: [stage({ lostCount: 2, lostAmounts: [{ currency: 'USD', amount: 5 }] }), stage({ stageId: 's2', name: 'Meeting', seq: 2 })] };
    const view = renderAt('/reports');
    await screen.findByRole('heading', { name: 'Pipeline now' });
    const widths = [...view.container.querySelectorAll<HTMLElement>('[style]')].map((el) => el.getAttribute('style') ?? '');
    expect(widths.join(' ')).not.toMatch(/NaN|Infinity|undefined/);
    expect(view.container.textContent).toContain('2 lost');
    expect(view.container.textContent).not.toMatch(/NaN|undefined|null/);
  });

  it('KILLS: a week whose total is zero and a run group whose count is zero draw no NaN widths', async () => {
    reportBody = {
      ...BASE(),
      intake: { weeks: [{ weekStart: '2026-11-02', total: 0, bySource: { mailbox: 0, linkedin: 0, csv: 0, captured: 0, manual: 0 } }] },
      runs: { groups: [{ kind: 'draft', status: 'failed', count: 0 }], estimatedUsd: 0, runsWithEstimate: 0 },
    };
    const view = renderAt('/reports');
    await screen.findByRole('heading', { name: 'New people' });
    const styles = [...view.container.querySelectorAll('[style]')].map((el) => el.getAttribute('style')).join(' ');
    expect(styles).not.toMatch(/NaN|Infinity/);
    expect(view.container.textContent).not.toMatch(/NaN/);
  });

  it('KILLS: a malformed week or currency from the server degrades to text, not a crash', async () => {
    reportBody = {
      ...BASE(),
      pipeline: [stage({ openCount: 1, openAmounts: [{ currency: 'NOT A CODE', amount: 5 }, { currency: '', amount: 7 }, { currency: '<b>', amount: 1 }] })],
      intake: { weeks: [{ weekStart: 'garbage', total: 1, bySource: { mailbox: 0, linkedin: 0, csv: 0, captured: 0, manual: 1 } }] },
    };
    const view = renderAt('/reports');
    await screen.findByRole('heading', { name: 'Pipeline now' });
    expect(view.container.textContent).toContain('Week of garbage');
    expect(view.container.textContent).not.toMatch(/NaN/);
    expect(view.container.querySelector('b')).toBeNull();
  });

  it('KILLS: a null count from the server degrades to the empty card, with no NaN, null, or undefined text', async () => {
    reportBody = {
      ...BASE(),
      pipeline: [stage({ openCount: null })],
      stageFlow: [{ stageId: 's1', name: 'Research', seq: 1, entered: null }],
    };
    const view = renderAt('/reports');
    await screen.findByRole('heading', { name: 'Stage flow' });
    expect(view.container.textContent).not.toMatch(/NaN|undefined|\bnull\b/);
  });

  it('KILLS: a response that omits a section renders that card empty instead of throwing', async () => {
    // api.reports now defaults every section like api.today, so a version skewed server cannot crash the screen.
    reportBody = { pipeline: BASE().pipeline };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const caught: unknown[] = [];
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error: unknown) {
        caught.push(error);
      }
      render() {
        return this.state.failed ? <p>boundary caught it</p> : this.props.children;
      }
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Router initialEntries={['/reports']}>
          <Boundary>
            <Routes>
              <Route path="/reports" element={<Reports />} />
            </Routes>
          </Boundary>
        </Router>
      </QueryClientProvider>,
    );
    await screen.findByRole('heading', { name: 'Runs' });
    errors.mockRestore();
    expect(caught.length).toBe(0);
    expect(screen.queryByText('boundary caught it')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Pipeline now' })).toBeInTheDocument();
  });

  it('ACCEPTED: an unknown currency code still renders, as plain number and code, because formatAmount falls back', async () => {
    reportBody = { ...BASE(), pipeline: [stage({ openCount: 1, openAmounts: [{ currency: 'ZZZZ9', amount: 1500 }] })] };
    renderAt('/reports');
    await screen.findByRole('heading', { name: 'Pipeline now' });
    expect(screen.getByText(/1 open, .*1,?500.*ZZZZ9|1 open, .*ZZZZ9/)).toBeInTheDocument();
  });
});
