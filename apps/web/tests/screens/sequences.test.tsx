import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SequencesSection } from '../../src/screens/SequenceSettings';
import { followupCeilingProblem, sequenceSummary } from '../../src/lib/mail';
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

interface Saved {
  id: string;
  name: string;
  version: number;
  steps: Array<{ waitDays: number; body: string }>;
}

let calls: Call[];
let sequences: Saved[];
let failure: { status: number; code: string; message: string } | null;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const body = (n: number) => `Saved follow-up text number ${n}.`;

beforeEach(() => {
  calls = [];
  failure = null;
  sequences = [
    { id: 'sqn-1', name: 'Gentle nudges', version: 1, steps: [{ waitDays: 3, body: body(1) }, { waitDays: 4, body: body(2) }, { waitDays: 5, body: body(3) }] },
    { id: 'sqn-2', name: 'One and done', version: 1, steps: [{ waitDays: 1, body: body(4) }] },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body: payload });
      if (url.pathname === '/api/sequences' && method === 'GET') return json(200, { items: sequences, nextCursor: null });
      if (method !== 'GET' && failure) return json(failure.status, { error: { code: failure.code, message: failure.message } });
      if (url.pathname === '/api/sequences' && method === 'POST') {
        const created = { id: 'sqn-new', version: 1, name: payload.name, steps: payload.steps };
        sequences = [created, ...sequences];
        return json(201, created);
      }
      const match = /^\/api\/sequences\/([^/]+)$/.exec(url.pathname);
      if (match && method === 'PATCH') {
        const target = sequences.find((entry) => entry.id === match[1])!;
        Object.assign(target, payload.fields, { version: target.version + 1 });
        return json(200, target);
      }
      if (match && method === 'DELETE') {
        sequences = sequences.filter((entry) => entry.id !== match[1]);
        return new Response(null, { status: 204 });
      }
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSection() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router>
        <SequencesSection />
      </Router>
    </QueryClientProvider>,
  );
  return { user };
}

const writes = () => calls.filter((call) => call.method !== 'GET');
const rowOf = (name: string) => screen.getByText(name, { selector: 'span' }).closest('li') as HTMLElement;

describe('summary copy', () => {
  it('words the step count and total wait', () => {
    expect(sequenceSummary([{ waitDays: 3 }, { waitDays: 4 }, { waitDays: 5 }])).toBe('3 steps over 12 days');
    expect(sequenceSummary([{ waitDays: 1 }])).toBe('1 step over 1 day');
  });

  it('names the total and the ceiling once the waits reach 90 days', () => {
    expect(followupCeilingProblem([30, 30, 29])).toBeNull();
    expect(followupCeilingProblem([30, 30, 30])).toBe('The waits add up to 90 days; follow-ups stop after 90 days. Shorten a wait or remove a step.');
  });
});

