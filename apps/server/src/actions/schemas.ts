import { z } from 'zod';

export const idSchema = z.string().trim().min(1).max(64);

export const entityTypeSchema = z.enum(['person', 'organization', 'opportunity']);

export const isoTimestamp = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'Use an ISO 8601 date or timestamp')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Use an ISO 8601 date or timestamp')
  .transform((value) => new Date(value).toISOString());

export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === '' ? null : value));

export const tagsSchema = z
  .array(z.string().trim().min(1).max(60))
  .max(30)
  .transform((tags) => [...new Set(tags)]);

export const expectedVersionSchema = z.number().int().min(1);
