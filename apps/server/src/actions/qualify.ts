import { z } from 'zod';
import { configSchema, currentTemplateDefaults, readQualificationConfig, readSettings, type QualificationConfig } from '../qualification/config.js';
import { evaluatePerson, type ClaimFact, type PersonFacts } from '../qualification/evaluate.js';
import { getRun, listRunSteps } from '../queries/runs.js';
import type { Row, RunCounts } from '../records.js';
import { type ActionContext, mutate, parseInput, type Tx, withTxActor } from './context.js';
import { type AdvanceResult, finishStep, setCounts, startStep } from './demoResearch.js';
import { enqueueJobIn } from './jobs.js';

export const qualifyKind = 'qualify';
export const qualifyJobKind = 'qualify_step';
export const qualifyActor = 'system:qualify';
export const qualifyStepTitles = ['Load criteria', 'Evaluate people', 'Write results'] as const;
export const qualifyChunkSize = 200;

export const qualifyScopeSchema = z
  .object({ tag: z.string().trim().min(1).max(60).optional() })
  .strict()
  .default({});

export function scheduleQualifyRun(tx: Tx, runId: string, runAt: string): void {
  enqueueJobIn(tx, qualifyJobKind, { runId, workspaceId: tx.workspaceId }, runAt);
}

export function writeConfigIn(tx: Tx, config: QualificationConfig): void {
  const settings = { ...readSettings(tx.db, tx.workspaceId), qualification: config };
  tx.db.prepare('UPDATE workspace SET settings = ? WHERE id = ?').run(JSON.stringify(settings), tx.workspaceId);
  tx.audit('qualification.update', 'workspace', tx.workspaceId, {
    exclusions: config.exclusions.length,
    criteria: config.criteria.length,
  });
  tx.emit({ type: 'record_updated', entityType: 'qualification', entityId: tx.workspaceId });
}

// Replaces the whole config. Anything not in the input is removed.
export function saveQualificationConfig(ctx: ActionContext, input: unknown): QualificationConfig {
  const data = parseInput(configSchema, input);
  return mutate(ctx, (tx) => {
    writeConfigIn(tx, data);
    return data;
  });
}

// Writes the template defaults when no config is saved yet. Used by the seed.
export function saveDefaultQualificationConfig(ctx: ActionContext): QualificationConfig {
  return saveQualificationConfig(ctx, currentTemplateDefaults(ctx.db, ctx.workspaceId));
}

interface QualifyScope {
  tag?: string;
  snapshot?: QualificationConfig;
  totalPeople?: number;
  cursor?: string | null;
  found?: number;
  flagged?: number;
  excluded?: number;
  processed?: number;
}

function patchScope(tx: Tx, runId: string, patch: Record<string, unknown>): void {
  const row = tx.db.prepare('SELECT scope FROM run WHERE id = ?').get(runId) as { scope: string };
  const merged = { ...(JSON.parse(row.scope) as Record<string, unknown>), ...patch };
  tx.db.prepare('UPDATE run SET scope = ? WHERE id = ?').run(JSON.stringify(merged), runId);
}

