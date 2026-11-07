import { z } from 'zod';
import { validationError } from '../errors.js';
import { isValidEmail, parseAddress } from '../mail/rules.js';
import { type ImportCounts, emptyImportCounts } from '../queries/imports.js';
import { listMailConnectors, mailAccountOf } from '../queries/mailProvider.js';
import { getRunDetail } from '../queries/runs.js';
import { emailSchema } from './entities.js';
import { type ActionContext, mutate, parseInput, type Tx, withTxActor } from './context.js';
import { type AdvanceResult } from './demoResearch.js';
import { advanceStagedImportRun, importCountsOf } from './importReview.js';
import { enqueueJobIn } from './jobs.js';

export const mailboxCaptureKind = 'mailbox_capture';
export const mailboxCaptureJobKind = 'mailbox_capture_step';
export const mailboxCaptureActor = 'system:mailbox_capture';

export const mailboxCaptureStepTitles = [
  'Scan stored mail and stage correspondents',
  'Validate rows',
  'Check for duplicates',
  'Request import review',
] as const;

export const noStoredMailMessage = 'No mail is stored on this computer yet. Mail sync fills it after a mail provider is connected.';
export const noCorrespondentsMessage = 'No new correspondents were found in the stored mail for this window.';

// Local parts that mean a machine, not a person. A local part matches when it is one of these or starts with one
// followed by a separator, for example "noreply+a1b2" or "bounce-1042". The list stays short and conservative: the
// review gate is the real filter.
export const machinePrefixes = [
  'no-reply',
  'noreply',
  'do-not-reply',
  'donotreply',
  'mailer-daemon',
  'postmaster',
  'bounce',
  'bounces',
  'notification',
  'notifications',
  'alert',
  'alerts',
  'newsletter',
  'unsubscribe',
] as const;

export function isMachineAddress(address: string): boolean {
  const local = address.slice(0, address.lastIndexOf('@')).toLowerCase();
  return machinePrefixes.some((prefix) => local === prefix || (local.startsWith(prefix) && /^[^a-z0-9]/.test(local.slice(prefix.length))));
}

const startSchema = z.object({ sinceDays: z.number().int().min(1).max(3650).optional() }).strict();

export interface Correspondent {
  email: string;
  name: string | null;
  inbound: number;
  outbound: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface MailboxScan {
  scannedMessages: number;
  correspondents: Correspondent[];
}

// Every address that belongs to a connected mail account, so the user's own inboxes never become people.
function ownAddresses(tx: Tx): Set<string> {
  const own = new Set<string>();
  for (const connector of listMailConnectors(tx.db, tx.workspaceId)) {
    const account = mailAccountOf(connector);
    for (const value of [account.address, account.accountId]) if (value && value.includes('@')) own.add(value.toLowerCase());
  }
  return own;
}

function addressSet(tx: Tx, sql: string): Set<string> {
  return new Set((tx.db.prepare(sql).all(tx.workspaceId) as { email: string }[]).map((row) => row.email.toLowerCase()));
}

// Reads only stored message rows (never subjects or bodies) and aggregates one candidate per correspondent address:
// the from address of inbound rows and every recipient of outbound rows inside the window, case folded.
export function scanStoredMail(tx: Tx, sinceDays: number | null): MailboxScan {
  const since = sinceDays === null ? null : new Date(Date.parse(tx.now()) - sinceDays * 86_400_000).toISOString();
  const excluded = ownAddresses(tx);
  for (const address of addressSet(tx, 'SELECT email FROM suppression WHERE workspace_id = ?')) excluded.add(address);
  for (const address of addressSet(tx, 'SELECT email FROM person WHERE workspace_id = ? AND email IS NOT NULL')) excluded.add(address);

  const found = new Map<string, Correspondent & { nameAt: string }>();
  let scannedMessages = 0;
  const rows = tx.db
    .prepare(
      `SELECT direction, from_email AS fromEmail, from_name AS fromName, "to" AS recipients, provider_timestamp AS at
       FROM email_message WHERE workspace_id = ?${since ? ' AND provider_timestamp >= ?' : ''}`,
    )
    .iterate(...(since ? [tx.workspaceId, since] : [tx.workspaceId])) as IterableIterator<{
    direction: 'in' | 'out';
    fromEmail: string;
    fromName: string | null;
    recipients: string;
    at: string;
  }>;
  for (const row of rows) {
    scannedMessages += 1;
    let addresses: string[];
    if (row.direction === 'in') {
      addresses = [row.fromEmail];
    } else {
      try {
        const parsed = JSON.parse(row.recipients) as unknown;
        addresses = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
      } catch {
        addresses = [];
      }
    }
    for (const address of new Set(addresses.map((value) => parseAddress(value) ?? value.trim().toLowerCase()))) {
      if (!isValidEmail(address) || !emailSchema.safeParse(address).success || excluded.has(address) || isMachineAddress(address)) continue;
      let entry = found.get(address);
      if (!entry) {
        entry = { email: address, name: null, inbound: 0, outbound: 0, firstSeenAt: row.at, lastSeenAt: row.at, nameAt: '' };
        found.set(address, entry);
      }
      if (row.direction === 'in') entry.inbound += 1;
      else entry.outbound += 1;
      if (row.at < entry.firstSeenAt) entry.firstSeenAt = row.at;
      if (row.at > entry.lastSeenAt) entry.lastSeenAt = row.at;
      // The most recent non empty name wins. Only the sender's own header names the sender.
      if (row.direction === 'in' && row.fromName && row.at >= entry.nameAt) {
        entry.name = row.fromName;
        entry.nameAt = row.at;
      }
    }
  }
  const correspondents = [...found.values()]
    .map(({ nameAt: _nameAt, ...entry }) => entry)
    .sort((a, b) => (a.lastSeenAt === b.lastSeenAt ? a.email.localeCompare(b.email) : a.lastSeenAt < b.lastSeenAt ? 1 : -1));
  return { scannedMessages, correspondents };
}

export function scheduleMailboxCaptureRun(tx: Tx, runId: string, runAt: string): void {
  enqueueJobIn(tx, mailboxCaptureJobKind, { runId, workspaceId: tx.workspaceId }, runAt);
}

// Scans and stages in one transaction, then queues the run, like a CSV import. Nothing is fetched from any provider
// and nothing becomes a person until a person approves the import. A person starts it from the app; agents cannot.
export function startMailboxCapture(ctx: ActionContext, input: unknown, options: { origin?: 'user' | 'agent' } = {}) {
  const origin = options.origin ?? 'user';
  if (origin === 'agent') throw validationError('Mailbox capture is started by a person in the app, not by an agent.');
  const data = parseInput(startSchema, input ?? {});
  const sinceDays = data.sinceDays ?? null;

  const runId = mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, ctx.actor);
    const stored = tx.db.prepare('SELECT 1 FROM email_message WHERE workspace_id = ? LIMIT 1').get(tx.workspaceId);
    if (!stored) throw validationError(noStoredMailMessage);
    const scan = scanStoredMail(tx, sinceDays);
    const rowCount = scan.correspondents.length;
    if (rowCount === 0) throw validationError(noCorrespondentsMessage);

