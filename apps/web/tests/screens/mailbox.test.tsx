import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes, useLocation } from 'react-router-dom';
import { useServerEvents } from '../../src/api/events';
import { ImportReviewBody } from '../../src/components/importReview';
import { parseImportReviewPayload } from '../../src/lib/imports';
import { formatDaysAgo } from '../../src/lib/format';
import { ImportBatchSheet } from '../../src/screens/ImportSheets';
import { Leads } from '../../src/screens/Relationships';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({
    theme: 'system',
    setTheme: () => {},
    navCollapsed: false,
    setNavCollapsed: () => {},
    navNarrow: false,
    setSelectedRecord: () => {},
    setPaletteOpen: () => {},
    panelCollapsed: true,
    setPanelCollapsed: () => {},
    panelSheetOpen: false,
    setPanelSheetOpen: () => {},
    toasts: [],
    dismissToast: () => {},
    pushToast: () => {},
  }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));

interface Call {
  method: string;
  path: string;
  body: any;
}

let calls: Call[];
let mailProvider: Record<string, unknown> | null;
let interaction: Record<string, unknown> | null | undefined;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const person = {
  id: 'lead-1',
  version: 1,
  lifecycle: 'lead',
  firstName: 'Lena',
  lastName: 'Example',
  email: 'lena@example.com',
  title: null,
  organizationId: null,
  location: null,
  tags: [],
  nextActionAt: null,
  claims: [],
  activities: [],
  tasks: [],
  opportunities: [],
  organization: null,
  lists: [],
  createdAt: '2026-10-01T10:00:00',
  updatedAt: '2026-11-01T10:00:00',
};

