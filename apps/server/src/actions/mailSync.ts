import { mailPollMilliseconds, minimumMailPollMilliseconds } from '../config.js';
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
import { messageIdTokens } from '../providers/gmail.js';
import { MailProviderError, type MailProviderKind, type NormalizedInbound } from '../providers/mailTypes.js';
import { getActiveMailConnector, mailAccountOf } from '../queries/mailProvider.js';
import { type ActionContext, mutate, type Tx } from './context.js';
import { imapPasswordRejectedSentence } from './imapConnector.js';
import { promotePersonIn } from './lifecycle.js';
import { createMailAdapter, type MailAdapter, markMailProviderRejected } from './mailProviders.js';
import {
  blockWaitingIntentsIn,
  createEmailActivityIn,
  createTaskIn,
  ensureTaskIn,
  insertSuppressionIn,
  transitionIntentIn,
} from './sendIntentState.js';

// Small pages keep the number of full message fetches per poll low. A backlog drains over several polls.
const maxMessagePages = 4;
const maxEvidenceFetchesPerPoll = 10;
const activitySnippetLength = 500;

export interface SyncResult {
  skipped: boolean;
  messagesStored: number;
  eventsHandled: number;
  error: string | null;
}

interface SyncTarget {
  adapter: MailAdapter;
  kind: MailProviderKind;
  accountId: string;
  address: string;
  cursor: string | null;
  seenEventId: string | null;
}

type SettingsPatch = Record<string, string | null>;

function cursorKeyOf(kind: MailProviderKind): string {
  return kind === 'agentmail' ? 'lastMessageTimestamp' : kind === 'microsoft' ? 'deltaLink' : kind === 'imap' ? 'inboxCursor' : 'historyId';
}

