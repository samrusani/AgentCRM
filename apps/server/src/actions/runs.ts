import { z } from 'zod';
import { conflict, validationError } from '../errors.js';
import { getRunDetail, listRunSteps, requireRun } from '../queries/runs.js';
import { dotSegmentMessage, hasDotSegment } from '../providers/apify.js';
import { getConnector } from '../queries/connectors.js';
import { requireOrganization } from '../queries/organizations.js';
import { requirePerson } from '../queries/people.js';
import { isActiveModelReady } from '../queries/modelProvider.js';
import { terminalRunStatuses, type RunCounts } from '../records.js';
import { apifyKind, apifyStepTitles, defaultMaxItems, hardMaxItems, scheduleApifyRun } from './apifyScrape.js';
import { allowlistIncludes, connectApifyMessage, requireActiveModel } from './connectors.js';
import { type ActionContext, mutate, parseInput, type Tx } from './context.js';
import { defaultTargetCount, demoStepTitles, maxTargetCount, scheduleDemoRun } from './demoResearch.js';
import { csvImportKind, scheduleCsvImportRun } from './csvImport.js';
import {
  defaultEnrichLimit,
  defaultMaxPeople,
  hardEnrichLimit,
  hardMaxPeople,
  hasUnfinishedCall,
  leadCaptureKind,
  leadCaptureStepTitles,
  requestedPeople,
  postNeedsProviderMessage,
  type SourceName,
  scheduleLeadCaptureRun,
  sourceNames,
} from './leadCapture.js';
import { isLinkedinPostUrl, postUrlShapesMessage } from './leadCaptureMapping.js';
import { defaultAgentBudgetUsd, draftKind, draftScopeSchema, draftStepTitlesFor, scheduleDraftRun } from './draftOutreach.js';
import {
  enrichByAgentMessage,
  enrichPersonStartScope,
  enrichPersonStepTitles,
  scheduleEnrichPersonRun,
} from './enrichPerson.js';
import {
  enrichOrganizationByAgentMessage,
  enrichOrganizationStartScope,
  enrichOrganizationStepTitles,
  scheduleEnrichOrganizationRun,
} from './enrichOrganization.js';
import { enrichOrganizationKind, enrichPersonKind, isEnrichKind, noteUnknownStartOnCancelIn } from './enrichRun.js';
import { closeImportBatchForRun } from './importReview.js';
import { idSchema } from './schemas.js';
import { cancelIntentsForRunIn } from './sendIntents.js';
import { qualifyKind, qualifyScopeSchema, qualifyStepTitles, scheduleQualifyRun } from './qualify.js';

