import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Pipeline } from '../../src/screens/Pipeline';
import { NewOpportunitySheet } from '../../src/screens/NewOpportunitySheet';
import { OrganizationSheet, PersonSheet } from '../../src/screens/RecordSheets';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({
    setSelectedRecord: () => {},
    pushToast: () => {},
    toasts: [],
    dismissToast: () => {},
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
let opportunities: any[];
let createStatus: number;
// When set, the create request waits for it, so a test can observe the pending state.
let createGate: Promise<void> | null;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const STAGES = [
  { id: 'stage-1', pipelineId: 'pipe-1', name: 'Prospect', seq: 1 },
  { id: 'stage-2', pipelineId: 'pipe-1', name: 'Meeting booked', seq: 2 },
  { id: 'stage-3', pipelineId: 'pipe-1', name: 'Committed', seq: 3 },
];
const PIPELINES = [{ id: 'pipe-1', name: 'Fundraising', stages: STAGES }];

const ORG_ACME = {
  id: 'org-1',
  version: 1,
  name: 'Acme Capital',
  domain: 'acme.example.com',
  kind: 'fund',
  location: null,
  tags: [],
  createdAt: '2026-10-01T10:00:00',
  updatedAt: '2026-11-01T10:00:00',
};

function personRecord(id: string, first: string, last: string, org: typeof ORG_ACME | null) {
  return {
    id,
    version: 1,
    lifecycle: 'lead',
    firstName: first,
    lastName: last,
    email: null,
    title: null,
    organizationId: org?.id ?? null,
    organizationName: org?.name ?? null,
    location: null,
    tags: [],
    nextActionAt: null,
    createdAt: '2026-10-01T10:00:00',
    updatedAt: '2026-11-01T10:00:00',
  };
}

const ADA = personRecord('person-1', 'Ada', 'Quinn', ORG_ACME);
const ADRIAN = personRecord('person-2', 'Adrian', 'Solo', null);
const MANY_PEOPLE = Array.from({ length: 10 }, (_, index) => personRecord(`bulk-${index}`, `Casey${index}`, 'Bulk', null));

function opportunityRecord(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    version: 1,
    name,
    pipelineId: 'pipe-1',
    stageId: 'stage-1',
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

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, search: url.searchParams, body });
      if (url.pathname === '/api/pipelines') return json(200, { items: PIPELINES, nextCursor: null });
      if (url.pathname === '/api/search') {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const people = [ADA, ADRIAN, ...MANY_PEOPLE].filter((p) => `${p.firstName} ${p.lastName}`.toLowerCase().includes(q));
        const organizations = [ORG_ACME].filter((o) => o.name.toLowerCase().includes(q));
        return json(200, { people, organizations, opportunities: [] });
      }
      if (url.pathname === '/api/opportunities' && method === 'POST') {
        if (createGate) await createGate;
        if (createStatus !== 201) {
          return json(createStatus, { error: { code: 'not_found', message: 'Person not found.' } });
        }
        const created = opportunityRecord('opp-new', body.name, body);
        opportunities.push(created);
        return json(201, created);
      }
      if (url.pathname === '/api/opportunities' && method === 'GET') return json(200, { items: opportunities, nextCursor: null });
      if (url.pathname === '/api/people/person-1') {
        return json(200, {
          ...ADA,
          claims: [],
          activities: [],
          tasks: [],
          opportunities: [],
          organization: ORG_ACME,
        });
      }
      if (url.pathname === '/api/organizations/org-1') {
        return json(200, { ...ORG_ACME, people: [], claims: [], activities: [], opportunities: [] });
      }
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      if (url.pathname === '/api/activities') return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function renderUI(ui: React.ReactNode, entry = '/') {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[entry]}>
        <Where />
        <Routes>
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="*" element={ui} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

function renderSheet(props: Partial<React.ComponentProps<typeof NewOpportunitySheet>> = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const view = renderUI(<NewOpportunitySheet onClose={onClose} onCreated={onCreated} {...props} />);
  return { ...view, onClose, onCreated };
}

const createButton = () => screen.getByRole('button', { name: 'Create opportunity' });
const PROMOTION_LINE = 'Creating the deal at this stage marks the linked person as a relationship.';

async function sheetReady() {
  await screen.findByLabelText('Name');
  await waitFor(() => expect(screen.getByLabelText('Stage')).toHaveValue('stage-1'));
}

// The stage select also has option roles, so matches are read from inside the picker's listbox.
const matchOptions = () => within(screen.getByRole('listbox')).queryAllByRole('option');

async function waitForMatches() {
  await waitFor(() => expect(matchOptions().length).toBeGreaterThan(0));
}

async function pickPerson(user: ReturnType<typeof userEvent.setup>, query: string) {
  const input = screen.getByRole('combobox', { name: 'Person' });
  await user.type(input, query);
  await waitForMatches();
  return input;
}

const postCalls = () => calls.filter((call) => call.method === 'POST' && call.path === '/api/opportunities');

beforeEach(() => {
  calls = [];
  opportunities = [];
  createStatus = 201;
  createGate = null;
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('New opportunity sheet', () => {
  it('keeps the create button disabled until the name has text', async () => {
    const { user } = renderSheet();
    await sheetReady();
    expect(createButton()).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), '   ');
    expect(createButton()).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), 'Acme seed round');
    expect(createButton()).toBeEnabled();
  });

  it('lists the pipeline stages in order with the first preselected, and USD as the currency', async () => {
    renderSheet();
    await sheetReady();
    const stage = screen.getByLabelText('Stage');
    expect(within(stage).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Prospect',
      'Meeting booked',
      'Committed',
    ]);
    expect(stage).toHaveValue('stage-1');
    expect(screen.getByLabelText('Currency')).toHaveValue('USD');
  });

  it('posts the stage, person, organization, amount, and currency', async () => {
    const { user, onCreated } = renderSheet();
    await sheetReady();
    await user.type(screen.getByLabelText('Name'), '  Acme seed round ');
    await pickPerson(user, 'Ada');
    await user.keyboard('{Enter}');
    await user.selectOptions(screen.getByLabelText('Stage'), 'stage-2');
    await user.type(screen.getByLabelText('Amount'), '250000');
    await user.selectOptions(screen.getByLabelText('Currency'), 'EUR');
    await user.click(createButton());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('opp-new'));
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body).toEqual({
      name: 'Acme seed round',
      stageId: 'stage-2',
      personId: 'person-1',
      organizationId: 'org-1',
      amountTarget: 250000,
      currency: 'EUR',
    });
  });

  it('omits the optional fields that were left empty', async () => {
    const { user, onCreated } = renderSheet();
    await sheetReady();
    await user.type(screen.getByLabelText('Name'), 'Loose idea');
    await user.click(createButton());
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(postCalls()[0].body).toEqual({ name: 'Loose idea', stageId: 'stage-1', currency: 'USD' });
  });

  it('prefills the organization from the chosen person and keeps it editable', async () => {
    const { user } = renderSheet();
    await sheetReady();
    expect(screen.getByRole('combobox', { name: 'Organization' })).toBeInTheDocument();
    await pickPerson(user, 'Ada');
    await user.keyboard('{Enter}');
    const organizationGroup = screen.getByRole('group', { name: 'Organization' });
    expect(within(organizationGroup).getByText('Acme Capital')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear organization' }));
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue('');
  });

  it('does not replace an organization the user chose by hand when a person is picked later', async () => {
    const { user } = renderSheet();
    await sheetReady();
    await user.type(screen.getByRole('combobox', { name: 'Organization' }), 'Acme');
    await waitForMatches();
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Clear organization' }));
    await pickPerson(user, 'Ada');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue('');
  });

  it('states the relationship promotion only when the stage is past the first and a person is linked', async () => {
    const { user } = renderSheet();
    await sheetReady();
    // No person yet: no line, whatever the stage.
    await user.selectOptions(screen.getByLabelText('Stage'), 'stage-2');
    expect(screen.queryByText(PROMOTION_LINE)).not.toBeInTheDocument();
    // Person and a later stage: the line shows.
    await pickPerson(user, 'Adrian');
    await user.keyboard('{Enter}');
    expect(screen.getByText(PROMOTION_LINE)).toBeInTheDocument();
    // Person and the first stage: gone again.
    await user.selectOptions(screen.getByLabelText('Stage'), 'stage-1');
    expect(screen.queryByText(PROMOTION_LINE)).not.toBeInTheDocument();
    // Clearing the person at a later stage removes it too.
    await user.selectOptions(screen.getByLabelText('Stage'), 'stage-3');
    expect(screen.getByText(PROMOTION_LINE)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear person' }));
    expect(screen.queryByText(PROMOTION_LINE)).not.toBeInTheDocument();
  });

  it('shows a server failure inline, keeps the sheet open, and lets the user retry', async () => {
    createStatus = 404;
    const { user, onCreated } = renderSheet();
    await sheetReady();
    await user.type(screen.getByLabelText('Name'), 'Doomed deal');
    await user.click(createButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Person not found.');
    expect(alert).toHaveTextContent('The opportunity was not created.');
    expect(onCreated).not.toHaveBeenCalled();
    await waitFor(() => expect(createButton()).toBeEnabled());
  });

  it('disables create while the request and its refetches are in flight', async () => {
    let release: () => void = () => {};
    createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user, onCreated } = renderSheet();
    await sheetReady();
    await user.type(screen.getByLabelText('Name'), 'Quick one');
    await user.click(createButton());
    expect(await screen.findByRole('button', { name: 'Creating...' })).toBeDisabled();
    expect(onCreated).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('blocks a fractional or negative amount before it reaches the server', async () => {
    const { user } = renderSheet();
    await sheetReady();
    await user.type(screen.getByLabelText('Name'), 'Odd amount');
    await user.type(screen.getByLabelText('Amount'), '12.5');
    expect(createButton()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('whole number');
  });

  it('starts from the prefilled record', async () => {
    renderSheet({
      prefill: { person: { id: 'person-1', name: 'Ada Quinn' }, organization: { id: 'org-1', name: 'Acme Capital' } },
    });
    await sheetReady();
    expect(within(screen.getByRole('group', { name: 'Person' })).getByText('Ada Quinn')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Organization' })).getByText('Acme Capital')).toBeInTheDocument();
  });
});

describe('Record picker', () => {
  it('chooses with the arrow keys and enter, and exposes combobox roles', async () => {
    const { user } = renderSheet();
    await sheetReady();
    const input = await pickPerson(user, 'Ad');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const options = matchOptions();
    expect(options.map((option) => option.textContent)).toEqual(['Ada QuinnAcme Capital', 'Adrian Solo']);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
    await user.keyboard('{ArrowDown}');
    expect(matchOptions()[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(within(screen.getByRole('group', { name: 'Person' })).getByText('Adrian Solo')).toBeInTheDocument();
    // Enter chose a record; it did not submit the form.
    expect(postCalls()).toHaveLength(0);
  });

  it('lists at most eight matches', async () => {
    const { user } = renderSheet();
    await sheetReady();
    await pickPerson(user, 'Casey');
    expect(matchOptions()).toHaveLength(8);
  });

  it('closes the list on escape without closing the sheet', async () => {
    const { user, onClose } = renderSheet();
    await sheetReady();
    await pickPerson(user, 'Ada');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Person' })).toHaveAttribute('aria-expanded', 'false');
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears the chosen record and returns to an empty input', async () => {
    const { user } = renderSheet();
    await sheetReady();
    await pickPerson(user, 'Ada');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('combobox', { name: 'Person' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear person' }));
    const input = screen.getByRole('combobox', { name: 'Person' });
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
  });

  it('searches through the search endpoint and never creates a record', async () => {
    const { user } = renderSheet();
    await sheetReady();
    await pickPerson(user, 'Ada');
    expect(calls.some((call) => call.path === '/api/search' && call.search.get('q') === 'Ada')).toBe(true);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('says so when nothing matches', async () => {
    const { user } = renderSheet();
    await sheetReady();
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'Zzz');
    expect(await screen.findByText('No people match this search.')).toBeInTheDocument();
  });
});

describe('Pipeline entry point', () => {
  it('shows a primary New opportunity button in the header and opens the sheet', async () => {
    opportunities = [opportunityRecord('opp-1', 'Existing deal')];
    const { user } = renderUI(null, '/pipeline');
    const header = await screen.findByRole('button', { name: 'New opportunity' });
    expect(header).toHaveClass('btn--primary');
    await user.click(header);
    expect(await screen.findByRole('dialog', { name: 'New opportunity' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Stage')).toHaveValue('stage-1'));
  });

  it('creates a deal and opens its sheet on the pipeline route', async () => {
    opportunities = [opportunityRecord('opp-1', 'Existing deal')];
    const { user } = renderUI(null, '/pipeline');
    await user.click(await screen.findByRole('button', { name: 'New opportunity' }));
    await user.type(await screen.findByLabelText('Name'), 'Fresh deal');
    await user.click(createButton());
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/pipeline?opportunity=opp-new'));
    expect(await screen.findByRole('dialog', { name: 'Fresh deal' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'New opportunity' })).not.toBeInTheDocument();
  });

  it('invites creation from the empty screen', async () => {
    const { user } = renderUI(null, '/pipeline');
    expect(await screen.findByText('No open opportunities yet. Create one to start tracking a deal.')).toBeInTheDocument();
    const inEmptyState = screen
      .getAllByRole('button', { name: 'New opportunity' })
      .filter((button) => !button.classList.contains('btn--primary'));
    expect(inEmptyState).toHaveLength(1);
    await user.click(inEmptyState[0]);
    expect(await screen.findByRole('dialog', { name: 'New opportunity' })).toBeInTheDocument();
  });
});

describe('Record sheet entry points', () => {
  it('person sheet offers a quiet New opportunity action prefilled with the person and organization', async () => {
    const onClose = vi.fn();
    const { user } = renderUI(<PersonSheet id="person-1" onClose={onClose} onOpenOrganization={() => {}} />);
    const action = await screen.findByRole('button', { name: 'New opportunity' });
    expect(action).toHaveClass('btn--quiet');
    await user.click(action);
    expect(await screen.findByRole('dialog', { name: 'New opportunity' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Ada Quinn' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Person' })).getByText('Ada Quinn')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Organization' })).getByText('Acme Capital')).toBeInTheDocument();
    // Cancel returns to the person sheet.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Ada Quinn' })).toBeInTheDocument();
  });

  it('person sheet creation lands on the new opportunity in the pipeline', async () => {
    const { user } = renderUI(<PersonSheet id="person-1" onClose={() => {}} onOpenOrganization={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'New opportunity' }));
    await user.type(await screen.findByLabelText('Name'), 'From the person');
    await user.click(createButton());
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/pipeline?opportunity=opp-new'));
    expect(postCalls()[0].body).toMatchObject({ personId: 'person-1', organizationId: 'org-1', name: 'From the person' });
  });

  it('organization sheet offers a quiet New opportunity action prefilled with the organization only', async () => {
    const { user } = renderUI(<OrganizationSheet id="org-1" onClose={() => {}} onOpenPerson={() => {}} />);
    const action = await screen.findByRole('button', { name: 'New opportunity' });
    expect(action).toHaveClass('btn--quiet');
    await user.click(action);
    expect(await screen.findByRole('dialog', { name: 'New opportunity' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Organization' })).getByText('Acme Capital')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Person' })).toHaveValue('');
    await user.type(screen.getByLabelText('Name'), 'From the org');
    await user.click(createButton());
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/pipeline?opportunity=opp-new'));
    expect(postCalls()[0].body).toEqual({
      name: 'From the org',
      stageId: 'stage-1',
      organizationId: 'org-1',
      currency: 'USD',
    });
  });
});
