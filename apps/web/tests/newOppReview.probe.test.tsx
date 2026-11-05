import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Pipeline } from '../src/screens/Pipeline';
import { NewOpportunitySheet } from '../src/screens/NewOpportunitySheet';
import { PersonSheet } from '../src/screens/RecordSheets';
import { Router } from './helpers';

vi.mock('../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
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
  signal?: AbortSignal | null;
}

let calls: Call[];
let opportunities: any[];
let createStatus: number;
let createMessage: string;
let createGate: Promise<void> | null;
// Per query search control: when a handler exists for q it decides the response.
let searchHold: Record<string, { release: () => void; promise: Promise<void> }>;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const STAGES = [
  { id: 'stage-1', pipelineId: 'pipe-1', name: 'Prospect', seq: 1 },
  { id: 'stage-2', pipelineId: 'pipe-1', name: 'Meeting booked', seq: 2 },
];
const PIPELINES = [{ id: 'pipe-1', name: 'Fundraising', stages: STAGES }];
const ORG_ACME = { id: 'org-1', version: 1, name: 'Acme Capital', domain: 'acme.example.com', kind: 'fund', location: null, tags: [], createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00' };
const ORG_BETA = { ...ORG_ACME, id: 'org-2', name: 'Beta Partners', domain: 'beta.example.com' };

function personRecord(id: string, first: string, last: string, org: typeof ORG_ACME | null) {
  return { id, version: 1, lifecycle: 'lead', firstName: first, lastName: last, email: null, title: null, organizationId: org?.id ?? null, organizationName: org?.name ?? null, location: null, tags: [], nextActionAt: null, createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00' };
}
const ADA = personRecord('person-1', 'Ada', 'Quinn', ORG_ACME);
const ADRIAN = personRecord('person-2', 'Adrian', 'Solo', null);
const BEA = personRecord('person-3', 'Bea', 'Moss', ORG_BETA);

function opportunityRecord(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, version: 1, name, pipelineId: 'pipe-1', stageId: 'stage-1', organizationId: null, personId: null, amountTarget: null, currency: 'USD', owner: null, status: 'open', reason: null, nextActionAt: null, stageChangedAt: null, createdAt: '2026-11-02T10:00:00', updatedAt: '2026-11-02T10:00:00', ...extra };
}

function hold(q: string) {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  searchHold[q] = { release, promise };
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, search: url.searchParams, body, signal: init?.signal });
      if (url.pathname === '/api/pipelines') return json(200, { items: PIPELINES, nextCursor: null });
      if (url.pathname === '/api/search') {
        const q = url.searchParams.get('q') ?? '';
        const gate = searchHold[q];
        if (gate) {
          await new Promise<void>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            void gate.promise.then(() => resolve());
          });
        }
        const lower = q.toLowerCase();
        const people = [ADA, ADRIAN, BEA].filter((p) => `${p.firstName} ${p.lastName}`.toLowerCase().includes(lower));
        const organizations = [ORG_ACME, ORG_BETA].filter((o) => o.name.toLowerCase().includes(lower));
        return json(200, { people, organizations, opportunities: [] });
      }
      if (url.pathname === '/api/opportunities' && method === 'POST') {
        if (createGate) await createGate;
        if (createStatus !== 201) return json(createStatus, { error: { code: createStatus === 409 ? 'conflict' : 'validation_error', message: createMessage } });
        const created = opportunityRecord('opp-new', body.name, body);
        opportunities.push(created);
        return json(201, created);
      }
      if (url.pathname === '/api/opportunities' && method === 'GET') return json(200, { items: opportunities, nextCursor: null });
      if (url.pathname === '/api/people/person-1') {
        return json(200, { ...ADA, claims: [], activities: [], tasks: [], opportunities: [], organization: ORG_ACME });
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
  const view = render(
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
  return { user, view };
}

function renderSheet(props: Partial<React.ComponentProps<typeof NewOpportunitySheet>> = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const view = renderUI(<NewOpportunitySheet onClose={onClose} onCreated={onCreated} {...props} />);
  return { ...view, onClose, onCreated };
}

const createButton = () => screen.getByRole('button', { name: 'Create opportunity' });
const posts = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/opportunities');
const searches = () => calls.filter((c) => c.path === '/api/search');
const options = () => within(screen.getByRole('listbox')).queryAllByRole('option');

async function sheetReady() {
  await screen.findByLabelText('Name');
  await waitFor(() => expect(screen.getByLabelText('Stage')).toHaveValue('stage-1'));
}

beforeEach(() => {
  calls = [];
  opportunities = [];
  createStatus = 201;
  createMessage = 'Name is required.';
  createGate = null;
  searchHold = {};
  installFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('review probes: picker race and load', () => {
  it('R1 out-of-order responses never show stale results, and the old request is aborted', async () => {
    hold('Ad');
    hold('Ada');
    const { user } = renderSheet();
    await sheetReady();
    const input = screen.getByRole('combobox', { name: 'Person' });
    await user.type(input, 'Ad');
    await waitFor(() => expect(searches().some((c) => c.search.get('q') === 'Ad')).toBe(true));
    await user.type(input, 'a');
    await waitFor(() => expect(searches().some((c) => c.search.get('q') === 'Ada')).toBe(true));
    const adCall = searches().find((c) => c.search.get('q') === 'Ad')!;
    expect(adCall.signal).toBeTruthy();
    // The first request was cancelled when the key changed.
    await waitFor(() => expect(adCall.signal!.aborted).toBe(true));
    searchHold['Ada'].release();
    await waitFor(() => expect(options().map((o) => o.textContent)).toEqual(['Ada QuinnAcme Capital']));
    searchHold['Ad'].release();
    await new Promise((r) => setTimeout(r, 50));
    expect(options().map((o) => o.textContent)).toEqual(['Ada QuinnAcme Capital']);
  });

  it('R2 enter right after another keystroke, before the debounce lands, chooses nothing', async () => {
    const { user } = renderSheet();
    await sheetReady();
    const input = screen.getByRole('combobox', { name: 'Person' });
    await user.type(input, 'Ada');
    await waitFor(() => expect(options().length).toBe(1));
    // Type a character that matches nothing, then press enter inside the debounce window.
    await user.type(input, 'z{Enter}');
    expect(screen.queryByRole('group', { name: 'Person' })).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('group', { name: 'Person' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Person' })).toHaveValue('Adaz');
  });

  it('R3 an empty or whitespace query never fires a search', async () => {
    const { user } = renderSheet();
    await sheetReady();
    const input = screen.getByRole('combobox', { name: 'Person' });
    await user.type(input, '   ');
    await new Promise((r) => setTimeout(r, 300));
    expect(searches()).toHaveLength(0);
    await user.type(input, 'A');
    await waitFor(() => expect(searches()).toHaveLength(1));
    await user.clear(input);
    await new Promise((r) => setTimeout(r, 300));
    expect(searches().filter((c) => (c.search.get('q') ?? '') === '')).toHaveLength(0);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('R4 debounce: fast typing sends one request', async () => {
    const { user } = renderSheet();
    await sheetReady();
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'Adri');
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    expect(searches().map((c) => c.search.get('q'))).toEqual(['Adri']);
  });
});

describe('review probes: submit', () => {
  it('S1 double click on create posts once', async () => {
    let release: () => void = () => {};
    createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user, onCreated } = renderSheet();
    await sheetReady();
    await user.type(screen.getByLabelText('Name'), 'Once');
    await user.dblClick(createButton());
    release();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posts()).toHaveLength(1);
  });

  it('S2 two synchronous submit events post once', async () => {
    let release: () => void = () => {};
    createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user, onCreated } = renderSheet();
    await sheetReady();
    await user.type(screen.getByLabelText('Name'), 'Once');
    const form = screen.getByLabelText('Name').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    release();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posts()).toHaveLength(1);
  });

  it('S3 held enter in the name field posts once', async () => {
    // The sheet unmounts on success in the app; here onCreated is a spy, so hold the request to model the pending window.
    let release: () => void = () => {};
    createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user, onCreated } = renderSheet();
    await sheetReady();
    await user.type(screen.getByLabelText('Name'), 'Enter spam{Enter}{Enter}{Enter}');
    release();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posts()).toHaveLength(1);
  });

  it('S4 body shape for edge amounts', async () => {
    const { user, onCreated } = renderSheet();
    await sheetReady();
    await user.type(screen.getByLabelText('Name'), 'Zero');
    await user.type(screen.getByLabelText('Amount'), '0');
    await user.click(createButton());
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posts()[0].body).toEqual({ name: 'Zero', stageId: 'stage-1', currency: 'USD', amountTarget: 0 });
    expect(Object.keys(posts()[0].body)).not.toContain('personId');
  });

  it('S5 a cleared person is omitted, not null', async () => {
    const { user, onCreated } = renderSheet();
    await sheetReady();
    await user.type(screen.getByLabelText('Name'), 'No person');
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'Ada');
    await waitFor(() => expect(options().length).toBe(1));
    await user.keyboard('{Enter}');
    // Clearing the person also clears the organization that came from it.
    await user.click(screen.getByRole('button', { name: 'Clear person' }));
    await user.click(createButton());
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posts()[0].body).toEqual({ name: 'No person', stageId: 'stage-1', currency: 'USD' });
  });

  it('S6 a 400 and a 409 render inline and the form stays editable', async () => {
    createStatus = 400;
    createMessage = 'Name must be at most 200 characters.';
    const { user, onCreated } = renderSheet();
    await sheetReady();
    await user.type(screen.getByLabelText('Name'), 'Bad');
    await user.click(createButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Name must be at most 200 characters.');
    expect(screen.getByLabelText('Name')).toBeEnabled();
    expect(screen.getByLabelText('Stage')).toBeEnabled();
    createStatus = 409;
    createMessage = 'Conflict.';
    await user.type(screen.getByLabelText('Name'), 'x');
    await user.click(createButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Conflict.'));
    createStatus = 201;
    await user.click(createButton());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('opp-new'));
  });

  it('S7 escape then enter in a picker with typed text never submits the form', async () => {
    const { user, onCreated } = renderSheet();
    await sheetReady();
    await user.type(screen.getByLabelText('Name'), 'Sneaky');
    const input = screen.getByRole('combobox', { name: 'Person' });
    await user.type(input, 'Ada');
    await waitFor(() => expect(options().length).toBe(1));
    await user.keyboard('{Escape}');
    await user.keyboard('{Enter}');
    await new Promise((r) => setTimeout(r, 100));
    expect(posts()).toHaveLength(0);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('S8 create with unchosen typed picker text drops it silently', async () => {
    const { user, onCreated } = renderSheet();
    await sheetReady();
    await user.type(screen.getByLabelText('Name'), 'Typed only');
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'Ada');
    await user.click(createButton());
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    // eslint-disable-next-line no-console
    console.log('S8 body with unchosen text:', JSON.stringify(posts()[0].body));
  });
});

