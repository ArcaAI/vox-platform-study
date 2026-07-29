/**
 * UserRoleAssignmentService: tenant-scoped read methods
 *
 * Pins the contract for the three callsites that AuthController previously
 * answered with direct `databaseService.client.userRoleAssignment` access:
 *   1. `findActiveAssignmentForUserInTenant(userId, tenantId)`
 *      → login-time tenant validation
 *   2. `findActiveTenantIdsForUser(userId)`
 *      → impersonation target tenant resolution
 *   3. `findActiveRolesForUser(userId)`
 *      → JWT role / permission claim build
 *
 * Behaviour preservation is the contract — every test below mirrors the
 * Prisma call shape the controller relied on.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResourceStatusType } from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';
import { UserRoleAssignmentService } from '../userRoleAssignment.service';

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

const mockEventEmitter = {
  emit: vi.fn(),
};

const mockUserRoleAssignmentRepository = {
  findFirst: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  restore: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  findById: vi.fn(),
};

// These auth-identity reads run pre-auth / cross-tenant and MUST
// bypass the tenant-scope `$extends`, so they go through `baseClient`. The
// scoped `client` is mocked too, purely to assert it is NEVER touched.
const mockDatabaseService = {
  client: {
    userRoleAssignment: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
  baseClient: {
    userRoleAssignment: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
};

const buildService = () =>
  new UserRoleAssignmentService(mockUserRoleAssignmentRepository as any, mockEventEmitter as any, mockClsService as any, mockDatabaseService as any);

describe('UserRoleAssignmentService tenant-scoped reads', () => {
  let service: UserRoleAssignmentService;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'caller-id', firstName: 'Test', lastName: 'User', email: 'test@example.com' };
        case 'tenantId':
          return 'tenant-A';
        case 'correlationId':
          return 'corr-307-w6';
        case 'requestIp':
          return '127.0.0.1';
        default:
          return null;
      }
    });

    mockUserRoleAssignmentRepository.findFirst.mockRejectedValue(new DataNotFoundException('UserRoleAssignment', 'not-found'));

    service = buildService();
  });

  describe('findActiveAssignmentForUserInTenant', () => {
    it('returns the assignment when the user is ENABLED in the requested tenant', async () => {
      const assignment = {
        id: 'ura-1',
        userId: 'user-1',
        roleId: 'role-1',
        tenantId: 'tenant-B',
        resourceStatus: ResourceStatusType.ENABLED,
      };
      mockDatabaseService.baseClient.userRoleAssignment.findFirst.mockResolvedValue(assignment);

      const result = await service.findActiveAssignmentForUserInTenant('user-1', 'tenant-B');

      expect(result).toEqual(assignment);
      expect(mockDatabaseService.baseClient.userRoleAssignment.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          tenantId: 'tenant-B',
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    });

    it('returns null when no ENABLED assignment exists for the user in the tenant (cross-tenant probe)', async () => {
      mockDatabaseService.baseClient.userRoleAssignment.findFirst.mockResolvedValue(null);

      const result = await service.findActiveAssignmentForUserInTenant('user-A', 'tenant-B');

      expect(result).toBeNull();
      expect(mockDatabaseService.baseClient.userRoleAssignment.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'user-A',
          tenantId: 'tenant-B',
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    });
  });

  describe('findActiveTenantIdsForUser', () => {
    it('returns unique tenant ids in creation order (oldest first)', async () => {
      mockDatabaseService.baseClient.userRoleAssignment.findMany.mockResolvedValue([
        { tenantId: 'tenant-A' },
        { tenantId: 'tenant-B' },
        { tenantId: 'tenant-A' }, // duplicate via second role in same tenant
        { tenantId: 'tenant-C' },
      ]);

      const result = await service.findActiveTenantIdsForUser('user-1');

      expect(result).toEqual(['tenant-A', 'tenant-B', 'tenant-C']);
      // `tenantId` is non-nullable, so the service does NOT
      // push a `{ not: null }` filter (invalid in Prisma 7 + redundant); it
      // skips empty/blank tenantIds in memory instead.
      expect(mockDatabaseService.baseClient.userRoleAssignment.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          resourceStatus: ResourceStatusType.ENABLED,
        },
        select: { tenantId: true },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('drops null/empty tenantIds (defensive — contract)', async () => {
      mockDatabaseService.baseClient.userRoleAssignment.findMany.mockResolvedValue([{ tenantId: null }, { tenantId: '' }, { tenantId: 'tenant-A' }]);

      const result = await service.findActiveTenantIdsForUser('user-1');

      expect(result).toEqual(['tenant-A']);
    });

    it('returns [] when the user has no ENABLED assignments', async () => {
      mockDatabaseService.baseClient.userRoleAssignment.findMany.mockResolvedValue([]);

      const result = await service.findActiveTenantIdsForUser('user-1');

      expect(result).toEqual([]);
    });
  });

  describe('findActiveRolesForUser', () => {
    it('returns the Role objects from each ENABLED assignment, filtering null Roles', async () => {
      mockDatabaseService.baseClient.userRoleAssignment.findMany.mockResolvedValue([
        { Role: { id: 'role-1', name: 'doctor', permissions: ['read:Consultation'] } },
        { Role: null }, // stale join — must be filtered
        { Role: { id: 'role-2', name: 'admin', permissions: ['manage:all'] } },
      ]);

      const result = await service.findActiveRolesForUser('user-1');

      expect(result).toEqual([
        { id: 'role-1', name: 'doctor', permissions: ['read:Consultation'] },
        { id: 'role-2', name: 'admin', permissions: ['manage:all'] },
      ]);
      expect(mockDatabaseService.baseClient.userRoleAssignment.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          resourceStatus: ResourceStatusType.ENABLED,
        },
        include: { Role: true },
      });
    });

    it('returns [] when the user has no ENABLED assignments', async () => {
      mockDatabaseService.baseClient.userRoleAssignment.findMany.mockResolvedValue([]);

      const result = await service.findActiveRolesForUser('user-1');

      expect(result).toEqual([]);
    });
  });

  // Pre-auth identity resolution runs before any tenant context
  // exists in CLS. Routing it through the tenant-scoped `client` makes the
  // tenant-scope `$extends` throw "tenant context required for model
  // UserRoleAssignment" (clean boot) and 401s every login. These three reads
  // MUST use the unscoped `baseClient`; the scoped `client` must stay untouched.
  describe('tenant-scope bypass invariant', () => {
    it('findActiveRolesForUser never touches the scoped client', async () => {
      mockDatabaseService.baseClient.userRoleAssignment.findMany.mockResolvedValue([]);

      await service.findActiveRolesForUser('user-1');

      expect(mockDatabaseService.client.userRoleAssignment.findMany).not.toHaveBeenCalled();
      expect(mockDatabaseService.baseClient.userRoleAssignment.findMany).toHaveBeenCalledTimes(1);
    });

    it('findActiveAssignmentForUserInTenant never touches the scoped client', async () => {
      mockDatabaseService.baseClient.userRoleAssignment.findFirst.mockResolvedValue(null);

      await service.findActiveAssignmentForUserInTenant('user-1', 'tenant-B');

      expect(mockDatabaseService.client.userRoleAssignment.findFirst).not.toHaveBeenCalled();
      expect(mockDatabaseService.baseClient.userRoleAssignment.findFirst).toHaveBeenCalledTimes(1);
    });

    it('findActiveTenantIdsForUser never touches the scoped client', async () => {
      mockDatabaseService.baseClient.userRoleAssignment.findMany.mockResolvedValue([]);

      await service.findActiveTenantIdsForUser('user-1');

      expect(mockDatabaseService.client.userRoleAssignment.findMany).not.toHaveBeenCalled();
      expect(mockDatabaseService.baseClient.userRoleAssignment.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
