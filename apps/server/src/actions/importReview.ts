import { type ImportCounts, emptyImportCounts, getImportBatchForRun } from '../queries/imports.js';
import { getRun, listRunSteps } from '../queries/runs.js';
import { AppError } from '../errors.js';
import { type Row, type RunCounts } from '../records.js';
import { normalizeName, splitName, type MappedRow } from './apifyMapping.js';
import { normalizeProfileUrl } from './leadCaptureMapping.js';
import { type ActionContext, type Tx, emitRecord, mutate, withAuditActor, withTxActor } from './context.js';
import { readImportSettings } from './importSettings.js';
import { createFieldClaimIn, createOrganizationIn, createPersonIn } from './crud.js';
import { promotePersonIn } from './lifecycle.js';
import { updateEntityIn } from './entities.js';
import { requireOrganization } from '../queries/organizations.js';
import { canonicalCompanyLinkedinUrl, canonicalPersonLinkedinUrl } from './profileUrls.js';
import { type AdvanceResult, finishStep, hashPayload, setCounts, startStep } from './demoResearch.js';

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
  // A lead capture run that ends before staging used its extraction keeps no post names, quotes, or pasted text in its scope.
  tx.db
    .prepare("UPDATE run SET scope = json_remove(scope, '$.extraction', '$.extractionResult', '$.postText') WHERE id = ? AND kind = 'lead_capture'")
    .run(runId);
  // The same for a transcript run: the pasted call transcript and its extraction never outlive the run's work.
  tx.db
    .prepare("UPDATE run SET scope = json_remove(scope, '$.extraction', '$.extractionResult', '$.transcriptText') WHERE id = ? AND kind = 'transcript_capture'")
    .run(runId);
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
    ...(parsed.kind === 'organization' ? { kind: 'organization' as const } : {}),
    ...(parsed.kind === 'organization' ? { orgKind: parsed.orgKind === 'fund' ? ('fund' as const) : ('company' as const) } : {}),
  };
}

function orgKey(mapped: MappedRow): string | null {
  if (mapped.domain) return `d:${mapped.domain}`;
  if (mapped.company) return `n:${normalizeName(mapped.company)}`;
  return null;
}

// People who have a LinkedIn profile URL saved on the record, keyed by the normalized profile.
function peopleByLinkedinProfile(tx: Tx): Map<string, string> {
  const peopleByProfile = new Map<string, string>();
  for (const person of tx.db
    .prepare(
      `SELECT id, linkedin_url AS value FROM person WHERE workspace_id = ? AND linkedin_url IS NOT NULL ORDER BY created_at, id`,
    )
    .all(tx.workspaceId) as { id: string; value: string }[]) {
    const key = normalizeProfileUrl(person.value);
    if (key && !peopleByProfile.has(key)) peopleByProfile.set(key, person.id);
  }
  return peopleByProfile;
}

// The post link without its query and fragment, so share tracking parameters do not end up in claims.
function stripUrlQuery(value: string): string {
  return value.split('#')[0]!.split('?')[0]!;
}

