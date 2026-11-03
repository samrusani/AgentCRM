import type { FollowupRule } from '../../src/api/types';
import {
  followupOutcomeLabel,
  followupProgress,
  followupStatusLine,
  followupThreadSentence,
  followupWaitPhrase,
  isFollowupActive,
  isMessageComplete,
  mailProviderName,
  messageCountLabel,
  parseSendReviewPayload,
  reasonSentence,
} from '../../src/lib/mail';

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
    anchorSubject: 'Intro',
    lastIntentId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

const message = {
  intentId: 'i-1',
  personName: 'Ada Example',
  to: 'ada@example.com',
  subject: 'Hello',
  body: 'Body text',
  inboxEmail: 'me@example.com',
  provider: 'gmail',
};

describe('parseSendReviewPayload', () => {
  it('reads the follow-up plan when the payload has one', () => {
    const parsed = parseSendReviewPayload({
      messages: [message],
      followups: {
        steps: [
          { waitDays: 5, body: 'First' },
          { wait_days: 9, body: 'Second' },
        ],
      },
    });
    expect(parsed.followups).toEqual({
      steps: [
        { waitDays: 5, body: 'First' },
        { waitDays: 9, body: 'Second' },
      ],
    });
  });

  it('leaves followups null when the payload has none', () => {
    expect(parseSendReviewPayload({ messages: [message] }).followups).toBeNull();
  });

  it('treats a plan with an empty step list as absent', () => {
    expect(parseSendReviewPayload({ messages: [message], followups: { steps: [] } }).followups).toBeNull();
  });

  it('treats a plan that is not an object as absent', () => {
    expect(parseSendReviewPayload({ messages: [message], followups: 'soon' }).followups).toBeNull();
    expect(parseSendReviewPayload({ messages: [message], followups: [1, 2] }).followups).toBeNull();
  });

  it('keeps a step with an unreadable wait as zero days and a missing body as empty text', () => {
    const parsed = parseSendReviewPayload({ followups: { steps: [{ waitDays: 'soon' }] } });
    expect(parsed.followups).toEqual({ steps: [{ waitDays: 0, body: '' }] });
  });

  it('floors a fractional wait', () => {
    const parsed = parseSendReviewPayload({ followups: { steps: [{ waitDays: 4.9, body: 'x' }] } });
    expect(parsed.followups?.steps[0]?.waitDays).toBe(4);
  });

  it('reads a payload that arrives as a JSON string', () => {
    const parsed = parseSendReviewPayload(JSON.stringify({ messages: [message], followups: { steps: [{ waitDays: 3, body: 'Hi' }] } }));
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.followups?.steps).toHaveLength(1);
  });

  it('reads messages from the intents key', () => {
    const parsed = parseSendReviewPayload({ intents: [{ id: 'x', toEmail: 'b@example.com', subject: 'S', text: 'T', from: 'me@example.com' }] });
    expect(parsed.messages[0]).toMatchObject({ intentId: 'x', to: 'b@example.com', subject: 'S', body: 'T', inboxEmail: 'me@example.com' });
  });

  describe('mailProvider', () => {
    it('uses the top level provider when present', () => {
      const parsed = parseSendReviewPayload({ provider: 'imap', messages: [{ ...message, provider: 'gmail' }] });
      expect(parsed.mailProvider).toBe('imap');
    });

    it('falls back to the first message that names a provider', () => {
      const parsed = parseSendReviewPayload({
        messages: [{ ...message, provider: null }, { ...message, provider: 'microsoft' }, { ...message, provider: 'gmail' }],
      });
      expect(parsed.mailProvider).toBe('microsoft');
    });

    it('is null when nothing names a provider', () => {
      const parsed = parseSendReviewPayload({ messages: [{ ...message, provider: undefined }] });
      expect(parsed.mailProvider).toBeNull();
    });

    it('lets a message inherit the top level provider and inbox', () => {
      const parsed = parseSendReviewPayload({ mailProvider: 'agentmail', inboxEmail: 'top@example.com', messages: [{ to: 'a@example.com' }] });
      expect(parsed.messages[0]?.provider).toBe('agentmail');
      expect(parsed.messages[0]?.inboxEmail).toBe('top@example.com');
    });
  });

  describe('malformed input never throws', () => {
    const inputs: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['a number', 42],
      ['an array', [1, 2, 3]],
      ['broken JSON text', '{not json'],
      ['an empty string', ''],
      ['messages that are not an array', { messages: 'nope', excluded: 7, followups: 9 }],
      ['entries that are not objects', { messages: [null, 3, 'x', []], excluded: [null, 5] }],
      ['steps that are not objects', { followups: { steps: [null, 4, 'x'] } }],
    ];
    it.each(inputs)('returns a usable payload for %s', (_name, input) => {
      const parsed = parseSendReviewPayload(input);
      expect(Array.isArray(parsed.messages)).toBe(true);
      expect(Array.isArray(parsed.excluded)).toBe(true);
    });

    it('returns empty lists and null fields for an empty payload', () => {
      expect(parseSendReviewPayload(null)).toEqual({
        messages: [],
        excluded: [],
        remainingDailyCap: null,
        mailProvider: null,
        followups: null,
      });
    });

    it('turns non-object message entries into incomplete messages', () => {
      const parsed = parseSendReviewPayload({ messages: [null, 3] });
      expect(parsed.messages).toHaveLength(2);
      expect(parsed.messages.every((entry) => !isMessageComplete(entry))).toBe(true);
    });
  });

  it('reads the remaining daily cap and drops negative or unreadable values', () => {
    expect(parseSendReviewPayload({ remainingDailyCap: 12 }).remainingDailyCap).toBe(12);
    expect(parseSendReviewPayload({ remainingDailyCap: '7' }).remainingDailyCap).toBe(7);
    expect(parseSendReviewPayload({ remainingDailyCap: -1 }).remainingDailyCap).toBeNull();
    expect(parseSendReviewPayload({ remainingDailyCap: 'many' }).remainingDailyCap).toBeNull();
  });

  it('reads the people left out', () => {
    const parsed = parseSendReviewPayload({ excluded: [{ name: 'Bo', email: 'bo@example.com', code: 'suppressed' }] });
    expect(parsed.excluded).toEqual([{ personName: 'Bo', toEmail: 'bo@example.com', reason: 'suppressed' }]);
  });
});

