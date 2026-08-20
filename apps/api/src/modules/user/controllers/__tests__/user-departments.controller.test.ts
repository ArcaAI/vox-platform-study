/**
 * UserDepartmentsController — F-07 parent-existence guard on
 * `GET /admin/users/:id/departments`.
 *
 * Before this fix the route delegated straight to
 * `UserDepartmentService.getByUser(id)`, which returns `[]` for both a
 * nonexistent user id AND a real cross-tenant user (its query already
 * tenant-scopes the rows). Both cases must 404 — indistinguishable from
 * each other and from a real, empty result being impossible to tell apart
 * from "no such user" — mirroring `UserController.assertUserInScope`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';
import { UserDepartmentsController } from '../user-departments.controller';

const createMockUserDepartmentService = () => ({
  getByUser: vi.fn(),
  assign: vi.fn(),
  update: vi.fn(),
  unassign: vi.fn(),
});

const createMockUserService = () => ({
  fetchById: vi.fn(),
});

const createMockUserRoleAssignmentService = () => ({
  findActiveTenantIdsForUser: vi.fn(),
});

const createMockCls = (user: { id?: string; roles?: string[] } | null, tenantId: string | null) => ({
  get: vi.fn((key: string) => {
    if (key === 'user') return user;
    if (key === 'tenantId') return tenantId;
    return undefined;
  }),
});

describe('UserDepartmentsController', () => {
  let userDepartmentService: ReturnType<typeof createMockUserDepartmentService>;
  let userService: ReturnType<typeof createMockUserService>;
  let userRoleAssignmentService: ReturnType<typeof createMockUserRoleAssignmentService>;

  const buildController = (cls: ReturnType<typeof createMockCls>) =>
    new UserDepartmentsController(userDepartmentService as never, userService as never, userRoleAssignmentService as never, cls as never);

  beforeEach(() => {
    userDepartmentService = createMockUserDepartmentService();
    userService = createMockUserService();
    userRoleAssignmentService = createMockUserRoleAssignmentService();
  });

  describe('list — GET :id/departments', () => {
    it('returns the assignments when the user exists in the caller tenant', async () => {
      const cls = createMockCls({ id: 'admin-1', roles: ['TENANT_ADMIN'] }, 'tenant-A');
      userService.fetchById.mockResolvedValue({ id: 'user-1' });
      userRoleAssignmentService.findActiveTenantIdsForUser.mockResolvedValue(['tenant-A']);
      const assignments = [{ id: 'ud-1', departmentId: 'dept-1' }];
      userDepartmentService.getByUser.mockResolvedValue(assignments);

      const result = await buildController(cls).list('user-1');

      expect(result).toBe(assignments);
      expect(userDepartmentService.getByUser).toHaveBeenCalledWith('user-1');
    });

    it('404s a nonexistent user id (never a 200 empty list)', async () => {
      const cls = createMockCls({ id: 'admin-1', roles: ['TENANT_ADMIN'] }, 'tenant-A');
      userService.fetchById.mockRejectedValue(new DataNotFoundException('User', 'missing-id'));

      await expect(buildController(cls).list('missing-id')).rejects.toBeInstanceOf(NotFoundException);
      expect(userDepartmentService.getByUser).not.toHaveBeenCalled();
    });

    it('404s (never 403, never a 200 empty list) a real user who belongs to a DIFFERENT tenant', async () => {
      const cls = createMockCls({ id: 'admin-1', roles: ['TENANT_ADMIN'] }, 'tenant-A');
      userService.fetchById.mockResolvedValue({ id: 'victim' });
      userRoleAssignmentService.findActiveTenantIdsForUser.mockResolvedValue(['tenant-OTHER']);

      await expect(buildController(cls).list('victim')).rejects.toBeInstanceOf(NotFoundException);
      expect(userDepartmentService.getByUser).not.toHaveBeenCalled();
    });

    it('404s a non-super-admin caller with no tenant context (no enumeration)', async () => {
      const cls = createMockCls({ id: 'admin-1', roles: ['TENANT_ADMIN'] }, null);
      userService.fetchById.mockResolvedValue({ id: 'user-1' });

      await expect(buildController(cls).list('user-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(userRoleAssignmentService.findActiveTenantIdsForUser).not.toHaveBeenCalled();
      expect(userDepartmentService.getByUser).not.toHaveBeenCalled();
    });

    it('a SUPER_ADMIN still 404s a nonexistent user id (F-07 — the bug this closes)', async () => {
      const cls = createMockCls({ id: 'admin', roles: ['SUPER_ADMIN'] }, null);
      userService.fetchById.mockRejectedValue(new DataNotFoundException('User', 'bogus-id'));

      await expect(buildController(cls).list('bogus-id')).rejects.toBeInstanceOf(NotFoundException);
      expect(userDepartmentService.getByUser).not.toHaveBeenCalled();
    });

    it('an unscoped SUPER_ADMIN reads a real cross-tenant user (deliberate cross-tenant read)', async () => {
      const cls = createMockCls({ id: 'admin', roles: ['SUPER_ADMIN'] }, null);
      userService.fetchById.mockResolvedValue({ id: 'user-1' });
      const assignments = [{ id: 'ud-1', departmentId: 'dept-1' }];
      userDepartmentService.getByUser.mockResolvedValue(assignments);

      const result = await buildController(cls).list('user-1');

      expect(result).toBe(assignments);
      expect(userRoleAssignmentService.findActiveTenantIdsForUser).not.toHaveBeenCalled();
    });
  });
});
