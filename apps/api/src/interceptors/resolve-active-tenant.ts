import { isSuperAdmin } from '@arcaai/applications';

/**
 * TASK-331 r2605 Finding #1 — pure decision helper for the super-admin
 * "manage as tenant" elevation.
 *
 * A super-admin authenticates with an EMPTY CLS `tenantId` (their JWT carries
 * `tenantId: ''`). When they pick a tenant in the admin console it is sent as
 * an `x-tenant-id` header. `ContextInterceptor` uses this helper to decide
 * whether that header may elevate the active tenant; the elevation itself
 * (the `clsService.set` + audit log) stays in the interceptor so this stays
 * pure and trivially testable.
 *
 * Decision table (only reached when an `x-tenant-id` header is present and the
 * caller has NOT been rejected by the TASK-307 W5.3 divergence guard):
 *  - super-admin + empty JWT tenant + valid-UUID header → `elevate`
 *  - super-admin + empty JWT tenant + malformed header  → `invalid`
 *  - tenant-bound caller (truthy JWT tenant)            → `none`
 *  - non-super-admin                                    → `none`
 *  - no header                                          → `none`
 */
export type ActiveTenantDecision = { type: 'elevate'; tenantId: string } | { type: 'invalid' } | { type: 'none' };

// Canonical RFC 4122 8-4-4-4-12 hex shape (any version, incl. the uuidv7 the
// platform mints for tenant ids). Mirrors the pattern already used in
// `streaming/dto/transcription-job.dto.ts`.
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function resolveActiveTenant(
  clsUser: { tenantId?: string | null; roles?: string[] | null } | null | undefined,
  headerTenant: string | undefined,
): ActiveTenantDecision {
  if (!headerTenant) return { type: 'none' };

  // A tenant-bound caller never elevates here. The interceptor already
  // handles the truthy-JWT cases (match = no-op, diverge = 400).
  if (clsUser?.tenantId) return { type: 'none' };

  if (!isSuperAdmin(clsUser)) return { type: 'none' };

  if (!UUID_PATTERN.test(headerTenant)) return { type: 'invalid' };

  return { type: 'elevate', tenantId: headerTenant };
}
