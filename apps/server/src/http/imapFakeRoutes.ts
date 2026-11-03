import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../actions/index.js';
import { AppError } from '../errors.js';
import type { FakeMailTransport, SendStep } from '../providers/fakeMailTransport.js';
import { headerValue, parseMime } from '../providers/mime.js';

// Debug routes for the in process fake mail server. They are registered only when AGENTCRM_IMAP_FAKE=1, and they touch
// only the fake's memory, never the database. They exist so a person can watch the whole flow in the browser: trigger a
// reply, a bounce, a lost connection, or a rebuilt mailbox, and see what the app does.

const inboundBody = z
  .object({
    from: z.string().trim().min(3).max(300),
    subject: z.string().max(300).default('Re: your message'),
    text: z.string().max(20_000).default('Thanks, this is interesting. Can we talk next week?'),
    to: z.string().max(300).optional(),
    // The Message-ID this message answers. Left out, the latest message the fake sent to `from` is used.
    inReplyTo: z.string().max(300).optional(),
  })
  .strict();

const bounceBody = z
  .object({
    to: z.string().trim().min(3).max(300).optional(),
    originalMessageId: z.string().max(300).optional(),
    kind: z.enum(['failure', 'delay', 'delivered', 'relayed']).default('failure'),
    returned: z.enum(['rfc822', 'headers', 'none']).default('rfc822'),
  })
  .strict();

const knobsBody = z
  .object({
    sentAutoSave: z.boolean().optional(),
    reportsStoredCopy: z.boolean().nullable().optional(),
    appendFailure: z.string().max(300).nullable().optional(),
    // What the next send does: accept, reject (550), not_sent, lost_delivered (the server kept the message but the
    // answer was lost), or lost_not_delivered (the connection died and the server has nothing).
    nextSend: z.enum(['accept', 'reject', 'not_sent', 'lost_delivered', 'lost_not_delivered']).optional(),
    changeUidValidity: z.boolean().optional(),
  })
  .strict();

function stepFor(name: NonNullable<z.output<typeof knobsBody>['nextSend']>): SendStep {
  switch (name) {
    case 'accept':
      return { type: 'accept' };
    case 'reject':
      return { type: 'reject', code: 550, text: '5.7.1 Message rejected by the fake mail server' };
    case 'not_sent':
      return { type: 'not_sent', text: 'The fake mail server could not be reached.' };
    case 'lost_delivered':
      return { type: 'ambiguous', accepted: true };
    case 'lost_not_delivered':
      return { type: 'ambiguous', accepted: false };
  }
}

function latestTo(fake: FakeMailTransport, address: string): string | null {
  const wanted = address.trim().toLowerCase();
  for (const call of [...fake.sendCalls].reverse()) {
    if (call.envelopeTo.some((to) => to.toLowerCase() === wanted)) return call.messageId;
  }
  return null;
}

function summary(fake: FakeMailTransport): Record<string, unknown> {
  const describe = (entries: { raw: Buffer }[]) =>
    entries.map((entry) => {
      const top = parseMime(entry.raw);
      return { messageId: headerValue(top, 'message-id'), to: headerValue(top, 'to'), subject: headerValue(top, 'subject') };
    });
  return {
    uidValidity: fake.uidValidity,
    uidNext: fake.uidNext,
    inbox: fake.inbox.length,
    sent: describe(fake.sent),
    delivered: describe(fake.delivered),
    sendCalls: fake.sendCalls.length,
    knobs: { sentAutoSave: fake.knobs.sentAutoSave, reportsStoredCopy: fake.knobs.reportsStoredCopy, appendFailure: fake.knobs.appendFailure },
    scriptedSends: fake.sendScript.map((step) => step.type),
  };
}

export function registerImapFakeRoutes(app: FastifyInstance, fake: FakeMailTransport): void {
  app.get('/api/debug/imap-fake', async () => summary(fake));

  app.post('/api/debug/imap-fake/inbound', async (request, reply) => {
    const data = parseInput(inboundBody, request.body);
    const inReplyTo = data.inReplyTo ?? latestTo(fake, data.from.replace(/^.*<([^>]+)>.*$/, '$1')) ?? undefined;
    const added = fake.addInbound({
      from: data.from,
      subject: data.subject,
      text: data.text,
      ...(data.to ? { to: data.to } : {}),
      ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}),
    });
    reply.status(201);
    return { uid: added.uid, messageId: added.messageId, inReplyTo: inReplyTo ?? null };
  });

  app.post('/api/debug/imap-fake/bounce', async (request, reply) => {
    const data = parseInput(bounceBody, request.body);
    const original = data.originalMessageId ?? (data.to ? latestTo(fake, data.to) : null);
    if (!original || !data.to) {
      throw new AppError('not_found', 'Send "to" with an address the fake mail server has sent to, or an originalMessageId and "to".');
    }
    const added = fake.addBounce({ originalMessageId: original, to: data.to, kind: data.kind, returned: data.returned });
    reply.status(201);
    return { uid: added.uid, messageId: added.messageId, originalMessageId: original };
  });

  app.post('/api/debug/imap-fake/knobs', async (request) => {
    const data = parseInput(knobsBody, request.body);
    if (data.sentAutoSave !== undefined) fake.knobs.sentAutoSave = data.sentAutoSave;
    if (data.reportsStoredCopy !== undefined) fake.knobs.reportsStoredCopy = data.reportsStoredCopy;
    if (data.appendFailure !== undefined) fake.knobs.appendFailure = data.appendFailure;
    if (data.nextSend) fake.sendScript.push(stepFor(data.nextSend));
    if (data.changeUidValidity) fake.changeUidValidity();
    return summary(fake);
  });
}
