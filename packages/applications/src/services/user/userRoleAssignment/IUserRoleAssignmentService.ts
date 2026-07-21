import { EntityId, UserRoleAssignmentEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../../common';
import { IBaseService } from '../../../interfaces';
import { CreateUserRoleAssignmentRequest, UpdateUserRoleAssignmentRequest } from './dto';

/**
 * Minimal projection of a Role row needed by the auth-issuance
 * path. Defined here (rather than re-using the auto-generated `RoleEntity`) so
 * the service contract stays narrow: only `id`, `name`, and the legacy
 * `permissions` claim list — the only fields `AuthController.getUserRoles` and
 * `getUserPermissions` consume today.
 */
export interface AuthRoleSummary {
  id: string;
  name: string;
  permissions?: string[];
}

/**
 * Minimal projection of a UserRoleAssignment row used for
 * login-time tenant validation. Matches the raw Prisma shape the controller
 * previously relied on directly.
 */
export interface ActiveUserRoleAssignmentRow {
  id: string;
  userId: string;
  roleId: string;
  tenantId: string | null;
  resourceStatus: string;
}

/**
 * One member of a role: a `UserRoleAssignment` row joined to its
 * (global) `User`, projected for the admin members listing. `department` is
 * the user's department IN THE ASSIGNMENT'S TENANT (primary preferred);
 * `resourceStatus` is the membership (assignment) status, `userResourceStatus`
 * the account status.
 */
export interface RoleMemberRow {
  assignmentId: string;
  userId: string;
  tenantId: string;
  username: string;
  displayName: string;
  email: string | null;
  department: string | null;
  resourceStatus: string;
  userResourceStatus: string;
  assignedAt: Date;
}

/** Members listing result (RBAC-surface envelope: data + total). */
export interface RoleMembersResult {
  data: RoleMemberRow[];
  total: number;
}

export interface IUserRoleAssignmentService extends IBaseService {
  create(request: CreateUserRoleAssignmentRequest): Promise<UserRoleAssignmentEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchAllByUserId(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>>;

  /**
   * The inverse of `fetchAllByUserId`: who holds this role.
   * Tenant-scoped through the extended client (tenant admins see their
   * tenant's members; an unscoped platform admin sees all assignments).
   */
  fetchAllByRoleId(props: { page: number; pageSize: number; roleId: string }): Promise<RoleMembersResult>;
  fetchById(id: EntityId): Promise<UserRoleAssignmentEntity>;
  update(id: EntityId, request: UpdateUserRoleAssignmentRequest): Promise<UserRoleAssignmentEntity>;
  deleteById(id: EntityId): Promise<UserRoleAssignmentEntity>;

  /**
   * Replaces the direct Prisma `findFirst` previously used in
   * `AuthController.login` to validate the user has at least one ENABLED role
   * assignment in the tenant key they're authenticating into. Returns the
   * matching assignment, or null when the user has no access to the tenant.
   */
  findActiveAssignmentForUserInTenant(userId: string, tenantId: string): Promise<ActiveUserRoleAssignmentRow | null>;

  /**
   * Replaces the direct Prisma `findMany` previously used in
   * `AuthController.impersonate` to enumerate the tenants the
   * impersonation target user has ENABLED assignments in. Returns unique
   * tenant ids in creation order (oldest first) — matches the previous
   * sortable-via-createdAt behaviour the controller depended on.
   */
  findActiveTenantIdsForUser(userId: string): Promise<string[]>;

  /**
   * Replaces the direct Prisma `findMany({include: {Role}})`
   * previously used in `AuthController.getUserRoles` for JWT role / permission
   * claim construction. Returns the Role rows joined to the user's ENABLED
   * assignments, filtering null Roles defensively against stale joins.
   */
  findActiveRolesForUser(userId: string): Promise<AuthRoleSummary[]>;
}
export const IUserRoleAssignmentService = Symbol('IUserRoleAssignmentService');