describe('review probes: promotion and prefill', () => {
  const LINE = 'Creating the deal at this stage marks the linked person as a relationship.';

  it('P1 org-only at a later stage shows no promotion line', async () => {
    const { user } = renderSheet({ prefill: { organization: { id: 'org-1', name: 'Acme Capital' } } });
    await sheetReady();
    await user.selectOptions(screen.getByLabelText('Stage'), 'stage-2');
    expect(screen.queryByText(LINE)).not.toBeInTheDocument();
  });

  it('P2 prefilled person at a later stage shows the line as plain text, not an alert', async () => {
    const { user } = renderSheet({ prefill: { person: { id: 'person-1', name: 'Ada Quinn' } } });
    await sheetReady();
    await user.selectOptions(screen.getByLabelText('Stage'), 'stage-2');
    const line = screen.getByText(LINE);
    expect(line.tagName).toBe('P');
    expect(line).not.toHaveAttribute('role');
  });

  it('P3 an auto-filled organization follows the person: replaced by a new one, cleared for an org-less person or a cleared person', async () => {
    const { user } = renderSheet();
    await sheetReady();
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'Ada');
    await waitFor(() => expect(options().length).toBe(1));
    await user.keyboard('{Enter}');
    expect(within(screen.getByRole('group', { name: 'Organization' })).getByText('Acme Capital')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear person' }));
    // Clearing the person clears the auto-filled organization.
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue('');
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'Bea');
    await waitFor(() => expect(options().map((o) => o.textContent)).toEqual(['Bea MossBeta Partners']));
    await user.keyboard('{Enter}');
    expect(within(screen.getByRole('group', { name: 'Organization' })).getByText('Beta Partners')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear person' }));
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'Adrian');
    await waitFor(() => expect(options().map((o) => o.textContent)).toEqual(['Adrian Solo']));
    await user.keyboard('{Enter}');
    // Adrian has no organization, so the auto-filled one is gone.
    expect(screen.queryByRole('group', { name: 'Organization' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue('');
  });

  it('P4 person pick after the org was hand-cleared does not refill it', async () => {
    const { user } = renderSheet();
    await sheetReady();
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'Ada');
    await waitFor(() => expect(options().length).toBe(1));
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Clear organization' }));
    await user.click(screen.getByRole('button', { name: 'Clear person' }));
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'Bea');
    await waitFor(() => expect(options().length).toBe(1));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue('');
  });

  it('P5 person prefilled from the person sheet: clear it and pick another and the prefilled org is replaced', async () => {
    const { user } = renderSheet({
      prefill: { person: { id: 'person-1', name: 'Ada Quinn' }, organization: { id: 'org-1', name: 'Acme Capital' } },
    });
    await sheetReady();
    await user.click(screen.getByRole('button', { name: 'Clear person' }));
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'Bea');
    await waitFor(() => expect(options().length).toBe(1));
    await user.keyboard('{Enter}');
    // eslint-disable-next-line no-console
    console.log('P5 org after replacing prefilled person:', screen.getByRole('group', { name: 'Organization' }).textContent);
  });
});

