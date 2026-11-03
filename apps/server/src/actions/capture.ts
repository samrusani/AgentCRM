import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.js';
import { AppError, validationError } from '../errors.js';
import { readSettings } from '../qualification/config.js';
import { splitName } from './apifyMapping.js';
import { type ActionContext, emitRecord, mutate, parseInput, type Tx } from './context.js';
import { createActivityIn, createFieldClaimIn, createPersonIn } from './crud.js';
import { normalizeProfileUrl } from './leadCaptureMapping.js';

// Capture token

interface CaptureSettings {
  tokenHash: string;
  createdAt: string;
}

const tokenHashPattern = /^[0-9a-f]{64}$/;

function readCapture(db: Db, workspaceId: string): CaptureSettings | null {
  const saved = readSettings(db, workspaceId).capture;
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return null;
  const { tokenHash, createdAt } = saved as Record<string, unknown>;
  if (typeof tokenHash !== 'string' || !tokenHashPattern.test(tokenHash) || typeof createdAt !== 'string') return null;
  return { tokenHash, createdAt };
}

function writeCaptureIn(tx: Tx, capture: CaptureSettings | null): void {
  const settings = { ...readSettings(tx.db, tx.workspaceId) };
  if (capture === null) delete settings.capture;
  else settings.capture = capture;
  tx.db.prepare('UPDATE workspace SET settings = ? WHERE id = ?').run(JSON.stringify(settings), tx.workspaceId);
}

const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export function getCaptureSettings(ctx: Pick<ActionContext, 'db' | 'workspaceId'>): { configured: boolean; createdAt: string | null } {
  const capture = readCapture(ctx.db, ctx.workspaceId);
  return { configured: capture !== null, createdAt: capture ? capture.createdAt : null };
}

// Creates the token, or replaces it. The plaintext leaves the server once, in this return value.
export function generateCaptureToken(ctx: ActionContext): { token: string; createdAt: string } {
  const token = `cap_${randomBytes(32).toString('base64url')}`;
  return mutate(ctx, (tx) => {
    const createdAt = tx.now();
    const rotated = readCapture(tx.db, tx.workspaceId) !== null;
    writeCaptureIn(tx, { tokenHash: hashToken(token), createdAt });
    tx.audit('capture.token_generate', 'workspace', tx.workspaceId, { rotated });
    emitRecord(tx, 'capture_settings', tx.workspaceId);
    return { token, createdAt };
  });
}

export function removeCaptureToken(ctx: ActionContext): void {
  mutate(ctx, (tx) => {
    if (readCapture(tx.db, tx.workspaceId) === null) return;
    writeCaptureIn(tx, null);
    tx.audit('capture.token_remove', 'workspace', tx.workspaceId, {});
    emitRecord(tx, 'capture_settings', tx.workspaceId);
  });
}

// "Bearer <token>" with a case insensitive scheme. Anything else gives null.
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

const unauthorizedMessage = 'A valid capture token is required. Copy it from Settings into the extension options.';

export function verifyCaptureToken(db: Db, workspaceId: string, presented: string | null | undefined): void {
  const capture = readCapture(db, workspaceId);
  if (!capture) {
    throw new AppError('unauthorized', 'No capture token is set up. Generate one in Settings first.');
  }
  if (!presented) throw new AppError('unauthorized', unauthorizedMessage);
  // Both sides are SHA-256 digests, so the buffers always have the same length.
  const given = Buffer.from(hashToken(presented), 'hex');
  const stored = Buffer.from(capture.tokenHash, 'hex');
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
    throw new AppError('unauthorized', unauthorizedMessage);
  }
}

// URL canonicalization

export const linkedinCaptureUrlMessage =
  'The LinkedIn link must be a profile link such as https://www.linkedin.com/in/example.';
export const xCaptureUrlMessage =
  'The X link must be a profile link such as https://x.com/example, with a handle of 1 to 15 letters, numbers, or underscores.';

const reservedXPaths = new Set([
  'home',
  'explore',
  'notifications',
  'messages',
  'search',
  'settings',
  'i',
  'compose',
  'intent',
  'login',
  'signup',
  'about',
  'tos',
  'privacy',
  'jobs',
  'hashtag',
  'share',
  'download',
  'account',
  'logout',
  'lists',
  'bookmarks',
  'help',
  'verified',
  'grok',
]);

const xHosts = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);

export interface XProfile {
  handle: string;
  // Lowercased handle, because X handles are case insensitive.
  key: string;
  url: string;
}

// The profile an X link points at, or null when it is not a profile link.
export function normalizeXProfileUrl(value: unknown): XProfile | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') return null;
  if (!xHosts.has(url.hostname.toLowerCase())) return null;
  const handle = url.pathname.split('/')[1] ?? '';
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  if (reservedXPaths.has(handle.toLowerCase())) return null;
  return { handle, key: handle.toLowerCase(), url: `https://x.com/${handle}` };
}

// Capture

