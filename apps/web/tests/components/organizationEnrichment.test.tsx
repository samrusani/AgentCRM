import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrganizationSheet } from '../../src/screens/RecordSheets';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/ui')>()),
  useUI: () => ({ setSelectedRecord: () => {} }),
}));

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface World {
  organization: Record<string, unknown>;
  connectors: Array<Record<string, unknown>>;
  enrichment: { run: Record<string, unknown> | null; suggestions: Array<Record<string, unknown>> };
  calls: Call[];
  acceptFailure: { status: number; code: string; message: string } | null;
}

let world: World;

const COST_LINE = 'Runs one company lookup on your Apify account.';

function freshWorld(): World {
  return {
    organization: {
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
    },
    connectors: [{ id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, allowlist: [] }],
    enrichment: { run: null, suggestions: [] },
    calls: [],
    acceptFailure: null,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      world.calls.push({ method, path: `${url.pathname}${url.search}`, body });

      if (url.pathname === '/api/organizations/o1' && method === 'GET') return json(200, world.organization);
      if (url.pathname === '/api/organizations/o1/enrichment' && method === 'GET') return json(200, world.enrichment);
      if (url.pathname === '/api/organizations/o1/enrichment' && method === 'POST') {
        if (world.acceptFailure) return json(world.acceptFailure.status, { error: world.acceptFailure });
        const { field } = body as { field: string };
        const accepted = world.enrichment.suggestions.find((entry) => entry.field === field);
        world.enrichment = { ...world.enrichment, suggestions: world.enrichment.suggestions.filter((entry) => entry.field !== field) };
        world.organization = { ...world.organization, [field]: accepted?.value, version: (world.organization.version as number) + 1 };
        return json(200, {});
      }
      if (url.pathname === '/api/organizations/o1/enrichment' && method === 'DELETE') {
        world.enrichment = { ...world.enrichment, suggestions: [] };
        return json(200, {});
      }
      if (url.pathname === '/api/runs' && method === 'POST') {
        const run = { id: 'run-new', kind: 'enrich_organization', title: 'Enrich', status: 'queued', scope: { organizationId: 'o1' }, counts: {}, startedAt: null, finishedAt: null, createdAt: '2026-11-05T10:00:00' };
        world.enrichment = { run: { id: 'run-new', status: 'queued', startedAt: null }, suggestions: [] };
        return json(201, run);
      }
      if (url.pathname === '/api/connectors') return json(200, world.connectors);
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

function calls(method: string, pathStart: string): Call[] {
  return world.calls.filter((call) => call.method === method && call.path.startsWith(pathStart));
}

function renderOrganization() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <OrganizationSheet id="o1" onClose={() => {}} onOpenPerson={() => {}} />
      </Router>
    </QueryClientProvider>,
  );
  return { user, client };
}

function fieldRow(label: string): HTMLElement {
  return screen.getByText(label, { selector: 'dt' }).closest('.field') as HTMLElement;
}

async function loaded() {
  await screen.findByRole('heading', { name: 'Fields' });
}