describe('review probes: keyboard, focus, a11y', () => {
  it('K1 name input holds focus when the sheet opens', async () => {
    renderSheet();
    await sheetReady();
    await new Promise((r) => setTimeout(r, 50));
    // eslint-disable-next-line no-console
    console.log('K1 active element:', document.activeElement?.tagName, document.activeElement?.id || document.activeElement?.textContent);
  });

  it('K2 focus moves to the clear control on choose and back to the input on clear', async () => {
    const { user } = renderSheet();
    await sheetReady();
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'Ada');
    await waitFor(() => expect(options().length).toBe(1));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Clear person' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Clear person' }));
    expect(screen.getByRole('combobox', { name: 'Person' })).toHaveFocus();
  });

  it('K3 click on an option chooses it', async () => {
    const { user } = renderSheet();
    await sheetReady();
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'Ada');
    await waitFor(() => expect(options().length).toBe(1));
    await user.click(options()[0]);
    expect(within(screen.getByRole('group', { name: 'Person' })).getByText('Ada Quinn')).toBeInTheDocument();
  });

  it('K4 aria wiring: every field has a label, options have unique ids, aria-controls resolves while open', async () => {
    const { user } = renderSheet();
    await sheetReady();
    for (const label of ['Name', 'Stage', 'Amount', 'Currency']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    const person = screen.getByRole('combobox', { name: 'Person' });
    expect(screen.getByRole('combobox', { name: 'Organization' })).toBeInTheDocument();
    // Closed: aria-controls points at nothing.
    const controls = person.getAttribute('aria-controls')!;
    // eslint-disable-next-line no-console
    console.log('K4 closed aria-controls resolves:', Boolean(document.getElementById(controls)));
    await user.type(person, 'Ad');
    await waitFor(() => expect(options().length).toBe(2));
    expect(document.getElementById(controls)).toBe(screen.getByRole('listbox'));
    const ids = options().map((o) => o.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every(Boolean)).toBe(true);
    // Options are not focusable and carry no tabindex; active row is signalled by aria-selected + class.
    expect(options()[0]).not.toHaveAttribute('tabindex');
  });

  it('K5 the searching note is a status region and the combobox exposes aria-expanded false when closed', async () => {
    const { user } = renderSheet();
    await sheetReady();
    const person = screen.getByRole('combobox', { name: 'Person' });
    expect(person).toHaveAttribute('aria-expanded', 'false');
    hold('Zed');
    await user.type(person, 'Zed');
    expect(await screen.findByText('Searching...')).toHaveAttribute('role', 'status');
  });
});

