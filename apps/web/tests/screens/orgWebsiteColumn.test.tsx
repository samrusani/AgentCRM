// The organizations table's Website column: host plus path (scheme and leading www. dropped) as a link to the stored
// URL that never opens the row's sheet, plain text for a value that does not parse as an http or https URL, empty
// when none is saved.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { Leads } from '../../src/screens/Relationships';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/ui')>()),
  useUI: () => ({ theme: 'system', setTheme: () => {}, setSelectedRecord: () => {} }),
}));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const organization = (id: string, name: string, website: string | null) => ({
  id,
  version: 1,
  name,
  domain: null,
  kind: 'company',
  location: null,
  linkedinUrl: null,
  website,
  tags: [],
  createdAt: '2026-10-01T10:00:00',
  updatedAt: '2026-11-01T10:00:00',
});

let detailGets: string[] = [];

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/organizations') {
        return json(200, {
          items: [
            organization('org-1', 'Alpaca VC', 'https://www.alpaca.example.com/team'),
            organization('org-2', 'Plain Text Co', 'not a website'),
            organization('org-3', 'No Site Co', null),
          ],
          nextCursor: null,
        });
      }
      const detail = url.pathname.match(/^\/api\/organizations\/(.+)$/);
      if (detail) {
        detailGets.push(detail[1]!);
        return json(200, { ...organization(detail[1]!, 'Alpaca VC', null), people: [], claims: [], activities: [], attributes: [], opportunities: [] });
      }
      if (url.pathname === '/api/people') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/lists') return json(200, { items: [] });
      if (url.pathname === '/api/views') return json(200, { items: [] });
      return json(200, { items: [], nextCursor: null });
    }),
  );
}

function stubLayout() {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
}

beforeEach(() => {
  detailGets = [];
  installFetch();
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  stubLayout();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
});

function renderOrganizations() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={['/leads?tab=organizations']}>
        <Routes>
          <Route path="/leads" element={<Leads />} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
  return user;
}

describe('organizations table Website column', () => {
  it('shows the header and the shortened host and path as a new-tab link', async () => {
    renderOrganizations();
    expect(await screen.findByText('Website')).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: 'alpaca.example.com/team' });
    expect(link).toHaveAttribute('href', 'https://www.alpaca.example.com/team');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('clicking the link never opens the row sheet', async () => {
    const user = renderOrganizations();
    const link = await screen.findByRole('link', { name: 'alpaca.example.com/team' });
    await user.click(link);
    expect(detailGets).toEqual([]);
  });

  it('a value that does not parse as an http or https URL renders as plain text, not a link', async () => {
    renderOrganizations();
    const text = await screen.findByText('not a website');
    expect(text.tagName).not.toBe('A');
    expect(screen.queryByRole('link', { name: 'not a website' })).toBeNull();
  });

  it('an organization without a website shows an empty cell and still opens its sheet on row click', async () => {
    const user = renderOrganizations();
    const row = (await screen.findByText('No Site Co')).closest('[role="row"]') ?? (await screen.findByText('No Site Co'));
    await user.click(row as HTMLElement);
    await waitFor(() => expect(detailGets).toContain('org-3'));
  });
});
