/**
 * Seed-Policy Regression Test — TASK-259
 *
 * Locks in the invariant flagged in TASK-258 Note (3): the seeded `SUPER_ADMIN`
 * role must resolve to a CASL ability that grants `manage:Tenant`, otherwise
 * `MyTenantController.create/update/delete` (guarded after TASK-258) would 403
 * its own super-admins.
 *
 * Strategy — "Option B" from the TASK-259 plan: the test feeds the actual
 * seed data shapes (`DEFAULT_POLICIES` from `01-policy.ts`, role/policy linkage
 * from `03-role.ts`) through the production `PolicyEngine.buildAbility` path
 * with the Prisma client mocked. This exercises the engine's loader code, so a
 * future seed edit that breaks the linkage (e.g., renames `system-full-access`,
 * downgrades the `manage:all` rule, or detaches it from `SUPER_ADMIN`) will
 * make this test fail before reaching production.
 *
 * Negative control: a `DOCTOR` role (without the `system-full-access` policy)
 * must NOT resolve to `manage:Tenant`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { PolicyEngine } from '../policy.engine';
// Direct relative imports of the seed source so a regression in either file
// fails this test deterministically (no compiled-artifact indirection).
import { DEFAULT_POLICIES } from '../../../../database/src/prisma/db_main/seed/01-policy';
import {
  SYSTEM_ROLES,
  DEFAULT_ROLES,
} from '../../../../database/src/prisma/db_main/seed/03-role';
import {
  SEED_ROLE_IDS,
  SEED_USER_IDS,
} from '../../../../database/src/prisma/db_main/seed/00-constants';

type SeedPolicy = (typeof DEFAULT_POLICIES)[number];

const mockPrismaClient = {
  userRoleAssignment: {
    findMany: vi.fn(),
  },
  role: {
    findMany: vi.fn(),
  },
  rolePolicy: {
    findMany: vi.fn(),
  },
};

// TASK-305 B.1 — `PolicyEngine.loadUserPolicies` reads the UNSCOPED platform-admin
// client (`baseClient`) for the cross-tenant RBAC control-plane query. Mock both
// `client` and `baseClient` (same fake client) so the loader resolves.
const mockDatabaseService = {
  client: mockPrismaClient,
  baseClient: mockPrismaClient,
};

const mockCacheService = {
  isConnected: vi.fn().mockReturnValue(false),
  get: vi.fn(),
  setex: vi.fn(),
  keys: vi.fn(),
  delMany: vi.fn(),
};

/**
 * Resolves a role definition from the seed by name and returns the Prisma-shape
 * payload that PolicyEngine.loadUserPolicies expects (role with RolePolicies +
 * embedded Policy.rules). Mirrors `role.findMany` output exactly so the
 * engine's loader code path is exercised, not faked.
 */
function buildPrismaRolePayload(roleName: string) {
  const role = DEFAULT_ROLES.find((r) => r.name === roleName);
  if (!role) {
    throw new Error(`Seed role '${roleName}' not found — seed regression`);
  }
  const policiesByName = new Map<string, SeedPolicy>(
    DEFAULT_POLICIES.map((p) => [p.name, p]),
  );
  const rolePolicies = role.policies
    .map((policyName, idx) => {
      const policy = policiesByName.get(policyName);
      if (!policy) {
        throw new Error(
          `Seed policy '${policyName}' referenced by role '${roleName}' not found — seed regression`,
        );
      }
      return {
        id: `rp-${role.id}-${idx}`,
        roleId: role.id,
        policyId: policy.id,
        priority: idx,
        resourceStatus: 'ENABLED',
        Policy: {
          id: policy.id,
          name: policy.name,
          resourceStatus: 'ENABLED',
          rules: policy.rules,
        },
      };
    });
  return {
    id: role.id,
    name: role.name,
    resourceStatus: 'ENABLED',
    RolePolicies: rolePolicies,
    ParentRole: null,
  };
}

