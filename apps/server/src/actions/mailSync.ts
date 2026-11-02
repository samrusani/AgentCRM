import { mailPollMilliseconds } from '../config.js';
import {
  bounceTaskTitle,
  findOptOutWording,
  normalizeEmail,
  optOutSource,
  optOutTaskTitle,
  parseAddress,
  reasonCodes,
  replyTaskTitle,
  unreadMessageTaskTitle,
  unreadSenderLabel,
} from '../mail/rules.js';
import {
  AgentmailError,
  getMessage,
  listEvents,
  listMessages,
  type MailEvent,
  type MailMessageDetail,
  type MailMessageSummary,
} from '../providers/agentmail.js';
import { getConnector } from '../queries/connectors.js';
import { markAgentmailError } from './agentmailConnector.js';
import { type ActionContext, mutate, type Tx } from './context.js';
import {
  blockWaitingIntentsIn,
  createEmailActivityIn,
  createTaskIn,
  ensureTaskIn,
  insertSuppressionIn,
  transitionIntentIn,
} from './sendIntentState.js';

// Small pages keep the number of full message fetches per poll low. A backlog drains over several polls.
const messagePageSize = 25;
const maxMessagePages = 4;
const maxEventPages = 5;
const overlapMilliseconds = 1000;
const activitySnippetLength = 500;
// A message whose full text cannot be fetched is tried on this many polls in a row. After that it is stored with its
// preview only and a task names it, so one stubborn message cannot stall the sync for good.
const maxTransientFailures = 3;
const transientFailures = new Map<string, number>();

export interface SyncResult {
  skipped: boolean;
  messagesStored: number;
  eventsHandled: number;
  error: string | null;
}

interface SyncTarget {
  apiKey: string;
  inboxId: string;
  inboxEmail: string;
  cursor: string | null;
  seenEventId: string | null;
}

type SettingsPatch = Partial<{
  lastMessageTimestamp: string | null;
  seenEventId: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}>;

// Cursor and status writes do not touch the connector's updated_at and are not audited: they happen on every poll
// and carry no decision. The records the poll creates are audited as usual.
function patchSettingsIn(tx: Tx, inboxId: string, patch: SettingsPatch): boolean {
  const row = tx.db.prepare("SELECT id, settings FROM connector WHERE workspace_id = ? AND kind = 'agentmail'").get(tx.workspaceId) as
    | { id: string; settings: string }
    | undefined;
  if (!row) return false;
  const settings = JSON.parse(row.settings) as Record<string, unknown>;
  if (settings.inboxId !== inboxId) return false;
  tx.db.prepare('UPDATE connector SET settings = ? WHERE id = ?').run(JSON.stringify({ ...settings, ...patch }), row.id);
  return true;
}