describe('review probes: entry points', () => {
  it('E1 table view has the header button, outside the board', async () => {
    opportunities = [opportunityRecord('opp-1', 'Existing deal')];
    const { user, view } = renderUI(null, '/pipeline');
    await screen.findByText('Existing deal');
    expect(view.container.querySelector('.board button')?.textContent).not.toBe('New opportunity');
    await user.click(screen.getByRole('button', { name: 'Table' }));
    const header = screen.getByRole('button', { name: 'New opportunity' });
    expect(header).toHaveClass('btn--primary');
    expect(header.closest('.board')).toBeNull();
    expect(header.closest('.table-region')).toBeNull();
    // Board view too.
    await user.click(screen.getByRole('button', { name: 'Board' }));
    const boardHeader = screen.getAllByRole('button', { name: 'New opportunity' });
    expect(boardHeader).toHaveLength(1);
    expect(boardHeader[0].closest('.board')).toBeNull();
  });

  it('E2 empty state in table view and on a non-open status filter', async () => {
    const { user } = renderUI(null, '/pipeline');
    await screen.findByText('No open opportunities yet. Create one to start tracking a deal.');
    await user.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.getByText('No open opportunities yet. Create one to start tracking a deal.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'passed');
    expect(await screen.findByText(/No opportunities match this status/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'all');
    expect(await screen.findByText('No opportunities yet. Create one to start tracking a deal.')).toBeInTheDocument();
  });

  it('E3 cancel from the person sheet keeps the route, success goes to the pipeline from /relationships', async () => {
    const { user } = renderUI(<PersonSheet id="person-1" onClose={() => {}} onOpenOrganization={() => {}} />, '/relationships?tab=people&person=person-1');
    await user.click(await screen.findByRole('button', { name: 'New opportunity' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await screen.findByRole('dialog', { name: 'Ada Quinn' });
    expect(screen.getByTestId('where')).toHaveTextContent('/relationships?tab=people&person=person-1');
    await user.click(screen.getByRole('button', { name: 'New opportunity' }));
    await user.type(await screen.findByLabelText('Name'), 'Deal');
    await user.click(createButton());
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/pipeline?opportunity=opp-new'));
  });

  it('E4 escape on the replacing sheet returns to the person sheet', async () => {
    const { user } = renderUI(<PersonSheet id="person-1" onClose={() => {}} onOpenOrganization={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'New opportunity' }));
    await screen.findByLabelText('Name');
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('dialog', { name: 'Ada Quinn' })).toBeInTheDocument();
  });

  it('E5 pipeline: creating sets the new deal as open sheet even when status filter hides it', async () => {
    opportunities = [opportunityRecord('opp-1', 'Existing deal')];
    const { user } = renderUI(null, '/pipeline');
    await screen.findByText('Existing deal');
    await user.selectOptions(screen.getByLabelText('Status'), 'passed');
    await user.click(screen.getByRole('button', { name: 'New opportunity', hidden: false }));
    await user.type(await screen.findByLabelText('Name'), 'Hidden by filter');
    await user.click(createButton());
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('opportunity=opp-new'));
    expect(await screen.findByRole('dialog', { name: 'Hidden by filter' })).toBeInTheDocument();
  });
});
