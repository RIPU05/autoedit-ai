import { z } from 'zod';

export const CURRENT_CONTRACT_VERSION = '1.0.0';

/**
 * Common Identifier & Tenancy Primitives
 */
export const TenantIdSchema = z
  .string()
  .min(1, 'Tenant ID cannot be empty')
  .max(128, 'Tenant ID exceeds maximum length');

export type TenantId = z.infer<typeof TenantIdSchema>;

export const ResourceIdSchema = z
  .string()
  .min(1, 'Resource ID cannot be empty')
  .max(128, 'Resource ID exceeds maximum length');

export type ResourceId = z.infer<typeof ResourceIdSchema>;

export const TenantReferenceSchema = z.object({
  tenantId: TenantIdSchema,
  organizationId: z.string().max(128).optional(),
  role: z.enum(['USER', 'ADMIN']).default('USER'),
});

export type TenantReference = z.infer<typeof TenantReferenceSchema>;

export const ResourceOwnershipSchema = z.object({
  resourceId: ResourceIdSchema,
  resourceType: z.enum(['project', 'asset', 'session', 'render', 'source', 'segment']),
  tenantId: TenantIdSchema,
  createdAt: z.string().datetime().optional(),
});

export type ResourceOwnership = z.infer<typeof ResourceOwnershipSchema>;

/**
 * Precise Millisecond Time Primitives
 */
export const MillisecondTimestampSchema = z
  .number()
  .int('Timestamp must be integer milliseconds')
  .nonnegative('Timestamp cannot be negative');

export type MillisecondTimestamp = z.infer<typeof MillisecondTimestampSchema>;

export const MediaTimeRangeSchema = z
  .object({
    startMs: MillisecondTimestampSchema,
    endMs: MillisecondTimestampSchema,
    durationMs: MillisecondTimestampSchema,
  })
  .refine((data) => data.endMs >= data.startMs, {
    message: 'endMs must be greater than or equal to startMs',
    path: ['endMs'],
  })
  .refine((data) => data.durationMs === data.endMs - data.startMs, {
    message: 'durationMs must equal (endMs - startMs)',
    path: ['durationMs'],
  });

export type MediaTimeRange = z.infer<typeof MediaTimeRangeSchema>;

export function createMediaTimeRange(startMs: number, endMs: number): MediaTimeRange {
  if (endMs < startMs) {
    throw new Error(`Invalid range: endMs (${endMs}) cannot be less than startMs (${startMs})`);
  }
  return {
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
    durationMs: Math.round(endMs - startMs),
  };
}

/**
 * Standard API Error Response Structure
 */
export const ApiErrorResponseSchema = z.object({
  error: z.string().min(1),
  code: z.string().optional(),
  details: z.unknown().optional(),
});

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

/**
 * Schema Versioning Primitives
 */
export const SchemaVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'Version must be SemVer format (e.g. 1.0.0)');

export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;

export const VersionedEnvelopeSchema = <T extends z.ZodTypeAny>(payloadSchema: T) =>
  z.object({
    schemaVersion: SchemaVersionSchema,
    payloadType: z.string().min(1),
    timestamp: z.string().datetime(),
    tenantId: TenantIdSchema,
    data: payloadSchema,
  });
