import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { isSuperAdmin } from '@arcaai/applications';

/**
 * TASK-504 Phase 2 — canonical tenant-scope resolution for admin controllers.
 *
 * Before this, `tenant`, `harness-admin`, `pipeline-policy-admin`, and
 * `tenant-tts-config-admin` each carried a near-identical private
 * `resolveTenantId`/`resolveReadTenantId`/`assertTenantInScope`. Four copies
 * drift; a new admin surface would spawn a fifth. These pure helpers are the
 * one home — same style as `interceptors/resolve-active-tenant.ts` (explicit
 * inputs, trivially unit-testable). Controllers keep a thin one-line private
 * wrapper that feeds in `this.cls.get('user')` / `this.cls.get('tenantId')`, so
 * their call sites are unchanged.
 *
 * Posture (unchanged from the originals):
 *  - global-admin (`isSuperAdmin`) acts cross-tenant via `?tenantId=`, falling
 *    back to the working tenant elevated into CLS.
 *  - a tenant-bound caller is pinned to its own tenant; a FOREIGN `?tenantId=`
 *    is rejected (403, or 404 for the no-existence-leak config surfaces).
 */
type ScopeUser = { tenantId?: string | null; roles?: string[] | null } | null | undefined;

/**
 * Resolve the single tenant a scoped admin request acts on.
 * @param callerTenantId the CLS active tenant (may be the elevated working
 *   tenant for a global-admin); falls back to the user's JWT tenant.
 */
export function resolveScopedTenantId(user: ScopeUser, callerTenantId: string | undefined, queryTenantId?: string): string {
  if (isSuperAdmin(user)) {
    const target = queryTenantId ?? callerTenantId ?? user?.tenantId ?? undefined;
    if (!target) {
      throw new BadRequestException('Platform admins must pass ?tenantId= to scope this request.');
    }
    return target;
  }
  const tenantId = callerTenantId ?? user?.tenantId ?? undefined;
  if (!tenantId) {
    throw new BadRequestException('Tenant context is required.');
  }
  if (queryTenantId && queryTenantId !== tenantId) {
    throw new ForbiddenException('You do not have access to this tenant');
  }
  return tenantId;
}

/**
 * List-filter variant: a global-admin may OMIT the tenant (undefined = across
 * all tenants); a tenant-bound caller is pinned and a foreign query → 403.
 */
export function resolveScopedTenantIdOptional(user: ScopeUser, callerTenantId: string | undefined, queryTenantId?: string): string | undefined {
  if (isSuperAdmin(user)) return queryTenantId;
  const tenantId = callerTenantId ?? user?.tenantId ?? undefined;
  if (!tenantId) {
    throw new BadRequestException('Tenant context is required.');
  }
  if (queryTenantId && queryTenantId !== tenantId) {
    throw new ForbiddenException('You do not have access to this tenant');
  }
  return tenantId;
}

/**
 * Assert a caller may act on an ALREADY-KNOWN target tenant id (e.g. from a
 * `:id` path param or a lookup result). Global-admin always passes.
 * @param onForeign `'forbidden'` (403, default) or `'notfound'` (404) — use
 *   404 where surfacing existence would leak cross-tenant data.
 */
export function assertTenantInScope(user: ScopeUser, targetTenantId: string, onForeign: 'forbidden' | 'notfound' = 'forbidden'): void {
  if (isSuperAdmin(user)) return;
  const callerTenantId = user?.tenantId ?? undefined;
  if (!callerTenantId || callerTenantId !== targetTenantId) {
    throw onForeign === 'notfound' ? new NotFoundException('Resource not found') : new ForbiddenException('You do not have access to this tenant');
  }
}
