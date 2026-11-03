// Pure rules for addresses and message text. Nothing here touches the database or the network.

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const addressPattern = /^[^\s@<>(),;:"\\[\]]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

// One plain address. Display names, lists, and international domains are not accepted.
export function isValidEmail(email: string): boolean {
  return email.length <= 254 && addressPattern.test(email);
}

// Reads "Name <addr@host>" or a bare address. Returns the normalized address, or null when there is none.
export function parseAddress(raw: string): string | null {
  const angle = /<([^<>]+)>/.exec(raw);
  const candidate = normalizeEmail(angle ? angle[1]! : raw);
  return isValidEmail(candidate) ? candidate : null;
}

export const demoDomains = ['example.com', 'example.org', 'example.net'] as const;

// Synthetic data uses these domains, so mail to them is never sent. Subdomains count; look alikes such as
// "notexample.com" do not.
export function isDemoAddress(email: string): boolean {
  const domain = normalizeEmail(email).split('@').pop()?.replace(/\.$/, '') ?? '';
  return demoDomains.some((demo) => domain === demo || domain.endsWith(`.${demo}`));
}

const optOutPattern = /\b(unsubscribe|stop|opt[\s-]+out|remove\s+me)\b/i;

// Quoted history and the "On ... wrote:" tail are not the sender's new words, so they are left out.
function newWordsOf(value: string): string {
  const kept: string[] = [];
  for (const line of value.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*on .{5,200} wrote:\s*$/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

// Returns the wording that matched, as the sender wrote it, or null.
export function findOptOutWording(value: string): string | null {
  const match = optOutPattern.exec(newWordsOf(value));
  return match ? match[0].replace(/\s+/g, ' ') : null;
}

export const subjectMaxLength = 300;
export const bodyMaxLength = 20_000;
const factsMarker = '\n\nFacts the model says it used:';

// Draft activities store "Subject: ..." followed by a blank line and the body. Model drafts end with a facts list.
export function parseDraftActivity(activityBody: string): { subject: string; body: string } | null {
  const lines = activityBody.replace(/\r\n/g, '\n').split('\n');
  const subjectIndex = lines.findIndex((line) => line.startsWith('Subject:'));
  if (subjectIndex < 0) return null;
  const subject = lines[subjectIndex]!.slice('Subject:'.length).trim();
  let rest = lines.slice(subjectIndex + 1).join('\n');
  rest = rest.replace(/^\n/, '');
  const markerIndex = rest.lastIndexOf(factsMarker);
  if (markerIndex >= 0) rest = rest.slice(0, markerIndex);
  const body = rest.trim();
  if (subject === '' || body === '') return null;
  return { subject, body };
}

// Task titles are built here so the code that creates a task and the code that reports it use the same words.
const taskTitleMaxLength = 300;

function clip(value: string): string {
  return value.length > taskTitleMaxLength ? `${value.slice(0, taskTitleMaxLength - 3)}...` : value;
}

export const replyTaskTitle = (personName: string): string => clip(`Reply received from ${personName}`);
export const optOutTaskTitle = (who: string, wording: string): string => clip(`Review opt out from ${who}: matched "${wording}"`);
export const bounceTaskTitle = (who: string): string => clip(`Email to ${who} bounced`);
// Names the message by sender address and date only. Subjects and display names are free text from outside the app,
// and task titles are shown to models.
export const unreadSenderLabel = 'an unreadable sender address';
export const unreadMessageTaskTitle = (from: string | null, receivedAt: string): string =>
  clip(`Could not read the full text of an email from ${from ?? unreadSenderLabel} sent ${receivedAt.slice(0, 10)}`);
export const unknownSendTaskTitle = (who: string): string => clip(`Check whether the email to ${who} was sent`);

// Opt out suppressions record which inbound message caused them, so the summary can show it. The source is JSON,
// so wording that contains any character cannot break the format.
export const optOutSource = (providerMessageId: string, wording: string): string =>
  JSON.stringify({ kind: 'opt_out', messageId: providerMessageId, wording });

export function readOptOutSource(source: string): { providerMessageId: string; wording: string } | null {
  if (source.startsWith('{')) {
    try {
      const parsed = JSON.parse(source) as { kind?: unknown; messageId?: unknown; wording?: unknown };
      if (parsed.kind === 'opt_out' && typeof parsed.messageId === 'string' && typeof parsed.wording === 'string') {
        return { providerMessageId: parsed.messageId, wording: parsed.wording };
      }
    } catch {
      return null;
    }
    return null;
  }
  // Suppressions saved by an earlier build used "opt_out|messageId|wording".
  const parts = source.split('|');
  if (parts.length < 3 || parts[0] !== 'opt_out') return null;
  return { providerMessageId: parts[1]!, wording: parts.slice(2).join('|') };
}

// AgentMail idempotency keys expire 24 hours after a send completes. A retry that reuses a key is only safe well
// inside that window, so the app stops retrying after 23 hours.
export const idempotencyWindowMilliseconds = 23 * 60 * 60 * 1000;
export const duplicateProtectionExpiredSentence =
  "The provider's duplicate protection has expired, so this cannot be retried safely. Check the provider's sent mail.";

// Gmail has no idempotency key, so nothing is ever retried. After the same window the app stops searching.
export const gmailSearchWindowEndedSentence =
  "This message was not found in Gmail within a day, so the app stopped checking. Check Gmail's sent mail.";

// Microsoft keeps a draft until it is sent, so the check can run for a day too. After that it stops and asks a person.
export const microsoftCheckWindowEndedSentence =
  "This message was not confirmed in Outlook within a day, so the app stopped checking. Check the Sent Items folder in Outlook.";

// IMAP and SMTP: the check is a read only search of the Sent mailbox for the saved Message-ID. After the same window it
// stops and asks a person. Nothing is ever sent again from here.
export const imapCheckWindowEndedSentence =
  "This message was not found in the Sent mailbox within a day, so the app stopped checking. It may or may not have been sent, because neither iCloud nor Fastmail documents whether its mail server keeps a Sent copy on its own. Look in the Sent folder in the provider's webmail before sending again.";

// An approval older than this is not trusted to start a send.
export const approvalMaxAgeMilliseconds = 24 * 60 * 60 * 1000;
export const approvalTooOldSentence = 'Approved more than a day ago. Review and approve again.';

// Microsoft may send its saved draft again after an unknown outcome. These are the reasons it will not, each with the
// task that asks a person to look in Outlook.
export const microsoftResendApprovalTooOldSentence =
  'Approved more than a day ago, so this app will not send the saved draft again. It stays unknown until a person looks in Outlook and acknowledges it.';
export const microsoftNoResendSentence =
  'The Microsoft connector was removed while this message was unknown, so from now on this app only reads Outlook and will not send the saved draft again. It stays unknown until a person looks in Outlook and acknowledges it.';

export const acknowledgedUnknownSentence =
  "A previous send attempt for this draft has an unknown outcome. Check the provider's sent mail first.";

// Block and exclusion reasons the web app turns into sentences. Anything else is shown as written.
export const reasonCodes = {
  suppressed: 'suppressed',
  demoAddress: 'demo_address',
  invalidRecipient: 'invalid_recipient',
  duplicateOpenIntent: 'duplicate_open_intent',
  noInbox: 'no_inbox',
  dailyCap: 'daily_cap',
  replyReceived: 'reply_received',
  connectorRemoved: 'connector_removed',
  followupArmed: 'followup_armed',
  followupStopped: 'followup_stopped',
} as const;

// A step intent that a follow-up rule created and that sat queued for a day is not sent. Its own creation time counts,
// because the approval may be weeks old by then.
export const followupStaleSentence = 'Created by a follow-up rule more than a day ago.';

// An unknown follow-up step is never submitted again once its rule has stopped or expired, because the attempt before the
// stop may or may not have gone out. It keeps its unknown task, and only a read only check can settle it.
export const followupStoppedUnknownSentence =
  'Follow-ups to this person were stopped after this message was staged, so the app will not try to send it again. It may or may not have been sent. Look in the sent mail of the sending account before sending again.';

export const followupExpiredTaskTitle = (who: string): string =>
  clip(`Follow-up to ${who} was not sent: the computer was off past the send window`);
export const followupCeilingTaskTitle = (who: string): string =>
  clip(`Follow-up to ${who} was not sent: the plan expired 90 days after approval`);
export const followupStepNotSentTaskTitle = (who: string): string => clip(`Follow-up to ${who} was not sent`);

// Subject of a follow-up: "Re: " plus the first message's subject, unless it already starts with Re: in any case.
export function followupSubject(anchorSubject: string): string {
  return /^\s*re:/i.test(anchorSubject) ? anchorSubject : `Re: ${anchorSubject}`;
}
