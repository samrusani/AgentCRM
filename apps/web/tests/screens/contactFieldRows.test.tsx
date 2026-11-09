// The Phone and Website rows in the person and organization sheets: they show after Location, edit through the
// version envelope, show a website as a shortened new-tab link, and show a value that is not a URL as plain text.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrganizationSheet, PersonSheet } from '../../src/screens/RecordSheets';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../../src/api/events', () => ({
  useServerEvents: () => {},
  useEventConnection: () => 'open',
}));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Patch {
  path: string;
  body: any;
}
let patches: Patch[];
let phone: string | null;
let website: string | null;

const common = {
  version: 2,
  claims: [],
  activities: [],
  tasks: [],
  opportunities: [],
  attributes: [],
  tags: [],
  createdAt: '2026-10-01T10:00:00',
  updatedAt: '2026-11-01T10:00:00',
};

const personBody = () => ({
  ...common,
  id: 'person-1',
  lifecycle: 'lead',
  firstName: 'Ada',
  lastName: 'Quinn',
  email: null,
  title: null,
  organizationId: null,
  organizationName: null,
  organization: null,
  location: 'Berlin',
  nextActionAt: null,
  phone,
  website,
});

const organizationBody = () => ({
  ...common,
  id: 'org-1',
  name: 'Acme Capital',
  domain: null,
  kind: 'fund',
  location: 'Berlin',
  people: [],
  phone,
  website,
});

beforeEach(() => {
  patches = [];
  phone = null;
  website = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      if (method === 'PATCH') {
        const body = JSON.parse(String(init!.body));
        patches.push({ path: url.pathname, body });
        if ('phone' in body.fields) phone = body.fields.phone || null;
        if ('website' in body.fields) website = body.fields.website || null;
        return json(200, url.pathname.includes('/people/') ? personBody() : organizationBody());
      }
      if (url.pathname === '/api/people/person-1') return json(200, personBody());
      if (url.pathname === '/api/organizations/org-1') return json(200, organizationBody());
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      return json(200, { items: [], nextCursor: null });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSheet(kind: 'person' | 'organization') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        {kind === 'person' ? (
          <PersonSheet id="person-1" onClose={() => {}} onOpenOrganization={() => {}} />
        ) : (
          <OrganizationSheet id="org-1" onClose={() => {}} onOpenPerson={() => {}} />
        )}
      </Router>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const row = (label: string): HTMLElement => {
  const term = screen.getAllByText(label).find((element) => element.tagName === 'DT');
  return term!.parentElement as HTMLElement;
};

describe.each(['person', 'organization'] as const)('%s sheet contact fields', (kind) => {
  it('shows Phone and Website after Location, muted Not set when empty', async () => {
    renderSheet(kind);
    await screen.findByText('Berlin');
    const labels = Array.from(document.querySelectorAll('dl.fields dt')).map((term) => term.textContent);
    const location = labels.indexOf('Location');
    expect(labels.slice(location + 1, location + 3)).toEqual(['Phone', 'Website']);
    expect(within(row('Phone')).getByText('Not set')).toHaveClass('muted');
    expect(within(row('Website')).getByText('Not set')).toHaveClass('muted');
  });

  it('shows a website as a shortened link that opens in a new tab', async () => {
    phone = '+1 555 0100';
    website = 'https://www.acme.com/team';
    renderSheet(kind);
    expect(await screen.findByText('+1 555 0100')).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: 'acme.com/team' });
    expect(link).toHaveAttribute('href', 'https://www.acme.com/team');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows a website that does not parse as http or https as plain text', async () => {
    website = 'not a website';
    renderSheet(kind);
    const text = await screen.findByText('not a website');
    expect(text.tagName).toBe('SPAN');
    expect(screen.queryByRole('link', { name: 'not a website' })).toBeNull();
  });

  it('edits the phone and the website through the version envelope', async () => {
    const user = renderSheet(kind);
    await screen.findByText('Berlin');
    await user.click(within(row('Phone')).getByRole('button', { name: 'Edit phone' }));
    await user.type(screen.getByRole('textbox', { name: 'Phone' }), '555 0199{Enter}');
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.body).toEqual({ expectedVersion: 2, fields: { phone: '555 0199' } });

    await user.click(await within(row('Website')).findByRole('button', { name: 'Edit website' }));
    await user.type(screen.getByRole('textbox', { name: 'Website' }), 'acme.com{Enter}');
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]!.body.fields).toEqual({ website: 'acme.com' });
  });
});