const demoRunSchema = z
  .object({
    kind: z.literal('demo_research'),
    title: z.string().trim().min(1).max(200).optional(),
    scope: z
      .object({
        targetCount: z.number().int().min(1).max(maxTargetCount).default(defaultTargetCount),
        query: z.string().trim().max(200).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

const apifyRunSchema = z
  .object({
    kind: z.literal('apify_scrape'),
    title: z.string().trim().min(1).max(200).optional(),
    scope: z
      .object({
        actorId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9_.~/-]+$/, 'Use an actor id like username/actor-name')
          .refine((value) => !hasDotSegment(value), dotSegmentMessage),
        input: z.record(z.unknown()),
        maxItems: z.number().int().min(1).max(hardMaxItems).default(defaultMaxItems),
      })
      .strict(),
  })
  .strict();

const qualifyRunSchema = z
  .object({
    kind: z.literal('qualify'),
    title: z.string().trim().min(1).max(200).optional(),
    scope: qualifyScopeSchema,
  })
  .strict();

const draftRunSchema = z
  .object({
    kind: z.literal('draft_outreach'),
    title: z.string().trim().min(1).max(200).optional(),
    scope: draftScopeSchema,
  })
  .strict();

const leadCaptureRunSchema = z
  .object({
    kind: z.literal('lead_capture'),
    title: z.string().trim().min(1).max(200).optional(),
    scope: z
      .object({
        postUrl: z
          .string()
          .trim()
          .min(1)
          .max(500, 'Use a post link of at most 500 characters')
          .refine(isLinkedinPostUrl, postUrlShapesMessage),
        // Left out, a user's sources default to all three when a model provider is ready, else reactions and comments.
        // An agent's default is always reactions and comments: reading the post text must be asked for.
        sources: z
          .array(z.enum(sourceNames))
          .min(1, 'Choose at least one source: post, reactions, or comments')
          .optional()
          .transform((chosen) => (chosen ? sourceNames.filter((name) => chosen.includes(name)) : undefined)),
        maxPeople: z.number().int().min(1).max(hardMaxPeople).default(defaultMaxPeople),
        enrich: z.boolean().default(true),
        enrichLimit: z.number().int().min(1).max(hardEnrichLimit).default(defaultEnrichLimit),
      })
      .strict(),
  })
  .strict();

const enrichPersonRunSchema = z
  .object({
    kind: z.literal('enrich_person'),
    title: z.string().trim().min(1).max(200).optional(),
    scope: z.object({ personId: idSchema }).strict(),
  })
  .strict();

const enrichOrganizationRunSchema = z
  .object({
    kind: z.literal('enrich_organization'),
    title: z.string().trim().min(1).max(200).optional(),
    scope: z.object({ organizationId: idSchema }).strict(),
  })
  .strict();

const startRunSchema = z.discriminatedUnion('kind', [
  demoRunSchema,
  apifyRunSchema,
  qualifyRunSchema,
  draftRunSchema,
  leadCaptureRunSchema,
  enrichPersonRunSchema,
  enrichOrganizationRunSchema,
]);

export interface StartRunOptions {
  // Runs started by an agent (MCP or the agent endpoint) may only use allowlisted Apify actors.
  origin?: 'user' | 'agent';
}

function assertApifyRunAllowed(ctx: ActionContext, actorId: string, origin: 'user' | 'agent'): void {
  const connector = getConnector(ctx.db, ctx.workspaceId, 'apify');
  if (!connector) throw conflict(connectApifyMessage);
  if (connector.status !== 'connected') throw conflict('Apify rejected the saved API token. Update it in Settings.');
  if (origin === 'agent' && !allowlistIncludes(connector, actorId)) {
    throw conflict(
      `Actor "${actorId}" is not on the Apify allowlist. Add it to the allowlist in Settings before an agent can run it.`,
    );
  }
}

// Resolves the three actor ids from the connector settings. The run freezes them, so a later settings edit changes nothing.
function assertLeadCaptureAllowed(
  ctx: ActionContext,
  scope: { sources: readonly string[]; enrich: boolean },
  origin: 'user' | 'agent',
) {
  const connector = getConnector(ctx.db, ctx.workspaceId, 'apify');
  if (!connector) throw conflict(connectApifyMessage);
  if (connector.status !== 'connected') throw conflict('Apify rejected the saved API token. Update it in Settings.');
  const configured = connector.settings.leadCapture;
  const actors = { post: configured.postActor, reactions: configured.reactionsActor, comments: configured.commentsActor, profile: configured.profileActor };
  if (origin === 'agent') {
    const involved = [
      ...(scope.sources.includes('post') ? [actors.post] : []),
      ...(scope.sources.includes('reactions') ? [actors.reactions] : []),
      ...(scope.sources.includes('comments') ? [actors.comments] : []),
      ...(scope.enrich ? [actors.profile] : []),
    ];
    const missing = involved.filter((actorId) => !allowlistIncludes(connector, actorId));
    if (missing.length > 0) {
      throw conflict(
        `${missing.length === 1 ? 'Actor' : 'Actors'} ${missing.map((id) => `"${id}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on the Apify allowlist. Add ${missing.length === 1 ? 'it' : 'them'} to the allowlist in Settings before an agent can run a lead capture.`,
      );
    }
  }
  return actors;
}

// The sources a lead capture starts with. Reading the post text needs a ready model provider, and it spends the
// user's model credit, so an agent gets it only when it names the source.
function resolveLeadSources(ctx: ActionContext, chosen: SourceName[] | undefined, origin: 'user' | 'agent'): SourceName[] {
  const ready = isActiveModelReady(ctx.db, ctx.workspaceId);
  if (!chosen) return origin === 'agent' || !ready ? sourceNames.filter((name) => name !== 'post') : [...sourceNames];
  if (chosen.includes('post') && !ready) throw validationError(`scope.sources: ${postNeedsProviderMessage}`);
  return chosen;
}

// Draft runs use the active model provider. The run keeps that provider and model for its whole life.
function assertDraftRunAllowed(ctx: ActionContext) {
  const { kind, label, model } = requireActiveModel(ctx);
  return { kind, label, model };
}

// The post link without its query, for run titles.
function postUrlLabel(postUrl: string): string {
  try {
    const url = new URL(postUrl);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname}`.slice(0, 120);
  } catch {
    return postUrl.slice(0, 120);
  }
}

export function scheduleRunJob(tx: Tx, kind: string, runId: string, runAt: string): void {
  if (kind === apifyKind) scheduleApifyRun(tx, runId, runAt);
  else if (kind === leadCaptureKind) scheduleLeadCaptureRun(tx, runId, runAt);
  else if (kind === enrichPersonKind) scheduleEnrichPersonRun(tx, runId, runAt);
  else if (kind === enrichOrganizationKind) scheduleEnrichOrganizationRun(tx, runId, runAt);
  else if (kind === draftKind) scheduleDraftRun(tx, runId, runAt);
  else if (kind === csvImportKind) scheduleCsvImportRun(tx, runId, runAt);
  else if (kind === qualifyKind) scheduleQualifyRun(tx, runId, runAt);
  else scheduleDemoRun(tx, runId, runAt);
}

export function startRun(ctx: ActionContext, input: unknown, options: StartRunOptions = {}) {
  const parsed = parseInput(startRunSchema, input);
  const origin = options.origin ?? 'user';
  // Enrichment spends the user's Apify credit on one scrape or lookup and is started from the record sheet only.
  if (parsed.kind === 'enrich_person' && origin === 'agent') throw validationError(enrichByAgentMessage);
  if (parsed.kind === 'enrich_organization' && origin === 'agent') throw validationError(enrichOrganizationByAgentMessage);
  const data =
    parsed.kind === 'lead_capture'
      ? { ...parsed, scope: { ...parsed.scope, sources: resolveLeadSources(ctx, parsed.scope.sources, origin) } }
      : parsed;
  if (data.kind === 'apify_scrape') assertApifyRunAllowed(ctx, data.scope.actorId, origin);
  const leadActors = data.kind === 'lead_capture' ? assertLeadCaptureAllowed(ctx, data.scope, origin) : null;
  const draftConnector = data.kind === 'draft_outreach' ? assertDraftRunAllowed(ctx) : null;
  const runId = mutate(ctx, (tx) => {
    const id = tx.newId('run');
    const now = tx.now();
    let title: string;
    let stepTitles: readonly string[];
    let counts: RunCounts;
    let auditScope: Record<string, unknown>;
    let storedScope: Record<string, unknown> = data.scope;
    // Agent started imports and draft runs share one slot, checked inside the write transaction so two processes cannot both pass it.
    if (origin === 'agent' && (data.kind === 'apify_scrape' || data.kind === 'draft_outreach' || data.kind === 'lead_capture')) {
      const open = tx.db
        .prepare(
          "SELECT 1 FROM run WHERE workspace_id = ? AND kind IN (?, ?, ?) AND json_extract(scope, '$.origin') = 'agent' AND status IN ('queued', 'running', 'paused', 'waiting_approval') LIMIT 1",
        )
        .get(tx.workspaceId, apifyKind, draftKind, leadCaptureKind);
      if (open) {
        throw conflict(
          'One agent started run may be open at a time, and imports and draft runs share that limit. Approve, reject, or cancel the open agent run first.',
        );
      }
      storedScope = { ...data.scope, origin: 'agent' };
    }
    if (data.kind === 'draft_outreach') {
      title = data.title ?? (data.scope.tag ? `Draft outreach to people tagged ${data.scope.tag}` : 'Draft outreach emails');
      stepTitles = draftStepTitlesFor(draftConnector!.label);
      counts = { processed: 0, found: 0, flagged: 0, estimatedUsd: 0 };
      // An agent that sets no budget gets a default one, and the run scope records that it was defaulted.
      // A local model costs nothing, so an agent run on Ollama gets no dollar budget and the scope records null.
      const unbudgeted = origin === 'agent' && data.scope.budgetUsd === undefined;
      const local = draftConnector!.kind === 'ollama';
      const defaulted = unbudgeted && !local;
      const skippedBudget = unbudgeted && local;
      storedScope = {
        ...storedScope,
        provider: draftConnector!.kind,
        model: draftConnector!.model,
        ...(defaulted ? { budgetUsd: defaultAgentBudgetUsd, budgetDefaulted: true } : {}),
        ...(skippedBudget ? { budgetUsd: null } : {}),
      };
      auditScope = {
        scope: {
          ...data.scope,
          instructions: data.scope.instructions ? '(set)' : undefined,
          ...(defaulted ? { budgetUsd: defaultAgentBudgetUsd, budgetDefaulted: true } : {}),
          ...(skippedBudget ? { budgetUsd: null, budgetNote: 'No dollar budget, because a local model costs nothing.' } : {}),
        },
        origin,
        provider: draftConnector!.kind,
        model: draftConnector!.model,
      };
    } else if (data.kind === 'apify_scrape') {
      title = data.title ?? `Apify import: ${data.scope.actorId}`;
      stepTitles = apifyStepTitles;
      counts = {
        processed: 0,
        found: 0,
        flagged: 0,
        requested: data.scope.maxItems,
        fetched: 0,
        staged: 0,
        duplicates: 0,
        invalid: 0,
        accepted: 0,
      };
      auditScope = { actorId: data.scope.actorId, maxItems: data.scope.maxItems, origin };
    } else if (data.kind === 'lead_capture') {
      title = data.title ?? `LinkedIn lead capture: ${postUrlLabel(data.scope.postUrl)}`;
      stepTitles = leadCaptureStepTitles;
      counts = {
        processed: 0,
        found: 0,
        flagged: 0,
        requested: requestedPeople(data.scope),
        fetched: 0,
        staged: 0,
        duplicates: 0,
        invalid: 0,
        accepted: 0,
      };
      // A run that reads the post text pins the provider and model it will use, like a draft run does.
      const pinned = data.scope.sources.includes('post') ? requireActiveModel(ctx) : null;
      storedScope = { ...storedScope, actors: leadActors!, calls: {}, ...(pinned ? { provider: pinned.kind, model: pinned.model } : {}) };
      auditScope = { ...data.scope, actors: leadActors, origin, ...(pinned ? { provider: pinned.kind, model: pinned.model } : {}) };
    } else if (data.kind === 'enrich_person') {
      const enrichScope = enrichPersonStartScope(tx, data.scope.personId);
      const person = requirePerson(tx.db, tx.workspaceId, data.scope.personId);
      title = data.title ?? `Enrich ${person.name}`;
      stepTitles = enrichPersonStepTitles;
      counts = { processed: 0, found: 0, flagged: 0 };
      storedScope = { ...enrichScope };
      auditScope = { personId: enrichScope.personId, actorId: enrichScope.actorId, origin };
    } else if (data.kind === 'enrich_organization') {
      const enrichScope = enrichOrganizationStartScope(tx, data.scope.organizationId);
      const organization = requireOrganization(tx.db, tx.workspaceId, data.scope.organizationId);
      title = data.title ?? `Enrich ${organization.name}`;
      stepTitles = enrichOrganizationStepTitles;
      counts = { processed: 0, found: 0, flagged: 0 };
      storedScope = { ...enrichScope };
      auditScope = { organizationId: enrichScope.organizationId, actorId: enrichScope.actorId, origin };
    } else if (data.kind === 'qualify') {
      title = data.title ?? (data.scope.tag ? `Qualify people tagged ${data.scope.tag}` : 'Qualify people');
      stepTitles = qualifyStepTitles;
      counts = { processed: 0, found: 0, flagged: 0, excluded: 0 };
      auditScope = { scope: data.scope, origin };
    } else {
      title =
        data.title ??
        (data.scope.query ? `Simulated research: ${data.scope.query}` : 'Simulated research: investor shortlist');
      stepTitles = demoStepTitles;
      counts = { processed: 0, found: 0, flagged: 0 };
      auditScope = { scope: data.scope };
    }
    // Every run records who started it. The auto accept gate reads this and fails closed when it is absent.
    storedScope = { ...storedScope, origin };
    tx.db
      .prepare(
        `INSERT INTO run (id, created_at, workspace_id, kind, title, status, scope, counts)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(id, now, tx.workspaceId, data.kind, title, JSON.stringify(storedScope), JSON.stringify(counts));
    stepTitles.forEach((stepTitle, index) => {
      tx.db
        .prepare("INSERT INTO run_step (id, created_at, run_id, seq, title, status) VALUES (?, ?, ?, ?, ?, 'pending')")
        .run(tx.newId('stp'), now, id, index + 1, stepTitle);
    });
    scheduleRunJob(tx, data.kind, id, now);
    tx.audit('run.create', 'run', id, { kind: data.kind, ...auditScope });
    tx.emit({ type: 'run_updated', runId: id });
    return id;
  });
  return getRunDetail(ctx.db, ctx.workspaceId, runId);
}

