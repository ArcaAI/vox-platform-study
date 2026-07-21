import { IBaseService } from '../../../interfaces';
import { AssignUserDepartmentRequest, SetUserDepartmentsRequest, UpdateUserDepartmentRequest, UserDepartmentResponse } from './dto';

/**
 * Tenant-scoped CRUD for user ↔ department assignments.
 */
export interface IUserDepartmentService extends IBaseService {
  /** List a user's active department assignments in the active tenant. */
  getByUser(userId: string): Promise<UserDepartmentResponse[]>;
  /** Assign a user to a department (reactivates a prior soft-deleted row). */
  assign(userId: string, dto: AssignUserDepartmentRequest): Promise<UserDepartmentResponse>;
  /**
   * Reconcile a user's department memberships to EXACTLY
   * `dto.departmentIds` (adds missing, soft-deletes the rest) and set
   * `dto.primaryDepartmentId` as the single primary. Returns the resulting
   * active assignments.
   */
  setDepartments(userId: string, dto: SetUserDepartmentsRequest): Promise<UserDepartmentResponse[]>;
  /** Update an assignment (e.g. toggle primary) under optimistic concurrency. */
  update(id: string, dto: UpdateUserDepartmentRequest): Promise<UserDepartmentResponse>;
  /** Soft-delete an assignment. */
  unassign(id: string): Promise<UserDepartmentResponse>;

  /**
   * Pre-auth (baseClient) membership lookup used by the
   * login flow BEFORE any tenant context exists in CLS: does `userId` have an
   * ENABLED `UserDepartment` in `tenantId`? Bypasses the tenant-scope extension
   * (the explicit `tenantId` predicate is the boundary), mirroring
   * `IUserRoleAssignmentService.findActiveAssignmentForUserInTenant`.
   */
  findActiveDepartmentForUserInTenant(userId: string, tenantId: string): Promise<{ id: string } | null>;
}

export const IUserDepartmentService = Symbol('IUserDepartmentService');
