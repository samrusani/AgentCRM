// Adversarial probes for the sequences wave on the web: the Use a sequence select, Save as sequence, the 90 day ceiling
// line, the five step editor, and the Settings section. KILLS / CONFIRMS / ACCEPTED as in the server probes.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMailReadiness, useStageSend } from '../src/api/hooks';
import { PrepareToSend } from '../src/components/prepareSend';
import { SequencesSection } from '../src/screens/SequenceSettings';
import { Router } from './helpers';

vi.mock('../src/lib/ui', () => ({
  useUI: () => ({ setSelectedRecord: () => {}, pushToast: () => {}, toasts: [], dismissToast: () => {} }),
  useMediaQuery: () => false,
  NARROW_QUERY: '(max-width: 899px)',
}));
vi.mock('../src/api/events', () => ({ useServerEvents: () => {}, useEventConnection: () => 'open' }));
// Real sequence hooks over a stubbed fetch; only mail readiness and staging are faked.
vi.mock('../src/api/hooks', async (importActual) => ({
  ...(await importActual<typeof import('../src/api/hooks')>()),
  useMailReadiness: vi.fn(),
  useStageSend: vi.fn(),
}));

interface Saved {
  id: string;
  name: string;
  version: number;
  steps: Array<{ waitDays: number; body: string }>;
}
interface Call {
  method: string;
  path: string;
  body: any;
}

const mutate = vi.fn();
let calls: Call[];
let sequences: Saved[];
let failure: { status: number; code: string; message: string } | null;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const text = (n: number) => `Saved follow-up text number ${n}.`;
const hostile = '<img src=x onerror=alert(1)><b>bold</b>‮evil';
const steps = (waits: number[]) => waits.map((waitDays, index) => ({ waitDays, body: text(index + 1) }));

