import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackblazeCard } from '../../src/screens/BackblazeCard';
import type { Connector } from '../../src/api/types';
import { Router } from '../helpers';

interface Call {
  method: string;
  path: string;
  body: any;
}

let calls: Call[];
let putResponse: { status: number; body: unknown };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function server(settings: Record<string, unknown> | null, status = 'connected') {
  return {
    id: 'con_1',
    kind: 'backblaze',
    status,
    statusMessage: status === 'error' ? 'Backblaze rejected the saved application key. Enter a new one to reconnect.' : null,
    tokenMasked: '****1234',
    updatedAt: new Date().toISOString(),
    settings,
  };
}

const baseSettings = {
  keyId: 'key-id-1',
  bucketId: 'bkt_1',
  bucketName: 'my-backups',
  keep: 14,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastResult: null,
  runRequestedAt: null,
};

beforeEach(() => {
  calls = [];
  putResponse = { status: 201, body: server(baseSettings) };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.pathname === '/api/connectors/backblaze' && method === 'PUT') return json(putResponse.status, putResponse.body);
      if (url.pathname === '/api/connectors/backblaze' && method === 'DELETE') return new Response(null, { status: 204 });
      if (url.pathname === '/api/backups/run') return json(202, { ok: true });
      if (url.pathname === '/api/connectors') return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Builds the card input through the same normalizer the app uses, by reading what /api/connectors would return.
async function connectorFrom(raw: unknown): Promise<Connector> {
  const { api } = await import('../../src/api/client');
  vi.mocked(fetch).mockImplementationOnce(async () => json(200, { items: [raw], nextCursor: null }));
  const list = await api.connectors.list();
  return list[0]!;
}

async function renderCard(raw: unknown | null) {
  const connector = raw ? await connectorFrom(raw) : null;
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <BackblazeCard connector={connector} />
      </Router>
    </QueryClientProvider>,
  );
  // The card opens on its own only on error, so open it like a person would.
  const toggle = screen.getByRole('button', { name: /Backblaze backups/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') await user.click(toggle);
  return user;
}

describe('Backblaze backup card', () => {
  it('shows the fields and the muted lines when not configured', async () => {
    await renderCard(null);
    expect(screen.getByLabelText('Key ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Application key')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Bucket name')).toBeInTheDocument();
    expect(screen.getByLabelText('Keep count')).toHaveValue(14);
    expect(screen.getByText(/stored unencrypted in the local database file/)).toBeInTheDocument();
    expect(screen.getByText('A backup is the whole database, connector keys included. Keep the bucket private.')).toBeInTheDocument();
    expect(screen.getByText('Backups run daily while AgentCRM is open; a missed day is caught up the next time it starts.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back up now' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('sends the four fields on Connect', async () => {
    const user = await renderCard(null);
    await user.type(screen.getByLabelText('Key ID'), 'key-id-1');
    await user.type(screen.getByLabelText('Application key'), 'secret-app-key');
    await user.type(screen.getByLabelText('Bucket name'), 'my-backups');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({
      keyId: 'key-id-1',
      applicationKey: 'secret-app-key',
      bucketName: 'my-backups',
      keep: 14,
    });
  });

  it('shows the server refusal sentence inline', async () => {
    putResponse = { status: 400, body: { error: { code: 'validation', message: 'bucketName: Bucket nope does not exist in this account.' } } };
    const user = await renderCard(null);
    await user.type(screen.getByLabelText('Key ID'), 'k');
    await user.type(screen.getByLabelText('Application key'), 'secret');
    await user.type(screen.getByLabelText('Bucket name'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bucket nope does not exist in this account.');
  });

  it('says no backup has run yet before the first one', async () => {
    await renderCard(server(baseSettings));
    expect(screen.getByText('No backup has run yet.')).toBeInTheDocument();
    expect(screen.getByText('my-backups')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeEnabled();
  });

  it('shows the last backup time and size', async () => {
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    await renderCard(server({ ...baseSettings, lastSuccessAt: at, lastResult: { at, ok: true, fileName: 'agentcrm/x.db', bytes: 2_621_440 } }));
    expect(screen.getByText('Last backup 3h ago, 2.5 MB.')).toBeInTheDocument();
  });

  it('shows the recorded failure sentence', async () => {
    const at = new Date().toISOString();
    await renderCard(server({ ...baseSettings, lastResult: { at, ok: false, error: 'The backup did not upload: Could not reach Backblaze.' } }));
    expect(screen.getByText('The backup did not upload: Could not reach Backblaze.')).toBeInTheDocument();
  });

  it('says a backup is queued and disables Back up now', async () => {
    await renderCard(server({ ...baseSettings, runRequestedAt: new Date().toISOString() }));
    expect(screen.getByText('A backup is queued.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled();
  });

  it('requests a backup with Back up now', async () => {
    const user = await renderCard(server(baseSettings));
    await user.click(screen.getByRole('button', { name: 'Back up now' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path === '/api/backups/run')).toBe(true));
  });

  it('saves the keep count on its own', async () => {
    putResponse = { status: 200, body: server({ ...baseSettings, keep: 30 }) };
    const user = await renderCard(server(baseSettings));
    const field = screen.getByLabelText('Keep count');
    await user.clear(field);
    await user.type(field, '30');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ keep: 30 }));
  });

  it('removes after confirming and says nothing uploaded is deleted', async () => {
    const user = await renderCard(server(baseSettings));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(/Nothing already uploaded is deleted/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Backblaze backups' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.path === '/api/connectors/backblaze')).toBe(true));
  });

  it('opens on a rejected key and offers a reconnect', async () => {
    await renderCard(server(baseSettings, 'error'));
    expect(screen.getByRole('alert')).toHaveTextContent('Backblaze rejected the saved application key');
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled();
  });
});