describe('Tenant-ability regression — seeded SUPER_ADMIN policy linkage', () => {
  let policyEngine: PolicyEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheService.isConnected.mockReturnValue(false);
    mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([]);
    mockPrismaClient.role.findMany.mockResolvedValue([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    policyEngine = new PolicyEngine(
      mockDatabaseService as any,
      mockCacheService as any,
    );
  });

  describe('seed-data sanity', () => {
    it('SUPER_ADMIN role exists in seed', () => {
      const superAdmin = SYSTEM_ROLES.find((r) => r.name === 'SUPER_ADMIN');
      expect(superAdmin).toBeDefined();
      expect(superAdmin?.id).toBe(SEED_ROLE_IDS.SUPER_ADMIN);
    });

    it('SUPER_ADMIN role references system-full-access policy', () => {
      const superAdmin = SYSTEM_ROLES.find((r) => r.name === 'SUPER_ADMIN');
      expect(superAdmin?.policies).toContain('system-full-access');
    });

    it('system-full-access policy contains the manage:all wildcard rule', () => {
      const policy = DEFAULT_POLICIES.find(
        (p) => p.name === 'system-full-access',
      );
      expect(policy).toBeDefined();
      expect(policy?.rules).toEqual(
        expect.arrayContaining([{ action: 'manage', subject: 'all' }]),
      );
    });
  });

  describe('SUPER_ADMIN via PolicyEngine.buildAbility', () => {
    it('grants can(manage, Tenant) when a user holds the seeded SUPER_ADMIN role', async () => {
      const superAdminRolePayload = buildPrismaRolePayload('SUPER_ADMIN');

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-super-admin',
          userId: SEED_USER_IDS.SUPER_ADMIN,
          roleId: SEED_ROLE_IDS.SUPER_ADMIN,
          tenantId: null,
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);
      mockPrismaClient.role.findMany.mockResolvedValue([superAdminRolePayload]);

      const ability = await policyEngine.buildAbility({
        userId: SEED_USER_IDS.SUPER_ADMIN,
      });

      expect(ability.can('manage', 'Tenant')).toBe(true);
    });

    it('grants can(manage, Tenant) regardless of tenant context (global wildcard)', async () => {
      const superAdminRolePayload = buildPrismaRolePayload('SUPER_ADMIN');

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-super-admin',
          userId: SEED_USER_IDS.SUPER_ADMIN,
          roleId: SEED_ROLE_IDS.SUPER_ADMIN,
          tenantId: null,
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);
      mockPrismaClient.role.findMany.mockResolvedValue([superAdminRolePayload]);

      const ability = await policyEngine.buildAbility({
        userId: SEED_USER_IDS.SUPER_ADMIN,
        tenantId: '50000000-0000-0000-0000-000000000000',
      });

      expect(ability.can('manage', 'Tenant')).toBe(true);
      expect(ability.can('create', 'Tenant')).toBe(true);
      expect(ability.can('delete', 'Tenant')).toBe(true);
      expect(ability.can('update', 'Tenant')).toBe(true);
    });

    it('cross-check: SUPER_ADMIN also has manage on unrelated subjects (manage:all)', async () => {
      // Guards against a seed edit that narrows the rule from `manage:all` to a
      // single subject like `Tenant` — that would silently re-introduce gaps
      // elsewhere even though `manage:Tenant` keeps passing.
      const superAdminRolePayload = buildPrismaRolePayload('SUPER_ADMIN');

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-super-admin',
          userId: SEED_USER_IDS.SUPER_ADMIN,
          roleId: SEED_ROLE_IDS.SUPER_ADMIN,
          tenantId: null,
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);
      mockPrismaClient.role.findMany.mockResolvedValue([superAdminRolePayload]);

      const ability = await policyEngine.buildAbility({
        userId: SEED_USER_IDS.SUPER_ADMIN,
      });

      expect(ability.can('manage', 'AuditLog')).toBe(true);
      expect(ability.can('manage', 'Policy')).toBe(true);
      expect(ability.can('manage', 'Role')).toBe(true);
    });
  });

  describe('negative control — DOCTOR role', () => {
    it('does NOT grant can(manage, Tenant) without the system-full-access policy', async () => {
      const doctorRolePayload = buildPrismaRolePayload('DOCTOR');

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-doctor',
          userId: SEED_USER_IDS.DOCTOR,
          roleId: SEED_ROLE_IDS.DOCTOR,
          tenantId: '50000000-0000-0000-0000-000000000000',
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);
      mockPrismaClient.role.findMany.mockResolvedValue([doctorRolePayload]);

      const ability = await policyEngine.buildAbility({
        userId: SEED_USER_IDS.DOCTOR,
        tenantId: '50000000-0000-0000-0000-000000000000',
      });

      expect(ability.can('manage', 'Tenant')).toBe(false);
      expect(ability.can('create', 'Tenant')).toBe(false);
      expect(ability.can('delete', 'Tenant')).toBe(false);
    });
  });
});
