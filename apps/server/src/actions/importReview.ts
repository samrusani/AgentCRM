import { type ImportCounts, emptyImportCounts, getImportBatchForRun } from '../queries/imports.js';
import { AppError } from '../errors.js';
import { type Row } from '../records.js';
import { normalizeName, splitName, type MappedRow } from './apifyMapping.js';
import { type Tx, emitRecord } from './context.js';
import { createFieldClaimIn, createOrganizationIn, createPersonIn } from './crud.js';

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
  };
}

function orgKey(mapped: MappedRow): string | null {
  if (mapped.domain) return `d:${mapped.domain}`;
  if (mapped.company) return `n:${normalizeName(mapped.company)}`;
  return null;
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
  const actorId = String(scope.actorId ?? 'unknown');
  const sourceUrl = apifyConsoleRunUrl(String(scope.apifyRunId ?? ''));
  const observedAt = tx.now();

  const rows = (
    tx.db.prepare("SELECT * FROM import_row WHERE batch_id = ? AND status = 'staged' ORDER BY seq").all(batch.id) as Row[]
  ).map(
    (row): StagedRow => ({
      id: String(row.id),
      seq: Number(row.seq),
      mapped: parseMapped(row.mapped),
      matchEntityType: row.match_entity_type === null ? null : String(row.match_entity_type),
      matchEntityId: row.match_entity_id === null ? null : String(row.match_entity_id),
    }),
  );

  const markRow = (rowId: string, status: string, reason: string | null, type: string | null, id: string | null): void => {
    tx.db
      .prepare('UPDATE import_row SET status = ?, reason = ?, match_entity_type = ?, match_entity_id = ? WHERE id = ?')
      .run(status, reason, type, id, rowId);
  };

  // An email can be taken between staging and approval. Skip those rows and say why.
  const importable: StagedRow[] = [];
  let skipped = 0;
  for (const row of rows) {
    const taken = row.mapped.email
      ? (tx.db
          .prepare('SELECT id FROM person WHERE workspace_id = ? AND lower(email) = ?')
          .get(tx.workspaceId, row.mapped.email) as { id: string } | undefined)
      : undefined;
    if (taken) {
      markRow(row.id, 'duplicate', 'A person with this email was added after staging.', 'person', taken.id);
      skipped += 1;
    } else {
      importable.push(row);
    }
  }

  const organizationIds = new Map<string, string>();
  const createdOrganizations = new Set<string>();
  const lookupOrganization = (mapped: MappedRow, hinted: string | null): string | null => {
    if (hinted) {
      const hit = tx.db
        .prepare('SELECT id FROM organization WHERE workspace_id = ? AND id = ?')
        .get(tx.workspaceId, hinted) as { id: string } | undefined;
      if (hit) return hit.id;
    }
    if (mapped.domain) {
      const hit = tx.db
        .prepare('SELECT id FROM organization WHERE workspace_id = ? AND lower(domain) = ?')
        .get(tx.workspaceId, mapped.domain) as { id: string } | undefined;
      if (hit) return hit.id;
    }
    if (mapped.company) {
      const wanted = normalizeName(mapped.company);
      const all = tx.db.prepare('SELECT id, name FROM organization WHERE workspace_id = ?').all(tx.workspaceId) as {
        id: string;
        name: string;
      }[];
      const hit = all.find((candidate) => normalizeName(candidate.name) === wanted);
      if (hit) return hit.id;
    }
    return null;
  };

  const organizationTags = ['apify', `via-${runId}`];
  const personTags = ['apify', `via-${runId}`];

  // Each row gets its own savepoint. A conflict that appeared after staging (an email or domain added
  // since) rolls back only that row, which is marked duplicate. The rest of the approval still commits.
  let accepted = 0;
  const lateConflictReason = 'This row conflicted with a record added after staging.';
  for (const row of importable) {
    tx.db.exec('SAVEPOINT import_row');
    const addedKeys: string[] = [];
    const addedOrganizations: string[] = [];
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
            const orgClaims: [string, string | null][] = [
              ['name', name],
              ['domain', mapped.domain],
            ];
            for (const [field, value] of orgClaims) {
              if (!value) continue;
              createFieldClaimIn(tx, {
                entityType: 'organization',
                entityId: organizationId,
                field,
                value: value.slice(0, longestClaim),
                sourceUrl,
                sourceType: 'apify',
                observedAt,
                status: 'imported',
                extractionMethod: actorId,
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
        tags: personTags,
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
          sourceUrl,
          sourceType: 'apify',
          observedAt,
          status: 'imported',
          extractionMethod: actorId,
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