// The saved position of the mail provider in use, read from the connector settings.
function savedCursor(ctx: ActionContext, kind: MailProviderKind): string | null {
  const row = ctx.db.prepare('SELECT settings FROM connector WHERE workspace_id = ? AND kind = ?').get(ctx.workspaceId, kind) as { settings: string } | undefined;
  if (!row) return null;
  try {
    const value = (JSON.parse(row.settings) as Record<string, unknown>)[cursorKeyOf(kind)];
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

// Cursor and status writes do not touch the connector's updated_at and are not audited: they happen on every poll
// and carry no decision. The records the poll creates are audited as usual. A write is refused when the connector
// now points at a different account than the one this poll started with.
function patchSettingsIn(tx: Tx, target: Pick<SyncTarget, 'kind' | 'accountId'>, patch: SettingsPatch): boolean {
  const row = tx.db.prepare('SELECT id, settings FROM connector WHERE workspace_id = ? AND kind = ?').get(tx.workspaceId, target.kind) as
    | { id: string; settings: string }
    | undefined;
  if (!row) return false;
  const settings = JSON.parse(row.settings) as Record<string, unknown>;
  const accountField = target.kind === 'imap' ? settings.address : settings.emailAddress;
  const current = target.kind === 'agentmail' ? settings.inboxId : typeof accountField === 'string' ? accountField.toLowerCase() : null;
  if (current !== target.accountId) return false;
  tx.db.prepare('UPDATE connector SET settings = ? WHERE id = ?').run(JSON.stringify({ ...settings, ...patch }), row.id);
  return true;
}

function errorSentence(error: unknown, adapter: MailAdapter): string {
  const label = adapter.provider.label;
  if (error instanceof MailProviderError) {
    if (error.kind === 'unauthorized') {
      if (adapter.account.kind === 'imap') return imapPasswordRejectedSentence;
      return adapter.account.kind === 'agentmail' ? 'AgentMail rejected the saved API key.' : `${label} no longer accepts the saved sign in.`;
    }
    if (error.kind === 'rate_limited') return `${label} is rate limiting requests. The next poll will try again.`;
    if (error.kind === 'timeout') return `${adapter.account.kind === 'imap' ? 'The mail server' : label} did not answer in time. The next poll will try again.`;
  }
  if (adapter.account.kind === 'imap') {
    const detail = error instanceof MailProviderError ? ` (${error.message.replace(/[.!?]+$/, '')})` : '';
    return `The last poll could not read the Inbox from the mail server${detail}. The next poll will try again.`;
  }
  return `The last poll could not read from ${label}. The next poll will try again.`;
}

function snippet(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > activitySnippetLength ? `${flat.slice(0, activitySnippetLength - 3)}...` : flat;
}

function personByEmail(tx: Tx, email: string): { id: string; name: string } | null {
  const row = tx.db
    .prepare("SELECT id, TRIM(first_name || ' ' || last_name) AS name FROM person WHERE workspace_id = ? AND lower(email) = ?")
    .get(tx.workspaceId, email) as { id: string; name: string } | undefined;
  return row ?? null;
}

// True when the address case folds to the person's own email. Promotion on inbound mail requires this: a mailer daemon,
// a third party, or a colleague on the thread never promotes the thread's person.
function isOwnAddress(tx: Tx, personId: string, address: string): boolean {
  return Boolean(tx.db.prepare('SELECT 1 FROM person WHERE workspace_id = ? AND id = ? AND lower(email) = ?').get(tx.workspaceId, personId, address.toLowerCase()));
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
function handleInbound(tx: Tx, message: NormalizedInbound, fromEmail: string, link: InboundLink, inboxEmail: string): boolean {
  const body = message.replyText;
  let changed = false;

  if (link.person) {
    createEmailActivityIn(tx, {
      personId: link.person.id,
      kind: 'email_in',
      body: `Reply received\n\nFrom: ${fromEmail}\nSubject: ${message.subject}\n\n${snippet(body)}`,
    });
    changed = true;
  }
  if (link.senderAddress === inboxEmail) return changed;

  const people = [link.senderPerson, link.threadPerson].filter((person, index, all): person is { id: string; name: string } =>
    Boolean(person) && all.findIndex((other) => other?.id === person?.id) === index,
  );
  for (const person of people) {
    if (markReplied(tx, person, message.threadId, message.providerMessageId)) changed = true;
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
        if (insertSuppressionIn(tx, { email: address, reason: 'opt_out', source: optOutSource(message.providerMessageId, wording) })) created = true;
      }
      if (created) {
        createTaskIn(tx, { title: optOutTaskTitle(link.person?.name ?? link.senderAddress ?? unreadSenderLabel, wording), personId: link.person?.id ?? null });
        changed = true;
      }
    }
  }
  return changed;
}

interface BouncedIntent {
  id: string;
  person_id: string;
  to_email: string;
  status: 'accepted' | 'replied' | 'unknown';
}

const maxBounceTokens = 100;
const intentHeaderLine = /^\s*x-agentcrm-intent:\s*(\S+)\s*$/gim;

// Words in a subject or the first lines of a report that say the message could not be delivered at all.
const failureWording =
  /delivery status notification \(failure\)|undeliverable|could not be delivered|couldn'?t be delivered|wasn'?t delivered|was not delivered|not delivered|address not found|address couldn'?t be found|delivery (has )?failed|delivery incomplete|failed permanently|mail delivery (failed|subsystem)|returned (to sender|mail)|message blocked/i;
// Words that say the provider is still trying, or that the message arrived. These win over failure wording because a
// delay notice often opens with "Delivery incomplete".
const progressWording =
  /\((delay|delayed|delivered|relayed|success)\)|delivery (has been )?delayed|delayed delivery|delivery (status )?notification \((delay|delayed)\)|temporary problem|temporarily|will (keep|continue) (trying|to try)|will retry|still trying|warning: (message|delivery)|successfully delivered|has been delivered/i;
const reportOpeningLines = 12;
const reportOpeningCharacters = 1200;

// True when a report from an automated sender says delivery failed for good. An attached delivery status report
// decides by its Action: only "failed" is a bounce, and delayed, delivered, relayed, and expanded notices are not.
// Without a report, the subject and the opening lines must say so in words, and a notice that says the provider is
// still trying is not a failure.
function reportsFailure(message: NormalizedInbound): boolean {
  if (message.deliveryAction) return message.deliveryAction === 'failed';
  const opening = (message.text ?? message.replyText)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, reportOpeningLines)
    .join('\n')
    .slice(0, reportOpeningCharacters);
  const words = `${message.subject}\n${opening}`;
  if (progressWording.test(words)) return false;
  return failureWording.test(words);
}