const mailboxBatchRows = [
  { seq: 1, status: 'staged', reason: null, mapped: { name: 'Ada Quill', email: 'ada@lanternrow.example' }, raw: { email: 'ada@lanternrow.example', name: 'Ada Quill', inbound: 12, outbound: 8, firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-11-01T10:00:00.000Z' } },
  { seq: 2, status: 'staged', reason: null, mapped: { name: null, email: 'ben@lanternrow.example' }, raw: { email: 'ben@lanternrow.example', name: null, inbound: 0, outbound: 3, firstSeenAt: '2026-02-01T00:00:00.000Z', lastSeenAt: '2026-03-01T00:00:00.000Z' } },
];

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === '/api/mail-provider') return json(200, mailProvider);
      if (url.pathname === '/api/people' && method === 'GET') return json(200, { items: [person], nextCursor: null });
      if (url.pathname === '/api/organizations') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/lists') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/imports/mailbox' && method === 'POST') {
        return json(201, { id: 'run-mailbox-1', kind: 'mailbox_capture', title: 'Mailbox capture', status: 'queued', steps: [], approvals: [], counts: {}, scope: {} });
      }
      if (url.pathname === '/api/imports/imp-mail') {
        return json(200, {
          id: 'imp-mail',
          runId: 'run-mailbox-1',
          sourceKind: 'mailbox',
          sourceRef: { sinceDays: 30, scannedMessages: 40, correspondents: 2 },
          status: 'awaiting_review',
          counts: { fetched: 2, staged: 2, duplicates: 0, invalid: 0 },
          items: mailboxBatchRows,
          nextCursor: null,
        });
      }
      if (url.pathname === '/api/people/lead-1') {
        return json(200, interaction === undefined ? person : { ...person, interaction });
      }
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  listeners = new Map<string, Array<() => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close() {}
  fire(name: string) {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function Events() {
  useServerEvents();
  return null;
}

function renderAt(entry: string) {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[entry]}>
        <Events />
        <Where />
        <Routes>
          <Route path="/leads" element={<Leads />} />
          <Route path="/research" element={<p>Research screen</p>} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

beforeEach(() => {
  calls = [];
  mailProvider = { kind: 'agentmail', address: 'me@mine.example', ready: true, lastSyncAt: null };
  interaction = undefined;
  FakeEventSource.instances = [];
  installFetch();
  vi.stubGlobal('EventSource', FakeEventSource);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
});

describe('Scan mailbox button', () => {
  it('is disabled with the reason while no mail provider is connected', async () => {
    mailProvider = null;
    renderAt('/leads');
    const button = await screen.findByRole('button', { name: 'Scan mailbox' });
    await waitFor(() => expect(calls.some((call) => call.path === '/api/mail-provider')).toBe(true));
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Connect a mail provider in Settings first.');
  });

  it('is disabled when the provider is not ready', async () => {
    mailProvider = { kind: 'gmail', address: 'me@mine.example', ready: false, lastSyncAt: null };
    renderAt('/leads');
    const button = await screen.findByRole('button', { name: 'Scan mailbox' });
    await waitFor(() => expect(button).toHaveAccessibleDescription('Connect a mail provider in Settings first.'));
    expect(button).toBeDisabled();
  });

  it('opens a sheet with the truth sentence, the window select, and stages all synced mail by default', async () => {
    const { user } = renderAt('/leads');
    const button = await screen.findByRole('button', { name: 'Scan mailbox' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    const sheet = await screen.findByRole('dialog', { name: 'Scan mailbox' });
    expect(within(sheet).getByText('Reads only mail already synced to this computer. Nothing is fetched, sent, or billed.')).toBeInTheDocument();
    const select = within(sheet).getByRole('combobox', { name: 'Window' });
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['All synced mail', 'Last 90 days', 'Last 30 days']);
    expect(select).toHaveValue('all');

    await user.click(within(sheet).getByRole('button', { name: 'Stage people for review' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/research?run=run-mailbox-1'));
    expect(calls.find((call) => call.path === '/api/imports/mailbox')!.body).toEqual({});
  });

  it('maps the window to sinceDays', async () => {
    const { user } = renderAt('/leads');
    const button = await screen.findByRole('button', { name: 'Scan mailbox' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const sheet = await screen.findByRole('dialog', { name: 'Scan mailbox' });
    await user.selectOptions(within(sheet).getByRole('combobox', { name: 'Window' }), 'Last 30 days');
    await user.click(within(sheet).getByRole('button', { name: 'Stage people for review' }));
    await waitFor(() => expect(calls.some((call) => call.path === '/api/imports/mailbox')).toBe(true));
    expect(calls.find((call) => call.path === '/api/imports/mailbox')!.body).toEqual({ sinceDays: 30 });
  });
});

describe('mailbox review columns', () => {
  const payload = {
    batchId: 'imp-mail',
    sinceDays: 30,
    counts: { fetched: 2, staged: 2, duplicates: 0, invalid: 0 },
    sample: [
      { email: 'ada@lanternrow.example', name: 'Ada Quill', inbound: 12, outbound: 8, lastSeenAt: '2020-01-01T00:00:00.000Z' },
      { email: 'ben@lanternrow.example', name: null, inbound: 0, outbound: 3, lastSeenAt: null },
    ],
  };

  it('shows email, name, in, out, and last seen in the approval sample', () => {
    const review = parseImportReviewPayload(payload)!;
    expect(review.mailbox).toBe(true);
    render(
      <Router>
        <ImportReviewBody approval={{ id: 'apr-1', runId: 'run-1' } as never} review={review} />
      </Router>,
    );
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['Name', 'Email', 'In', 'Out', 'Last seen']);
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Ada Quill', 'ada@lanternrow.example', '12', '8', expect.stringMatching(/ago$/)]);
    expect(within(rows[1]!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['No name', 'ben@lanternrow.example', '0', '3', 'Unknown']);
    expect(screen.queryByRole('columnheader', { name: 'Company' })).not.toBeInTheDocument();
  });

  it('keeps the usual columns for other imports', () => {
    const review = parseImportReviewPayload({ batchId: 'b', actorId: 'a~b', counts: payload.counts, sample: [{ name: 'X', email: 'x@y.example', company: 'Y' }] })!;
    expect(review.mailbox).toBe(false);
    render(
      <Router>
        <ImportReviewBody approval={{ id: 'apr-1', runId: 'run-1' } as never} review={review} />
      </Router>,
    );
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Name', 'Email', 'Company']);
  });

  it('shows in, out, and last seen in the batch sheet rows', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Router>
          <ImportBatchSheet id="imp-mail" onClose={() => {}} />
        </Router>
      </QueryClientProvider>,
    );
    await screen.findByText('Ada Quill');
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Row', 'Name', 'Email', 'In', 'Out', 'Last seen', 'Status', 'Reason']);
    const first = screen.getAllByRole('row')[1]!;
    const cells = within(first).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells.slice(0, 5)).toEqual(['1', 'Ada Quill', 'ada@lanternrow.example', '12', '8']);
    expect(screen.getByText('From mail already synced to this computer')).toBeInTheDocument();
  });
});

describe('Interaction on the person sheet', () => {
  const NOW = Date.parse('2026-11-08T12:00:00');

  it('formats days the way the sentence reads', () => {
    expect(formatDaysAgo('2026-11-08T01:00:00', NOW)).toBe('today');
    expect(formatDaysAgo('2026-11-07T23:00:00', NOW)).toBe('yesterday');
    expect(formatDaysAgo('2026-11-05T09:00:00', NOW)).toBe('3 days ago');
    expect(formatDaysAgo('2026-08-01T09:00:00', NOW)).toBe('3 months ago');
    expect(formatDaysAgo(null, NOW)).toBe('at an unknown time');
  });

  it('renders two sentences and muted counts under the Lifecycle row', async () => {
    interaction = { lastInboundAt: '2026-11-05T10:00:00', lastOutboundAt: '2026-11-07T10:00:00', inbound: 12, outbound: 8 };
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    try {
      renderAt('/leads?person=lead-1');
      const sheet = await screen.findByRole('dialog', { name: 'Lena Example' });
      const line = await within(sheet).findByText(/They last wrote 3 days ago\./);
      expect(line.textContent).toBe('They last wrote 3 days ago. You last wrote yesterday. 12 in, 8 out.');
      expect(within(line).getByText('12 in, 8 out.')).toHaveClass('muted');
      const labels = Array.from(sheet.querySelectorAll('dt')).map((term) => term.textContent);
      expect(labels.indexOf('Interaction')).toBe(labels.indexOf('Lifecycle') + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows nothing for a person without linked mail', async () => {
    interaction = null;
    renderAt('/leads?person=lead-1');
    const sheet = await screen.findByRole('dialog', { name: 'Lena Example' });
    await within(sheet).findByText('Lifecycle');
    expect(within(sheet).queryByText('Interaction')).not.toBeInTheDocument();
    expect(within(sheet).queryByText(/They last wrote/)).not.toBeInTheDocument();
  });

  it('refetches the person on record_updated so new mail appears', async () => {
    interaction = null;
    renderAt('/leads?person=lead-1');
    const sheet = await screen.findByRole('dialog', { name: 'Lena Example' });
    await within(sheet).findByText('Lifecycle');
    const before = calls.filter((call) => call.path === '/api/people/lead-1').length;
    interaction = { lastInboundAt: '2026-11-07T10:00:00', lastOutboundAt: null, inbound: 1, outbound: 0 };
    act(() => FakeEventSource.instances[0]!.fire('record_updated'));
    await waitFor(() => expect(calls.filter((call) => call.path === '/api/people/lead-1').length).toBeGreaterThan(before));
    expect(await within(sheet).findByText(/They last wrote/)).toBeInTheDocument();
    expect(within(sheet).getByText(/You have not written\./)).toBeInTheDocument();
  });
});
