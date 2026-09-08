import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { isSuperAdmin, type SettingScope } from '@arcaai/applications';

/**
 * Which tenant a SETTINGS read resolves against, given the scope the caller
 * intends to write at.
 *
 * -- THE BUG THIS EXISTS TO FIX (TASK-932 R-6) --------------------------------
 * Both settings routes resolved their tenant through `resolveScopedTenantId`,
 * whose posture is right for a tenant-scoped admin resource and wrong here: for
 * a super admin it demands `?tenantId=` (or a working tenant) and throws
 * `400 "Platform admins must pass ?tenantId= to scope this request."` when there
 * is neither. But the PLATFORM row is not addressed by a tenant id at all -- it
 * lives on the reserved SYSTEM tenant by definition. So a platform admin with no
 * working tenant selected, opening a key at `scope=system` (the scope the
 * console asks for by default), got a 400 before any value was read: the drawer
 * could not load, so nothing could be saved, which is exactly the reported
 * "the platform admin cannot update any setting".
 *
 * Selecting a customer tenant made the drawer load -- and then the write landed
 * on the SYSTEM row anyway, because the write lane targets SYSTEM for
 * `scope=system` regardless of who is selected. The read and the write disagreed
 * about which row they were talking about.
 *
 * -- THE RULE -----------------------------------------------------------------
 * SCOPE decides, and it decides for reads exactly as it already does for writes:
 *
 *   elevated + `system`      -> the SYSTEM tenant. No `?tenantId`, no working
 *                               tenant, no 400. This is the platform row.
 *   elevated + `tenant`      -> `?tenantId` -> working tenant -> 400 (a tenant
 *                               row genuinely needs a tenant).
 *   elevated + no scope      -> `?tenantId` -> working tenant -> SYSTEM. The
 *                               legacy `GET effective` shape, which had no
 *                               `scope` param: today's answer is preserved for
 *                               every caller that had one, and the caller that
 *                               used to get a 400 now gets the platform value
 *                               instead of an error.
 *   NOT elevated             -> pinned to its own tenant; a foreign `?tenantId`
 *                               is a 403. Unchanged, and deliberately so: a
 *                               tenant admin asking for `scope=system` is asking
 *                               "what would I inherit", and the honest answer is
 *                               its own effective value, not the platform row it
 *                               may not address.
 *
 * `resolveScopedTenantId` in `shared/tenant-scope.ts` is left ALONE: a dozen
 * other admin surfaces depend on its posture, and none of them has a platform
 * row to address.
 */
type ScopeUser = { tenantId?: string | null; roles?: string[] | null } | null | undefined;

/** The reserved platform-configuration tier. Never a customer tenant. */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export function resolveSettingsReadTenantId(
  user: ScopeUser,
  callerTenantId: string | undefined,
  options: { scope?: SettingScope; queryTenantId?: string } = {},
): string {
  const { scope, queryTenantId } = options;

  if (isSuperAdmin(user)) {
    if (scope === 'system') return SYSTEM_TENANT_ID;
    const target = queryTenantId ?? callerTenantId ?? user?.tenantId ?? undefined;
    if (target) return target;
    if (scope === 'tenant') {
      throw new BadRequestException(
        'Reading a setting at `tenant` scope needs a tenant: select a working tenant or pass ?tenantId=. The platform row is `scope=system`.',
      );
    }
    // No scope asked for and no tenant in hand: the platform tier is the answer,
    // not an error. SYSTEM is the declared widening target, never a customer.
    return SYSTEM_TENANT_ID;
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
