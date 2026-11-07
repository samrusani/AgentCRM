// Adversarial review probes for the multi pipeline web wave. Names start with KILLS (the attack fails), CONFIRMS (a live
// bug: the test passes against today's code and the comment says what should happen), or ACCEPTED (a deliberate limit).
// Nothing here changes application code.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { Pipeline } from '../src/screens/Pipeline';
import { Router } from './helpers';

const pushToast = vi.fn();
vi.mock('../src/lib/ui', () => ({
  useUI: () => ({
    setSelectedRecord: () => {},
    pushToast: (...args: unknown[]) => pushToast(...args),
    toasts: [],
    dismissToast: () => {},
    theme: 'system',
    setTheme: () => {},
  }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../src/api/events', () => ({
  useServerEvents: () => {},
  useEventConnection: () => 'open',
}));

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: any;
}

let calls: Call[];
let pipelines: any[];
let opportunities: any[];
// When set, a list request with no status filter (the per stage count reads) answers 500.
let failCounts: boolean;

const json = (status: number, body: unknown): Response =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const TEMPLATES = [
  { id: 'startup-fundraising', name: 'Startup fundraising', description: 'Raise a round.', pipelineName: 'Fundraising', stageNames: ['Research', 'Qualified', 'Meeting'] },
  { id: 'fund-lp', name: 'Fund LP fundraising', description: 'Raise a fund.', pipelineName: 'LP fundraising', stageNames: ['Research', 'Qualified', 'Due diligence'] },
  { id: 'client-sales', name: 'Client sales', description: 'Sell to buyers.', pipelineName: 'Sales', stageNames: ['Research', 'Outreach', 'Proposal'] },
];

function pipelineRecord(id: string, name: string, template: string, version: number, stageNames: string[]) {
  return {
    id,
    workspaceId: 'ws-1',
    name,
    template,
    version,
    stages: stageNames.map((stageName, index) => ({ id: `${id}-s${index + 1}`, pipelineId: id, name: stageName, seq: index + 1 })),
  };
}

function opportunityRecord(id: string, name: string, pipelineId: string, stageSeq: number) {
  return {
    id,
    version: 1,
    name,
    pipelineId,
    stageId: `${pipelineId}-s${stageSeq}`,
    organizationId: null,
    personId: null,
    amountTarget: null,
    currency: 'USD',
    owner: null,
    status: 'open',
    reason: null,
    nextActionAt: null,
    stageChangedAt: null,
    createdAt: '2026-11-02T10:00:00',
    updatedAt: '2026-11-02T10:00:00',
  };
}

beforeEach(() => {
  calls = [];
  failCounts = false;
  pushToast.mockClear();
  pipelines = [
    pipelineRecord('us', 'US investors', 'startup-fundraising', 3, ['Research', 'Qualified', 'Meeting']),
    pipelineRecord('uk', 'UK investors', 'fund-lp', 1, ['Research', 'Qualified', 'Due diligence']),
    pipelineRecord('empty', 'Empty board', 'client-sales', 1, ['Research', 'Outreach', 'Proposal']),
  ];
  opportunities = [
    opportunityRecord('opp-us-1', 'Acme round', 'us', 1),
    opportunityRecord('opp-uk-1', 'Lantern fund', 'uk', 3),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, search: url.searchParams, body });
      if (url.pathname === '/api/templates') return json(200, { items: TEMPLATES, nextCursor: null });
      if (url.pathname === '/api/pipelines' && method === 'GET') return json(200, { items: pipelines, nextCursor: null });
      const match = url.pathname.match(/^\/api\/pipelines\/([^/]+)$/);
      if (match && method === 'PATCH') {
        const target = pipelines.find((item) => item.id === match[1])!;
        if (body.expectedVersion !== target.version) {
          return json(409, { error: { code: 'version_conflict', message: 'This record changed since you loaded it.', current: target } });
        }
        target.name = body.fields.name;
        target.version += 1;
        return json(200, target);
      }
      if (match && method === 'DELETE') {
        pipelines = pipelines.filter((item) => item.id !== match[1]);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/api/opportunities' && method === 'GET') {
        if (failCounts && !url.searchParams.get('status')) return json(500, { error: { code: 'internal', message: 'Count failed.' } });
        const pipelineId = url.searchParams.get('pipelineId');
        const status = url.searchParams.get('status');
        const items = opportunities.filter((item) => (!pipelineId || item.pipelineId === pipelineId) && (!status || item.status === status));
        return json(200, { items, nextCursor: null });
      }
      if (url.pathname === '/api/activities') return json(200, { items: [], nextCursor: null });
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
const select = () => screen.getByLabelText('Pipeline') as HTMLSelectElement;

function renderPipeline(entry = '/pipeline') {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[entry]}>
        <Where />
        <Link to="/pipeline?pipeline=us">go us</Link>
        <Link to="/pipeline?pipeline=empty">go empty</Link>
        <Routes>
          <Route path="/pipeline" element={<Pipeline />} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
  return { user, client };
}

