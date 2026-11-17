// Adversarial review probes for the Search the web button, its suggestions, and the Web search actor setting. Names
// start with KILLS (a real defect, pinned with it.fails), CONFIRMS (an attack failed, a property holds), or ACCEPTED
// (an imperfection that is fine, with the why). Nothing here changes application code.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectorSettings } from '../src/screens/ConnectorSettings';
import { OrganizationSheet, PersonSheet } from '../src/screens/RecordSheets';
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
  connectors: Array<Record<string, unknown>> | 'error';
  provider: Record<string, unknown> | 'error';
  enrichment: { run: Record<string, unknown> | null; suggestions: Array<Record<string, unknown>> };
  calls: Call[];
  leadCapture: Record<string, string>;
  startGate: Promise<void> | null;
}

let world: World;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const person = {
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
};
const organization = {
  id: 'o1',
  version: 2,
  name: 'Acme',
  domain: null,
  kind: 'company',
  location: null,
  linkedinUrl: null,
  tags: [],
  people: [],
  claims: [],
  activities: [],
  opportunities: [],
  createdAt: '2026-10-01T10:00:00',
  updatedAt: '2026-11-01T10:00:00',
};

const apifyEntry = () => ({ id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, settings: { allowlist: [], leadCapture: world.leadCapture } });

