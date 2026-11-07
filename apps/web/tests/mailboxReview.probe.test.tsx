// Adversarial review probes for the mailbox capture web wave. Names start with KILLS (the attack fails), CONFIRMS (a
// live bug: the test passes against today's code and the comment says what should happen), or ACCEPTED (a deliberate
// limit). Nothing here changes application code.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { ImportReviewBody } from '../src/components/importReview';
import { formatDaysAgo } from '../src/lib/format';
import { parseImportReviewPayload } from '../src/lib/imports';
import { ImportBatchSheet } from '../src/screens/ImportSheets';
import { Leads } from '../src/screens/Relationships';
import { Router } from './helpers';

vi.mock('../src/lib/ui', () => ({
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

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const HOSTILE = '<img src=x onerror="window.__pwned=1"> ‮evil <b>bold</b>';
const person = {
  id: 'p1', version: 1, lifecycle: 'lead', firstName: 'Lena', lastName: 'Example', email: 'lena@example.com', title: null,
  organizationId: null, location: null, tags: [], nextActionAt: null, claims: [], activities: [], tasks: [], opportunities: [],
  organization: null, lists: [], createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-01T10:00:00',
};
let interaction: unknown;
let calls: string[];

function installFetch(batch: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/api/mail-provider') return json(200, { kind: 'agentmail', address: 'me@mine.example', ready: true, lastSyncAt: null });
      if (url.pathname === '/api/people') return json(200, { items: [person], nextCursor: null });
      if (url.pathname === '/api/organizations') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/lists') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/imports/imp-x') return json(200, batch);
      if (url.pathname === '/api/people/p1') return json(200, interaction === undefined ? person : { ...person, interaction });
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
}

class FakeEventSource {
  static CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  addEventListener() {}
  close() {}
}

function renderLeads(entry: string) {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[entry]}>
        <Routes>
          <Route path="/leads" element={<Leads />} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

beforeEach(() => {
  calls = [];
  interaction = undefined;
  installFetch({});
  vi.stubGlobal('EventSource', FakeEventSource);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  Reflect.deleteProperty(window, '__pwned');
});

describe('hostile names', () => {
  it('KILLS: a hostile name and a hostile address render as inert text in the review sample', () => {
    const review = parseImportReviewPayload({
      batchId: 'b', sinceDays: null, counts: { fetched: 1, staged: 1, duplicates: 0, invalid: 0 },
      sample: [{ email: 'x@y.example', name: HOSTILE, inbound: 1, outbound: 0, lastSeenAt: '2026-01-01T00:00:00.000Z' }],
    })!;
    const { container } = render(<Router><ImportReviewBody approval={{ id: 'a', runId: 'r' } as never} review={review} /></Router>);
    expect(container.querySelector('img, b')).toBeNull();
    expect(container.textContent).toContain('<img src=x');
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('KILLS: a hostile name renders as inert text in the batch sheet rows, and a missing raw column shows zero counts and Unknown', async () => {
    installFetch({
      id: 'imp-x', runId: 'r', sourceKind: 'mailbox', sourceRef: {}, status: 'awaiting_review', counts: { fetched: 2, staged: 2, duplicates: 0, invalid: 0 },
      items: [
        { seq: 1, status: 'staged', reason: null, mapped: { name: HOSTILE, email: 'x@y.example' }, raw: { inbound: 2, outbound: 1, lastSeenAt: '2026-01-01T00:00:00.000Z' } },
        { seq: 2, status: 'staged', reason: null, mapped: { name: null, email: 'z@y.example' }, raw: {} },
      ],
      nextCursor: null,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><Router><ImportBatchSheet id="imp-x" onClose={() => {}} /></Router></QueryClientProvider>);
    await screen.findByText(/<img src=x/);
    expect(document.querySelector('img, b')).toBeNull();
    const second = screen.getAllByRole('row')[2]!;
    expect(within(second).getAllByRole('cell').map((cell) => cell.textContent).slice(0, 5)).toEqual(['2', 'No name', 'z@y.example', '0', '0']);
    expect(container.ownerDocument.body.textContent).toContain('Unknown');
  });
});

describe('review columns', () => {
  it('KILLS: only a payload that carries sinceDays gets the mailbox columns; counts keys on an ordinary sample never switch the table', () => {
    const csv = parseImportReviewPayload({
      batchId: 'b', fileName: 'a.csv', counts: { fetched: 1, staged: 1, duplicates: 0, invalid: 0 },
      sample: [{ name: 'X', email: 'x@y.example', company: 'Y', inbound: 5, outbound: 5, lastSeenAt: '2026-01-01T00:00:00.000Z' }],
    })!;
    expect(csv.mailbox).toBe(false);
    render(<Router><ImportReviewBody approval={{ id: 'a', runId: 'r' } as never} review={csv} /></Router>);
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Name', 'Email', 'Company']);
  });

  it('KILLS: bad counts in a mailbox sample (negative, text, missing) render as numbers or zero, never NaN or a crash', () => {
    const review = parseImportReviewPayload({
      batchId: 'b', sinceDays: 30, counts: { fetched: 1, staged: 1, duplicates: 0, invalid: 0 },
      sample: [{ email: 'x@y.example', name: null, inbound: -3, outbound: 'lots', lastSeenAt: 'not a date' }],
    })!;
    const { container } = render(<Router><ImportReviewBody approval={{ id: 'a', runId: 'r' } as never} review={review} /></Router>);
    expect(container.textContent).not.toMatch(/NaN|undefined/);
    expect(within(screen.getAllByRole('row')[1]!).getAllByRole('cell').map((cell) => cell.textContent).slice(0, 4)).toEqual(['No name', 'x@y.example', '0', '0']);
  });
});

describe('Scan mailbox on the page', () => {
  it('KILLS: the button is absent on the Organizations tab, and a mailbox import param there opens no sheet', async () => {
    renderLeads('/leads?tab=organizations&import=mailbox');
    await waitFor(() => expect(calls.some((call) => call.endsWith('/api/organizations'))).toBe(true));
    expect(screen.queryByRole('button', { name: 'Scan mailbox' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Scan mailbox' })).not.toBeInTheDocument();
  });

  it('KILLS: the sheet\'s Cancel closes it without any request to the mailbox route', async () => {
    const { user } = renderLeads('/leads');
    const button = await screen.findByRole('button', { name: 'Scan mailbox' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const sheet = await screen.findByRole('dialog', { name: 'Scan mailbox' });
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Scan mailbox' })).not.toBeInTheDocument());
    expect(calls.some((call) => call.includes('/imports/mailbox'))).toBe(false);
  });
});

describe('interaction line', () => {
  it('KILLS: a missing interaction key and a null one both render no row', async () => {
    renderLeads('/leads?person=p1');
    const sheet = await screen.findByRole('dialog', { name: 'Lena Example' });
    await within(sheet).findByText('Lifecycle');
    expect(within(sheet).queryByText('Interaction')).not.toBeInTheDocument();
  });

  it('KILLS: a future or unreadable last date never reads as negative days or NaN', () => {
    const now = Date.parse('2026-11-08T12:00:00');
    expect(formatDaysAgo('2027-01-01T00:00:00', now)).toBe('today');
    expect(formatDaysAgo('garbage', now)).toBe('at an unknown time');
  });

  it('ACCEPTED (LOW): an outbound only person reads "They have not written." and the dates use the browser local day, so a near midnight UTC stamp can read as the neighbouring day', async () => {
    interaction = { lastInboundAt: null, lastOutboundAt: '2026-11-07T10:00:00', inbound: 0, outbound: 2 };
    renderLeads('/leads?person=p1');
    const sheet = await screen.findByRole('dialog', { name: 'Lena Example' });
    const line = await within(sheet).findByText(/They have not written\./);
    expect(line.textContent).toMatch(/^They have not written\. You last wrote .+\. 0 in, 2 out\.$/);
  });
});
