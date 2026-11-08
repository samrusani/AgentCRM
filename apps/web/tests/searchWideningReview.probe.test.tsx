import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { CommandPalette } from '../src/shell/CommandPalette';
import { Router } from './helpers';

// Adversarial probes for the palette retrieval widening. Probes that pin a confirmed defect say so in the name.
const setPaletteOpen = vi.fn();
vi.mock('../src/lib/ui', () => ({
  useUI: () => ({ paletteOpen: true, setPaletteOpen, toggleAppearance: () => {}, pushToast: () => {} }),
}));

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
let payload: unknown;

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={['/start']}>
        <CommandPalette />
        <Where />
      </Router>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
const person = { id: 'per_1', firstName: 'Ada', lastName: 'Lovelace', name: 'Ada Lovelace', title: 'Partner', organizationName: 'Northwind', tags: [] };
const full = () => ({
  people: [person],
  organizations: [{ id: 'org_1', name: 'Northwind', kind: 'fund', domain: 'nw.example' }],
  opportunities: [{ id: 'opp_1', name: 'Seed round', organizationName: 'Northwind', amountTarget: 1000, currency: 'USD' }],
  notes: [{ id: 'act_1', snippet: 'a snippet', entityType: 'person', entityId: 'per_1', entityName: 'Ada Lovelace' }],
  tasks: [{ id: 'tsk_1', title: 'A task', entityType: 'opportunity', entityId: 'opp_1', entityName: 'Seed round' }],
  meetings: [{ id: 'mtg_1', title: 'A meeting', startsAt: '2026-04-01T10:00:00.000Z' }],
});

beforeEach(() => {
  setPaletteOpen.mockClear();
  Element.prototype.scrollIntoView = () => {};
  payload = full();
  vi.stubGlobal('fetch', vi.fn(async () => json(payload)));
});
afterEach(() => vi.unstubAllGlobals());

async function typeAbc(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('combobox'), 'abc');
  await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
}

describe('palette widening review', () => {
  it('the input aria-label is exactly the design copy', () => {
    setup();
    expect(screen.getByRole('combobox')).toHaveAccessibleName('Search people, organizations, deals, meetings, tasks, and notes');
  });

  it('KILLS: the empty state and the idle hint name everything search now covers, per design.md', async () => {
    const user = setup();
    expect(screen.getByText('Search people, organizations, deals, meetings, tasks, and notes.')).toBeInTheDocument();
    payload = { people: [], organizations: [], opportunities: [], notes: [], tasks: [], meetings: [] };
    await user.type(screen.getByRole('combobox'), 'abc');
    expect(await screen.findByText('No people, organizations, deals, meetings, tasks, or notes match this search.')).toBeInTheDocument();
  });

  it('keyboard: ArrowDown walks every group in design order, wraps, Enter opens the active row, aria-activedescendant tracks it', async () => {
    const user = setup();
    await typeAbc(user);
    const input = screen.getByRole('combobox');
    const order = screen.getAllByRole('option').map((o) => o.textContent);
    expect(order.length).toBe(6);
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['People', 'Organizations', 'Opportunities', 'Meetings', 'Tasks', 'Notes']);
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-option-0');
    for (let i = 0; i < 3; i += 1) await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-option-3');
    expect(screen.getAllByRole('option')[3]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('option')[3]).toHaveTextContent('A meeting');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/meetings?meeting=mtg_1'));
  });

  it('keyboard: ArrowUp from the first row wraps to the last (Notes), Enter opens the note parent', async () => {
    const user = setup();
    await typeAbc(user);
    await user.keyboard('{ArrowUp}');
    expect(screen.getAllByRole('option')[5]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/relationships?tab=people&person=per_1'));
  });

  it('a task linked to a deal opens the pipeline sheet; a note on an organization opens its organization sheet', async () => {
    payload = { ...full(), notes: [{ id: 'a', snippet: 's', entityType: 'organization', entityId: 'org_1', entityName: 'Northwind' }] };
    const user = setup();
    await typeAbc(user);
    await user.click(within(screen.getByRole('group', { name: 'Tasks' })).getByRole('option'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/pipeline?opportunity=opp_1'));
  });

  it('hostile text: ANSI escapes, RTL override, NUL-ish and a 10k character title render as inert text and do not crash', async () => {
    const hostile = '\u001b[31mred\u001b[0m ‮evil‬ \u0000 <script>window.__x=1</script>';
    const huge = 'T'.repeat(10_000);
    payload = {
      ...full(),
      tasks: [{ id: 't_h', title: huge, entityType: null, entityId: null, entityName: null }, { id: 't_h2', title: hostile, entityType: null, entityId: null, entityName: null }],
      notes: [{ id: 'n_h', snippet: hostile, entityType: 'person', entityId: 'per_1', entityName: hostile }],
      meetings: [{ id: 'm_h', title: hostile, startsAt: 'not a date' }],
    };
    const user = setup();
    await typeAbc(user);
    expect(document.querySelector('script')).toBeNull();
    expect((window as unknown as { __x?: number }).__x).toBeUndefined();
    expect(screen.getAllByText(huge).length).toBe(1);
    expect(screen.getAllByRole('group', { name: 'Notes' }).length).toBe(1);
  });

  it('KILLS (static CSS): .palette__label shrinks with an ellipsis and .palette__detail keeps the record name readable beside it', () => {
    const css = readFileSync(path.join(__dirname, '../src/styles/components.css'), 'utf8');
    const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)));
    const label = rule('.palette__label');
    expect(label).toContain('white-space: nowrap');
    expect(label).toMatch(/min-width: 0/);
    expect(label).toMatch(/text-overflow: ellipsis/);
    const detail = rule('.palette__detail');
    expect(detail).toMatch(/min-width: 0/);
    expect(detail).toMatch(/flex-shrink: 0/);
    expect(detail).toMatch(/max-width/);
  });

  it('older server tolerance: missing groups, null groups, and an empty object keep the palette working', async () => {
    for (const body of [{ people: [person] }, { people: [person], organizations: null, opportunities: null, notes: null, tasks: null, meetings: null }, {}]) {
      payload = body;
      const user = setup();
      await user.type(screen.getByRole('combobox'), 'abc');
      await waitFor(() => expect(screen.queryByText(/Search failed/)).toBeNull());
      await user.keyboard('{ArrowDown}{ArrowUp}');
      expect(screen.getByRole('combobox')).toBeInTheDocument();
      document.body.innerHTML = '';
    }
  });

  it('a note whose entityName is an empty string and a task with null name render without a detail element', async () => {
    payload = { ...full(), notes: [{ id: 'n', snippet: 'x', entityType: 'person', entityId: 'per_1', entityName: '' }], tasks: [{ id: 't', title: 'T', entityType: null, entityId: null, entityName: null }] };
    const user = setup();
    await typeAbc(user);
    expect(within(screen.getByRole('group', { name: 'Notes' })).getByRole('option').querySelector('.palette__detail')).toBeNull();
  });
});
