// Adversarial review probes for the Organizations section of the Duplicates screen.
// KILLS: the attack failed and the safe behavior is pinned. CONFIRMS: a live gap asserted as it behaves today.
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
let people: { pairs: any[]; capped: boolean };
let orgs: { pairs: any[]; capped: boolean };
let peopleStatus = 200;
let orgStatus = 200;
let mergeFailure: { status: number; code: string; message: string } | null;

const json = (status: number, body: unknown): Response =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const org = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  domain: 'acme.example',
  linkedinUrl: 'https://www.linkedin.com/company/acme',
  kind: 'company',
  createdAt: '2026-10-01T10:00:00.000Z',
  version: 3,
  people: 0,
  deals: 0,
  tasks: 0,
  activities: 0,
  ...over,
});

const orgPair = (a: any, b: any, over: Record<string, unknown> = {}) => ({
  organizationIds: [a.id, b.id],
  reason: 'domain',
  reasonText: 'Same domain.',
  left: a,
  right: b,
  fillsIfKeepLeft: 2,
  fillsIfKeepRight: 1,
  ...over,
});

const personSummary = (id: string, name: string) => ({
  id,
  name,
  email: `${id}@example.com`,
  organizationName: null,
  linkedinUrl: null,
  lifecycle: 'lead',
  createdAt: '2026-10-01T10:00:00.000Z',
  version: 2,
  deals: 0,
  tasks: 0,
  activities: 0,
});