async function boardReady() {
  await screen.findByLabelText('Pipeline');
  await waitFor(() => expect(screen.queryByText(/^Loading/)).not.toBeInTheDocument());
}

describe('hostile and stale pipeline ids in the URL', () => {
  it.each([
    ['markup', '%3Cscript%3Ealert(1)%3C%2Fscript%3E'],
    ['prototype name', '__proto__'],
    ['constructor', 'constructor'],
    ['path traversal', '..%2F..%2Fetc%2Fpasswd'],
    ['empty', ''],
    ['very long', 'p'.repeat(5000)],
    ['id of a deleted pipeline', 'deleted-long-ago'],
  ])('KILLS: ?pipeline= with %s falls back to the first pipeline and never asks the server about it', async (_label, value) => {
    renderPipeline(`/pipeline?pipeline=${value}`);
    await boardReady();
    expect(select()).toHaveValue('us');
    expect(await screen.findByText('Acme round')).toBeInTheDocument();
    expect(screen.queryByText('Lantern fund')).not.toBeInTheDocument();
    const listCalls = calls.filter((call) => call.path === '/api/opportunities');
    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.every((call) => call.search.get('pipelineId') === 'us')).toBe(true);
    expect(screen.getByRole('button', { name: 'New opportunity' })).toBeEnabled();
  });

  it('KILLS: a repeated ?pipeline= takes the first value', async () => {
    renderPipeline('/pipeline?pipeline=uk&pipeline=us');
    await boardReady();
    expect(select()).toHaveValue('uk');
    expect(await screen.findByText('Lantern fund')).toBeInTheDocument();
  });

  it('KILLS: choosing another pipeline after a deep link closes the deal, writes the choice, and is not pulled back to the deal\'s pipeline', async () => {
    const { user } = renderPipeline('/pipeline?pipeline=us&opportunity=opp-uk-1');
    await waitFor(() => expect(select()).toHaveValue('uk'));
    expect(await screen.findByRole('heading', { name: 'Lantern fund' })).toBeInTheDocument();
    await user.selectOptions(select(), 'us');
    expect(where()).toBe('/pipeline?pipeline=us');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Lantern fund' })).not.toBeInTheDocument());
    expect(select()).toHaveValue('us');
    expect(await screen.findByText('Acme round')).toBeInTheDocument();
  });

  it('KILLS: a deep link to a deal that does not exist says so and leaves the selected pipeline alone', async () => {
    renderPipeline('/pipeline?pipeline=uk&opportunity=opp-ghost');
    expect(await screen.findByText(/This opportunity was not found/)).toBeInTheDocument();
    expect(select()).toHaveValue('uk');
    expect(where()).toContain('pipeline=uk');
  });
});

