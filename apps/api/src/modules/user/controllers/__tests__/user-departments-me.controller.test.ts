/**
 * UserDepartmentsMeController — self-service department read
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

describe('UserDepartmentsMeController', () => {
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

    /**
     *  — the ownership property the playground's department
     * picker now RESTS on.
     *
     * The Consultation Scribe moved its picker off `admin/departments` (403 for
     * a clinician) onto this route. That is only safe because the subject is
     * the CLS principal and nothing else: under impersonation CLS holds the
     * IMPERSONATED clinician, so the read must follow the clinician, never the
     * admin who is acting as them, and never an id supplied by the caller.
 */
    it('follows the IMPERSONATED clinician, not the admin acting as them', async () => {
      clsService = createMockClsService({ id: 'doctor-derm', impersonatedBy: 'tenant-admin-1' } as never);
      controller = new UserDepartmentsMeController(userDepartmentService as never, clsService as never);
      userDepartmentService.getByUser.mockResolvedValue([]);

      await controller.myDepartments();

      expect(userDepartmentService.getByUser).toHaveBeenCalledWith('doctor-derm');
      expect(userDepartmentService.getByUser).not.toHaveBeenCalledWith('tenant-admin-1');
    });

    /**
     * Cross-clinician isolation is STRUCTURAL here, and this test pins the
     * structure rather than a branch: `myDepartments` takes no parameters, so
     * there is no id for one clinician to substitute for another's. If someone
     * ever adds one, this fails and the reviewer is forced to think about it.
     */
    it('exposes no caller-supplied id — the subject cannot be substituted', async () => {
      userDepartmentService.getByUser.mockResolvedValue([]);

      expect(controller.myDepartments.length).toBe(0);

      // Calling it with another clinician's id changes nothing: the argument
      // is ignored and CLS still decides.
      await (controller.myDepartments as (id?: string) => Promise<unknown>)('some-other-doctor');

      expect(userDepartmentService.getByUser).toHaveBeenCalledWith('user-1');
      expect(userDepartmentService.getByUser).not.toHaveBeenCalledWith('some-other-doctor');
    });

    it('throws UnauthorizedException when no user is in CLS', async () => {
      clsService = createMockClsService(undefined);
      controller = new UserDepartmentsMeController(userDepartmentService as never, clsService as never);

      await expect(controller.myDepartments()).rejects.toBeInstanceOf(UnauthorizedException);
      expect(userDepartmentService.getByUser).not.toHaveBeenCalled();
    });
  });
});
