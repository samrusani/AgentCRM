import {
  formatInboxCursor,
  type InboxCursor,
  type MailServerSettings,
  type MailTransport,
  parseInboxCursor,
  TransportError,
  TransportSendError,
} from './mailTransport.js';
import { composeRawMessage } from './gmail.js';
import {
  type InboundBatch,
  type ListInboundOptions,
  type MailErrorKind,
  type MailIntent,
  type MailProvider,
  MailProviderError,
  type MailSubmitResult,
  type ReconcileResult,
  type SubmitHooks,
} from './mailTypes.js';

// Sending through any mail server that speaks SMTP, reading it through IMAP. All of the network work goes through the
// transport seam (providers/mailTransport.ts), so this module holds the rules and no sockets.
//
// Duplicate protection is the self generated Message-ID, as with Gmail: it is saved on the intent before the SMTP
// session opens, the same bytes go to the server and to the Sent mailbox, and an unclear outcome is settled only by a
// read only search of the Sent mailbox. This provider has no resend of any kind.

export const imapInboxResetNote =
  'The mail server rebuilt the Inbox (its UIDVALIDITY changed), so the sync started again from now. Replies that arrived in between may not be shown here.';
export const imapStoredCopyNote = 'The mail server saves its own copy of sent mail, so no copy was added to the Sent mailbox.';
export const imapDuplicateCopyNote =
  'A copy was added to the Sent mailbox. If the provider also saves its own copy, Sent may show this message twice. The recipient gets it once.';

export interface ImapSmtpAdapterOptions {
  settings: MailServerSettings;
  transport: MailTransport;
  // What verify reported about the server saving its own Sent copy, kept with the connector.
  smtpStoresSentCopy: boolean | null;
  now: () => number;
}

function errorKindOf(error: TransportError, sentNothing: boolean): MailErrorKind {
  if (error.kind === 'auth') {
    // Only a permanent refusal (5xx) means the saved login is wrong. A 4xx such as 454 is a temporary
    // condition on the server, and treating it as unauthorized would wrongly lock the whole connector.
    const code = error instanceof TransportSendError ? error.replyCode : null;
    if (code !== null && code >= 400 && code < 500) return sentNothing ? 'rejected' : 'unavailable';
    return 'unauthorized';
  }
  if (error.kind === 'timeout') return 'timeout';
  if (error.kind === 'network') return 'network';
  return sentNothing ? 'rejected' : 'unavailable';
}

export function toMailProviderError(error: unknown): MailProviderError {
  if (error instanceof MailProviderError) return error;
  if (error instanceof TransportError) {
    return new MailProviderError(errorKindOf(error, false), error.message);
  }
  return new MailProviderError('unavailable', 'The mail server check failed in an unexpected way.');
}

