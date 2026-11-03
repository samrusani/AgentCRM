import { render, screen, within } from '@testing-library/react';
import { useDecideApproval, useMailProvider, useMailProviderNamer, useMailSummary } from '../../src/api/hooks';
import type { Approval } from '../../src/api/types';
import { ApprovalCard } from '../../src/components/approvals';
import { SendReviewBody } from '../../src/components/sendReview';
import { mailProviderName, parseSendReviewPayload } from '../../src/lib/mail';
import { Router } from '../helpers';

vi.mock('../../src/api/hooks', () => ({
  useMailProvider: vi.fn(),
  useMailProviderNamer: vi.fn(),
  useMailSummary: vi.fn(),
  useDecideApproval: vi.fn(),
}));

const BODY_ONE = 'Hi Ada,\n\nFirst follow-up with  two spaces and a second paragraph.\nThanks, Sam';
const BODY_TWO = 'Last note: if now is a bad time, ignore this.';

function message(overrides: Record<string, unknown> = {}) {
  return {
    intentId: 'intent-1',
    personName: 'Ada Example',
    to: 'ada@example.com',
    subject: 'Quick intro',
    body: 'Hello Ada, this is the first message.',
    inboxEmail: 'me@example.com',
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    messages: [message()],
    excluded: [],
    followups: {
      steps: [
        { waitDays: 5, body: BODY_ONE },
        { waitDays: 1, body: BODY_TWO },
      ],
    },
    ...overrides,
  };
}

function mockHooks({ summary = null, inUse = null }: { summary?: unknown; inUse?: unknown } = {}) {
  vi.mocked(useMailProvider).mockReturnValue({ data: inUse } as unknown as ReturnType<typeof useMailProvider>);
  vi.mocked(useMailProviderNamer).mockReturnValue((kind) => mailProviderName(kind));
  vi.mocked(useMailSummary).mockReturnValue({ data: summary } as unknown as ReturnType<typeof useMailSummary>);
  vi.mocked(useDecideApproval).mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false } as unknown as ReturnType<typeof useDecideApproval>);
}

function renderBody(raw: unknown) {
  render(
    <Router>
      <SendReviewBody review={parseSendReviewPayload(raw)} />
    </Router>,
  );
}

function renderCard(raw: unknown, compact = false) {
  const approval: Approval = {
    id: 'approval-1',
    runId: null,
    kind: 'send_review',
    title: 'Send review',
    payload: raw,
    payloadHash: 'hash',
    status: 'pending',
    note: null,
    decidedAt: null,
    decidedBy: null,
    createdAt: '2026-11-03T10:00:00Z',
  };
  render(
    <Router>
      <ApprovalCard approval={approval} compact={compact} />
    </Router>,
  );
}

// Matches text exactly as written, so a changed newline or space fails the test.
const keepWhitespace = { normalizer: (text: string) => text };

beforeEach(() => mockHooks());

