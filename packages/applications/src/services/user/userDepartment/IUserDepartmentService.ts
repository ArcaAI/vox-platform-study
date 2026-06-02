import { IBaseService } from '../../../interfaces';
import { AssignUserDepartmentRequest, UpdateUserDepartmentRequest, UserDepartmentResponse } from './dto';

/**
 * Tenant-scoped CRUD for user ↔ department assignments (TASK-328 A1).
 */
export interface IUserDepartmentService extends IBaseService {
  /** List a user's active department assignments in the active tenant. */
  getByUser(userId: string): Promise<UserDepartmentResponse[]>;
  /** Assign a user to a department (reactivates a prior soft-deleted row). */
  assign(userId: string, dto: AssignUserDepartmentRequest): Promise<UserDepartmentResponse>;
  /** Update an assignment (e.g. toggle primary) under optimistic concurrency. */
  update(id: string, dto: UpdateUserDepartmentRequest): Promise<UserDepartmentResponse>;
  /** Soft-delete an assignment. */
  unassign(id: string): Promise<UserDepartmentResponse>;

  /**
   * TASK-305 Phase F — pre-auth (baseClient) membership lookup used by the
   * login flow BEFORE any tenant context exists in CLS: does `userId` have an
   * ENABLED `UserDepartment` in `tenantId`? Bypasses the tenant-scope extension
   * (the explicit `tenantId` predicate is the boundary), mirroring
   * `IUserRoleAssignmentService.findActiveAssignmentForUserInTenant`.
   */
  findActiveDepartmentForUserInTenant(userId: string, tenantId: string): Promise<{ id: string } | null>;
}

export const IUserDepartmentService = Symbol('IUserDepartmentService');
