// Adversarial review probes for the enrich suggestions and profile link UI. Names start with CONFIRMS (the bug is real,
// the test passes because it is) or KILLS (a safety property holds). Nothing here changes application code.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { profileHref } from '../src/lib/links';
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
  calls: Call[];
  // While set, person reads and enrichment reads wait for it, like a slow refetch.
  gatePerson: Promise<void> | null;
  gateEnrichment: Promise<void> | null;
}

let world: World;

const suggestionsOf = (...fields: [string, string][]) => fields.map(([field, value]) => ({ field, value, status: 'pending' }));

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
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
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
      run: { id: 'run-1', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: 'Suggested 2 fields to fill: title, location.', suggestedCount: 2 },
      suggestions: suggestionsOf(['title', 'Partner'], ['location', 'Port Alder']),
    },
    calls: [],
    gatePerson: null,
    gateEnrichment: null,
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      world.calls.push({ method, path: `${url.pathname}${url.search}`, body });

      if (url.pathname === '/api/people/p1' && method === 'GET') {
        const snapshot = world.person;
        if (world.gatePerson) await world.gatePerson;
        return json(200, world.gatePerson ? snapshot : world.person);
      }
      if (url.pathname === '/api/people/p1/enrichment' && method === 'GET') {
        const snapshot = world.enrichment;
        if (world.gateEnrichment) await world.gateEnrichment;
        return json(200, world.gateEnrichment ? snapshot : world.enrichment);
      }
      if (url.pathname === '/api/people/p1/enrichment' && method === 'POST') {
        const { field, expectedVersion } = body as { field: string; expectedVersion: number };
        if (expectedVersion !== world.person.version) return json(409, { error: { code: 'version_conflict', message: 'This record changed.' } });
        const hit = world.enrichment.suggestions.find((entry) => entry.field === field);
        world.enrichment = { ...world.enrichment, suggestions: world.enrichment.suggestions.filter((entry) => entry.field !== field) };
        world.person = { ...world.person, [field]: hit?.value, version: world.person.version + 1 };
        return json(200, {});
      }
      if (url.pathname === '/api/runs' && method === 'POST') {
        // The server refuses a second open run for the same person.
        if (world.enrichment.run && ['queued', 'running'].includes(String(world.enrichment.run.status)) && world.enrichment.run.id === 'run-new') {
          return json(400, { error: { code: 'validation', message: 'An enrichment run for this person is already open.' } });
        }
        world.enrichment = { run: { id: 'run-new', status: 'queued', startedAt: null }, suggestions: [] };
        return json(201, { id: 'run-new', kind: 'enrich_person', title: 'Enrich', status: 'queued', scope: { personId: 'p1' }, counts: {}, startedAt: null, finishedAt: null, createdAt: '2026-11-05T10:00:00' });
      }
      if (url.pathname === '/api/connectors') return json(200, [{ id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, allowlist: [] }]);
      if (url.pathname === '/api/followup-rules') return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

const posts = (pathStart: string) => world.calls.filter((call) => call.method === 'POST' && call.path.startsWith(pathStart));

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

describe('suggestion rendering', () => {
  it('KILLS: a scraped value with markup renders as literal text, never as elements or a link', async () => {
    const hostile = '<img src=x onerror=alert(1)><b>bold</b> javascript:alert(1)';
    world.enrichment = {
      run: { id: 'run-1', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: null, suggestedCount: 1 },
      suggestions: suggestionsOf(['title', hostile]),
    };
    renderPerson();
    const row = (await screen.findByText(hostile)).closest('li') as HTMLElement;
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('b')).toBeNull();
    expect(row.querySelector('a')).toBeNull();
    expect(within(row).getByText(hostile)).toBeInTheDocument();
  });

  it('KILLS: profile links only ever get an http or https href, whatever the stored text says', async () => {
    for (const value of ['javascript:alert(1)', 'JaVaScRiPt://linkedin.com/in/x', 'data:text/html,<b>x</b>', 'vbscript://x', '  javascript://x', 'file:///etc/passwd']) {
      expect(profileHref(value), value).toBeNull();
    }
    world.person = { ...world.person, linkedinUrl: 'javascript://linkedin.com/in/x%0Aalert(1)', xUrl: 'data:text/html,hi' };
    renderPerson();
    await screen.findByRole('heading', { name: 'Fields' });
    const links = Array.from(document.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href') ?? '');
    for (const href of links) expect(href).not.toMatch(/^(javascript|data|vbscript|file):/i);
    expect(links.some((href) => href.includes('alert'))).toBe(false);
  });
});