const controlSchema = z.object({ action: z.enum(['pause', 'resume', 'cancel']) }).strict();

export function controlRun(ctx: ActionContext, runId: string, input: unknown) {
  const { action } = parseInput(controlSchema, input);
  mutate(ctx, (tx) => {
    const run = requireRun(tx.db, tx.workspaceId, runId);
    const now = tx.now();
    if (action === 'pause') {
      if (run.kind === 'send_outreach') {
        throw conflict('A send cannot be paused. Cancel the run to stop messages that have not started sending.');
      }
      if (run.status !== 'running' && run.status !== 'queued') {
        throw conflict(`A run that is ${run.status.replace('_', ' ')} cannot be paused.`);
      }
      tx.db.prepare("UPDATE run SET status = 'paused' WHERE id = ?").run(runId);
    } else if (action === 'resume') {
      if (run.status !== 'paused') {
        throw conflict(`A run that is ${run.status.replace('_', ' ')} cannot be resumed.`);
      }
      tx.db.prepare('UPDATE run SET status = ? WHERE id = ?').run(run.startedAt ? 'running' : 'queued', runId);
      scheduleRunJob(tx, run.kind, runId, now);
    } else {
      if ((terminalRunStatuses as readonly string[]).includes(run.status)) {
        throw conflict(`A run that is ${run.status} cannot be cancelled.`);
      }
      cancelRunIn(tx, runId, 'Cancelled by a user action.');
      // A paused or idle run has no job left. Queue one so the worker asks Apify to stop the actor run.
      const scope = run.scope as { apifyRunId?: string; apifyFinished?: boolean; abortRequested?: boolean };
      if (run.kind === apifyKind && scope.apifyRunId && !scope.apifyFinished && !scope.abortRequested) {
        scheduleRunJob(tx, run.kind, runId, now);
      }
      // A lead capture run may have several remote calls. The job asks Apify to stop every unfinished one.
      if (isEnrichKind(run.kind)) noteUnknownStartOnCancelIn(tx, runId, run.scope);
      if (isEnrichKind(run.kind) && scope.apifyRunId && !scope.apifyFinished && !scope.abortRequested) {
        scheduleRunJob(tx, run.kind, runId, now);
      }
      if (run.kind === leadCaptureKind && hasUnfinishedCall(run.scope)) {
        scheduleRunJob(tx, run.kind, runId, now);
      }
    }
    tx.audit(`run.${action}`, 'run', runId);
    tx.emit({ type: 'run_updated', runId });
  });
  return getRunDetail(ctx.db, ctx.workspaceId, runId);
}

