import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { PersonSheet } from '../../src/screens/RecordSheets';
import { Today } from '../../src/screens/Today';
import { Router } from '../helpers';

vi.mock('../../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../../src/api/events', () => ({
  useServerEvents: () => {},
  useEventConnection: () => 'open',
}));

interface Call {
  method: string;
  path: string;
  body: any;
}

let calls: Call[];
let birthday: string | null;
let version: number;
let patchFailure: { status: number; message: string } | null;
let birthdays: unknown[];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const pad = (value: number) => String(value).padStart(2, '0');
// MM-DD for a day offset from the real today, so the row notes are checked against the real clock.
const monthDayIn = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

function personBody() {
  return {
    id: 'person-1',
    version,
    lifecycle: 'lead',
    firstName: 'Ada',
    lastName: 'Quinn',
    email: null,
    title: null,
    organizationId: null,
    organization: null,
    location: null,
    tags: [],
    birthday,
    nextActionAt: null,
    createdAt: '2026-10-01T10:00:00',
    updatedAt: '2026-11-01T10:00:00',
    claims: [],
    activities: [],
    tasks: [],
    opportunities: [],
  };
}

beforeEach(() => {
  calls = [];
  birthday = null;
  version = 1;
  patchFailure = null;
  birthdays = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === '/api/people/person-1' && method === 'PATCH') {
        if (patchFailure) return json(patchFailure.status, { error: { code: 'validation', message: patchFailure.message } });
        birthday = body.fields.birthday;
        version += 1;
        return json(200, personBody());
      }
      if (url.pathname === '/api/people/person-1') return json(200, personBody());
      if (url.pathname === '/api/today') return json(200, { tasksDue: [], approvalsPending: [], runsActive: [], counts: {}, birthdays });
      if (url.pathname === '/api/send-intents' || url.pathname === '/api/followup-rules') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/mail/summary') return json(200, { counts: {}, repliesNeedingAttention: { count: 0, items: [] } });
      if (url.pathname.endsWith('/enrichment')) return json(200, { run: null, suggestions: [] });
      if (url.pathname === '/api/activities') return json(200, { items: [], nextCursor: null });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: false } } });

function renderSheet() {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client()}>
      <Router>
        <PersonSheet id="person-1" onClose={() => {}} onOpenOrganization={() => {}} />
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

const birthdayRow = () => screen.getByText('Birthday', { selector: 'dt' }).closest('.field') as HTMLElement;

describe('Birthday row on the person sheet', () => {
  it('shows Not set when empty and sits right below Next action', async () => {
    renderSheet();
    await screen.findByText('Birthday', { selector: 'dt' });
    expect(within(birthdayRow()).getByText('Not set')).toBeInTheDocument();
    const labels = Array.from(document.querySelectorAll('dt')).map((dt) => dt.textContent);
    expect(labels.indexOf('Birthday')).toBe(labels.indexOf('Next action') + 1);
  });

  it('renders a full date readably with no note when it is far off', async () => {
    birthday = '1986-11-12';
    // Pick a date that cannot fall in the next seven days: 100 days away.
    const far = new Date();
    far.setDate(far.getDate() + 100);
    birthday = `1986-${pad(far.getMonth() + 1)}-${pad(far.getDate())}`;
    renderSheet();
    await screen.findByText('Birthday', { selector: 'dt' });
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    expect(within(birthdayRow()).getByText(`${far.getDate()} ${months[far.getMonth()]} 1986`)).toBeInTheDocument();
    expect(birthdayRow().textContent).not.toMatch(/today|in \d+ days?/);
  });

  it('renders a year-less date and adds "in N days" within seven days', async () => {
    birthday = monthDayIn(4);
    renderSheet();
    await screen.findByText('Birthday', { selector: 'dt' });
    expect(birthdayRow().textContent).toMatch(/^Birthday\d{1,2} [A-Z][a-z]{2} in 4 days/);
  });

  it('says today on the day', async () => {
    birthday = monthDayIn(0);
    renderSheet();
    await screen.findByText('Birthday', { selector: 'dt' });
    expect(within(birthdayRow()).getByText('today')).toBeInTheDocument();
  });

  it('edits and saves through the fields envelope', async () => {
    const { user } = renderSheet();
    await screen.findByText('Birthday', { selector: 'dt' });
    await user.click(within(birthdayRow()).getByRole('button', { name: 'Edit birthday' }));
    await user.type(screen.getByRole('textbox', { name: 'Birthday' }), '1986-11-12{Enter}');
    await waitFor(() => expect(within(birthdayRow()).getByText('12 Nov 1986')).toBeInTheDocument());
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.body).toEqual({ expectedVersion: 1, fields: { birthday: '1986-11-12' } });
  });

  it('clears with an empty value', async () => {
    birthday = '11-12';
    const { user } = renderSheet();
    await screen.findByText('Birthday', { selector: 'dt' });
    await user.click(within(birthdayRow()).getByRole('button', { name: 'Edit birthday' }));
    await user.clear(screen.getByRole('textbox', { name: 'Birthday' }));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(within(birthdayRow()).getByText('Not set')).toBeInTheDocument());
    expect(calls.find((call) => call.method === 'PATCH')!.body.fields).toEqual({ birthday: null });
  });

  it('shows the server refusal naming both forms and keeps the draft open', async () => {
    patchFailure = { status: 400, message: 'Birthday must be YYYY-MM-DD or MM-DD' };
    const { user } = renderSheet();
    await screen.findByText('Birthday', { selector: 'dt' });
    await user.click(within(birthdayRow()).getByRole('button', { name: 'Edit birthday' }));
    await user.type(screen.getByRole('textbox', { name: 'Birthday' }), 'soon{Enter}');
    expect(await within(birthdayRow()).findByText(/YYYY-MM-DD or MM-DD/)).toBeInTheDocument();
  });
});

describe('Birthdays card on Today', () => {
  function renderToday() {
    render(
      <QueryClientProvider client={client()}>
        <Router initialEntries={['/today']}>
          <Routes>
            <Route path="/today" element={<Today />} />
          </Routes>
        </Router>
      </QueryClientProvider>,
    );
  }

  it('says the empty sentence when nobody is due', async () => {
    renderToday();
    const card = (await screen.findByRole('heading', { name: 'Birthdays' })).closest('section') as HTMLElement;
    expect(within(card).getByText('No birthdays in the next seven days. Add birthdays on a person\'s sheet.')).toBeInTheDocument();
  });

  it('lists rows with both copy forms, soonest first, names linking to the person', async () => {
    birthdays = [
      { personId: 'person-1', name: 'Ada Quinn', date: '2026-11-12', turns: 40 },
      { personId: 'person-2', name: 'Bo Lin', date: '2026-11-14' },
    ];
    renderToday();
    const card = (await screen.findByRole('heading', { name: 'Birthdays' })).closest('section') as HTMLElement;
    const rows = within(card).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Ada Quinn');
    expect(rows[0]).toHaveTextContent('Turns 40 on 12 Nov');
    expect(rows[1]).toHaveTextContent('Bo Lin');
    expect(rows[1]).toHaveTextContent('Birthday on 14 Nov');
    expect(within(rows[0]!).getByRole('link', { name: 'Ada Quinn' })).toHaveAttribute('href', '/relationships?tab=people&person=person-1');
    expect(within(card).getByText('2')).toBeInTheDocument();
  });
});
