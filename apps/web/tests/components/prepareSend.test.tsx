import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { useCreateSequence, useMailReadiness, useSequences, useStageSend } from '../../src/api/hooks';
import type { StageSendInput } from '../../src/api/types';
import { PrepareToSend } from '../../src/components/prepareSend';
import { Router } from '../helpers';

vi.mock('../../src/api/hooks', () => ({
  useMailReadiness: vi.fn(),
  useStageSend: vi.fn(),
  useSequences: vi.fn(),
  useCreateSequence: vi.fn(),
  useMailProvider: vi.fn(),
  useMailProviderNamer: vi.fn(),
  useMailSummary: vi.fn(),
}));

const input: StageSendInput = { draftActivityIds: ['draft-1', 'draft-2'] };
const VALID_BODY = 'Just checking in on my note from last week.';

const mutate = vi.fn();
const createMutate = vi.fn();
let stage: Record<string, unknown>;
let saved: Array<{ id: string; name: string; version: number; steps: Array<{ waitDays: number; body: string }> }> = [];

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function setup(props: { label?: string } = {}) {
  vi.mocked(useMailReadiness).mockReturnValue({ state: 'ready', inboxEmail: 'me@example.com', provider: 'gmail' });
  vi.mocked(useStageSend).mockReturnValue(stage as unknown as ReturnType<typeof useStageSend>);
  vi.mocked(useSequences).mockReturnValue({ data: saved } as unknown as ReturnType<typeof useSequences>);
  vi.mocked(useCreateSequence).mockReturnValue({ mutate: createMutate, isPending: false, isError: false, error: null } as unknown as ReturnType<typeof useCreateSequence>);
  const user = userEvent.setup();
  render(
    <Router>
      <PrepareToSend label={props.label ?? 'Prepare to send'} input={input} />
      <Where />
    </Router>,
  );
  return user;
}

const prepareButton = () => screen.getByRole('button', { name: 'Prepare to send' });

async function addStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Add a follow-up' }));
}

function setBody(index: number, value: string) {
  fireEvent.change(screen.getByLabelText(`Exact text of follow-up ${index}`), { target: { value } });
}

function setDays(index: number, value: string) {
  fireEvent.change(screen.getAllByLabelText('days after the last send')[index - 1]!, { target: { value } });
}

beforeEach(() => {
  mutate.mockReset();
  createMutate.mockReset();
  saved = [];
  stage = { mutate, isPending: false, isError: false, isSuccess: false, data: undefined, error: null };
});

describe('PrepareToSend without follow-ups', () => {
  it('sends the request unchanged when no step was added', async () => {
    const user = setup();
    await user.click(prepareButton());
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual(input);
    expect(mutate.mock.calls[0]?.[0]).not.toHaveProperty('followups');
  });

  it('offers to add a follow-up and shows no step editor yet', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Add a follow-up' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Follow-ups' })).not.toBeInTheDocument();
  });

  it('keeps staging disabled when the connector is not ready', () => {
    vi.mocked(useMailReadiness).mockReturnValue({ state: 'blocked', message: 'No sending connector is in use.', settingsLink: true });
    vi.mocked(useStageSend).mockReturnValue(stage as unknown as ReturnType<typeof useStageSend>);
    vi.mocked(useSequences).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useSequences>);
    render(
      <Router>
        <PrepareToSend label="Prepare to send" input={input} />
      </Router>,
    );
    expect(prepareButton()).toBeDisabled();
    expect(screen.getByText(/No sending connector is in use/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Settings' })).toBeInTheDocument();
  });
});

