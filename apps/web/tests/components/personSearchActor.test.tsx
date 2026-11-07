import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../src/api/client';
import { DEFAULT_LEAD_ACTORS } from '../../src/lib/leads';
import { ConnectorSettings } from '../../src/screens/ConnectorSettings';
import { Router } from '../helpers';

// The people search actor setting used by person enrichment in name mode: type, defaults, normalizer, and the Apify card.

interface Call {
  method: string;
  path: string;
  body: any;
}

let connectors: Array<Record<string, unknown>>;
let calls: Call[];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const apifyEntry = (leadCapture: Record<string, string>) => ({
  id: 'c1',
  kind: 'apify',
  status: 'connected',
  statusMessage: null,
  settings: { allowlist: [], leadCapture },
});

beforeEach(() => {
  window.localStorage.clear();
  calls = [];
  connectors = [apifyEntry({ personSearchActor: 'custom~people-search' })];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === '/api/connectors' && method === 'GET') return json(200, connectors);
      if (url.pathname === '/api/connectors/apify' && method === 'PUT') {
        const sent = (body as { leadCapture?: Record<string, string> }).leadCapture ?? {};
        const current = (connectors[0]!.settings as { leadCapture: Record<string, string> }).leadCapture;
        const next = { ...current };
        for (const [key, value] of Object.entries(sent)) {
          if (value === '') delete next[key];
          else next[key] = value;
        }
        connectors = [apifyEntry(next)];
        return json(200, connectors[0]);
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

describe('people search actor setting', () => {
  it('KILLS: the connector normalizer keeps personSearchActor, and fills the default for an older server', async () => {
    const saved = (await api.connectors.list()).find((entry) => entry.kind === 'apify')!;
    expect(saved.leadCapture!.personSearchActor).toBe('custom~people-search');
    connectors = [apifyEntry({ companyActor: 'custom~company' })];
    const older = (await api.connectors.list()).find((entry) => entry.kind === 'apify')!;
    expect(older.leadCapture!.personSearchActor).toBe(DEFAULT_LEAD_ACTORS.personSearchActor);
    expect(DEFAULT_LEAD_ACTORS.personSearchActor).toBe('harvestapi/linkedin-profile-search-by-name');
  });

  it('shows the People search actor field with its saved value and a purpose line naming person enrichment', async () => {
    const user = renderSettings();
    await user.click(await screen.findByRole('button', { name: /Apify/ }));
    const field = (await screen.findByLabelText('People search actor')) as HTMLInputElement;
    expect(field.value).toBe('custom~people-search');
    expect(field.placeholder).toBe('harvestapi/linkedin-profile-search-by-name');
    expect(screen.getByText(/Used by Enrich on a person with no LinkedIn profile saved/)).toHaveClass('muted');
  });

  it('shows the default when the server sent none', async () => {
    connectors = [apifyEntry({})];
    const user = renderSettings();
    await user.click(await screen.findByRole('button', { name: /Apify/ }));
    expect(((await screen.findByLabelText('People search actor')) as HTMLInputElement).value).toBe('harvestapi/linkedin-profile-search-by-name');
    expect(screen.getByRole('button', { name: 'Reset People search actor to default' })).toBeDisabled();
  });

  it('saves an edited actor id alone, with the slash form turned into a tilde, and shows what the server returned', async () => {
    const user = renderSettings();
    await user.click(await screen.findByRole('button', { name: /Apify/ }));
    const field = await screen.findByLabelText('People search actor');
    await user.clear(field);
    await user.type(field, 'My-User/People-Finder');
    await user.click(screen.getByRole('button', { name: 'Save actors' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ leadCapture: { personSearchActor: 'My-User~People-Finder' } });
    await waitFor(() => expect((screen.getByLabelText('People search actor') as HTMLInputElement).value).toBe('My-User~People-Finder'));
  });

  it('resets to the default with an empty string', async () => {
    const user = renderSettings();
    await user.click(await screen.findByRole('button', { name: /Apify/ }));
    await user.click(await screen.findByRole('button', { name: 'Reset People search actor to default' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ leadCapture: { personSearchActor: '' } }));
    await waitFor(() =>
      expect((screen.getByLabelText('People search actor') as HTMLInputElement).value).toBe('harvestapi/linkedin-profile-search-by-name'),
    );
  });
});
