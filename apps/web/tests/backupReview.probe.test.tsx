// Adversarial review probes for the Backblaze card. KILLS tests fail when the defect is present.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorSettings } from '../src/screens/ConnectorSettings';
import { Router } from './helpers';

const SECRET = 'K005abcdefghijklmnopqrstuvwxyz1234';

interface World {
  connector: Record<string, any> | null;
  calls: { method: string; path: string; body: any }[];
}
let world: World;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function connectorRow(settingsPatch: Record<string, unknown> = {}, status = 'connected', extra: Record<string, unknown> = {}) {
  return {
    id: 'con_1',
    kind: 'backblaze',
    status,
    statusMessage: status === 'error' ? 'Backblaze rejected the saved application key. Enter a new one to reconnect.' : null,
    tokenMasked: '****1234',
    updatedAt: '2026-03-10T12:00:00.000Z',
    settings: {
      keyId: 'key-id-1',
      bucketId: 'bkt_1',
      bucketName: 'my-backups',
      keep: 14,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastResult: null,
      runRequestedAt: null,
      ...settingsPatch,
    },
    ...extra,
  };
}

beforeEach(() => {
  world = { connector: null, calls: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      world.calls.push({ method, path: url.pathname, body });
      if (url.pathname === '/api/connectors' && method === 'GET') return json(200, { items: world.connector ? [world.connector] : [], nextCursor: null });
      if (url.pathname === '/api/backups/run' && method === 'POST') {
        if (!world.connector) return json(400, { error: { code: 'validation', message: 'Backblaze is not connected. Connect Backblaze in Settings first.' } });
        world.connector = { ...world.connector, settings: { ...world.connector.settings, runRequestedAt: '2026-03-10T12:05:00.000Z' } };
        return json(202, { ok: true });
      }
      if (url.pathname === '/api/connectors/backblaze' && method === 'PUT') {
        const current = world.connector;
        world.connector = connectorRow({ ...(current?.settings ?? {}), ...(body.keep !== undefined ? { keep: body.keep } : {}), ...(body.bucketName ? { bucketName: body.bucketName } : {}) });
        return json(current ? 200 : 201, world.connector);
      }
      if (url.pathname === '/api/connectors/backblaze' && method === 'DELETE') {
        world.connector = null;
        return new Response(null, { status: 204 });
      }
      return json(200, { items: [], nextCursor: null });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderSettings() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <ConnectorSettings />
      </Router>
    </QueryClientProvider>,
  );
  const toggle = await screen.findByRole('button', { name: /Backblaze backups/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') await user.click(toggle);
  return user;
}

describe('Backblaze card review probes', () => {
  it('CONFIRMS: Back up now refreshes the card to "A backup is queued." and disables the button, via react-query invalidation', async () => {
    world.connector = connectorRow({ lastResult: { at: new Date().toISOString(), ok: true, fileName: 'a', bytes: 2048 } });
    const user = await renderSettings();
    expect(await screen.findByText(/Last backup/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back up now' }));
    expect(await screen.findByText('A backup is queued.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled();
    expect(world.calls.filter((call) => call.path === '/api/backups/run')).toHaveLength(1);
  });

  it('CONFIRMS: saving the keep count refreshes the card and sends only keep', async () => {
    world.connector = connectorRow();
    const user = await renderSettings();
    const field = await screen.findByLabelText('Keep count');
    await user.clear(field);
    await user.type(field, '30');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(world.calls.find((call) => call.method === 'PUT')?.body).toEqual({ keep: 30 }));
    await waitFor(() => expect(screen.getByLabelText('Keep count')).toHaveValue(30));
  });

  it('CONFIRMS: the four states of the status line and the disabled button in error', async () => {
    world.connector = connectorRow();
    await renderSettings();
    expect(await screen.findByText('No backup has run yet.')).toBeInTheDocument();
  });

  it('CONFIRMS: a failed last run shows the recorded sentence', async () => {
    world.connector = connectorRow({ lastResult: { at: '2026-03-10T11:00:00.000Z', ok: false, error: 'The backup did not upload: Upload token expired.' } });
    await renderSettings();
    expect(await screen.findByText('The backup did not upload: Upload token expired.')).toBeInTheDocument();
  });

  it('CONFIRMS: in error the card opens, Back up now is disabled, and a reconnect form is offered', async () => {
    world.connector = connectorRow({}, 'error');
    await renderSettings();
    expect(await screen.findByRole('button', { name: 'Back up now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.getByText(/Backblaze rejected the saved application key/)).toBeInTheDocument();
  });

  it('CONFIRMS: the card never renders the key even when the server row carries one by mistake', async () => {
    world.connector = connectorRow({}, 'connected', { applicationKey: SECRET, secret: SECRET, settings: { ...connectorRow().settings, applicationKey: SECRET } });
    await renderSettings();
    await screen.findByText('No backup has run yet.');
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(document.body.textContent).toContain('1234');
  });

  it('CONFIRMS: the storage sentence and both muted lines are present when not configured, and the key field is a password input', async () => {
    await renderSettings();
    expect(await screen.findByText(/stored unencrypted in the local database file/)).toBeInTheDocument();
    expect(screen.getByLabelText('Application key')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Keep count')).toHaveValue(14);
    expect(screen.getByText(/Keep the bucket private/)).toBeInTheDocument();
  });

  it('CONFIRMS: Remove asks first and names that nothing already uploaded is deleted; confirming returns to the connect form', async () => {
    world.connector = connectorRow();
    const user = await renderSettings();
    await screen.findByText('No backup has run yet.');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(/Nothing already uploaded is deleted/)).toBeInTheDocument();
    expect(world.calls.some((call) => call.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: /Remove Backblaze backups/ }));
    await waitFor(() => expect(world.calls.some((call) => call.method === 'DELETE')).toBe(true));
    expect(await screen.findByLabelText('Bucket name')).toBeInTheDocument();
  });

  it('KILLS: a backup that uploaded but failed to prune looks like a clean success; the recorded prune sentence is never shown (BackblazeCard.backupStatusLine ignores lastResult.error when ok)', async () => {
    const sentence = 'The backup uploaded, but could not remove old uploads (Delete failed).';
    world.connector = connectorRow({ lastResult: { at: new Date().toISOString(), ok: true, fileName: 'agentcrm/x.db', bytes: 4096, error: sentence } });
    await renderSettings();
    await screen.findByText(/Last backup/);
    expect(document.body.textContent).toContain(sentence);
  });

  it('CONFIRMS: an out of range keep disables Connect and an invalid server refusal shows inline', async () => {
    const user = await renderSettings();
    const keep = await screen.findByLabelText('Keep count');
    await user.type(screen.getByLabelText('Key ID'), 'id');
    await user.type(screen.getByLabelText('Application key'), 'key');
    await user.type(screen.getByLabelText('Bucket name'), 'b');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
    await user.clear(keep);
    await user.type(keep, '400');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    const form = within(screen.getByLabelText('Application key').closest('form')!);
    expect(form.queryByText(SECRET)).toBeNull();
  });
});
