/**
 * UserDepartmentsMeController — self-service department read (BUG-005 Issue 4)
 *
 * The admin `GET /admin/users/:id/departments` route requires `@CanManage('User')`,
 * so an end-user (or an impersonated one, whose act-as JWT carries their own
 * non-elevated roles) could never see their own department. This mirrors
 * `UserDepartmentsController.list` but resolves the caller from CLS instead
 * of an admin-supplied `:id`, matching `UserSettingsController.getMySettings`'s
 * self-service convention.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { UserDepartmentsMeController } from '../user-departments-me.controller';

const createMockUserDepartmentService = () => ({
  getByUser: vi.fn(),
});

const createMockClsService = (user?: { id: string }) => ({
  get: vi.fn((key: string) => {
    if (key === 'user') return user;
    return undefined;
  }),
});

describe('UserDepartmentsMeController (BUG-005 Issue 4)', () => {
  let controller: UserDepartmentsMeController;
  let userDepartmentService: ReturnType<typeof createMockUserDepartmentService>;
  let clsService: ReturnType<typeof createMockClsService>;

  beforeEach(() => {
    userDepartmentService = createMockUserDepartmentService();
    clsService = createMockClsService({ id: 'user-1' });
    controller = new UserDepartmentsMeController(userDepartmentService as never, clsService as never);
  });

  describe('myDepartments', () => {
    it("returns the caller's own department assignments, resolved from CLS", async () => {
      const assignments = [{ id: 'ud-1', departmentId: 'dept-1', departmentName: 'Cardiology', primary: true }];
      userDepartmentService.getByUser.mockResolvedValue(assignments);

      const result = await controller.myDepartments();

      expect(userDepartmentService.getByUser).toHaveBeenCalledWith('user-1');
      expect(result).toBe(assignments);
    });

    it('throws UnauthorizedException when no user is in CLS', async () => {
      clsService = createMockClsService(undefined);
      controller = new UserDepartmentsMeController(userDepartmentService as never, clsService as never);

      await expect(controller.myDepartments()).rejects.toBeInstanceOf(UnauthorizedException);
      expect(userDepartmentService.getByUser).not.toHaveBeenCalled();
    });
  });
});
