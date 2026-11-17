// The person sheet's Calendar row: it follows Website, shows the shortened link in a new tab, says "Not set"
// when empty, and saves the calendarUrl field.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersonSheet } from '../../src/screens/RecordSheets';
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

let calendarUrl: string | null = null;
let patches: any[] = [];

const person = () => ({
  id: 'p1',
  version: 2,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: null,
  title: null,
  organizationId: null,
  location: 'Berlin',
  website: 'https://ada.example.com',
  calendarUrl,
  lifecycle: 'lead',
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
  calendarUrl = null;
  patches = [];
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if ((init?.method ?? 'GET') === 'PATCH') {
        patches.push(JSON.parse(String(init!.body)));
        return json(200, person());
      }
      if (url.pathname === '/api/people/p1') return json(200, person());
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
        <PersonSheet id="p1" onClose={() => {}} onOpenOrganization={() => {}} />
      </Router>
    </QueryClientProvider>,
  );
}

const row = (label: string) => screen.getAllByText(label).find((element) => element.tagName === 'DT')!.parentElement as HTMLElement;

describe('person sheet Calendar row', () => {
  it('sits directly after the Website row', async () => {
    renderSheet();
    await screen.findByText('Berlin');
    const labels = Array.from(document.querySelectorAll('dt')).map((term) => term.textContent);
    const website = labels.indexOf('Website');
    expect(website).toBeGreaterThan(-1);
    expect(labels[website + 1]).toBe('Calendar');
  });

  it('shows the stored link as its path form, opening in a new tab', async () => {
    calendarUrl = 'https://www.calendly.com/ada/intro/';
    renderSheet();
    const link = await screen.findByRole('link', { name: 'calendly.com/ada/intro' });
    expect(link).toHaveAttribute('href', 'https://www.calendly.com/ada/intro/');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows Not set when empty', async () => {
    renderSheet();
    await screen.findByText('Berlin');
    expect(within(row('Calendar')).getByText('Not set')).toBeInTheDocument();
  });

  it('saves the calendarUrl field when edited', async () => {
    const user = userEvent.setup();
    renderSheet();
    await screen.findByText('Berlin');
    await user.click(within(row('Calendar')).getByRole('button', { name: 'Edit calendar' }));
    await user.type(screen.getByRole('textbox', { name: 'Calendar' }), 'calendly.com/ada');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ expectedVersion: 2, fields: { calendarUrl: 'calendly.com/ada' } });
  });
});
