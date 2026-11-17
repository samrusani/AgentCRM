// Adversarial review probes for per-row dismiss of enrichment suggestions. Names start with KILLS (a real defect, pinned
// with it.fails), CONFIRMS (an attack failed, a safety property holds), or ACCEPTED (an imperfection that is fine, with
// the why). Nothing here changes application code.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrganizationSheet, PersonSheet } from '../src/screens/RecordSheets';
import { Router } from './helpers';

vi.mock('../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ui')>()),
  useUI: () => ({ setSelectedRecord: () => {} }),
}));

interface Call {
  method: string;
  path: string;
}
type Sugg = { field: string; value: string };
interface World {
  enrichment: { run: Record<string, unknown>; suggestions: Sugg[] };
  orgEnrichment: { run: Record<string, unknown>; suggestions: Sugg[] };
  calls: Call[];
  dismissGate: Promise<void> | null;
  // Status and message the next DELETEs answer with; removeOnFailure mimics a 409 for a row another tab already decided.
  dismissFailure: { status: number; code: string; message: string; removeOnFailure?: boolean } | null;
}
let world: World;

const run = (n: number) => ({ id: 'run-1', status: 'succeeded', startedAt: '2026-11-05T09:00:00', detail: null, suggestedCount: n });
const three: Sugg[] = [
  { field: 'title', value: 'Partner' },
  { field: 'location', value: 'Port Alder' },
  { field: 'email', value: 'jane@example.com' },
];
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const person = {
  id: 'p1', version: 3, firstName: 'Jane', lastName: 'Doe', email: null, title: null, organizationId: null, location: null,
  linkedinUrl: 'https://www.linkedin.com/in/jane-doe', xUrl: null, tags: [], nextActionAt: null, qualification: null, organization: null,
  affiliationsSummary: null, claims: [], activities: [], tasks: [], opportunities: [], createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00',
};
const org = {
  id: 'o1', version: 2, name: 'Acme', domain: null, kind: 'company', location: null, linkedinUrl: null, tags: [], people: [], claims: [],
  activities: [], opportunities: [], createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00',
};

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      world.calls.push({ method, path: `${url.pathname}${url.search}` });
      const personRoute = url.pathname === '/api/people/p1/enrichment';
      const orgRoute = url.pathname === '/api/organizations/o1/enrichment';
      if (url.pathname === '/api/people/p1' && method === 'GET') return json(200, person);
      if (url.pathname === '/api/organizations/o1' && method === 'GET') return json(200, org);
      if (personRoute && method === 'GET') return json(200, world.enrichment);
      if (orgRoute && method === 'GET') return json(200, world.orgEnrichment);
      if (personRoute && method === 'POST') {
        const { field } = JSON.parse(String(init?.body)) as { field: string };
        world.enrichment = { ...world.enrichment, suggestions: world.enrichment.suggestions.filter((s) => s.field !== field) };
        return json(200, {});
      }
      if ((personRoute || orgRoute) && method === 'DELETE') {
        const key = personRoute ? 'enrichment' : 'orgEnrichment';
        if (world.dismissGate) await world.dismissGate;
        const only = url.searchParams.get('field');
        if (world.dismissFailure) {
          const failure = world.dismissFailure;
          if (failure.removeOnFailure) world[key] = { ...world[key], suggestions: world[key].suggestions.filter((s) => s.field !== only) };
          return json(failure.status, { error: failure });
        }
        world[key] = { ...world[key], suggestions: world[key].suggestions.filter((s) => only !== null && s.field !== only) };
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/api/connectors') return json(200, [{ id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, allowlist: [] }]);
      if (url.pathname === '/api/followup-rules') return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

const deletes = () => world.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);

