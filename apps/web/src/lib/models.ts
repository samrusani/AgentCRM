// List prices per million tokens, mirrored from docs/architecture.md (Model adapter).
// Used only for estimates in the UI. The server computes the costs it reports.

export interface ModelOption {
  id: string;
  name: string;
  inputPerMillion: number;
  outputPerMillion: number;
  note?: string;
}

export const MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', inputPerMillion: 4, outputPerMillion: 20 },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', inputPerMillion: 2, outputPerMillion: 10 },
  {
    id: 'claude-haiku-5-5',
    name: 'Haiku 5.5',
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
    note: 'up to 100K prompts',
  },
];

export const DEFAULT_MODEL_ID = 'claude-opus-5-5';

export function findModel(id: string | null | undefined): ModelOption | null {
  return MODELS.find((model) => model.id === id) ?? null;
}

export function modelName(id: string | null | undefined): string {
  return findModel(id)?.name ?? id ?? 'Unknown model';
}

function price(value: number): string {
  return value.toFixed(2);
}

export function modelHint(model: ModelOption): string {
  const base = `${model.name}, ${price(model.inputPerMillion)} in / ${price(model.outputPerMillion)} out per million tokens`;
  return model.note ? `${base} (${model.note})` : base;
}

// Rough per draft token guess used by the preflight estimate in the draft outreach sheet.
export const DRAFT_INPUT_TOKENS = 1500;
export const DRAFT_OUTPUT_TOKENS = 400;
// The guess is wide on purpose: reasoning tokens bill as output and prompts vary with the record.
const RANGE_LOW = 0.5;
const RANGE_HIGH = 2;

export interface CostRange {
  low: number;
  high: number;
}

export function estimateDraftCost(people: number, modelId: string | null | undefined): CostRange {
  const model = findModel(modelId) ?? MODELS[0];
  const perDraft =
    (DRAFT_INPUT_TOKENS * model.inputPerMillion + DRAFT_OUTPUT_TOKENS * model.outputPerMillion) / 1_000_000;
  const point = perDraft * people;
  return { low: point * RANGE_LOW, high: point * RANGE_HIGH };
}

// Small amounts keep three decimals ("$0.005") so a cheap chat reply never rounds to zero.
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.001) return 'under $0.001';
  if (value < 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}