// The Sent copy may take at most ten seconds; past that the accepted outcome is recorded without it.
function withAppendDeadline(work: Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TransportError('timeout', 'Saving the Sent copy took too long.')), 10_000);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function endSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function createImapSmtpMailProvider(options: ImapSmtpAdapterOptions): MailProvider {
  const { settings, transport, now } = options;

  return {
    kind: 'imap',
    label: 'IMAP',
    duplicateProtection: 'message_id_search',

    async submit(intent: MailIntent, hooks?: SubmitHooks): Promise<MailSubmitResult> {
      if (!intent.messageIdHeader) {
        throw new MailProviderError('rejected', 'This message has no saved Message-ID, so it was not sent.', null, { sentNothing: true });
      }
      const messageId = intent.messageIdHeader;
      let raw: Buffer;
      try {
        raw = Buffer.from(
          composeRawMessage({
            from: intent.fromAddress,
            to: intent.to,
            subject: intent.subject,
            body: intent.body,
            messageId,
            date: new Date(now()),
            ...(intent.replyTo ? { replyTo: { inReplyTo: intent.replyTo.inReplyTo, references: intent.replyTo.references } } : {}),
          }),
          'utf8',
        );
      } catch (error) {
        if (error instanceof MailProviderError) throw error;
        throw new MailProviderError('rejected', 'The message could not be assembled, so it was not sent.', null, { sentNothing: true });
      }
      // The caller checks every guard of a first send once more and records the time of the attempt. Without that check
      // nothing is sent.
      const beforeSend = hooks?.beforeSend;
      if (!beforeSend) {
        throw new MailProviderError('rejected', 'The message could not be checked once more before sending, so it was not sent.', null, { sentNothing: true });
      }
      const refusal = beforeSend();
      if (refusal) throw new MailProviderError('rejected', `${endSentence(refusal)} The message was not sent.`, null, { sentNothing: true });

      try {
        await transport.send({ settings, envelopeFrom: intent.fromAddress, envelopeTo: [intent.to], messageId, raw });
      } catch (error) {
        if (error instanceof TransportSendError) {
          if (error.outcome === 'rejected') {
            if (error.kind === 'auth') {
              throw new MailProviderError('unauthorized', `The mail server did not accept the saved login: ${endSentence(error.message)} The message was not sent.`, error.replyCode, { sentNothing: true });
            }
            throw new MailProviderError('rejected', `The mail server refused the message: ${endSentence(error.message)}`, error.replyCode, { sentNothing: false });
          }
          if (error.outcome === 'not_sent') {
            throw new MailProviderError(errorKindOf(error, true), `${endSentence(error.message)} The message was not sent.`, error.replyCode, { sentNothing: true });
          }
          // The connection died or timed out after data started, or the final reply was not a clear answer.
          throw new MailProviderError(errorKindOf(error, false), `${endSentence(error.message)}`, error.replyCode);
        }
        // Anything unexpected after the session may have opened is an unknown outcome, never a failure.
        throw new MailProviderError('unavailable', 'The send ended in an unexpected way before the server answered.');
      }

      // Accepted. The Sent copy is best effort, never changes the outcome, and is bounded so a slow
      // IMAP server cannot hold the accepted record hostage for long.
      const notes: string[] = [];
      if (options.smtpStoresSentCopy === true) {
        notes.push(imapStoredCopyNote);
      } else {
        try {
          await withAppendDeadline(transport.appendSent(settings, raw));
          if (options.smtpStoresSentCopy === null) notes.push(imapDuplicateCopyNote);
        } catch (error) {
          const reason = error instanceof TransportError ? endSentence(error.message) : 'The copy could not be saved.';
          notes.push(`A copy could not be added to the Sent mailbox: ${reason} The message was accepted by the server.`);
        }
      }
      // The Message-ID is also the thread id: a reply names it in References or In-Reply-To.
      return { messageId, threadId: messageId, notes };
    },

    // READ ONLY. This searches the Sent mailbox for the Message-ID saved before the send. It never opens an SMTP session,
    // and nothing found keeps the intent unknown: neither preset documents whether the server saves a Sent copy itself.
    async reconcileUnknown(intent: MailIntent): Promise<ReconcileResult> {
      if (!intent.messageIdHeader) return { outcome: 'not_found' };
      try {
        const { found } = await transport.searchSent(settings, intent.messageIdHeader);
        return found ? { outcome: 'accepted', messageId: intent.messageIdHeader, threadId: intent.messageIdHeader } : { outcome: 'not_found' };
      } catch (error) {
        return { outcome: 'unavailable', error: toMailProviderError(error) };
      }
    },

    async listInbound(cursor: string | null, listOptions: ListInboundOptions): Promise<InboundBatch> {
      const parsed: InboxCursor | null = parseInboxCursor(cursor);
      // A saved position that cannot be read is treated like a rebuilt mailbox: start from now and say so.
      const unreadable = cursor !== null && parsed === null;
      let batch;
      try {
        batch = await transport.listNewInbox(settings, parsed, { limit: 25 });
      } catch (error) {
        throw toMailProviderError(error);
      }
      const messages = batch.messages.filter((message) => !listOptions.isKnown(message.providerMessageId));
      return {
        messages,
        nextCursor: formatInboxCursor(batch.cursor),
        more: batch.more,
        ...(batch.reset || unreadable ? { reset: { note: imapInboxResetNote } } : {}),
      };
    },

    async checkAccount() {
      return { address: settings.address };
    },
  };
}
