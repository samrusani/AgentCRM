import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrganizationSheet, PersonSheet } from '../../src/screens/RecordSheets';
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
  person: Record<string, unknown>;
  organization: Record<string, unknown>;
  connectors: Array<Record<string, unknown>>;
  enrichment: { run: Record<string, unknown> | null; suggestions: Array<Record<string, unknown>> };
  calls: Call[];
  // When set, the next accept answers with this status and error envelope.
  acceptFailure: { status: number; code: string; message: string } | null;
  patchFailure: { status: number; code: string; message: string } | null;
}

let world: World;

const LINKEDIN_CLAIM = {
  id: 'claim-1',
  entityType: 'person',
  entityId: 'p1',
  field: 'linkedin_url',
  value: 'https://www.linkedin.com/in/jane-doe',
  sourceUrl: 'https://www.linkedin.com/in/jane-doe',
  sourceType: 'extension',
  observedAt: '2026-11-01T10:00:00',
  status: 'imported',
};

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
      xUrl: 'https://x.com/janedoe',
      tags: [],
      nextActionAt: null,
      qualification: null,
      organization: null,
      affiliationsSummary: null,
      claims: [LINKEDIN_CLAIM],
      activities: [],
      tasks: [],
      opportunities: [],
      createdAt: '2026-10-01T10:00:00',
      updatedAt: '2026-11-01T10:00:00',
    },
    organization: {
      id: 'o1',
      version: 2,
      name: 'Acme',
      domain: 'acme.example.com',
      kind: 'company',
      location: null,
      linkedinUrl: 'https://linkedin.com/company/acme',
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
    patchFailure: null,
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
      const path = `${url.pathname}${url.search}`;
      world.calls.push({ method, path, body });

      if (url.pathname === '/api/people/p1' && method === 'GET') return json(200, world.person);
      if (url.pathname === '/api/people/p1' && method === 'PATCH') {
        if (world.patchFailure) return json(world.patchFailure.status, { error: world.patchFailure });
        const fields = (body as { fields: Record<string, unknown> }).fields;
        world.person = { ...world.person, ...fields, version: (world.person.version as number) + 1 };
        return json(200, world.person);
      }
      if (url.pathname === '/api/people/p1/enrichment' && method === 'GET') return json(200, world.enrichment);
      if (url.pathname === '/api/people/p1/enrichment' && method === 'POST') {
        if (world.acceptFailure) return json(world.acceptFailure.status, { error: world.acceptFailure });
        const { field } = body as { field: string };
        const accepted = world.enrichment.suggestions.find((entry) => entry.field === field);
        world.enrichment = { ...world.enrichment, suggestions: world.enrichment.suggestions.filter((entry) => entry.field !== field) };
        world.person = { ...world.person, [field]: accepted?.value, version: (world.person.version as number) + 1 };
        return json(200, {});
      }
      if (url.pathname === '/api/people/p1/enrichment' && method === 'DELETE') {
        world.enrichment = { ...world.enrichment, suggestions: [] };
        return json(200, {});
      }
      if (url.pathname === '/api/runs' && method === 'POST') {
        const run = { id: 'run-new', kind: 'enrich_person', title: 'Enrich', status: 'queued', scope: { personId: 'p1' }, counts: {}, startedAt: null, finishedAt: null, createdAt: '2026-11-05T10:00:00' };
        world.enrichment = { run: { id: 'run-new', status: 'queued', startedAt: null }, suggestions: [] };
        return json(201, run);
      }
      if (url.pathname === '/api/connectors') return json(200, world.connectors);
      if (url.pathname === '/api/followup-rules') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/organizations/o1' && method === 'GET') return json(200, world.organization);
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

function calls(method: string, pathStart: string): Call[] {
  return world.calls.filter((call) => call.method === method && call.path.startsWith(pathStart));
}

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

function renderOrganization() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <OrganizationSheet id="o1" onClose={() => {}} onOpenPerson={() => {}} />
      </Router>
    </QueryClientProvider>,
  );
}

function fieldRow(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: 'dt' });
  return term.closest('.field') as HTMLElement;
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

