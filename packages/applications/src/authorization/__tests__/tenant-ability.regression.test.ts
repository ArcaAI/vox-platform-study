/**
 * Seed-Policy Regression Test — TASK-259 (re-pointed to GLOBAL_ADMIN by TASK-417)
 *
 * Locks in the invariant flagged in TASK-258 Note (3): the seeded elevated
 * role (`GLOBAL_ADMIN` — the former `SUPER_ADMIN` was consolidated into it)
 * must resolve to a CASL ability that grants `manage:Tenant`, otherwise
 * `MyTenantController.create/update/delete` (guarded after TASK-258) would 403
 * its own global admins.
 *
 * Strategy — "Option B" from the TASK-259 plan: the test feeds the actual
 * seed data shapes (`DEFAULT_POLICIES` from `01-policy.ts`, role/policy linkage
 * from `03-role.ts`) through the production `PolicyEngine.buildAbility` path
 * with the Prisma client mocked. This exercises the engine's loader code, so a
 * future seed edit that breaks the linkage (e.g., renames `system-full-access`,
 * downgrades the `manage:all` rule, or detaches it from `GLOBAL_ADMIN`) will
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
import { DEFAULT_ROLES } from '../../../../database/src/prisma/db_main/seed/03-role';
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

describe('Tenant-ability regression — seeded GLOBAL_ADMIN policy linkage', () => {
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
    it('GLOBAL_ADMIN role exists in seed (SUPER_ADMIN is retired — TASK-417)', () => {
      const globalAdmin = DEFAULT_ROLES.find((r) => r.name === 'GLOBAL_ADMIN');
      expect(globalAdmin).toBeDefined();
      expect(globalAdmin?.id).toBe(SEED_ROLE_IDS.GLOBAL_ADMIN);
      expect(DEFAULT_ROLES.find((r) => r.name === 'SUPER_ADMIN')).toBeUndefined();
    });

    it('GLOBAL_ADMIN role references system-full-access policy', () => {
      const globalAdmin = DEFAULT_ROLES.find((r) => r.name === 'GLOBAL_ADMIN');
      expect(globalAdmin?.policies).toContain('system-full-access');
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

    // TASK-331 doc-04 F1 — the tenant-admin nav↔backend gap is closed by
    // widening `tenant-full-access` with tenant-scoped manage rules for
    // Departments and ASR pipelines. Lock the seed shape so a future edit
    // that drops either rule fails here before reaching production.
    it('tenant-full-access policy includes manage:Department and manage:AsrPipeline', () => {
      const policy = DEFAULT_POLICIES.find(
        (p) => p.name === 'tenant-full-access',
      );
      expect(policy).toBeDefined();
      expect(policy?.rules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'manage', subject: 'Department' }),
          expect.objectContaining({ action: 'manage', subject: 'AsrPipeline' }),
        ]),
      );
    });
  });

  describe('GLOBAL_ADMIN via PolicyEngine.buildAbility', () => {
    it('grants can(manage, Tenant) when a user holds the seeded GLOBAL_ADMIN role', async () => {
      const globalAdminRolePayload = buildPrismaRolePayload('GLOBAL_ADMIN');

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-global-admin',
          userId: SEED_USER_IDS.GLOBAL_ADMIN,
          roleId: SEED_ROLE_IDS.GLOBAL_ADMIN,
          tenantId: null,
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);
      mockPrismaClient.role.findMany.mockResolvedValue([globalAdminRolePayload]);

      const ability = await policyEngine.buildAbility({
        userId: SEED_USER_IDS.GLOBAL_ADMIN,
      });

      expect(ability.can('manage', 'Tenant')).toBe(true);
    });

    it('grants can(manage, Tenant) regardless of tenant context (global wildcard)', async () => {
      const globalAdminRolePayload = buildPrismaRolePayload('GLOBAL_ADMIN');

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-global-admin',
          userId: SEED_USER_IDS.GLOBAL_ADMIN,
          roleId: SEED_ROLE_IDS.GLOBAL_ADMIN,
          tenantId: null,
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);
      mockPrismaClient.role.findMany.mockResolvedValue([globalAdminRolePayload]);

      const ability = await policyEngine.buildAbility({
        userId: SEED_USER_IDS.GLOBAL_ADMIN,
        tenantId: '50000000-0000-0000-0000-000000000000',
      });

      expect(ability.can('manage', 'Tenant')).toBe(true);
      expect(ability.can('create', 'Tenant')).toBe(true);
      expect(ability.can('delete', 'Tenant')).toBe(true);
      expect(ability.can('update', 'Tenant')).toBe(true);
    });

    it('cross-check: GLOBAL_ADMIN also has manage on unrelated subjects (manage:all)', async () => {
      // Guards against a seed edit that narrows the rule from `manage:all` to a
      // single subject like `Tenant` — that would silently re-introduce gaps
      // elsewhere even though `manage:Tenant` keeps passing.
      const globalAdminRolePayload = buildPrismaRolePayload('GLOBAL_ADMIN');

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-global-admin',
          userId: SEED_USER_IDS.GLOBAL_ADMIN,
          roleId: SEED_ROLE_IDS.GLOBAL_ADMIN,
          tenantId: null,
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);
      mockPrismaClient.role.findMany.mockResolvedValue([globalAdminRolePayload]);

      const ability = await policyEngine.buildAbility({
        userId: SEED_USER_IDS.GLOBAL_ADMIN,
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

  describe('TENANT_ADMIN via PolicyEngine.buildAbility', () => {
    // TASK-331 doc-04 F1 + Q2 — a seeded TENANT_ADMIN must be able to
    // self-serve their own departments, ASR pipelines, storage, and their
    // own tenant row (read/update), so the admin nav stops linking to
    // backend-403 pages. The same posture must NOT leak tenant create/delete
    // (privilege escalation) — those stay GLOBAL_ADMIN-only via the
    // method-level `@CanManage('Tenant')` on TenantController.
    it('grants tenant-scoped self-service but forbids tenant create/delete', async () => {
      const tenantAdminRolePayload = buildPrismaRolePayload('TENANT_ADMIN');

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-tenant-admin',
          userId: SEED_USER_IDS.TENANT_ADMIN,
          roleId: SEED_ROLE_IDS.TENANT_ADMIN,
          tenantId: '50000000-0000-0000-0000-000000000000',
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);
      mockPrismaClient.role.findMany.mockResolvedValue([tenantAdminRolePayload]);

      const ability = await policyEngine.buildAbility({
        userId: SEED_USER_IDS.TENANT_ADMIN,
        tenantId: '50000000-0000-0000-0000-000000000000',
      });

      // Widened self-service surfaces (doc-04 F1 nav↔backend gap closed).
      expect(ability.can('manage', 'Department')).toBe(true);
      expect(ability.can('manage', 'AsrPipeline')).toBe(true);
      expect(ability.can('manage', 'Storage')).toBe(true);
      // Own-tenant read/update reaches the relaxed Tenant controllers.
      expect(ability.can('update', 'Tenant')).toBe(true);
      expect(ability.can('read', 'Tenant')).toBe(true);
      // No privilege escalation — cannot manage/create/delete tenants.
      expect(ability.can('manage', 'Tenant')).toBe(false);
      expect(ability.can('create', 'Tenant')).toBe(false);
      expect(ability.can('delete', 'Tenant')).toBe(false);
    });
  });
});
