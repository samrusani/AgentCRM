import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersonSheet } from '../../src/screens/RecordSheets';
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

type Org = { id: string; version: number; name: string; domain: string | null; kind: string; location: null; tags: string[] };

let calls: Call[];
let personOrg: Org | null;
let personVersion: number;
// What the next person PATCH answers with, when it should fail.
let patchFailure: { status: number; code: string; message: string; current?: unknown } | null;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const org = (id: string, name: string, domain: string | null = null): Org => ({
  id,
  version: 1,
  name,
  domain,
  kind: 'company',
  location: null,
  tags: [],
});
const ACME = org('org-1', 'Acme Capital', 'acme.example.com');
const BETA = org('org-2', 'Beta Labs');
const KNOWN = [ACME, BETA];

function personBody() {
  return {
    id: 'person-1',
    version: personVersion,
    lifecycle: 'lead',
    firstName: 'Ada',
    lastName: 'Quinn',
    email: null,
    title: 'Partner',
    organizationId: personOrg?.id ?? null,
    organizationName: personOrg?.name ?? null,
    organization: personOrg,
    location: null,
    tags: [],
    nextActionAt: null,
    createdAt: '2026-10-01T10:00:00',
    updatedAt: '2026-11-01T10:00:00',
    claims: [],
    activities: [],
    tasks: [],
    opportunities: [],
  };
}

beforeEach(() => {
  calls = [];
  personOrg = ACME;
  personVersion = 3;
  patchFailure = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, search: url.searchParams, body });
      if (url.pathname === '/api/search') {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        return json(200, { people: [], organizations: KNOWN.filter((o) => o.name.toLowerCase().includes(q)), opportunities: [] });
      }
      if (url.pathname === '/api/organizations' && method === 'POST') {
        const created = org('org-new', body.name);
        KNOWN.push(created);
        return json(201, created);
      }
      if (url.pathname === '/api/people/person-1' && method === 'PATCH') {
        if (patchFailure) {
          const { status, code, message, current } = patchFailure;
          return json(status, { error: { code, message, current } });
        }
        const next = body.fields.organizationId as string | null;
        personOrg = next ? (KNOWN.find((o) => o.id === next) ?? null) : null;
        personVersion += 1;
        return json(200, personBody());
      }
      if (url.pathname === '/api/people/person-1') return json(200, personBody());
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      if (url.pathname === '/api/activities') return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  KNOWN.splice(2);
});

function renderSheet() {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onOpenOrganization = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <PersonSheet id="person-1" onClose={onClose} onOpenOrganization={onOpenOrganization} />
      </Router>
    </QueryClientProvider>,
  );
  return { user, onClose, onOpenOrganization };
}

const personPatches = () => calls.filter((call) => call.method === 'PATCH' && call.path === '/api/people/person-1');
// The Tags row also says None, so the organization value is read from its own row.
const orgRow = () => screen.getByText('Organization', { selector: 'dt' }).closest('.field') as HTMLElement;
const orgInput = () => screen.getByRole('combobox', { name: 'Organization' });

async function startEditing(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Edit organization' }));
  return orgInput();
}