describe('profile field rows', () => {
  it('shows LinkedIn and X as links in the path form that open in a new tab', async () => {
    renderPerson();
    await loaded();
    const linkedin = within(fieldRow('LinkedIn')).getByRole('link', { name: '/in/jane-doe' });
    expect(linkedin).toHaveAttribute('href', 'https://www.linkedin.com/in/jane-doe');
    expect(linkedin).toHaveAttribute('target', '_blank');
    expect(linkedin.getAttribute('rel')).toContain('noreferrer');
    const x = within(fieldRow('X')).getByRole('link', { name: '/janedoe' });
    expect(x).toHaveAttribute('href', 'https://x.com/janedoe');
    expect(x).toHaveAttribute('target', '_blank');
  });

  it('shows the evidence chip on the LinkedIn row', async () => {
    renderPerson();
    await loaded();
    const chip = within(fieldRow('LinkedIn')).getByRole('button', { name: /Evidence for Linkedin url/i });
    expect(chip).toBeInTheDocument();
  });

  it('does not repeat a shown profile claim under More evidence', async () => {
    renderPerson();
    await loaded();
    expect(screen.queryByText('More evidence')).not.toBeInTheDocument();
  });

  it('says Not set when the person has no profile URLs', async () => {
    world.person = { ...world.person, linkedinUrl: null, xUrl: null, claims: [] };
    renderPerson();
    await loaded();
    expect(within(fieldRow('LinkedIn')).getByText('Not set')).toBeInTheDocument();
    expect(within(fieldRow('X')).getByText('Not set')).toBeInTheDocument();
    expect(within(fieldRow('LinkedIn')).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows a company LinkedIn row on the organization sheet', async () => {
    renderOrganization();
    const link = await screen.findByRole('link', { name: '/company/acme' });
    expect(link).toHaveAttribute('href', 'https://linkedin.com/company/acme');
    expect(link).toHaveAttribute('target', '_blank');
    expect(within(fieldRow('LinkedIn')).getByRole('button', { name: 'Edit linkedin' })).toBeInTheDocument();
  });

  it('adds https to a company URL the server saved without a scheme', async () => {
    world.organization = { ...world.organization, linkedinUrl: 'linkedin.com/company/acme' };
    renderOrganization();
    const link = await screen.findByRole('link', { name: '/company/acme' });
    expect(link).toHaveAttribute('href', 'https://linkedin.com/company/acme');
  });

  it('edits the LinkedIn URL like any other field', async () => {
    const { user } = renderPerson();
    await loaded();
    await user.click(within(fieldRow('LinkedIn')).getByRole('button', { name: 'Edit linkedin' }));
    const input = screen.getByRole('textbox', { name: 'LinkedIn' });
    await user.clear(input);
    await user.type(input, 'https://www.linkedin.com/in/jane-d{Enter}');
    await waitFor(() => expect(calls('PATCH', '/api/people/p1')).toHaveLength(1));
    expect(calls('PATCH', '/api/people/p1')[0]?.body).toEqual({ expectedVersion: 3, fields: { linkedinUrl: 'https://www.linkedin.com/in/jane-d' } });
    expect(await screen.findByRole('link', { name: '/in/jane-d' })).toBeInTheDocument();
  });

  it('clears the X URL by saving null', async () => {
    const { user } = renderPerson();
    await loaded();
    await user.click(within(fieldRow('X')).getByRole('button', { name: 'Edit x' }));
    await user.clear(screen.getByRole('textbox', { name: 'X' }));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(calls('PATCH', '/api/people/p1')).toHaveLength(1));
    expect(calls('PATCH', '/api/people/p1')[0]?.body).toEqual({ expectedVersion: 3, fields: { xUrl: null } });
  });

  it('shows the validation message when the server rejects the URL', async () => {
    world.patchFailure = { status: 400, code: 'validation_error', message: 'That is not a LinkedIn profile URL.' };
    const { user } = renderPerson();
    await loaded();
    await user.click(within(fieldRow('LinkedIn')).getByRole('button', { name: 'Edit linkedin' }));
    const input = screen.getByRole('textbox', { name: 'LinkedIn' });
    await user.clear(input);
    await user.type(input, 'nonsense{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('That is not a LinkedIn profile URL. Your edit was not saved.');
  });
});

describe('Enrich button', () => {
  const COST_LINE = 'Runs one profile scrape on your Apify account.';

  it('sits beside the Fields title with the cost line and is enabled when ready', async () => {
    renderPerson();
    await loaded();
    const head = screen.getByRole('heading', { name: 'Fields' }).parentElement as HTMLElement;
    await waitFor(() => expect(within(head).getByRole('button', { name: 'Enrich' })).toBeEnabled());
    expect(within(head).getByText(COST_LINE)).toBeInTheDocument();
    expect(screen.queryByText('Connect Apify in Settings to enrich')).not.toBeInTheDocument();
    expect(screen.queryByText('Add a LinkedIn profile first')).not.toBeInTheDocument();
  });

  it('is disabled with a reason when Apify is not connected', async () => {
    world.connectors = [];
    renderPerson();
    await loaded();
    const button = screen.getByRole('button', { name: 'Enrich' });
    await waitFor(() => expect(screen.getByText('Connect Apify in Settings to enrich')).toBeInTheDocument());
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Connect Apify in Settings to enrich');
    expect(screen.getByText(COST_LINE)).toBeInTheDocument();
  });

  it('is disabled with the same reason when the Apify token was rejected', async () => {
    world.connectors = [{ id: 'c1', kind: 'apify', status: 'error', statusMessage: 'Token rejected', allowlist: [] }];
    renderPerson();
    await loaded();
    await waitFor(() => expect(screen.getByText('Connect Apify in Settings to enrich')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Enrich' })).toBeDisabled();
  });

  it('is disabled with a reason when the person has no LinkedIn profile', async () => {
    world.person = { ...world.person, linkedinUrl: null, claims: [] };
    renderPerson();
    await loaded();
    await waitFor(() => expect(screen.getByText('Add a LinkedIn profile first')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Enrich' })).toBeDisabled();
  });

  it('names the Apify problem first when both are missing', async () => {
    world.connectors = [];
    world.person = { ...world.person, linkedinUrl: null, claims: [] };
    renderPerson();
    await loaded();
    await waitFor(() => expect(screen.getByText('Connect Apify in Settings to enrich')).toBeInTheDocument());
    expect(screen.queryByText('Add a LinkedIn profile first')).not.toBeInTheDocument();
  });

  it('starts an enrich run for this person and then reads Enriching', async () => {
    const { user } = renderPerson();
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'Enrich' }));
    await waitFor(() => expect(calls('POST', '/api/runs')).toHaveLength(1));
    expect(calls('POST', '/api/runs')[0]?.body).toEqual({ kind: 'enrich_person', scope: { personId: 'p1' } });
    const busy = await screen.findByRole('button', { name: 'Enriching' });
    expect(busy).toBeDisabled();
  });

  it.each(['queued', 'running', 'waiting_approval'])('reads Enriching and is disabled while the newest run is %s', async (status) => {
    world.enrichment = { run: { id: 'run-1', status, startedAt: '2026-11-05T09:00:00' }, suggestions: [] };
    renderPerson();
    await loaded();
    const button = await screen.findByRole('button', { name: 'Enriching' });
    expect(button).toBeDisabled();
  });

  it('is enabled again once the newest run finished', async () => {
    world.enrichment = { run: { id: 'run-1', status: 'succeeded', startedAt: '2026-11-05T09:00:00' }, suggestions: [] };
    renderPerson();
    await loaded();
    expect(await screen.findByRole('button', { name: 'Enrich' })).toBeEnabled();
  });

  it('shows the server message when the run cannot start', async () => {
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/runs' && init?.method === 'POST') {
          return json(400, { error: { code: 'validation_error', message: 'An enrich run is already open for this person.' } });
        }
        return original(input, init);
      }),
    );
    const { user } = renderPerson();
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'Enrich' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('An enrich run is already open for this person.');
  });
});