beforeEach(() => {
  mutate.mockReset();
  calls = [];
  failure = null;
  sequences = [];
  vi.mocked(useMailReadiness).mockReturnValue({ state: 'ready', inboxEmail: 'me@example.com', provider: 'gmail' });
  vi.mocked(useStageSend).mockReturnValue({ mutate, isPending: false, isError: false, isSuccess: false, data: undefined, error: null } as unknown as ReturnType<typeof useStageSend>);
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
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderWith(node: React.ReactNode) {
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Router>{node}</Router>
    </QueryClientProvider>,
  );
  return { user, ...view };
}
const prepare = () => renderWith(<PrepareToSend label="Prepare to send" input={{ draftActivityIds: ['d1'] }} />);
const prepareButton = () => screen.getByRole('button', { name: 'Prepare to send' });
const rows = () => screen.queryAllByLabelText(/^Exact text of follow-up \d$/);
const setDays = (index: number, value: string) => fireEvent.change(screen.getAllByLabelText('days after the last send')[index - 1]!, { target: { value } });

describe('Use a sequence', () => {
  it('KILLS: choosing a second sequence replaces the first (no merged or duplicated rows), and the request carries no sequence id', async () => {
    sequences = [
      { id: 'sqn-five', name: 'Five', version: 1, steps: steps([2, 2, 2, 2, 2]) },
      { id: 'sqn-one', name: 'One', version: 1, steps: [{ waitDays: 9, body: 'Only the single step text.' }] },
    ];
    const { user } = prepare();
    const select = await screen.findByLabelText('Use a sequence');
    await user.selectOptions(select, 'Five');
    expect(rows()).toHaveLength(5);
    expect(screen.getByText('Five follow-ups is the most one send can carry.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Use a sequence'), 'One');
    expect(rows()).toHaveLength(1);
    expect(screen.getByLabelText('Exact text of follow-up 1')).toHaveValue('Only the single step text.');
    await user.click(prepareButton());
    expect(mutate.mock.calls[0]?.[0]).toEqual({ draftActivityIds: ['d1'], followups: { steps: [{ waitDays: 9, body: 'Only the single step text.' }] } });
    expect(JSON.stringify(mutate.mock.calls[0]?.[0])).not.toMatch(/sqn|sequence/i);
  });

  it('KILLS: edits after copying are what is staged, for all five steps, and re-choosing the same sequence discards the edits', async () => {
    sequences = [{ id: 'sqn-five', name: 'Five', version: 1, steps: steps([2, 2, 2, 2, 2]) }];
    const { user } = prepare();
    await user.selectOptions(await screen.findByLabelText('Use a sequence'), 'Five');
    fireEvent.change(screen.getByLabelText('Exact text of follow-up 5'), { target: { value: 'Edited fifth step text here.' } });
    await user.click(prepareButton());
    expect(mutate.mock.calls[0]?.[0].followups.steps.map((step: { body: string }) => step.body)).toEqual([text(1), text(2), text(3), text(4), 'Edited fifth step text here.']);
    // ACCEPTED: choosing the same sequence again is a fresh copy and the edit is gone, the person asked for the preset.
    await user.selectOptions(screen.getByLabelText('Use a sequence'), 'Five');
    expect(screen.getByLabelText('Exact text of follow-up 5')).toHaveValue(text(5));
  });

  it('KILLS: hostile sequence names render as text in the select and the copied line, never as markup', async () => {
    sequences = [{ id: 'sqn-h', name: hostile, version: 1, steps: steps([2]) }];
    const { user, container } = prepare();
    await user.selectOptions(await screen.findByLabelText('Use a sequence'), 'sqn-h');
    expect(screen.getByText(new RegExp('Copied the steps from <img src=x'))).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  // The copied line shows only when steps actually landed in the editor, so a sequence whose steps read as zero (a
  // corrupt steps column reads as []) copies nothing and claims nothing.
  it('KILLS: an empty saved sequence copies nothing and never claims steps were copied', async () => {
    sequences = [{ id: 'sqn-empty', name: 'Empty', version: 1, steps: [] }];
    const { user } = prepare();
    await user.selectOptions(await screen.findByLabelText('Use a sequence'), 'Empty');
    expect(rows()).toHaveLength(0);
    expect(screen.queryByText(/Copied the steps from Empty/)).toBeNull();
    await user.click(prepareButton());
    expect(mutate.mock.calls[0]?.[0]).toEqual({ draftActivityIds: ['d1'] });
  });
});

describe('the ceiling line and the five step editor', () => {
  it('KILLS: with five steps 89 days enables submit and Save as sequence, 90 disables both', async () => {
    const { user } = prepare();
    for (let step = 1; step <= 5; step += 1) {
      await user.click(screen.getByRole('button', { name: 'Add a follow-up' }));
      fireEvent.change(screen.getByLabelText(`Exact text of follow-up ${step}`), { target: { value: text(step) } });
    }
    expect(screen.queryByRole('button', { name: 'Add a follow-up' })).not.toBeInTheDocument();
    for (const [wait, index] of [[18, 1], [18, 2], [18, 3], [18, 4], [17, 5]] as const) setDays(index, String(wait));
    expect(screen.queryByText(/The waits add up to/)).not.toBeInTheDocument();
    expect(prepareButton()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save as sequence' })).toBeEnabled();
    setDays(5, '18');
    expect(screen.getByText('The waits add up to 90 days; follow-ups stop after 90 days. Shorten a wait or remove a step.')).toBeInTheDocument();
    expect(prepareButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save as sequence' })).toBeDisabled();
    await user.click(prepareButton());
    expect(mutate).not.toHaveBeenCalled();
    // Removing a step brings the plan back under the line and re-opens the sixth slot.
    await user.click(screen.getByRole('button', { name: 'Remove follow-up 5' }));
    expect(prepareButton()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add a follow-up' })).toBeInTheDocument();
  });

  it('KILLS: a copied sequence whose waits already reach 90 days is held at the ceiling line and cannot be staged', async () => {
    // Defence in depth: the server never stores such a preset, but the editor must not trust the row either.
    sequences = [{ id: 'sqn-old', name: 'Old', version: 1, steps: steps([30, 30, 30]) }];
    const { user } = prepare();
    await user.selectOptions(await screen.findByLabelText('Use a sequence'), 'Old');
    expect(screen.getByText(/The waits add up to 90 days/)).toBeInTheDocument();
    expect(prepareButton()).toBeDisabled();
    await user.click(prepareButton());
    expect(mutate).not.toHaveBeenCalled();
  });

  it('KILLS: wait values the server would refuse (0, 31, 1.5, empty) keep staging disabled even when the total is small', async () => {
    const { user } = prepare();
    await user.click(screen.getByRole('button', { name: 'Add a follow-up' }));
    fireEvent.change(screen.getByLabelText('Exact text of follow-up 1'), { target: { value: text(1) } });
    for (const bad of ['0', '31', '1.5', '', '-3']) {
      setDays(1, bad);
      expect(prepareButton(), bad).toBeDisabled();
    }
    setDays(1, '30');
    expect(prepareButton()).toBeEnabled();
  });
});

describe('Save as sequence', () => {
  it('KILLS: saves the five edited steps trimmed under a trimmed name and refreshes the select; a server refusal keeps the sheet and says not saved', async () => {
    const { user } = prepare();
    for (let step = 1; step <= 5; step += 1) {
      await user.click(screen.getByRole('button', { name: 'Add a follow-up' }));
      fireEvent.change(screen.getByLabelText(`Exact text of follow-up ${step}`), { target: { value: `  ${text(step)}  ` } });
    }
    await user.click(screen.getByRole('button', { name: 'Save as sequence' }));
    const dialog = screen.getByRole('dialog');
    failure = { status: 400, code: 'validation', message: 'The name cannot contain control characters' };
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '\u0000bad' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save sequence' }));
    expect(await within(dialog).findByText(/The sequence was not saved\./)).toBeInTheDocument();
    failure = null;
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '  Good name ' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save sequence' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts.at(-1)!.body).toEqual({ name: 'Good name', steps: [5, 5, 5, 5, 5].map((waitDays, index) => ({ waitDays, body: text(index + 1) })) });
    expect(await screen.findByText('Saved as Good name.')).toBeInTheDocument();
    expect(await screen.findByLabelText('Use a sequence')).toBeInTheDocument();
    // Saving never stages anything.
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('Settings section', () => {
  it('KILLS: hostile names render as text in the row and the delete confirmation', async () => {
    sequences = [{ id: 'sqn-h', name: hostile, version: 1, steps: steps([2, 3]) }];
    const { user, container } = renderWith(<SequencesSection />);
    await screen.findByText(hostile, { selector: 'span' });
    await user.click(screen.getByRole('button', { name: `Delete ${hostile}` }));
    expect(screen.getByRole('alert')).toHaveTextContent(`Delete ${hostile}?`);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it('KILLS: the new sequence sheet stops at five steps and the name field is capped at 200', async () => {
    const { user } = renderWith(<SequencesSection />);
    await user.click(await screen.findByRole('button', { name: 'New sequence' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveAttribute('maxlength', '200');
    for (let step = 2; step <= 5; step += 1) await user.click(within(dialog).getByRole('button', { name: 'Add a follow-up' }));
    expect(within(dialog).queryByRole('button', { name: 'Add a follow-up' })).not.toBeInTheDocument();
    expect(within(dialog).getAllByLabelText(/^Exact text of follow-up \d$/)).toHaveLength(5);
  });

  it('KILLS: a version conflict on edit says nothing was saved and does not close the sheet', async () => {
    sequences = [{ id: 'sqn-1', name: 'Gentle', version: 1, steps: steps([2]) }];
    const { user } = renderWith(<SequencesSection />);
    await screen.findByText('Gentle');
    await user.click(screen.getByRole('button', { name: 'Rename Gentle' }));
    const dialog = screen.getByRole('dialog');
    failure = { status: 409, code: 'version_conflict', message: 'Changed elsewhere.' };
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Renamed' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/changed since you opened this sheet/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