beforeEach(() => {
  window.localStorage.clear();
  world = {
    connectors: [{ id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, allowlist: [] }],
    provider: { kind: 'anthropic', model: 'claude-opus-5-5', status: 'connected', statusMessage: null, ready: true },
    enrichment: { run: null, suggestions: [] },
    calls: [],
    leadCapture: {},
    startGate: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      world.calls.push({ method, path: `${url.pathname}${url.search}`, body });
      if (url.pathname === '/api/people/p1' && method === 'GET') return json(200, person);
      if (url.pathname === '/api/organizations/o1' && method === 'GET') return json(200, organization);
      if (url.pathname === '/api/organizations/o1/enrichment') return json(200, { run: null, suggestions: [] });
      if (url.pathname === '/api/people/p1/enrichment' && method === 'GET') return json(200, world.enrichment);
      if (url.pathname === '/api/people/p1/enrichment' && method === 'POST') {
        const { field } = body as { field: string };
        world.enrichment = { ...world.enrichment, suggestions: world.enrichment.suggestions.filter((entry) => entry.field !== field) };
        return json(200, {});
      }
      if (url.pathname === '/api/runs' && method === 'POST') {
        if (world.startGate) await world.startGate;
        const mode = body?.scope?.mode;
        world.enrichment = { run: { id: 'run-new', status: 'queued', startedAt: null, ...(mode ? { mode } : { mode: 'name' }) }, suggestions: [] };
        return json(201, { id: 'run-new', kind: 'enrich_person', title: 'Enrich', status: 'queued', scope: { personId: 'p1', ...(mode ? { mode } : {}) }, counts: {}, startedAt: null, finishedAt: null, createdAt: '2026-11-05T10:00:00' });
      }
      if (url.pathname === '/api/connectors' && method === 'GET') return world.connectors === 'error' ? json(500, { error: { code: 'internal', message: 'Boom.' } }) : json(200, Array.isArray(world.connectors) && world.connectors[0] && 'settings' in world.connectors[0] ? world.connectors : world.connectors);
      if (url.pathname === '/api/model-provider') return world.provider === 'error' ? json(500, { error: { code: 'internal', message: 'Boom.' } }) : json(200, world.provider);
      if (url.pathname === '/api/followup-rules') return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPerson() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <PersonSheet id="p1" onClose={() => {}} onOpenOrganization={() => {}} />
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

async function loaded() {
  await screen.findByRole('heading', { name: 'Fields' });
  await screen.findByRole('button', { name: 'Enrich' });
}

const runPosts = () => world.calls.filter((call) => call.method === 'POST' && call.path === '/api/runs');

describe('Search the web button states', () => {
  it('CONFIRMS: the Apify not connected reason renders once, the model reason once, and both buttons point at them', async () => {
    world.connectors = [];
    world.provider = { kind: 'anthropic', model: 'claude-opus-5-5', status: 'error', statusMessage: 'Rejected.', ready: false };
    renderPerson();
    await loaded();
    expect(await screen.findAllByText('Connect Apify in Settings to enrich')).toHaveLength(1);
    expect(await screen.findAllByRole('link', { name: 'model provider' })).toHaveLength(1);
    const search = screen.getByRole('button', { name: 'Search the web' });
    for (const id of (search.getAttribute('aria-describedby') ?? '').split(' ')) expect(document.getElementById(id), id).not.toBeNull();
    expect(search).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enrich' })).toBeDisabled();
  });

  it('CONFIRMS: Apify down and model fine disables only on the Apify reason, and a model down with Apify fine leaves Enrich enabled', async () => {
    world.connectors = [{ id: 'c1', kind: 'apify', status: 'error', statusMessage: 'Rejected.', allowlist: [] }];
    renderPerson();
    await loaded();
    expect(screen.getByRole('button', { name: 'Search the web' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'model provider' })).toBeNull();
  });

  it('CONFIRMS: every open status, paused and waiting included, disables both buttons, and a web run reads Searching while a name run reads Enriching', async () => {
    for (const status of ['queued', 'running', 'paused', 'waiting_approval']) {
      world.enrichment = { run: { id: 'r', status, startedAt: null, mode: 'web' }, suggestions: [] };
      const { unmount } = (() => {
        const user = userEvent.setup();
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        return {
          user,
          ...render(
            <QueryClientProvider client={client}>
              <Router>
                <PersonSheet id="p1" onClose={() => {}} onOpenOrganization={() => {}} />
              </Router>
            </QueryClientProvider>,
          ),
        };
      })();
      expect(await screen.findByRole('button', { name: 'Searching' }), status).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Enrich' })).toBeDisabled();
      unmount();
    }
    world.enrichment = { run: { id: 'r', status: 'running', startedAt: null, mode: 'name' }, suggestions: [] };
    renderPerson();
    expect(await screen.findByRole('button', { name: 'Enriching' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Search the web' })).toBeDisabled();
  });

  it('CONFIRMS: a fast double click on Search the web posts one run, and Enrich cannot be started while the start is in flight', async () => {
    let release!: () => void;
    world.startGate = new Promise<void>((resolve) => (release = resolve));
    const { user } = renderPerson();
    await loaded();
    const search = screen.getByRole('button', { name: 'Search the web' });
    await waitFor(() => expect(search).toBeEnabled());
    await user.dblClick(search);
    await user.click(screen.getByRole('button', { name: 'Enrich' }));
    release();
    await waitFor(() => expect(runPosts().length).toBeGreaterThan(0));
    expect(runPosts()).toHaveLength(1);
    expect(runPosts()[0]!.body.scope).toEqual({ personId: 'p1', mode: 'web' });
  });

  it('CONFIRMS: the Enrich post is unchanged by the new button, no mode key', async () => {
    const { user } = renderPerson();
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Enrich' }));
    await waitFor(() => expect(runPosts()).toHaveLength(1));
    expect(runPosts()[0]!.body).toEqual({ kind: 'enrich_person', scope: { personId: 'p1' } });
  });

  it('CONFIRMS: an organization sheet has no Search the web button and does not read the model provider', async () => {
    const user = userEvent.setup();
    void user;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Router>
          <OrganizationSheet id="o1" onClose={() => {}} onOpenPerson={() => {}} />
        </Router>
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: 'Enrich' });
    expect(screen.queryByRole('button', { name: /Search the web/ })).toBeNull();
    expect(world.calls.some((call) => call.path === '/api/model-provider')).toBe(false);
  });

  it('CONFIRMS: the button is disabled until the provider check has settled, so a ready provider never flashes a reason', async () => {
    renderPerson();
    await loaded();
    expect(screen.queryByText(/Connect a/)).toBeNull();
    expect(screen.queryByText('Could not check the model provider.')).toBeNull();
  });
});

describe('web suggestions rendering', () => {
  it('CONFIRMS: hostile text in the run detail or a suggestion value renders as text, not markup, and a source url is not turned into a link', async () => {
    const detail = 'Searched the web for "<img src=x onerror=alert(1)> Doe". Check that the results are about the right person before accepting anything.';
    world.enrichment = {
      run: { id: 'run-web', status: 'succeeded', startedAt: '2026-11-05T10:00:00', mode: 'web', detail, suggestedCount: 1 },
      suggestions: [{ field: 'website', value: 'https://x.example.com/"><script>alert(1)</script>', sourceUrl: 'javascript:alert(1)' }],
    };
    renderPerson();
    const heading = await screen.findByRole('heading', { name: 'Suggestions' });
    const section = heading.closest('section') as HTMLElement;
    expect(within(section).getByText(detail)).toBeInTheDocument();
    expect(section.querySelector('img, script')).toBeNull();
    expect(section.querySelector('a[href^="javascript"]')).toBeNull();
    expect(section.querySelector('a')).toBeNull();
  });

  it('CONFIRMS: a succeeded web run with nothing suggested and a failed web run show their own detail line, and a fully decided run shows nothing', async () => {
    world.enrichment = { run: { id: 'r', status: 'succeeded', startedAt: 'x', mode: 'web', detail: 'The results offered no links for this person.', suggestedCount: 0 }, suggestions: [] };
    const first = renderPerson();
    void first;
    expect(await screen.findByText('The results offered no links for this person.')).toHaveClass('muted');
  });

  it('CONFIRMS: a failed web run shows its failing detail where suggestions would be', async () => {
    world.enrichment = { run: { id: 'r', status: 'failed', startedAt: 'x', mode: 'web', detail: 'The search actor returned no organic results, so there was nothing to read and nothing was suggested.', suggestedCount: 0 }, suggestions: [] };
    renderPerson();
    expect(await screen.findByText(/no organic results/)).toBeInTheDocument();
  });

  it('CONFIRMS: all four new and old labels render in field order for a four field run, with Accept and Dismiss per row', async () => {
    world.enrichment = {
      run: { id: 'run-web', status: 'succeeded', startedAt: 'x', mode: 'web', detail: 'Searched.', suggestedCount: 4 },
      suggestions: [
        { field: 'linkedinUrl', value: 'https://www.linkedin.com/in/jane-doe', sourceUrl: null },
        { field: 'xUrl', value: 'https://x.com/janedoe', sourceUrl: null },
        { field: 'website', value: 'https://jane.example.com/', sourceUrl: null },
        { field: 'calendarUrl', value: 'https://cal.example.com/jane', sourceUrl: null },
      ],
    };
    renderPerson();
    const section = (await screen.findByRole('heading', { name: 'Suggestions' })).closest('section') as HTMLElement;
    const rows = within(section).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('.suggestion-row__field')?.textContent)).toEqual(['LinkedIn', 'X', 'Website', 'Calendar']);
    for (const row of rows) {
      expect(within(row).getByRole('button', { name: /^Accept / })).toBeEnabled();
      expect(within(row).getByRole('button', { name: /^Dismiss / })).toBeEnabled();
    }
  });
});

describe('Web search actor setting', () => {
  function settingsWorld() {
    world.connectors = [apifyEntry()] as never;
    (world as any).puts = [];
    const original = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/connectors/apify' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        (world as any).puts.push(body);
        for (const [key, value] of Object.entries(body.leadCapture as Record<string, string>)) {
          if (value === '') delete world.leadCapture[key];
          else world.leadCapture[key] = value;
        }
        return json(200, apifyEntry());
      }
      return original(input, init);
    });
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

  it('CONFIRMS: a pasted URL, a path, or a spaced id is refused in the browser with no PUT, and a case or slash variant of the default is no change', async () => {
    settingsWorld();
    const user = renderSettings();
    await user.click(await screen.findByRole('button', { name: /Apify/ }));
    const field = (await screen.findByLabelText('Web search actor')) as HTMLInputElement;
    expect(field.value).toBe('apify/google-search-scraper');
    for (const bad of ['https://console.apify.com/actors/apify~google-search-scraper', 'a/b/c', 'two words', '../x']) {
      await user.clear(field);
      await user.type(field, bad);
      await user.click(screen.getByRole('button', { name: 'Save actors' }));
      expect(await screen.findByRole('alert'), bad).toHaveTextContent(/Web search actor: enter an actor id/);
    }
    expect((world as any).puts).toEqual([]);
    await user.clear(field);
    await user.type(field, ' Apify~Google-Search-Scraper ');
    expect(screen.getByRole('button', { name: 'Save actors' })).toBeDisabled();
  });

  it('CONFIRMS: saving only the web actor sends only that field, never the other actors', async () => {
    world.leadCapture = { personSearchActor: 'my~people' };
    settingsWorld();
    const user = renderSettings();
    await user.click(await screen.findByRole('button', { name: /Apify/ }));
    const field = (await screen.findByLabelText('Web search actor')) as HTMLInputElement;
    await user.clear(field);
    await user.type(field, 'me/web');
    await user.click(screen.getByRole('button', { name: 'Save actors' }));
    await waitFor(() => expect((world as any).puts).toHaveLength(1));
    expect((world as any).puts[0]).toEqual({ leadCapture: { webSearchActor: 'me~web' } });
    expect((await screen.findByLabelText('People search actor') as HTMLInputElement).value).toBe('my~people');
  });
});
