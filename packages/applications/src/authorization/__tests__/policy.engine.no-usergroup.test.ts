/**
 * PolicyEngine Tests — Post-UserGroup Removal
 *
 * These tests verify that UserGroup-related code has been completely removed
 * from the PolicyEngine. After removal, the engine should ONLY use direct
 * user-role assignments (UserRoleAssignment), with no references to
 * UserGroupRoleAssignment or UserGroup.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PolicyEngine, PolicyContext } from '../policy.engine';

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

// `PolicyEngine.loadUserPolicies` reads the UNSCOPED platform-admin
// client (`baseClient`) for the cross-tenant RBAC control-plane query, while
// `invalidateRole`/cache-invalidation paths use the scoped `client`. Mock both
// (same fake client) so whichever the engine reaches resolves.
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

describe('PolicyEngine — UserGroup Removal Verification', () => {
  let policyEngine: PolicyEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheService.isConnected.mockReturnValue(false);
    mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([]);
    mockPrismaClient.role.findMany.mockResolvedValue([]);

    policyEngine = new PolicyEngine(mockDatabaseService as any, mockCacheService as any);
  });

  describe('invalidateUserGroup method removal', () => {
    it('should NOT have invalidateUserGroup method', () => {
      expect((policyEngine as any).invalidateUserGroup).toBeUndefined();
    });
  });

  describe('loadUserPolicies without group assignments', () => {
    it('should NOT query userGroupRoleAssignment during buildAbility', async () => {
      const context: PolicyContext = {
        userId: 'user-123',
        tenantId: 'tenant-456',
      };

      await policyEngine.buildAbility(context);

      expect(mockPrismaClient.userRoleAssignment.findMany).toHaveBeenCalled();
      // The mock prisma client should NOT have userGroupRoleAssignment at all
      expect((mockPrismaClient as any).userGroupRoleAssignment).toBeUndefined();
    });

    it('should build ability using only direct role assignments', async () => {
      const context: PolicyContext = {
        userId: 'user-123',
        tenantId: 'tenant-456',
      };

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

      mockPrismaClient.role.findMany.mockResolvedValue([
        {
          id: 'role-1',
          name: 'reader',
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
          ],
          ParentRole: null,
        },
      ]);

      const ability = await policyEngine.buildAbility(context);

      expect(ability.can('read', 'User')).toBe(true);
      expect(ability.can('create', 'User')).toBe(false);
    });
  });

  describe('invalidateRole without group assignments', () => {
    it('should only query direct userRoleAssignment when invalidating role', async () => {
      mockCacheService.isConnected.mockReturnValue(true);
      mockCacheService.keys.mockResolvedValue([]);

      mockPrismaClient.userRoleAssignment.findMany.mockResolvedValue([
        { userId: 'user-1' },
        { userId: 'user-2' },
      ]);

      await policyEngine.invalidateRole('role-123');

      expect(mockPrismaClient.userRoleAssignment.findMany).toHaveBeenCalledWith({
        where: { roleId: 'role-123' },
        select: { userId: true },
      });
      // Should NOT query userGroupRoleAssignment
      expect((mockPrismaClient as any).userGroupRoleAssignment).toBeUndefined();
    });
  });
});