    const id = tx.newId('run');
    const batchId = tx.newId('imp');
    const now = tx.now();
    const counts: ImportCounts = { ...emptyImportCounts, fetched: rowCount, staged: rowCount };
    const window = sinceDays === null ? 'all synced mail' : `last ${sinceDays} ${sinceDays === 1 ? 'day' : 'days'}`;
    tx.db
      .prepare(
        `INSERT INTO run (id, created_at, workspace_id, kind, title, status, scope, counts)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(id, now, tx.workspaceId, mailboxCaptureKind, `Mailbox capture: ${window}`, JSON.stringify({ batchId, sinceDays, origin }), JSON.stringify(importCountsOf(counts, rowCount)));
    mailboxCaptureStepTitles.forEach((title, index) => {
      // The scan and staging are done when the run is created, so the first step starts done.
      const done = index === 0;
      tx.db
        .prepare(
          'INSERT INTO run_step (id, created_at, run_id, seq, title, status, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          tx.newId('stp'),
          now,
          id,
          index + 1,
          title,
          done ? 'done' : 'pending',
          done
            ? `Scanned ${scan.scannedMessages} stored ${scan.scannedMessages === 1 ? 'message' : 'messages'} and staged ${rowCount} ${rowCount === 1 ? 'correspondent' : 'correspondents'}.`
            : null,
          done ? now : null,
          done ? now : null,
        );
    });
    tx.db
      .prepare(
        `INSERT INTO import_batch (id, created_at, workspace_id, run_id, source_kind, source_ref, status, counts, updated_at)
         VALUES (?, ?, ?, ?, 'mailbox', ?, 'staging', ?, ?)`,
      )
      .run(batchId, now, tx.workspaceId, id, JSON.stringify({ sinceDays, scannedMessages: scan.scannedMessages, correspondents: rowCount }), JSON.stringify(counts), now);
    const insert = tx.db.prepare(
      "INSERT INTO import_row (id, created_at, batch_id, seq, raw, mapped, status) VALUES (?, ?, ?, ?, ?, ?, 'staged')",
    );
    scan.correspondents.forEach((correspondent, index) => {
      // The raw column keeps counts only. No subject or body text reaches a row, a review, or a claim.
      const mapped = {
        name: correspondent.name,
        firstName: null,
        lastName: null,
        email: correspondent.email,
        company: null,
        domain: null,
        title: null,
        location: null,
        linkedinUrl: null,
        tags: [],
      };
      insert.run(tx.newId('row'), now, batchId, index + 1, JSON.stringify(correspondent), JSON.stringify(mapped));
    });
    scheduleMailboxCaptureRun(tx, id, now);
    tx.audit('run.create', 'run', id, { kind: mailboxCaptureKind, sinceDays, scannedMessages: scan.scannedMessages, correspondents: rowCount });
    tx.audit('import.create', 'import_batch', batchId, { runId: id, sinceDays, scannedMessages: scan.scannedMessages, correspondents: rowCount });
    tx.emit({ type: 'run_updated', runId: id });
    return id;
  });
  return getRunDetail(ctx.db, ctx.workspaceId, runId);
}

export function advanceMailboxCaptureRun(ctx: ActionContext, runId: string): AdvanceResult {
  return advanceStagedImportRun(ctx, runId, {
    kind: mailboxCaptureKind,
    actor: mailboxCaptureActor,
    invalidReason: 'No email found in this row.',
    validatedDetail: (total, invalid) => `Checked ${total} ${total === 1 ? 'correspondent' : 'correspondents'}. ${invalid} had no email and were marked invalid.`,
    // Like a CSV import, plus the staged rows of other pending imports.
    dedupe: { pendingBatches: true },
    review: (run) => {
      const sinceDays = typeof run.scope.sinceDays === 'number' ? run.scope.sinceDays : null;
      const window = sinceDays === null ? 'all synced mail' : `the last ${sinceDays} ${sinceDays === 1 ? 'day' : 'days'}`;
      return {
        emptyDetail: (counts) => `All ${counts.fetched} correspondents were duplicates or invalid, so there is nothing to review.`,
        title: (staged) => `Review ${staged} ${staged === 1 ? 'correspondent' : 'correspondents'} from ${window}`,
        payloadSource: { sinceDays },
      };
    },
  });
}