// Captured text is third party page content. Control characters, bidirectional overrides, and zero
// width characters are stripped before validation: they would otherwise survive into claims, notes,
// and the FTS index (whose contract assumes stored text never contains NUL). Printable text, however
// hostile looking, is kept verbatim; it is data everywhere it is read.
const invisibleChars = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

function scrubbed(keepLineBreaks: boolean) {
  return (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const flattened = keepLineBreaks ? value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ') : value.replace(/[\r\n\t]+/g, ' ');
    return flattened.replace(invisibleChars, '');
  };
}

const scrubbedText = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(scrubbed(false), schema);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value));

const optionalEmail = z
  .string()
  .trim()
  .max(254)
  .optional()
  .refine((value) => value === undefined || value === '' || z.string().email().safeParse(value).success, {
    message: 'Enter a valid email address',
  })
  .transform((value) => (value === undefined || value === '' ? undefined : value.toLowerCase()));

const lookupSchema = z
  .object({
    source: z.enum(['linkedin', 'x']),
    url: scrubbedText(z.string().trim().min(1).max(500)),
  })
  .strict();

const captureSchema = z
  .object({
    source: z.enum(['linkedin', 'x']),
    url: scrubbedText(z.string().trim().min(1).max(500)),
    // A name that is only invisible characters scrubs down to nothing and fails min(1).
    name: scrubbedText(z.string().trim().min(1, 'The name is empty once invisible characters are removed.').max(200)),
    headline: scrubbedText(optionalText(200)),
    company: scrubbedText(optionalText(200)),
    location: scrubbedText(optionalText(200)),
    handle: scrubbedText(optionalText(30)),
    bio: z.preprocess(scrubbed(true), optionalText(2000)),
    website: scrubbedText(optionalText(500)),
    email: scrubbedText(optionalEmail),
    phone: scrubbedText(
      optionalText(40).refine((value) => value === undefined || /\d/.test(value), {
        message: 'A phone needs at least one digit.',
      }),
    ),
  })
  .strict();

export interface CaptureResult {
  outcome: 'created' | 'existing';
  person: { id: string; name: string };
}

interface Canonical {
  url: string;
  // Matches a saved claim value for the same profile.
  matches: (claimValue: string) => boolean;
  // Narrows the claim scan in SQL. Null scans every claim of that field.
  hint: string | null;
}

// The raw, still percent encoded /in/ segment of a LinkedIn link. The decoded form from
// normalizeProfileUrl cannot be used to rebuild the URL: a decoded ? or # would cut the stored URL
// short on the next parse and the capture would never match itself again.
function rawLinkedinSegment(value: string): string | null {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
  } catch {
    return null;
  }
  const match = /^\/in\/([^/]+)\/?/.exec(url.pathname);
  return match ? match[1]! : null;
}

function canonicalize(source: 'linkedin' | 'x', url: string): Canonical {
  if (source === 'linkedin') {
    if (!normalizeProfileUrl(url)) throw validationError(linkedinCaptureUrlMessage);
    const raw = rawLinkedinSegment(url);
    if (!raw) throw validationError(linkedinCaptureUrlMessage);
    const canonicalUrl = `https://www.linkedin.com/in/${raw}`;
    // The dedupe key comes from the canonical URL itself, so storing and re-reading always agree.
    // Known limit: an id carrying an encoded slash decodes into a path and collapses onto its first
    // segment; real LinkedIn ids never contain one.
    const key = normalizeProfileUrl(canonicalUrl);
    if (!key) throw validationError(linkedinCaptureUrlMessage);
    return { url: canonicalUrl, matches: (value) => normalizeProfileUrl(value) === key, hint: null };
  }
  const profile = normalizeXProfileUrl(url);
  if (!profile) throw validationError(xCaptureUrlMessage);
  return { url: profile.url, matches: (value) => normalizeXProfileUrl(value)?.key === profile.key, hint: profile.key };
}

const personName = (first: string, last: string): string => `${first} ${last}`.trim();

function summarize(tx: Pick<Tx, 'db' | 'workspaceId'>, id: string): CaptureResult['person'] {
  const row = tx.db
    .prepare('SELECT first_name AS first, last_name AS last FROM person WHERE id = ? AND workspace_id = ?')
    .get(id, tx.workspaceId) as { first: string; last: string | null };
  return { id, name: personName(row.first, row.last ?? '') };
}

