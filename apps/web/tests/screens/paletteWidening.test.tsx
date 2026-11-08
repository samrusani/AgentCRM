import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { CommandPalette } from '../../src/shell/CommandPalette';
import { Router } from '../helpers';

const setPaletteOpen = vi.fn();
vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({ paletteOpen: true, setPaletteOpen, toggleAppearance: () => {}, pushToast: () => {} }),
}));

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const HOSTILE = '<img src=x onerror="window.__pwned=1"> <b>bold</b>';
let payload: Record<string, unknown>;

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

beforeEach(() => {
  setPaletteOpen.mockClear();
  // jsdom does not implement scrollIntoView, which the palette calls for the active row.
  Element.prototype.scrollIntoView = () => {};
  payload = {
    people: [person],
    organizations: [],
    opportunities: [],
    notes: [{ id: 'act_1', snippet: `met about ${HOSTILE}`, entityType: 'opportunity', entityId: 'opp_9', entityName: 'Series A' }],
    tasks: [
      { id: 'tsk_1', title: 'Send the deck', entityType: 'organization', entityId: 'org_4', entityName: 'Northwind' },
      { id: 'tsk_2', title: 'Water the plants', entityType: null, entityId: null, entityName: null },
    ],
    meetings: [{ id: 'mtg_7', title: 'Board sync', startsAt: '2026-04-01T10:00:00.000Z' }],
  };
  vi.stubGlobal('fetch', vi.fn(async () => json(payload)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function search(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('combobox'), 'abc');
  await screen.findByRole('group', { name: 'Meetings' });
}

describe('command palette retrieval groups', () => {
  it('renders Meetings, Tasks, and Notes in order, with the design row shapes (actions are filtered out by the query)', async () => {
    const user = setup();
    await search(user);
    const groups = screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'));
    expect(groups).toEqual(['People', 'Meetings', 'Tasks', 'Notes']);

    const meetings = within(screen.getByRole('group', { name: 'Meetings' }));
    const meetingRow = meetings.getByRole('option');
    expect(meetingRow).toHaveTextContent('Board sync');
    expect(meetingRow.querySelector('.palette__detail')?.textContent).toMatch(/Apr/);

    const tasks = within(screen.getByRole('group', { name: 'Tasks' })).getAllByRole('option');
    expect(tasks[0]!.querySelector('.palette__label')?.textContent).toBe('Send the deck');
    expect(tasks[0]!.querySelector('.palette__detail')?.textContent).toBe('Northwind');
    expect(tasks[1]!.querySelector('.palette__detail')).toBeNull();

    const note = within(screen.getByRole('group', { name: 'Notes' })).getByRole('option');
    expect(note.querySelector('.palette__detail')?.textContent).toBe('Series A');

    // The existing people row is unchanged.
    expect(within(screen.getByRole('group', { name: 'People' })).getByRole('option')).toHaveTextContent('Ada Lovelace');
  });

  it('does not render empty groups', async () => {
    payload = { people: [person], organizations: [], opportunities: [], notes: [], tasks: [], meetings: [] };
    const user = setup();
    await user.type(screen.getByRole('combobox'), 'abc');
    await screen.findByRole('group', { name: 'People' });
    expect(screen.queryByRole('group', { name: 'Meetings' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Tasks' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Notes' })).toBeNull();
  });

  it('opens the meeting sheet, the parent record sheets, and /today for an unlinked task', async () => {
    const cases: [string, string, string][] = [
      ['Board sync', 'Meetings', '/meetings?meeting=mtg_7'],
      ['Send the deck', 'Tasks', '/relationships?tab=organizations&org=org_4'],
      ['Water the plants', 'Tasks', '/today'],
    ];
    for (const [label, group, expected] of cases) {
      const user = setup();
      await search(user);
      await user.click(within(screen.getByRole('group', { name: group })).getByText(label));
      await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(expected));
      expect(setPaletteOpen).toHaveBeenCalledWith(false);
      document.body.innerHTML = '';
    }
    const user = setup();
    await search(user);
    await user.click(within(screen.getByRole('group', { name: 'Notes' })).getByRole('option'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/pipeline?opportunity=opp_9'));
  });

  it('keeps hostile snippet and title text inert', async () => {
    payload = { ...payload, tasks: [{ id: 'tsk_h', title: HOSTILE, entityType: null, entityId: null, entityName: null }] };
    const user = setup();
    await search(user);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.palette b')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(screen.getAllByText(new RegExp(HOSTILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length).toBeGreaterThanOrEqual(2);
  });

  it('tolerates an older server answer without the new groups', async () => {
    payload = { people: [person], organizations: [], opportunities: [] };
    const user = setup();
    await user.type(screen.getByRole('combobox'), 'abc');
    await screen.findByRole('group', { name: 'People' });
    expect(screen.queryByRole('group', { name: 'Notes' })).toBeNull();
  });
});
