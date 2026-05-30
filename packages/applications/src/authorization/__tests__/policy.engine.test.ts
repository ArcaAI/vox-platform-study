/**
 * PolicyEngine Unit Tests
 *
 * Tests for the core authorization engine that builds CASL abilities from database policies.
 * Updated for the new schema structure with direct roleId on UserRoleAssignment.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PolicyEngine, PolicyRule, PolicyContext, AppAbility } from '../policy.engine';

// Mock dependencies
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

// `loadUserPolicies` reads the RBAC control-plane via the UNSCOPED
// `baseClient` (bypasses tenant-scope so the SYSTEM + request-tenant
// `in` filter survives); cache-invalidation helpers still use `.client`.
// Pointing both at the same spy keeps every behavioural assertion valid
// regardless of which getter a given method reaches for.
const mockDatabaseService = {
  client: mockPrismaClient,
  baseClient: mockPrismaClient,
};

const mockCacheService = {
  isConnected: vi.fn(),
  get: vi.fn(),
  setex: vi.fn(),
  keys: vi.fn(),
  delMany: vi.fn(),
};

// Helper to create mock role with policies
const createMockRole = (
  id: string,
  name: string,
  rules: PolicyRule[],
  parentRole?: { id: string; name: string; rules: PolicyRule[] }
) => ({
  id,
  name,
  resourceStatus: 'ENABLED',
  RolePolicies: [
    {
      id: `rp-${id}`,
      roleId: id,
      policyId: `policy-${id}`,
      priority: 0,
      resourceStatus: 'ENABLED',
      Policy: {
        id: `policy-${id}`,
        name: `policy-${name}`,
        resourceStatus: 'ENABLED',
        rules,
      },
    },
  ],
  ParentRole: parentRole
    ? {
        id: parentRole.id,
        name: parentRole.name,
        resourceStatus: 'ENABLED',
        RolePolicies: [
          {
            id: `rp-${parentRole.id}`,
            Policy: {
              id: `policy-${parentRole.id}`,
              resourceStatus: 'ENABLED',
              rules: parentRole.rules,
            },
          },
        ],
      }
    : null,
});

describe('PolicyEngine', () => {
  let policyEngine: PolicyEngine;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: cache not connected
    mockCacheService.isConnected.mockReturnValue(false);

    // Default: no role assignments
    mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([]);
    mockPrismaClient.role.findMany.mockResolvedValue([]);

    policyEngine = new PolicyEngine(mockDatabaseService as any, mockCacheService as any);
  });

  describe('buildAbility', () => {
    it('should return an ability with no rules when user has no roles', async () => {
      const context: PolicyContext = {
        userId: 'user-123',
        tenantId: 'tenant-456',
      };

      const ability = await policyEngine.buildAbility(context);

      expect(ability).toBeDefined();
      // User with no roles should not be able to do anything
      expect(ability.can('read', 'User')).toBe(false);
      expect(ability.can('manage', 'all')).toBe(false);
    });

    it('should build ability from direct role assignments', async () => {
      const context: PolicyContext = {
        userId: 'user-123',
        tenantId: 'tenant-456',
      };

      const mockRole = createMockRole('role-1', 'reader', [
        { action: 'read', subject: 'User' },
        { action: 'list', subject: 'User' },
      ]);

      // Mock user has a direct role assignment
      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-1',
          userId: 'user-123',
          roleId: 'role-1',
          tenantId: 'tenant-456',
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);

      // Mock role lookup
      mockPrismaClient.role.findMany.mockResolvedValue([mockRole]);

      const ability = await policyEngine.buildAbility(context);

      expect(ability.can('read', 'User')).toBe(true);
      expect(ability.can('list', 'User')).toBe(true);
      expect(ability.can('create', 'User')).toBe(false);
      expect(ability.can('delete', 'User')).toBe(false);
    });

    it('should build ability with manage:all permission', async () => {
      const context: PolicyContext = {
        userId: 'admin-user',
        tenantId: 'tenant-456',
      };

      const mockRole = createMockRole('admin-role', 'admin', [
        { action: 'manage', subject: 'all' },
      ]);

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-admin',
          userId: 'admin-user',
          roleId: 'admin-role',
          tenantId: 'tenant-456',
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);

      mockPrismaClient.role.findMany.mockResolvedValue([mockRole]);

      const ability = await policyEngine.buildAbility(context);

      expect(ability.can('read', 'User')).toBe(true);
      expect(ability.can('create', 'User')).toBe(true);
      expect(ability.can('update', 'User')).toBe(true);
      expect(ability.can('delete', 'User')).toBe(true);
      expect(ability.can('manage', 'Tenant')).toBe(true);
    });

    it('should inherit policies from parent role', async () => {
      const context: PolicyContext = {
        userId: 'user-123',
        tenantId: 'tenant-456',
      };

      const mockRole = createMockRole(
        'child-role',
        'child',
        [{ action: 'read', subject: 'Document' }],
        {
          id: 'parent-role',
          name: 'parent',
          rules: [{ action: 'read', subject: 'User' }],
        }
      );

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-1',
          userId: 'user-123',
          roleId: 'child-role',
          tenantId: 'tenant-456',
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);

      mockPrismaClient.role.findMany.mockResolvedValue([mockRole]);

      const ability = await policyEngine.buildAbility(context);

      // Should have permissions from both child and parent
      expect(ability.can('read', 'Document')).toBe(true);
      expect(ability.can('read', 'User')).toBe(true);
    });

    it('should resolve template variables in conditions', async () => {
      const context: PolicyContext = {
        userId: 'user-123',
        tenantId: 'tenant-456',
        params: { resourceId: 'resource-789' },
      };

      const mockRole = createMockRole('role-1', 'self-access', [
        {
          action: 'read',
          subject: 'User',
          conditions: {
            id: '${user.id}',
            tenantId: '${context.tenantId}',
          },
        },
      ]);

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-1',
          userId: 'user-123',
          roleId: 'role-1',
          tenantId: 'tenant-456',
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);

      mockPrismaClient.role.findMany.mockResolvedValue([mockRole]);

      const ability = await policyEngine.buildAbility(context);

      // The conditions should be resolved with actual values
      expect(ability).toBeDefined();
      // CASL will evaluate conditions against the subject instance
    });

    it('should apply scope overrides from assignment', async () => {
      const context: PolicyContext = {
        userId: 'user-123',
        tenantId: 'tenant-456',
      };

      const mockRole = {
        id: 'role-1',
        name: 'base-role',
        resourceStatus: 'ENABLED',
        RolePolicies: [
          {
            id: 'rp-1',
            Policy: {
              id: 'policy-1',
              resourceStatus: 'ENABLED',
              rules: [{ action: 'read', subject: 'User' }],
            },
          },
          {
            id: 'rp-2',
            Policy: {
              id: 'policy-to-exclude',
              resourceStatus: 'ENABLED',
              rules: [{ action: 'delete', subject: 'User' }],
            },
          },
        ],
        ParentRole: null,
      };

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-1',
          userId: 'user-123',
          roleId: 'role-1',
          tenantId: 'tenant-456',
          scopeOverrides: {
            additionalRules: [{ action: 'create', subject: 'Report' }],
            excludedPolicies: ['policy-to-exclude'],
          },
          resourceStatus: 'ENABLED',
        },
      ]);

      mockPrismaClient.role.findMany.mockResolvedValue([mockRole]);

      const ability = await policyEngine.buildAbility(context);

      // Should have read:User from policy-1
      expect(ability.can('read', 'User')).toBe(true);
      // Should have create:Report from additional rules
      expect(ability.can('create', 'Report')).toBe(true);
      // Should NOT have delete:User (policy was excluded)
      expect(ability.can('delete', 'User')).toBe(false);
    });

    it('should use cache when available', async () => {
      const context: PolicyContext = {
        userId: 'user-123',
        tenantId: 'tenant-456',
      };

      mockCacheService.isConnected.mockReturnValue(true);
      mockCacheService.get.mockResolvedValue(
        JSON.stringify([{ action: 'read', subject: 'CachedResource' }])
      );

      const ability = await policyEngine.buildAbility(context);

      expect(mockCacheService.get).toHaveBeenCalled();
      expect(mockPrismaClient.userRoleAssignment.findMany).not.toHaveBeenCalled();
      expect(ability.can('read', 'CachedResource')).toBe(true);
    });

    it('should cache ability after building from database', async () => {
      const context: PolicyContext = {
        userId: 'user-123',
        tenantId: 'tenant-456',
      };

      mockCacheService.isConnected.mockReturnValue(true);
      mockCacheService.get.mockResolvedValue(null); // Cache miss

      const mockRole = createMockRole('role-1', 'reader', [
        { action: 'read', subject: 'User' },
      ]);

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-1',
          userId: 'user-123',
          roleId: 'role-1',
          tenantId: 'tenant-456',
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);

      mockPrismaClient.role.findMany.mockResolvedValue([mockRole]);

      await policyEngine.buildAbility(context);

      expect(mockCacheService.setex).toHaveBeenCalled();
    });

    it('should handle multiple role assignments', async () => {
      const context: PolicyContext = {
        userId: 'user-123',
        tenantId: 'tenant-456',
      };

      const mockRole1 = createMockRole('role-1', 'reader', [
        { action: 'read', subject: 'User' },
      ]);

      const mockRole2 = createMockRole('role-2', 'writer', [
        { action: 'create', subject: 'Document' },
      ]);

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-1',
          userId: 'user-123',
          roleId: 'role-1',
          tenantId: 'tenant-456',
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
        {
          id: 'ura-2',
          userId: 'user-123',
          roleId: 'role-2',
          tenantId: 'tenant-456',
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);

      mockPrismaClient.role.findMany.mockResolvedValue([mockRole1, mockRole2]);

      const ability = await policyEngine.buildAbility(context);

      // Should have permissions from both roles
      expect(ability.can('read', 'User')).toBe(true);
      expect(ability.can('create', 'Document')).toBe(true);
    });

    it('should handle platform-wide role assignments (SYSTEM_TENANT_ID)', async () => {
      const context: PolicyContext = {
        userId: 'user-123',
        tenantId: 'tenant-456',
      };

      const mockRole = createMockRole('global-role', 'global', [
        { action: 'read', subject: 'GlobalResource' },
      ]);

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-global',
          userId: 'user-123',
          roleId: 'global-role',
          // TASK-305 Phase A: platform-wide rows live under SYSTEM_TENANT_ID (was NULL).
          tenantId: '00000000-0000-0000-0000-000000000000',
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);

      mockPrismaClient.role.findMany.mockResolvedValue([mockRole]);

      const ability = await policyEngine.buildAbility(context);

      expect(ability.can('read', 'GlobalResource')).toBe(true);
    });
  });

  describe('can / cannot', () => {
    it('should check permissions correctly', async () => {
      const context: PolicyContext = { userId: 'user-123' };

      const mockRole = createMockRole('role-1', 'reader', [
        { action: 'read', subject: 'User' },
      ]);

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-1',
          userId: 'user-123',
          roleId: 'role-1',
          tenantId: null,
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);

      mockPrismaClient.role.findMany.mockResolvedValue([mockRole]);

      const ability = await policyEngine.buildAbility(context);

      expect(policyEngine.can(ability, 'read', 'User')).toBe(true);
      expect(policyEngine.cannot(ability, 'read', 'User')).toBe(false);
      expect(policyEngine.can(ability, 'delete', 'User')).toBe(false);
      expect(policyEngine.cannot(ability, 'delete', 'User')).toBe(true);
    });

    it('should check permissions with conditions', async () => {
      const context: PolicyContext = { userId: 'user-123' };

      const mockRole = createMockRole('role-1', 'self-access', [
        { action: 'read', subject: 'User', conditions: { id: 'user-123' } },
      ]);

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-1',
          userId: 'user-123',
          roleId: 'role-1',
          tenantId: null,
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);

      mockPrismaClient.role.findMany.mockResolvedValue([mockRole]);

      const ability = await policyEngine.buildAbility(context);

      // Check basic permission - should be able to read User (with conditions)
      expect(policyEngine.can(ability, 'read', 'User')).toBe(true);

      // Check that other actions are not allowed
      expect(policyEngine.can(ability, 'update', 'User')).toBe(false);
      expect(policyEngine.can(ability, 'delete', 'User')).toBe(false);
    });
  });

  describe('getAccessibleBy', () => {
    it('should return accessible filter for Prisma queries', async () => {
      const context: PolicyContext = { userId: 'user-123' };

      const mockRole = createMockRole('role-1', 'reader', [
        { action: 'read', subject: 'User' },
      ]);

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-1',
          userId: 'user-123',
          roleId: 'role-1',
          tenantId: null,
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);

      mockPrismaClient.role.findMany.mockResolvedValue([mockRole]);

      const ability = await policyEngine.buildAbility(context);
      const filter = policyEngine.getAccessibleBy(ability, 'read');

      expect(filter).toBeDefined();
    });
  });

  describe('getPermittedFields', () => {
    it('should return permitted fields when defined', async () => {
      const context: PolicyContext = { userId: 'user-123' };

      const mockRole = createMockRole('role-1', 'limited-reader', [
        { action: 'read', subject: 'User', fields: ['id', 'name', 'email'] },
      ]);

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-1',
          userId: 'user-123',
          roleId: 'role-1',
          tenantId: null,
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);

      mockPrismaClient.role.findMany.mockResolvedValue([mockRole]);

      const ability = await policyEngine.buildAbility(context);
      const fields = policyEngine.getPermittedFields(ability, 'read', 'User');

      expect(fields).toEqual(['id', 'name', 'email']);
    });

    it('should return undefined when no field restrictions', async () => {
      const context: PolicyContext = { userId: 'user-123' };

      const mockRole = createMockRole('role-1', 'reader', [
        { action: 'read', subject: 'User' }, // No fields restriction
      ]);

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-1',
          userId: 'user-123',
          roleId: 'role-1',
          tenantId: null,
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);

      mockPrismaClient.role.findMany.mockResolvedValue([mockRole]);

      const ability = await policyEngine.buildAbility(context);
      const fields = policyEngine.getPermittedFields(ability, 'read', 'User');

      expect(fields).toBeUndefined();
    });
  });

  describe('cache invalidation', () => {
    beforeEach(() => {
      mockCacheService.isConnected.mockReturnValue(true);
    });

    it('should invalidate user cache', async () => {
      mockCacheService.keys.mockResolvedValue([
        'policy:ability:user-123:tenant-1',
        'policy:ability:user-123:tenant-2',
      ]);

      await policyEngine.invalidateUser('user-123');

      expect(mockCacheService.keys).toHaveBeenCalledWith('policy:ability:user-123:*');
      expect(mockCacheService.delMany).toHaveBeenCalledWith([
        'policy:ability:user-123:tenant-1',
        'policy:ability:user-123:tenant-2',
      ]);
    });

    it('should invalidate role cache for all users with direct assignments', async () => {
      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        { userId: 'user-1' },
        { userId: 'user-2' },
      ]);

      mockCacheService.keys.mockResolvedValue([]);

      await policyEngine.invalidateRole('role-123');

      expect(mockPrismaClient.userRoleAssignment.findMany).toHaveBeenCalledWith({
        where: { roleId: 'role-123' },
        select: { userId: true },
      });
    });

    it('should invalidate policy cache', async () => {
      mockPrismaClient.rolePolicy.findMany.mockResolvedValue([
        { roleId: 'role-1' },
        { roleId: 'role-2' },
      ]);

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([]);

      await policyEngine.invalidatePolicy('policy-123');

      expect(mockPrismaClient.rolePolicy.findMany).toHaveBeenCalledWith({
        where: { policyId: 'policy-123' },
        select: { roleId: true },
      });
    });

    it('should invalidate tenant cache', async () => {
      mockCacheService.keys.mockResolvedValue([
        'policy:ability:user-1:tenant-456',
        'policy:ability:user-2:tenant-456',
      ]);

      await policyEngine.invalidateTenant('tenant-456');

      expect(mockCacheService.keys).toHaveBeenCalledWith('policy:ability:*:tenant-456');
      expect(mockCacheService.delMany).toHaveBeenCalled();
    });

    it('should invalidate all cache', async () => {
      mockCacheService.keys.mockResolvedValue([
        'policy:ability:user-1:tenant-1',
        'policy:ability:user-2:tenant-2',
      ]);

      await policyEngine.invalidateAll();

      expect(mockCacheService.keys).toHaveBeenCalledWith('policy:ability:*');
      expect(mockCacheService.delMany).toHaveBeenCalled();
    });

    it('should skip invalidation when cache is not connected', async () => {
      mockCacheService.isConnected.mockReturnValue(false);

      await policyEngine.invalidateUser('user-123');

      expect(mockCacheService.keys).not.toHaveBeenCalled();
      expect(mockCacheService.delMany).not.toHaveBeenCalled();
    });
  });

  describe('inverted rules (cannot)', () => {
    it('should handle inverted rules correctly', async () => {
      const context: PolicyContext = { userId: 'user-123' };

      const mockRole = createMockRole('role-1', 'limited-manager', [
        { action: 'manage', subject: 'User' },
        { action: 'delete', subject: 'User', inverted: true }, // Cannot delete
      ]);

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        {
          id: 'ura-1',
          userId: 'user-123',
          roleId: 'role-1',
          tenantId: null,
          scopeOverrides: null,
          resourceStatus: 'ENABLED',
        },
      ]);

      mockPrismaClient.role.findMany.mockResolvedValue([mockRole]);

      const ability = await policyEngine.buildAbility(context);

      expect(ability.can('read', 'User')).toBe(true);
      expect(ability.can('update', 'User')).toBe(true);
      // Inverted rule should deny delete
      expect(ability.can('delete', 'User')).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      const context: PolicyContext = { userId: 'user-123' };

      mockPrismaClient.userRoleAssignment.findMany.mockRejectedValue(
        new Error('Database connection failed')
      );

      // Should throw or return empty ability
      await expect(policyEngine.buildAbility(context)).rejects.toThrow();
    });

    it('should handle cache errors gracefully', async () => {
      const context: PolicyContext = { userId: 'user-123' };

      mockCacheService.isConnected.mockReturnValue(true);
      mockCacheService.get.mockRejectedValue(new Error('Redis error'));

      // Should fall back to database
      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([]);

      const ability = await policyEngine.buildAbility(context);

      expect(ability).toBeDefined();
      expect(mockPrismaClient.userRoleAssignment.findMany).toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Tenant scoping of the role-assignment lookup (TASK-305 Phase A alignment).
  //
  // `UserRoleAssignment.tenantId` became a required, non-nullable column;
  // platform-wide assignments (e.g. SUPER_ADMIN) live under SYSTEM_TENANT_ID
  // ('00000000-…'), not NULL. The loader must (a) always include the system
  // tenant, (b) add the request tenant only when present, and (c) never put a
  // raw `undefined` into the Prisma filter — Prisma 7 rejects
  // `{ tenantId: undefined }` with "Argument `tenantId` is missing", which
  // crashed every tenant-less admin request (super_admin → /admin/*).
  // ───────────────────────────────────────────────────────────────────────
  describe('loadUserPolicies — tenant scoping (TASK-305 schema alignment)', () => {
    const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

    it('queries only the system tenant when context has no tenantId (no undefined leaks to Prisma)', async () => {
      await policyEngine.buildAbility({ userId: 'user-123' });

      expect(mockPrismaClient.userRoleAssignment.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          resourceStatus: 'ENABLED',
          tenantId: { in: [SYSTEM_TENANT_ID] },
        },
      });

      const passedWhere = mockPrismaClient.userRoleAssignment.findMany.mock.calls[0][0].where;
      expect(JSON.stringify(passedWhere)).not.toContain('null');
      expect(passedWhere.OR).toBeUndefined();
    });

    it('includes both the system tenant and the request tenant when context has a tenantId', async () => {
      await policyEngine.buildAbility({ userId: 'user-123', tenantId: 'tenant-456' });

      expect(mockPrismaClient.userRoleAssignment.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          resourceStatus: 'ENABLED',
          tenantId: { in: [SYSTEM_TENANT_ID, 'tenant-456'] },
        },
      });
    });

    it('does not duplicate the system tenant when context.tenantId === SYSTEM_TENANT_ID', async () => {
      await policyEngine.buildAbility({ userId: 'user-123', tenantId: SYSTEM_TENANT_ID });

      expect(mockPrismaClient.userRoleAssignment.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          resourceStatus: 'ENABLED',
          tenantId: { in: [SYSTEM_TENANT_ID] },
        },
      });
    });

    // Regression — the control-plane lookup MUST use the unscoped baseClient.
    //
    // PolicyEngine resolves SYSTEM + request-tenant assignments with a
    // `tenantId: { in: [...] }` filter. If it went through the extended
    // (tenant-scoped) client, the tenant-scope `$extends` rejects the
    // non-scalar `tenantId` ("TenantScope: tenantId mismatch"), buildAbility
    // throws, and every permissioned request 403s once a tenant context is
    // present. Reading via the unscoped `baseClient` is the sanctioned
    // cross-tenant control-plane path that avoids that throw.
    it('reads role assignments via the unscoped baseClient, never the tenant-scoped client', async () => {
      const baseClientPrisma = {
        userRoleAssignment: { findMany: vi.fn().mockResolvedValue([]) },
        role: { findMany: vi.fn().mockResolvedValue([]) },
      };
      const extendedClientPrisma = {
        userRoleAssignment: { findMany: vi.fn().mockResolvedValue([]) },
        role: { findMany: vi.fn().mockResolvedValue([]) },
      };
      const splitDatabaseService = {
        client: extendedClientPrisma,
        baseClient: baseClientPrisma,
      };
      const engine = new PolicyEngine(splitDatabaseService as any, mockCacheService as any);

      await engine.buildAbility({ userId: 'user-123', tenantId: 'tenant-456' });

      expect(baseClientPrisma.userRoleAssignment.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          resourceStatus: 'ENABLED',
          tenantId: { in: [SYSTEM_TENANT_ID, 'tenant-456'] },
        },
      });
      expect(extendedClientPrisma.userRoleAssignment.findMany).not.toHaveBeenCalled();
    });
  });
});
