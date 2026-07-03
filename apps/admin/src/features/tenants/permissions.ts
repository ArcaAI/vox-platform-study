/**
 * Client-side permission gate (TASK-379 §6 / PHASE-2 §4b.4). Mirrors the server's
 * CASL/RBAC so the UI can hide/disable what the API would reject — the server
 * stays the source of truth (defense in depth, never trust the client). The
 * console answers 404-over-403 for cross-tenant reads the user may not see.
 */

/** Platform-wide roles. `@CanManage('Tenant')` (create/disable tenants) is super-admin only. */
const SUPER_ADMIN_ROLES = ['SUPER_ADMIN', 'GLOBAL_ADMIN'];

/** A tenant-scoped admin manages only their own tenant's data. */
const TENANT_ADMIN_ROLES = ['TENANT_ADMIN'];

/** Minimal tenant shape the gates need (system flag / key / id); avoids an SDK value import. */
export interface TenantLike {
  id?: string | null;
  key?: string | null;
  isSystem?: boolean | null;
}

/**
 * The reserved system/global tenant, blocked from lifecycle transitions by the
 * server (DEF-ADM-002). The backend guard matches the `__GLOBAL__` key
 * (case-insensitive, mirroring DEF-ADM-001) OR the reserved zero-UUID id.
 */
const SYSTEM_TENANT_KEY = '__GLOBAL__';
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export function isSuperAdmin(roles?: string[] | null): boolean {
  return !!roles && roles.some((r) => SUPER_ADMIN_ROLES.includes(r));
}

export function isTenantAdmin(roles?: string[] | null): boolean {
  return !!roles && roles.some((r) => TENANT_ADMIN_ROLES.includes(r));
}

/** Provisioning a new tenant is gated by the server's `@CanManage('Tenant')` → super-admin only. */
export function canCreateTenant(roles?: string[] | null): boolean {
  return isSuperAdmin(roles);
}

/** The system/global tenant is protected (DEF-ADM-001): never editable/disablable from the console. */
export function isSystemTenant(tenant?: TenantLike | null): boolean {
  if (!tenant) return false;
  if (tenant.isSystem === true) return true;
  return String(tenant.key ?? '').toLowerCase() === 'system';
}

/** Edit/disable a tenant: super-admin AND not the protected system tenant. */
export function canModifyTenant(tenant: TenantLike | null | undefined, roles?: string[] | null): boolean {
  return isSuperAdmin(roles) && !isSystemTenant(tenant);
}

/**
 * The tenant the server blocks from `suspend`/`archive`/`restore`/delete
 * (DEF-ADM-002). Distinct from {@link isSystemTenant} — it matches the backend
 * guard exactly (reserved `__GLOBAL__` key, case-insensitive, or the zero-UUID
 * id, or an explicit `isSystem` flag) so the lifecycle affordances are hidden on
 * precisely the tenant the API would answer 403 for.
 */
export function isLifecycleProtectedTenant(tenant?: TenantLike | null): boolean {
  if (!tenant) return false;
  if (tenant.isSystem === true) return true;
  if (String(tenant.id ?? '') === SYSTEM_TENANT_ID) return true;
  const key = String(tenant.key ?? '').toLowerCase();
  return key === SYSTEM_TENANT_KEY.toLowerCase() || key === 'system';
}

/** Suspend/archive/restore a tenant: super-admin AND not the DEF-ADM-002 system tenant. */
export function canManageTenantLifecycle(tenant: TenantLike | null | undefined, roles?: string[] | null): boolean {
  return isSuperAdmin(roles) && !isLifecycleProtectedTenant(tenant);
}
