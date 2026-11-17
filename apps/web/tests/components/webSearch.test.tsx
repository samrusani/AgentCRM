import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersonSheet } from '../../src/screens/RecordSheets';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/ui')>()),
  useUI: () => ({ setSelectedRecord: () => {} }),
}));

// The Search the web button beside Enrich on a person sheet, and the suggestions a web run produces.

interface Call {
  method: string;
  path: string;
  body: any;
}

interface World {
  connectors: Array<Record<string, unknown>> | 'error';
  provider: Record<string, unknown> | null | 'error';
  enrichment: { run: Record<string, unknown> | null; suggestions: Array<Record<string, unknown>> };
  calls: Call[];
  startFailure: { status: number; code: string; message: string } | null;
}

let world: World;

const WEB_LINE =
  'Searches the web for their profiles and links on your Apify account and reads the results with your model provider. Check the match before accepting.';

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

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  window.localStorage.clear();
  world = {
    connectors: [{ id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, allowlist: [] }],
    provider: { kind: 'anthropic', model: 'claude-opus-5-5', status: 'connected', statusMessage: null, ready: true },
    enrichment: { run: null, suggestions: [] },
    calls: [],
    startFailure: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      world.calls.push({ method, path: `${url.pathname}${url.search}`, body });
      if (url.pathname === '/api/people/p1' && method === 'GET') return json(200, person);
      if (url.pathname === '/api/people/p1/enrichment' && method === 'GET') return json(200, world.enrichment);
      if (url.pathname === '/api/people/p1/enrichment' && method === 'POST') {
        const { field } = body as { field: string };
        world.enrichment = { ...world.enrichment, suggestions: world.enrichment.suggestions.filter((entry) => entry.field !== field) };
        return json(200, {});
      }
      if (url.pathname === '/api/people/p1/enrichment' && method === 'DELETE') {
        const only = url.searchParams.get('field');
        world.enrichment = { ...world.enrichment, suggestions: world.enrichment.suggestions.filter((entry) => only !== null && entry.field !== only) };
        return json(200, {});
      }
      if (url.pathname === '/api/runs' && method === 'POST') {
        if (world.startFailure) return json(world.startFailure.status, { error: world.startFailure });
        world.enrichment = { run: { id: 'run-web', status: 'queued', startedAt: null, mode: 'web' }, suggestions: [] };
        return json(201, { id: 'run-web', kind: 'enrich_person', title: 'Enrich', status: 'queued', scope: { personId: 'p1', mode: 'web' }, counts: {}, startedAt: null, finishedAt: null, createdAt: '2026-11-05T10:00:00' });
      }
      if (url.pathname === '/api/connectors') return world.connectors === 'error' ? json(500, { error: { code: 'internal', message: 'Boom.' } }) : json(200, world.connectors);
      if (url.pathname === '/api/model-provider') {
        if (world.provider === 'error') return json(500, { error: { code: 'internal', message: 'Boom.' } });
        return json(200, world.provider);
      }
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

describe('Search the web button', () => {
  it('renders beside Enrich with its muted line, enabled when Apify and a model provider are ready', async () => {
    renderPerson();
    await loaded();
    const button = screen.getByRole('button', { name: 'Search the web' });
    expect(button).toHaveClass('btn--quiet');
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByText(WEB_LINE)).toHaveClass('muted');
    expect(screen.getByRole('button', { name: 'Enrich' })).toBeEnabled();
  });

  it('is disabled with the Settings line when Apify is not connected', async () => {
    world.connectors = [];
    renderPerson();
    await loaded();
    expect(await screen.findByText('Connect Apify in Settings to enrich')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search the web' })).toBeDisabled();
  });

  it('is disabled with a line linking to the model settings when no provider is ready', async () => {
    world.provider = { kind: 'anthropic', model: 'claude-opus-5-5', status: 'error', statusMessage: 'Rejected.', ready: false };
    renderPerson();
    await loaded();
    const link = await screen.findByRole('link', { name: 'model provider' });
    expect(link).toHaveAttribute('href', '/settings/models');
    expect(link.closest('p')).toHaveClass('muted');
    expect(screen.getByRole('button', { name: 'Search the web' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enrich' })).toBeEnabled();
  });

  it('says the check failed when the provider cannot be read, and when the connector cannot be read', async () => {
    world.provider = 'error';
    renderPerson();
    await loaded();
    expect(await screen.findByText('Could not check the model provider.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search the web' })).toBeDisabled();
  });

  it('says the check failed instead of not connected when the Apify check failed', async () => {
    world.connectors = 'error';
    renderPerson();
    await screen.findByRole('heading', { name: 'Fields' });
    expect(await screen.findByText('Could not check the Apify connector. Retry from Settings.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search the web' })).toBeDisabled();
  });

  it('is disabled while any enrichment run is open on the person, including one it did not start', async () => {
    world.enrichment = { run: { id: 'run-1', status: 'running', startedAt: '2026-11-05T10:00:00', mode: 'name' }, suggestions: [] };
    renderPerson();
    await screen.findByRole('heading', { name: 'Fields' });
    expect(await screen.findByRole('button', { name: 'Enriching' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Search the web' })).toBeDisabled();
  });

  it('posts the run with mode web and reads Searching while its run is open, with Enrich disabled too', async () => {
    const { user } = renderPerson();
    await loaded();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search the web' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Search the web' }));
    await waitFor(() => expect(world.calls.filter((call) => call.method === 'POST' && call.path === '/api/runs')).toHaveLength(1));
    expect(world.calls.find((call) => call.method === 'POST' && call.path === '/api/runs')?.body).toEqual({
      kind: 'enrich_person',
      scope: { personId: 'p1', mode: 'web' },
    });
    expect(await screen.findByRole('button', { name: 'Searching' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enrich' })).toBeDisabled();
  });

  it('shows the server message when the start is refused', async () => {
    world.startFailure = { status: 400, code: 'validation', message: 'An enrichment run for this person is already open.' };
    const { user } = renderPerson();
    await loaded();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search the web' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Search the web' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('An enrichment run for this person is already open.');
  });

  it('starts the plain Enrich with no mode', async () => {
    const { user } = renderPerson();
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Enrich' }));
    await waitFor(() => expect(world.calls.find((call) => call.method === 'POST' && call.path === '/api/runs')).toBeDefined());
    expect(world.calls.find((call) => call.method === 'POST' && call.path === '/api/runs')?.body).toEqual({ kind: 'enrich_person', scope: { personId: 'p1' } });
  });
});

describe('web run suggestions', () => {
  const detail = 'Searched the web for "Jane Doe". Check that the results are about the right person before accepting anything. Suggested 2 fields to fill: xUrl, website.';

  it('renders the run detail above the suggestions with the new field labels', async () => {
    world.enrichment = {
      run: { id: 'run-web', status: 'succeeded', startedAt: '2026-11-05T10:00:00', mode: 'web', detail, suggestedCount: 3 },
      suggestions: [
        { field: 'xUrl', value: 'https://x.com/janedoe', sourceUrl: null },
        { field: 'website', value: 'https://jane.example.com/', sourceUrl: 'https://jane.example.com/' },
        { field: 'calendarUrl', value: 'https://cal.example.com/jane', sourceUrl: null },
      ],
    };
    renderPerson();
    const heading = await screen.findByRole('heading', { name: 'Suggestions' });
    const section = heading.closest('section') as HTMLElement;
    const line = within(section).getByText(detail);
    expect(line).toHaveClass('muted');
    const rows = within(section).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('.suggestion-row__field')?.textContent)).toEqual(['X', 'Website', 'Calendar']);
    expect(line.compareDocumentPosition(rows[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Accept calendar' })).toBeInTheDocument();
  });

  it('accepts one field and leaves the rest, and dismisses one with the field', async () => {
    world.enrichment = {
      run: { id: 'run-web', status: 'succeeded', startedAt: '2026-11-05T10:00:00', mode: 'web', detail, suggestedCount: 2 },
      suggestions: [
        { field: 'xUrl', value: 'https://x.com/janedoe', sourceUrl: null },
        { field: 'website', value: 'https://jane.example.com/', sourceUrl: null },
      ],
    };
    const { user } = renderPerson();
    await user.click(await screen.findByRole('button', { name: 'Accept x' }));
    await waitFor(() => expect(world.calls.find((call) => call.method === 'POST' && call.path === '/api/people/p1/enrichment')).toBeDefined());
    expect(world.calls.find((call) => call.method === 'POST' && call.path === '/api/people/p1/enrichment')?.body).toEqual({ runId: 'run-web', field: 'xUrl', expectedVersion: 3 });
    expect(await screen.findByRole('button', { name: 'Accept website' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss website' }));
    await waitFor(() => expect(world.calls.find((call) => call.method === 'DELETE')?.path).toBe('/api/people/p1/enrichment?runId=run-web&field=website'));
  });

  it('shows the server reason on a conflict in web mode', async () => {
    world.enrichment = {
      run: { id: 'run-web', status: 'succeeded', startedAt: '2026-11-05T10:00:00', mode: 'web', detail, suggestedCount: 1 },
      suggestions: [{ field: 'xUrl', value: 'https://x.com/janedoe', sourceUrl: null }],
    };
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/people/p1/enrichment') && init?.method === 'POST') {
        return json(409, { error: { code: 'conflict', message: "This person's name changed after the search, so its suggestions may describe someone else and were not applied." } });
      }
      return original(input, init);
    });
    const { user } = renderPerson();
    await user.click(await screen.findByRole('button', { name: 'Accept x' }));
    expect(await screen.findByText(/name changed after the search/)).toBeInTheDocument();
  });
});