function hasLinkedInbound(tx: Tx, personId: string): boolean {
  return Boolean(
    tx.db.prepare("SELECT 1 FROM email_message WHERE workspace_id = ? AND person_id = ? AND direction = 'in' LIMIT 1").get(tx.workspaceId, personId),
  );
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
    const key = origin === 'enrich' ? 'profile' : origin === 'post_author' ? 'post' : origin;
    const chosen = key ? leadActors[key] : undefined;
    const fallback = leadActors.reactions ?? leadActors.comments ?? leadActors.post ?? leadActors.profile;
    return String(typeof chosen === 'string' ? chosen : (fallback ?? 'unknown'));
  };
  // Fields read out of the post text by the model name the provider and model the run used.
  const modelMethod = `lead_capture:model:${String(scope.provider ?? 'unknown')}:${String(scope.model ?? 'unknown')}`.slice(0, 200);
  const transcript = batch.sourceKind === 'transcript';
  const transcriptMethod = `transcript:model:${String(scope.provider ?? 'unknown')}:${String(scope.model ?? 'unknown')}`.slice(0, 200);
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
      : batch.sourceKind === 'mailbox'
        ? { type: 'import', url: null as string | null, method: 'mailbox:scan', tag: 'mailbox-import' }
        : transcript
          ? { type: 'import', url: null as string | null, method: transcriptMethod, tag: 'transcript-import' }
          : {
              type: 'apify',
              url: apifyConsoleRunUrl(String(scope.apifyRunId ?? '')) as string | null,
              method: String(scope.actorId ?? 'unknown'),
              tag: 'apify',
            };
  // A pasted capture read some fields out of text the user pasted, which is not Apify data, so those claims are an
  // import. Fields an actor supplied (enrichment) keep the Apify source type.
  const pastedCapture = leadCapture && batch.sourceRef.pasted === true;
  const typeFor = (row: StagedRow, field: string): string =>
    pastedCapture && row.fieldSources[field] === 'post' ? 'import' : source.type;
  const methodFor = (row: StagedRow, field: string): string => {
    if (!leadCapture) return source.method;
    if (row.fieldSources[field] === 'post') return modelMethod;
    return `lead_capture:${leadActorFor(row.fieldSources[field])}`.slice(0, 200);
  };

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
  const recheckProfiles = leadCapture || transcript;
  const knownProfiles = recheckProfiles ? peopleByLinkedinProfile(tx) : new Map<string, string>();
  for (const row of rows) {
    const taken = row.mapped.email
      ? (tx.db
          .prepare('SELECT id FROM person WHERE workspace_id = ? AND lower(email) = ?')
          .get(tx.workspaceId, row.mapped.email) as { id: string } | undefined)
      : undefined;
    const profileKey = recheckProfiles ? normalizeProfileUrl(row.mapped.linkedinUrl) : null;
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
      // On an organization row the link is the company page. On a person row it is the person's own profile.
      const organizationLinkedin = mapped.kind === 'organization' ? canonicalCompanyLinkedinUrl(mapped.linkedinUrl) : null;
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
              kind: mapped.kind === 'organization' && mapped.orgKind === 'fund' ? 'fund' : 'company',
              location: mapped.kind === 'organization' ? mapped.location : null,
              linkedinUrl: organizationLinkedin,
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
              ['linkedinUrl', organizationLinkedin, 'company'],
            ];
            for (const [field, value, originField] of orgClaims) {
              if (!value) continue;
              createFieldClaimIn(tx, {
                entityType: 'organization',
                entityId: organizationId,
                field,
                value: value.slice(0, longestClaim),
                sourceUrl: source.url,
                sourceType: typeFor(row, originField),
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

      if (mapped.kind === 'organization') {
        // An organization row creates or matches just the organization. No person is created.
        if (!organizationId) throw new AppError('conflict', 'The organization row has no name.');
        if (organizationLinkedin && !addedOrganizations.includes(organizationId)) {
          // The row matched an organization that already exists. Fill its LinkedIn page when it has none, and
          // keep the link as evidence either way.
          const current = requireOrganization(tx.db, tx.workspaceId, organizationId);
          if (current.linkedinUrl !== organizationLinkedin) {
            if (current.linkedinUrl === null) {
              updateEntityIn(tx, 'organization', organizationId, {
                expectedVersion: current.version,
                fields: { linkedinUrl: organizationLinkedin },
              });
            }
            createFieldClaimIn(tx, {
              entityType: 'organization',
              entityId: organizationId,
              field: 'linkedinUrl',
              value: organizationLinkedin,
              sourceUrl: source.url,
              sourceType: typeFor(row, 'company'),
              observedAt,
              status: 'imported',
              extractionMethod: methodFor(row, 'company'),
            });
          }
        }
        tx.db.exec('RELEASE import_row');
        markRow(row.id, 'accepted', null, 'organization', organizationId);
        accepted += 1;
        continue;
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
        linkedinUrl: canonicalPersonLinkedinUrl(mapped.linkedinUrl),
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
          sourceType: typeFor(row, field),
          observedAt,
          status: 'imported',
          extractionMethod: methodFor(row, field),
        });
      }
      // The person was created with this address, so createPersonIn already filed the address's stored messages under
      // them. Someone who has written to the user is a relationship; this is the only promotion stored mail causes.
      if (batch.sourceKind === 'mailbox' && hasLinkedInbound(tx, person.id)) promotePersonIn(tx, person.id, 'replied');
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
  if (transcript) linkTranscriptAttendees(tx, runId, batch.id, scope);

  return {
    accepted,
    skipped,
    organizationsCreated: createdOrganizations.size,
    counts,
    truncated: scope.fetchStoppedEarly !== undefined && scope.fetchStoppedEarly !== null,
  };
}

