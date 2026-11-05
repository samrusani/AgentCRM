// Adversarial review probes for organization enrichment in the web app. Names start with CONFIRMS (the bug is real,
// the test passes because it is) or KILLS (a safety property holds). Nothing here changes application code.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../src/api/client';
import { ConnectorSettings } from '../src/screens/ConnectorSettings';
import { OrganizationSheet } from '../src/screens/RecordSheets';
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
  organization: Record<string, any>;
  enrichment: { run: Record<string, unknown> | null; suggestions: Array<Record<string, unknown>> };
  connectors: Array<Record<string, unknown>>;
  calls: Call[];
  // While set, organization reads wait for it, like a slow refetch.
  gateOrganization: Promise<void> | null;
}

let world: World;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const suggestionsOf = (...fields: [string, string][]) => fields.map(([field, value]) => ({ field, value, status: 'pending' }));

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
    enrichment: {
      run: { id: 'run-1', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: 'Suggested 2 fields to fill: domain, location.', suggestedCount: 2 },
      suggestions: suggestionsOf(['domain', 'acme.example.com'], ['location', 'Port Alder']),
    },
    connectors: [{ id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, allowlist: [] }],
    calls: [],
    gateOrganization: null,
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
      if (url.pathname === '/api/organizations/o1' && method === 'GET') {
        const snapshot = world.organization;
        if (world.gateOrganization) await world.gateOrganization;
        return json(200, world.gateOrganization ? snapshot : world.organization);
      }
      if (url.pathname === '/api/organizations/o1/enrichment' && method === 'GET') return json(200, world.enrichment);
      if (url.pathname === '/api/organizations/o1/enrichment' && method === 'POST') {
        const { field, expectedVersion } = body as { field: string; expectedVersion: number };
        if (expectedVersion !== world.organization.version) return json(409, { error: { code: 'version_conflict', message: 'This record changed.' } });
        const hit = world.enrichment.suggestions.find((entry) => entry.field === field);
        world.enrichment = { ...world.enrichment, suggestions: world.enrichment.suggestions.filter((entry) => entry.field !== field) };
        world.organization = { ...world.organization, [field]: hit?.value, version: world.organization.version + 1 };
        return json(200, {});
      }
      if (url.pathname === '/api/connectors') return json(200, world.connectors);
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

const posts = (pathStart: string) => world.calls.filter((call) => call.method === 'POST' && call.path.startsWith(pathStart));

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

describe('company lookup actor setting', () => {
  it('KILLS: the connector normalizer keeps companyActor, so the saved company lookup actor reaches the Settings card', async () => {
    world.connectors = [
      {
        id: 'c1',
        kind: 'apify',
        status: 'connected',
        statusMessage: null,
        settings: {
          allowlist: [],
          leadCapture: {
            postActor: 'apimaestro/linkedin-post-detail',
            reactionsActor: 'harvestapi/linkedin-post-reactions',
            commentsActor: 'harvestapi/linkedin-post-comments',
            profileActor: 'harvestapi/linkedin-profile-scraper',
            companyActor: 'custom~company-lookup',
          },
        },
      },
    ];
    const connectors = await api.connectors.list();
    const apify = connectors.find((entry) => entry.kind === 'apify')!;
    expect(apify.leadCapture!.companyActor).toBe('custom~company-lookup');
  });

  it('KILLS: opening the Apify card on a connected account renders the Company lookup field instead of crashing', async () => {
    const user = userEvent.setup();
    world.connectors = [
      { id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, settings: { allowlist: [], leadCapture: { companyActor: 'custom~company-lookup' } } },
    ];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Router>
          <ConnectorSettings />
        </Router>
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole('button', { name: /Apify/ }));
    const field = await screen.findByLabelText('Company lookup');
    expect((field as HTMLInputElement).value).toBe('custom~company-lookup');
  });
});

describe('detail line and suggestion rendering', () => {
  it('KILLS: a hostile scraped company name in the run detail renders as literal text, never as elements or a link', async () => {
    const hostile = '<img src=x onerror=alert(1)><a href="javascript:alert(1)">Acme</a> ‮evil';
    world.enrichment = {
      run: { id: 'run-1', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: hostile, suggestedCount: 1 },
      suggestions: suggestionsOf(['domain', '<b>acme.example.com</b>']),
    };
    renderOrganization();
    const line = (await screen.findByText(hostile)).closest('p') as HTMLElement;
    expect(line.querySelector('img')).toBeNull();
    expect(line.querySelector('a')).toBeNull();
    const row = screen.getByText('<b>acme.example.com</b>').closest('li') as HTMLElement;
    expect(row.querySelector('b')).toBeNull();
  });

  it('KILLS: the detail line sits above the suggestion list for an organization run with pending suggestions', async () => {
    renderOrganization();
    const detail = await screen.findByText('Suggested 2 fields to fill: domain, location.');
    const list = document.querySelector('.suggestion-list') as HTMLElement;
    expect(detail.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('KILLS: a run that is still open shows no detail line and no suggestions, even if the server sent a stale detail', async () => {
    world.enrichment = {
      run: { id: 'run-2', status: 'running', startedAt: '2026-11-05T09:00:00', detail: 'stale detail from before', suggestedCount: 0 },
      suggestions: suggestionsOf(['domain', 'acme.example.com']),
    };
    renderOrganization();
    await screen.findByRole('heading', { name: 'Fields' });
    await screen.findByText('acme.example.com');
    expect(screen.queryByText('stale detail from before')).toBeNull();
  });
});

describe('accept on the organization sheet', () => {
  it('KILLS: while the organization refetch is slow, every Accept and Dismiss stays disabled, and the next Accept sends the new version', async () => {
    const { user } = renderOrganization();
    const first = await screen.findByRole('button', { name: 'Accept domain' });
    const slow = gate();
    world.gateOrganization = slow.promise;
    await user.click(first);
    await waitFor(() => expect(posts('/api/organizations/o1/enrichment')).toHaveLength(1));
    expect(posts('/api/organizations/o1/enrichment')[0]!.body.expectedVersion).toBe(2);
    await waitFor(() => expect(world.calls.filter((call) => call.method === 'GET' && call.path === '/api/organizations/o1').length).toBeGreaterThan(1));
    expect(world.organization.version).toBe(3);
    expect(screen.getByRole('button', { name: 'Accept location' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    slow.open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept location' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Accept location' }));
    await waitFor(() => expect(posts('/api/organizations/o1/enrichment')).toHaveLength(2));
    expect(posts('/api/organizations/o1/enrichment')[1]!.body.expectedVersion).toBe(3);
  });

  it('KILLS: the organization sheet never posts to a person route and never sends a field outside the list the row names', async () => {
    const { user } = renderOrganization();
    await user.click(await screen.findByRole('button', { name: 'Accept location' }));
    await waitFor(() => expect(posts('/api/organizations/o1/enrichment')).toHaveLength(1));
    expect(world.calls.filter((call) => call.path.startsWith('/api/people'))).toEqual([]);
    expect(posts('/api/organizations/o1/enrichment')[0]!.body).toEqual({ runId: 'run-1', field: 'location', expectedVersion: 2 });
  });
});