describe('Person sheet organization row', () => {
  it('shows the organization as a link and opens its sheet', async () => {
    const { user, onOpenOrganization } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Acme Capital' }));
    expect(onOpenOrganization).toHaveBeenCalledWith('org-1');
  });

  it('shows None with the same edit control when there is no organization', async () => {
    personOrg = null;
    renderSheet();
    expect(await screen.findByRole('button', { name: 'Edit organization' })).toBeInTheDocument();
    expect(within(orgRow()).getByText('None')).toBeInTheDocument();
  });

  it('enters edit mode with the picker focused and a Remove organization action', async () => {
    const { user } = renderSheet();
    const input = await startEditing(user);
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Remove organization' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit organization' })).not.toBeInTheDocument();
  });

  it('hides Remove organization when the person has none', async () => {
    personOrg = null;
    const { user } = renderSheet();
    await startEditing(user);
    expect(screen.queryByRole('button', { name: 'Remove organization' })).not.toBeInTheDocument();
  });

  it('saves a picked organization with the current version and shows the new name', async () => {
    const { user } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), 'Beta');
    await user.click(await screen.findByRole('option', { name: /Beta Labs/ }));
    expect(await screen.findByRole('button', { name: 'Beta Labs' })).toBeInTheDocument();
    expect(personPatches()).toHaveLength(1);
    expect(personPatches()[0].body).toEqual({ expectedVersion: 3, fields: { organizationId: 'org-2' } });
    expect(screen.queryByRole('combobox', { name: 'Organization' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit organization' })).toHaveFocus());
  });

  it('removes the organization by sending null', async () => {
    const { user } = renderSheet();
    await startEditing(user);
    await user.click(screen.getByRole('button', { name: 'Remove organization' }));
    await waitFor(() => expect(within(orgRow()).getByText('None')).toBeInTheDocument());
    expect(personPatches()[0].body).toEqual({ expectedVersion: 3, fields: { organizationId: null } });
  });

  it('cancels with Escape without a request, and keeps the sheet open', async () => {
    const { user, onClose } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), 'Beta');
    await screen.findByRole('option', { name: /Beta Labs/ });
    // The first Escape closes the list, the second leaves edit mode.
    await user.keyboard('{Escape}');
    expect(orgInput()).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox', { name: 'Organization' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acme Capital' })).toBeInTheDocument();
    expect(personPatches()).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    // A third Escape, in view mode, is the one that closes the sheet.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancels when the user clicks away', async () => {
    const { user } = renderSheet();
    await startEditing(user);
    await user.click(screen.getByText('Fields'));
    expect(screen.queryByRole('combobox', { name: 'Organization' })).not.toBeInTheDocument();
    expect(personPatches()).toHaveLength(0);
  });

  it('shows the conflict wording with a Reload record action', async () => {
    patchFailure = { status: 409, code: 'version_conflict', message: 'Version conflict.', current: { version: 4, organizationName: 'Beta Labs' } };
    const { user } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), 'Beta');
    await user.click(await screen.findByRole('option', { name: /Beta Labs/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The organization changed since you opened this record. It is now "Beta Labs". Your change was not saved.');
    patchFailure = null;
    personOrg = BETA;
    personVersion = 4;
    await user.click(screen.getByRole('button', { name: 'Reload record' }));
    expect(await screen.findByRole('button', { name: 'Beta Labs' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Organization' })).not.toBeInTheDocument();
  });

  it('says the organization was not changed for any other save failure', async () => {
    patchFailure = { status: 404, code: 'not_found', message: 'Organization not found.' };
    const { user } = renderSheet();
    await startEditing(user);
    await user.click(screen.getByRole('button', { name: 'Remove organization' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Organization not found. The organization was not changed.');
    expect(screen.queryByRole('button', { name: 'Reload record' })).not.toBeInTheDocument();
    // The row stays in edit mode so the user can try again.
    expect(orgInput()).toBeInTheDocument();
  });

  it('creates a new organization, then links it with the same save', async () => {
    const { user } = renderSheet();
    await startEditing(user);
    await user.type(orgInput(), 'Newco');
    await user.click(await screen.findByRole('option', { name: 'Add "Newco" as a new organization' }));
    expect(await screen.findByRole('button', { name: 'Newco' })).toBeInTheDocument();
    const writes = calls.filter((call) => call.method !== 'GET' && call.path !== '/api/search');
    expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/organizations', 'PATCH /api/people/person-1']);
    expect(writes[0].body).toEqual({ name: 'Newco' });
    expect(writes[1].body).toEqual({ expectedVersion: 3, fields: { organizationId: 'org-new' } });
  });
});
