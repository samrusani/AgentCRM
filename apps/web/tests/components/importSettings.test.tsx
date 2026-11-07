import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GeneralSettings } from '../../src/screens/Settings';
import { ApprovalCard } from '../../src/components/approvals';
import type { Approval } from '../../src/api/types';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/ui')>()),
  useUI: () => ({ theme: 'system', setTheme: () => {} }),
}));

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let autoAccept: boolean;
let calls: Call[];
let putFailure: boolean;

const COPY =
  'Staged rows from Apify imports, CSV files, and lead capture are saved without review. Duplicates and invalid rows are still skipped. Runs started by the agent, and mailbox scans, always wait for your review.';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === '/api/imports/settings' && method === 'GET') return json(200, { autoAccept });
      if (url.pathname === '/api/imports/settings' && method === 'PUT') {
        if (putFailure) return json(500, { error: { code: 'internal', message: 'Could not save.' } });
        autoAccept = (body as { autoAccept: boolean }).autoAccept;
        return json(200, { autoAccept });
      }
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

function renderGeneral() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <GeneralSettings />
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

beforeEach(() => {
  autoAccept = false;
  calls = [];
  putFailure = false;
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Imports section in General settings', () => {
  it('shows an Imports heading, the toggle off by default, and the exact copy', async () => {
    renderGeneral();
    expect(screen.getByRole('heading', { name: 'Imports' })).toBeInTheDocument();
    const toggle = await screen.findByRole('checkbox', { name: 'Auto accept imports' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(COPY)).toBeInTheDocument();
    expect(toggle).toHaveAccessibleDescription(COPY);
  });

  it('shows the toggle on when the saved setting is on', async () => {
    autoAccept = true;
    renderGeneral();
    expect(await screen.findByRole('checkbox', { name: 'Auto accept imports' })).toBeChecked();
  });

  it('saves the new value when switched on and then off again', async () => {
    const { user } = renderGeneral();
    const toggle = await screen.findByRole('checkbox', { name: 'Auto accept imports' });
    await user.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([{ autoAccept: true }]);
    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([
      { autoAccept: true },
      { autoAccept: false },
    ]);
  });

  it('keeps the toggle off and says so when the save fails', async () => {
    putFailure = true;
    const { user } = renderGeneral();
    const toggle = await screen.findByRole('checkbox', { name: 'Auto accept imports' });
    await user.click(toggle);
    const section = screen.getByRole('heading', { name: 'Imports' }).closest('section') as HTMLElement;
    expect(await within(section).findByRole('alert')).toHaveTextContent('The setting did not change.');
    expect(toggle).not.toBeChecked();
  });
});

function decided(overrides: Partial<Approval>): Approval {
  return {
    id: 'a1',
    runId: 'r1',
    kind: 'import_review',
    title: 'Review 12 staged rows',
    payload: {},
    payloadHash: 'hash',
    status: 'approved',
    note: null,
    decidedAt: '2026-11-05T10:00:00Z',
    decidedBy: 'auto_accept',
    createdAt: '2026-11-05T09:59:00Z',
    ...overrides,
  };
}

function renderApproval(approval: Approval) {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <Router>
        <ApprovalCard approval={approval} />
      </Router>
    </QueryClientProvider>,
  );
}

describe('decided import review', () => {
  it('shows Approved and Auto accepted when the setting decided it', () => {
    renderApproval(decided({}));
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Auto accepted')).toBeInTheDocument();
    expect(screen.queryByText('auto_accept')).not.toBeInTheDocument();
  });

  it('does not say Auto accepted for a human decision', () => {
    renderApproval(decided({ decidedBy: 'user' }));
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.queryByText('Auto accepted')).not.toBeInTheDocument();
  });

  it('does not say Auto accepted for a rejected review', () => {
    renderApproval(decided({ status: 'rejected', decidedBy: 'user' }));
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.queryByText('Auto accepted')).not.toBeInTheDocument();
  });
});
