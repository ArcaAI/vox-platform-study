/**
 * `GET /admin/rbac/roles/:id/members` + `memberCount` on the role
 * responses. The controller stays a thin transport wrapper: role existence is
 * checked through `IRbacRoleService.findOne` (missing → 404 — roles are
 * global, so there is no cross-tenant role case; the MEMBER rows themselves
 * are tenant-scoped by the service layer, so another tenant's members are
 * simply absent), and the listing is delegated to
 * `IUserRoleAssignmentService.fetchAllByRoleId`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY, PERMISSION_MODE_KEY } from '@arcaai/applications';
import { RolesController } from '../roles.controller';

function makeRoleRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'role-1',
    name: 'doctor',
    description: 'Practising doctor',
    externalName: null,
    externalId: null,
    isSystemRole: false,
    parentRoleId: null,
    resourceStatus: 'ENABLED',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    RolePolicies: [],
    ...overrides,
  };
}

const MEMBER_ROW = {
  assignmentId: 'assign-1',
  userId: 'user-1',
  tenantId: 'tenant-1',
  username: 'jdoe',
  displayName: 'Jane Doe',
  email: 'jane@clinic.test',
  department: 'Cardiology',
  resourceStatus: 'ENABLED',
  userResourceStatus: 'ENABLED',
  assignedAt: new Date('2026-03-01T10:00:00Z'),
};

function makeController() {
  const roleService = {
    findAll: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    patch: vi.fn(),
    softDelete: vi.fn(),
    assignPolicy: vi.fn(),
    removePolicy: vi.fn(),
  };
  const userRoleAssignmentService = {
    fetchAllByRoleId: vi.fn(),
  };
  const controller = new RolesController(roleService as never, userRoleAssignmentService as never);
  return { controller, roleService, userRoleAssignmentService };
}

describe('TASK-444 — RolesController.listMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is gated by read OR manage on Role (parity with the other read routes)', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, RolesController.prototype.listMembers)).toEqual([
      { action: 'read', subject: 'Role' },
      { action: 'manage', subject: 'Role' },
    ]);
    expect(Reflect.getMetadata(PERMISSION_MODE_KEY, RolesController.prototype.listMembers)).toBe('OR');
  });

  it('404s when the role does not exist (no members call is made)', async () => {
    const { controller, roleService, userRoleAssignmentService } = makeController();
    roleService.findOne.mockResolvedValue(null);

    await expect(controller.listMembers('missing-role', 1, 20)).rejects.toBeInstanceOf(NotFoundException);
    expect(userRoleAssignmentService.fetchAllByRoleId).not.toHaveBeenCalled();
  });

  it('returns the paginated members envelope from fetchAllByRoleId', async () => {
    const { controller, roleService, userRoleAssignmentService } = makeController();
    roleService.findOne.mockResolvedValue(makeRoleRecord());
    userRoleAssignmentService.fetchAllByRoleId.mockResolvedValue({ data: [MEMBER_ROW], total: 41 });

    const result = await controller.listMembers('role-1', 3, 20);

    expect(userRoleAssignmentService.fetchAllByRoleId).toHaveBeenCalledWith({ page: 3, pageSize: 20, roleId: 'role-1' });
    expect(result).toEqual({ data: [MEMBER_ROW], total: 41, page: 3, pageSize: 20 });
  });
});

describe('TASK-444 — memberCount on role responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('findOne surfaces _count.UserRoleAssignments as memberCount', async () => {
    const { controller, roleService } = makeController();
    roleService.findOne.mockResolvedValue(makeRoleRecord({ _count: { UserRoleAssignments: 7 } }));

    const response = await controller.findOne('role-1');

    expect(response.memberCount).toBe(7);
  });

  it('findAll surfaces memberCount per row', async () => {
    const { controller, roleService } = makeController();
    roleService.findAll.mockResolvedValue({ data: [makeRoleRecord({ _count: { UserRoleAssignments: 2 } })], total: 1 });

    const response = await controller.findAll(1, 20);

    expect(response.data[0].memberCount).toBe(2);
  });

  it('leaves memberCount undefined when the read carried no _count (mutation returns)', async () => {
    const { controller, roleService } = makeController();
    roleService.create.mockResolvedValue({ ...makeRoleRecord(), RolePolicies: [] });

    const response = await controller.create({ name: 'auditor' } as never);

    expect(response.memberCount).toBeUndefined();
  });
});
