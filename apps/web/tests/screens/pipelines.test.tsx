import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Pipeline } from '../../src/screens/Pipeline';
import { NewOpportunitySheet } from '../../src/screens/NewOpportunitySheet';
import { GeneralSettings } from '../../src/screens/Settings';
import { Router } from '../helpers';

const pushToast = vi.fn();
vi.mock('../../src/lib/ui', () => ({
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
vi.mock('../../src/api/events', () => ({
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

const json = (status: number, body: unknown): Response =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const TEMPLATES = [
  {
    id: 'startup-fundraising',
    name: 'Startup fundraising',
    description: 'Raise a round from investors.',
    pipelineName: 'Fundraising',
    stageNames: ['Research', 'Qualified', 'Meeting'],
  },
  {
    id: 'fund-lp',
    name: 'Fund LP fundraising',
    description: 'Raise a fund from limited partners.',
    pipelineName: 'LP fundraising',
    stageNames: ['Research', 'Qualified', 'Due diligence'],
  },
  {
    id: 'client-sales',
    name: 'Client sales',
    description: 'Sell to buyers.',
    pipelineName: 'Sales',
    stageNames: ['Research', 'Outreach', 'Proposal'],
  },
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

function opportunityRecord(id: string, name: string, pipelineId: string, stageSeq: number, extra: Record<string, unknown> = {}) {
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
    ...extra,
  };
}

function resetData() {
  pipelines = [
    pipelineRecord('us', 'US investor pipeline', 'startup-fundraising', 3, ['Research', 'Qualified', 'Meeting']),
    pipelineRecord('uk', 'UK investor pipeline', 'fund-lp', 1, ['Research', 'Qualified', 'Due diligence']),
  ];
  opportunities = [
    opportunityRecord('opp-us-1', 'Acme round', 'us', 1),
    opportunityRecord('opp-us-2', 'Birch round', 'us', 2),
    opportunityRecord('opp-uk-1', 'Lantern fund', 'uk', 3),
  ];
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, search: url.searchParams, body });

      if (url.pathname === '/api/templates') return json(200, { items: TEMPLATES, nextCursor: null });
      if (url.pathname === '/api/workspace') return json(200, { id: 'ws-1', name: 'Demo workspace', version: 1 });
      if (url.pathname === '/api/health') return json(200, { ok: true, version: '1.0.0', dbPath: 'data/agentcrm.db' });
      if (url.pathname === '/api/connectors/model') return json(200, { kind: null });

      if (url.pathname === '/api/pipelines' && method === 'GET') return json(200, { items: pipelines, nextCursor: null });
      if (url.pathname === '/api/pipelines' && method === 'POST') {
        const template = TEMPLATES.find((item) => item.id === body.template)!;
        const created = pipelineRecord(`new-${pipelines.length}`, body.name, template.id, 1, template.stageNames);
        pipelines.push(created);
        return json(201, created);
      }
      const pipelineMatch = url.pathname.match(/^\/api\/pipelines\/([^/]+)$/);
      if (pipelineMatch && method === 'PATCH') {
        const target = pipelines.find((item) => item.id === pipelineMatch[1])!;
        if (body.expectedVersion !== target.version) {
          return json(409, { error: { code: 'version_conflict', message: 'This record changed since you loaded it.', current: target } });
        }
        target.name = body.fields.name;
        target.version += 1;
        return json(200, target);
      }
      if (pipelineMatch && method === 'DELETE') {
        pipelines = pipelines.filter((item) => item.id !== pipelineMatch[1]);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/api/workspace/template' && method === 'POST') {
        const target = pipelines.find((item) => item.id === body.pipelineId)!;
        const template = TEMPLATES.find((item) => item.id === body.template)!;
        const next = pipelineRecord(target.id, target.name, template.id, target.version + 1, template.stageNames);
        pipelines[pipelines.indexOf(target)] = next;
        return json(200, next);
      }
      if (url.pathname === '/api/opportunities' && method === 'GET') {
        const pipelineId = url.searchParams.get('pipelineId');
        const status = url.searchParams.get('status');
        const items = opportunities.filter((item) => (!pipelineId || item.pipelineId === pipelineId) && (!status || item.status === status));
        return json(200, { items, nextCursor: null });
      }
      if (url.pathname === '/api/opportunities' && method === 'POST') {
        const stagePipeline = pipelines.find((item) => item.stages.some((stage: any) => stage.id === body.stageId))!;
        const created = opportunityRecord('opp-new', body.name, stagePipeline.id, 1, { stageId: body.stageId });
        opportunities.push(created);
        return json(201, created);
      }
      if (url.pathname === '/api/activities') return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function renderPipeline(entry = '/pipeline') {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[entry]}>
        <Where />
        <Routes>
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/settings/general" element={<GeneralSettings />} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

const where = () => screen.getByTestId('where').textContent;
const select = () => screen.getByLabelText('Pipeline') as HTMLSelectElement;
const callsTo = (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path);
const columns = () => within(screen.getByRole('list', { name: 'Pipeline stages' })).getAllByRole('heading', { level: 2 }).map((node) => node.textContent);

// The select shows up once the pipelines load. A pipeline with no open deals shows its empty message instead of a board.
async function boardReady() {
  await screen.findByLabelText('Pipeline');
  await waitFor(() => expect(screen.queryByText(/^Loading/)).not.toBeInTheDocument());
}

beforeEach(() => {
  calls = [];
  pushToast.mockClear();
  resetData();
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Pipeline switcher', () => {
  it('lists every pipeline, defaults to the first, and shows only its deals', async () => {
    renderPipeline();
    await boardReady();
    expect(within(select()).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'US investor pipeline',
      'UK investor pipeline',
    ]);
    expect(select()).toHaveValue('us');
    expect(await screen.findByText('Acme round')).toBeInTheDocument();
    expect(screen.getByText('Birch round')).toBeInTheDocument();
    expect(screen.queryByText('Lantern fund')).not.toBeInTheDocument();
    expect(columns()).toEqual(['Research', 'Qualified', 'Meeting']);
  });

  it('opens the pipeline named in the URL and falls back to the first for an unknown id', async () => {
    renderPipeline('/pipeline?pipeline=uk');
    await boardReady();
    expect(select()).toHaveValue('uk');
    expect(await screen.findByText('Lantern fund')).toBeInTheDocument();
    expect(screen.queryByText('Acme round')).not.toBeInTheDocument();
    expect(columns()).toEqual(['Research', 'Qualified', 'Due diligence']);
  });

  it('falls back to the first pipeline when the id is unknown', async () => {
    renderPipeline('/pipeline?pipeline=nope');
    await boardReady();
    expect(select()).toHaveValue('us');
    expect(await screen.findByText('Acme round')).toBeInTheDocument();
  });

  it('writes the choice to the URL and scopes the board and the table to it', async () => {
    const { user } = renderPipeline();
    await boardReady();
    await screen.findByText('Acme round');
    await user.selectOptions(select(), 'uk');
    expect(where()).toBe('/pipeline?pipeline=uk');
    expect(await screen.findByText('Lantern fund')).toBeInTheDocument();
    expect(screen.queryByText('Acme round')).not.toBeInTheDocument();
    expect(callsTo('GET', '/api/opportunities').some((call) => call.search.get('pipelineId') === 'uk')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Table' }));
    // The virtual table renders no rows without layout, so the row count (header plus deals) shows the scope.
    const table = await screen.findByRole('grid', { name: 'Opportunities' });
    expect(table).toHaveAttribute('aria-rowcount', '2');
    await user.selectOptions(select(), 'us');
    await waitFor(() => expect(screen.getByRole('grid', { name: 'Opportunities' })).toHaveAttribute('aria-rowcount', '3'));
  });

  it('switches the board to the open deal\'s own pipeline when a deep link names another one', async () => {
    renderPipeline('/pipeline?pipeline=us&opportunity=opp-uk-1');
    await waitFor(() => expect(select()).toHaveValue('uk'));
    expect(where()).toContain('pipeline=uk');
    expect(where()).toContain('opportunity=opp-uk-1');
    expect(await screen.findByRole('heading', { name: 'Lantern fund' })).toBeInTheDocument();
  });
});

describe('New pipeline', () => {
  it('needs a name, lists templates with their stages, posts, and switches the board to the new pipeline', async () => {
    const { user } = renderPipeline();
    await boardReady();
    await user.click(screen.getByRole('button', { name: 'New pipeline' }));
    const create = await screen.findByRole('button', { name: 'Create pipeline' });
    expect(screen.getByText('Research, Qualified, Due diligence')).toBeInTheDocument();
    expect(screen.getByText('Raise a fund from limited partners.')).toBeInTheDocument();
    // A blank name disables the button; the name is required.
    await user.clear(screen.getByLabelText('Name'));
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), '   ');
    expect(create).toBeDisabled();
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Sales UK');
    await user.click(screen.getByRole('radio', { name: /Client sales/ }));
    expect(create).toBeEnabled();
    await user.click(create);

    await waitFor(() => expect(callsTo('POST', '/api/pipelines')).toHaveLength(1));
    expect(callsTo('POST', '/api/pipelines')[0]!.body).toEqual({ name: 'Sales UK', template: 'client-sales' });
    await waitFor(() => expect(select()).toHaveValue('new-2'));
    expect(where()).toBe('/pipeline?pipeline=new-2');
    expect(screen.queryByRole('dialog', { name: 'New pipeline' })).not.toBeInTheDocument();
    // The new pipeline holds no deals yet, so the board shows the empty message for it.
    expect(await screen.findByText(/No open opportunities yet/)).toBeInTheDocument();
    expect(screen.queryByText('Acme round')).not.toBeInTheDocument();
  });

  it('preselects the first template when none is chosen', async () => {
    const { user } = renderPipeline();
    await boardReady();
    await user.click(screen.getByRole('button', { name: 'New pipeline' }));
    const field = await screen.findByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'Plain');
    await user.click(screen.getByRole('button', { name: 'Create pipeline' }));
    await waitFor(() => expect(callsTo('POST', '/api/pipelines')[0]!.body).toEqual({ name: 'Plain', template: 'startup-fundraising' }));
  });

  it('prefills the name with the chosen template\'s pipeline name until the user edits it by hand', async () => {
    const { user } = renderPipeline();
    await boardReady();
    await user.click(screen.getByRole('button', { name: 'New pipeline' }));
    const field = await screen.findByLabelText('Name');
    expect(field).toHaveValue('Fundraising');
    await user.click(screen.getByRole('radio', { name: /Fund LP fundraising/ }));
    expect(field).toHaveValue('LP fundraising');
    await user.click(screen.getByRole('radio', { name: /Client sales/ }));
    expect(field).toHaveValue('Sales');

    await user.clear(field);
    await user.type(field, 'UK investors');
    await user.click(screen.getByRole('radio', { name: /Fund LP fundraising/ }));
    expect(field).toHaveValue('UK investors');
    await user.click(screen.getByRole('button', { name: 'Create pipeline' }));
    await waitFor(() => expect(callsTo('POST', '/api/pipelines')[0]!.body).toEqual({ name: 'UK investors', template: 'fund-lp' }));
  });
});

describe('Rename pipeline', () => {
  it('prefills the name and patches with the pipeline version', async () => {
    const { user } = renderPipeline();
    await boardReady();
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const field = await screen.findByLabelText('Name');
    expect(field).toHaveValue('US investor pipeline');
    expect(screen.getByRole('button', { name: 'Rename pipeline' })).toBeDisabled();
    await user.clear(field);
    await user.type(field, 'US investors');
    await user.click(screen.getByRole('button', { name: 'Rename pipeline' }));
    await waitFor(() => expect(callsTo('PATCH', '/api/pipelines/us')).toHaveLength(1));
    expect(callsTo('PATCH', '/api/pipelines/us')[0]!.body).toEqual({ expectedVersion: 3, fields: { name: 'US investors' } });
    await waitFor(() => expect(within(select()).getByRole('option', { name: 'US investors' })).toBeInTheDocument());
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('shows a version conflict inline and keeps the sheet open', async () => {
    const { user } = renderPipeline();
    await boardReady();
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const field = await screen.findByLabelText('Name');
    pipelines[0].version = 9;
    await user.clear(field);
    await user.type(field, 'Stale name');
    await user.click(screen.getByRole('button', { name: 'Rename pipeline' }));
    expect(await screen.findByText(/changed since you opened this sheet/)).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });
});

describe('Delete pipeline', () => {
  it('is disabled with the deal count while the pipeline holds deals of any status', async () => {
    opportunities.push(opportunityRecord('opp-us-3', 'Old pass', 'us', 1, { status: 'passed', reason: 'No fit' }));
    renderPipeline();
    await boardReady();
    expect(await screen.findByText('This pipeline still holds 3 deals.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('says a single deal in the singular', async () => {
    renderPipeline('/pipeline?pipeline=uk');
    await boardReady();
    expect(await screen.findByText('This pipeline still holds 1 deal.')).toBeInTheDocument();
  });

  it('is disabled with its reason for the only pipeline', async () => {
    pipelines = [pipelines[0]];
    opportunities = [];
    renderPipeline();
    await boardReady();
    expect(await screen.findByText('This is the only pipeline.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('asks for an inline confirm, can be cancelled, then deletes and falls back to the first pipeline', async () => {
    opportunities = opportunities.filter((item) => item.pipelineId !== 'uk');
    const { user } = renderPipeline('/pipeline?pipeline=uk');
    await boardReady();
    const remove = screen.getByRole('button', { name: 'Delete' });
    await waitFor(() => expect(remove).toBeEnabled());

    await user.click(remove);
    expect(screen.getByText(/Delete UK investor pipeline\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep pipeline' }));
    expect(callsTo('DELETE', '/api/pipelines/uk')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete pipeline' }));
    await waitFor(() => expect(callsTo('DELETE', '/api/pipelines/uk')).toHaveLength(1));
    await waitFor(() => expect(select()).toHaveValue('us'));
    expect(where()).toBe('/pipeline');
    expect(pushToast).toHaveBeenCalledWith('Deleted UK investor pipeline.');
    expect(within(select()).getAllByRole('option')).toHaveLength(1);
  });
});

describe('Change template', () => {
  it('is scoped to the selected pipeline: its name in the title, its stages in the mapping, its version in the call', async () => {
    const { user } = renderPipeline('/pipeline?pipeline=uk');
    await boardReady();
    await user.click(screen.getByRole('button', { name: 'Change template' }));
    expect(await screen.findByRole('heading', { name: 'Change template for UK investor pipeline' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Fund LP fundraising/ })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: /Client sales/ }));
    const rows = await screen.findAllByRole('listitem');
    const mapped = rows.filter((row) => row.className.includes('stage-map__row'));
    expect(mapped.map((row) => within(row).getAllByText(/Research|Qualified|Due diligence/)[0]!.textContent)).toEqual([
      'Research',
      'Qualified',
      'Due diligence',
    ]);
    // Only the UK pipeline's one deal counts; the US pipeline's deals do not appear here.
    expect(screen.getByText('1 opportunity')).toBeInTheDocument();
    expect(screen.queryByText(/is renamed|renamed/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(callsTo('POST', '/api/workspace/template')).toHaveLength(1));
    expect(callsTo('POST', '/api/workspace/template')[0]!.body).toEqual({
      pipelineId: 'uk',
      template: 'client-sales',
      stageMapping: { 'uk-s1': 'Research', 'uk-s2': 'Outreach', 'uk-s3': 'Proposal' },
      replaceQualification: true,
      expectedVersion: 1,
    });
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('Template changed to Client sales.'));
    // The switch keeps the pipeline's own name, and the sheet no longer warns about a rename.
    expect(pipelines.find((item) => item.id === 'uk').name).toBe('UK investor pipeline');
    // The US pipeline is untouched.
    expect(pipelines[0].template).toBe('startup-fundraising');
  });
});

describe('New opportunity pipeline select', () => {
  it('preselects the viewed pipeline, follows it with the stage list, and resets the stage on change', async () => {
    const { user } = renderPipeline('/pipeline?pipeline=uk');
    await boardReady();
    await user.click(screen.getByRole('button', { name: 'New opportunity' }));
    const pipelineSelect = (await screen.findByLabelText('Pipeline', { selector: '#new-opportunity-pipeline' })) as HTMLSelectElement;
    expect(pipelineSelect).toHaveValue('uk');
    const stage = screen.getByLabelText('Stage') as HTMLSelectElement;
    expect(within(stage).getAllByRole('option').map((option) => option.textContent)).toEqual(['Research', 'Qualified', 'Due diligence']);

    await user.selectOptions(stage, 'uk-s3');
    expect(stage).toHaveValue('uk-s3');
    await user.selectOptions(pipelineSelect, 'us');
    expect(stage).toHaveValue('us-s1');
    expect(within(stage).getAllByRole('option').map((option) => option.textContent)).toEqual(['Research', 'Qualified', 'Meeting']);

    await user.type(screen.getByLabelText('Name'), 'Cross board');
    await user.click(screen.getByRole('button', { name: 'Create opportunity' }));
    await waitFor(() => expect(callsTo('POST', '/api/opportunities')).toHaveLength(1));
    expect(callsTo('POST', '/api/opportunities')[0]!.body).toMatchObject({ name: 'Cross board', stageId: 'us-s1' });
    // The new deal belongs to the US pipeline, so opening it switches the board there.
    await waitFor(() => expect(select()).toHaveValue('us'));
    expect(where()).toContain('opportunity=opp-new');
  });

  it('defaults to the first pipeline when opened without a viewed board, as from a record sheet', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Router>
          <NewOpportunitySheet onClose={() => {}} onCreated={() => {}} />
        </Router>
      </QueryClientProvider>,
    );
    const pipelineSelect = await screen.findByLabelText('Pipeline');
    await waitFor(() => expect(pipelineSelect).toHaveValue('us'));
    expect(screen.getByLabelText('Stage')).toHaveValue('us-s1');
  });

  it('keys the promotion line on the chosen pipeline\'s stages', async () => {
    const people = [
      { id: 'per-1', version: 1, lifecycle: 'lead', firstName: 'Ada', lastName: 'Quinn', email: null, title: null, organizationId: null, organizationName: null, location: null, tags: [], nextActionAt: null, createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00' },
    ];
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/search') return json(200, { people, organizations: [], opportunities: [] });
      return base(input, init);
    }));
    const { user } = renderPipeline();
    await boardReady();
    await user.click(screen.getByRole('button', { name: 'New opportunity' }));
    const input = await screen.findByRole('combobox', { name: 'Person' });
    await user.type(input, 'Ada');
    await waitFor(() => expect(within(screen.getByRole('listbox')).queryAllByRole('option').length).toBeGreaterThan(0));
    await user.keyboard('{Enter}');
    const line = 'Creating the deal at this stage marks the linked person as a relationship.';
    expect(screen.queryByText(line)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Stage'), 'us-s2');
    expect(screen.getByText(line)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Pipeline', { selector: '#new-opportunity-pipeline' }), 'uk');
    expect(screen.queryByText(line)).not.toBeInTheDocument();
  });
});

describe('Settings General', () => {
  it('no longer shows a Template field or a Change template action', async () => {
    renderPipeline('/settings/general');
    expect(await screen.findByText('Demo workspace')).toBeInTheDocument();
    expect(screen.queryByText('Template')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change template' })).not.toBeInTheDocument();
  });
});
