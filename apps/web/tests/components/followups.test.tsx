import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFollowupRules, useMailProviderNamer, useStopFollowupRule } from '../../src/api/hooks';
import type { FollowupRule } from '../../src/api/types';
import { Followups, PersonFollowupLine } from '../../src/components/followups';
import { mailProviderName } from '../../src/lib/mail';
import { Router } from '../helpers';

vi.mock('../../src/api/hooks', () => ({
  useFollowupRules: vi.fn(),
  useMailProviderNamer: vi.fn(),
  useStopFollowupRule: vi.fn(),
}));

function rule(overrides: Partial<FollowupRule> = {}): FollowupRule {
  return {
    id: 'rule-1',
    personId: 'person-1',
    personName: 'Ada Example',
    status: 'armed',
    steps: [
      { waitDays: 5, body: 'First nudge text' },
      { waitDays: 7, body: 'Second nudge text' },
    ],
    nextStep: 1,
    nextDueAt: '2026-11-10T12:00:00',
    stoppedReason: null,
    provider: 'gmail',
    anchorIntentId: 'intent-1',
    anchorSubject: 'Quick intro',
    lastIntentId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

const stopMutate = vi.fn();
let stopState: Record<string, unknown>;

function mockRules(data: FollowupRule[] | { isPending?: boolean; isError?: boolean; error?: unknown; refetch?: () => void }) {
  const value = Array.isArray(data) ? { isPending: false, isError: false, data } : { isPending: false, isError: false, refetch: vi.fn(), ...data };
  vi.mocked(useFollowupRules).mockReturnValue(value as unknown as ReturnType<typeof useFollowupRules>);
}

function renderFollowups() {
  const user = userEvent.setup();
  render(
    <Router>
      <Followups />
    </Router>,
  );
  return user;
}

beforeEach(() => {
  stopMutate.mockReset();
  stopState = { mutate: stopMutate, isPending: false, isError: false, error: null };
  vi.mocked(useStopFollowupRule).mockImplementation(() => stopState as unknown as ReturnType<typeof useStopFollowupRule>);
  vi.mocked(useMailProviderNamer).mockReturnValue((kind) => mailProviderName(kind));
});

describe('active rule status line', () => {
  it('says which follow-up is due and on what day when armed', () => {
    mockRules([rule({ status: 'armed', nextStep: 1, nextDueAt: '2026-11-10T12:00:00' })]);
    renderFollowups();
    expect(screen.getByText('Follow-up 1 of 2 due Tue 10 Nov')).toBeInTheDocument();
  });

  it('follows the next step number', () => {
    mockRules([rule({ nextStep: 2, nextDueAt: '2026-11-17T12:00:00' })]);
    renderFollowups();
    expect(screen.getByText('Follow-up 2 of 2 due Tue 17 Nov')).toBeInTheDocument();
  });

  it('says there is no due date yet when an armed rule has none', () => {
    mockRules([rule({ nextDueAt: null })]);
    renderFollowups();
    expect(screen.getByText('Follow-up 1 of 2, no due date yet')).toBeInTheDocument();
  });

  it('says it is waiting for the first send', () => {
    mockRules([rule({ status: 'waiting', nextDueAt: null })]);
    renderFollowups();
    expect(screen.getByText('Waiting for the first send')).toBeInTheDocument();
  });

  it('says the step is sending', () => {
    mockRules([rule({ status: 'sending' })]);
    renderFollowups();
    expect(screen.getByText('Follow-up 1 of 2 is sending')).toBeInTheDocument();
  });

  it('shows the person, the anchor subject, and the provider', () => {
    mockRules([rule()]);
    renderFollowups();
    expect(screen.getByRole('link', { name: 'Ada Example' })).toHaveAttribute('href', '/relationships?tab=people&person=person-1');
    expect(screen.getByText('After Quick intro')).toBeInTheDocument();
    expect(screen.getByText('via Gmail')).toBeInTheDocument();
  });

  it('names an unnamed person without a link when the id is missing', () => {
    mockRules([rule({ personName: null, personId: null })]);
    renderFollowups();
    expect(screen.getByText('Unnamed person')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('says none are active when only finished rules exist', () => {
    mockRules([rule({ status: 'done' })]);
    renderFollowups();
    expect(screen.getByText(/No follow-ups are active/)).toBeInTheDocument();
  });
});

describe('stop confirmation', () => {
  const openConfirm = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'Stop follow-ups to Ada Example' }));

  it('asks first and does not stop on the first click', async () => {
    mockRules([rule()]);
    const user = renderFollowups();
    await openConfirm(user);
    expect(screen.getByRole('alert')).toHaveTextContent('Stop follow-ups to this person? Nothing more will be sent.');
    expect(stopMutate).not.toHaveBeenCalled();
  });

  it('stops this rule when confirmed', async () => {
    mockRules([rule({ id: 'rule-42' })]);
    const user = renderFollowups();
    await openConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Stop follow-ups' }));
    expect(stopMutate).toHaveBeenCalledTimes(1);
    expect(stopMutate.mock.calls[0]?.[0]).toBe('rule-42');
  });

  it('does not stop on Keep them and returns to the Stop button', async () => {
    mockRules([rule()]);
    const user = renderFollowups();
    await openConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(stopMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stop follow-ups to Ada Example' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('closes the confirmation once the stop succeeds', async () => {
    mockRules([rule()]);
    const user = renderFollowups();
    await openConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Stop follow-ups' }));
    const options = stopMutate.mock.calls[0]?.[1] as { onSuccess: () => void };
    act(() => options.onSuccess());
    expect(screen.queryByRole('button', { name: 'Keep them' })).not.toBeInTheDocument();
  });

  it('disables both buttons and says Stopping while the stop is running', async () => {
    mockRules([rule()]);
    stopState = { ...stopState, isPending: true };
    const user = renderFollowups();
    await openConfirm(user);
    expect(screen.getByRole('button', { name: 'Stopping...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep them' })).toBeDisabled();
  });

  it('says the follow-ups were not changed when the stop fails', async () => {
    mockRules([rule()]);
    stopState = { ...stopState, isError: true, error: new Error('The server is busy.') };
    renderFollowups();
    expect(screen.getByText('The server is busy. The follow-ups were not changed.')).toBeInTheDocument();
  });

  it('asks about the right person when two rules are active', async () => {
    mockRules([rule({ id: 'a', personName: 'Ada Example' }), rule({ id: 'b', personName: 'Bo Example', personId: 'person-2' })]);
    const user = renderFollowups();
    await user.click(screen.getByRole('button', { name: 'Stop follow-ups to Bo Example' }));
    await user.click(screen.getByRole('button', { name: 'Stop follow-ups' }));
    expect(stopMutate.mock.calls[0]?.[0]).toBe('b');
  });
});

describe('history grouping', () => {
  const finished = [
    rule({ id: 'h1', status: 'stopped', stoppedReason: 'replied', personName: 'Replied One' }),
    rule({ id: 'h2', status: 'stopped', stoppedReason: 'replied', personName: 'Replied Two' }),
    rule({ id: 'h3', status: 'done', personName: 'Done One' }),
    rule({ id: 'h4', status: 'expired', stoppedReason: 'ceiling', personName: 'Ceiling One' }),
    rule({ id: 'h5', status: 'expired', stoppedReason: 'overdue', personName: 'Overdue One' }),
    rule({ id: 'h6', status: 'stopped', stoppedReason: 'stopped_by_user', personName: 'Manual One' }),
  ];

  it('groups finished rules under one label per outcome with a count', () => {
    mockRules(finished);
    renderFollowups();
    const replied = screen.getByRole('region', { name: 'Stopped, replied' });
    expect(within(replied).getByRole('heading')).toHaveTextContent('Stopped, replied 2');
    expect(within(replied).getByText('Replied One')).toBeInTheDocument();
    expect(within(replied).getByText('Replied Two')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Done, all sent' })).getByText('Done One')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Stopped, by you' })).getByText('Manual One')).toBeInTheDocument();
  });

  it('keeps ceiling and overdue expiries in separate groups with their own wording', () => {
    mockRules(finished);
    renderFollowups();
    const ceiling = screen.getByRole('region', { name: 'Expired, approved more than 90 days ago' });
    const overdue = screen.getByRole('region', { name: 'Expired, the computer was off past the send window' });
    expect(within(ceiling).getByText('Ceiling One')).toBeInTheDocument();
    expect(within(ceiling).queryByText('Overdue One')).not.toBeInTheDocument();
    expect(within(overdue).getByText('Overdue One')).toBeInTheDocument();
  });

  it('shows the history total in the summary', () => {
    mockRules(finished);
    renderFollowups();
    expect(screen.getByText('History').closest('summary')).toHaveTextContent('History 6');
  });

  it('leaves finished rules out of the active list and active rules out of history', () => {
    mockRules([rule({ id: 'live', personName: 'Live Person' }), ...finished]);
    renderFollowups();
    expect(screen.getAllByRole('button', { name: /^Stop follow-ups to / })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Stop follow-ups to Replied One' })).not.toBeInTheDocument();
  });

  it('shows no history when nothing has finished', () => {
    mockRules([rule()]);
    renderFollowups();
    expect(screen.queryByText('History')).not.toBeInTheDocument();
  });
});

describe('loading and error states', () => {
  it('says follow-ups are loading', () => {
    mockRules({ isPending: true });
    renderFollowups();
    expect(screen.getByText('Loading follow-ups')).toBeInTheDocument();
  });

  it('offers a retry on error', async () => {
    const refetch = vi.fn();
    mockRules({ isError: true, error: new Error('Network down.'), refetch });
    const user = renderFollowups();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });
});

describe('PersonFollowupLine', () => {
  function renderLine() {
    render(
      <Router>
        <PersonFollowupLine personId="person-1" />
      </Router>,
    );
  }

  it('shows the status line and a stop control for an active rule', () => {
    mockRules([rule()]);
    renderLine();
    expect(screen.getByText('Follow-up 1 of 2 due Tue 10 Nov')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop follow-ups to Ada Example' })).toBeInTheDocument();
  });

  it('shows only the newest finished outcome when none is active, with no stop control', () => {
    mockRules([rule({ id: 'n', status: 'stopped', stoppedReason: 'bounced' }), rule({ id: 'o', status: 'done' })]);
    renderLine();
    expect(screen.getByText('Stopped, bounced')).toBeInTheDocument();
    expect(screen.queryByText('Done, all sent')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing when the person has no rules', () => {
    mockRules([]);
    const { container } = render(
      <Router>
        <PersonFollowupLine personId="person-1" />
      </Router>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
