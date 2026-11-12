// Adversarial review probes for the organization Crunchbase row. Titles start with KILLS, CONFIRMS, or ACCEPTED.
// Nothing here changes application code.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrganizationSheet } from '../src/screens/RecordSheets';
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

let crunchbaseUrl: string | null = null;
let patchResponse: Response | null = null;

const org = () => ({
  id: 'org-1', version: 2, name: 'Acme Capital', domain: null, kind: 'fund', location: 'Berlin',
  linkedinUrl: null, crunchbaseUrl, people: [], claims: [], activities: [], tasks: [], opportunities: [],
  attributes: [], tags: [], createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00',
});

beforeEach(() => {
  crunchbaseUrl = null;
  patchResponse = null;
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if ((init?.method ?? 'GET') === 'PATCH') return patchResponse ?? json(200, org());
      if (url.pathname === '/api/organizations/org-1') return json(200, org());
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      return json(200, { items: [], nextCursor: null });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

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

describe('Crunchbase row hostile stored values', () => {
  it('CONFIRMS: javascript: and other non-http values render as plain text, never a link', async () => {
    for (const value of ['javascript:alert(1)', 'javascript://x%0aalert(1)', 'data:text/html,<b>x</b>', 'not a url', 'vbscript:x', 'ftp://crunchbase.com/organization/x']) {
      crunchbaseUrl = value;
      const { unmount } = (() => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        return render(
          <QueryClientProvider client={client}>
            <Router>
              <OrganizationSheet id="org-1" onClose={() => {}} onOpenPerson={() => {}} />
            </Router>
          </QueryClientProvider>,
        );
      })();
      await screen.findByText('Berlin');
      const r = row('Crunchbase');
      expect(within(r).queryByRole('link'), value).toBeNull();
      expect(r.textContent, value).toContain(value);
      unmount();
    }
  });

  it('ACCEPTED: a stored off-site https link would render as a link whose text hides its host', async () => {
    // The column is new and every write is validated, so only a direct database edit can store this. The link text is
    // the path by design (docs/design.md), the title attribute carries the full value, and LinkedIn behaves the same.
    crunchbaseUrl = 'https://evil.example.net/organization/acme';
    renderSheet();
    const link = await screen.findByRole('link', { name: '/organization/acme' });
    expect(link).toHaveAttribute('href', 'https://evil.example.net/organization/acme');
    expect(link).toHaveAttribute('title', 'https://evil.example.net/organization/acme');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  });
});

describe('Crunchbase row save error path', () => {
  it('CONFIRMS: a 400 validation message from the server is shown in the row', async () => {
    const message = 'The Crunchbase link must be an organization page such as https://www.crunchbase.com/organization/example.';
    patchResponse = json(400, { error: { code: 'validation', message, details: [{ path: ['fields', 'crunchbaseUrl'], message: message.replace(/\.$/, '') }] } });
    const user = userEvent.setup();
    renderSheet();
    await screen.findByText('Berlin');
    await user.click(within(row('Crunchbase')).getByRole('button', { name: 'Edit crunchbase' }));
    await user.type(screen.getByRole('textbox', { name: 'Crunchbase' }), 'https://example.com/x');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.body.textContent).toContain('Crunchbase link must be an organization page'));
  });

  it('CONFIRMS: a set value shows its path and an empty one shows Not set, and the edit button labels differ from LinkedIn', async () => {
    renderSheet();
    await screen.findByText('Berlin');
    expect(within(row('Crunchbase')).getByText('Not set')).toBeInTheDocument();
    expect(within(row('Crunchbase')).getByRole('button', { name: 'Edit crunchbase' })).toBeInTheDocument();
    expect(within(row('LinkedIn')).queryByRole('button', { name: 'Edit crunchbase' })).toBeNull();
  });
});
