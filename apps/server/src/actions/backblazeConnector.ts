import { readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { backupDatabase } from '../backup.js';
import { AppError, notFound, validationError } from '../errors.js';
import {
  authorizeAccount,
  type B2Authorization,
  BackblazeError,
  deleteFileVersion,
  getUploadUrl,
  listBuckets,
  listFileNames,
  uploadFile,
} from '../providers/backblaze.js';
import { type BackblazeConnector, defaultBackblazeKeep, getConnector, getConnectorSecret } from '../queries/connectors.js';
import { type ActionContext, mutate, parseInput } from './context.js';

export const connectBackblazeMessage = 'Backblaze is not connected. Connect Backblaze in Settings first.';
export const backblazeKeyRejectedMessage = 'Backblaze rejected the saved application key. Enter a new one to reconnect.';

const remotePrefix = 'agentcrm/';
const requiredCapabilities = ['writeFiles', 'listFiles', 'deleteFiles'] as const;
const hourMilliseconds = 3_600_000;
const dayMilliseconds = 24 * hourMilliseconds;
const throttleMilliseconds = 60_000;

// agentcrm-backup-20260301T090000Z.db, or ...Z-2.db when two snapshots share a second.
const backupNamePattern = /^agentcrm-backup-(\d{8}T\d{6}Z)(?:-(\d+))?\.db$/;

function backupOrder(name: string): [string, number] {
  const match = backupNamePattern.exec(name);
  return [match?.[1] ?? '', match?.[2] ? Number(match[2]) : 1];
}

// Oldest first. The attempt number is compared as a number, because "Z-2.db" sorts before "Z.db" as text.
function compareBackupNames(a: string, b: string): number {
  const [stampA, attemptA] = backupOrder(a);
  const [stampB, attemptB] = backupOrder(b);
  return stampA < stampB ? -1 : stampA > stampB ? 1 : attemptA - attemptB;
}

const configureSchema = z
  .object({
    keyId: z.string().trim().min(1).max(200).optional(),
    applicationKey: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((value) => !/\s/.test(value), 'Application key must not contain spaces')
      .optional(),
    bucketName: z.string().trim().min(1).max(200).optional(),
    keep: z.number().int('Keep must be a whole number').min(1, 'Keep must be at least 1').max(365, 'Keep must be 365 or fewer').optional(),
  })
  .strict();

// Turns a provider failure into the standard error envelope. The message never carries the key.
function mapBackblazeError(error: unknown): AppError {
  if (!(error instanceof BackblazeError)) return new AppError('internal', 'Something went wrong while talking to Backblaze.');
  switch (error.kind) {
    case 'unauthorized':
    case 'expired_token':
      return new AppError('conflict', 'Backblaze did not accept the saved application key. Update it in Settings.');
    case 'rejected':
      return new AppError('conflict', error.message);
    case 'timeout':
      return new AppError('internal', 'Backblaze did not answer in time. Try again.', { status: 504 });
    case 'network':
    case 'server':
      return new AppError('internal', 'Could not reach Backblaze. Check your connection and try again.', { status: 502 });
    case 'bad_response':
      return new AppError('internal', 'Backblaze sent a response this app could not read.', { status: 502 });
  }
}

interface Resolved {
  bucketId: string;
  bucketName: string;
}

async function authorizeAndResolve(keyId: string, applicationKey: string, wantedBucket: string | undefined): Promise<Resolved> {
  let auth: B2Authorization;
  try {
    auth = await authorizeAccount(keyId, applicationKey);
  } catch (error) {
    if (error instanceof BackblazeError && (error.kind === 'unauthorized' || (error.kind === 'rejected' && error.status === 400))) {
      throw validationError('Backblaze did not accept this key ID and application key. Check them and try again.');
    }
    throw mapBackblazeError(error);
  }
  const missing = requiredCapabilities.filter((name) => !auth.capabilities.includes(name));
  if (missing.length > 0) {
    throw validationError(`applicationKey: This key cannot do the nightly backup. It is missing: ${missing.join(', ')}.`);
  }
  if (auth.bucketId && auth.bucketName) {
    if (wantedBucket !== undefined && wantedBucket !== auth.bucketName) {
      throw validationError(`bucketName: This key can only use the bucket "${auth.bucketName}", not "${wantedBucket}".`);
    }
    return { bucketId: auth.bucketId, bucketName: auth.bucketName };
  }
  if (!wantedBucket) throw validationError('bucketName: A bucket name is required to connect Backblaze.');
  let buckets;
  try {
    buckets = await listBuckets(auth, wantedBucket);
  } catch (error) {
    if (error instanceof BackblazeError && error.kind === 'rejected') throw validationError(`bucketName: ${error.message}`);
    throw mapBackblazeError(error);
  }
  const found = buckets.find((bucket) => bucket.bucketName === wantedBucket);
  if (!found) throw validationError(`bucketName: Backblaze has no bucket named "${wantedBucket}" on this account.`);
  return found;
}

export async function configureBackblazeConnector(
  ctx: ActionContext,
  input: unknown,
): Promise<{ connector: BackblazeConnector; created: boolean }> {
  const data = parseInput(configureSchema, input);
  const existing = getConnector(ctx.db, ctx.workspaceId, 'backblaze');
  if ((data.keyId === undefined) !== (data.applicationKey === undefined)) {
    throw validationError('Send the key ID and the application key together.');
  }
  const keyChange = data.keyId !== undefined && data.applicationKey !== undefined;
  if (!existing) {
    if (!keyChange) throw validationError('keyId: A key ID and an application key are required to connect Backblaze.');
    if (data.bucketName === undefined) throw validationError('bucketName: A bucket name is required to connect Backblaze.');
  } else if (!keyChange && data.bucketName === undefined && data.keep === undefined) {
    throw validationError('Send a key, a bucket name, a keep count, or any mix of them.');
  }

  // A key change, or a new bucket name on a saved key, is checked against B2 before anything is stored.
  let resolved: Resolved | null = null;
  if (keyChange) {
    resolved = await authorizeAndResolve(data.keyId!, data.applicationKey!, data.bucketName);
  } else if (existing && data.bucketName !== undefined && data.bucketName !== existing.settings.bucketName) {
    const secret = getConnectorSecret(ctx.db, ctx.workspaceId, 'backblaze') ?? '';
    resolved = await authorizeAndResolve(existing.settings.keyId ?? '', secret, data.bucketName);
  }

  const save = (): boolean =>
    mutate(ctx, (tx) => {
      const current = getConnector(tx.db, tx.workspaceId, 'backblaze');
      if (!current && !keyChange) throw validationError('keyId: A key ID and an application key are required to connect Backblaze.');
      const now = tx.now();
      const keep = data.keep ?? current?.settings.keep ?? defaultBackblazeKeep;
      const bucketChanged = resolved !== null && resolved.bucketId !== (current?.settings.bucketId ?? null);
      const row = current
        ? (tx.db.prepare('SELECT settings FROM connector WHERE id = ?').get(current.id) as { settings: string })
        : null;
      const stored = row ? (JSON.parse(row.settings) as Record<string, unknown>) : {};
      const settings: Record<string, unknown> = {
        keyId: keyChange ? data.keyId : (current?.settings.keyId ?? null),
        bucketId: resolved?.bucketId ?? current?.settings.bucketId ?? null,
        bucketName: resolved?.bucketName ?? current?.settings.bucketName ?? null,
        keep,
        // Results from another bucket say nothing about this one, so a new bucket starts clean and a backup is due.
        // A new key clears the attempt and result too, so a fresh key never waits out a backoff earned by the old one.
        lastAttemptAt: bucketChanged || keyChange ? null : (current?.settings.lastAttemptAt ?? null),
        lastSuccessAt: bucketChanged ? null : (current?.settings.lastSuccessAt ?? null),
        lastResult: bucketChanged || keyChange ? null : (current?.settings.lastResult ?? null),
        runRequestedAt: current?.settings.runRequestedAt ?? null,
        statusMessage: keyChange ? null : (stored.statusMessage ?? null),
      };
      if (current) {
        if (keyChange) {
          tx.db
            .prepare("UPDATE connector SET settings = ?, secret = ?, status = 'connected', updated_at = ? WHERE id = ?")
            .run(JSON.stringify(settings), data.applicationKey, now, current.id);
        } else {
          tx.db.prepare('UPDATE connector SET settings = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(settings), now, current.id);
        }
        tx.audit('connector.configure', 'connector', current.id, {
          kind: 'backblaze',
          keyReplaced: keyChange,
          bucketName: settings.bucketName,
          keep,
        });
        return false;
      }
      const created = tx.newId('con');
      tx.db
        .prepare(
          "INSERT INTO connector (id, created_at, workspace_id, kind, settings, secret, status, updated_at) VALUES (?, ?, ?, 'backblaze', ?, ?, 'connected', ?)",
        )
        .run(created, now, tx.workspaceId, JSON.stringify(settings), data.applicationKey ?? '', now);
      tx.audit('connector.configure', 'connector', created, { kind: 'backblaze', keyReplaced: true, bucketName: settings.bucketName, keep });
      return true;
    });
  let created: boolean;
  try {
    created = save();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('internal', 'The key is valid, but it could not be saved to the local database.');
  }
  return { connector: getConnector(ctx.db, ctx.workspaceId, 'backblaze')!, created };
}

// Removes the row and the key. Nothing already uploaded is touched.
export function disconnectBackblazeConnector(ctx: ActionContext): void {
  mutate(ctx, (tx) => {
    const row = tx.db.prepare('SELECT id FROM connector WHERE workspace_id = ? AND kind = ?').get(tx.workspaceId, 'backblaze') as
      | { id: string }
      | undefined;
    if (!row) throw notFound('Backblaze connector');
    tx.db.prepare('DELETE FROM connector WHERE id = ?').run(row.id);
    tx.audit('connector.disconnect', 'connector', row.id, { kind: 'backblaze' });
  });
}

function patchSettingsIn(tx: { db: ActionContext['db'] }, id: string, patch: Record<string, unknown>): void {
  const row = tx.db.prepare('SELECT settings FROM connector WHERE id = ?').get(id) as { settings: string } | undefined;
  if (!row) return;
  const settings = { ...(JSON.parse(row.settings) as Record<string, unknown>), ...patch };
  tx.db.prepare('UPDATE connector SET settings = ? WHERE id = ?').run(JSON.stringify(settings), id);
}

// The in memory throttle: the worker asks at most once a minute per workspace.
const lastCheck = new Map<string, number>();
const running = new Set<string>();

// Tests call this between cases.
export function resetBackupThrottle(): void {
  lastCheck.clear();
  running.clear();
}

// Marks a backup requested. The next worker tick runs it, because the throttle is cleared here.
export function requestBackup(ctx: ActionContext): void {
  mutate(ctx, (tx) => {
    const row = tx.db.prepare('SELECT id, status FROM connector WHERE workspace_id = ? AND kind = ?').get(tx.workspaceId, 'backblaze') as
      | { id: string; status: string }
      | undefined;
    if (!row) throw validationError(connectBackblazeMessage);
    if (row.status === 'error') throw validationError('Backblaze rejected the saved application key. Enter a new one before backing up.');
    patchSettingsIn(tx, row.id, { runRequestedAt: tx.now() });
    tx.emit({ type: 'record_updated', entityType: 'connector', entityId: row.id });
  });
  lastCheck.delete(ctx.workspaceId);
}

export interface BackupRunResult {
  ok: boolean;
  fileName?: string;
  bytes?: number;
  error?: string;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// A timestamp in the future counts as unparseable, so a stepped clock never stalls backups: a future success means
// due, and a future attempt means no backoff.
function isDue(connector: BackblazeConnector, now: number): boolean {
  if (connector.status !== 'connected') return false;
  const settings = connector.settings;
  if (settings.runRequestedAt) return true;
  if (settings.lastResult?.ok === false) {
    const attempted = parseTime(settings.lastAttemptAt);
    if (attempted !== null && attempted <= now && now < attempted + hourMilliseconds) return false;
  }
  const succeeded = parseTime(settings.lastSuccessAt);
  return succeeded === null || succeeded > now || now - succeeded > dayMilliseconds;
}

function failureSentence(error: unknown, secrets: string[]): string {
  let sentence: string;
  if (error instanceof BackblazeError) {
    if (error.kind === 'network') sentence = 'Could not reach Backblaze.';
    else if (error.kind === 'timeout') sentence = 'Backblaze did not answer in time.';
    else sentence = error.message;
    sentence = `The backup did not upload: ${sentence}`;
  } else if (error instanceof AppError) {
    sentence = `The backup could not be made: ${error.message}`;
  } else {
    sentence = 'The backup failed for a reason this app did not expect.';
  }
  for (const secret of secrets) if (secret.length > 0) sentence = sentence.split(secret).join('[hidden]');
  return sentence;
}

function retryable(error: unknown): boolean {
  return error instanceof BackblazeError && (error.kind === 'expired_token' || error.kind === 'server');
}

async function uploadWithRetry(auth: B2Authorization, bucketId: string, fileName: string, bytes: Buffer): Promise<void> {
  const attempt = async (): Promise<void> => {
    const target = await getUploadUrl(auth, bucketId);
    await uploadFile(target, fileName, bytes);
  };
  try {
    await attempt();
  } catch (error) {
    if (!retryable(error)) throw error;
    await attempt();
  }
}

// Returns an error sentence when pruning failed, otherwise null. Never throws. The file this run just uploaded is
// never a deletion candidate and counts among the kept files, so a stepped clock cannot make a run delete its own
// upload.
async function prune(auth: B2Authorization, bucketId: string, directory: string, keep: number, uploadedFileName: string): Promise<string | null> {
  const problems: string[] = [];
  const keepOthers = Math.max(0, keep - 1);
  try {
    const remote = (await listFileNames(auth, bucketId, remotePrefix))
      .filter((file) => file.fileName !== uploadedFileName)
      .filter((file) => file.fileName.startsWith(remotePrefix) && backupNamePattern.test(file.fileName.slice(remotePrefix.length)))
      .sort((a, b) => compareBackupNames(a.fileName.slice(remotePrefix.length), b.fileName.slice(remotePrefix.length)));
    for (const file of remote.slice(0, Math.max(0, remote.length - keepOthers))) await deleteFileVersion(auth, file);
  } catch (error) {
    problems.push(error instanceof BackblazeError ? `could not remove old uploads (${error.message.replace(/[.!?]+$/, '')})` : 'could not remove old uploads');
  }
  try {
    const uploadedBase = path.basename(uploadedFileName);
    const local = readdirSync(directory)
      .filter((name) => name !== uploadedBase && backupNamePattern.test(name))
      .sort(compareBackupNames);
    for (const name of local.slice(0, Math.max(0, local.length - keepOthers))) rmSync(path.join(directory, name), { force: true });
  } catch {
    problems.push('could not remove old local snapshots');
  }
  return problems.length > 0 ? `The backup uploaded, but ${problems.join(' and ')}.` : null;
}

async function runBackup(ctx: ActionContext, connector: BackblazeConnector, applicationKey: string): Promise<BackupRunResult> {
  const keyId = connector.settings.keyId ?? '';
  const bucketId = connector.settings.bucketId ?? '';
  const directory = path.join(path.dirname(ctx.db.name), 'backups', 'auto');
  let result: BackupRunResult;
  let rejectedKey = false;
  try {
    let auth: B2Authorization;
    try {
      auth = await authorizeAccount(keyId, applicationKey);
    } catch (error) {
      if (error instanceof BackblazeError && error.kind === 'unauthorized') rejectedKey = true;
      throw error;
    }
    const snapshot = await backupDatabase({ databasePath: ctx.db.name, directory, now: () => new Date(ctx.now()) });
    const fileName = `${remotePrefix}${path.basename(snapshot.path)}`;
    try {
      await uploadWithRetry(auth, bucketId, fileName, readFileSync(snapshot.path));
    } catch (error) {
      // A snapshot that never reached the bucket is not kept, so a long outage does not fill the folder.
      rmSync(snapshot.path, { force: true });
      throw error;
    }
    const pruneProblem = await prune(auth, bucketId, directory, connector.settings.keep, fileName);
    result = { ok: true, fileName, bytes: snapshot.bytes, ...(pruneProblem ? { error: pruneProblem } : {}) };
  } catch (error) {
    result = { ok: false, error: failureSentence(rejectedKey ? new BackblazeError('unauthorized', 'Backblaze rejected the saved application key.') : error, [applicationKey]) };
    if (rejectedKey) result.error = backblazeKeyRejectedMessage;
  }

  mutate(ctx, (tx) => {
    const row = tx.db.prepare('SELECT id, secret FROM connector WHERE workspace_id = ? AND kind = ?').get(tx.workspaceId, 'backblaze') as
      | { id: string; secret: string }
      | undefined;
    if (!row) return;
    const at = tx.now();
    const lastResult = { at, ok: result.ok, ...(result.fileName ? { fileName: result.fileName } : {}), ...(result.bytes !== undefined ? { bytes: result.bytes } : {}), ...(result.error ? { error: result.error } : {}) };
    patchSettingsIn(tx, row.id, {
      lastAttemptAt: at,
      ...(result.ok ? { lastSuccessAt: at } : {}),
      lastResult,
      runRequestedAt: null,
      // A key that was replaced while this run was going is not marked bad.
      ...(rejectedKey && row.secret === applicationKey ? { statusMessage: backblazeKeyRejectedMessage } : {}),
    });
    if (rejectedKey && row.secret === applicationKey) {
      tx.db.prepare("UPDATE connector SET status = 'error', updated_at = ? WHERE id = ?").run(at, row.id);
    }
    tx.audit('backup.run', 'connector', row.id, {
      ok: result.ok,
      ...(result.fileName ? { fileName: result.fileName } : {}),
      ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    tx.emit({ type: 'record_updated', entityType: 'connector', entityId: row.id });
  });
  return result;
}

// The worker calls this on every tick. It looks at most once a minute, and runs only when a backup is due.
export async function runBackupIfDue(ctx: ActionContext): Promise<BackupRunResult | null> {
  const last = lastCheck.get(ctx.workspaceId) ?? 0;
  if (Date.now() - last < throttleMilliseconds) return null;
  lastCheck.set(ctx.workspaceId, Date.now());
  if (running.has(ctx.workspaceId)) return null;
  const connector = getConnector(ctx.db, ctx.workspaceId, 'backblaze');
  const secret = getConnectorSecret(ctx.db, ctx.workspaceId, 'backblaze');
  if (!connector || !secret || !connector.settings.bucketId) return null;
  const now = parseTime(ctx.now());
  if (now === null || !isDue(connector, now)) return null;
  running.add(ctx.workspaceId);
  try {
    return await runBackup(ctx, connector, secret);
  } finally {
    running.delete(ctx.workspaceId);
  }
}