beforeEach(() => {
  window.localStorage.clear();
  world = freshWorld();
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('organization Enrich button', () => {
  it('sits beside the Fields title with the company cost line and is enabled without a LinkedIn page', async () => {
    renderOrganization();
    await loaded();
    const head = screen.getByRole('heading', { name: 'Fields' }).parentElement as HTMLElement;
    await waitFor(() => expect(within(head).getByRole('button', { name: 'Enrich' })).toBeEnabled());
    expect(within(head).getByText(COST_LINE)).toBeInTheDocument();
    expect(screen.queryByText('Connect Apify in Settings to enrich')).not.toBeInTheDocument();
    expect(screen.queryByText('Add a LinkedIn profile first')).not.toBeInTheDocument();
  });

  it('is disabled with a reason when Apify is not connected', async () => {
    world.connectors = [];
    renderOrganization();
    await loaded();
    const button = screen.getByRole('button', { name: 'Enrich' });
    await waitFor(() => expect(screen.getByText('Connect Apify in Settings to enrich')).toBeInTheDocument());
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Connect Apify in Settings to enrich');
    expect(screen.getByText(COST_LINE)).toBeInTheDocument();
  });

  it('is disabled with the same reason when the Apify token was rejected', async () => {
    world.connectors = [{ id: 'c1', kind: 'apify', status: 'error', statusMessage: 'Token rejected', allowlist: [] }];
    renderOrganization();
    await loaded();
    await waitFor(() => expect(screen.getByText('Connect Apify in Settings to enrich')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Enrich' })).toBeDisabled();
  });

  it('starts an enrich_organization run for this organization and then reads Enriching', async () => {
    const { user } = renderOrganization();
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'Enrich' }));
    await waitFor(() => expect(calls('POST', '/api/runs')).toHaveLength(1));
    expect(calls('POST', '/api/runs')[0]?.body).toEqual({ kind: 'enrich_organization', scope: { organizationId: 'o1' } });
    expect(calls('GET', '/api/organizations/o1/enrichment').length).toBeGreaterThan(1);
    expect(await screen.findByRole('button', { name: 'Enriching' })).toBeDisabled();
  });

  it.each(['queued', 'running', 'waiting_approval'])('reads Enriching and is disabled while the newest run is %s', async (status) => {
    world.enrichment = { run: { id: 'run-1', status, startedAt: '2026-11-05T09:00:00' }, suggestions: [] };
    renderOrganization();
    await loaded();
    expect(await screen.findByRole('button', { name: 'Enriching' })).toBeDisabled();
  });

  it('shows the server message when the run cannot start', async () => {
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/runs' && init?.method === 'POST') {
          return json(400, { error: { code: 'validation_error', message: 'An enrich run is already open for this organization.' } });
        }
        return original(input, init);
      }),
    );
    const { user } = renderOrganization();
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'Enrich' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('An enrich run is already open for this organization.');
  });
});