describe('Delete confirm and sheet versions', () => {
  it('KILLS: an open "Delete X?" confirm closes when the board changes underneath it (back button, or the pipeline removed in another tab), so it never names or deletes a different pipeline', async () => {
    // The confirm resets whenever the active pipeline id changes, whatever caused it.
    const { user } = renderPipeline('/pipeline?pipeline=uk');
    await boardReady();
    opportunities = opportunities.filter((item) => item.pipelineId !== 'uk');
    await user.click(screen.getByRole('link', { name: 'go empty' }));
    await boardReady();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/Delete Empty board\?/)).toBeInTheDocument();
    // The user navigates back to a pipeline that still holds a deal. The confirm is still open, now for that pipeline.
    await user.click(screen.getByRole('link', { name: 'go us' }));
    await waitFor(() => expect(select()).toHaveValue('us'));
    expect(screen.queryByText(/Delete US investors\?/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Delete Empty board\?/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete pipeline' })).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });

  it('KILLS: when the deal counts fail to load, Delete stays disabled, says "Could not count this pipeline\'s deals." and offers a retry wired to the count query', async () => {
    // The reason is muted copy beside Delete, with a quiet Retry that refetches the counts.
    failCounts = true;
    renderPipeline('/pipeline?pipeline=empty');
    await boardReady();
    await waitFor(() => expect(calls.some((call) => call.path === '/api/opportunities' && !call.search.get('status'))).toBe(true));
    const remove = screen.getByRole('button', { name: 'Delete' });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('aria-describedby', 'pipeline-delete-reason');
    expect(screen.getByText("Could not count this pipeline's deals.")).toBeInTheDocument();
    expect(screen.queryByText(/still holds|only pipeline/i)).not.toBeInTheDocument();
    const countCalls = () => calls.filter((call) => call.path === '/api/opportunities' && !call.search.get('status')).length;
    const before = countCalls();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(countCalls()).toBeGreaterThan(before));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('KILLS: the Rename sheet sends the version from when it opened, so a rename made in another tab and delivered by the refetch conflicts instead of being silently overwritten', async () => {
    // The sheet freezes expectedVersion when it opens (3 here), so the server answers 409 and the sheet shows
    // "changed since you opened this sheet".
    const { user, client } = renderPipeline('/pipeline?pipeline=us');
    await boardReady();
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const field = await screen.findByLabelText('Name');
    expect(field).toHaveValue('US investors');
    pipelines[0].name = 'Renamed in tab two';
    pipelines[0].version = 4;
    await client.invalidateQueries({ queryKey: ['pipelines'] });
    await waitFor(() => expect(within(select()).getByRole('option', { name: 'Renamed in tab two' })).toBeInTheDocument());
    await user.clear(field);
    await user.type(field, 'My late rename');
    await user.click(screen.getByRole('button', { name: 'Rename pipeline' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1));
    expect(calls.find((call) => call.method === 'PATCH')!.body.expectedVersion).toBe(3);
    expect(await screen.findByText(/changed since you opened this sheet/)).toBeInTheDocument();
    expect(pipelines[0].name).toBe('Renamed in tab two');
  });
});

describe('New pipeline sheet', () => {
  it('ACCEPTED: once the name is edited by hand (even cleared), changing the template never re-prefills it; a blank name keeps Create disabled', async () => {
    const { user } = renderPipeline('/pipeline?pipeline=us');
    await boardReady();
    await user.click(screen.getByRole('button', { name: 'New pipeline' }));
    const field = await screen.findByLabelText('Name');
    expect(field).toHaveValue('Fundraising');
    await user.click(screen.getByRole('radio', { name: /Fund LP fundraising/ }));
    expect(field).toHaveValue('LP fundraising');
    await user.type(field, ' 2');
    await user.click(screen.getByRole('radio', { name: /Client sales/ }));
    expect(field).toHaveValue('LP fundraising 2');
    await user.clear(field);
    await user.click(screen.getByRole('radio', { name: /Startup fundraising/ }));
    expect(field).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Create pipeline' })).toBeDisabled();
    await user.type(field, '   ');
    expect(screen.getByRole('button', { name: 'Create pipeline' })).toBeDisabled();
  });
});

describe('second tab', () => {
  it('KILLS: record_updated invalidates pipelines and stage counts, and a refetch of pipelines makes a pipeline created elsewhere appear in the select', async () => {
    const source = readFileSync(path.join(__dirname, '..', 'src', 'api', 'events.ts'), 'utf8');
    const recordUpdated = source.slice(source.indexOf('record_updated: ['), source.indexOf('followup_updated:'));
    expect(recordUpdated).toContain("'pipelines'");
    expect(recordUpdated).toContain("'stage-counts'");
    expect(recordUpdated).toContain("'opportunities'");

    const { client } = renderPipeline('/pipeline?pipeline=us');
    await boardReady();
    expect(within(select()).getAllByRole('option')).toHaveLength(3);
    pipelines.push(pipelineRecord('made-elsewhere', 'Made in tab two', 'client-sales', 1, ['Research', 'Outreach', 'Proposal']));
    await client.invalidateQueries({ queryKey: ['pipelines'] });
    await waitFor(() => expect(within(select()).getByRole('option', { name: 'Made in tab two' })).toBeInTheDocument());
    expect(select()).toHaveValue('us');
  });

  it('KILLS: when the selected pipeline is deleted elsewhere the board falls back to the first pipeline instead of crashing or showing a blank board', async () => {
    const { client } = renderPipeline('/pipeline?pipeline=empty');
    await boardReady();
    expect(select()).toHaveValue('empty');
    pipelines = pipelines.filter((item) => item.id !== 'empty');
    await client.invalidateQueries({ queryKey: ['pipelines'] });
    await waitFor(() => expect(select()).toHaveValue('us'));
    expect(await screen.findByText('Acme round')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual(['Research', 'Qualified', 'Meeting']);
  });
});