describe('followupWaitPhrase', () => {
  it('uses the plural for several days', () => {
    expect(followupWaitPhrase(5)).toBe('5 days after the last send, weekends skipped');
  });

  it('uses the singular for one day', () => {
    expect(followupWaitPhrase(1)).toBe('1 day after the last send, weekends skipped');
  });

  it('uses the plural for 30 days', () => {
    expect(followupWaitPhrase(30)).toBe('30 days after the last send, weekends skipped');
  });
});

describe('followupThreadSentence', () => {
  it.each(['gmail', 'imap'])('says follow-ups continue the thread for %s', (provider) => {
    expect(followupThreadSentence(provider)).toBe('Follow-ups continue the same email thread.');
  });

  it.each(['agentmail', 'microsoft'])('says follow-ups are new Re: messages for %s', (provider) => {
    expect(followupThreadSentence(provider)).toBe('Follow-ups go out as new messages whose subject starts with Re:.');
  });

  it('says nothing for an unknown or missing provider', () => {
    expect(followupThreadSentence('carrier-pigeon')).toBeNull();
    expect(followupThreadSentence(null)).toBeNull();
    expect(followupThreadSentence(undefined)).toBeNull();
  });
});

describe('followupOutcomeLabel', () => {
  it('says done when all steps were sent', () => {
    expect(followupOutcomeLabel(rule({ status: 'done' }))).toBe('Done, all sent');
  });

  it('says the approval is over 90 days old when the ceiling expired it', () => {
    expect(followupOutcomeLabel(rule({ status: 'expired', stoppedReason: 'ceiling' }))).toBe(
      'Expired, approved more than 90 days ago',
    );
  });

  it('says the computer was off when an overdue step expired it', () => {
    expect(followupOutcomeLabel(rule({ status: 'expired', stoppedReason: 'overdue' }))).toBe(
      'Expired, the computer was off past the send window',
    );
  });

  it('does not blame the 90 day ceiling when an expired rule has no reason', () => {
    expect(followupOutcomeLabel(rule({ status: 'expired', stoppedReason: null }))).toBe(
      'Expired, the computer was off past the send window',
    );
  });

  it.each([
    ['replied', 'Stopped, replied'],
    ['bounced', 'Stopped, bounced'],
    ['suppressed', 'Stopped, opted out or suppressed'],
    ['stopped_by_user', 'Stopped, by you'],
    ['connector_changed', 'Stopped, connector changed'],
    ['not_sent', 'Stopped, the first message was not sent'],
    ['step_not_sent', 'Stopped, a follow-up could not be sent'],
  ])('labels a stopped rule with reason %s', (stoppedReason, label) => {
    expect(followupOutcomeLabel(rule({ status: 'stopped', stoppedReason }))).toBe(label);
  });

  it('falls back to plain Stopped for an unknown or missing reason', () => {
    expect(followupOutcomeLabel(rule({ status: 'stopped', stoppedReason: 'mystery' }))).toBe('Stopped');
    expect(followupOutcomeLabel(rule({ status: 'stopped', stoppedReason: null }))).toBe('Stopped');
  });
});

