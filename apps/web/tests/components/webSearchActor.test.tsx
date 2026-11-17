import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../src/api/client';
import { DEFAULT_LEAD_ACTORS } from '../../src/lib/leads';
import { ConnectorSettings } from '../../src/screens/ConnectorSettings';
import { Router } from '../helpers';

// The web search actor setting used by person enrichment in web mode: default, normalizer, and the Apify card.

let leadCapture: Record<string, string>;
let puts: any[];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  window.localStorage.clear();
  leadCapture = { webSearchActor: 'custom~web-search' };
  puts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const entry = () => [{ id: 'c1', kind: 'apify', status: 'connected', statusMessage: null, settings: { allowlist: [], leadCapture } }];
      if (url.pathname === '/api/connectors' && method === 'GET') return json(200, entry());
      if (url.pathname === '/api/connectors/apify' && method === 'PUT') {
        const body = JSON.parse(String(init?.body));
        puts.push(body);
        for (const [key, value] of Object.entries(body.leadCapture as Record<string, string>)) {
          if (value === '') delete leadCapture[key];
          else leadCapture[key] = value;
        }
        return json(200, entry()[0]);
      }
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSettings() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <ConnectorSettings />
      </Router>
    </QueryClientProvider>,
  );
  return user;
}

describe('web search actor setting', () => {
  it('keeps the saved id and fills the default for an older server', async () => {
    const saved = (await api.connectors.list()).find((entry) => entry.kind === 'apify')!;
    expect(saved.leadCapture!.webSearchActor).toBe('custom~web-search');
    leadCapture = {};
    const older = (await api.connectors.list()).find((entry) => entry.kind === 'apify')!;
    expect(older.leadCapture!.webSearchActor).toBe(DEFAULT_LEAD_ACTORS.webSearchActor);
    expect(DEFAULT_LEAD_ACTORS.webSearchActor).toBe('apify/google-search-scraper');
  });

  it('shows the Web search actor field with a purpose line, saves an edit, and resets with an empty string', async () => {
    const user = renderSettings();
    await user.click(await screen.findByRole('button', { name: /Apify/ }));
    const field = (await screen.findByLabelText('Web search actor')) as HTMLInputElement;
    expect(field.value).toBe('custom~web-search');
    expect(field.placeholder).toBe('apify/google-search-scraper');
    expect(screen.getByText(/Used by Search the web on a person/)).toHaveClass('muted');
    await user.clear(field);
    await user.type(field, 'My-User/Web-Finder');
    await user.click(screen.getByRole('button', { name: 'Save actors' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ leadCapture: { webSearchActor: 'My-User~Web-Finder' } });
    await user.click(await screen.findByRole('button', { name: 'Reset Web search actor to default' }));
    await waitFor(() => expect(puts[1]).toEqual({ leadCapture: { webSearchActor: '' } }));
    await waitFor(() => expect((screen.getByLabelText('Web search actor') as HTMLInputElement).value).toBe('apify/google-search-scraper'));
  });
});
