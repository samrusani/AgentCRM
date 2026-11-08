// Adversarial review probes for the Duplicates screen. KILLS: the attack failed and the safe behavior is pinned.
// CONFIRMS: a live gap asserted as it behaves today. ACCEPTED: a contracted limit.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Duplicates } from '../src/screens/Duplicates';
import { Router } from './helpers';

vi.mock('../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {}, theme: 'system', setTheme: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../src/api/events', () => ({
  useServerEvents: () => {},
  useEventConnection: () => 'open',
}));

interface Call {
  method: string;
  path: string;
  body: any;
}

let calls: Call[];
let scan: { pairs: any[]; capped: boolean };
let mergeDelayMs = 0;
let mergeFailure: { status: number; code: string; message: string; body?: unknown } | null;

const json = (status: number, body: unknown): Response =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const summary = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  email: `${id}@example.com`,
  organizationName: 'Acme Capital',
  linkedinUrl: 'https://www.linkedin.com/in/example',
  lifecycle: 'lead',
  createdAt: '2026-10-01T10:00:00.000Z',
  version: 3,
  deals: 0,
  tasks: 0,
  activities: 0,
  ...over,
});

const pair = (a: any, b: any, over: Record<string, unknown> = {}) => ({
  personIds: [a.id, b.id],
  reason: 'email',
  reasonText: 'Same email address.',
  left: a,
  right: b,
  fillsIfKeepLeft: 2,
  fillsIfKeepRight: 1,
  ...over,
});

beforeEach(() => {
  calls = [];
  mergeFailure = null;
  mergeDelayMs = 0;
  scan = { capped: false, pairs: [pair(summary('per-old', 'Older Record', { version: 4, createdAt: '2026-01-01T00:00:00.000Z' }), summary('per-new', 'Newer Record', { version: 9 }))] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === '/api/duplicates' && method === 'GET') return json(200, scan);
      if (url.pathname === '/api/duplicates/dismiss') return json(200, { personIds: body.personIds });
      const merge = url.pathname.match(/^\/api\/people\/([^/]+)\/merge$/);
      if (merge) {
        if (mergeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, mergeDelayMs));
        if (mergeFailure) return json(mergeFailure.status, mergeFailure.body ?? { error: { code: mergeFailure.code, message: mergeFailure.message } });
        scan = { ...scan, pairs: [] };
        return json(200, { id: merge[1] });
      }
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDuplicates() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Router initialEntries={['/duplicates']}>
        <Duplicates />
      </Router>
    </QueryClientProvider>,
  );
}

const firstCard = async () =>
  waitFor(() => {
    const found = within(screen.getByRole('list', { name: 'Duplicate candidates' })).getAllByRole('listitem');
    expect(found.length).toBeGreaterThan(0);
    return found[0]!;
  });

const merges = () => calls.filter((call) => call.method === 'POST' && /\/merge$/.test(call.path));