function findExistingPerson(
  tx: Pick<Tx, 'db' | 'workspaceId'>,
  source: 'linkedin' | 'x',
  canonical: Canonical,
  email: string | undefined,
): { id: string; via: 'url' | 'email' } | null {
  const field = source === 'linkedin' ? 'linkedinUrl' : 'xUrl';
  const claims = (
    canonical.hint
      ? tx.db
          .prepare(
            `SELECT c.entity_id AS id, c.value AS value FROM field_claim c JOIN person p ON p.id = c.entity_id
             WHERE c.workspace_id = ? AND c.entity_type = 'person' AND c.field = ? AND p.workspace_id = ?
               AND instr(lower(c.value), ?) > 0 ORDER BY c.created_at, c.id`,
          )
          .all(tx.workspaceId, field, tx.workspaceId, canonical.hint)
      : tx.db
          .prepare(
            `SELECT c.entity_id AS id, c.value AS value FROM field_claim c JOIN person p ON p.id = c.entity_id
             WHERE c.workspace_id = ? AND c.entity_type = 'person' AND c.field = ? AND p.workspace_id = ?
             ORDER BY c.created_at, c.id`,
          )
          .all(tx.workspaceId, field, tx.workspaceId)
  ) as { id: string; value: string }[];
  for (const claim of claims) {
    if (canonical.matches(claim.value)) return { id: claim.id, via: 'url' };
  }
  if (email) {
    const row = tx.db
      .prepare('SELECT id FROM person WHERE workspace_id = ? AND lower(email) = ?')
      .get(tx.workspaceId, email.toLowerCase()) as { id: string } | undefined;
    if (row) return { id: row.id, via: 'email' };
  }
  return null;
}

// An email hit proves the person is the captured profile, so the profile URL is saved as a claim and the
// next lookup and capture match it. A person with any claim for that field already (even a different
// URL) is left alone: which profile is right is ambiguous and the record is edited in the app.
function saveProfileUrlClaim(tx: Tx, personId: string, source: 'linkedin' | 'x', url: string): void {
  const field = source === 'linkedin' ? 'linkedinUrl' : 'xUrl';
  const has = tx.db
    .prepare(
      `SELECT 1 FROM field_claim WHERE workspace_id = ? AND entity_type = 'person' AND entity_id = ? AND field = ? LIMIT 1`,
    )
    .get(tx.workspaceId, personId, field);
  if (has) return;
  createFieldClaimIn(tx, {
    entityType: 'person',
    entityId: personId,
    field,
    value: url,
    sourceUrl: url,
    sourceType: 'extension',
    observedAt: tx.now(),
    status: 'imported',
    extractionMethod: `extension:${source}`,
  });
  // createFieldClaimIn writes the claim.create audit row and emits the person's record_updated frame.
}

// One profile from the browser extension. The match runs in the same transaction as the create, so two
// quick clicks cannot both create the person. No organization is created: a company string is a claim only.
export function capturePerson(ctx: ActionContext, input: unknown): CaptureResult {
  const data = parseInput(captureSchema, input);
  const canonical = canonicalize(data.source, data.url);
  return mutate(ctx, (tx): CaptureResult => {
    const existing = findExistingPerson(tx, data.source, canonical, data.email);
    if (existing) {
      if (existing.via === 'email') saveProfileUrlClaim(tx, existing.id, data.source, canonical.url);
      return { outcome: 'existing', person: summarize(tx, existing.id) };
    }

    const split = splitName(data.name);
    const person = createPersonIn(tx, {
      firstName: split.firstName,
      lastName: split.lastName,
      email: data.email ?? null,
      title: data.headline ?? null,
      organizationId: null,
      location: data.location ?? null,
      tags: ['captured', data.source],
      nextActionAt: null,
    });
    const observedAt = tx.now();
    const method = `extension:${data.source}`;
    const claims: [string, string | undefined][] = [
      ['name', data.name],
      ['title', data.headline],
      ['company', data.company],
      ['location', data.location],
      ['email', data.email],
      ['website', data.website],
      ['phone', data.phone],
      [data.source === 'linkedin' ? 'linkedinUrl' : 'xUrl', canonical.url],
    ];
    for (const [field, value] of claims) {
      if (!value) continue;
      createFieldClaimIn(tx, {
        entityType: 'person',
        entityId: person.id,
        field,
        value,
        sourceUrl: canonical.url,
        sourceType: 'extension',
        observedAt,
        status: 'imported',
        extractionMethod: method,
      });
    }
    const label = data.source === 'linkedin' ? 'LinkedIn' : 'X';
    const lead = `Captured from ${label} ${canonical.url}.`;
    createActivityIn(tx, {
      entityType: 'person',
      entityId: person.id,
      kind: 'note',
      body: data.bio ? `${lead}\n\n${data.bio}` : lead,
    });
    tx.audit('capture.person', 'person', person.id, { source: data.source, url: canonical.url });
    emitRecord(tx, 'person', person.id);
    return { outcome: 'created', person: { id: person.id, name: personName(person.firstName, person.lastName) } };
  });
}

// A boolean and nothing else: the button needs no more, so the matched person's fields stay in the app.
export interface LookupResult {
  exists: boolean;
}

// Whether a profile is already in the CRM. Read only: no transaction, no audit event, no event. Email is
// unknown at lookup time, so only a saved profile URL claim can match.
export function lookupCapture(ctx: Pick<ActionContext, 'db' | 'workspaceId'>, input: unknown): LookupResult {
  const data = parseInput(lookupSchema, input);
  const canonical = canonicalize(data.source, data.url);
  return { exists: findExistingPerson(ctx, data.source, canonical, undefined) !== null };
}
