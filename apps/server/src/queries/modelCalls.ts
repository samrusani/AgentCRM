import type { Db } from '../db.js';

export interface ModelUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedUsd: number;
}

// Totals for the provider calls a run made. Costs are estimates from list prices, not bills.
// Start markers that were never finalized are not counted as calls. Their cost is unknown.
export function getRunModelUsage(db: Db, workspaceId: string, runId: string): ModelUsageTotals {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN pending = 0 THEN 1 ELSE 0 END), 0) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens, COALESCE(SUM(estimated_usd), 0) AS estimated_usd
       FROM model_call WHERE workspace_id = ? AND run_id = ?`,
    )
    .get(workspaceId, runId) as {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    estimated_usd: number;
  };
  return {
    calls: Number(row.calls),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheCreationTokens: Number(row.cache_creation_tokens),
    estimatedUsd: Math.round(Number(row.estimated_usd) * 1_000_000) / 1_000_000,
  };
}

export function sumRunEstimatedUsd(db: Db, workspaceId: string, runId: string): number {
  return getRunModelUsage(db, workspaceId, runId).estimatedUsd;
}