function later(left: string | null, right: string): string {
  if (!left) return right;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

// The cursor never moves past the current time. A message dated in the future would otherwise hide every later
// message from the sync.
function notAfter(timestamp: string, limit: string): string {
  return Date.parse(timestamp) > Date.parse(limit) ? limit : timestamp;
}

function errorSentence(error: unknown): string {
  if (error instanceof AgentmailError) {
    if (error.kind === 'unauthorized') return 'AgentMail rejected the saved API key.';
    if (error.kind === 'rate_limited') return 'AgentMail is rate limiting requests. The next poll will try again.';
    if (error.kind === 'timeout') return 'AgentMail did not answer in time. The next poll will try again.';
  }
  return 'The last poll could not read from AgentMail. The next poll will try again.';
}

function textFor(summary: MailMessageSummary, detail: MailMessageDetail | null): string {
  return detail?.extractedText ?? detail?.text ?? summary.preview;
}

function snippet(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > activitySnippetLength ? `${flat.slice(0, activitySnippetLength - 3)}...` : flat;
}

function directionOf(summary: MailMessageSummary, inboxEmail: string): 'in' | 'out' | null {
  const labels = summary.labels.map((label) => label.toLowerCase());
  if (labels.includes('draft')) return null;
  if (labels.includes('received')) return 'in';
  if (labels.includes('sent')) return 'out';
  return parseAddress(summary.from) === inboxEmail ? 'out' : 'in';
}

function personByEmail(tx: Tx, email: string): { id: string; name: string } | null {
  const row = tx.db
    .prepare("SELECT id, TRIM(first_name || ' ' || last_name) AS name FROM person WHERE workspace_id = ? AND lower(email) = ?")
    .get(tx.workspaceId, email) as { id: string; name: string } | undefined;
  return row ?? null;
}

function personById(tx: Tx, id: string): { id: string; name: string } | null {
  const row = tx.db
    .prepare("SELECT id, TRIM(first_name || ' ' || last_name) AS name FROM person WHERE workspace_id = ? AND id = ?")
    .get(tx.workspaceId, id) as { id: string; name: string } | undefined;
  return row ?? null;
}

interface ThreadIntent {
  id: string;
  person_id: string;
  to_email: string;
}

// Who an inbound message belongs to. The sender's address may match a person, and the message may sit on a thread
// the app started. A reply from a different address (an alias, an assistant, a forward) still links through the thread.
interface InboundLink {
  // The sender's address when it could be read from the header, otherwise null.
  senderAddress: string | null;
  senderPerson: { id: string; name: string } | null;
  threadPerson: { id: string; name: string } | null;
  threadIntent: ThreadIntent | null;
  // The person the message is filed under.
  person: { id: string; name: string } | null;
}

function linkInbound(tx: Tx, senderAddress: string | null, threadId: string | null, inboxEmail: string): InboundLink {
  const senderPerson = senderAddress ? personByEmail(tx, senderAddress) : null;
  const fromInbox = senderAddress === inboxEmail;
  const threadIntent =
    threadId && !fromInbox
      ? ((tx.db
          .prepare(
            "SELECT id, person_id, to_email FROM send_intent WHERE workspace_id = ? AND provider_thread_id = ? AND status IN ('accepted', 'replied', 'bounced') ORDER BY submitted_at DESC, id DESC LIMIT 1",
          )
          .get(tx.workspaceId, threadId) as ThreadIntent | undefined) ?? null)
      : null;
  const threadPerson = threadIntent ? personById(tx, threadIntent.person_id) : null;
  return { senderAddress, senderPerson, threadPerson, threadIntent, person: senderPerson ?? threadPerson };
}

const automatedSender = /^(mailer-daemon|postmaster)@/;

function markReplied(tx: Tx, person: { id: string; name: string }, threadId: string | null, messageId: string): boolean {
  let changed = false;
  const thread = threadId
    ? (tx.db
        .prepare(
          "SELECT id FROM send_intent WHERE workspace_id = ? AND person_id = ? AND status = 'accepted' AND provider_thread_id = ? ORDER BY submitted_at DESC, id DESC LIMIT 1",
        )
        .get(tx.workspaceId, person.id, threadId) as { id: string } | undefined)
    : undefined;
  const target =
    thread ??
    (tx.db
      .prepare("SELECT id FROM send_intent WHERE workspace_id = ? AND person_id = ? AND status = 'accepted' ORDER BY submitted_at DESC, id DESC LIMIT 1")
      .get(tx.workspaceId, person.id) as { id: string } | undefined);
  if (target && transitionIntentIn(tx, target.id, ['accepted'], 'replied', {}, 'replied', { messageId })) {
    createTaskIn(tx, { title: replyTaskTitle(person.name), personId: person.id });
    changed = true;
  }
  if (blockWaitingIntentsIn(tx, { personId: person.id }, reasonCodes.replyReceived) > 0) changed = true;
  return changed;
}

// Everything one inbound message can cause. All of it happens in the transaction that stores the message.
function handleInbound(
  tx: Tx,
  summary: MailMessageSummary,
  detail: MailMessageDetail | null,
  fromEmail: string,
  link: InboundLink,
  inboxEmail: string,
): boolean {
  const body = textFor(summary, detail);
  let changed = false;

  if (link.person) {
    createEmailActivityIn(tx, {
      personId: link.person.id,
      kind: 'email_in',
      body: `Reply received\n\nFrom: ${fromEmail}\nSubject: ${summary.subject}\n\n${snippet(body)}`,
    });
    changed = true;
  }
  if (link.senderAddress === inboxEmail) return changed;

  const people = [link.senderPerson, link.threadPerson].filter((person, index, all): person is { id: string; name: string } =>
    Boolean(person) && all.findIndex((other) => other?.id === person?.id) === index,
  );
  for (const person of people) {
    if (markReplied(tx, person, summary.threadId, summary.messageId)) changed = true;
  }
  if (link.senderAddress && blockWaitingIntentsIn(tx, { toEmail: link.senderAddress }, reasonCodes.replyReceived) > 0) changed = true;
  if (link.threadIntent && blockWaitingIntentsIn(tx, { toEmail: link.threadIntent.to_email }, reasonCodes.replyReceived) > 0) changed = true;

  const wording = automatedSender.test(link.senderAddress ?? fromEmail) ? null : findOptOutWording(body);
  if (wording) {
    // Only a sender the app can tie to a person, or to a thread it started, is suppressed on its own word. The
    // address that was written to on that thread is suppressed too. Anything else gets a task for a person to review.
    const addresses = new Set<string>();
    if (link.senderAddress && (link.senderPerson || link.threadIntent)) addresses.add(link.senderAddress);
    if (link.threadIntent) addresses.add(normalizeEmail(link.threadIntent.to_email));
    if (addresses.size === 0) {
      createTaskIn(tx, { title: optOutTaskTitle(link.person?.name ?? link.senderAddress ?? unreadSenderLabel, wording), personId: link.person?.id ?? null });
      changed = true;
    } else {
      let created = false;
      for (const address of addresses) {
        if (insertSuppressionIn(tx, { email: address, reason: 'opt_out', source: optOutSource(summary.messageId, wording) })) created = true;
      }
      if (created) {
        createTaskIn(tx, { title: optOutTaskTitle(link.person?.name ?? link.senderAddress ?? unreadSenderLabel, wording), personId: link.person?.id ?? null });
        changed = true;
      }
    }
  }
  return changed;
}

interface FetchedMessage {
  summary: MailMessageSummary;
  detail: MailMessageDetail | null;
  direction: 'in' | 'out';
  // True when the full text could not be fetched on several polls in a row and the message is stored without it.
  unreadable: boolean;
}

// Full text is fetched once, only for inbound messages that are new. A busy or slow provider stops the poll and
// leaves the cursor where it was, so the same messages are tried again next time. A message AgentMail cannot
// return (for example one that was deleted) is stored with its preview only.
// Messages fetched before a failure are left in `fetched`, so the caller can still store them.
async function fetchNewMessages(ctx: ActionContext, target: SyncTarget, page: MailMessageSummary[], fetched: FetchedMessage[]): Promise<void> {
  for (const summary of page) {
    const direction = directionOf(summary, target.inboxEmail);
    if (!direction) continue;
    const known = ctx.db
      .prepare('SELECT 1 FROM email_message WHERE workspace_id = ? AND provider_message_id = ?')
      .get(ctx.workspaceId, summary.messageId);
    if (known) continue;
    let detail: MailMessageDetail | null = null;
    let unreadable = false;
    if (direction === 'in') {
      const failureKey = `${ctx.workspaceId}:${summary.messageId}`;
      try {
        detail = await getMessage(target.apiKey, target.inboxId, summary.messageId);
        transientFailures.delete(failureKey);
      } catch (error) {
        const permanent = error instanceof AgentmailError && (error.kind === 'not_found' || error.kind === 'rejected' || error.kind === 'bad_response');
        if (!permanent) {
          const failures = (transientFailures.get(failureKey) ?? 0) + 1;
          if (failures < maxTransientFailures) {
            transientFailures.set(failureKey, failures);
            throw error;
          }
          transientFailures.delete(failureKey);
          unreadable = true;
        }
      }
    }
    fetched.push({ summary, detail, direction, unreadable });
  }
}

function storeMessages(ctx: ActionContext, target: SyncTarget, fetched: FetchedMessage[], pageEnd: string | null): { stored: number; cursor: string | null } {
  return mutate(ctx, (tx) => {
    let stored = 0;
    let changed = false;
    const now = tx.now();
    for (const { summary, detail, direction, unreadable } of fetched) {
      // A header that cannot be read as one address is kept as written for display. It is never used as an address.
      const senderAddress = parseAddress(summary.from);
      const fromEmail = senderAddress ?? normalizeEmail(summary.from);
      const recipients = summary.to.map((address) => parseAddress(address) ?? normalizeEmail(address));
      const link = direction === 'in' ? linkInbound(tx, senderAddress, summary.threadId, target.inboxEmail) : null;
      const person = link ? link.person : (recipients.map((address) => personByEmail(tx, address)).find(Boolean) ?? null);
      const result = tx.db
        .prepare(
          `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, provider_thread_id, direction, person_id, from_email, "to", subject, preview, body_text, labels, provider_timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, provider_message_id) DO NOTHING`,
        )
        .run(
          tx.newId('msg'),
          tx.now(),
          tx.workspaceId,
          summary.messageId,
          summary.threadId,
          direction,
          person?.id ?? null,
          fromEmail,
          JSON.stringify(recipients),
          summary.subject,
          summary.preview,
          direction === 'in' ? (detail?.text ?? detail?.extractedText ?? null) : null,
          JSON.stringify(summary.labels),
          summary.timestamp,
        );
      if (result.changes === 0) continue;
      stored += 1;
      changed = true;
      if (link) handleInbound(tx, summary, detail, fromEmail, link, target.inboxEmail);
      if (unreadable) {
        ensureTaskIn(tx, { title: unreadMessageTaskTitle(senderAddress, summary.timestamp), personId: person?.id ?? null });
      }
    }
    let cursor = target.cursor;
    if (pageEnd) cursor = later(cursor, notAfter(pageEnd, now));
    patchSettingsIn(tx, target.inboxId, { lastMessageTimestamp: cursor });
    if (changed) tx.emit({ type: 'record_updated', entityType: 'send_intent', entityId: 'mail_sync' });
    return { stored, cursor };
  });
}

async function pollMessages(ctx: ActionContext, target: SyncTarget): Promise<number> {
  let stored = 0;
  let pageToken: string | undefined;
  // The query stays the same across pages, because a page token belongs to the query that produced it.
  const after = target.cursor ? new Date(Date.parse(target.cursor) - overlapMilliseconds).toISOString() : undefined;
  for (let pages = 0; pages < maxMessagePages; pages += 1) {
    const page = await listMessages(target.apiKey, target.inboxId, {
      ...(after ? { after } : {}),
      ascending: true,
      limit: messagePageSize,
      ...(pageToken ? { pageToken } : {}),
    });
    const fetched: FetchedMessage[] = [];
    try {
      await fetchNewMessages(ctx, target, page.messages, fetched);
    } catch (error) {
      // What was fetched before the failure is kept, but the cursor stays where it was, so the failing message
      // and everything after it are tried again on the next poll.
      if (fetched.length > 0) storeMessages(ctx, target, fetched, null);
      throw error;
    }
    const pageEnd = page.messages.reduce<string | null>((latest, message) => later(latest, message.timestamp), null);
    const result = storeMessages(ctx, target, fetched, pageEnd);
    stored += result.stored;
    target.cursor = result.cursor;
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return stored;
}

// Pages the newest-first feed until it meets an event it has already seen, then returns the new ones oldest first.
async function collectNewEvents(target: SyncTarget): Promise<{ events: MailEvent[]; newest: string | null }> {
  const collected: MailEvent[] = [];
  let newest: string | null = null;
  let pageToken: string | undefined;
  for (let pages = 0; pages < maxEventPages; pages += 1) {
    const page = await listEvents(target.apiKey, target.inboxId, { limit: 100, ...(pageToken ? { pageToken } : {}) });
    if (pages === 0) newest = page.events[0]?.eventId ?? null;
    let metSeen = false;
    for (const event of page.events) {
      if (event.eventId === target.seenEventId) {
        metSeen = true;
        break;
      }
      collected.push(event);
    }
    if (metSeen || !page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return { events: collected.reverse(), newest };
}

function handleBounce(tx: Tx, event: MailEvent): boolean {
  if (!event.messageId) return false;
  const intent = tx.db
    .prepare("SELECT id, person_id, to_email, status FROM send_intent WHERE workspace_id = ? AND provider_message_id = ? AND status IN ('accepted', 'replied')")
    .get(tx.workspaceId, event.messageId) as { id: string; person_id: string; to_email: string; status: 'accepted' | 'replied' } | undefined;
  let email: string | null = null;
  let personId: string | null = null;
  if (intent) {
    transitionIntentIn(tx, intent.id, [intent.status], 'bounced', {}, 'bounced', { eventId: event.eventId });
    email = intent.to_email;
    personId = intent.person_id;
  } else {
    const message = tx.db
      .prepare("SELECT person_id, \"to\" AS recipients FROM email_message WHERE workspace_id = ? AND provider_message_id = ? AND direction = 'out'")
      .get(tx.workspaceId, event.messageId) as { person_id: string | null; recipients: string } | undefined;
    if (!message) return false;
    const recipients = JSON.parse(message.recipients) as string[];
    email = recipients[0] ?? null;
    personId = message.person_id;
  }
  if (!email) return false;
  const suppressionId = insertSuppressionIn(tx, { email, reason: 'bounce', source: `bounce|${event.eventId}` });
  if (suppressionId || intent) {
    const person = personId
      ? (tx.db.prepare("SELECT TRIM(first_name || ' ' || last_name) AS name FROM person WHERE id = ?").get(personId) as { name: string } | undefined)
      : undefined;
    createTaskIn(tx, { title: bounceTaskTitle(person?.name ?? email), personId });
  }
  return true;
}

async function pollEvents(ctx: ActionContext, target: SyncTarget): Promise<number> {
  const { events, newest } = await collectNewEvents(target);
  return mutate(ctx, (tx) => {
    let handled = 0;
    for (const event of events) {
      // Only a bounced label is evidence of a failed delivery. Opened labels and everything else are ignored.
      if (event.eventType.toLowerCase() !== 'label.added' || event.label?.toLowerCase() !== 'bounced') continue;
      if (handleBounce(tx, event)) handled += 1;
    }
    if (newest) patchSettingsIn(tx, target.inboxId, { seenEventId: newest });
    if (handled > 0) tx.emit({ type: 'record_updated', entityType: 'send_intent', entityId: 'mail_sync' });
    return handled;
  });
}

const running = new Set<string>();

// One poll: new messages after the cursor, then new events. The cursor moves only after a page is stored.
export async function syncMail(ctx: ActionContext): Promise<SyncResult> {
  const connector = getConnector(ctx.db, ctx.workspaceId, 'agentmail');
  const secret = ctx.db.prepare("SELECT secret FROM connector WHERE workspace_id = ? AND kind = 'agentmail'").get(ctx.workspaceId) as
    | { secret: string }
    | undefined;
  const skipped: SyncResult = { skipped: true, messagesStored: 0, eventsHandled: 0, error: null };
  if (!connector || !secret || connector.status !== 'connected' || !connector.settings.inboxId || !connector.settings.inboxEmail) return skipped;
  if (running.has(ctx.workspaceId)) return skipped;
  running.add(ctx.workspaceId);
  const target: SyncTarget = {
    apiKey: secret.secret,
    inboxId: connector.settings.inboxId,
    inboxEmail: normalizeEmail(connector.settings.inboxEmail),
    cursor: connector.settings.lastMessageTimestamp ? notAfter(connector.settings.lastMessageTimestamp, ctx.now()) : null,
    seenEventId: connector.settings.seenEventId,
  };
  try {
    const messagesStored = await pollMessages(ctx, target);
    const eventsHandled = await pollEvents(ctx, target);
    mutate(ctx, (tx) => {
      patchSettingsIn(tx, target.inboxId, { lastSyncAt: tx.now(), lastSyncError: null });
    });
    return { skipped: false, messagesStored, eventsHandled, error: null };
  } catch (error) {
    if (error instanceof AgentmailError && error.kind === 'unauthorized') markAgentmailError(ctx, target.apiKey);
    const sentence = errorSentence(error);
    mutate(ctx, (tx) => {
      patchSettingsIn(tx, target.inboxId, { lastSyncError: sentence });
    });
    return { skipped: false, messagesStored: 0, eventsHandled: 0, error: sentence };
  } finally {
    running.delete(ctx.workspaceId);
  }
}

const lastAttempt = new Map<string, number>();

// The worker calls this on every tick. It polls at most once per poll interval.
export async function syncMailIfDue(ctx: ActionContext): Promise<SyncResult | null> {
  const last = lastAttempt.get(ctx.workspaceId) ?? 0;
  if (Date.now() - last < mailPollMilliseconds()) return null;
  lastAttempt.set(ctx.workspaceId, Date.now());
  return syncMail(ctx);
}
