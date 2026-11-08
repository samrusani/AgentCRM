import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { Meetings } from '../../src/screens/Meetings';
import { MeetingSheet } from '../../src/screens/MeetingSheet';
import { Today } from '../../src/screens/Today';
import { TranscriptCaptureCard } from '../../src/screens/TranscriptCaptureCard';
import { fromLocalInput, nextHourInput, splitMeetings, toLocalInput, todayAndTomorrowBounds } from '../../src/lib/meetings';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));

const SENTENCE = 'This record was deleted, usually because it was merged into another record.';
const CONFIRM = 'Deletes this meeting and its attendee links. People and their records stay. This cannot be undone.';
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Calls {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function meeting(id: string, title: string, startOffset: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    version: 1,
    title,
    startsAt: iso(startOffset),
    endsAt: null,
    location: null,
    organizationId: null,
    organizationName: null,
    opportunityId: null,
    opportunityName: null,
    notes: null,
    attendeeCount: 0,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...extra,
  };
}

let meetings: ReturnType<typeof meeting>[];
let detail: (ReturnType<typeof meeting> & { attendees: { id: string; name: string }[] }) | null;
let detailStatus = 200;
let calls: Calls[];
let people: { id: string; firstName: string; lastName: string }[];

beforeEach(() => {
  meetings = [];
  detail = null;
  detailStatus = 200;
  calls = [];
  people = [{ id: 'per_1', firstName: 'Noor', lastName: 'Ellery' }];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, query: url.search, body });
      if (url.pathname === '/api/meetings' && method === 'GET') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        return json(200, {
          items: meetings.filter((m) => (!from || m.startsAt >= from) && (!to || m.startsAt < to)),
          nextCursor: null,
        });
      }
      if (url.pathname === '/api/meetings' && method === 'POST') {
        return json(201, { ...meeting('mtg_new', body.title, 0), startsAt: body.startsAt, attendees: [] });
      }
      const one = url.pathname.match(/^\/api\/meetings\/([^/]+)$/);
      if (one && method === 'GET') {
        return detailStatus === 200 && detail ? json(200, detail) : json(detailStatus, { error: { code: detailStatus === 404 ? 'not_found' : 'internal', message: 'No.' } });
      }
      if (one && method === 'PATCH' && detail) {
        detail = { ...detail, ...body.fields, version: detail.version + 1 };
        return json(200, detail);
      }
      if (one && method === 'DELETE') return new Response(null, { status: 204 });
      if (url.pathname.endsWith('/attendees') && method === 'POST' && detail) {
        const person = people.find((p) => p.id === body.personId)!;
        detail = { ...detail, attendees: [...detail.attendees, { id: person.id, name: `${person.firstName} ${person.lastName}` }], attendeeCount: detail.attendees.length + 1 };
        return json(200, detail);
      }
      const removal = url.pathname.match(/\/attendees\/([^/]+)$/);
      if (removal && method === 'DELETE' && detail) {
        detail = { ...detail, attendees: detail.attendees.filter((a) => a.id !== removal[1]), attendeeCount: detail.attendees.length - 1 };
        return json(200, detail);
      }
      if (url.pathname === '/api/search') return json(200, { people, organizations: [], opportunities: [] });
      if (url.pathname === '/api/model-provider') return json(200, { ready: true, kind: 'anthropic', model: 'm' });
      if (url.pathname === '/api/imports/transcript') return json(201, { id: 'run_1', kind: 'transcript_capture', title: body.title, status: 'queued', steps: [], counts: {}, scope: {} });
      return json(200, { items: [], nextCursor: null });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderWith(ui: React.ReactNode, entry = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[entry]}>{ui}</Router>
    </QueryClientProvider>,
  );
}