describe('followupStatusLine and progress', () => {
  it('says armed with the due day', () => {
    expect(followupStatusLine(rule({ status: 'armed', nextStep: 1 }))).toBe('Follow-up 1 of 2 due Tue 10 Nov');
  });

  it('says armed with no due date yet when the date is missing', () => {
    expect(followupStatusLine(rule({ nextDueAt: null }))).toBe('Follow-up 1 of 2, no due date yet');
  });

  it('says waiting for the first send', () => {
    expect(followupStatusLine(rule({ status: 'waiting' }))).toBe('Waiting for the first send');
  });

  it('says the step is sending', () => {
    expect(followupStatusLine(rule({ status: 'sending', nextStep: 2 }))).toBe('Follow-up 2 of 2 is sending');
  });

  it('keeps the step inside the plan length', () => {
    expect(followupProgress(9, 2)).toBe('Follow-up 2 of 2');
    expect(followupProgress(0, 2)).toBe('Follow-up 1 of 2');
  });

  it('has a bare label for an empty plan', () => {
    expect(followupProgress(1, 0)).toBe('Follow-up');
  });

  it('treats waiting, armed, and sending as active', () => {
    expect(['waiting', 'armed', 'sending'].every((status) => isFollowupActive({ status }))).toBe(true);
    expect(['done', 'stopped', 'expired'].some((status) => isFollowupActive({ status }))).toBe(false);
  });
});

describe('reasonSentence', () => {
  it('explains followup_armed', () => {
    expect(reasonSentence('followup_armed')).toBe('This person already has active follow-ups. Stop them to stage again.');
  });

  it('explains followup_stopped', () => {
    expect(reasonSentence('followup_stopped')).toBe('Follow-ups to this person were stopped after this message was staged.');
  });

  it('accepts a code with different case, spaces, or dashes', () => {
    expect(reasonSentence('Followup-Armed')).toBe(reasonSentence('followup_armed'));
  });

  it('speaks an unknown code as a sentence', () => {
    expect(reasonSentence('some_new_code')).toBe('Some new code.');
  });

  it('shows a server sentence as sent', () => {
    expect(reasonSentence('Mailbox is full, try later')).toBe('Mailbox is full, try later');
  });

  it('says no reason was given for empty or missing input', () => {
    expect(reasonSentence('   ')).toBe('No reason was given.');
    expect(reasonSentence(null)).toBe('No reason was given.');
  });
});

describe('small mail helpers', () => {
  it('counts messages with the right noun', () => {
    expect(messageCountLabel(1)).toBe('1 message');
    expect(messageCountLabel(0)).toBe('0 messages');
    expect(messageCountLabel(2)).toBe('2 messages');
  });

  it('names providers and the IMAP preset', () => {
    expect(mailProviderName('gmail')).toBe('Gmail');
    expect(mailProviderName('imap', 'icloud')).toBe('iCloud Mail');
    expect(mailProviderName('imap', 'unknown-preset')).toBe('IMAP and SMTP');
    expect(mailProviderName(null)).toBe('the mail provider');
  });
});
