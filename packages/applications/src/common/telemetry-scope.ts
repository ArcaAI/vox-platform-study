/**
 * Shared tenant-scope resolver for admin telemetry / metrics
 * reads.
 *
 * Mirrors the `?tenantId=` override precedent in
 * `dna-writing-style-admin.controller.ts:59` and the per-row guard in
 * `tenant.controller.ts:63`:
 *
 *   - **super-admin** may target a specific tenant via `?tenantId=`, or omit it
 *     for a platform-wide (all-tenants) roll-up → returns `requestedTenantId`
 *     when supplied, otherwise `null` (= no tenant filter / cross-tenant).
 *   - **tenant-admin** (non-super) is ALWAYS pinned to their CLS tenant; any
 *     supplied `requestedTenantId` is IGNORED. A missing CLS tenant is a 403.
 *
 * Pure + framework-light (only the Nest `ForbiddenException` type) so it is
 * unit-testable in isolation and reusable by every widened admin controller.
 */
import { ForbiddenException } from '@nestjs/common';
import { isSuperAdmin } from './tenant-guards';

export interface ResolveTenantScopeParams {
  /** The CLS-resolved request user (roles drive the super-admin bypass). */
  user: { roles?: string[] | null } | null | undefined;
  /** The CLS-resolved tenant id for the request (null for super-admins). */
  clsTenantId: string | null | undefined;
  /** The caller-supplied `?tenantId=` query value (honoured for super-admin only). */
  requestedTenantId?: string | null;
}

/**
 * Resolve the effective tenant id an admin metrics/telemetry read should be
 * scoped to.
 *
 * @returns the tenant id to filter by, or `null` for a super-admin platform-wide
 *   (all-tenants) read.
 * @throws ForbiddenException when a non-super caller has no CLS tenant context.
 */
export function resolveAdminTenantScope(params: ResolveTenantScopeParams): string | null {
  const { user, clsTenantId, requestedTenantId } = params;

  if (isSuperAdmin(user)) {
    // super-admin: honour an explicit target tenant, else roll up all tenants.
    return requestedTenantId && requestedTenantId.length > 0 ? requestedTenantId : null;
  }

  // tenant-admin: pinned to their own tenant; a supplied tenantId is ignored.
  if (!clsTenantId) {
    throw new ForbiddenException('Tenant context is required');
  }
  return clsTenantId;
}
