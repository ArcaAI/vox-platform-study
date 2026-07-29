/**
 * `fetchAllByRoleId`: the users-by-role listing behind
 * `GET /admin/rbac/roles/:id/members`.
 *
 * The read needs a `User` + profile + department join the generic
 * `Repository<E,M>` base cannot express, so it uses the raw client at this
 * service's sanctioned Prisma boundary — but through the SCOPED extended
 * client (`client`, NOT `baseClient`): the tenant-scope `$extends` injects the
 * caller's CLS tenant (tenant admins see only their tenant's members; an
 * unscoped platform admin passes through and sees all) and the soft-delete
 * extension filters DELETED rows. This is the `fetchAll` posture — the
 * baseClient reads above it are pre-auth identity paths and stay unchanged.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SysEventType, ResourceStatusType } from '@arcaai/domains';
import { UserRoleAssignmentService } from '../userRoleAssignment.service';

const mockClsService = {
  get: vi.fn((key: string) => {
    if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
    if (key === 'tenantId') return 'tenant-1';
    return null;
  }),
  set: vi.fn(),
};

const mockEventEmitter = { emit: vi.fn() };

const mockRepository = {
  findById: vi.fn(),
  findFirst: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  restore: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
};

const mockDatabaseService = {
  baseClient: {},
  client: {
    userRoleAssignment: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
};

function buildService() {
  return new UserRoleAssignmentService(mockRepository as never, mockEventEmitter as never, mockClsService as never, mockDatabaseService as never);
}

/** A raw joined row as the scoped client returns it. */
function makeJoinedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'assign-1',
    userId: 'user-1',
    roleId: 'role-1',
    tenantId: 'tenant-1',
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-03-01T10:00:00Z'),
    User: {
      id: 'user-1',
      username: 'jdoe',
      resourceStatus: ResourceStatusType.ENABLED,
      UserProfile: { firstName: 'Jane', lastName: 'Doe', email: 'jane@clinic.test' },
      UserDepartments: [
        { tenantId: 'tenant-1', isPrimary: true, Department: { name: 'Cardiology' } },
        { tenantId: 'tenant-2', isPrimary: true, Department: { name: 'OtherTenantDept' } },
      ],
    },
    ...overrides,
  };
}

describe('UserRoleAssignmentService.fetchAllByRoleId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDatabaseService.client.userRoleAssignment.findMany.mockResolvedValue([]);
    mockDatabaseService.client.userRoleAssignment.count.mockResolvedValue(0);
  });

  it('queries the SCOPED client by roleId with pagination and the User join', async () => {
    const service = buildService();

    await service.fetchAllByRoleId({ page: 2, pageSize: 10, roleId: 'role-1' });

    expect(mockDatabaseService.client.userRoleAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { roleId: 'role-1' },
        skip: 10,
        take: 10,
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(mockDatabaseService.client.userRoleAssignment.count).toHaveBeenCalledWith({ where: { roleId: 'role-1' } });
  });

  it('maps joined rows to member rows: display name, tenant-matched department, statuses', async () => {
    mockDatabaseService.client.userRoleAssignment.findMany.mockResolvedValue([makeJoinedRow()]);
    mockDatabaseService.client.userRoleAssignment.count.mockResolvedValue(1);
    const service = buildService();

    const result = await service.fetchAllByRoleId({ page: 1, pageSize: 20, roleId: 'role-1' });

    expect(result.total).toBe(1);
    expect(result.data).toEqual([
      {
        assignmentId: 'assign-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        username: 'jdoe',
        displayName: 'Jane Doe',
        email: 'jane@clinic.test',
        // The department must match the ASSIGNMENT's tenant, not another
        // tenant's membership of the same (global) user.
        department: 'Cardiology',
        resourceStatus: ResourceStatusType.ENABLED,
        userResourceStatus: ResourceStatusType.ENABLED,
        assignedAt: new Date('2026-03-01T10:00:00Z'),
      },
    ]);
  });

  it('falls back to the username when no profile exists and null department when none match', async () => {
    mockDatabaseService.client.userRoleAssignment.findMany.mockResolvedValue([
      makeJoinedRow({
        User: {
          id: 'user-2',
          username: 'svc-account',
          resourceStatus: ResourceStatusType.ENABLED,
          UserProfile: null,
          UserDepartments: [{ tenantId: 'tenant-9', isPrimary: true, Department: { name: 'Elsewhere' } }],
        },
      }),
    ]);
    mockDatabaseService.client.userRoleAssignment.count.mockResolvedValue(1);
    const service = buildService();

    const result = await service.fetchAllByRoleId({ page: 1, pageSize: 20, roleId: 'role-1' });

    expect(result.data[0].displayName).toBe('svc-account');
    expect(result.data[0].email).toBeNull();
    expect(result.data[0].department).toBeNull();
  });

  it('prefers the primary department when several match the assignment tenant', async () => {
    mockDatabaseService.client.userRoleAssignment.findMany.mockResolvedValue([
      makeJoinedRow({
        User: {
          id: 'user-1',
          username: 'jdoe',
          resourceStatus: ResourceStatusType.ENABLED,
          UserProfile: { firstName: 'Jane', lastName: 'Doe', email: null },
          UserDepartments: [
            { tenantId: 'tenant-1', isPrimary: false, Department: { name: 'Radiology' } },
            { tenantId: 'tenant-1', isPrimary: true, Department: { name: 'Cardiology' } },
          ],
        },
      }),
    ]);
    mockDatabaseService.client.userRoleAssignment.count.mockResolvedValue(1);
    const service = buildService();

    const result = await service.fetchAllByRoleId({ page: 1, pageSize: 20, roleId: 'role-1' });

    expect(result.data[0].department).toBe('Cardiology');
  });

  it('broadcasts ResourceViewed with the roleId and listed assignment ids', async () => {
    mockDatabaseService.client.userRoleAssignment.findMany.mockResolvedValue([makeJoinedRow()]);
    mockDatabaseService.client.userRoleAssignment.count.mockResolvedValue(1);
    const service = buildService();

    await service.fetchAllByRoleId({ page: 1, pageSize: 20, roleId: 'role-1' });

    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceViewed,
      expect.objectContaining({ data: { roleId: 'role-1', items: ['assign-1'] } }),
    );
  });
});