function renderSheet(kind: 'person' | 'org' = 'person') {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        {kind === 'person' ? (
          <PersonSheet id="p1" onClose={() => {}} onOpenOrganization={() => {}} />
        ) : (
          <OrganizationSheet id="o1" onClose={() => {}} onOpenPerson={() => {}} />
        )}
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

beforeEach(() => {
  window.localStorage.clear();
  world = {
    enrichment: { run: run(3), suggestions: three },
    orgEnrichment: { run: run(2), suggestions: [{ field: 'domain', value: 'acme.example.com' }, { field: 'location', value: 'Port Alder' }] },
    calls: [],
    dismissGate: null,
    dismissFailure: null,
  };
  installFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe('labels and names', () => {
  it('CONFIRMS: every row has a unique Accept and Dismiss name built from the same lowercased field label', async () => {
    renderSheet();
    await screen.findByRole('button', { name: 'Dismiss all' });
    const accepts = screen.getAllByRole('button', { name: /^Accept / }).map((b) => b.getAttribute('aria-label'));
    const dismisses = screen.getAllByRole('button', { name: /^Dismiss / }).map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(accepts).toEqual(['Accept title', 'Accept location', 'Accept email']);
    expect(dismisses).toEqual(['Dismiss title', 'Dismiss location', 'Dismiss email', 'Dismiss all']);
    expect(new Set(dismisses).size).toBe(dismisses.length);
    // Every per-row name is the Accept name with the verb swapped.
    expect(dismisses.filter((n) => n !== 'Dismiss all')).toEqual(accepts.map((n) => n!.replace('Accept', 'Dismiss')));
    expect(dismisses).toHaveLength(4);
  });

  it('CONFIRMS: with exactly one suggestion the bottom button reads Dismiss and is distinct by name from the row button', async () => {
    world.enrichment = { run: run(1), suggestions: [three[0]!] };
    renderSheet();
    const bottom = await screen.findByRole('button', { name: 'Dismiss' });
    expect(bottom).toHaveTextContent('Dismiss');
    expect(screen.getByRole('button', { name: 'Dismiss title' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss all' })).not.toBeInTheDocument();
  });
});

describe('request shape', () => {
  it('CONFIRMS: row Dismiss sends the field and never the all-dismiss; bottom flips to Dismiss after the refetch; last Dismiss sends no field', async () => {
    world.enrichment = { run: run(2), suggestions: three.slice(0, 2) };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Dismiss title' }));
    await waitFor(() => expect(screen.queryByText('Partner')).not.toBeInTheDocument());
    expect(deletes()).toEqual(['/api/people/p1/enrichment?runId=run-1&field=title']);
    const bottom = await screen.findByRole('button', { name: 'Dismiss' });
    expect(screen.queryByRole('button', { name: 'Dismiss all' })).not.toBeInTheDocument();
    await user.click(bottom);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Suggestions' })).not.toBeInTheDocument());
    expect(deletes()).toEqual(['/api/people/p1/enrichment?runId=run-1&field=title', '/api/people/p1/enrichment?runId=run-1']);
  });

  it('CONFIRMS: Dismiss all with three rows sends no field param at all', async () => {
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Dismiss all' }));
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(deletes()[0]).toBe('/api/people/p1/enrichment?runId=run-1');
  });

  it('CONFIRMS: the organization sheet dismisses one row with its field on the organization endpoint', async () => {
    const { user } = renderSheet('org');
    await user.click(await screen.findByRole('button', { name: 'Dismiss domain' }));
    await waitFor(() => expect(screen.queryByText('acme.example.com')).not.toBeInTheDocument());
    expect(deletes()).toEqual(['/api/organizations/o1/enrichment?runId=run-1&field=domain']);
    expect(await screen.findByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });
});

describe('in flight', () => {
  it('CONFIRMS: while a row dismiss is in flight all three Accepts, all three row Dismisses and the bottom button are disabled, and a second click sends nothing', async () => {
    const { user } = renderSheet();
    let open!: () => void;
    world.dismissGate = new Promise<void>((r) => (open = r));
    await user.click(await screen.findByRole('button', { name: 'Dismiss location' }));
    await waitFor(() => expect(deletes()).toHaveLength(1));
    const controls = screen.getAllByRole('button', { name: /^(Accept|Dismiss)/ });
    expect(controls).toHaveLength(7);
    for (const c of controls) expect(c).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Dismiss title' }));
    await user.click(screen.getByRole('button', { name: 'Dismiss all' }));
    expect(deletes()).toHaveLength(1);
    open();
    await waitFor(() => expect(screen.queryByText('Port Alder')).not.toBeInTheDocument());
    for (const c of screen.getAllByRole('button', { name: /^(Accept|Dismiss)/ })) await waitFor(() => expect(c).toBeEnabled());
  });
});

describe('errors', () => {
  it('CONFIRMS: a failed row dismiss shows the server sentence on that row only, keeps the list, and shows no second copy in the bottom bar', async () => {
    world.dismissFailure = { status: 500, code: 'internal', message: 'The server broke.' };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Dismiss location' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The server broke.');
    expect(alert.closest('li')).toHaveTextContent('Port Alder');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(document.querySelector('.suggestion-actions .inline-error')).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Accept / })).toHaveLength(3);
  });

  it('KILLS, fixed: after a failed row dismiss, clearing the row error (Reload suggestions) must not resurrect the same message in the bottom bar', async () => {
    world.dismissFailure = { status: 500, code: 'internal', message: 'The server broke.' };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Dismiss location' }));
    await screen.findByRole('alert');
    world.dismissFailure = null;
    await user.click(screen.getByRole('button', { name: 'Reload suggestions' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    // The bottom bar has its own error state now, so a cleared row error never reappears there.
    expect(document.querySelector('.suggestion-actions .inline-error')).toBeNull();
  });

  it('KILLS, fixed: after a failed row dismiss, clicking Accept on another row must not leave the old dismiss error in the bottom bar', async () => {
    world.dismissFailure = { status: 500, code: 'internal', message: 'The server broke.' };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Dismiss location' }));
    await screen.findByRole('alert');
    world.dismissFailure = null;
    await user.click(screen.getByRole('button', { name: 'Accept email' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(document.querySelector('.suggestion-actions .inline-error')).toBeNull();
  });

  it('ACCEPTED: a 409 on a row another session already decided removes the row on refetch, so the sentence is shown only briefly; the outcome (row gone) is the truth', async () => {
    world.dismissFailure = { status: 409, code: 'conflict', message: 'That suggestion was already accepted or dismissed.', removeOnFailure: true };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Dismiss location' }));
    await waitFor(() => expect(screen.queryByText('Port Alder')).not.toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: /^Accept / })).toHaveLength(2);
  });

  it('CONFIRMS: a failed bottom Dismiss all shows its error inline, and one row error never coexists with it', async () => {
    world.dismissFailure = { status: 500, code: 'internal', message: 'Nope.' };
    const { user } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Dismiss all' }));
    await waitFor(() => expect(document.querySelector('.suggestion-actions .inline-error')).toHaveTextContent('Nope.'));
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Dismiss title' }));
    await screen.findByRole('alert');
    expect(document.querySelector('.suggestion-actions .inline-error')).toBeNull();
  });
});

describe('focus', () => {
  it('ACCEPTED: when the dismissed row unmounts, focus falls to the document body; Accept behaves the same and no focus management exists in the suggestions view', async () => {
    const { user } = renderSheet();
    const button = await screen.findByRole('button', { name: 'Dismiss title' });
    await user.click(button);
    await waitFor(() => expect(screen.queryByText('Partner')).not.toBeInTheDocument());
    expect(button).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
    // The sheet itself stays rendered, so the keyboard user lands at the top of the page and tabs on from there.
    expect(within(document.body).getByRole('button', { name: 'Dismiss all' })).toBeInTheDocument();
  });
});