describe('meeting helpers', () => {
  it('round trips a local input value and rounds up to the next hour', () => {
    const stored = '2026-04-01T10:30:00.000Z';
    expect(fromLocalInput(toLocalInput(stored))).toBe(stored);
    expect(toLocalInput(null)).toBe('');
    expect(fromLocalInput('')).toBeNull();
    expect(nextHourInput(new Date(2026, 3, 1, 9, 20))).toBe('2026-04-01T10:00');
  });

  it('bounds today and tomorrow and splits upcoming from past', () => {
    const { from, to } = todayAndTomorrowBounds(new Date(2026, 3, 1, 15, 0));
    expect(new Date(from).getDate()).toBe(1);
    expect(new Date(to).getDate()).toBe(3);
    expect(new Date(from).getHours()).toBe(0);
    const now = Date.parse('2026-04-01T12:00:00.000Z');
    const all = [meeting('a', 'Past old', -48 * HOUR), meeting('b', 'Next', HOUR), meeting('c', 'Past new', -HOUR), meeting('d', 'Later', 5 * HOUR)];
    const split = splitMeetings(all.map((m) => ({ ...m, startsAt: new Date(now + (Date.parse(m.startsAt) - Date.now())).toISOString() })) as never, now);
    expect(split.upcoming.map((m) => m.id)).toEqual(['b', 'd']);
    expect(split.past.map((m) => m.id)).toEqual(['c', 'a']);
  });
});

describe('Meetings screen', () => {
  it('shows the exact empty state and the New meeting button when there are no meetings', async () => {
    renderWith(<Meetings />);
    expect(await screen.findByText('No meetings yet. Add one when you book a call.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New meeting' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Meetings', level: 1 })).toBeInTheDocument();
  });

  it('lists upcoming meetings soonest first with time, attendee count and organization, and hides past ones until asked', async () => {
    meetings = [
      meeting('mtg_a', 'Later call', 30 * HOUR, { attendeeCount: 2, organizationName: 'Quillan Labs' }),
      meeting('mtg_b', 'Sooner call', 2 * HOUR, { attendeeCount: 1 }),
      meeting('mtg_old', 'Old call', -48 * HOUR, { attendeeCount: 3 }),
      meeting('mtg_older', 'Older call', -96 * HOUR),
    ];
    const user = userEvent.setup();
    renderWith(<Meetings />);
    const upcoming = await screen.findByRole('region', { name: 'Upcoming meetings' });
    const rows = within(upcoming).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getByRole('button').textContent)).toEqual(['Sooner call', 'Later call']);
    expect(rows[0]!.textContent).toContain('1 attendee');
    expect(rows[1]!.textContent).toContain('2 attendees');
    expect(rows[1]!.textContent).toContain('Quillan Labs');
    expect(screen.queryByText('Old call')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show past' }));
    const past = await screen.findByRole('region', { name: /Past/ });
    expect(within(past).getAllByRole('listitem').map((row) => within(row).getByRole('button').textContent)).toEqual(['Old call', 'Older call']);
    expect(screen.getByRole('button', { name: 'Hide past' })).toBeInTheDocument();
  });

  it('says so when only past meetings exist and the toggle is off', async () => {
    meetings = [meeting('mtg_old', 'Old call', -48 * HOUR)];
    renderWith(<Meetings />);
    expect(await screen.findByText('Nothing is coming up. Show past to see held meetings.')).toBeInTheDocument();
    expect(screen.queryByText('No meetings yet. Add one when you book a call.')).not.toBeInTheDocument();
  });

  it('creates a meeting from the New meeting sheet and opens it', async () => {
    const user = userEvent.setup();
    renderWith(<Meetings />);
    await user.click(await screen.findByRole('button', { name: 'New meeting' }));
    const create = screen.getByRole('button', { name: 'Create meeting' });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText('Title'), 'Intro with Noor');
    expect(create).toBeEnabled();
    detail = { ...meeting('mtg_new', 'Intro with Noor', 0), attendees: [] };
    await user.click(create);
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path === '/api/meetings')).toBe(true));
    const post = calls.find((call) => call.method === 'POST' && call.path === '/api/meetings')!;
    expect(post.body).toMatchObject({ title: 'Intro with Noor', endsAt: null, location: null });
    expect(typeof (post.body as { startsAt: string }).startsAt).toBe('string');
    expect(await screen.findByRole('dialog', { name: 'Intro with Noor' })).toBeInTheDocument();
  });

  it('blocks Create when the end is not after the start', async () => {
    const user = userEvent.setup();
    renderWith(<Meetings />);
    await user.click(await screen.findByRole('button', { name: 'New meeting' }));
    await user.type(screen.getByLabelText('Title'), 'Backwards');
    const start = screen.getByLabelText('Starts') as HTMLInputElement;
    await user.clear(start);
    await user.type(start, '2026-04-01T10:00');
    await user.type(screen.getByLabelText('Ends (optional)'), '2026-04-01T09:00');
    expect(screen.getByRole('alert')).toHaveTextContent('The end must be after the start.');
    expect(screen.getByRole('button', { name: 'Create meeting' })).toBeDisabled();
  });
});

