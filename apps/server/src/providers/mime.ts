import { decodeMimeWords, htmlToText, messageIdTokens, splitAddressList } from './gmail.js';
import type { NormalizedInbound } from './mailTypes.js';

// A small, tolerant reader for the messages an IMAP server returns. It reads headers, multipart structure, transfer
// encodings, and charsets, which is all the mail sync needs: sender, recipients, text, threading headers, and the
// parts of a delivery status report. It never throws on a malformed message; it returns what it could read.

export interface MimeHeader {
  name: string;
  // Unfolded, still encoded (RFC 2047 words are not decoded here).
  value: string;
}

export interface MimePart {
  headers: MimeHeader[];
  // The header block as written, for returning it as evidence.
  rawHead: string;
  // Lowercase, such as text/plain. Defaults to text/plain as RFC 2045 says.
  type: string;
  params: Record<string, string>;
  encoding: string;
  disposition: string;
  // The body still in its transfer encoding, as bytes.
  body: Buffer;
  // The parts of a multipart, or the one embedded message of a message/rfc822.
  children: MimePart[];
}

const maxDepth = 8;
const maxParts = 60;

function splitHeadAndBody(text: string): { head: string; body: string } {
  if (text.startsWith('\r\n')) return { head: '', body: text.slice(2) };
  if (text.startsWith('\n')) return { head: '', body: text.slice(1) };
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return { head: text, body: '' };
  return { head: text.slice(0, match.index), body: text.slice(match.index + match[0].length) };
}

function parseHeaderBlock(head: string): MimeHeader[] {
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const headers: MimeHeader[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (!/^[!-9;-~]+$/.test(name)) continue;
    headers.push({ name, value: line.slice(colon + 1).trim() });
  }
  return headers;
}

export function headerValue(part: Pick<MimePart, 'headers'>, name: string): string | null {
  const wanted = name.toLowerCase();
  const found = part.headers.find((header) => header.name.toLowerCase() === wanted);
  return found ? found.value : null;
}

function parseParameters(value: string): { main: string; params: Record<string, string> } {
  const semicolon = value.indexOf(';');
  const main = (semicolon < 0 ? value : value.slice(0, semicolon)).trim().toLowerCase();
  const params: Record<string, string> = {};
  if (semicolon >= 0) {
    for (const match of value.slice(semicolon).matchAll(/;\s*([A-Za-z0-9*._-]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^;\s]*)/g)) {
      params[match[1]!.toLowerCase()] = match[3] !== undefined ? match[3].replace(/\\(.)/g, '$1') : match[2]!;
    }
  }
  return { main, params };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseMime(raw: Buffer, depth = 0, budget: { parts: number } = { parts: 0 }): MimePart {
  // A binary string keeps every byte as one character, so slices of it convert back to the exact bytes.
  return parseText(raw.toString('latin1'), depth, budget);
}