describe('accept version', () => {
  it('KILLS: after the person refetch lands, the next Accept sends the current version', async () => {
    const { user } = renderPerson();
    await user.click(await screen.findByRole('button', { name: 'Accept title' }));
    await waitFor(() => expect(posts('/api/people/p1/enrichment')).toHaveLength(1));
    expect(posts('/api/people/p1/enrichment')[0]!.body.expectedVersion).toBe(3);
    // Wait until the refetched person (version 4) shows the accepted title in Fields, then accept the other row.
    await waitFor(() => expect(document.querySelector('.fields')?.textContent ?? '').toContain('Partner'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept location' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Accept location' }));
    await waitFor(() => expect(posts('/api/people/p1/enrichment')).toHaveLength(2));
    expect(posts('/api/people/p1/enrichment')[1]!.body.expectedVersion).toBe(4);
  });

  it('KILLS: while the person refetch is slow, every Accept and Dismiss stays disabled, so no stale version can be sent', async () => {
    const { user } = renderPerson();
    const first = await screen.findByRole('button', { name: 'Accept title' });
    const slow = gate();
    world.gatePerson = slow.promise;
    await user.click(first);
    await waitFor(() => expect(posts('/api/people/p1/enrichment')).toHaveLength(1));
    // The POST has settled and the server is at version 4, but the person read is still in flight.
    await waitFor(() => expect(world.calls.filter((call) => call.method === 'GET' && call.path === '/api/people/p1').length).toBeGreaterThan(1));
    expect(world.person.version).toBe(4);
    expect(screen.getByRole('button', { name: 'Accept location' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Accept location' }));
    expect(posts('/api/people/p1/enrichment')).toHaveLength(1);
    // Once the refetches land the control unlocks and the next Accept carries the current version.
    slow.open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept location' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Accept location' }));
    await waitFor(() => expect(posts('/api/people/p1/enrichment')).toHaveLength(2));
    expect(posts('/api/people/p1/enrichment')[1]!.body.expectedVersion).toBe(4);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('KILLS: while the enrichment refetch is slow after an accept, every Accept and Dismiss stays disabled', async () => {
    const { user } = renderPerson();
    const first = await screen.findByRole('button', { name: 'Accept title' });
    const slow = gate();
    world.gateEnrichment = slow.promise;
    await user.click(first);
    await waitFor(() => expect(posts('/api/people/p1/enrichment')).toHaveLength(1));
    await waitFor(() => expect(document.querySelector('.fields')?.textContent ?? '').toContain('Partner'));
    expect(screen.getByRole('button', { name: 'Accept location' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    slow.open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept location' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
  });
});

describe('enrich button', () => {
  it('KILLS: after the start settles and until the enrichment read lands, the button stays in its disabled Enriching state', async () => {
    world.enrichment = { run: { id: 'run-old', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: null, suggestedCount: 0 }, suggestions: [] };
    const { user } = renderPerson();
    const button = await screen.findByRole('button', { name: 'Enrich' });
    await waitFor(() => expect(button).toBeEnabled());
    const slow = gate();
    world.gateEnrichment = slow.promise;
    await user.click(button);
    await waitFor(() => expect(posts('/api/runs')).toHaveLength(1));
    // The server has accepted the run and the enrichment read is in flight, still gated.
    await waitFor(() => expect(world.calls.filter((call) => call.path === '/api/people/p1/enrichment' && call.method === 'GET').length).toBeGreaterThan(1));
    const enriching = screen.getByRole('button', { name: 'Enriching' });
    expect(enriching).toBeDisabled();
    await user.click(enriching);
    expect(posts('/api/runs')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
    // When the read lands it shows the open run, which keeps the button disabled.
    slow.open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enriching' })).toBeDisabled());
    expect(posts('/api/runs')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