describe('SendReviewBody with follow-ups', () => {
  it('shows a Follow-ups block with a count of 2', () => {
    renderBody(payload());
    const block = screen.getByRole('region', { name: 'Follow-ups' });
    expect(within(block).getByRole('heading', { name: /Follow-ups\s*\(2\)/ })).toBeInTheDocument();
  });

  it('shows both follow-up bodies verbatim, newlines and spacing included', () => {
    renderBody(payload());
    const block = screen.getByRole('region', { name: 'Follow-ups' });
    expect(within(block).getByText(BODY_ONE, keepWhitespace)).toBeInTheDocument();
    expect(within(block).getByText(BODY_TWO, keepWhitespace)).toBeInTheDocument();
  });

  it('shows the full text of a very long step without cutting it', () => {
    const long = `${'word '.repeat(399)}end`;
    renderBody(payload({ followups: { steps: [{ waitDays: 2, body: long }] } }));
    expect(screen.getByText(long, keepWhitespace)).toBeInTheDocument();
  });

  it('numbers each step and states its wait', () => {
    renderBody(payload());
    expect(screen.getByText('Follow-up 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Follow-up 2 of 2')).toBeInTheDocument();
    expect(screen.getByText('5 days after the last send, weekends skipped')).toBeInTheDocument();
    expect(screen.getByText('1 day after the last send, weekends skipped')).toBeInTheDocument();
  });

  it('states when follow-ups stop and that every recipient gets the same text', () => {
    renderBody(payload());
    expect(screen.getByText(/Follow-ups stop on any reply, bounce, opt out, or suppression/)).toBeInTheDocument();
    expect(screen.getByText(/The same text goes to every recipient\./)).toBeInTheDocument();
  });

  it.each([
    ['gmail', 'Follow-ups continue the same email thread.'],
    ['imap', 'Follow-ups continue the same email thread.'],
    ['agentmail', 'Follow-ups go out as new messages whose subject starts with Re:.'],
    ['microsoft', 'Follow-ups go out as new messages whose subject starts with Re:.'],
  ])('thread sentence for a payload provider of %s', (provider, sentence) => {
    renderBody(payload({ provider }));
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  it('takes the thread sentence from the first message provider when the payload names none', () => {
    renderBody(payload({ messages: [message({ provider: 'microsoft' })] }));
    expect(screen.getByText('Follow-ups go out as new messages whose subject starts with Re:.')).toBeInTheDocument();
  });

  it('gives no thread sentence when no provider is known', () => {
    renderBody(payload());
    expect(screen.queryByText(/same email thread/)).not.toBeInTheDocument();
    expect(screen.queryByText(/subject starts with Re:/)).not.toBeInTheDocument();
  });
});

describe('SendReviewBody without follow-ups', () => {
  it.each([
    ['no followups key', { followups: undefined }],
    ['an empty step list', { followups: { steps: [] } }],
  ])('renders no Follow-ups block for %s', (_name, overrides) => {
    renderBody(payload(overrides));
    expect(screen.queryByRole('region', { name: 'Follow-ups' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Follow-ups stop on any reply/)).not.toBeInTheDocument();
    expect(screen.queryByText(/weekends skipped/)).not.toBeInTheDocument();
  });

  it('still shows the message in full and the fixed approval line', () => {
    renderBody(payload({ followups: undefined }));
    expect(screen.getByText('Hello Ada, this is the first message.')).toBeInTheDocument();
    expect(screen.getByText('Approving sends these exact messages. Nothing can be edited after approval.')).toBeInTheDocument();
  });
});

describe('SendReviewBody messages', () => {
  it('names the provider that owns the sending address', () => {
    renderBody(payload({ messages: [message({ provider: 'gmail' })] }));
    expect(screen.getByText(/with Gmail/)).toBeInTheDocument();
  });

  it('falls back to the provider in use only when it owns the same address', () => {
    mockHooks({ inUse: { kind: 'imap', address: 'me@example.com' } });
    renderBody(payload({ messages: [message()] }));
    expect(screen.getByText(/with IMAP and SMTP/)).toBeInTheDocument();
  });

  it('does not borrow the provider in use for a different address', () => {
    mockHooks({ inUse: { kind: 'imap', address: 'someone-else@example.com' } });
    renderBody(payload({ messages: [message()] }));
    expect(screen.queryByText(/with IMAP/)).not.toBeInTheDocument();
  });

  it('warns when a message is incomplete', () => {
    renderBody(payload({ messages: [message({ subject: null })] }));
    expect(screen.getByRole('alert')).toHaveTextContent('cannot be approved');
  });

  it('shows the daily cap from the summary when the payload has none', () => {
    mockHooks({ summary: { dailyCap: 50, remainingDailyCap: 31 } });
    renderBody(payload());
    expect(screen.getByText('Daily cap remaining').nextElementSibling).toHaveTextContent('31 of 50 today');
  });
});

describe('approve wording on the approval card', () => {
  it('says Send 2 messages and approve 2 follow-ups', () => {
    renderCard(payload({ messages: [message(), message({ intentId: 'intent-2', to: 'bo@example.com' })] }));
    expect(screen.getByRole('button', { name: /^Send 2 messages and approve 2 follow-ups/ })).toBeEnabled();
  });

  it('uses the singular for 1 message and 1 follow-up', () => {
    renderCard(payload({ followups: { steps: [{ waitDays: 5, body: BODY_ONE }] } }));
    expect(screen.getByRole('button', { name: /^Send 1 message and approve 1 follow-up:/ })).toBeInTheDocument();
  });

  it('mixes the plural and the singular correctly', () => {
    renderCard(payload({ messages: [message(), message({ intentId: 'intent-2' })], followups: { steps: [{ waitDays: 5, body: BODY_ONE }] } }));
    expect(screen.getByRole('button', { name: /^Send 2 messages and approve 1 follow-up:/ })).toBeInTheDocument();
  });

  it('does not mention follow-ups when the plan is absent', () => {
    renderCard(payload({ followups: undefined }));
    const button = screen.getByRole('button', { name: /^Send 1 message/ });
    expect(button).toHaveTextContent(/^Send 1 message$/);
  });

  it('disables approval when a message is incomplete', () => {
    renderCard(payload({ messages: [message({ body: null })] }));
    expect(screen.getByRole('button', { name: /^Send 1 message and approve 2 follow-ups/ })).toBeDisabled();
  });

  it('shows only a summary and no approve button on the compact surface', () => {
    renderCard(payload(), true);
    expect(screen.getByText(/1 message waiting to be sent/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Send / })).not.toBeInTheDocument();
    expect(screen.queryByText(BODY_ONE, keepWhitespace)).not.toBeInTheDocument();
  });
});