describe('the Follow-up sequences section', () => {
  it('lists each sequence with its step summary', async () => {
    renderSection();
    expect(screen.getByRole('heading', { name: 'Follow-up sequences' })).toBeInTheDocument();
    await screen.findByText('Gentle nudges');
    expect(within(rowOf('Gentle nudges')).getByText('3 steps over 12 days')).toBeInTheDocument();
    expect(within(rowOf('One and done')).getByText('1 step over 1 day')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    sequences = [];
    renderSection();
    expect(await screen.findByText('No sequences yet.')).toBeInTheDocument();
  });

  it('renames with the opened version and only the name', async () => {
    const { user } = renderSection();
    await screen.findByText('Gentle nudges');
    await user.click(within(rowOf('Gentle nudges')).getByRole('button', { name: 'Rename Gentle nudges' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Exact text of follow-up 1')).not.toBeInTheDocument();
    const field = within(dialog).getByLabelText('Name');
    await user.clear(field);
    await user.type(field, '  Softer nudges ');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'PATCH', path: '/api/sequences/sqn-1', body: { expectedVersion: 1, fields: { name: 'Softer nudges' } } });
    await screen.findByText('Softer nudges');
  });

  it('edits steps in the shared editor, up to five, and sends only the steps', async () => {
    const { user } = renderSection();
    await screen.findByText('One and done');
    await user.click(within(rowOf('One and done')).getByRole('button', { name: 'Edit steps of One and done' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Name')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Exact text of follow-up 1')).toHaveValue(body(4));
    for (let step = 2; step <= 5; step += 1) {
      await user.click(within(dialog).getByRole('button', { name: 'Add a follow-up' }));
      fireEvent.change(within(dialog).getByLabelText(`Exact text of follow-up ${step}`), { target: { value: body(step + 10) } });
    }
    expect(within(dialog).queryByRole('button', { name: 'Add a follow-up' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const sent = writes()[0]!;
    expect(sent.body.fields).not.toHaveProperty('name');
    expect(sent.body.fields.steps).toHaveLength(5);
    expect(sent.body.fields.steps[1]).toEqual({ waitDays: 5, body: body(12) });
  });

  it('blocks saving steps that pass the 90 day ceiling', async () => {
    const { user } = renderSection();
    await screen.findByText('One and done');
    await user.click(within(rowOf('One and done')).getByRole('button', { name: 'Edit steps of One and done' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('days after the last send'), { target: { value: '30' } });
    for (let step = 2; step <= 3; step += 1) {
      await user.click(within(dialog).getByRole('button', { name: 'Add a follow-up' }));
      fireEvent.change(within(dialog).getByLabelText(`Exact text of follow-up ${step}`), { target: { value: body(step) } });
      fireEvent.change(within(dialog).getAllByLabelText('days after the last send')[step - 1]!, { target: { value: '30' } });
    }
    expect(within(dialog).getByText(/The waits add up to 90 days; follow-ups stop after 90 days\./)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(writes()).toHaveLength(0);
  });

  it('creates a new sequence with a name and one blank step to fill', async () => {
    const { user } = renderSection();
    await screen.findByText('Gentle nudges');
    await user.click(screen.getByRole('button', { name: 'New sequence' }));
    const dialog = screen.getByRole('dialog');
    const create = within(dialog).getByRole('button', { name: 'Create sequence' });
    expect(create).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Name'), 'Fresh');
    fireEvent.change(within(dialog).getByLabelText('Exact text of follow-up 1'), { target: { value: body(9) } });
    await user.click(create);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'POST', path: '/api/sequences', body: { name: 'Fresh', steps: [{ waitDays: 5, body: body(9) }] } });
    await screen.findByText('Fresh');
  });

  it('asks before deleting, says sends and rules are untouched, and keeps on cancel', async () => {
    const { user } = renderSection();
    await screen.findByText('Gentle nudges');
    await user.click(within(rowOf('Gentle nudges')).getByRole('button', { name: 'Delete Gentle nudges' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Sends you have already prepared and follow-ups that are running are not changed.');
    await user.click(screen.getByRole('button', { name: 'Keep sequence' }));
    expect(writes()).toHaveLength(0);
    await user.click(within(rowOf('Gentle nudges')).getByRole('button', { name: 'Delete Gentle nudges' }));
    await user.click(screen.getByRole('button', { name: 'Delete sequence' }));
    await waitFor(() => expect(screen.queryByText('Gentle nudges')).not.toBeInTheDocument());
    expect(writes()).toEqual([{ method: 'DELETE', path: '/api/sequences/sqn-1', body: undefined }]);
  });

  it('shows the refusal and keeps the sheet open when the server says no', async () => {
    const { user } = renderSection();
    await screen.findByText('Gentle nudges');
    failure = { status: 400, code: 'validation', message: 'The name cannot contain control characters.' };
    await user.click(within(rowOf('Gentle nudges')).getByRole('button', { name: 'Rename Gentle nudges' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/The name cannot contain control characters\. The sequence was not saved\./)).toBeInTheDocument();
  });
});