// Gmail has no bounce API. A message from a mailer daemon counts as a bounce only when all three hold: it comes from
// an automated sender, it says delivery failed (see reportsFailure), and it carries the Message-ID the app saved for
// one of its own sends, in the references, the reply header, the text, or the attached original. Anything less
// certain is an ordinary inbound message, which includes delay notices that quote our Message-ID. A bounce that names
// an intent whose outcome was unknown also proves that the email went out.
function findBouncedIntent(tx: Tx, message: NormalizedInbound, senderAddress: string | null): BouncedIntent | null {
  if (!senderAddress || !automatedSender.test(senderAddress)) return null;
  if (!reportsFailure(message)) return null;
  const haystack = [message.references.join(' '), message.inReplyTo ?? '', message.text ?? '', message.evidenceText].join('\n');
  const tokens = [...new Set(messageIdTokens(haystack).map((token) => token.toLowerCase()))].slice(0, maxBounceTokens);
  // A Microsoft send also carries the intent id in a header of its own, which survives in the returned original.
  const intentIds = [...new Set([...haystack.matchAll(intentHeaderLine)].map((match) => match[1]!))].slice(0, maxBounceTokens);
  if (tokens.length === 0 && intentIds.length === 0) return null;
  const row = tx.db
    .prepare(
      `SELECT id, person_id, to_email, status FROM send_intent WHERE workspace_id = ?
         AND ((message_id_header IS NOT NULL AND lower(message_id_header) IN (${tokens.map(() => '?').join(', ') || "''"}))
              OR (provider = 'microsoft' AND id IN (${intentIds.map(() => '?').join(', ') || "''"})))
         AND status IN ('accepted', 'replied', 'unknown')
         ORDER BY submitted_at DESC, id DESC LIMIT 1`,
    )
    .get(tx.workspaceId, ...tokens, ...intentIds) as BouncedIntent | undefined;
  return row ?? null;
}

// The shared bounce path: the intent becomes bounced, the address is suppressed, and a person gets a task. AgentMail
// reaches it from a bounced label event, Gmail from a delivery report that carries our Message-ID.
function applyBounceIn(tx: Tx, intent: BouncedIntent, evidence: string): void {
  transitionIntentIn(tx, intent.id, [intent.status], 'bounced', {}, 'bounced', { eventId: evidence });
  insertSuppressionIn(tx, { email: intent.to_email, reason: 'bounce', source: `bounce|${evidence}` });
  const person = tx.db.prepare("SELECT TRIM(first_name || ' ' || last_name) AS name FROM person WHERE id = ?").get(intent.person_id) as
    | { name: string }
    | undefined;
  createTaskIn(tx, { title: bounceTaskTitle(person?.name ?? intent.to_email), personId: intent.person_id });
}