// A transcript run started from a meeting links every person the transcript named to that meeting: the people this accept
// created and the people the rows matched (known before staging or taken after it). Organization rows match
// organizations and link nothing. The meeting is looked up once; one deleted since staging links nothing and the accept
// goes on unchanged. The link is insert-or-ignore, so a person already on the meeting changes nothing.
function linkTranscriptAttendees(tx: Tx, runId: string, batchId: string, scope: Record<string, unknown>): void {
  const meetingId = typeof scope.meetingId === 'string' ? scope.meetingId : null;
  if (!meetingId) return;
  const meeting = tx.db.prepare('SELECT 1 FROM meeting WHERE id = ? AND workspace_id = ?').get(meetingId, tx.workspaceId);
  if (!meeting) return;
  const people = tx.db
    .prepare(
      `SELECT DISTINCT r.match_entity_id AS id FROM import_row r JOIN person p ON p.id = r.match_entity_id
       WHERE r.batch_id = ? AND r.match_entity_type = 'person' AND r.status IN ('accepted', 'duplicate') AND p.workspace_id = ?`,
    )
    .all(batchId, tx.workspaceId) as { id: string }[];
  const insert = tx.db.prepare('INSERT OR IGNORE INTO meeting_attendee (meeting_id, person_id, created_at) VALUES (?, ?, ?)');
  let added = 0;
  for (const person of people) added += insert.run(meetingId, person.id, tx.now()).changes;
  if (added > 0) {
    tx.audit('meeting.attendee_add', 'meeting', meetingId, { added, runId });
    emitRecord(tx, 'meeting', meetingId);
  }
}

// The approve path of an import_review approval, shared by a human decision and the auto accept setting:
// accept the batch, then finish the run with honest counts. Runs inside the deciding transaction.
export function settleAcceptedImport(tx: Tx, run: { id: string; scope: Record<string, unknown>; counts: RunCounts }, now: string): void {
  const outcome = acceptImportBatch(tx, run.id, run.scope);
  const finalStatus = outcome.truncated ? 'partial' : 'succeeded';
  tx.db.prepare('UPDATE run SET status = ?, counts = ?, finished_at = ? WHERE id = ?').run(
    finalStatus,
    JSON.stringify({
      ...run.counts,
      processed: outcome.counts.fetched,
      found: outcome.counts.accepted,
      flagged: outcome.counts.duplicates + outcome.counts.invalid,
      ...outcome.counts,
      requested: run.counts.requested ?? Number(run.scope.maxItems ?? 0),
    }),
    now,
    run.id,
  );
  tx.audit(`run.${finalStatus}`, 'run', run.id, {
    accepted: outcome.accepted,
    skipped: outcome.skipped,
    organizationsCreated: outcome.organizationsCreated,
  });
}

// Only a run that explicitly records origin "user" can be auto accepted. The gate fails closed: a missing or unknown
// origin waits for a human, and agent started runs store origin "agent".
function startedByUser(scope: Record<string, unknown>): boolean {
  return scope.origin === 'user';
}

