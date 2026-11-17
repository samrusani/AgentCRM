// Adversarial review probes for the person Calendar row. Titles start with KILLS, CONFIRMS, or ACCEPTED.
// Nothing here changes application code.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersonSheet } from '../src/screens/RecordSheets';
import { Router } from './helpers';

vi.mock('../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ui')>()),
  useUI: () => ({ theme: 'system', setTheme: () => {}, setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../src/api/events', () => ({ useServerEvents: () => {}, useEventConnection: () => 'open' }));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let calendarUrl: string | null = null;
let claims: unknown[] = [];
let patchResponse: Response | null = null;

const person = () => ({
  id: 'p1', version: 2, firstName: 'Ada', lastName: 'Lovelace', email: null, title: null, organizationId: null,
  location: 'Berlin', website: null, calendarUrl, lifecycle: 'lead', claims, activities: [], tasks: [],
  opportunities: [], attributes: [], tags: [], createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00',
});

beforeEach(() => {
  calendarUrl = null;
  claims = [];
  patchResponse = null;
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if ((init?.method ?? 'GET') === 'PATCH') return patchResponse ?? json(200, person());
      if (url.pathname === '/api/people/p1') return json(200, person());
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      return json(200, { items: [], nextCursor: null });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Router>
        <PersonSheet id="p1" onClose={() => {}} onOpenOrganization={() => {}} />
      </Router>
    </QueryClientProvider>,
  );
}
const row = (label: string) => screen.getAllByText(label).find((element) => element.tagName === 'DT')!.parentElement as HTMLElement;

describe('Calendar row hostile stored values', () => {
  it('CONFIRMS: javascript:, data:, and plain garbage render as plain text, never a link', async () => {
    for (const value of ['javascript:alert(1)', 'javascript://x%0aalert(1)', 'data:text/html,<b>x</b>', 'not a url', 'vbscript:x', 'ftp://cal.example.com/x', ]) {
      calendarUrl = value;
      const { unmount } = renderSheet();
      await screen.findByText('Berlin');
      const r = row('Calendar');
      expect(within(r).queryByRole('link'), value).toBeNull();
      expect(r.textContent, value).toContain(value);
      unmount();
    }
  });

  it('ACCEPTED: a stored mailto:a@example.com is shown as a link to example.com (WebsiteLink prepends https), same as Website', async () => {
    // Only a direct database edit can store this, the server refuses it. WebsiteLink treats a value without // as
    // schemeless, so it becomes https://mailto:a@example.com/ (host example.com). Shared with the Website row.
    calendarUrl = 'mailto:a@example.com';
    renderSheet();
    await screen.findByText('Berlin');
    const link = within(row('Calendar')).getByRole('link');
    expect(link).toHaveAttribute('href', 'https://mailto:a@example.com/');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('CONFIRMS: a valid link opens safely in a new tab', async () => {
    calendarUrl = 'https://calendly.com/ada';
    renderSheet();
    const link = await screen.findByRole('link', { name: 'calendly.com/ada' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  });
});

describe('Calendar row claims chip and errors', () => {
  it('CONFIRMS: claims for calendarUrl attach to the Calendar row and not to Website, and do not duplicate under other evidence', async () => {
    calendarUrl = 'https://calendly.com/ada';
    claims = [
      { id: 'c1', entityType: 'person', entityId: 'p1', field: 'calendarUrl', value: 'https://calendly.com/ada', sourceUrl: null, sourceType: 'import', observedAt: '2026-10-01T10:00:00', status: 'active' },
    ];
    renderSheet();
    await screen.findByText('Berlin');
    const cal = row('Calendar');
    const web = row('Website');
    expect(within(cal).getByRole('button', { name: /^Evidence for calendarUrl/ })).toBeTruthy();
    expect(within(web).queryAllByRole('button', { name: /^Evidence for/ })).toHaveLength(0);
    // The shown-fields list keeps the claim out of the "other evidence" section.
    expect(screen.getAllByRole('button', { name: /^Evidence for calendarUrl/ })).toHaveLength(1);
    const dts = Array.from(document.querySelectorAll('dt')).map((d) => d.textContent);
    expect(dts.filter((t) => t === 'Calendar')).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/calendarUrl/);
  });

  it('CONFIRMS: a 400 from the server shows the calendar message in the row', async () => {
    const message = 'The calendar link must be an http or https link, such as https://calendly.com/example.';
    patchResponse = json(400, { error: { code: 'validation', message, details: [{ path: ['fields', 'calendarUrl'], message: message.replace(/\.$/, '') }] } });
    const user = userEvent.setup();
    renderSheet();
    await screen.findByText('Berlin');
    await user.click(within(row('Calendar')).getByRole('button', { name: 'Edit calendar' }));
    await user.type(screen.getByRole('textbox', { name: 'Calendar' }), 'ftp://x.example.com');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.body.textContent).toContain('The calendar link must be an http or https link'));
  });

  it('CONFIRMS: Not set when empty, and Website and Calendar edit buttons are distinct', async () => {
    renderSheet();
    await screen.findByText('Berlin');
    expect(within(row('Calendar')).getByText('Not set')).toBeInTheDocument();
    expect(within(row('Calendar')).getByRole('button', { name: 'Edit calendar' })).toBeInTheDocument();
    expect(within(row('Website')).queryByRole('button', { name: 'Edit calendar' })).toBeNull();
  });
});