describe('suggestions', () => {
  function withSuggestions() {
    world.enrichment = {
      run: { id: 'run-1', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: '2 fields suggested.', suggestedCount: 2 },
      suggestions: [
        { field: 'title', value: 'VP Engineering', status: 'pending' },
        { field: 'location', value: 'Lisbon, Portugal', status: 'pending' },
      ],
    };
  }

  it('lists each suggestion between Fields and Qualification', async () => {
    withSuggestions();
    renderPerson();
    const heading = await screen.findByRole('heading', { name: 'Suggestions' });
    const section = heading.closest('section') as HTMLElement;
    expect(within(section).getByText('Title')).toBeInTheDocument();
    expect(within(section).getByText('VP Engineering')).toBeInTheDocument();
    expect(within(section).getByText('Location')).toBeInTheDocument();
    expect(within(section).getByText('Lisbon, Portugal')).toBeInTheDocument();
    expect(within(section).getAllByRole('button', { name: /^Accept / })).toHaveLength(2);
    expect(within(section).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();

    const titles = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent);
    expect(titles.indexOf('Suggestions')).toBe(titles.indexOf('Fields') + 1);
    expect(titles.indexOf('Qualification')).toBe(titles.indexOf('Suggestions') + 1);
  });

  it('shows no Suggestions section when nothing is pending and no run exists', async () => {
    renderPerson();
    await loaded();
    expect(screen.queryByRole('heading', { name: 'Suggestions' })).not.toBeInTheDocument();
  });

  it('accepts one suggestion with the current version, then refetches the person and the suggestions', async () => {
    withSuggestions();
    const { user } = renderPerson();
    await screen.findByRole('heading', { name: 'Suggestions' });
    const personFetches = calls('GET', '/api/people/p1').filter((call) => call.path === '/api/people/p1').length;
    const enrichmentFetches = calls('GET', '/api/people/p1/enrichment').length;

    await user.click(screen.getByRole('button', { name: 'Accept title' }));

    await waitFor(() => expect(calls('POST', '/api/people/p1/enrichment')).toHaveLength(1));
    expect(calls('POST', '/api/people/p1/enrichment')[0]?.body).toEqual({ runId: 'run-1', field: 'title', expectedVersion: 3 });

    // The accepted value appears under Fields and the accepted row leaves the list.
    await waitFor(() => expect(within(fieldRow('Title')).getByText('VP Engineering')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept title' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Accept location' })).toBeInTheDocument();
    expect(calls('GET', '/api/people/p1').filter((call) => call.path === '/api/people/p1').length).toBeGreaterThan(personFetches);
    expect(calls('GET', '/api/people/p1/enrichment').length).toBeGreaterThan(enrichmentFetches);
  });

  it('sends the refreshed version for the second accept', async () => {
    withSuggestions();
    const { user } = renderPerson();
    await screen.findByRole('heading', { name: 'Suggestions' });
    await user.click(screen.getByRole('button', { name: 'Accept title' }));
    await waitFor(() => expect(within(fieldRow('Title')).getByText('VP Engineering')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accept location' }));
    await waitFor(() => expect(calls('POST', '/api/people/p1/enrichment')).toHaveLength(2));
    expect(calls('POST', '/api/people/p1/enrichment')[1]?.body).toEqual({ runId: 'run-1', field: 'location', expectedVersion: 4 });
  });

  it('does not claim the run found nothing after its last suggestion was accepted', async () => {
    world.enrichment = {
      run: { id: 'run-1', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: '1 field suggested.', suggestedCount: 1 },
      suggestions: [{ field: 'title', value: 'VP Engineering', status: 'pending' }],
    };
    const { user } = renderPerson();
    await user.click(await screen.findByRole('button', { name: 'Accept title' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Suggestions' })).not.toBeInTheDocument());
    expect(screen.queryByText('Nothing new to suggest.')).not.toBeInTheDocument();
  });

  it('shows the conflict message and keeps the suggestion when the field was filled meanwhile', async () => {
    withSuggestions();
    world.acceptFailure = { status: 409, code: 'conflict', message: 'Title already has a value.' };
    const { user } = renderPerson();
    await user.click(await screen.findByRole('button', { name: 'Accept title' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Title changed since you opened this record, so the suggestion was not applied.');
    expect(screen.getByRole('button', { name: 'Accept title' })).toBeInTheDocument();
    expect(screen.getByText('VP Engineering')).toBeInTheDocument();
  });

  it('reloads the suggestions from the conflict message', async () => {
    withSuggestions();
    world.acceptFailure = { status: 409, code: 'conflict', message: 'Title already has a value.' };
    const { user } = renderPerson();
    await user.click(await screen.findByRole('button', { name: 'Accept title' }));
    await screen.findByRole('alert');
    world.acceptFailure = null;
    world.enrichment = { ...world.enrichment, suggestions: world.enrichment.suggestions.filter((entry) => entry.field !== 'title') };
    await user.click(screen.getByRole('button', { name: 'Reload suggestions' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Accept title' })).not.toBeInTheDocument();
  });

  it('shows the server message for other accept failures', async () => {
    withSuggestions();
    world.acceptFailure = { status: 500, code: 'internal', message: 'The server could not save this.' };
    const { user } = renderPerson();
    await user.click(await screen.findByRole('button', { name: 'Accept title' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The server could not save this. The suggestion was not applied.');
  });

  it('dismisses the rest of the run and clears the list', async () => {
    withSuggestions();
    const { user } = renderPerson();
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(calls('DELETE', '/api/people/p1/enrichment')).toHaveLength(1));
    expect(calls('DELETE', '/api/people/p1/enrichment')[0]?.path).toBe('/api/people/p1/enrichment?runId=run-1');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Suggestions' })).not.toBeInTheDocument());
    expect(screen.queryByText('Nothing new to suggest.')).not.toBeInTheDocument();
  });
});

describe('runs without pending suggestions', () => {
  it('shows the run detail as one muted line when the run found nothing', async () => {
    world.enrichment = {
      run: { id: 'run-2', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: 'Every field was already filled.', suggestedCount: 0 },
      suggestions: [],
    };
    renderPerson();
    expect(await screen.findByText('Every field was already filled.')).toHaveClass('muted');
    expect(screen.queryByRole('button', { name: /^Accept / })).not.toBeInTheDocument();
  });

  it('falls back to a plain line when a run that found nothing has no detail', async () => {
    world.enrichment = {
      run: { id: 'run-2', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: null, suggestedCount: 0 },
      suggestions: [],
    };
    renderPerson();
    expect(await screen.findByText('Nothing new to suggest.')).toHaveClass('muted');
  });

  it('shows nothing when the suggestions were all accepted or dismissed', async () => {
    world.enrichment = {
      run: { id: 'run-2', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: '2 fields suggested.', suggestedCount: 2 },
      suggestions: [],
    };
    renderPerson();
    await loaded();
    await screen.findByRole('button', { name: 'Enrich' });
    expect(screen.queryByRole('heading', { name: 'Suggestions' })).not.toBeInTheDocument();
    expect(screen.queryByText('2 fields suggested.')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing new to suggest.')).not.toBeInTheDocument();
  });

  it('shows the failing detail for a failed run and keeps Enrich available', async () => {
    world.enrichment = {
      run: { id: 'run-3', status: 'failed', startedAt: '2026-11-05T09:00:00', detail: 'The scraped item named a different profile.', suggestedCount: 0 },
      suggestions: [],
    };
    renderPerson();
    expect(await screen.findByText('The scraped item named a different profile.')).toHaveClass('muted');
    expect(await screen.findByRole('button', { name: 'Enrich' })).toBeEnabled();
  });

  it('drops the failure line once a new run starts', async () => {
    world.enrichment = {
      run: { id: 'run-3', status: 'failed', startedAt: '2026-11-05T09:00:00', detail: 'The scraped item named a different profile.', suggestedCount: 0 },
      suggestions: [],
    };
    const { user } = renderPerson();
    await screen.findByText('The scraped item named a different profile.');
    await user.click(await screen.findByRole('button', { name: 'Enrich' }));
    await screen.findByRole('button', { name: 'Enriching' });
    expect(screen.queryByText('The scraped item named a different profile.')).not.toBeInTheDocument();
  });

  it('shows nothing while a run is still open', async () => {
    world.enrichment = { run: { id: 'run-4', status: 'running', startedAt: '2026-11-05T09:00:00', detail: null, suggestedCount: 0 }, suggestions: [] };
    renderPerson();
    await screen.findByRole('button', { name: 'Enriching' });
    expect(screen.queryByRole('heading', { name: 'Suggestions' })).not.toBeInTheDocument();
  });
});