export const autoAcceptActor = 'auto_accept';
export const autoAcceptNote = 'Auto accepted by the imports setting.';

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
function pendingBatchKeys(tx: Tx, batchId: string): { profiles: Map<string, string>; emails: Map<string, string>; organizations: Map<string, string> } {
  const profiles = new Map<string, string>();
  const emails = new Map<string, string>();
  const organizations = new Map<string, string>();
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
    if (mapped.kind === 'organization') {
      const key = mapped.company ? normalizeName(mapped.company) : '';
      if (key !== '' && !organizations.has(key)) organizations.set(key, row.batchId);
      continue;
    }
    const profile = normalizeProfileUrl(mapped.linkedinUrl);
    if (profile && !profiles.has(profile)) profiles.set(profile, row.batchId);
    if (mapped.email && !emails.has(mapped.email)) emails.set(mapped.email, row.batchId);
  }
  return { profiles, emails, organizations };
}

// Marks staged rows that match an existing person or an earlier row in the same batch. Never merges.
// Existing people match by normalized email, then by name plus organization.
// With `linkedin` set, a row also matches the person whose saved linkedinUrl claim is the same profile.
// LinkedIn lead rows carry no email or company before enrichment, so this is the only match they can have.
// With `pendingBatches` set, a row also matches a staged row of another import that still waits on review in
// this workspace, so a repeated capture buys no enrichment for people who are already staged.
export function dedupeImportBatch(tx: Tx, batchId: string, options: { linkedin?: boolean; pendingBatches?: boolean; joinNameOnly?: boolean } = {}): number {
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
  const seenName = new Map<string, number>();
  let duplicates = 0;
  const markDuplicate = tx.db.prepare(
    "UPDATE import_row SET status = 'duplicate', match_entity_type = ?, match_entity_id = ?, reason = ? WHERE id = ?",
  );
  const markLink = tx.db.prepare(
    "UPDATE import_row SET match_entity_type = 'organization', match_entity_id = ?, reason = ? WHERE id = ?",
  );

  const seenOrganization = new Map<string, number>();
  for (const row of rows) {
    const mapped = parseMapped(row.mapped);
    if (mapped.kind === 'organization') {
      // Organization rows match existing organizations by domain, then name, and other pending imports by name.
      const nameKey = mapped.company ? normalizeName(mapped.company) : '';
      const existing =
        (mapped.domain ? organizationsByDomain.get(mapped.domain) : undefined) ?? (nameKey !== '' ? organizationsByName.get(nameKey) : undefined);
      const pendingOrganization = nameKey !== '' ? pending?.organizations.get(nameKey) : undefined;
      const earlierOrganization = nameKey !== '' ? seenOrganization.get(nameKey) : undefined;
      if (existing) {
        markDuplicate.run('organization', existing, 'Organization matches an existing organization.', row.id);
        duplicates += 1;
      } else if (pendingOrganization) {
        markDuplicate.run(null, null, `Already staged in another pending import (${pendingOrganization}).`, row.id);
        duplicates += 1;
      } else if (earlierOrganization !== undefined) {
        markDuplicate.run(null, null, `Same organization name as row ${earlierOrganization} in this import.`, row.id);
        duplicates += 1;
      } else if (nameKey !== '') {
        seenOrganization.set(nameKey, row.seq);
      }
      continue;
    }
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
    // A row with only a name carries nothing that could tell a second person apart, so it joins any earlier row of that name.
    // Lead capture turns this off: its contract keeps every item without a profile URL as its own visible row.
    const nameOnly = options.joinNameOnly !== false && Boolean(normalizedName) && !mapped.email && !companyKey;
    const earlierNameOnly = nameOnly && normalizedName ? seenName.get(normalizedName) : undefined;

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
    } else if (earlierNameOnly !== undefined) {
      markDuplicate.run(null, null, `Same name as row ${earlierNameOnly} in this import.`, row.id);
      duplicates += 1;
    } else {
      if (normalizedName && !seenName.has(normalizedName)) seenName.set(normalizedName, row.seq);
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
      .prepare("SELECT mapped, raw FROM import_row WHERE batch_id = ? AND status = 'staged' ORDER BY seq LIMIT ?")
      .all(batch.id, reviewSampleSize) as { mapped: string; raw: string }[]
  ).map((row) => {
    const mapped = parseMapped(row.mapped);
    // A mailbox row shows who the person is and how much mail there is, from the counts its raw column keeps.
    if (batch.sourceKind === 'mailbox') {
      const counts = JSON.parse(row.raw) as { inbound?: number; outbound?: number; lastSeenAt?: string };
      return { email: mapped.email, name: mapped.name, inbound: counts.inbound ?? 0, outbound: counts.outbound ?? 0, lastSeenAt: counts.lastSeenAt ?? null };
    }
    const base = { name: mapped.name, email: mapped.email, company: mapped.company };
    // A transcript row shows what the model read and the verbatim line it read it from.
    if (batch.sourceKind === 'transcript') {
      const raw = JSON.parse(row.raw) as { quote?: unknown };
      return {
        ...base,
        title: mapped.title,
        linkedinUrl: mapped.linkedinUrl,
        kind: mapped.kind === 'organization' ? 'organization' : 'person',
        quote: typeof raw.quote === 'string' ? raw.quote : null,
      };
    }
    // Lead capture rows also show the title and the profile, which are what the reviewer approves.
    return batch.sourceKind === 'lead_capture'
      ? { ...base, title: mapped.title, linkedinUrl: mapped.linkedinUrl, kind: mapped.kind === 'organization' ? 'organization' : 'person' }
      : base;
  });
  // A mailbox accept promotes each new person with stored inbound mail, so count those staged rows now, with the
  // predicate the accept applies: any unfiled stored inbound message from the row's address, across all stored mail,
  // not just the scanned window, because linkStoredMessagesToPerson links everything whatever window the scan used.
  const willPromote =
    batch.sourceKind === 'mailbox'
      ? (
          tx.db
            .prepare(
              `SELECT COUNT(*) AS n FROM import_row r
               WHERE r.batch_id = ? AND r.status = 'staged'
                 AND EXISTS (
                   SELECT 1 FROM email_message m
                   WHERE m.workspace_id = ? AND m.person_id IS NULL AND m.direction = 'in'
                     AND m.from_email = lower(trim(json_extract(r.mapped, '$.email')))
                 )`,
            )
            .get(batch.id, tx.workspaceId) as { n: number }
        ).n
      : null;
  const payload = {
    batchId: batch.id,
    ...request.payloadSource,
    counts: {
      fetched: counts.fetched,
      staged: counts.staged,
      duplicates: counts.duplicates,
      invalid: counts.invalid,
    },
    ...(willPromote === null ? {} : { willPromote }),
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
  const summary = `${counts.staged} to import, ${counts.duplicates} duplicates, ${counts.invalid} invalid.`;

  // The only place an approval is ever decided without a person, and only for import_review: this one,
  // just created. Mailbox and transcript batches never auto accept: a scan of stored mail and rows read by a model out of untrusted text always wait for a person. The setting is read inside this transaction, so a toggle is seen or not as a whole.
  if (readImportSettings(tx.db, tx.workspaceId).autoAccept && startedByUser(live.run.scope) && batch.sourceKind !== 'mailbox' && batch.sourceKind !== 'transcript') {
    finishStep(tx, runId, live.step, `Auto accepted by the imports setting: ${summary}`);
    const decider = withAuditActor(tx, autoAcceptActor);
    const now = tx.now();
    tx.db
      .prepare("UPDATE approval SET status = 'approved', note = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'")
      .run(autoAcceptNote, now, autoAcceptActor, approvalId);
    decider.audit('approval.approve', 'approval', approvalId, { runId, note: autoAcceptNote, autoAccept: true });
    settleAcceptedImport(decider, live.run, now);
    tx.emit({ type: 'approval_updated', approvalId, runId });
    tx.emit({ type: 'run_updated', runId });
    return;
  }

  finishStep(tx, runId, live.step, `Waiting for review: ${summary}`);
  tx.db.prepare("UPDATE run SET status = 'waiting_approval' WHERE id = ?").run(runId);
  tx.audit('run.waiting_approval', 'run', runId);
  tx.emit({ type: 'run_updated', runId });
}

// What differs between the staged imports that stage everything at creation (CSV and mailbox capture).
export interface StagedImportSpec {
  kind: string;
  actor: string;
  // The reason on a row with neither a name nor an email, and the step detail that reports the check.
  invalidReason: string;
  validatedDetail: (total: number, invalid: number) => string;
  dedupe: { pendingBatches?: boolean };
  // The review request of the last step, built from the run and its batch.
  review: (run: { scope: Record<string, unknown> }, batch: { sourceRef: Record<string, unknown> }) => ReviewRequest;
}

// Moves one step forward in a single transaction. The steps hold no network calls, so a crash leaves the run consistent.
export function advanceStagedImportRun(ctx: ActionContext, runId: string, spec: StagedImportSpec): AdvanceResult {
  const failNow = (tx: Tx, detail: string): AdvanceResult => {
    failImportRunIn(tx, runId, detail);
    return { nextRunAt: null };
  };
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, spec.actor);
    const run = getRun(tx.db, tx.workspaceId, runId);
    if (!run || run.kind !== spec.kind) return { nextRunAt: null };
    const soon = tx.now();

    if (run.status === 'queued') {
      tx.db.prepare("UPDATE run SET status = 'running', started_at = ? WHERE id = ?").run(tx.now(), runId);
      const first = listRunSteps(tx.db, runId).find((step) => step.status === 'pending');
      if (first) startStep(tx, runId, first);
      tx.audit('run.start', 'run', runId, { kind: run.kind });
      tx.emit({ type: 'run_updated', runId });
      return { nextRunAt: soon };
    }
    if (run.status !== 'running') return { nextRunAt: null };

    const steps = listRunSteps(tx.db, runId);
    const active = steps.find((step) => step.status === 'running');
    if (!active) {
      const pending = steps.find((step) => step.status === 'pending');
      if (!pending) return { nextRunAt: null };
      startStep(tx, runId, pending);
      tx.emit({ type: 'run_updated', runId });
      return { nextRunAt: soon };
    }

    const batch = getImportBatchForRun(tx.db, tx.workspaceId, runId);
    if (!batch) return failNow(tx, 'The import batch is missing.');
    const requested = run.counts.requested ?? batch.counts.fetched;

    if (active.seq === 2) {
      const live = liveStep(tx, runId, 2);
      if (!live) return { nextRunAt: null };
      const { total, invalid } = markInvalidRows(tx, batch.id, spec.invalidReason);
      const counts: ImportCounts = { ...batch.counts, invalid, staged: total - invalid };
      writeBatchCounts(tx, batch.id, counts);
      setCounts(tx, runId, importCountsOf(counts, requested));
      completeStep(tx, runId, live.step, spec.validatedDetail(total, invalid));
      return { nextRunAt: soon };
    }
    if (active.seq === 3) {
      const live = liveStep(tx, runId, 3);
      if (!live) return { nextRunAt: null };
      const duplicates = dedupeImportBatch(tx, batch.id, spec.dedupe);
      const counts: ImportCounts = { ...batch.counts, duplicates, staged: batch.counts.fetched - batch.counts.invalid - duplicates };
      writeBatchCounts(tx, batch.id, counts);
      setCounts(tx, runId, importCountsOf(counts, requested));
      completeStep(
        tx,
        runId,
        live.step,
        `Found ${duplicates} duplicates of existing records or earlier rows. ${counts.staged} rows are ready for review.`,
      );
      return { nextRunAt: soon };
    }

    requestImportReview(tx, runId, active.seq, spec.review(run, batch), (detail) => failImportRunIn(tx, runId, detail));
    return { nextRunAt: null };
  });
}
