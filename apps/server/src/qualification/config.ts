import { z } from 'zod';
import type { Db } from '../db.js';
import { defaultTemplate, getTemplate } from '../templates.js';

export const criterionTargets = ['person', 'organization'] as const;
export const criterionFields = ['title', 'location', 'tags', 'email', 'name', 'kind', 'domain'] as const;
export const criterionOperators = ['contains', 'equals', 'in', 'exists'] as const;

export type CriterionTarget = (typeof criterionTargets)[number];
export type CriterionField = (typeof criterionFields)[number];
export type CriterionOperator = (typeof criterionOperators)[number];

// Which fields each target can read. Fields outside these lists would never match, so they are rejected.
export const fieldsByTarget: Record<CriterionTarget, readonly CriterionField[]> = {
  person: ['title', 'location', 'tags', 'email', 'name'],
  organization: ['kind', 'domain', 'location', 'tags', 'name'],
};

export interface Criterion {
  id: string;
  label: string;
  target: CriterionTarget;
  field: CriterionField;
  operator: CriterionOperator;
  values: string[];
  enabled: boolean;
}

export interface QualificationConfig {
  exclusions: Criterion[];
  criteria: Criterion[];
}

export const criterionSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, numbers, dashes, and underscores'),
    label: z.string().trim().min(1).max(200),
    target: z.enum(criterionTargets),
    field: z.enum(criterionFields),
    operator: z.enum(criterionOperators),
    values: z
      .array(z.string().trim().min(1).max(200))
      .max(50)
      .default([])
      .transform((values) => [...new Set(values)]),
    enabled: z.boolean(),
  })
  .superRefine((criterion, context) => {
    if (!fieldsByTarget[criterion.target].includes(criterion.field)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['field'],
        message: `A ${criterion.target} criterion can use ${fieldsByTarget[criterion.target].join(', ')}, not ${criterion.field}`,
      });
    }
    if (criterion.operator !== 'exists' && criterion.values.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['values'], message: 'Add at least one value' });
    }
  });

export const configSchema = z
  .object({
    exclusions: z.array(criterionSchema).max(50),
    criteria: z.array(criterionSchema).max(50),
  })
  .superRefine((config, context) => {
    const seen = new Set<string>();
    for (const list of ['exclusions', 'criteria'] as const) {
      config[list].forEach((criterion, index) => {
        if (seen.has(criterion.id)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: [list, index, 'id'], message: `The id "${criterion.id}" is used more than once` });
        }
        seen.add(criterion.id);
      });
    }
  });

export function readSettings(db: Db, workspaceId: string): Record<string, unknown> {
  const row = db.prepare('SELECT settings FROM workspace WHERE id = ?').get(workspaceId) as { settings: string | null } | undefined;
  if (!row || !row.settings) return {};
  try {
    const parsed = JSON.parse(row.settings) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface ReadConfig extends QualificationConfig {
  // True only when nothing has been saved and these are the template defaults.
  defaulted?: true;
}

// Returns the saved config, or the template defaults when none was saved or the saved value is unusable.
export function readQualificationConfig(db: Db, workspaceId: string): ReadConfig {
  const saved = readSettings(db, workspaceId).qualification;
  if (saved !== undefined) {
    const parsed = configSchema.safeParse(saved);
    if (parsed.success) return parsed.data;
  }
  return { ...currentTemplateDefaults(db, workspaceId), defaulted: true };
}

// The defaults of the workspace's current template. A template id this build does not know falls back to startup fundraising.
export function currentTemplateDefaults(db: Db, workspaceId: string): QualificationConfig {
  const row = db.prepare('SELECT template FROM workspace WHERE id = ?').get(workspaceId) as { template: string } | undefined;
  return (getTemplate(row?.template ?? defaultTemplate) ?? getTemplate(defaultTemplate)!).defaultQualificationConfig();
}

// The startup fundraising defaults. The template registry owns them; this stays for callers that import it from here.
export function defaultQualificationConfig(): QualificationConfig {
  return getTemplate(defaultTemplate)!.defaultQualificationConfig();
}
