// The organization sheet's Crunchbase row: it follows LinkedIn, shows the path form as a new-tab link, says
// "Not set" when empty, and saves the crunchbaseUrl field.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrganizationSheet } from '../../src/screens/RecordSheets';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/ui')>()),
  useUI: () => ({ theme: 'system', setTheme: () => {}, setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../../src/api/events', () => ({ useServerEvents: () => {}, useEventConnection: () => 'open' }));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let crunchbaseUrl: string | null = null;
let patches: any[] = [];

const org = () => ({
  id: 'org-1',
  version: 2,
  name: 'Acme Capital',
  domain: null,
  kind: 'fund',
  location: 'Berlin',
  linkedinUrl: 'https://www.linkedin.com/company/acme',
  crunchbaseUrl,
  people: [],
  claims: [],
  activities: [],
  tasks: [],
  opportunities: [],
  attributes: [],
  tags: [],
  createdAt: '2026-10-01T10:00:00',
  updatedAt: '2026-11-01T10:00:00',
});

beforeEach(() => {
  crunchbaseUrl = null;
  patches = [];
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if ((init?.method ?? 'GET') === 'PATCH') {
        patches.push(JSON.parse(String(init!.body)));
        return json(200, org());
      }
      if (url.pathname === '/api/organizations/org-1') return json(200, org());
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      return json(200, { items: [], nextCursor: null });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <OrganizationSheet id="org-1" onClose={() => {}} onOpenPerson={() => {}} />
      </Router>
    </QueryClientProvider>,
  );
}

const row = (label: string) => screen.getAllByText(label).find((element) => element.tagName === 'DT')!.parentElement as HTMLElement;

describe('organization sheet Crunchbase row', () => {
  it('sits directly after the LinkedIn row', async () => {
    renderSheet();
    await screen.findByText('Berlin');
    const labels = Array.from(document.querySelectorAll('dt')).map((term) => term.textContent);
    const linkedin = labels.indexOf('LinkedIn');
    expect(linkedin).toBeGreaterThan(-1);
    expect(labels[linkedin + 1]).toBe('Crunchbase');
  });

  it('shows the stored link as its path form, opening in a new tab', async () => {
    crunchbaseUrl = 'https://www.crunchbase.com/organization/acme';
    renderSheet();
    const link = await screen.findByRole('link', { name: '/organization/acme' });
    expect(link).toHaveAttribute('href', 'https://www.crunchbase.com/organization/acme');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows Not set when empty', async () => {
    renderSheet();
    await screen.findByText('Berlin');
    expect(within(row('Crunchbase')).getByText('Not set')).toBeInTheDocument();
  });

  it('saves the crunchbaseUrl field when edited', async () => {
    const user = userEvent.setup();
    renderSheet();
    await screen.findByText('Berlin');
    await user.click(within(row('Crunchbase')).getByRole('button', { name: 'Edit crunchbase' }));
    await user.type(screen.getByRole('textbox', { name: 'Crunchbase' }), 'crunchbase.com/organization/acme');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ expectedVersion: 2, fields: { crunchbaseUrl: 'crunchbase.com/organization/acme' } });
  });
});