describe('adding and removing steps', () => {
  it('adds a first step with the default wait of 5 days and an empty body', async () => {
    const user = setup();
    await addStep(user);
    expect(screen.getByLabelText('days after the last send')).toHaveValue(5);
    expect(screen.getByLabelText('Exact text of follow-up 1')).toHaveValue('');
  });

  // Contract: up to five follow-ups (docs/design.md, Follow-ups in prepare to send); the add action stops at five.
  it('keeps offering "Add a follow-up" up to five steps and then says five is the most', async () => {
    const user = setup();
    for (let step = 1; step <= 5; step += 1) {
      await addStep(user);
      expect(screen.getByLabelText(`Exact text of follow-up ${step}`)).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Add a follow-up' })).not.toBeInTheDocument();
    expect(screen.getByText('Five follow-ups is the most one send can carry.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Exact text of follow-up 6')).not.toBeInTheDocument();
  });

  it('removes a step and goes back to the plain request', async () => {
    const user = setup();
    await addStep(user);
    setBody(1, VALID_BODY);
    await user.click(screen.getByRole('button', { name: 'Remove follow-up 1' }));
    expect(screen.queryByLabelText('Exact text of follow-up 1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a follow-up' })).toBeInTheDocument();
    await user.click(prepareButton());
    expect(mutate.mock.calls[0]?.[0]).toEqual(input);
  });

  it('removing the invalid step re-enables staging', async () => {
    const user = setup();
    await addStep(user);
    expect(prepareButton()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Remove follow-up 1' }));
    expect(prepareButton()).toBeEnabled();
  });

  it('removing the first of two steps keeps the second one as follow-up 1', async () => {
    const user = setup();
    await addStep(user);
    await addStep(user);
    setBody(1, 'First follow-up text here');
    setBody(2, 'Second follow-up text here');
    await user.click(screen.getByRole('button', { name: 'Remove follow-up 1' }));
    expect(screen.getByLabelText('Exact text of follow-up 1')).toHaveValue('Second follow-up text here');
    await user.click(prepareButton());
    expect(mutate.mock.calls[0]?.[0].followups.steps).toEqual([{ waitDays: 5, body: 'Second follow-up text here' }]);
  });
});

describe('wait limits, 1 to 30 days', () => {
  const message = 'Enter a whole number of days from 1 to 30.';

  it.each(['0', '31', '-3', '2.5', ''])('rejects %j and blocks staging', async (value) => {
    const user = setup();
    await addStep(user);
    setBody(1, VALID_BODY);
    setDays(1, value);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(prepareButton()).toBeDisabled();
    await user.click(prepareButton());
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each(['1', '30'])('accepts the edge value %s', async (value) => {
    const user = setup();
    await addStep(user);
    setBody(1, VALID_BODY);
    setDays(1, value);
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(prepareButton()).toBeEnabled();
  });
});

describe('body limits, 10 to 2000 characters after trimming', () => {
  it('rejects 9 characters with the minimum message', async () => {
    const user = setup();
    await addStep(user);
    setBody(1, '123456789');
    expect(screen.getByText('Write at least 10 characters.')).toBeInTheDocument();
    expect(prepareButton()).toBeDisabled();
  });

  it('accepts exactly 10 characters', async () => {
    const user = setup();
    await addStep(user);
    setBody(1, '1234567890');
    expect(screen.queryByText('Write at least 10 characters.')).not.toBeInTheDocument();
    expect(prepareButton()).toBeEnabled();
  });

  it('counts after trimming, so padding cannot reach the minimum', async () => {
    const user = setup();
    await addStep(user);
    setBody(1, '      short      ');
    expect(screen.getByText('Write at least 10 characters.')).toBeInTheDocument();
    expect(prepareButton()).toBeDisabled();
  });

  it('accepts exactly 2000 characters', async () => {
    const user = setup();
    await addStep(user);
    setBody(1, 'a'.repeat(2000));
    expect(screen.queryByText(/Shorten this/)).not.toBeInTheDocument();
    expect(prepareButton()).toBeEnabled();
  });

  it('rejects 2001 characters with the maximum message', async () => {
    const user = setup();
    await addStep(user);
    setBody(1, 'a'.repeat(2001));
    expect(screen.getByText('Shorten this to 2,000 characters or fewer.')).toBeInTheDocument();
    expect(prepareButton()).toBeDisabled();
  });

  it('accepts 2000 characters of text with padding around it', async () => {
    const user = setup();
    await addStep(user);
    setBody(1, `   ${'a'.repeat(2000)}   `);
    expect(prepareButton()).toBeEnabled();
  });

  it('shows the live character count', async () => {
    const user = setup();
    await addStep(user);
    setBody(1, 'twelve chars');
    expect(screen.getByText('12 of 2,000 characters, at least 10')).toBeInTheDocument();
  });
});

describe('the staging request', () => {
  it('blocks staging while any one of the steps is invalid', async () => {
    const user = setup();
    await addStep(user);
    await addStep(user);
    setBody(1, VALID_BODY);
    expect(prepareButton()).toBeDisabled();
    setBody(2, VALID_BODY);
    expect(prepareButton()).toBeEnabled();
    setDays(2, '99');
    expect(prepareButton()).toBeDisabled();
  });

  it('includes a valid step with trimmed text and a numeric wait', async () => {
    const user = setup();
    await addStep(user);
    setDays(1, '7');
    setBody(1, `  ${VALID_BODY}  \n`);
    await user.click(prepareButton());
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      draftActivityIds: ['draft-1', 'draft-2'],
      followups: { steps: [{ waitDays: 7, body: VALID_BODY }] },
    });
  });

  it('includes both steps in order', async () => {
    const user = setup();
    await addStep(user);
    await addStep(user);
    setDays(1, '3');
    setBody(1, 'First follow-up text here');
    setDays(2, '10');
    setBody(2, 'Second follow-up text here');
    await user.click(prepareButton());
    expect(mutate.mock.calls[0]?.[0].followups).toEqual({
      steps: [
        { waitDays: 3, body: 'First follow-up text here' },
        { waitDays: 10, body: 'Second follow-up text here' },
      ],
    });
  });

  it('does not mutate the caller input', async () => {
    const user = setup();
    await addStep(user);
    setBody(1, VALID_BODY);
    await user.click(prepareButton());
    expect(input).not.toHaveProperty('followups');
  });

  it('goes to Today with the message count once an approval comes back', async () => {
    const user = setup();
    await user.click(prepareButton());
    const options = mutate.mock.calls[0]?.[1] as { onSuccess: (result: unknown) => void };
    act(() => {
      options.onSuccess({ approval: { payload: { messages: [{ to: 'a@example.com' }, { to: 'b@example.com' }] } }, excluded: [] });
    });
    expect(await screen.findByTestId('where')).toHaveTextContent('/today');
  });
});

describe('request states', () => {
  it('disables the controls while the request is running', () => {
    stage = { ...stage, isPending: true };
    setup();
    expect(screen.getByRole('button', { name: 'Preparing...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add a follow-up' })).toBeDisabled();
  });

  it('shows the error and says nothing was prepared', () => {
    stage = { ...stage, isError: true, error: new Error('The server said no.') };
    setup();
    expect(screen.getByRole('alert')).toHaveTextContent('The server said no. Nothing was prepared.');
  });

  it('explains when everyone was left out and lists why', () => {
    stage = {
      ...stage,
      isSuccess: true,
      data: { approval: null, excluded: [{ personName: 'Bo Example', toEmail: 'bo@example.com', reason: 'followup_armed' }] },
    };
    setup();
    expect(screen.getByText(/Everyone in this selection was left out/)).toBeInTheDocument();
    expect(screen.getByText('This person already has active follow-ups. Stop them to stage again.')).toBeInTheDocument();
  });
});

describe('the 90 day ceiling', () => {
  it('shows the total inline and disables submit when the waits reach 90 days', async () => {
    const user = setup();
    for (let step = 1; step <= 3; step += 1) {
      await addStep(user);
      setBody(step, VALID_BODY);
      setDays(step, '30');
    }
    expect(screen.getByText('The waits add up to 90 days; follow-ups stop after 90 days. Shorten a wait or remove a step.')).toBeInTheDocument();
    expect(prepareButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save as sequence' })).toBeDisabled();
    await user.click(prepareButton());
    expect(mutate).not.toHaveBeenCalled();
    setDays(3, '29');
    expect(screen.queryByText(/The waits add up to/)).not.toBeInTheDocument();
    expect(prepareButton()).toBeEnabled();
  });
});

describe('Use a sequence', () => {
  const nudges = {
    id: 'sqn_1',
    name: 'Gentle nudges',
    version: 1,
    steps: [
      { waitDays: 3, body: 'First saved follow-up text.' },
      { waitDays: 6, body: 'Second saved follow-up text.' },
    ],
  };

  it('shows no select until a sequence exists', () => {
    setup();
    expect(screen.queryByLabelText('Use a sequence')).not.toBeInTheDocument();
  });

  it('copies the steps into the editor, says so, keeps them editable, and stages the edited text', async () => {
    saved = [nudges];
    const user = setup();
    await user.selectOptions(screen.getByLabelText('Use a sequence'), 'Gentle nudges');
    expect(screen.getByLabelText('Exact text of follow-up 1')).toHaveValue('First saved follow-up text.');
    expect(screen.getByLabelText('Exact text of follow-up 2')).toHaveValue('Second saved follow-up text.');
    expect(screen.getAllByLabelText('days after the last send').map((field) => (field as HTMLInputElement).value)).toEqual(['3', '6']);
    expect(screen.getByText(/Copied the steps from Gentle nudges\. You can edit them freely/)).toBeInTheDocument();
    setBody(2, 'Edited second follow-up text.');
    await user.click(prepareButton());
    // The request carries the editor's text only, never the sequence id.
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      draftActivityIds: ['draft-1', 'draft-2'],
      followups: {
        steps: [
          { waitDays: 3, body: 'First saved follow-up text.' },
          { waitDays: 6, body: 'Edited second follow-up text.' },
        ],
      },
    });
  });

  it('replaces the steps that were already in the editor', async () => {
    saved = [nudges];
    const user = setup();
    await addStep(user);
    await addStep(user);
    await addStep(user);
    setBody(3, 'A third step that will go.');
    await user.selectOptions(screen.getByLabelText('Use a sequence'), 'Gentle nudges');
    expect(screen.queryByLabelText('Exact text of follow-up 3')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Exact text of follow-up 1')).toHaveValue('First saved follow-up text.');
  });
});

describe('Save as sequence', () => {
  it('is offered only once there is a step, and saves the editor under a name', async () => {
    const user = setup();
    expect(screen.queryByRole('button', { name: 'Save as sequence' })).not.toBeInTheDocument();
    await addStep(user);
    setDays(1, '4');
    setBody(1, `  ${VALID_BODY}  `);
    await user.click(screen.getByRole('button', { name: 'Save as sequence' }));
    const dialog = screen.getByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save sequence' });
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Name'), '  Quick check in ');
    await user.click(save);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({ name: 'Quick check in', steps: [{ waitDays: 4, body: VALID_BODY }] });
    act(() => {
      (createMutate.mock.calls[0]?.[1] as { onSuccess: () => void }).onSuccess();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Saved as Quick check in.')).toBeInTheDocument();
  });

  it('is disabled while a step is invalid', async () => {
    const user = setup();
    await addStep(user);
    expect(screen.getByRole('button', { name: 'Save as sequence' })).toBeDisabled();
  });
});
