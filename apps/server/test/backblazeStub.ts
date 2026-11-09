import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const stubKeyId = '0051234567890abcdef000000001';
export const stubApplicationKey = 'K005abcdefghijklmnopqrstuvwxyz1234';
export const stubBucketId = 'bkt_main_0001';
export const stubBucketName = 'agentcrm-backups';

export interface StubKey {
  keyId: string;
  applicationKey: string;
  capabilities: string[];
  // Set to make the key bucket restricted.
  bucket?: { id: string; name: string };
}

export interface StubFile {
  fileId: string;
  fileName: string;
  bytes: Buffer;
}

export interface StubUpload {
  fileName: string;
  contentType: string | undefined;
  contentLength: string | undefined;
  declaredSha1: string | undefined;
  actualSha1: string;
  authorization: string | undefined;
  size: number;
}

export interface Backblaze {
  origin: string;
  keys: StubKey[];
  buckets: { id: string; name: string }[];
  files: StubFile[];
  uploads: StubUpload[];
  authorizations: number;
  uploadUrlRequests: number;
  deletes: string[];
  // Statuses the next uploads answer with, one per upload.
  uploadFailures: number[];
  // When set, b2_delete_file_version answers 500.
  failDeletes: boolean;
  // When set, authorize answers 401 for every key.
  rejectAuthorize: boolean;
  reset: () => void;
  close: () => Promise<void>;
}

const allCapabilities = ['listKeys', 'writeKeys', 'deleteKeys', 'listBuckets', 'listFiles', 'readFiles', 'shareFiles', 'writeFiles', 'deleteFiles'];

export function defaultKeys(): StubKey[] {
  return [{ keyId: stubKeyId, applicationKey: stubApplicationKey, capabilities: allCapabilities }];
}

export async function startBackblazeStub(): Promise<Backblaze> {
  let counter = 0;
  const stub: Backblaze = {
    origin: '',
    keys: defaultKeys(),
    buckets: [{ id: stubBucketId, name: stubBucketName }],
    files: [],
    uploads: [],
    authorizations: 0,
    uploadUrlRequests: 0,
    deletes: [],
    uploadFailures: [],
    failDeletes: false,
    rejectAuthorize: false,
    reset: () => {
      stub.keys = defaultKeys();
      stub.buckets = [{ id: stubBucketId, name: stubBucketName }];
      stub.files = [];
      stub.uploads = [];
      stub.authorizations = 0;
      stub.uploadUrlRequests = 0;
      stub.deletes = [];
      stub.uploadFailures = [];
      stub.failDeletes = false;
      stub.rejectAuthorize = false;
    },
    close: () => Promise.resolve(),
  };

  const json = (response: http.ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const fail = (response: http.ServerResponse, status: number, code: string, message: string): void =>
    json(response, status, { status, code, message });

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? '/', stub.origin);
      if (url.pathname === '/b2api/v2/b2_authorize_account') {
        stub.authorizations += 1;
        const [keyId, applicationKey] = Buffer.from((request.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString().split(':');
        const key = stub.keys.find((candidate) => candidate.keyId === keyId && candidate.applicationKey === applicationKey);
        if (!key || stub.rejectAuthorize) return fail(response, 401, 'bad_auth_token', 'Invalid credentials.');
        return json(response, 200, {
          accountId: 'acct_001',
          authorizationToken: 'account-token',
          apiUrl: stub.origin,
          allowed: {
            capabilities: key.capabilities,
            bucketId: key.bucket?.id ?? null,
            bucketName: key.bucket?.name ?? null,
            namePrefix: null,
          },
        });
      }
      if (url.pathname.startsWith('/upload/')) {
        const failure = stub.uploadFailures.shift();
        if (failure !== undefined) {
          return failure === 401
            ? fail(response, 401, 'expired_auth_token', 'Upload token expired.')
            : fail(response, failure, 'service_unavailable', 'No tomes available.');
        }
        const header = (name: string): string | undefined => {
          const value = request.headers[name];
          return Array.isArray(value) ? value[0] : value;
        };
        const fileName = decodeURIComponent(header('x-bz-file-name') ?? '');
        const upload: StubUpload = {
          fileName,
          contentType: header('content-type'),
          contentLength: header('content-length'),
          declaredSha1: header('x-bz-content-sha1'),
          actualSha1: createHash('sha1').update(body).digest('hex'),
          authorization: header('authorization'),
          size: body.length,
        };
        stub.uploads.push(upload);
        counter += 1;
        const fileId = `file_${counter}`;
        stub.files.push({ fileId, fileName, bytes: body });
        return json(response, 200, { fileId, fileName, contentSha1: upload.actualSha1 });
      }
      if (request.headers.authorization !== 'account-token') return fail(response, 401, 'bad_auth_token', 'Bad token.');
      const payload = body.length > 0 ? (JSON.parse(body.toString()) as Record<string, any>) : {};
      if (url.pathname === '/b2api/v2/b2_list_buckets') {
        if (payload.bucketName !== undefined) {
          const found = stub.buckets.filter((bucket) => bucket.name === payload.bucketName);
          if (found.length === 0) return fail(response, 400, 'bad_request', `Bucket ${payload.bucketName} does not exist in this account.`);
          return json(response, 200, { buckets: found.map((bucket) => ({ bucketId: bucket.id, bucketName: bucket.name })) });
        }
        return json(response, 200, { buckets: stub.buckets.map((bucket) => ({ bucketId: bucket.id, bucketName: bucket.name })) });
      }
      if (url.pathname === '/b2api/v2/b2_get_upload_url') {
        stub.uploadUrlRequests += 1;
        return json(response, 200, { bucketId: payload.bucketId, uploadUrl: `${stub.origin}/upload/${stub.uploadUrlRequests}`, authorizationToken: `upload-token-${stub.uploadUrlRequests}` });
      }
      if (url.pathname === '/b2api/v2/b2_list_file_names') {
        const files = stub.files
          .filter((file) => file.fileName.startsWith(String(payload.prefix ?? '')))
          .sort((a, b) => (a.fileName < b.fileName ? -1 : 1))
          .map((file) => ({ fileId: file.fileId, fileName: file.fileName, contentLength: file.bytes.length }));
        return json(response, 200, { files, nextFileName: null });
      }
      if (url.pathname === '/b2api/v2/b2_delete_file_version') {
        if (stub.failDeletes) return fail(response, 500, 'internal_error', 'Delete failed.');
        stub.files = stub.files.filter((file) => file.fileId !== payload.fileId);
        stub.deletes.push(String(payload.fileName));
        return json(response, 200, { fileId: payload.fileId, fileName: payload.fileName });
      }
      return fail(response, 404, 'not_found', 'No such call.');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  stub.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}

export function useBackblazeStub(stub: Backblaze): () => void {
  const previous = process.env.AGENTCRM_B2_BASE;
  process.env.AGENTCRM_B2_BASE = stub.origin;
  return () => {
    if (previous === undefined) delete process.env.AGENTCRM_B2_BASE;
    else process.env.AGENTCRM_B2_BASE = previous;
  };
}