describe('organization suggestions', () => {
  const NAME_MODE_DETAIL = 'Looked up by name and found Acme Robotics (acmerobotics.example.com). Check it is the right company before accepting.';

  function withSuggestions(detail: string | null = '3 fields suggested.') {
    world.enrichment = {
      run: { id: 'run-1', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail, suggestedCount: 3 },
      suggestions: [
        { field: 'linkedinUrl', value: 'https://www.linkedin.com/company/acme', status: 'pending' },
        { field: 'domain', value: 'acme.example.com', status: 'pending' },
        { field: 'location', value: 'Austin, United States', status: 'pending' },
      ],
    };
  }

  it('lists LinkedIn, Domain, and Location suggestions between Fields and the people list', async () => {
    withSuggestions();
    renderOrganization();
    const heading = await screen.findByRole('heading', { name: 'Suggestions' });
    const section = heading.closest('section') as HTMLElement;
    expect(within(section).getByText('LinkedIn')).toBeInTheDocument();
    expect(within(section).getByText('https://www.linkedin.com/company/acme')).toBeInTheDocument();
    expect(within(section).getByText('Domain')).toBeInTheDocument();
    expect(within(section).getByText('acme.example.com')).toBeInTheDocument();
    expect(within(section).getByText('Location')).toBeInTheDocument();
    expect(within(section).getByText('Austin, United States')).toBeInTheDocument();
    expect(within(section).getAllByRole('button', { name: /^Accept / })).toHaveLength(3);
    expect(within(section).getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);

    const titles = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent);
    expect(titles.indexOf('Suggestions')).toBe(titles.indexOf('Fields') + 1);
    expect(titles.indexOf('People')).toBeGreaterThan(titles.indexOf('Suggestions'));
  });

  it('shows the run detail above the list when a name lookup matched, so a wrong match is visible', async () => {
    withSuggestions(NAME_MODE_DETAIL);
    renderOrganization();
    const heading = await screen.findByRole('heading', { name: 'Suggestions' });
    const section = heading.closest('section') as HTMLElement;
    const detail = within(section).getByText(NAME_MODE_DETAIL);
    expect(detail).toHaveClass('muted');
    const list = section.querySelector('ul.suggestion-list') as HTMLElement;
    expect(detail.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no detail line above the list when the run has none', async () => {
    withSuggestions(null);
    renderOrganization();
    const heading = await screen.findByRole('heading', { name: 'Suggestions' });
    const section = heading.closest('section') as HTMLElement;
    expect(section.querySelector('p.muted')).toBeNull();
  });

  it('accepts a suggestion with the organization version, then refetches the organization and the suggestions', async () => {
    withSuggestions(NAME_MODE_DETAIL);
    const { user } = renderOrganization();
    await screen.findByRole('heading', { name: 'Suggestions' });
    const orgFetches = calls('GET', '/api/organizations/o1').filter((call) => call.path === '/api/organizations/o1').length;
    const enrichmentFetches = calls('GET', '/api/organizations/o1/enrichment').length;

    await user.click(screen.getByRole('button', { name: 'Accept domain' }));

    await waitFor(() => expect(calls('POST', '/api/organizations/o1/enrichment')).toHaveLength(1));
    expect(calls('POST', '/api/organizations/o1/enrichment')[0]?.body).toEqual({ runId: 'run-1', field: 'domain', expectedVersion: 2 });
    await waitFor(() => expect(within(fieldRow('Domain')).getByText('acme.example.com')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept domain' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Accept location' })).toBeInTheDocument();
    expect(calls('GET', '/api/organizations/o1').filter((call) => call.path === '/api/organizations/o1').length).toBeGreaterThan(orgFetches);
    expect(calls('GET', '/api/organizations/o1/enrichment').length).toBeGreaterThan(enrichmentFetches);
    // The detail line stays while suggestions remain pending.
    expect(screen.getByText(NAME_MODE_DETAIL)).toBeInTheDocument();
  });

  it('sends the refreshed version for the second accept', async () => {
    withSuggestions();
    const { user } = renderOrganization();
    await screen.findByRole('heading', { name: 'Suggestions' });
    await user.click(screen.getByRole('button', { name: 'Accept domain' }));
    await waitFor(() => expect(within(fieldRow('Domain')).getByText('acme.example.com')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accept location' }));
    await waitFor(() => expect(calls('POST', '/api/organizations/o1/enrichment')).toHaveLength(2));
    expect(calls('POST', '/api/organizations/o1/enrichment')[1]?.body).toEqual({ runId: 'run-1', field: 'location', expectedVersion: 3 });
  });

  it('shows the conflict message and keeps the suggestion when the target changed', async () => {
    withSuggestions();
    world.acceptFailure = { status: 409, code: 'conflict', message: 'The organization changed.' };
    const { user } = renderOrganization();
    await user.click(await screen.findByRole('button', { name: 'Accept location' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Location changed since you opened this record, so the suggestion was not applied.');
    expect(screen.getByRole('button', { name: 'Accept location' })).toBeInTheDocument();
  });

  it('dismisses the rest of the run, including the detail line above the list', async () => {
    withSuggestions(NAME_MODE_DETAIL);
    const { user } = renderOrganization();
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(calls('DELETE', '/api/organizations/o1/enrichment')).toHaveLength(1));
    expect(calls('DELETE', '/api/organizations/o1/enrichment')[0]?.path).toBe('/api/organizations/o1/enrichment?runId=run-1');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Suggestions' })).not.toBeInTheDocument());
    expect(screen.queryByText(NAME_MODE_DETAIL)).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing new to suggest.')).not.toBeInTheDocument();
  });
});

describe('organization runs without pending suggestions', () => {
  it('shows the run detail once as a muted line when the lookup found nothing new', async () => {
    world.enrichment = {
      run: { id: 'run-2', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: 'Every field was already filled.', suggestedCount: 0 },
      suggestions: [],
    };
    renderOrganization();
    expect(await screen.findByText('Every field was already filled.')).toHaveClass('muted');
    expect(screen.getAllByText('Every field was already filled.')).toHaveLength(1);
  });

  it('shows the failing detail for a failed run and keeps Enrich available', async () => {
    world.enrichment = {
      run: { id: 'run-3', status: 'failed', startedAt: '2026-11-05T09:00:00', detail: 'The lookup returned a different company.', suggestedCount: 0 },
      suggestions: [],
    };
    renderOrganization();
    expect(await screen.findByText('The lookup returned a different company.')).toHaveClass('muted');
    expect(await screen.findByRole('button', { name: 'Enrich' })).toBeEnabled();
  });

  it('shows nothing when the suggestions were all accepted or dismissed', async () => {
    world.enrichment = {
      run: { id: 'run-2', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: 'Looked up by name and found Acme Robotics.', suggestedCount: 2 },
      suggestions: [],
    };
    renderOrganization();
    await loaded();
    await screen.findByRole('button', { name: 'Enrich' });
    expect(screen.queryByRole('heading', { name: 'Suggestions' })).not.toBeInTheDocument();
    expect(screen.queryByText('Looked up by name and found Acme Robotics.')).not.toBeInTheDocument();
  });
});
