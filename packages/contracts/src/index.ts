/**
 * @autoedit/contracts
 *
 * Core domain contracts, strict Zod schemas, and TypeScript interfaces
 * for the AutoAI Edit unified platform.
 */

export * from './common.js';
export * from './media.js';
export * from './live.js';
export * from './platforms.js';
export * from './highlight.js';
export * from './editing.js';
export * from './processing.js';
export * from './usage.js';

import { z } from 'zod';

/**
 * Universal Validation Helper
 */
export function validateContract<T>(schema: z.ZodType<T>, data: unknown): T {
  return schema.parse(data);
}

export function safeValidateContract<T>(
  schema: z.ZodType<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: z.ZodError<T> } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