beforeEach(() => {
  calls = [];
  mergeFailure = null;
  peopleStatus = 200;
  orgStatus = 200;
  people = { capped: false, pairs: [] };
  orgs = { capped: false, pairs: [orgPair(org('org-old', 'Older Org', { version: 4, createdAt: '2026-01-01T00:00:00.000Z', people: 2, deals: 1, tasks: 3, activities: 4 }), org('org-new', 'Newer Org', { version: 9, people: 1, deals: 1, tasks: 1, activities: 1 }))] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === '/api/duplicates' && method === 'GET')
        return peopleStatus === 200 ? json(200, people) : json(peopleStatus, { error: { code: 'internal', message: 'People scan broke.' } });
      if (url.pathname === '/api/duplicates/organizations' && method === 'GET')
        return orgStatus === 200 ? json(200, orgs) : json(orgStatus, { error: { code: 'internal', message: 'Organization scan broke.' } });
      if (url.pathname === '/api/duplicates/organizations/dismiss') return json(200, { organizationIds: body.organizationIds });
      if (url.pathname === '/api/duplicates/dismiss') return json(200, { personIds: body.personIds });
      const merge = url.pathname.match(/^\/api\/organizations\/([^/]+)\/merge$/);
      if (merge) {
        if (mergeFailure) return json(mergeFailure.status, { error: { code: mergeFailure.code, message: mergeFailure.message } });
        orgs = { ...orgs, pairs: [] };
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

const orgCards = async () =>
  waitFor(() => {
    const found = within(screen.getByRole('list', { name: 'Duplicate organizations' })).getAllByRole('listitem');
    expect(found.length).toBeGreaterThan(0);
    return found;
  });
const merges = () => calls.filter((call) => call.method === 'POST' && /\/merge$/.test(call.path));

describe('Organizations section probes', () => {
  it('KILLS: the people query failing leaves the organizations section rendered, and the reverse', async () => {
    peopleStatus = 500;
    const first = renderDuplicates();
    await orgCards();
    expect(await screen.findByText('People scan broke.')).toBeInTheDocument();
    first.unmount();
    peopleStatus = 200;
    orgStatus = 500;
    people = { capped: false, pairs: [{ personIds: ['p1', 'p2'], reason: 'email', reasonText: 'Same email address.', left: personSummary('p1', 'Pat One'), right: personSummary('p2', 'Pat Two'), fillsIfKeepLeft: 0, fillsIfKeepRight: 0 }] };
    renderDuplicates();
    expect(await screen.findByText('Organization scan broke.')).toBeInTheDocument();
    expect(await screen.findByText('Same email address.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Duplicate organizations' })).toBeNull();
  });

  it('KILLS: hostile organization names, domains, and LinkedIn values render as inert text and no link is built from them', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1">';
    orgs = {
      capped: false,
      pairs: [
        orgPair(
          org('org-a', hostile, { domain: 'javascript:alert(1)', linkedinUrl: 'https://www.linkedin.com/company/<b>x</b>' }),
          org('org-b', '"><svg onload=window.__pwned=1>', { domain: '<script>window.__pwned=1</script>', linkedinUrl: null }),
          { reasonText: '<i>Same domain.</i>' },
        ),
      ],
    };
    const { container } = renderDuplicates();
    const [card] = await orgCards();
    expect(within(card!).getByText(hostile)).toBeInTheDocument();
    expect(within(card!).getByText('javascript:alert(1)')).toBeInTheDocument();
    expect(container.querySelector('img, script, svg, b, i')).toBeNull();
    for (const anchor of Array.from(container.querySelectorAll('a'))) expect(anchor.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    expect((window as any).__pwned).toBeUndefined();
  });

  it('KILLS: the confirm sentence counts equal the other record of the pair, with singular forms at one', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    const [card] = await orgCards();
    // Keep left: the OTHER is the right record: 1 person, 1 deal, 1 task, 1 activity, fills = fillsIfKeepLeft = 2
    await user.click(within(card!).getByRole('button', { name: 'Keep left' }));
    expect(within(card!).getByText('Keep Older Org. Moves 1 person, 1 deal, 1 task, and 1 activity, fills 2 empty fields, and deletes the other record. This cannot be undone.')).toBeInTheDocument();
    await user.click(within(card!).getByRole('button', { name: 'Cancel' }));
    await user.click(within(card!).getByRole('button', { name: 'Keep right' }));
    // Keep right: the OTHER is the older record: 2 people, 1 deal, 3 tasks, 4 activities, fills 1
    expect(within(card!).getByText('Keep Newer Org. Moves 2 people, 1 deal, 3 tasks, and 4 activities, fills 1 empty field, and deletes the other record. This cannot be undone.')).toBeInTheDocument();
    await user.click(within(card!).getByRole('button', { name: 'Cancel' }));
    expect(merges()).toEqual([]);
  });

  it('KILLS: Keep left sends survivor = older, Keep right sends survivor = newer, each with the matching versions, to the organizations route', async () => {
    const user = userEvent.setup();
    renderDuplicates();
    let [card] = await orgCards();
    await user.click(within(card!).getByRole('button', { name: 'Keep left' }));
    await user.click(within(card!).getByRole('button', { name: 'Merge records' }));
    await waitFor(() => expect(merges()).toHaveLength(1));
    expect(merges()[0]).toMatchObject({ path: '/api/organizations/org-old/merge', body: { otherId: 'org-new', expectedVersion: 4, otherExpectedVersion: 9 } });
    await waitFor(() => expect(screen.getByText('No duplicate organizations.')).toBeInTheDocument());

    orgs = { capped: false, pairs: [orgPair(org('org-old', 'Older Org', { version: 4 }), org('org-new', 'Newer Org', { version: 9 }))] };
    calls = [];
    const again = renderDuplicates();
    [card] = await orgCards();
    await user.click(within(card!).getByRole('button', { name: 'Keep right' }));
    await user.click(within(card!).getByRole('button', { name: 'Merge records' }));
    await waitFor(() => expect(merges()).toHaveLength(1));
    expect(merges()[0]).toMatchObject({ path: '/api/organizations/org-new/merge', body: { otherId: 'org-old', expectedVersion: 9, otherExpectedVersion: 4 } });
    expect(calls.filter((c) => /\/api\/people\//.test(c.path))).toEqual([]); // never the person route
    again.unmount();
  });

  it('KILLS: a refused merge shows the server reason in place and keeps the pair; Not duplicates posts the organization dismissal', async () => {
    const user = userEvent.setup();
    mergeFailure = { status: 409, code: 'version_conflict', message: 'This record changed since you loaded it. Reload it and try again.' };
    renderDuplicates();
    const [card] = await orgCards();
    await user.click(within(card!).getByRole('button', { name: 'Keep left' }));
    await user.click(within(card!).getByRole('button', { name: 'Merge records' }));
    expect(await within(card!).findByRole('alert')).toHaveTextContent('This record changed since you loaded it.');
    expect(screen.getByRole('list', { name: 'Duplicate organizations' })).toBeInTheDocument();
    mergeFailure = null; // the confirm resets when the refused merge reloads the list, same as the person card
    await user.click(await within(card!).findByRole('button', { name: 'Not duplicates' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/duplicates/organizations/dismiss')).toBe(true));
    expect(calls.find((c) => c.path === '/api/duplicates/organizations/dismiss')!.body).toEqual({ organizationIds: ['org-old', 'org-new'] });
  });

  it('KILLS: empty state, cap note, and kind chips render per contract', async () => {
    orgs = { capped: false, pairs: [] };
    const first = renderDuplicates();
    expect(await screen.findByText('No duplicate organizations.')).toBeInTheDocument();
    first.unmount();
    orgs = { capped: true, pairs: [orgPair(org('o1', 'Fund One', { kind: 'fund' }), org('o2', 'Fund Two', { kind: 'fund' }), { reason: 'name', reasonText: 'Same name.' })] };
    renderDuplicates();
    const [card] = await orgCards();
    expect(screen.getByText('Showing the first 200 pairs. Merge or dismiss some to see more.')).toBeInTheDocument();
    expect(within(card!).getAllByText('Fund')).toHaveLength(2);
    expect(within(card!).getByText('Same name.')).toBeInTheDocument();
  });

  it('KILLS: heading structure, one h1, an h2 for Organizations, record names as h3, no skipped levels', async () => {
    renderDuplicates();
    await orgCards();
    const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)));
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: 'Organizations' })).toBeInTheDocument();
    for (let i = 1; i < levels.length; i += 1) expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
  });

  it('KILLS: the name link encodes the organization id into the relationships route and the source never uses innerHTML', async () => {
    orgs = { capped: false, pairs: [orgPair(org('org a/b?x', 'Odd Id'), org('org-2', 'Other'))] };
    renderDuplicates();
    const [card] = await orgCards();
    expect(within(card!).getByRole('link', { name: 'Odd Id' })).toHaveAttribute('href', '/relationships?tab=organizations&org=org%20a%2Fb%3Fx');
    const source = readFileSync(path.resolve(__dirname, '../src/screens/Duplicates.tsx'), 'utf8');
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });

  it('KILLS: a missing pairs field or a non-array answer renders the empty state, not a crash', async () => {
    orgs = { capped: false } as any;
    renderDuplicates();
    expect(await screen.findByText('No duplicate organizations.')).toBeInTheDocument();
  });

  it('CONFIRMS (minor): with a person pair and an organization pair on screen, an unscoped "Keep left" query is ambiguous, so the buttons must be queried per card', async () => {
    people = { capped: false, pairs: [{ personIds: ['p1', 'p2'], reason: 'email', reasonText: 'Same email address.', left: personSummary('p1', 'Pat One'), right: personSummary('p2', 'Pat Two'), fillsIfKeepLeft: 0, fillsIfKeepRight: 0 }] };
    renderDuplicates();
    await orgCards();
    await screen.findByText('Same email address.');
    // Not a bug (the person probe queries within a card); pinned so a future test author is not surprised.
    expect(screen.getAllByRole('button', { name: 'Keep left' })).toHaveLength(2);
  });
});