function parseTags(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

const tagClause = "EXISTS (SELECT 1 FROM json_each(p.tags) WHERE lower(value) = lower(?))";

function countPeople(tx: Tx, tag: string | undefined): number {
  const sql = `SELECT COUNT(*) AS n FROM person p WHERE p.workspace_id = ?${tag ? ` AND ${tagClause}` : ''}`;
  const params: unknown[] = tag ? [tx.workspaceId, tag] : [tx.workspaceId];
  return Number((tx.db.prepare(sql).get(...params) as { n: number }).n);
}

// Newest claim per entity and field, read for one chunk of entities.
function newestClaims(tx: Tx, entityType: 'person' | 'organization', ids: string[]): Map<string, ClaimFact> {
  const result = new Map<string, ClaimFact>();
  if (ids.length === 0) return result;
  const rows = tx.db
    .prepare(
      `SELECT id, entity_id, field, value, status, observed_at FROM field_claim
       WHERE workspace_id = ? AND entity_type = ? AND entity_id IN (${ids.map(() => '?').join(', ')})
       AND field IN ('title', 'location', 'email', 'name', 'domain')
       ORDER BY observed_at DESC, created_at DESC, id DESC`,
    )
    .all(tx.workspaceId, entityType, ...ids) as Row[];
  for (const row of rows) {
    const key = `${String(row.entity_id)}|${String(row.field)}`;
    if (result.has(key)) continue;
    result.set(key, {
      id: String(row.id),
      value: String(row.value),
      status: String(row.status),
      observedAt: String(row.observed_at),
    });
  }
  return result;
}

function evaluateChunk(tx: Tx, runId: string, scope: QualifyScope, config: QualificationConfig) {
  const params: unknown[] = [tx.workspaceId];
  let where = 'p.workspace_id = ?';
  if (scope.cursor) {
    where += ' AND p.id > ?';
    params.push(scope.cursor);
  }
  if (scope.tag) {
    where += ` AND ${tagClause}`;
    params.push(scope.tag);
  }
  const people = tx.db
    .prepare(
      `SELECT p.*, o.id AS org_id, o.name AS org_name, o.kind AS org_kind, o.domain AS org_domain,
              o.location AS org_location, o.tags AS org_tags
       FROM person p LEFT JOIN organization o ON o.id = p.organization_id AND o.workspace_id = p.workspace_id
       WHERE ${where} ORDER BY p.id LIMIT ?`,
    )
    .all(...params, qualifyChunkSize) as Row[];

  const personClaims = newestClaims(tx, 'person', people.map((row) => String(row.id)));
  const organizationIds = [...new Set(people.filter((row) => row.org_id).map((row) => String(row.org_id)))];
  const organizationClaims = newestClaims(tx, 'organization', organizationIds);

  const now = tx.now();
  const write = tx.db.prepare(
    `INSERT INTO qualification_result (id, created_at, workspace_id, person_id, run_id, payload, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, person_id) DO UPDATE SET run_id = excluded.run_id, payload = excluded.payload, updated_at = excluded.updated_at`,
  );
  let found = 0;
  let flagged = 0;
  let excluded = 0;
  for (const row of people) {
    const personId = String(row.id);
    const organizationId = row.org_id ? String(row.org_id) : null;
    const facts: PersonFacts = {
      person: {
        name: `${String(row.first_name)} ${String(row.last_name ?? '')}`.trim(),
        title: row.title === null ? null : String(row.title),
        location: row.location === null ? null : String(row.location),
        email: row.email === null ? null : String(row.email),
        tags: parseTags(row.tags),
      },
      organization: organizationId
        ? {
            name: String(row.org_name),
            kind: String(row.org_kind),
            domain: row.org_domain === null ? null : String(row.org_domain),
            location: row.org_location === null ? null : String(row.org_location),
            tags: parseTags(row.org_tags),
          }
        : null,
      personClaim: (field) => personClaims.get(`${personId}|${field}`),
      organizationClaim: (field) => (organizationId ? organizationClaims.get(`${organizationId}|${field}`) : undefined),
    };
    const payload = evaluatePerson(config, facts, now);
    write.run(tx.newId('qlr'), now, tx.workspaceId, personId, runId, JSON.stringify(payload), now);
    if (payload.total > 0 && payload.matched === payload.total) found += 1;
    if (payload.unknown > 0) flagged += 1;
    if (payload.excluded) excluded += 1;
  }
  const last = people[people.length - 1];
  return { processed: people.length, found, flagged, excluded, lastId: last ? String(last.id) : null };
}

function skipRemainingSteps(tx: Tx, runId: string): void {
  const now = tx.now();
  for (const step of listRunSteps(tx.db, runId)) {
    if (step.status === 'pending' || step.status === 'running') {
      tx.db.prepare("UPDATE run_step SET status = 'skipped', finished_at = ? WHERE id = ?").run(now, step.id);
    }
  }
}

// Each call does one transaction of work: start the run, load the criteria, evaluate one chunk of people, or
// finish. Results are saved chunk by chunk, so progress survives a restart and no transaction runs long.
export function advanceQualifyRun(ctx: ActionContext, runId: string): AdvanceResult {
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, qualifyActor);
    const run = getRun(tx.db, tx.workspaceId, runId);
    if (!run || run.kind !== qualifyKind) return { nextRunAt: null };
    const soon = tx.now();
    const steps = listRunSteps(tx.db, runId);

    if (run.status === 'queued') {
      tx.db.prepare("UPDATE run SET status = 'running', started_at = ? WHERE id = ?").run(tx.now(), runId);
      const first = steps[0];
      if (first) startStep(tx, runId, first);
      tx.audit('run.start', 'run', runId, { kind: run.kind });
      tx.emit({ type: 'run_updated', runId });
      return { nextRunAt: soon };
    }
    if (run.status !== 'running') return { nextRunAt: null };

    const active = steps.find((step) => step.status === 'running');
    if (!active) {
      const pending = steps.find((step) => step.status === 'pending');
      if (!pending) return { nextRunAt: null };
      startStep(tx, runId, pending);
      tx.emit({ type: 'run_updated', runId });
      return { nextRunAt: soon };
    }

    const scope = run.scope as QualifyScope;
    const advanceTo = (step: { id: string; seq: number }, detail: string): void => {
      finishStep(tx, runId, step, detail);
      const next = steps.find((candidate) => candidate.seq > step.seq && candidate.status === 'pending');
      if (next) startStep(tx, runId, next);
    };

    if (active.seq === 1) {
      const config = readQualificationConfig(tx.db, tx.workspaceId);
      const snapshot: QualificationConfig = { exclusions: config.exclusions, criteria: config.criteria };
      const enabled = snapshot.criteria.filter((criterion) => criterion.enabled).length;
      const rules = snapshot.exclusions.filter((exclusion) => exclusion.enabled).length;
      const totalPeople = countPeople(tx, scope.tag);
      patchScope(tx, runId, { snapshot, totalPeople, cursor: null });
      const where = scope.tag ? ` tagged "${scope.tag}"` : '';
      if (totalPeople === 0) {
        finishStep(tx, runId, active, `Loaded ${enabled} criteria and ${rules} exclusions. No people${where} exist, so there is nothing to evaluate.`);
        skipRemainingSteps(tx, runId);
        tx.db.prepare("UPDATE run SET status = 'partial', finished_at = ? WHERE id = ?").run(tx.now(), runId);
        tx.audit('run.partial', 'run', runId, { reason: 'no_people' });
      } else {
        advanceTo(
          active,
          `Loaded ${enabled} enabled criteria and ${rules} enabled exclusions${enabled === 0 ? ' (no criteria are on, so nobody can count as a match)' : ''}. ${totalPeople} ${totalPeople === 1 ? 'person' : 'people'}${where} to evaluate.`,
        );
      }
      tx.emit({ type: 'run_updated', runId });
      return { nextRunAt: totalPeople === 0 ? null : soon };
    }

    if (active.seq === 2) {
      if (!scope.snapshot) {
        tx.db.prepare("UPDATE run SET status = 'failed', finished_at = ? WHERE id = ?").run(tx.now(), runId);
        tx.db.prepare("UPDATE run_step SET status = 'failed', detail = 'The loaded criteria are missing.', finished_at = ? WHERE id = ?").run(tx.now(), active.id);
        tx.audit('run.failed', 'run', runId, { message: 'The loaded criteria are missing.' });
        tx.emit({ type: 'run_updated', runId });
        return { nextRunAt: null };
      }
      const chunk = evaluateChunk(tx, runId, scope, scope.snapshot);
      const processed = (scope.processed ?? 0) + chunk.processed;
      const found = (scope.found ?? 0) + chunk.found;
      const flagged = (scope.flagged ?? 0) + chunk.flagged;
      const excluded = (scope.excluded ?? 0) + chunk.excluded;
      const counts: RunCounts = { processed, found, flagged, excluded };
      setCounts(tx, runId, counts);
      patchScope(tx, runId, { cursor: chunk.lastId ?? scope.cursor ?? null, processed, found, flagged, excluded });
      const detail = `Evaluated ${processed} of ${scope.totalPeople ?? processed} people.`;
      if (chunk.processed < qualifyChunkSize) {
        advanceTo(active, detail);
      } else {
        tx.db.prepare('UPDATE run_step SET detail = ? WHERE id = ?').run(detail, active.id);
        tx.audit('run.step_progress', 'run', runId, { seq: 2, processed });
      }
      tx.emit({ type: 'run_updated', runId });
      return { nextRunAt: soon };
    }

    // Step 3: confirm what was saved. Another qualify run can replace a result, so the check is by run id.
    const processed = scope.processed ?? 0;
    const written = Number(
      (tx.db.prepare('SELECT COUNT(*) AS n FROM qualification_result WHERE workspace_id = ? AND run_id = ?').get(tx.workspaceId, runId) as { n: number }).n,
    );
    const replaced = Math.max(0, processed - written);
    const detail =
      replaced === 0
        ? `Saved ${written} results.`
        : `Saved ${processed} results. Another qualify run has since replaced ${replaced} of them.`;
    finishStep(tx, runId, active, detail);
    tx.db.prepare("UPDATE run SET status = 'succeeded', finished_at = ? WHERE id = ?").run(tx.now(), runId);
    tx.audit('run.succeeded', 'run', runId, { processed, found: scope.found ?? 0, flagged: scope.flagged ?? 0, excluded: scope.excluded ?? 0 });
    tx.audit('qualification.compute', 'qualification', runId, { processed });
    tx.emit({ type: 'record_updated', entityType: 'qualification', entityId: runId });
    tx.emit({ type: 'run_updated', runId });
    return { nextRunAt: null };
  });
}