// Cancel is final: unfinished steps are skipped and any pending approval is closed as rejected.
export function cancelRunIn(tx: Tx, runId: string, reason: string): void {
  const now = tx.now();
  tx.db.prepare("UPDATE run SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now, runId);
  for (const step of listRunSteps(tx.db, runId)) {
    if (step.status === 'pending' || step.status === 'running') {
      tx.db
        .prepare("UPDATE run_step SET status = 'skipped', detail = COALESCE(detail, ?), finished_at = ? WHERE id = ?")
        .run(reason, now, step.id);
    }
  }
  closeImportBatchForRun(tx, runId, 'rejected', reason);
  cancelIntentsForRunIn(tx, runId, reason);
  const pending = tx.db
    .prepare("SELECT id FROM approval WHERE run_id = ? AND status = 'pending'")
    .all(runId) as { id: string }[];
  for (const approval of pending) {
    tx.db
      .prepare("UPDATE approval SET status = 'rejected', note = ?, decided_at = ?, decided_by = 'system' WHERE id = ?")
      .run(reason, now, approval.id);
    tx.audit('approval.reject', 'approval', approval.id, { runId, reason });
    tx.emit({ type: 'approval_updated', approvalId: approval.id, runId });
  }
}

export function failRun(ctx: ActionContext, runId: string, message: string): void {
  mutate(ctx, (tx) => {
    const run = requireRun(tx.db, tx.workspaceId, runId);
    if ((terminalRunStatuses as readonly string[]).includes(run.status)) return;
    const now = tx.now();
    tx.db.prepare("UPDATE run SET status = 'failed', finished_at = ? WHERE id = ?").run(now, runId);
    for (const step of listRunSteps(tx.db, runId)) {
      if (step.status === 'running') {
        tx.db
          .prepare("UPDATE run_step SET status = 'failed', detail = ?, finished_at = ? WHERE id = ?")
          .run(message, now, step.id);
      } else if (step.status === 'pending') {
        tx.db.prepare("UPDATE run_step SET status = 'skipped', finished_at = ? WHERE id = ?").run(now, step.id);
      }
    }
    closeImportBatchForRun(tx, runId, 'failed', message);
    tx.audit('run.failed', 'run', runId, { message });
    tx.emit({ type: 'run_updated', runId });
  });
}