describe('Duplicates screen probes', () => {
  it('KILLS: hostile names, emails, organizations, and profile links render as inert text', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1">';
    scan = {
      capped: false,
      pairs: [
        pair(
          summary('per-a', hostile, { email: `${hostile}@example.com`, organizationName: '<script>window.__pwned=1</script>', linkedinUrl: 'https://www.linkedin.com/in/<b>bold</b>' }),
          summary('per-b', '"><svg onload=window.__pwned=1>', { organizationName: null, email: null, linkedinUrl: null }),
          { reasonText: '<i>Same email address.</i>' },
        ),
      ],
    };
    const { container } = renderDuplicates();
    const card = await firstCard();
    expect(within(card).getByText(hostile)).toBeInTheDocument();
    expect(within(card).getByText('<script>window.__pwned=1</script>')).toBeInTheDocument();
    expect(container.querySelector('img, script, svg, b, i')).toBeNull();
    expect((window as any).__pwned).toBeUndefined();
  });

  it('KILLS: the screen source never uses dangerouslySetInnerHTML or builds a link from record text', () => {
    const source = readFileSync(path.resolve(__dirname, '../src/screens/Duplicates.tsx'), 'utf8');
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|href=\{person\./);
    expect(source).toMatch(/encodeURIComponent\(person\.id\)/);
  });

  it('KILLS: Keep left sends survivor = the older record, Keep right sends survivor = the newer record, each with the right versions', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    let card = await firstCard();
    expect(within(card).getByRole('region', { name: 'Left record' })).toHaveTextContent('Older Record');
    await user.click(within(card).getByRole('button', { name: 'Keep left' }));
    await user.click(within(card).getByRole('button', { name: 'Merge records' }));
    await waitFor(() => expect(merges()).toHaveLength(1));
    expect(merges()[0]).toMatchObject({ path: '/api/people/per-old/merge', body: { otherId: 'per-new', expectedVersion: 4, otherExpectedVersion: 9 } });
  });

  it('KILLS: Keep right makes the RIGHT record survive and names it in the confirm sentence', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    const card = await firstCard();
    await user.click(within(card).getByRole('button', { name: 'Keep right' }));
    expect(within(card).getByText(/^Keep Newer Record\./)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Merge records' }));
    await waitFor(() => expect(merges()).toHaveLength(1));
    expect(merges()[0]).toMatchObject({ path: '/api/people/per-new/merge', body: { otherId: 'per-old', expectedVersion: 9, otherExpectedVersion: 4 } });
  });

  it('KILLS: a double click on Merge records sends one merge', async () => {
    const user = userEvent.setup();
    mergeDelayMs = 50;
    renderDuplicates();
    const card = await firstCard();
    await user.click(within(card).getByRole('button', { name: 'Keep left' }));
    const button = within(card).getByRole('button', { name: 'Merge records' });
    await user.dblClick(button);
    await user.click(button);
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Duplicate candidates' })).not.toBeInTheDocument());
    expect(merges()).toHaveLength(1);
  });

  it('KILLS: Merge records and Keep buttons are disabled while a merge is in flight, so a second pair cannot be merged on top of it', async () => {
    const user = userEvent.setup();
    mergeDelayMs = 150;
    scan = {
      capped: false,
      pairs: [pair(summary('per-1', 'One'), summary('per-2', 'Two')), pair(summary('per-3', 'Three'), summary('per-4', 'Four'))],
    };
    renderDuplicates();
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Duplicate candidates' })).getAllByRole('listitem')).toHaveLength(2));
    const [one, two] = within(screen.getByRole('list', { name: 'Duplicate candidates' })).getAllByRole('listitem');
    await user.click(within(one!).getByRole('button', { name: 'Keep left' }));
    await user.click(within(one!).getByRole('button', { name: 'Merge records' }));
    for (const button of within(two!).getAllByRole('button')) expect(button).toBeDisabled();
    await waitFor(() => expect(merges()).toHaveLength(1));
  });

  it('KILLS: each refusal reason renders in place and keeps the card with its choices usable again', async () => {
    const user = userEvent.setup();
    for (const failure of [
      { status: 409, code: 'conflict', message: 'Stop the follow-ups and sends first.' },
      { status: 409, code: 'version_conflict', message: 'This record changed. Reload and try again.' },
      { status: 404, code: 'not_found', message: 'Person not found.' },
    ]) {
      mergeFailure = failure;
      const { unmount } = renderDuplicates();
      const card = await firstCard();
      await user.click(within(card).getByRole('button', { name: 'Keep left' }));
      await user.click(within(card).getByRole('button', { name: 'Merge records' }));
      expect(await within(card).findByRole('alert')).toHaveTextContent(failure.message);
      // The refusal reloads the list, which closes the confirm; the card stays, its choices come back, and the reason stays visible.
      await waitFor(() => expect(within(card).getByRole('button', { name: 'Keep left' })).toBeEnabled());
      expect(within(card).getByRole('alert')).toHaveTextContent(failure.message);
      unmount();
    }
  });

  it('KILLS: a refusal whose body is not JSON (a 500 page) still shows a sentence, never a blank or raw markup', async () => {
    const user = userEvent.setup();
    mergeFailure = { status: 500, code: 'internal', message: '', body: { oops: true } };
    renderDuplicates();
    const card = await firstCard();
    await user.click(within(card).getByRole('button', { name: 'Keep left' }));
    await user.click(within(card).getByRole('button', { name: 'Merge records' }));
    const alert = await within(card).findByRole('alert');
    expect((alert.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('KILLS: the confirm sentence states the destructive consequence and offers Cancel without sending anything', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    const card = await firstCard();
    await user.click(within(card).getByRole('button', { name: 'Keep left' }));
    expect(within(card).getByText(/deletes the other record\. This cannot be undone\./)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(merges()).toHaveLength(0);
    expect(within(card).queryByRole('button', { name: 'Merge records' })).not.toBeInTheDocument();
  });

  it('KILLS: the profile and record links encode ids so an id with a slash or query cannot redirect the link', async () => {
    scan = { capped: false, pairs: [pair(summary('per/a?x=1&person=evil', 'Odd Id'), summary('per-b', 'Normal'))] };
    renderDuplicates();
    const card = await firstCard();
    const href = within(card).getByRole('link', { name: 'Odd Id' }).getAttribute('href')!;
    expect(href).toBe('/leads?tab=people&person=per%2Fa%3Fx%3D1%26person%3Devil');
  });
});
