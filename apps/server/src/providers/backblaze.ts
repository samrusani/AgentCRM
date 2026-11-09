import { createHash } from 'node:crypto';

// Backblaze B2 native API, version 2. Nothing from an authorize response is stored: every backup run authorizes again.
export const defaultB2Base = 'https://api.backblazeb2.com';

export function b2BaseUrl(): string {
  const raw = process.env.AGENTCRM_B2_BASE;
  return (raw && raw.length > 0 ? raw : defaultB2Base).replace(/\/+$/, '');
}

const requestTimeoutMilliseconds = 30_000;
const uploadTimeoutMilliseconds = 300_000;

export type BackblazeErrorKind = 'unauthorized' | 'expired_token' | 'rejected' | 'server' | 'timeout' | 'network' | 'bad_response';

// Messages are written here or come from B2 with the application key scrubbed out.
export class BackblazeError extends Error {
  readonly kind: BackblazeErrorKind;
  readonly status: number | null;
  readonly code: string | null;

  constructor(kind: BackblazeErrorKind, message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.name = 'BackblazeError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export interface B2Authorization {
  accountId: string;
  apiUrl: string;
  authorizationToken: string;
  capabilities: string[];
  // Set when the key is restricted to one bucket.
  bucketId: string | null;
  bucketName: string | null;
  // Everything that must never appear in a sentence built from a B2 response: the application key, the Basic pair, the tokens.
  secrets: string[];
}

export interface B2Bucket {
  bucketId: string;
  bucketName: string;
}

export interface B2UploadTarget {
  uploadUrl: string;
  authorizationToken: string;
  secrets?: string[];
}

export interface B2FileVersion {
  fileId: string;
  fileName: string;
}

function scrub(message: string, secrets: string[]): string {
  let result = message;
  for (const secret of secrets) if (secret.length > 0) result = result.split(secret).join('[hidden]');
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function send(url: string, init: RequestInit, secrets: string[], timeout = requestTimeoutMilliseconds): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new BackblazeError('timeout', 'Backblaze did not answer in time.');
    }
    throw new BackblazeError('network', 'Could not reach Backblaze.');
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok) {
    if (!isObject(body)) throw new BackblazeError('bad_response', 'Backblaze sent a response this app could not read.', response.status);
    return body;
  }
  const code = isObject(body) && typeof body.code === 'string' ? body.code : null;
  const detail = isObject(body) && typeof body.message === 'string' ? scrub(body.message, secrets).slice(0, 300) : '';
  const message = detail || `Backblaze answered with status ${response.status}.`;
  if (response.status === 401) {
    const expired = code === 'expired_auth_token' || code === 'bad_auth_token';
    throw new BackblazeError(expired ? 'expired_token' : 'unauthorized', message, 401, code);
  }
  if (response.status >= 500) throw new BackblazeError('server', message, response.status, code);
  throw new BackblazeError('rejected', message, response.status, code);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export async function authorizeAccount(keyId: string, applicationKey: string): Promise<B2Authorization> {
  const basic = Buffer.from(`${keyId}:${applicationKey}`).toString('base64');
  let body: Record<string, unknown>;
  try {
    body = (await send(
      `${b2BaseUrl()}/b2api/v2/b2_authorize_account`,
      { method: 'GET', headers: { authorization: `Basic ${basic}` } },
      [applicationKey, basic],
    )) as Record<string, unknown>;
  } catch (error) {
    // Any 401 here means the key itself was refused, whatever code B2 gives.
    if (error instanceof BackblazeError && error.kind === 'expired_token') throw new BackblazeError('unauthorized', error.message, 401, error.code);
    throw error;
  }
  const allowed = isObject(body.allowed) ? body.allowed : {};
  if (typeof body.apiUrl !== 'string' || typeof body.authorizationToken !== 'string' || typeof body.accountId !== 'string') {
    throw new BackblazeError('bad_response', 'Backblaze sent a response this app could not read.');
  }
  return {
    accountId: body.accountId,
    apiUrl: body.apiUrl.replace(/\/+$/, ''),
    authorizationToken: body.authorizationToken,
    capabilities: stringList(allowed.capabilities),
    bucketId: typeof allowed.bucketId === 'string' ? allowed.bucketId : null,
    bucketName: typeof allowed.bucketName === 'string' ? allowed.bucketName : null,
    secrets: [applicationKey, basic, body.authorizationToken],
  };
}

async function call(auth: B2Authorization, operation: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await send(
    `${auth.apiUrl}/b2api/v2/${operation}`,
    { method: 'POST', headers: { authorization: auth.authorizationToken, 'content-type': 'application/json' }, body: JSON.stringify(payload) },
    [auth.authorizationToken, ...auth.secrets],
  )) as Record<string, unknown>;
}

export async function listBuckets(auth: B2Authorization, bucketName?: string): Promise<B2Bucket[]> {
  const body = await call(auth, 'b2_list_buckets', { accountId: auth.accountId, ...(bucketName ? { bucketName } : {}) });
  const buckets = Array.isArray(body.buckets) ? body.buckets : [];
  return buckets.flatMap((item) =>
    isObject(item) && typeof item.bucketId === 'string' && typeof item.bucketName === 'string'
      ? [{ bucketId: item.bucketId, bucketName: item.bucketName }]
      : [],
  );
}

export async function getUploadUrl(auth: B2Authorization, bucketId: string): Promise<B2UploadTarget> {
  const body = await call(auth, 'b2_get_upload_url', { bucketId });
  if (typeof body.uploadUrl !== 'string' || typeof body.authorizationToken !== 'string') {
    throw new BackblazeError('bad_response', 'Backblaze sent a response this app could not read.');
  }
  return { uploadUrl: body.uploadUrl, authorizationToken: body.authorizationToken, secrets: [...auth.secrets, body.authorizationToken] };
}

export function sha1Hex(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

export async function uploadFile(target: B2UploadTarget, fileName: string, bytes: Buffer): Promise<{ fileId: string | null }> {
  const body = (await send(
    target.uploadUrl,
    {
      method: 'POST',
      headers: {
        authorization: target.authorizationToken,
        'x-bz-file-name': encodeURIComponent(fileName).replace(/%2F/g, '/'),
        'content-type': 'b2/x-auto',
        'content-length': String(bytes.length),
        'x-bz-content-sha1': sha1Hex(bytes),
      },
      body: bytes,
    },
    [target.authorizationToken, ...(target.secrets ?? [])],
    uploadTimeoutMilliseconds,
  )) as Record<string, unknown>;
  return { fileId: typeof body.fileId === 'string' ? body.fileId : null };
}

// Every file version under the prefix, following the paging.
export async function listFileNames(auth: B2Authorization, bucketId: string, prefix: string): Promise<B2FileVersion[]> {
  const found: B2FileVersion[] = [];
  let startFileName: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const body: Record<string, unknown> = await call(auth, 'b2_list_file_names', {
      bucketId,
      prefix,
      maxFileCount: 1000,
      ...(startFileName ? { startFileName } : {}),
    });
    const files = Array.isArray(body.files) ? body.files : [];
    for (const item of files) {
      if (isObject(item) && typeof item.fileId === 'string' && typeof item.fileName === 'string') {
        found.push({ fileId: item.fileId, fileName: item.fileName });
      }
    }
    if (typeof body.nextFileName !== 'string' || body.nextFileName === '') break;
    startFileName = body.nextFileName;
  }
  return found;
}

export async function deleteFileVersion(auth: B2Authorization, file: B2FileVersion): Promise<void> {
  await call(auth, 'b2_delete_file_version', { fileName: file.fileName, fileId: file.fileId });
}