describe('Meeting sheet', () => {
  const base = () => ({ ...meeting('mtg_1', 'Intro call', 2 * HOUR, { notes: 'Old notes' }), attendees: [{ id: 'per_9', name: 'Tomas Reyes' }], attendeeCount: 1 });

  it('shows the fields, the attendees, and the notes with a count', async () => {
    detail = base();
    renderWith(<MeetingSheet id="mtg_1" onClose={() => {}} />);
    expect(await screen.findByLabelText('Title')).toHaveValue('Intro call');
    expect(screen.getByLabelText('Starts')).toHaveValue(toLocalInput(detail.startsAt));
    expect(screen.getByLabelText('Ends')).toHaveValue('');
    expect(screen.getByLabelText('Location')).toHaveValue('');
    expect(screen.getByRole('list', { name: 'Attendees' })).toHaveTextContent('Tomas Reyes');
    expect(screen.getByLabelText('Notes')).toHaveValue('Old notes');
    expect(screen.getByText('9 of 10,000 characters')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toHaveAttribute('maxlength', '10000');
    expect(screen.getByRole('button', { name: 'Capture transcript' })).toBeInTheDocument();
  });

  it('saves the notes only on the explicit Save and sends the version', async () => {
    detail = base();
    const user = userEvent.setup();
    renderWith(<MeetingSheet id="mtg_1" onClose={() => {}} />);
    const notes = await screen.findByLabelText('Notes');
    const save = screen.getByRole('button', { name: 'Save notes' });
    expect(save).toBeDisabled();
    await user.clear(notes);
    await user.type(notes, 'Agreed to send a deck');
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    await user.click(save);
    await waitFor(() => expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({ expectedVersion: 1, fields: { notes: 'Agreed to send a deck' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save notes' })).toBeDisabled());
  });

  it('saves only the changed detail fields', async () => {
    detail = base();
    const user = userEvent.setup();
    renderWith(<MeetingSheet id="mtg_1" onClose={() => {}} />);
    const title = await screen.findByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Renamed call');
    await user.type(screen.getByLabelText('Location'), 'Zoom');
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({ expectedVersion: 1, fields: { title: 'Renamed call', location: 'Zoom' } });
  });

  it('adds an attendee through the person picker and removes one with the chip button', async () => {
    detail = base();
    const user = userEvent.setup();
    renderWith(<MeetingSheet id="mtg_1" onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Add attendee' }));
    await user.type(screen.getByPlaceholderText('Search people'), 'Noor');
    await user.click(await screen.findByRole('option', { name: /Noor Ellery/ }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path === '/api/meetings/mtg_1/attendees')).toBe(true));
    expect(calls.find((call) => call.path.endsWith('/attendees'))!.body).toEqual({ personId: 'per_1' });
    expect(await screen.findByText('Noor Ellery')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove Tomas Reyes' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.path === '/api/meetings/mtg_1/attendees/per_9')).toBe(true));
    await waitFor(() => expect(screen.queryByText('Tomas Reyes')).not.toBeInTheDocument());
  });

  it('asks before deleting with the exact sentence, keeps on Keep meeting, and deletes on confirm', async () => {
    detail = base();
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWith(<MeetingSheet id="mtg_1" onClose={onClose} />);
    await user.click(await screen.findByRole('button', { name: 'Delete meeting' }));
    expect(screen.getByRole('alert')).toHaveTextContent(CONFIRM);
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Keep meeting' }));
    expect(screen.queryByText(CONFIRM, { exact: false })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete meeting' }));
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Delete meeting' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/api/meetings/mtg_1')).toBe(true);
  });

  it('shows the deleted sentence with Close and no retry when the meeting answers not found', async () => {
    detailStatus = 404;
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWith(<MeetingSheet id="mtg_gone" onClose={onClose} />);
    expect(await screen.findByText(SENTENCE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Retry for any other load error', async () => {
    detailStatus = 500;
    renderWith(<MeetingSheet id="mtg_1" onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(SENTENCE)).not.toBeInTheDocument();
  });

  it('opens the transcript capture prefilled with the meeting and sends its id', async () => {
    detail = base();
    const user = userEvent.setup();
    renderWith(
      <Routes>
        <Route path="/" element={<MeetingSheet id="mtg_1" onClose={() => {}} />} />
        <Route path="/research" element={<p>Research screen</p>} />
      </Routes>,
    );
    await user.click(await screen.findByRole('button', { name: 'Capture transcript' }));
    expect(screen.getByLabelText('Call name (optional)')).toHaveValue('Intro call');
    expect(screen.getByText(/The people you accept join this meeting as attendees\./)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Call transcript'), 'Noor: hello');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stage people for review' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Stage people for review' }));
    await waitFor(() => expect(calls.some((call) => call.path === '/api/imports/transcript')).toBe(true));
    expect(calls.find((call) => call.path === '/api/imports/transcript')!.body).toEqual({ transcriptText: 'Noor: hello', title: 'Intro call', meetingId: 'mtg_1' });
    expect(await screen.findByText('Research screen')).toBeInTheDocument();
  });

  it('the plain capture card sends no meetingId', async () => {
    const user = userEvent.setup();
    renderWith(<TranscriptCaptureCard onStarted={() => {}} />);
    await user.type(await screen.findByLabelText('Call transcript'), 'Noor: hello');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stage people for review' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Stage people for review' }));
    await waitFor(() => expect(calls.some((call) => call.path === '/api/imports/transcript')).toBe(true));
    expect(calls.find((call) => call.path === '/api/imports/transcript')!.body).toEqual({ transcriptText: 'Noor: hello' });
  });
});

describe('Today meetings card', () => {
  beforeEach(() => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/today') return json(200, { tasksDue: [], approvalsPending: [], runsActive: [], birthdays: [], counts: {} });
      return base(input, init);
    });
  });

  it('shows the exact empty sentence', async () => {
    renderWith(<Today />);
    const card = await screen.findByRole('region', { name: 'Meetings' });
    expect(await within(card).findByText('Nothing scheduled for today or tomorrow.')).toBeInTheDocument();
    const request = calls.find((call) => call.path === '/api/meetings')!;
    const params = new URLSearchParams(request.query);
    expect(Date.parse(params.get('to')!) - Date.parse(params.get('from')!)).toBeGreaterThanOrEqual(47 * HOUR);
  });

  it('lists today and tomorrow rows with time, title, attendee count, and the count beside the title', async () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const at = (days: number, hour: number) => new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() + days, hour, 0).toISOString();
    meetings = [
      { ...meeting('mtg_t', 'Standup with Noor', 0), startsAt: at(0, 9), attendeeCount: 2 },
      { ...meeting('mtg_n', 'Board prep', 0), startsAt: at(1, 14), attendeeCount: 1 },
      { ...meeting('mtg_x', 'Too far out', 0), startsAt: at(2, 10) },
    ];
    renderWith(<Today />);
    const card = await screen.findByRole('region', { name: 'Meetings' });
    const rows = await within(card).findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Standup with Noor');
    expect(rows[0]).toHaveTextContent('2 attendees');
    expect(rows[1]).toHaveTextContent('Tomorrow');
    expect(rows[1]).toHaveTextContent('Board prep');
    expect(within(card).getByRole('link', { name: 'Standup with Noor' })).toHaveAttribute('href', '/meetings?meeting=mtg_t');
    expect(card.querySelector('.today-card__count')).toHaveTextContent('2');
    expect(within(card).queryByText('Too far out')).not.toBeInTheDocument();
  });
});

describe('Meeting sheet unsaved edits', () => {
  it('keeps typed details when another save bumps the version', async () => {
    detail = { ...meeting('mtg_1', 'Intro call', 2 * HOUR), attendees: [], attendeeCount: 0 };
    const user = userEvent.setup();
    renderWith(<MeetingSheet id="mtg_1" onClose={() => {}} />);
    const title = await screen.findByLabelText('Title');
    await user.type(title, ' typed');
    await user.type(screen.getByLabelText('Notes'), 'New note');
    await user.click(screen.getByRole('button', { name: 'Save notes' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save notes' })).toBeDisabled());
    expect(screen.getByLabelText('Title')).toHaveValue('Intro call typed');
    expect(screen.getByLabelText('Notes')).toHaveValue('New note');
  });
});