function storeMessages(
  ctx: ActionContext,
  target: SyncTarget,
  messages: NormalizedInbound[],
  nextCursor: string | null,
  resetNote: string | null,
): { stored: number; cursor: string | null } {
  return mutate(ctx, (tx) => {
    let stored = 0;
    let changed = false;
    for (const message of messages) {
      const direction = message.direction;
      // A header that cannot be read as one address is kept as written for display. It is never used as an address.
      const senderAddress = parseAddress(message.from);
      const fromEmail = senderAddress ?? normalizeEmail(message.from);
      const recipients = message.to.map((address) => parseAddress(address) ?? normalizeEmail(address));
      const bounced = direction === 'in' ? findBouncedIntent(tx, message, senderAddress) : null;
      const link = direction === 'in' && !bounced ? linkInbound(tx, senderAddress, message.threadId, target.address) : null;
      const person = bounced ? null : link ? link.person : (recipients.map((address) => personByEmail(tx, address)).find(Boolean) ?? null);
      const result = tx.db
        .prepare(
          `INSERT INTO email_message (id, created_at, workspace_id, provider_message_id, provider_thread_id, direction, person_id, from_email, "to", subject, preview, body_text, labels, provider_timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, provider_message_id) DO NOTHING`,
        )
        .run(
          tx.newId('msg'),
          tx.now(),
          tx.workspaceId,
          message.providerMessageId,
          message.threadId,
          direction,
          person?.id ?? null,
          fromEmail,
          JSON.stringify(recipients),
          message.subject,
          message.preview,
          message.text,
          JSON.stringify(message.labels),
          message.receivedAt,
        );
      if (result.changes === 0) continue;
      stored += 1;
      changed = true;
      if (direction === 'in' && person && senderAddress && isOwnAddress(tx, person.id, senderAddress)) promotePersonIn(tx, person.id, 'replied');
      if (bounced) applyBounceIn(tx, bounced, message.providerMessageId);
      else if (link) handleInbound(tx, message, fromEmail, link, target.address);
      if (message.unreadable) {
        ensureTaskIn(tx, { title: unreadMessageTaskTitle(senderAddress, message.receivedAt), personId: person?.id ?? null });
      }
    }
    const patch: SettingsPatch = {};
    if (nextCursor) patch[cursorKeyOf(target.kind)] = nextCursor;
    // A reset cursor means replies in between may have been skipped. Say so on the connector, which stays connected.
    if (resetNote) patch.statusMessage = resetNote;
    if (Object.keys(patch).length > 0) patchSettingsIn(tx, target, patch);
    if (changed) tx.emit({ type: 'record_updated', entityType: 'send_intent', entityId: 'mail_sync' });
    return { stored, cursor: nextCursor ?? target.cursor };
  });
}

function isStored(ctx: ActionContext, providerMessageId: string): boolean {
  return Boolean(ctx.db.prepare('SELECT 1 FROM email_message WHERE workspace_id = ? AND provider_message_id = ?').get(ctx.workspaceId, providerMessageId));
}

async function pollMessages(ctx: ActionContext, target: SyncTarget): Promise<number> {
  let stored = 0;
  // Fetching a bounce report takes extra requests. A poll makes at most this many, however many pages it reads.
  const evidenceBudget = { remaining: maxEvidenceFetchesPerPoll };
  for (let pages = 0; pages < maxMessagePages; pages += 1) {
    const batch = await target.adapter.provider.listInbound(target.cursor, { isKnown: (id) => isStored(ctx, id), evidenceBudget });
    if (batch.failure !== undefined) {
      // What was fetched before the failure is kept, but the cursor stays where it was, so the failing message
      // and everything after it are tried again on the next poll.
      if (batch.messages.length > 0) storeMessages(ctx, target, batch.messages, null, null);
      throw batch.failure;
    }
    // The cursor moves only after the batch is stored.
    const result = storeMessages(ctx, target, batch.messages, batch.nextCursor, batch.reset?.note ?? null);
    stored += result.stored;
    target.cursor = result.cursor;
    // The poll's budget of evidence fetches is spent. What was read is stored, the cursor stays, and the next poll reads
    // the rest.
    if (batch.deferred || !batch.more) break;
  }
  return stored;
}

