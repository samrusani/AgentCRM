import type { ModelCallReport, ModelProviderKind } from '../providers/modelTypes.js';
import { estimateModelCostUsd } from '../providers/presets.js';
import { type ActionContext, mutate, type Tx } from './context.js';

export type ModelCallPurpose = 'chat' | 'draft';

// Writes one model_call row for one provider response. The audit row holds counts and the estimate, never a key.
// Callers that checkpoint work use this inside their own transaction so the cost and the result save together.
export function recordModelCallIn(
  tx: Tx,
  input: { purpose: ModelCallPurpose; runId: string | null; report: ModelCallReport },
): number {
  const estimatedUsd = estimateModelCostUsd(input.report.provider, input.report.model, input.report.usage);
  const id = tx.newId('mcl');
  tx.db
    .prepare(
      `INSERT INTO model_call (id, created_at, workspace_id, run_id, purpose, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, estimated_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tx.now(),
      tx.workspaceId,
      input.runId,
      input.purpose,
      input.report.provider,
      input.report.model,
      input.report.usage.inputTokens,
      input.report.usage.outputTokens,
      input.report.usage.cacheReadTokens,
      input.report.usage.cacheCreationTokens,
      estimatedUsd,
    );
  tx.audit('model.call', 'model_call', id, auditDetail(input.purpose, input.runId, input.report, estimatedUsd));
  return estimatedUsd;
}

function auditDetail(purpose: ModelCallPurpose, runId: string | null, report: ModelCallReport, estimatedUsd: number) {
  return {
    purpose,
    runId,
    provider: report.provider,
    model: report.model,
    inputTokens: report.usage.inputTokens,
    outputTokens: report.usage.outputTokens,
    cacheReadTokens: report.usage.cacheReadTokens,
    cacheCreationTokens: report.usage.cacheCreationTokens,
    estimatedUsd,
  };
}

// A start marker, written in its own transaction just before a provider call. It has zero tokens and no cost.
// If the process dies during the call, the row stays pending and the outcome of the call is unknown.
export function markModelCallPending(
  ctx: ActionContext,
  input: { purpose: ModelCallPurpose; runId: string; provider: ModelProviderKind; model: string; subjectId: string },
): string {
  return mutate(ctx, (tx) => {
    const id = tx.newId('mcl');
    tx.db
      .prepare(
        `INSERT INTO model_call (id, created_at, workspace_id, run_id, purpose, provider, model, pending, subject_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(id, tx.now(), tx.workspaceId, input.runId, input.purpose, input.provider, input.model, input.subjectId);
    return id;
  });
}

export function hasPendingModelCall(tx: Pick<Tx, 'db' | 'workspaceId'>, runId: string, subjectId: string): boolean {
  return Boolean(
    tx.db
      .prepare('SELECT 1 FROM model_call WHERE workspace_id = ? AND run_id = ? AND subject_id = ? AND pending = 1 LIMIT 1')
      .get(tx.workspaceId, runId, subjectId),
  );
}

// Finalizes a start marker with the real usage. A call that failed before any response has no usage,
// and was not billed, so its marker is removed.
export function settlePendingModelCallIn(
  tx: Tx,
  input: { pendingId: string; purpose: ModelCallPurpose; runId: string; report: ModelCallReport | null },
): number {
  if (!input.report) {
    tx.db.prepare('DELETE FROM model_call WHERE id = ? AND pending = 1').run(input.pendingId);
    return 0;
  }
  const estimatedUsd = estimateModelCostUsd(input.report.provider, input.report.model, input.report.usage);
  tx.db
    .prepare(
      `UPDATE model_call SET pending = 0, provider = ?, model = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?, estimated_usd = ?
       WHERE id = ?`,
    )
    .run(
      input.report.provider,
      input.report.model,
      input.report.usage.inputTokens,
      input.report.usage.outputTokens,
      input.report.usage.cacheReadTokens,
      input.report.usage.cacheCreationTokens,
      estimatedUsd,
      input.pendingId,
    );
  tx.audit('model.call', 'model_call', input.pendingId, auditDetail(input.purpose, input.runId, input.report, estimatedUsd));
  return estimatedUsd;
}

export function recordModelCall(
  ctx: ActionContext,
  input: { purpose: ModelCallPurpose; runId: string | null; report: ModelCallReport },
): number {
  return mutate(ctx, (tx) => recordModelCallIn(tx, input));
}