function parseText(text: string, depth: number, budget: { parts: number }): MimePart {
  budget.parts += 1;
  const { head, body } = splitHeadAndBody(text);
  const headers = parseHeaderBlock(head);
  const typeHeader = parseParameters(headerValue({ headers }, 'content-type') ?? 'text/plain');
  const type = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(typeHeader.main) ? typeHeader.main : 'text/plain';
  const part: MimePart = {
    headers,
    rawHead: head,
    type,
    params: typeHeader.params,
    encoding: (headerValue({ headers }, 'content-transfer-encoding') ?? '7bit').trim().toLowerCase(),
    disposition: parseParameters(headerValue({ headers }, 'content-disposition') ?? '').main,
    body: Buffer.from(body, 'latin1'),
    children: [],
  };
  if (depth >= maxDepth) return part;
  if (type.startsWith('multipart/') && typeHeader.params.boundary) {
    const boundary = escapeRegex(typeHeader.params.boundary);
    const delimiter = new RegExp(`(?:^|\\r?\\n)--${boundary}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
    const pieces: string[] = [];
    let last = -1;
    for (const match of body.matchAll(delimiter)) {
      if (last >= 0) pieces.push(body.slice(last, match.index));
      if (match[1]) {
        last = -1;
        break;
      }
      last = match.index + match[0].length;
      // The line break after the delimiter belongs to the delimiter.
      if (body.startsWith('\r\n', last)) last += 2;
      else if (body.startsWith('\n', last)) last += 1;
    }
    // A message cut short has no closing delimiter. What was read of the last part is kept.
    if (last >= 0) pieces.push(body.slice(last));
    for (const piece of pieces) {
      if (budget.parts >= maxParts) break;
      part.children.push(parseText(piece, depth + 1, budget));
    }
  } else if (type === 'message/rfc822' && budget.parts < maxParts) {
    part.children.push(parseText(body, depth + 1, budget));
  }
  return part;
}

function decodeQuotedPrintable(text: string): Buffer {
  const joined = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < joined.length; index += 1) {
    const character = joined[index]!;
    if (character === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(joined.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(joined.charCodeAt(index) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function decodePartBytes(part: MimePart): Buffer {
  if (part.encoding === 'base64') return Buffer.from(part.body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (part.encoding === 'quoted-printable') return decodeQuotedPrintable(part.body.toString('latin1'));
  return part.body;
}

export function decodePartText(part: MimePart): string {
  const bytes = decodePartBytes(part);
  const charset = (part.params.charset ?? 'utf-8').trim().toLowerCase();
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Delivery status reports

const actionLine = /^\s*action:\s*([a-z-]+)/gim;

export interface DeliveryReport {
  // True for multipart/report with report-type=delivery-status.
  isDeliveryStatus: boolean;
  // Every Action line of the report, lowercased.
  actions: string[];
  // The returned headers (and the text of text/rfc822-headers parts) that may carry our Message-ID.
  evidence: string[];
}

function collectReport(part: MimePart, report: DeliveryReport): void {
  if (part.type === 'message/delivery-status') {
    for (const match of decodePartText(part).matchAll(actionLine)) report.actions.push(match[1]!.toLowerCase());
  } else if (part.type === 'text/rfc822-headers') {
    report.evidence.push(decodePartText(part));
  } else if (part.type === 'message/rfc822') {
    for (const child of part.children) report.evidence.push(child.rawHead);
  }
  for (const child of part.children) if (part.type !== 'message/rfc822') collectReport(child, report);
}

export function readDeliveryReport(top: MimePart): DeliveryReport {
  const report: DeliveryReport = { isDeliveryStatus: false, actions: [], evidence: [] };
  if (top.type !== 'multipart/report') return report;
  report.isDeliveryStatus = (top.params['report-type'] ?? '').trim().toLowerCase() === 'delivery-status';
  // A report of another type (a read receipt, say) says nothing about delivery, so nothing is taken from it.
  if (report.isDeliveryStatus) collectReport(top, report);
  return report;
}

// "failed" wins when a report names several recipients. Otherwise the first action is the answer.
function deliveryActionOf(actions: string[]): string | null {
  return actions.includes('failed') ? 'failed' : (actions[0] ?? null);
}

// ---------------------------------------------------------------------------------------------------------------
// One message

const maxStoredTextLength = 100_000;

function clip(value: string): string {
  return value.length > maxStoredTextLength ? value.slice(0, maxStoredTextLength) : value;
}

interface BodyText {
  plain: string | null;
  html: string | null;
}

function findBodyText(part: MimePart, found: BodyText): void {
  if (part.disposition === 'attachment') return;
  if (part.type === 'text/plain' && found.plain === null) found.plain = decodePartText(part);
  else if (part.type === 'text/html' && found.html === null) found.html = decodePartText(part);
  // The parts of a report that describe the delivery are evidence, not the message.
  if (part.type === 'message/rfc822' || part.type === 'message/delivery-status' || part.type === 'text/rfc822-headers') return;
  for (const child of part.children) findBodyText(child, found);
}

export interface RawInboxMessage {
  uid: number;
  uidValidity: string;
  // The server's internal date, when it reported one.
  internalDate: Date | string | null;
  source: Buffer;
}

// The one place a raw IMAP message becomes a NormalizedInbound. The real transport and the stub both use it.
export function normalizeImapMessage(raw: RawInboxMessage, fallbackReceivedAt: string): NormalizedInbound {
  const top = parseMime(raw.source);
  const found: BodyText = { plain: null, html: null };
  findBodyText(top, found);
  const body = found.plain ?? (found.html !== null ? htmlToText(found.html) : null);
  const report = readDeliveryReport(top);
  const references = (headerValue(top, 'references') ?? '').split(/\s+/).filter(Boolean);
  const inReplyTo = messageIdTokens(headerValue(top, 'in-reply-to') ?? '')[0] ?? null;
  const messageId = messageIdTokens(headerValue(top, 'message-id') ?? '')[0] ?? null;
  const internal = raw.internalDate === null ? NaN : new Date(raw.internalDate).getTime();
  const dateHeader = headerValue(top, 'date');
  const parsedDate = dateHeader ? Date.parse(dateHeader) : NaN;
  const receivedAt = Number.isFinite(internal) ? new Date(internal).toISOString() : Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : fallbackReceivedAt;
  const recipients = [headerValue(top, 'to'), headerValue(top, 'cc')].filter((value): value is string => Boolean(value));
  const text = body === null ? null : clip(body);
  const preview = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const thread = messageIdTokens(references.join(' '))[0] ?? inReplyTo;
  return {
    providerMessageId: `imap:${raw.uidValidity}:${raw.uid}`,
    // A reply carries the root of its thread in References. A message we started is its own root, so a reply from
    // another address still lands on the thread of the intent when the Message-ID is saved as the thread id.
    threadId: thread,
    direction: 'in',
    from: decodeMimeWords(headerValue(top, 'from') ?? ''),
    to: recipients.flatMap((value) => splitAddressList(decodeMimeWords(value))),
    subject: decodeMimeWords(headerValue(top, 'subject') ?? ''),
    preview,
    labels: [],
    text,
    replyText: text ?? '',
    messageIdHeader: messageId,
    inReplyTo,
    references: messageIdTokens(references.join(' ')),
    evidenceText: clip(report.evidence.join('\n')),
    deliveryAction: report.isDeliveryStatus ? deliveryActionOf(report.actions) : null,
    receivedAt,
    unreadable: false,
  };
}
