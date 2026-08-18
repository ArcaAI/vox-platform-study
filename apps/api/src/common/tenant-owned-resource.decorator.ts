/**
 * `@TenantOwnedResource` decorator.
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
  // Per-tenant/per-bucket storage config row — repo.findById(id),
  // tenant-scoped (the row carries `tenantId`).
  | 'TenantStorageConfig'
  | 'UserVoiceProfile'
  | 'ConsultationJob'
  // Clinical Workflow Playground (WS1): pre-stream tenant check for the
  // live-summary SSE route — repo.findById(id), tenant-scoped.
  | 'Consultation'
  | 'TranscriptionJob'
  // Opaque STT streaming session. The
  // interceptor resolves the sessionId → { tenantId, userId } mapping through
  // `StreamSessionTenantBindingService`, NOT a Prisma repository — the
  // session row lives in STT / Redis, not the API gateway DB.
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
   *   - `'session'`      → StreamSessionTenantBindingService.lookupBinding(paramValue)
   *                        (StreamSession only). Always asserts the owning
   *                        USER as well as the tenant — a live streaming
   *                        session is not a tenant-wide resource.
   */
  lookup?: 'id' | 'name' | 'session';
  scope?: 'tenant' | 'creator' | 'super-admin';
}

export const TenantOwnedResource = (opts: TenantOwnedResourceOptions): MethodDecorator => SetMetadata(TENANT_OWNED_RESOURCE_KEY, opts);
