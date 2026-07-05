/**
 * Cross-tenant fixture scaffold — TASK-305 Phase E.1.
 *
 * Pure synthetic fixtures (NO database, NO Prisma) used by cross-tenant
 * tests across the monorepo. Returns two tenants, two non-elevated
 * users (one per tenant), one GLOBAL_ADMIN, and a helper that shapes the
 * CLS payload exactly the way `apps/api/src/database/tenant-context.provider.ts`
 * reads it (`{ tenantId, user: { id, tenantId, roles, permissions } }`).
 *
 * UUIDs are deterministic so callers may hardcode expected values:
 *   - tenantA  = aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
 *   - tenantB  = bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
 *   - userA    = cccccccc-cccc-cccc-cccc-cccccccccccc
 *   - userB    = dddddddd-dddd-dddd-dddd-dddddddddddd
 *   - super    = eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee
 *
 * The fixture intentionally does NOT depend on `@arcaai/applications` so
 * callers in any package (including monorepo-root tests) can import it
 * without pulling in NestJS DI. The literal 'GLOBAL_ADMIN' string mirrors
 * `GLOBAL_ADMIN_ROLE` from `packages/applications/src/services/tenant/
 * constants.ts` (TASK-417 — SUPER_ADMIN was consolidated into it).
 */

export interface CrossTenant {
  id: string;
  name: string;
}

export interface CrossTenantUser {
  id: string;
  tenantId: string;
  roles: string[];
}

export interface CrossTenantClsPayload {
  tenantId: string;
  user: {
    id: string;
    tenantId: string;
    roles: string[];
    permissions: string[];
  };
}

export interface CrossTenantFixture {
  tenantA: CrossTenant;
  tenantB: CrossTenant;
  userA: CrossTenantUser;
  userB: CrossTenantUser;
  superAdmin: CrossTenantUser;
  clsContext(user: CrossTenantUser): CrossTenantClsPayload;
}

/**
 * Literal mirror of `GLOBAL_ADMIN_ROLE` from `packages/applications/src/
 * services/tenant/constants.ts`. Re-declared here (rather than imported)
 * so this fixture stays dependency-free for monorepo-root callers.
 */
const GLOBAL_ADMIN_ROLE = 'GLOBAL_ADMIN';

export const CROSS_TENANT_IDS = {
  TENANT_A: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  TENANT_B: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  USER_A: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  USER_B: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  GLOBAL_ADMIN: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
} as const;

export function createCrossTenantFixture(): CrossTenantFixture {
  const tenantA: CrossTenant = {
    id: CROSS_TENANT_IDS.TENANT_A,
    name: 'Cross-Tenant Fixture A',
  };
  const tenantB: CrossTenant = {
    id: CROSS_TENANT_IDS.TENANT_B,
    name: 'Cross-Tenant Fixture B',
  };
  const userA: CrossTenantUser = {
    id: CROSS_TENANT_IDS.USER_A,
    tenantId: tenantA.id,
    roles: ['DOCTOR'],
  };
  const userB: CrossTenantUser = {
    id: CROSS_TENANT_IDS.USER_B,
    tenantId: tenantB.id,
    roles: ['DOCTOR'],
  };
  const superAdmin: CrossTenantUser = {
    id: CROSS_TENANT_IDS.GLOBAL_ADMIN,
    tenantId: tenantA.id,
    roles: [GLOBAL_ADMIN_ROLE],
  };

  return {
    tenantA,
    tenantB,
    userA,
    userB,
    superAdmin,
    clsContext(user: CrossTenantUser): CrossTenantClsPayload {
      return {
        tenantId: user.tenantId,
        user: {
          id: user.id,
          tenantId: user.tenantId,
          roles: [...user.roles],
          permissions: [],
        },
      };
    },
  };
}