function handleBounceEvent(tx: Tx, event: { eventId: string; providerMessageId: string }): boolean {
  const intent = tx.db
    .prepare("SELECT id, person_id, to_email, status FROM send_intent WHERE workspace_id = ? AND provider_message_id = ? AND status IN ('accepted', 'replied')")
    .get(tx.workspaceId, event.providerMessageId) as { id: string; person_id: string; to_email: string; status: 'accepted' | 'replied' } | undefined;
  if (intent) {
    applyBounceIn(tx, intent, event.eventId);
    return true;
  }
  const message = tx.db
    .prepare("SELECT person_id, \"to\" AS recipients FROM email_message WHERE workspace_id = ? AND provider_message_id = ? AND direction = 'out'")
    .get(tx.workspaceId, event.providerMessageId) as { person_id: string | null; recipients: string } | undefined;
  if (!message) return false;
  const recipients = JSON.parse(message.recipients) as string[];
  const email = recipients[0] ?? null;
  if (!email) return false;
  const suppressionId = insertSuppressionIn(tx, { email, reason: 'bounce', source: `bounce|${event.eventId}` });
  if (suppressionId) {
    const person = message.person_id
      ? (tx.db.prepare("SELECT TRIM(first_name || ' ' || last_name) AS name FROM person WHERE id = ?").get(message.person_id) as { name: string } | undefined)
      : undefined;
    createTaskIn(tx, { title: bounceTaskTitle(person?.name ?? email), personId: message.person_id });
  }
  return true;
}

async function pollEvents(ctx: ActionContext, target: SyncTarget): Promise<number> {
  const batch = await target.adapter.provider.pollEvents?.(target.seenEventId);
  if (!batch) return 0;
  const { bounces, newestEventId } = batch;
  return mutate(ctx, (tx) => {
    let handled = 0;
    for (const event of bounces) {
      if (handleBounceEvent(tx, event)) handled += 1;
    }
    if (newestEventId) patchSettingsIn(tx, target, { seenEventId: newestEventId });
    if (handled > 0) tx.emit({ type: 'record_updated', entityType: 'send_intent', entityId: 'mail_sync' });
    return handled;
  });
}

const running = new Set<string>();

// One poll of the mail provider in use: new messages after the cursor, then bounce events for providers that have
// them. The cursor moves only after a page is stored.
export async function syncMail(ctx: ActionContext): Promise<SyncResult> {
  const skipped: SyncResult = { skipped: true, messagesStored: 0, eventsHandled: 0, error: null };
  const connector = getActiveMailConnector(ctx.db, ctx.workspaceId);
  if (!connector) return skipped;
  const account = mailAccountOf(connector);
  if (!account.ready || !account.accountId || !account.address) return skipped;
  if (running.has(ctx.workspaceId)) return skipped;
  const adapter = createMailAdapter(ctx, account.kind);
  if (!adapter) return skipped;
  running.add(ctx.workspaceId);
  const target: SyncTarget = {
    adapter,
    kind: account.kind,
    accountId: account.accountId,
    address: normalizeEmail(account.address),
    cursor: connector.kind === 'agentmail' ? connector.settings.lastMessageTimestamp : savedCursor(ctx, connector.kind),
    seenEventId: connector.kind === 'agentmail' ? connector.settings.seenEventId : null,
  };
  try {
    const messagesStored = await pollMessages(ctx, target);
    const eventsHandled = await pollEvents(ctx, target);
    mutate(ctx, (tx) => {
      patchSettingsIn(tx, target, { lastSyncAt: tx.now(), lastSyncError: null });
    });
    return { skipped: false, messagesStored, eventsHandled, error: null };
  } catch (error) {
    if (error instanceof MailProviderError && error.kind === 'unauthorized') markMailProviderRejected(ctx, adapter);
    const sentence = errorSentence(error, adapter);
    // A provider that says how long to wait (Retry-After) moves the next poll out by that long.
    if (error instanceof MailProviderError && error.retryAfterMilliseconds !== null) {
      // A tiny or zero value is raised to the shortest poll interval, so a server cannot make the app poll in a tight loop.
      const wait = Math.max(error.retryAfterMilliseconds, minimumMailPollMilliseconds);
      lastAttempt.set(ctx.workspaceId, Date.now() + wait - mailPollMilliseconds());
    }
    mutate(ctx, (tx) => {
      patchSettingsIn(tx, target, { lastSyncError: sentence });
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
