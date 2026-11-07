// Adversarial review probes for person enrichment in name mode in the web app. Names start with KILLS (a safety
// property holds), CONFIRMS (a live bug is pinned: the test passes because the buggy behavior is real, and the comment
// says what should happen), or ACCEPTED (a documented limit). Nothing here changes application code.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../src/api/client';
import { DEFAULT_LEAD_ACTORS } from '../src/lib/leads';
import { ConnectorSettings } from '../src/screens/ConnectorSettings';
import { PersonSheet } from '../src/screens/RecordSheets';
import { Router } from './helpers';

vi.mock('../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ui')>()),
  useUI: () => ({ setSelectedRecord: () => {} }),
}));

interface Call {
  method: string;
  path: string;
  body: any;
}

interface World {
  person: Record<string, any>;
  enrichment: { run: Record<string, unknown> | null; suggestions: Array<Record<string, unknown>> };
  connectors: Array<Record<string, unknown>>;
  connectorStatus: number;
  connectorGate: Promise<void> | null;
  acceptGate: Promise<void> | null;
  acceptFailure: { status: number; code: string; message: string } | null;
  calls: Call[];
}

let world: World;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const nameDetail =
  'The search for "Jane Doe" returned Jane Doe (VP Engineering at Acme). Check that this is the right person before accepting anything. Suggested 3 fields to fill: linkedinUrl, title, location.';

function freshWorld(): World {
  return {
    person: {
      id: 'p1',
      version: 3,
      firstName: 'Jane',
      lastName: 'Doe',
      email: null,
      title: null,
      organizationId: null,
      location: null,
      linkedinUrl: null,
      xUrl: null,
      tags: [],
      nextActionAt: null,
      qualification: null,
      organization: null,
      affiliationsSummary: null,
      claims: [],
      activities: [],
      tasks: [],
      opportunities: [],
      createdAt: '2026-10-01T10:00:00',
      updatedAt: '2026-11-01T10:00:00',
    },
    enrichment: {
      run: { id: 'run-n', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: nameDetail, suggestedCount: 3, mode: 'name' },
      suggestions: [
        { field: 'linkedinUrl', value: 'https://www.linkedin.com/in/jane-doe' },
        { field: 'title', value: 'VP Engineering at Acme' },
        { field: 'location', value: 'Lisbon, Portugal' },
      ],
    },
    connectors: [{ id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, allowlist: [], settings: { allowlist: [], leadCapture: {} } }],
    connectorStatus: 200,
    connectorGate: null,
    acceptGate: null,
    acceptFailure: null,
    calls: [],
  };
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      world.calls.push({ method, path: `${url.pathname}${url.search}`, body });
      if (url.pathname === '/api/people/p1' && method === 'GET') return json(200, world.person);
      if (url.pathname === '/api/people/p1/enrichment' && method === 'GET') return json(200, world.enrichment);
      if (url.pathname === '/api/people/p1/enrichment' && method === 'POST') {
        if (world.acceptGate) await world.acceptGate;
        if (world.acceptFailure) return json(world.acceptFailure.status, { error: world.acceptFailure });
        return json(200, {});
      }
      if (url.pathname === '/api/connectors') {
        if (world.connectorGate) await world.connectorGate;
        if (world.connectorStatus !== 200) return json(world.connectorStatus, { error: { code: 'internal', message: 'Could not check.' } });
        return json(200, world.connectors);
      }
      if (url.pathname === '/api/connectors/apify' && method === 'PUT') return json(200, world.connectors[0]);
      if (url.pathname === '/api/followup-rules') return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

const posts = (pathStart: string) => world.calls.filter((call) => call.method === 'POST' && call.path.startsWith(pathStart));

function renderPerson() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <Router>
        <PersonSheet id="p1" onClose={() => {}} onOpenOrganization={() => {}} />
      </Router>
    </QueryClientProvider>,
  );
  return { user, client, view };
}

function renderSettings() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <ConnectorSettings />
      </Router>
    </QueryClientProvider>,
  );
  return user;
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

