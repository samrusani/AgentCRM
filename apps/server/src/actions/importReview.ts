import { type ImportCounts, emptyImportCounts, getImportBatchForRun } from '../queries/imports.js';
import { getRun, listRunSteps } from '../queries/runs.js';
import { AppError } from '../errors.js';
import { type Row, type RunCounts } from '../records.js';
import { normalizeName, splitName, type MappedRow } from './apifyMapping.js';
import { normalizeProfileUrl } from './leadCaptureMapping.js';
import { type Tx, emitRecord } from './context.js';
import { createFieldClaimIn, createOrganizationIn, createPersonIn } from './crud.js';
import { finishStep, hashPayload, startStep } from './demoResearch.js';

export const apifyConsoleRunUrl = (apifyRunId: string): string =>
  `https://console.apify.com/actors/runs/${encodeURIComponent(apifyRunId)}`;

const longestClaim = 2000;

export function writeBatchCounts(tx: Tx, batchId: string, counts: ImportCounts): void {
  tx.db
    .prepare('UPDATE import_batch SET counts = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(counts), tx.now(), batchId);
}

// Called when a run ends without an approved import (cancel, reject, failure). Rows nobody accepted become rejected.
export function closeImportBatchForRun(tx: Tx, runId: string, outcome: 'rejected' | 'failed', reason: string): void {
  const batch = getImportBatchForRun(tx.db, tx.workspaceId, runId);
  if (!batch || (batch.status !== 'staging' && batch.status !== 'awaiting_review')) return;
  tx.db
    .prepare("UPDATE import_row SET status = 'rejected', reason = COALESCE(reason, ?) WHERE batch_id = ? AND status = 'staged'")
    .run(reason, batch.id);
  const rejected = Number(
    (tx.db.prepare("SELECT COUNT(*) AS n FROM import_row WHERE batch_id = ? AND status = 'rejected'").get(batch.id) as {
      n: number;
    }).n,
  );
  writeBatchCounts(tx, batch.id, { ...batch.counts, rejected });
  tx.db
    .prepare('UPDATE import_batch SET status = ?, updated_at = ? WHERE id = ?')
    .run(outcome, tx.now(), batch.id);
  tx.audit(outcome === 'rejected' ? 'import.reject' : 'import.fail', 'import_batch', batch.id, { runId, reason });
}

interface StagedRow {
  id: string;
  seq: number;
  mapped: MappedRow;
  matchEntityType: string | null;
  matchEntityId: string | null;
  // Lead capture rows record which call produced each field: reactions, comments, or enrich.
  fieldSources: Record<string, string>;
}

function parseFieldSources(raw: unknown): Record<string, string> {
  try {
    const parsed = JSON.parse(String(raw)) as { fieldSources?: unknown };
    const sources = parsed.fieldSources;
    if (typeof sources !== 'object' || sources === null || Array.isArray(sources)) return {};
    return Object.fromEntries(Object.entries(sources).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function parseMapped(value: unknown): MappedRow {
  const parsed = JSON.parse(String(value)) as Partial<MappedRow>;
  return {
    name: parsed.name ?? null,
    firstName: parsed.firstName ?? null,
    lastName: parsed.lastName ?? null,
    email: parsed.email ?? null,
    company: parsed.company ?? null,
    domain: parsed.domain ?? null,
    title: parsed.title ?? null,
    location: parsed.location ?? null,
    linkedinUrl: parsed.linkedinUrl ?? null,
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === 'string') : [],
  };
}

function orgKey(mapped: MappedRow): string | null {
  if (mapped.domain) return `d:${mapped.domain}`;
  if (mapped.company) return `n:${normalizeName(mapped.company)}`;
  return null;
}

// People who already have a saved linkedinUrl claim, keyed by the normalized profile.
function peopleByLinkedinProfile(tx: Tx): Map<string, string> {
  const peopleByProfile = new Map<string, string>();
  for (const claim of tx.db
    .prepare(
      `SELECT c.entity_id AS id, c.value AS value FROM field_claim c JOIN person p ON p.id = c.entity_id
       WHERE c.workspace_id = ? AND c.entity_type = 'person' AND c.field = 'linkedinUrl' AND p.workspace_id = ?`,
    )
    .all(tx.workspaceId, tx.workspaceId) as { id: string; value: string }[]) {
    const key = normalizeProfileUrl(claim.value);
    if (key && !peopleByProfile.has(key)) peopleByProfile.set(key, claim.id);
  }
  return peopleByProfile;
}

// The post link without its query and fragment, so share tracking parameters do not end up in claims.
function stripUrlQuery(value: string): string {
  return value.split('#')[0]!.split('?')[0]!;
}

export interface ImportOutcome {
  accepted: number;
  skipped: number;
  organizationsCreated: number;
  counts: ImportCounts;
  truncated: boolean;
}

// Runs inside the approval transaction. Organizations come first so people can link to them.
export function acceptImportBatch(tx: Tx, runId: string, scope: Record<string, unknown>): ImportOutcome {
  const batch = getImportBatchForRun(tx.db, tx.workspaceId, runId);
  if (!batch) throw new Error('The import batch for this run is missing.');
  const observedAt = tx.now();
  // Apify claims point at the Apify run and record the actor id. CSV claims have no URL and record the file name.
  // Lead capture claims point at the post and name the actor that produced each field.
  const leadCapture = batch.sourceKind === 'lead_capture';
  const leadActors = (typeof scope.actors === 'object' && scope.actors !== null ? scope.actors : batch.sourceRef.actors ?? {}) as Record<string, unknown>;
  const leadActorFor = (origin: string | undefined): string => {
    const key = origin === 'enrich' ? 'profile' : origin;
    const chosen = key ? leadActors[key] : undefined;
    const fallback = leadActors.reactions ?? leadActors.comments ?? leadActors.profile;
    return String(typeof chosen === 'string' ? chosen : (fallback ?? 'unknown'));
  };
  const source = leadCapture
    ? {
        type: 'apify',
        url: stripUrlQuery(String(scope.postUrl ?? batch.sourceRef.postUrl ?? '')) || null,
        method: 'lead_capture',
        tag: 'linkedin-leads',
      }
    : batch.sourceKind === 'csv'
      ? {
          type: 'import',
          url: null as string | null,
          method: `csv:${String(scope.fileName ?? batch.sourceRef.fileName ?? 'unknown')}`.slice(0, 200),
          tag: 'csv-import',
        }
      : {
          type: 'apify',
          url: apifyConsoleRunUrl(String(scope.apifyRunId ?? '')) as string | null,
          method: String(scope.actorId ?? 'unknown'),
          tag: 'apify',
        };
  const methodFor = (row: StagedRow, field: string): string =>
    leadCapture ? `lead_capture:${leadActorFor(row.fieldSources[field])}`.slice(0, 200) : source.method;

  const rows = (
    tx.db.prepare("SELECT * FROM import_row WHERE batch_id = ? AND status = 'staged' ORDER BY seq").all(batch.id) as Row[]
  ).map(
    (row): StagedRow => ({
      id: String(row.id),
      seq: Number(row.seq),
      mapped: parseMapped(row.mapped),
      matchEntityType: row.match_entity_type === null ? null : String(row.match_entity_type),
      matchEntityId: row.match_entity_id === null ? null : String(row.match_entity_id),
      fieldSources: leadCapture ? parseFieldSources(row.raw) : {},
    }),
  );

  const markRow = (rowId: string, status: string, reason: string | null, type: string | null, id: string | null): void => {
    tx.db
      .prepare('UPDATE import_row SET status = ?, reason = ?, match_entity_type = ?, match_entity_id = ? WHERE id = ?')
      .run(status, reason, type, id, rowId);
  };

  // An email, or for lead capture a LinkedIn profile, can be taken between staging and approval.
  // Skip those rows and say why.
  const importable: StagedRow[] = [];
  let skipped = 0;
  const knownProfiles = leadCapture ? peopleByLinkedinProfile(tx) : new Map<string, string>();
  for (const row of rows) {
    const taken = row.mapped.email
      ? (tx.db
          .prepare('SELECT id FROM person WHERE workspace_id = ? AND lower(email) = ?')
          .get(tx.workspaceId, row.mapped.email) as { id: string } | undefined)
      : undefined;
    const profileKey = leadCapture ? normalizeProfileUrl(row.mapped.linkedinUrl) : null;
    const profileTaken = profileKey ? knownProfiles.get(profileKey) : undefined;
    if (taken) {
      markRow(row.id, 'duplicate', 'A person with this email was added after staging.', 'person', taken.id);
      skipped += 1;
    } else if (profileTaken) {
      markRow(row.id, 'duplicate', 'A person with this LinkedIn profile was added after staging.', 'person', profileTaken);
      skipped += 1;
    } else {
      importable.push(row);
    }
  }

  const organizationIds = new Map<string, string>();
  const createdOrganizations = new Set<string>();
  // Read once per approval, then kept current as organizations are created, so each row is a map lookup
  // instead of a scan of every organization. The first organization wins when two share a name.
  const knownOrganizationIds = new Set<string>();
  const organizationsByDomain = new Map<string, string>();
  const organizationsByName = new Map<string, string>();
  for (const organization of tx.db
    .prepare('SELECT id, name, domain FROM organization WHERE workspace_id = ?')
    .all(tx.workspaceId) as { id: string; name: string; domain: string | null }[]) {
    knownOrganizationIds.add(organization.id);
    if (organization.domain) {
      const domain = organization.domain.toLowerCase();
      if (!organizationsByDomain.has(domain)) organizationsByDomain.set(domain, organization.id);
    }
    const name = normalizeName(organization.name);
    if (!organizationsByName.has(name)) organizationsByName.set(name, organization.id);
  }
  const lookupOrganization = (mapped: MappedRow, hinted: string | null): string | null => {
    if (hinted && knownOrganizationIds.has(hinted)) return hinted;
    if (mapped.domain) {
      const hit = organizationsByDomain.get(mapped.domain);
      if (hit) return hit;
    }
    if (mapped.company) {
      const hit = organizationsByName.get(normalizeName(mapped.company));
      if (hit) return hit;
    }
    return null;
  };

  const organizationTags = [source.tag, `via-${runId}`];

  // Each row gets its own savepoint. A conflict that appeared after staging (an email or domain added
  // since) rolls back only that row, which is marked duplicate. The rest of the approval still commits.
  let accepted = 0;
  const lateConflictReason = 'This row conflicted with a record added after staging.';
  for (const row of importable) {
    tx.db.exec('SAVEPOINT import_row');
    const addedKeys: string[] = [];
    const addedOrganizations: string[] = [];
    const undoLookups: (() => void)[] = [];
    try {
      const mapped = row.mapped;
      let organizationId: string | null = null;
      const key = orgKey(mapped);
      if (key) {
        organizationId = organizationIds.get(key) ?? null;
        if (!organizationId) {
          organizationId = lookupOrganization(mapped, row.matchEntityType === 'organization' ? row.matchEntityId : null);
          if (!organizationId) {
            const name = mapped.company ?? mapped.domain ?? 'Unknown organization';
            const created = createOrganizationIn(tx, {
              name,
              domain: mapped.domain,
              kind: 'company',
              location: null,
              tags: organizationTags,
            });
            organizationId = created.id;
            createdOrganizations.add(organizationId);
            addedOrganizations.push(organizationId);
            knownOrganizationIds.add(organizationId);
            undoLookups.push(() => knownOrganizationIds.delete(created.id));
            if (mapped.domain && !organizationsByDomain.has(mapped.domain)) {
              const domainKey = mapped.domain;
              organizationsByDomain.set(domainKey, created.id);
              undoLookups.push(() => organizationsByDomain.delete(domainKey));
            }
            const nameKey = normalizeName(name);
            if (!organizationsByName.has(nameKey)) {
              organizationsByName.set(nameKey, created.id);
              undoLookups.push(() => organizationsByName.delete(nameKey));
            }
            const orgClaims: [string, string | null, string][] = [
              ['name', name, mapped.company ? 'company' : 'domain'],
              ['domain', mapped.domain, 'domain'],
            ];
            for (const [field, value, originField] of orgClaims) {
              if (!value) continue;
              createFieldClaimIn(tx, {
                entityType: 'organization',
                entityId: organizationId,
                field,
                value: value.slice(0, longestClaim),
                sourceUrl: source.url,
                sourceType: source.type,
                observedAt,
                status: 'imported',
                extractionMethod: methodFor(row, originField),
              });
            }
          }
          organizationIds.set(key, organizationId);
          addedKeys.push(key);
        }
      }

      const fallbackFirst = mapped.email ? (mapped.email.split('@')[0] ?? 'Unknown') : 'Unknown';
      const split = mapped.name ? splitName(mapped.name) : { firstName: fallbackFirst.slice(0, 100), lastName: '' };
      const person = createPersonIn(tx, {
        firstName: split.firstName === '' ? fallbackFirst : split.firstName,
        lastName: split.lastName,
        email: mapped.email,
        title: mapped.title,
        organizationId,
        location: mapped.location,
        tags: [...new Set([source.tag, `via-${runId}`, ...(mapped.tags ?? [])])].slice(0, 30),
        nextActionAt: null,
      });
      const claims: [string, string | null][] = [
        ['name', mapped.name],
        ['email', mapped.email],
        ['title', mapped.title],
        ['location', mapped.location],
        ['linkedinUrl', mapped.linkedinUrl],
        ['company', mapped.company],
      ];
      for (const [field, value] of claims) {
        if (!value) continue;
        createFieldClaimIn(tx, {
          entityType: 'person',
          entityId: person.id,
          field,
          value: value.slice(0, longestClaim),
          sourceUrl: source.url,
          sourceType: source.type,
          observedAt,
          status: 'imported',
          extractionMethod: methodFor(row, field),
        });
      }
      tx.db.exec('RELEASE import_row');
      markRow(row.id, 'accepted', null, 'person', person.id);
      accepted += 1;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'conflict') throw error;
      tx.db.exec('ROLLBACK TO import_row');
      tx.db.exec('RELEASE import_row');
      for (const key of addedKeys) organizationIds.delete(key);
      for (const id of addedOrganizations) createdOrganizations.delete(id);
      for (const undo of undoLookups) undo();
      markRow(row.id, 'duplicate', `${lateConflictReason} ${error.message}`, null, null);
      skipped += 1;
    }
  }

  const rowCount = (status: string): number =>
    Number(
      (tx.db.prepare('SELECT COUNT(*) AS n FROM import_row WHERE batch_id = ? AND status = ?').get(batch.id, status) as {
        n: number;
      }).n,
    );
  const counts: ImportCounts = {
    ...emptyImportCounts,
    ...batch.counts,
    duplicates: rowCount('duplicate'),
    invalid: rowCount('invalid'),
    // Rows that dropped out at approval are no longer waiting, so the staged count follows.
    staged: Math.max(0, batch.counts.staged - skipped),
    accepted,
    rejected: rowCount('rejected'),
  };
  writeBatchCounts(tx, batch.id, counts);
  tx.db.prepare("UPDATE import_batch SET status = 'accepted', updated_at = ? WHERE id = ?").run(tx.now(), batch.id);
  tx.audit('import.accept', 'import_batch', batch.id, {
    runId,
    accepted,
    skipped,
    organizationsCreated: createdOrganizations.size,
  });
  for (const id of createdOrganizations) emitRecord(tx, 'organization', id);

  return {
    accepted,
    skipped,
    organizationsCreated: createdOrganizations.size,
    counts,
    truncated: scope.fetchStoppedEarly !== undefined && scope.fetchStoppedEarly !== null,
  };
}

// Ends the run as failed, or partial when rows were already staged. Never creates or keeps invented rows.
export function failImportRunIn(tx: Tx, runId: string, detail: string): void {
  const run = getRun(tx.db, tx.workspaceId, runId);
  if (!run || ['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status)) return;
  const batch = getImportBatchForRun(tx.db, tx.workspaceId, runId);
  const staged = batch ? batch.counts.staged : 0;
  const status = staged > 0 ? 'partial' : 'failed';
  const now = tx.now();
  tx.db.prepare('UPDATE run SET status = ?, finished_at = ? WHERE id = ?').run(status, now, runId);
  for (const step of listRunSteps(tx.db, runId)) {
    if (step.status === 'running') {
      tx.db
        .prepare("UPDATE run_step SET status = 'failed', detail = ?, finished_at = ? WHERE id = ?")
        .run(detail, now, step.id);
    } else if (step.status === 'pending') {
      tx.db.prepare("UPDATE run_step SET status = 'skipped', finished_at = ? WHERE id = ?").run(now, step.id);
    }
  }
  closeImportBatchForRun(tx, runId, 'failed', detail);
  tx.audit(`run.${status}`, 'run', runId, { message: detail });
  tx.emit({ type: 'run_updated', runId });
}

// Shared by Apify and CSV runs: the step helpers, the duplicate check, and the review request.

export function importCountsOf(counts: ImportCounts, requested: number): RunCounts {
  return {
    processed: counts.fetched,
    found: counts.staged,
    flagged: counts.duplicates + counts.invalid,
    requested,
    fetched: counts.fetched,
    staged: counts.staged,
    duplicates: counts.duplicates,
    invalid: counts.invalid,
    accepted: counts.accepted,
  };
}

// The running step with this seq, only while the run itself is still running.
export function liveStep(tx: Tx, runId: string, seq: number) {
  const run = getRun(tx.db, tx.workspaceId, runId);
  if (!run || run.status !== 'running') return null;
  const step = listRunSteps(tx.db, runId).find((candidate) => candidate.seq === seq && candidate.status === 'running');
  return step ? { run, step } : null;
}

export function completeStep(tx: Tx, runId: string, step: { id: string; seq: number }, detail: string): void {
  finishStep(tx, runId, step, detail);
  const next = listRunSteps(tx.db, runId).find((candidate) => candidate.seq > step.seq && candidate.status === 'pending');
  if (next) startStep(tx, runId, next);
  tx.emit({ type: 'run_updated', runId });
}

// Rows with neither a name nor an email cannot become a record. Returns how many were marked invalid.
export function markInvalidRows(tx: Tx, batchId: string, reason: string): { total: number; invalid: number } {
  const rows = tx.db.prepare('SELECT id, mapped FROM import_row WHERE batch_id = ? ORDER BY seq').all(batchId) as {
    id: string;
    mapped: string;
  }[];
  let invalid = 0;
  const update = tx.db.prepare("UPDATE import_row SET status = 'invalid', reason = ? WHERE id = ?");
  for (const row of rows) {
    const mapped = parseMapped(row.mapped);
    if (mapped.name === null && mapped.email === null) {
      update.run(reason, row.id);
      invalid += 1;
    }
  }
  return { total: rows.length, invalid };
}

// Staged rows in other import batches that are still waiting on review, keyed by normalized profile and email.
// The value is the id of the batch that holds the row.
function pendingBatchKeys(tx: Tx, batchId: string): { profiles: Map<string, string>; emails: Map<string, string> } {
  const profiles = new Map<string, string>();
  const emails = new Map<string, string>();
  const rows = tx.db
    .prepare(
      `SELECT r.batch_id AS batchId, r.mapped AS mapped
       FROM import_row r
       JOIN import_batch b ON b.id = r.batch_id
       JOIN run ON run.id = b.run_id
       WHERE b.workspace_id = ? AND b.id <> ? AND b.status IN ('staging', 'awaiting_review')
         AND run.workspace_id = ? AND run.status IN ('queued', 'running', 'paused', 'waiting_approval')
         AND r.status = 'staged'
       ORDER BY b.created_at, r.seq`,
    )
    .all(tx.workspaceId, batchId, tx.workspaceId) as { batchId: string; mapped: string }[];
  for (const row of rows) {
    const mapped = parseMapped(row.mapped);
    const profile = normalizeProfileUrl(mapped.linkedinUrl);
    if (profile && !profiles.has(profile)) profiles.set(profile, row.batchId);
    if (mapped.email && !emails.has(mapped.email)) emails.set(mapped.email, row.batchId);
  }
  return { profiles, emails };
}

// Marks staged rows that match an existing person or an earlier row in the same batch. Never merges.
// Existing people match by normalized email, then by name plus organization.
// With `linkedin` set, a row also matches the person whose saved linkedinUrl claim is the same profile.
// LinkedIn lead rows carry no email or company before enrichment, so this is the only match they can have.
// With `pendingBatches` set, a row also matches a staged row of another import that still waits on review in
// this workspace, so a repeated capture buys no enrichment for people who are already staged.
export function dedupeImportBatch(tx: Tx, batchId: string, options: { linkedin?: boolean; pendingBatches?: boolean } = {}): number {
  const peopleByProfile = options.linkedin ? peopleByLinkedinProfile(tx) : new Map<string, string>();
  const pending = options.pendingBatches ? pendingBatchKeys(tx, batchId) : null;
  const peopleByEmail = new Map<string, string>();
  const peopleByNameAndOrganization = new Map<string, string>();
  for (const person of tx.db
    .prepare('SELECT id, first_name, last_name, email, organization_id FROM person WHERE workspace_id = ?')
    .all(tx.workspaceId) as Row[]) {
    if (person.email) peopleByEmail.set(String(person.email).toLowerCase(), String(person.id));
    if (person.organization_id) {
      const name = normalizeName(`${String(person.first_name)} ${String(person.last_name ?? '')}`);
      peopleByNameAndOrganization.set(`${name}|${String(person.organization_id)}`, String(person.id));
    }
  }
  const organizationsByDomain = new Map<string, string>();
  const organizationsByName = new Map<string, string>();
  for (const organization of tx.db
    .prepare('SELECT id, name, domain FROM organization WHERE workspace_id = ?')
    .all(tx.workspaceId) as Row[]) {
    if (organization.domain) organizationsByDomain.set(String(organization.domain).toLowerCase(), String(organization.id));
    organizationsByName.set(normalizeName(String(organization.name)), String(organization.id));
  }

  const rows = tx.db
    .prepare("SELECT id, seq, mapped FROM import_row WHERE batch_id = ? AND status = 'staged' ORDER BY seq")
    .all(batchId) as { id: string; seq: number; mapped: string }[];
  const seenEmail = new Map<string, number>();
  const seenNameAndCompany = new Map<string, number>();
  let duplicates = 0;
  const markDuplicate = tx.db.prepare(
    "UPDATE import_row SET status = 'duplicate', match_entity_type = ?, match_entity_id = ?, reason = ? WHERE id = ?",
  );
  const markLink = tx.db.prepare(
    "UPDATE import_row SET match_entity_type = 'organization', match_entity_id = ?, reason = ? WHERE id = ?",
  );

  for (const row of rows) {
    const mapped = parseMapped(row.mapped);
    const organizationId =
      (mapped.domain ? organizationsByDomain.get(mapped.domain) : undefined) ??
      (mapped.company ? organizationsByName.get(normalizeName(mapped.company)) : undefined) ??
      null;
    const normalizedName = mapped.name ? normalizeName(mapped.name) : null;
    const companyKey = mapped.domain ?? (mapped.company ? normalizeName(mapped.company) : null);

    const emailMatch = mapped.email ? peopleByEmail.get(mapped.email) : undefined;
    const profileKey = options.linkedin ? normalizeProfileUrl(mapped.linkedinUrl) : null;
    const profileMatch = profileKey ? peopleByProfile.get(profileKey) : undefined;
    const pendingBatch =
      (profileKey ? pending?.profiles.get(profileKey) : undefined) ?? (mapped.email ? pending?.emails.get(mapped.email) : undefined);
    const nameMatch =
      normalizedName && organizationId ? peopleByNameAndOrganization.get(`${normalizedName}|${organizationId}`) : undefined;
    const earlierEmail = mapped.email ? seenEmail.get(mapped.email) : undefined;
    const earlierName = normalizedName && companyKey ? seenNameAndCompany.get(`${normalizedName}|${companyKey}`) : undefined;

    if (emailMatch) {
      markDuplicate.run('person', emailMatch, 'Email matches an existing person.', row.id);
      duplicates += 1;
    } else if (profileMatch) {
      markDuplicate.run('person', profileMatch, 'LinkedIn profile matches an existing person.', row.id);
      duplicates += 1;
    } else if (nameMatch) {
      markDuplicate.run('person', nameMatch, 'Name and organization match an existing person.', row.id);
      duplicates += 1;
    } else if (pendingBatch) {
      markDuplicate.run(null, null, `Already staged in another pending import (${pendingBatch}).`, row.id);
      duplicates += 1;
    } else if (earlierEmail !== undefined) {
      markDuplicate.run(null, null, `Same email as row ${earlierEmail} in this import.`, row.id);
      duplicates += 1;
    } else if (earlierName !== undefined) {
      markDuplicate.run(null, null, `Same name and organization as row ${earlierName} in this import.`, row.id);
      duplicates += 1;
    } else {
      if (mapped.email) seenEmail.set(mapped.email, row.seq);
      if (normalizedName && companyKey) seenNameAndCompany.set(`${normalizedName}|${companyKey}`, row.seq);
      if (organizationId) markLink.run(organizationId, 'The organization already exists, so the person will link to it.', row.id);
    }
  }
  return duplicates;
}

const reviewSampleSize = 5;

export interface ReviewRequest {
  // Words for the "nothing to review" detail and the approval title, for example "the actor returned no items".
  emptyDetail: (counts: ImportCounts) => string;
  title: (staged: number) => string;
  // Extra payload keys that identify the source, for example the actor id or the file name.
  payloadSource: Record<string, unknown>;
}

// Final step of an import run. With nothing left to import the run ends as partial and no approval is created.
// Otherwise it creates the import_review approval and moves the run to waiting_approval.
export function requestImportReview(tx: Tx, runId: string, seq: number, request: ReviewRequest, fail: (detail: string) => void): void {
  const live = liveStep(tx, runId, seq);
  if (!live) return;
  const batch = getImportBatchForRun(tx.db, tx.workspaceId, runId);
  if (!batch) {
    fail('The import batch is missing.');
    return;
  }
  const counts = batch.counts;
  if (counts.staged === 0) {
    const detail = request.emptyDetail(counts);
    finishStep(tx, runId, live.step, detail);
    closeImportBatchForRun(tx, runId, 'failed', detail);
    tx.db.prepare("UPDATE run SET status = 'partial', finished_at = ? WHERE id = ?").run(tx.now(), runId);
    tx.audit('run.partial', 'run', runId, { reason: 'nothing_to_import' });
    tx.emit({ type: 'run_updated', runId });
    return;
  }

  const sample = (
    tx.db
      .prepare("SELECT mapped FROM import_row WHERE batch_id = ? AND status = 'staged' ORDER BY seq LIMIT ?")
      .all(batch.id, reviewSampleSize) as { mapped: string }[]
  ).map((row) => {
    const mapped = parseMapped(row.mapped);
    const base = { name: mapped.name, email: mapped.email, company: mapped.company };
    // Lead capture rows also show the title and the profile, which are what the reviewer approves.
    return batch.sourceKind === 'lead_capture' ? { ...base, title: mapped.title, linkedinUrl: mapped.linkedinUrl } : base;
  });
  const payload = {
    batchId: batch.id,
    ...request.payloadSource,
    counts: {
      fetched: counts.fetched,
      staged: counts.staged,
      duplicates: counts.duplicates,
      invalid: counts.invalid,
    },
    sample,
  };
  const serialized = JSON.stringify(payload);
  const approvalId = tx.newId('apr');
  tx.db
    .prepare(
      `INSERT INTO approval (id, created_at, workspace_id, run_id, kind, title, payload, payload_hash, status)
       VALUES (?, ?, ?, ?, 'import_review', ?, ?, ?, 'pending')`,
    )
    .run(approvalId, tx.now(), tx.workspaceId, runId, request.title(counts.staged), serialized, hashPayload(serialized));
  tx.audit('approval.create', 'approval', approvalId, { runId, kind: 'import_review' });
  tx.emit({ type: 'approval_updated', approvalId, runId });
  tx.db.prepare("UPDATE import_batch SET status = 'awaiting_review', updated_at = ? WHERE id = ?").run(tx.now(), batch.id);
  finishStep(
    tx,
    runId,
    live.step,
    `Waiting for review: ${counts.staged} to import, ${counts.duplicates} duplicates, ${counts.invalid} invalid.`,
  );
  tx.db.prepare("UPDATE run SET status = 'waiting_approval' WHERE id = ?").run(runId);
  tx.audit('run.waiting_approval', 'run', runId);
  tx.emit({ type: 'run_updated', runId });
}
