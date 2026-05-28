/**
 * `@TenantOwnedResource` — TASK-307 W3.1 / AC-7.
 *
 * Marks a controller handler that takes a tenant-owned resource id (or name)
 * as a route param. The companion `TenantOwnedResourceInterceptor` reads the
 * metadata, resolves the resource via the matching repository / service, and
 * `404`s the request (no existence leak) when the resource's tenant does not
 * match the caller's CLS tenant.
 *
 * Mirrors the DEF-C3 "no existence leak" posture from TASK-306 W5.2 — the
 * decorator is uniformly 404-on-mismatch with no `@PlatformAdmin()` bypass.
 *
 * Usage:
 *   @Get(':id')
 *   @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'id' })
 *   getBucket(@Param('id') id: string) { … }
 *
 *   // Name-lookup mode for `StorageController` (resolves `TenantBucket` by name)
 *   @Get('buckets/:name')
 *   @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'name', lookup: 'name' })
 *   getBucketByName(@Param('name') name: string) { … }
 */
import { SetMetadata } from '@nestjs/common';

export const TENANT_OWNED_RESOURCE_KEY = 'tenant_owned_resource';

/**
 * Resources that the W3 interceptor knows how to resolve. Each entry maps to
 * a repository (or, for `ConsultationJob`, an in-memory/Redis-backed service)
 * in `TenantOwnedResourceInterceptor`.
 *
 * Add new entries here AND to the interceptor's lookup table together — the
 * union here is the single source of truth that prevents drift.
 */
export type TenantOwnedResourceModelName =
  | 'TenantBucket'
  | 'UserVoiceProfile'
  | 'ConsultationJob'
  | 'TranscriptionJob'
  // TASK-310 W7.A.9 (AC-3): opaque STT-V2 streaming session. The
  // interceptor resolves the sessionId → tenantId mapping through
  // `StreamSessionTenantBindingService`, NOT a Prisma repository — the
  // session row lives in STT-V2 / Redis, not the API gateway DB.
  | 'StreamSession';

export interface TenantOwnedResourceOptions {
  /** Domain model name the interceptor uses to pick a repository / service. */
  modelName: TenantOwnedResourceModelName;
  /** Route param key (e.g. `'id'`, `'jobId'`, `'name'`, `'sessionId'`). */
  paramName: string;
  /**
   * Lookup strategy:
   *   - `'id'` (default) → repository.findById(paramValue)
   *   - `'name'`         → repository.findByName(paramValue)  (TenantBucket only)
   *   - `'session'`      → StreamSessionTenantBindingService.lookup(paramValue)
   *                        (StreamSession only — TASK-310 W7.A.9 / AC-3)
   */
  lookup?: 'id' | 'name' | 'session';
}

export const TenantOwnedResource = (opts: TenantOwnedResourceOptions): MethodDecorator =>
  SetMetadata(TENANT_OWNED_RESOURCE_KEY, opts);
