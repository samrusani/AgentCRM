import { z } from 'zod';
import { csvFields, mapCsvRow, previewCsv, validateMapping, type CsvPreview } from '../csv/mapping.js';
import { assertUtf8Text, parseCsv } from '../csv/parse.js';
import { validationError } from '../errors.js';
import { type ImportCounts, emptyImportCounts, getImportBatchForRun } from '../queries/imports.js';
import { getRun, getRunDetail, listRunSteps } from '../queries/runs.js';
import { type ActionContext, mutate, parseInput, type Tx, withTxActor } from './context.js';
import { type AdvanceResult, setCounts, startStep } from './demoResearch.js';
import {
  completeStep,
  dedupeImportBatch,
  failImportRunIn,
  importCountsOf,
  liveStep,
  markInvalidRows,
  requestImportReview,
  writeBatchCounts,
} from './importReview.js';
import { enqueueJobIn } from './jobs.js';

export const csvImportKind = 'csv_import';
export const csvImportJobKind = 'csv_import_step';
export const csvImportActor = 'system:csv_import';

export const csvImportStepTitles = [
  'Parse and stage rows',
  'Validate rows',
  'Check for duplicates',
  'Request import review',
] as const;

const delimiterNames: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab' };

export function scheduleCsvImportRun(tx: Tx, runId: string, runAt: string): void {
  enqueueJobIn(tx, csvImportJobKind, { runId, workspaceId: tx.workspaceId }, runAt);
}

// A file name is a label. Any folder part the client sent is dropped.
function cleanFileName(value: string): string {
  const last = value.split(/[\\/]/).pop() ?? '';
  return last.trim().slice(0, 150);
}

const fileSchema = z
  .object({
    fileName: z.string().trim().min(1).max(300),
    content: z.string(),
  })
  .strict();

const stageSchema = fileSchema.extend({ mapping: z.unknown() }).strict();

export function previewCsvFile(input: unknown): CsvPreview & { fileName: string } {
  const data = parseInput(fileSchema, input);
  const fileName = cleanFileName(data.fileName);
  if (fileName === '') throw validationError('fileName: Give the name of the file.');
  assertUtf8Text(data.content);
  return { fileName, ...previewCsv(data.content) };
}

// Stages the batch and every row in one transaction, then queues the run. The worker validates, dedupes,
// and asks for review. Nothing becomes a person or organization until a person approves the import.
export function stageCsvImport(ctx: ActionContext, input: unknown) {
  const data = parseInput(stageSchema, input);
  const fileName = cleanFileName(data.fileName);
  if (fileName === '') throw validationError('fileName: Give the name of the file.');
  assertUtf8Text(data.content);
  const parsed = parseCsv(data.content);
  if (parsed.rows.length === 0) throw validationError('The file has a header row but no data rows.');
  const mapping = validateMapping(parsed.headers, data.mapping);
  const rowCount = parsed.rows.length;

  const runId = mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, ctx.actor);
    const id = tx.newId('run');
    const batchId = tx.newId('imp');
    const now = tx.now();
    const counts: ImportCounts = { ...emptyImportCounts, fetched: rowCount, staged: rowCount };
    tx.db
      .prepare(
        `INSERT INTO run (id, created_at, workspace_id, kind, title, status, scope, counts)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        id,
        now,
        tx.workspaceId,
        csvImportKind,
        `CSV import: ${fileName}`,
        JSON.stringify({ batchId, fileName }),
        JSON.stringify(importCountsOf(counts, rowCount)),
      );
    const delimiterName = delimiterNames[parsed.delimiter] ?? parsed.delimiter;
    csvImportStepTitles.forEach((title, index) => {
      // The file is already parsed and staged when the run is created, so the first step starts done.
      const done = index === 0;
      tx.db
        .prepare(
          'INSERT INTO run_step (id, created_at, run_id, seq, title, status, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          tx.newId('stp'),
          now,
          id,
          index + 1,
          title,
          done ? 'done' : 'pending',
          done ? `Staged ${rowCount} ${rowCount === 1 ? 'row' : 'rows'} from ${fileName} (${delimiterName} separated).` : null,
          done ? now : null,
          done ? now : null,
        );
    });
    tx.db
      .prepare(
        `INSERT INTO import_batch (id, created_at, workspace_id, run_id, source_kind, source_ref, status, counts, updated_at)
         VALUES (?, ?, ?, ?, 'csv', ?, 'staging', ?, ?)`,
      )
      .run(batchId, now, tx.workspaceId, id, JSON.stringify({ fileName, rowCount, delimiter: parsed.delimiter }), JSON.stringify(counts), now);
    const insert = tx.db.prepare(
      "INSERT INTO import_row (id, created_at, batch_id, seq, raw, mapped, status) VALUES (?, ?, ?, ?, ?, ?, 'staged')",
    );
    parsed.rows.forEach((row, index) => {
      insert.run(tx.newId('row'), now, batchId, index + 1, JSON.stringify(row), JSON.stringify(mapCsvRow(row, mapping)));
    });
    scheduleCsvImportRun(tx, id, now);
    tx.audit('run.create', 'run', id, { kind: csvImportKind, fileName, rowCount });
    tx.audit('import.create', 'import_batch', batchId, {
      runId: id,
      fileName,
      rowCount,
      delimiter: parsed.delimiter,
      mapping: Object.fromEntries(Object.entries(mapping).filter(([, field]) => field !== 'ignore')),
    });
    tx.emit({ type: 'run_updated', runId: id });
    return id;
  });
  return getRunDetail(ctx.db, ctx.workspaceId, runId);
}

export { csvFields };

function failNow(tx: Tx, runId: string, detail: string): AdvanceResult {
  failImportRunIn(tx, runId, detail);
  return { nextRunAt: null };
}

// Moves one step forward in a single transaction. The steps hold no network calls, so a crash leaves the run consistent.
export function advanceCsvImportRun(ctx: ActionContext, runId: string): AdvanceResult {
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, csvImportActor);
    const run = getRun(tx.db, tx.workspaceId, runId);
    if (!run || run.kind !== csvImportKind) return { nextRunAt: null };
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
    if (!batch) return failNow(tx, runId, 'The import batch is missing.');
    const requested = run.counts.requested ?? batch.counts.fetched;

    if (active.seq === 2) {
      const live = liveStep(tx, runId, 2);
      if (!live) return { nextRunAt: null };
      const { total, invalid } = markInvalidRows(tx, batch.id, 'No name or email found in this row.');
      const counts: ImportCounts = { ...batch.counts, invalid, staged: total - invalid };
      writeBatchCounts(tx, batch.id, counts);
      setCounts(tx, runId, importCountsOf(counts, requested));
      completeStep(tx, runId, live.step, `Checked ${total} rows. ${invalid} had no name or email and were marked invalid.`);
      return { nextRunAt: soon };
    }
    if (active.seq === 3) {
      const live = liveStep(tx, runId, 3);
      if (!live) return { nextRunAt: null };
      const duplicates = dedupeImportBatch(tx, batch.id);
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

    const fileName = String(run.scope.fileName ?? batch.sourceRef.fileName ?? 'the file');
    requestImportReview(
      tx,
      runId,
      active.seq,
      {
        emptyDetail: (counts) => `All ${counts.fetched} rows were duplicates or invalid, so there is nothing to review.`,
        title: (staged) => `Review ${staged} imported ${staged === 1 ? 'row' : 'rows'} from ${fileName}`,
        payloadSource: { fileName },
      },
      (detail) => failImportRunIn(tx, runId, detail),
    );
    return { nextRunAt: null };
  });
}
