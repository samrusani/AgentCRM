import { z } from 'zod';
import { notFound, validationError } from '../errors.js';
import { reasonCodes } from '../mail/rules.js';
import { appPasswordHints, type ImapPresetName, imapUsernameFor, presetLabels, presetServers, smtpUsernameFor } from '../providers/imapPresets.js';
import { findSentMailbox, formatInboxCursor, type MailServerSettings, type SmtpTlsMode, type VerifyResult } from '../providers/mailTransport.js';
import { getMailTransport } from '../providers/mailTransportFactory.js';
import { type ImapConnector, getConnector, getImapInternals } from '../queries/connectors.js';
import { getActiveMailConnector } from '../queries/mailProvider.js';
import { type ActionContext, mutate, parseInput, type Tx } from './context.js';
import { activateMailProviderIfUnsetIn, reassignMailProviderAfterRemovalIn } from './mailProvider.js';
import { stopRulesForProviderIn } from './followupRules.js';
import { blockWaitingIntentsIn, resumeReconcilesIn, transitionIntentIn } from './sendIntentState.js';

export const imapPasswordRejectedSentence = 'The mail server no longer accepts the saved app password. Enter it again in Settings.';

const hostPattern = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const port = z.number().int().min(1).max(65535);

const configureSchema = z
  .object({
    preset: z.enum(['icloud', 'fastmail', 'custom']).optional(),
    address: z.string().trim().min(3).max(254).optional(),
    username: z.string().trim().min(1).max(254).optional(),
    appPassword: z
      .string()
      .min(1)
      .max(300)
      .refine((value) => !/[\r\n\0]/.test(value), 'Must not contain line breaks')
      .optional(),
    imapHost: z.string().trim().regex(hostPattern, 'Must be a server name such as imap.example.com').optional(),
    imapPort: port.optional(),
    smtpHost: z.string().trim().regex(hostPattern, 'Must be a server name such as smtp.example.com').optional(),
    smtpPort: port.optional(),
    smtpTls: z.enum(['tls', 'starttls']).optional(),
    // An empty string or null goes back to the mailbox the server marks as Sent.
    sentMailbox: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

type ConfigureInput = z.output<typeof configureSchema>;

function isAddress(value: string): boolean {
  return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

interface Effective {
  preset: ImapPresetName;
  address: string;
  password: string;
  loginName: string | null;
  servers: { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; smtpTls: SmtpTlsMode };
  // A Sent mailbox a person chose, or null to use the one the server marks.
  chosenSent: string | null;
}

// Merges the request over what is stored. A request without the app password, the login name, or the server fields
// keeps the stored values. Nothing is stored here.
function mergeInput(data: ConfigureInput, stored: ReturnType<typeof getImapInternals>): Effective {
  const storedSettings = stored?.settings ?? {};
  const presetValue = data.preset ?? (storedSettings.preset === 'icloud' || storedSettings.preset === 'fastmail' || storedSettings.preset === 'custom' ? storedSettings.preset : null);
  if (!presetValue) throw validationError('preset: Choose iCloud, Fastmail, or custom.');
  const addressValue = (data.address ?? str(storedSettings.address))?.toLowerCase() ?? null;
  if (!addressValue) throw validationError('address: The sending address is required.');
  if (!isAddress(addressValue)) throw validationError('address: Must be an email address.');
  const password = data.appPassword ?? stored?.password ?? null;
  if (!password) throw validationError('appPassword: An app password is required to connect.');

  let servers: Effective['servers'];
  if (presetValue === 'custom') {
    const keep = storedSettings.preset === 'custom';
    const merged = {
      imapHost: data.imapHost ?? (keep ? str(storedSettings.imapHost) : null),
      imapPort: data.imapPort ?? (keep ? num(storedSettings.imapPort) : null),
      smtpHost: data.smtpHost ?? (keep ? str(storedSettings.smtpHost) : null),
      smtpPort: data.smtpPort ?? (keep ? num(storedSettings.smtpPort) : null),
      smtpTls: data.smtpTls ?? (keep && (storedSettings.smtpTls === 'tls' || storedSettings.smtpTls === 'starttls') ? storedSettings.smtpTls : null),
    };
    for (const key of ['imapHost', 'imapPort', 'smtpHost', 'smtpPort', 'smtpTls'] as const) {
      if (merged[key] === null) throw validationError(`${key}: The custom preset needs the IMAP server, the SMTP server, their ports, and the SMTP security mode.`);
    }
    servers = merged as Effective['servers'];
  } else {
    for (const key of ['imapHost', 'imapPort', 'smtpHost', 'smtpPort', 'smtpTls'] as const) {
      if (data[key] !== undefined) throw validationError(`${key}: The ${presetLabels[presetValue]} preset sets the servers. Use the custom preset to choose them.`);
    }
    servers = { ...presetServers[presetValue] };
  }
  const loginName = data.username !== undefined ? data.username : str(storedSettings.loginName);
  let chosenSent: string | null = null;
  if (data.sentMailbox !== undefined) chosenSent = data.sentMailbox === null || data.sentMailbox === '' ? null : data.sentMailbox;
  else if (storedSettings.sentMailboxSource === 'chosen') chosenSent = str(storedSettings.sentMailbox);
  return { preset: presetValue, address: addressValue, password, loginName, servers, chosenSent };
}

export function serverSettingsOf(effective: Pick<Effective, 'preset' | 'address' | 'password' | 'loginName' | 'servers'>, sentMailbox: string | null): MailServerSettings {
  return {
    address: effective.address,
    imap: {
      host: effective.servers.imapHost,
      port: effective.servers.imapPort,
      username: imapUsernameFor(effective.preset, effective.address, effective.loginName),
      password: effective.password,
    },
    smtp: {
      host: effective.servers.smtpHost,
      port: effective.servers.smtpPort,
      tls: effective.servers.smtpTls,
      username: smtpUsernameFor(effective.preset, effective.address, effective.loginName),
      password: effective.password,
    },
    sentMailbox,
  };
}

function scrubPassword(text: string, password: string): string {
  return password.length > 0 ? text.replaceAll(password, '[removed]') : text;
}

function quote(text: string): string {
  return text.replace(/[.!?]+$/, '');
}

// The honest sentence for the step that failed, or null when every step passed. IMAP is checked first, then SMTP, then
// the Sent mailbox.
export function describeVerifyFailure(effective: Effective, result: VerifyResult): { sentence: string; sentMailbox: string | null; source: 'detected' | 'chosen' | null } | null {
  const label = presetLabels[effective.preset];
  const { servers } = effective;
  if (!result.imapOk) {
    const failure = result.imapFailure;
    const where = `${servers.imapHost}:${servers.imapPort}`;
    const detail = failure ? scrubPassword(quote(failure.message), effective.password) : 'The server did not say why';
    const sentence =
      failure?.kind === 'auth' || failure === null
        ? `IMAP login failed. ${label} rejected the login at ${where} (${detail}). ${appPasswordHints[effective.preset]}`
        : failure.kind === 'tls'
          ? `IMAP login failed. A secure connection to ${where} could not be set up (${detail}). Check the server name and port.`
          : `IMAP login failed. Could not reach ${where} (${detail}). Check the server name and port, and your connection.`;
    return { sentence, sentMailbox: null, source: null };
  }
  if (!result.smtpOk) {
    const failure = result.smtpFailure;
    const where = `${servers.smtpHost}:${servers.smtpPort}`;
    const detail = failure ? scrubPassword(quote(failure.message), effective.password) : 'The server did not say why';
    const sentence =
      failure?.kind === 'auth' || failure === null
        ? `SMTP login failed. The IMAP login worked, but ${label} rejected the SMTP login at ${where} (${detail}). ${appPasswordHints[effective.preset]}`
        : `SMTP failed. The IMAP login worked, but the SMTP server at ${where} could not be used (${detail}). Check the server name, port, and security mode.`;
    return { sentence, sentMailbox: null, source: null };
  }
  const paths = result.mailboxes.map((mailbox) => mailbox.path);
  if (effective.chosenSent) {
    if (!paths.includes(effective.chosenSent)) {
      return { sentence: `No Sent mailbox found. The mailbox "${effective.chosenSent}" does not exist on the server. Choose one of the mailboxes the server lists.`, sentMailbox: null, source: null };
    }
    return null;
  }
  if (!findSentMailbox(result.mailboxes)) {
    return { sentence: 'No Sent mailbox found. The server does not mark any mailbox as Sent. Choose the mailbox that holds sent mail.', sentMailbox: null, source: null };
  }
  return null;
}

interface RawRow {
  id: string;
  status: 'connected' | 'error';
  settings: Record<string, unknown>;
  secret: string;
  updated_at: string;
}

function readRow(tx: Tx): RawRow | null {
  const row = tx.db.prepare("SELECT id, status, settings, secret, updated_at FROM connector WHERE workspace_id = ? AND kind = 'imap'").get(tx.workspaceId) as
    | { id: string; status: 'connected' | 'error'; settings: string; secret: string; updated_at: string }
    | undefined;
  if (!row) return null;
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.settings) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    settings = {};
  }
  return { id: row.id, status: row.status, settings, secret: row.secret, updated_at: row.updated_at };
}

// Connects or updates the IMAP and SMTP connector. It always verifies against the server first and stores what was
// verified. A failed check is saved as an error with the sentence for the failing step; it is not an HTTP error.
export async function configureImapConnector(ctx: ActionContext, input: unknown): Promise<{ connector: ImapConnector; created: boolean }> {
  const data = parseInput(configureSchema, input);
  const stored = getImapInternals(ctx.db, ctx.workspaceId);
  const effective = mergeInput(data, stored);

  const probe = serverSettingsOf(effective, effective.chosenSent);
  let result: VerifyResult;
  try {
    result = await getMailTransport().verify(probe);
  } catch (error) {
    const message = error instanceof Error ? scrubPassword(error.message, effective.password) : 'The check failed.';
    result = {
      imapOk: false,
      smtpOk: false,
      imapFailure: { kind: 'other', message },
      smtpFailure: null,
      mailboxes: [],
      capabilities: { imap: [], smtp: [], smtpStoresSentCopy: null },
      inbox: null,
    };
  }
  const failure = describeVerifyFailure(effective, result);
  const sentMailbox = failure ? null : (effective.chosenSent ?? findSentMailbox(result.mailboxes));
  // A chosen Sent mailbox that does not exist must not wreck a working connector: the logins passed,
  // so the previous Sent mailbox is kept and the mistake is only a sentence, not an error state.
  const chosenMissing = failure !== null && effective.chosenSent !== null && result.imapOk && result.smtpOk;

  const created = mutate(ctx, (tx) => {
    const current = readRow(tx);
    const previousAddress = current ? str(current.settings.address) : null;
    const previousSent = current ? str(current.settings.sentMailbox) : null;
    const addressChanged = previousAddress !== null && previousAddress !== effective.address;
    const softSentFailure = chosenMissing && previousSent !== null && !addressChanged;
    const hardFailure = failure !== null && !softSentFailure;
    const settings: Record<string, unknown> = { ...(current?.settings ?? {}) };
    Object.assign(settings, {
      preset: effective.preset,
      address: effective.address,
      loginName: effective.loginName,
      username: imapUsernameFor(effective.preset, effective.address, effective.loginName),
      smtpUsername: smtpUsernameFor(effective.preset, effective.address, effective.loginName),
      ...effective.servers,
      imapOk: result.imapOk,
      smtpOk: result.smtpOk,
      verifiedAt: tx.now(),
      mailboxes: result.mailboxes.map((mailbox) => ({ path: mailbox.path, specialUse: mailbox.specialUse })),
      capabilities: result.capabilities,
    });
    // A new password is kept only when the checks passed; otherwise the stored one, which may still
    // work, stays, and the sentence says so.
    const passwordOffered = data.appPassword !== undefined;
    const keepStoredPassword = hardFailure && current !== null;
    if (softSentFailure) {
      settings.statusMessage = `The mailbox "${effective.chosenSent}" does not exist on the server, so the Sent mailbox was not changed. Choose one of the mailboxes the server lists.`;
      settings.sentMailbox = previousSent;
      delete settings.lastSyncError;
    } else if (failure) {
      settings.statusMessage =
        keepStoredPassword && passwordOffered
          ? `${failure.sentence} The new app password was not kept; the previous one is still used.`
          : failure.sentence;
      settings.sentMailbox = previousSent;
      settings.sentMailboxSource = current ? settings.sentMailboxSource : null;
    } else {
      delete settings.statusMessage;
      settings.sentMailbox = sentMailbox;
      settings.sentMailboxSource = effective.chosenSent ? 'chosen' : 'detected';
      delete settings.lastSyncError;
    }
    if (addressChanged) {
      // A different mailbox: the old position means nothing, and mail approved to leave from the old address is blocked.
      delete settings.inboxCursor;
      settings.lastSyncAt = null;
      blockWaitingIntentsIn(tx, { provider: 'imap' }, 'The sending inbox changed after this message was approved.');
    }
    // The first poll starts at the Inbox position seen now, so a reply that arrives right after connecting is found.
    if (!hardFailure && result.inbox && (!str(settings.inboxCursor) || addressChanged)) {
      settings.inboxCursor = formatInboxCursor({ uidValidity: result.inbox.uidValidity, lastSeenUid: Math.max(0, result.inbox.uidNext - 1) });
    }
    const status: 'connected' | 'error' = hardFailure ? 'error' : 'connected';
    if (!current) {
      const id = tx.newId('con');
      const now = tx.now();
      tx.db
        .prepare("INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES (?, ?, ?, 'imap', ?, ?, ?, ?)")
        .run(id, now, tx.workspaceId, JSON.stringify(settings), effective.password, status, now);
      tx.audit('connector.configure', 'connector', id, { kind: 'imap', preset: effective.preset, imapOk: result.imapOk, smtpOk: result.smtpOk, status });
    } else {
      const secret = keepStoredPassword ? current.secret : effective.password;
      tx.db
        .prepare('UPDATE connector SET settings = ?, secret = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(settings), secret, status, tx.now(), current.id);
      tx.audit('connector.configure', 'connector', current.id, {
        kind: 'imap',
        preset: effective.preset,
        imapOk: result.imapOk,
        smtpOk: result.smtpOk,
        status,
        passwordReplaced: passwordOffered && !keepStoredPassword,
        addressChanged,
      });
    }
    if (!hardFailure) {
      activateMailProviderIfUnsetIn(tx, 'imap');
      // A working connection with the same address resumes the read only checks of unknown messages.
      // This runs on every successful connect, so it also covers reconnecting after a removal.
      if (!addressChanged) resumeReconcilesIn(tx, 'imap', effective.address);
    }
    return !current;
  });
  return { connector: getConnector(ctx.db, ctx.workspaceId, 'imap')!, created };
}

// Queued and approved messages become blocked. A message that is being submitted, or whose outcome is unknown, keeps its
// state because the email may already be out. The reason is added to its error text. This provider never sends again,
// so no resend marker is needed.
export function disconnectImapConnector(ctx: ActionContext): void {
  if (!getConnector(ctx.db, ctx.workspaceId, 'imap')) throw notFound('IMAP connector');
  mutate(ctx, (tx) => {
    const row = tx.db.prepare("SELECT id FROM connector WHERE workspace_id = ? AND kind = 'imap'").get(tx.workspaceId) as { id: string } | undefined;
    if (!row) throw notFound('IMAP connector');
    const wasActive = getActiveMailConnector(tx.db, tx.workspaceId)?.kind === 'imap';
    const blocked = blockWaitingIntentsIn(tx, { provider: 'imap' }, reasonCodes.connectorRemoved);
    stopRulesForProviderIn(tx, { provider: 'imap' }, 'connector_changed');
    const inFlight = tx.db
      .prepare("SELECT id, status FROM send_intent WHERE workspace_id = ? AND provider = 'imap' AND status IN ('submitting', 'unknown')")
      .all(tx.workspaceId) as { id: string; status: 'submitting' | 'unknown' }[];
    for (const intent of inFlight) {
      transitionIntentIn(tx, intent.id, [intent.status], intent.status, { appendError: reasonCodes.connectorRemoved }, 'connector_removed', {
        reason: reasonCodes.connectorRemoved,
      });
    }
    tx.db.prepare('DELETE FROM connector WHERE id = ?').run(row.id);
    reassignMailProviderAfterRemovalIn(tx, wasActive);
    tx.audit('connector.disconnect', 'connector', row.id, { kind: 'imap', intentsBlocked: blocked, intentsInFlight: inFlight.length });
  });
}

// The server stopped accepting the saved login. Does nothing when the connector is already marked, so the first and most
// specific sentence stays.
export function markImapError(ctx: ActionContext, sentence: string = imapPasswordRejectedSentence): void {
  mutate(ctx, (tx) => {
    const current = readRow(tx);
    if (!current || current.status === 'error') return;
    const settings = { ...current.settings, statusMessage: sentence };
    tx.db.prepare('UPDATE connector SET settings = ?, status = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(settings), 'error', tx.now(), current.id);
    tx.audit('connector.error', 'connector', current.id, { kind: 'imap' });
  });
}

// The connection settings the adapter needs, read from the saved connector. Null when the connector is incomplete.
export function readImapServerSettings(ctx: ActionContext): { settings: MailServerSettings; smtpStoresSentCopy: boolean | null } | null {
  const internals = getImapInternals(ctx.db, ctx.workspaceId);
  if (!internals?.password) return null;
  const s = internals.settings;
  const preset = s.preset === 'icloud' || s.preset === 'fastmail' || s.preset === 'custom' ? s.preset : null;
  const address = str(s.address);
  const imapHost = str(s.imapHost);
  const smtpHost = str(s.smtpHost);
  const imapPort = num(s.imapPort);
  const smtpPort = num(s.smtpPort);
  const smtpTls = s.smtpTls === 'tls' || s.smtpTls === 'starttls' ? s.smtpTls : null;
  if (!preset || !address || !imapHost || !smtpHost || imapPort === null || smtpPort === null || !smtpTls) return null;
  const capabilities = typeof s.capabilities === 'object' && s.capabilities !== null ? (s.capabilities as Record<string, unknown>) : {};
  return {
    settings: serverSettingsOf(
      { preset, address, password: internals.password, loginName: str(s.loginName), servers: { imapHost, imapPort, smtpHost, smtpPort, smtpTls } },
      str(s.sentMailbox),
    ),
    smtpStoresSentCopy: typeof capabilities.smtpStoresSentCopy === 'boolean' ? capabilities.smtpStoresSentCopy : null,
  };
}