beforeEach(() => {
  window.localStorage.clear();
  world = freshWorld();
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('candidate detail line', () => {
  it('KILLS: hostile scraped text in the detail and in a suggestion value renders as plain text, never as markup, a link, or a handler', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1"> **bold** [click](javascript:alert(1)) ```fence``` <script>window.__pwned=2</script>';
    world.enrichment = {
      run: { id: 'run-n', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: `The search returned ${hostile}`, suggestedCount: 1, mode: 'name' },
      suggestions: [{ field: 'title', value: hostile }],
    };
    const { view } = renderPerson();
    const section = (await screen.findByRole('heading', { name: 'Suggestions' })).closest('section') as HTMLElement;
    expect(section.textContent).toContain(hostile);
    expect(section.querySelector('img, script, a, strong, code')).toBeNull();
    expect((window as any).__pwned).toBeUndefined();
    expect(view.container.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('KILLS: a very long candidate detail is rendered whole in one muted line and does not add rows or buttons', async () => {
    world.enrichment = {
      run: { id: 'run-n', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: `Found ${'x'.repeat(10_000)}`, suggestedCount: 1, mode: 'name' },
      suggestions: [{ field: 'title', value: 'VP' }],
    };
    renderPerson();
    const section = (await screen.findByRole('heading', { name: 'Suggestions' })).closest('section') as HTMLElement;
    expect(section.querySelectorAll('p.muted')).toHaveLength(1);
    expect(within(section).getAllByRole('button', { name: /^Accept / })).toHaveLength(1);
  });

  it('KILLS: a server that does not send mode (an older payload) never shows the detail above the list', async () => {
    delete (world.enrichment.run as any).mode;
    renderPerson();
    const section = (await screen.findByRole('heading', { name: 'Suggestions' })).closest('section') as HTMLElement;
    expect(within(section).queryByText(nameDetail)).not.toBeInTheDocument();
    expect(section.querySelectorAll('p')).toHaveLength(0);

  });

  it('KILLS: a profile mode run never shows its detail above the list, even when the detail is long', async () => {
    world.person = { ...world.person, linkedinUrl: 'https://www.linkedin.com/in/jane-doe' };
    world.enrichment = {
      run: { id: 'run-p', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: 'Suggested 3 fields to fill: title, location, email.', suggestedCount: 3, mode: 'profile' },
      suggestions: [{ field: 'title', value: 'VP' }],
    };
    renderPerson();
    const section = (await screen.findByRole('heading', { name: 'Suggestions' })).closest('section') as HTMLElement;
    expect(section.querySelectorAll('p')).toHaveLength(0);
  });
});

describe('the mode line and the Enrich button', () => {
  it('KILLS: while the connector check is still loading the name line is shown, the button is disabled, and no reason flashes', async () => {
    world.enrichment = { run: null, suggestions: [] };
    const hold = gate();
    world.connectorGate = hold.promise;
    renderPerson();
    expect(await screen.findByText(/No profile saved, so this searches LinkedIn by their name on your Apify account/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enrich' })).toBeDisabled();
    expect(screen.queryByText('Connect Apify in Settings to enrich')).not.toBeInTheDocument();
    hold.open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enrich' })).toBeEnabled());
    expect(screen.queryByText('Connect Apify in Settings to enrich')).not.toBeInTheDocument();
  });

  it('KILLS: when the connector check itself fails (server error), the sheet says the check failed instead of claiming Apify is not connected, and Enrich stays disabled', async () => {
    world.enrichment = { run: null, suggestions: [] };
    world.connectorStatus = 500;
    renderPerson();
    expect(await screen.findByText('Could not check the Apify connector. Retry from Settings.')).toBeInTheDocument();
    expect(screen.queryByText('Connect Apify in Settings to enrich')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enrich' })).toBeDisabled();
  });

  it('KILLS: a person with a saved profile reads the scrape line, one without reads the name line, and the line follows the record, not the last run', async () => {
    world.person = { ...world.person, linkedinUrl: 'https://www.linkedin.com/in/jane-doe' };
    world.enrichment = { run: { id: 'run-n', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: nameDetail, suggestedCount: 0, mode: 'name' }, suggestions: [] };
    renderPerson();
    expect(await screen.findByText('Runs one profile scrape on your Apify account.')).toBeInTheDocument();
    expect(screen.queryByText(/No profile saved/)).not.toBeInTheDocument();
  });
});

describe('accepting from a name lookup', () => {
  it('KILLS: a 409 on a name lookup suggestion shows the server\'s own reason, not the generic field-changed wording, and Reload suggestions asks for the rows again', async () => {
    world.acceptFailure = { status: 409, code: 'conflict', message: 'A LinkedIn link was saved on this person after the search, so its suggestions were not applied.' };
    const { user } = renderPerson();
    await screen.findByRole('heading', { name: 'Suggestions' });
    await user.click(screen.getByRole('button', { name: 'Accept title' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A LinkedIn link was saved on this person after the search, so its suggestions were not applied.');
    expect(alert).not.toHaveTextContent('changed since you opened this record');
    const reads = world.calls.filter((call) => call.method === 'GET' && call.path === '/api/people/p1/enrichment').length;
    await user.click(screen.getByRole('button', { name: 'Reload suggestions' }));
    await waitFor(() => expect(world.calls.filter((call) => call.method === 'GET' && call.path === '/api/people/p1/enrichment').length).toBeGreaterThan(reads));
    // The mock still serves the same rows; with the real server the dismissed or stale ones would be gone.
    expect(screen.getByRole('button', { name: 'Accept title' })).toBeInTheDocument();
  });

  it('KILLS: a 409 on a profile run suggestion keeps the generic field-changed wording', async () => {
    world.person = { ...world.person, linkedinUrl: 'https://www.linkedin.com/in/jane-doe' };
    world.enrichment = {
      run: { id: 'run-p', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: 'Suggested 1 field to fill: title.', suggestedCount: 1, mode: 'profile' },
      suggestions: [{ field: 'title', value: 'VP Engineering at Acme' }],
    };
    world.acceptFailure = { status: 409, code: 'conflict', message: 'This person already has a title, so the suggestion was not applied.' };
    const { user } = renderPerson();
    await screen.findByRole('heading', { name: 'Suggestions' });
    await user.click(screen.getByRole('button', { name: 'Accept title' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Title changed since you opened this record, so the suggestion was not applied.');
  });

  it('KILLS: two fast clicks on one Accept send one request, and every Accept and Dismiss is disabled while it is in flight', async () => {
    const hold = gate();
    world.acceptGate = hold.promise;
    const { user } = renderPerson();
    await screen.findByRole('heading', { name: 'Suggestions' });
    const button = screen.getByRole('button', { name: 'Accept linkedin' });
    await user.click(button);
    await user.click(button);
    await user.click(screen.getByRole('button', { name: 'Accept title' }));
    expect(posts('/api/people/p1/enrichment')).toHaveLength(1);
    for (const control of [...screen.getAllByRole('button', { name: /^Accept / }), screen.getByRole('button', { name: 'Dismiss' })]) {
      expect(control).toBeDisabled();
    }
    hold.open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled());
  });

  it('KILLS: the accept request carries only the run id, the field, and the record version, never the scraped value', async () => {
    const { user } = renderPerson();
    await screen.findByRole('heading', { name: 'Suggestions' });
    await user.click(screen.getByRole('button', { name: 'Accept location' }));
    await waitFor(() => expect(posts('/api/people/p1/enrichment')).toHaveLength(1));
    expect(posts('/api/people/p1/enrichment')[0]!.body).toEqual({ runId: 'run-n', field: 'location', expectedVersion: 3 });
  });
});

describe('people search actor card', () => {
  it('KILLS: a pasted full URL or a multi part path is refused in the card with a reason and nothing is sent', async () => {
    const user = renderSettings();
    await user.click(await screen.findByRole('button', { name: /Apify/ }));
    const field = await screen.findByLabelText('People search actor');
    for (const pasted of ['https://apify.com/harvestapi/linkedin-profile-search-by-name', 'apify.com/harvestapi/linkedin-profile-search-by-name', 'a b', '..']) {
      await user.clear(field);
      await user.type(field, pasted);
      await user.click(screen.getByRole('button', { name: 'Save actors' }));
      expect(await screen.findByRole('alert'), pasted).toHaveTextContent('People search actor: enter an actor id such as username~actor-name');
    }
    expect(world.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });

  it('KILLS: an uppercase spelling of the saved default is not a change, so Save stays disabled; a real change still sends the id as typed (slash to tilde)', async () => {
    const user = renderSettings();
    await user.click(await screen.findByRole('button', { name: /Apify/ }));
    const field = await screen.findByLabelText('People search actor');
    await user.clear(field);
    await user.type(field, 'HarvestAPI/LinkedIn-Profile-Search-By-Name');
    expect(screen.getByRole('button', { name: 'Save actors' })).toBeDisabled();
    await user.clear(field);
    await user.type(field, 'Custom/People-Search');
    expect(screen.getByRole('button', { name: 'Save actors' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save actors' }));
    await waitFor(() => expect(world.calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
    expect(world.calls.find((call) => call.method === 'PUT')!.body).toEqual({ leadCapture: { personSearchActor: 'Custom~People-Search' } });
  });

  it('KILLS: clearing the field and saving sends the empty string, which resets only that field', async () => {
    world.connectors = [{ id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, settings: { allowlist: [], leadCapture: { personSearchActor: 'custom~people' } } }];
    const user = renderSettings();
    await user.click(await screen.findByRole('button', { name: /Apify/ }));
    const field = await screen.findByLabelText('People search actor');
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: 'Save actors' }));
    await waitFor(() => expect(world.calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
    expect(world.calls.find((call) => call.method === 'PUT')!.body).toEqual({ leadCapture: { personSearchActor: '' } });
  });

  it('KILLS: the connector normalizer falls back to the default for a missing, blank, numeric, or object personSearchActor', async () => {
    for (const bad of [undefined, '', '   ', 42, { id: 'x' }, null, []]) {
      world.connectors = [{ id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, settings: { allowlist: [], leadCapture: { personSearchActor: bad } } }];
      const apify = (await api.connectors.list()).find((entry) => entry.kind === 'apify')!;
      expect(apify.leadCapture!.personSearchActor, JSON.stringify(bad)).toBe(DEFAULT_LEAD_ACTORS.personSearchActor);
    }
    world.connectors = [{ id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, settings: { allowlist: [] } }];
    expect((await api.connectors.list()).find((entry) => entry.kind === 'apify')!.leadCapture!.personSearchActor).toBe(DEFAULT_LEAD_ACTORS.personSearchActor);
  });

  it('KILLS: only an Apify connector carries lead capture actors, so no other kind shows a people search field', async () => {
    world.connectors = [
      ...world.connectors,
      { id: 'c2', kind: 'agentmail', status: 'connected', statusMessage: null, settings: { leadCapture: { personSearchActor: 'x~y' } } },
    ];
    const list = await api.connectors.list();
    expect(list.find((entry) => entry.kind === 'agentmail')!.leadCapture ?? null).toBeNull();
  });
});
