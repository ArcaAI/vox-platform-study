import { EntityId, UserRoleAssignmentEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../../common';
import { IBaseService } from '../../../interfaces';
import { CreateUserRoleAssignmentRequest, UpdateUserRoleAssignmentRequest } from './dto';

// TODO: Implement this

/**
 * TASK-307 W6.1 — minimal projection of a Role row needed by the auth-issuance
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
 * TASK-307 W6.1 — minimal projection of a UserRoleAssignment row used for
 * login-time tenant validation. Matches the raw Prisma shape the controller
 * relied on before C-10 was closed.
 */
export interface ActiveUserRoleAssignmentRow {
  id: string;
  userId: string;
  roleId: string;
  tenantId: string | null;
  resourceStatus: string;
}

export interface IUserRoleAssignmentService extends IBaseService {
  create(request: CreateUserRoleAssignmentRequest): Promise<UserRoleAssignmentEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchAllByUserId(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchById(id: EntityId): Promise<UserRoleAssignmentEntity>;
  update(id: EntityId, request: UpdateUserRoleAssignmentRequest): Promise<UserRoleAssignmentEntity>;
  deleteById(id: EntityId): Promise<UserRoleAssignmentEntity>;

  /**
   * TASK-307 W6.1 — replaces the direct Prisma `findFirst` previously used in
   * `AuthController.login` to validate the user has at least one ENABLED role
   * assignment in the tenant key they're authenticating into. Returns the
   * matching assignment, or null when the user has no access to the tenant.
   */
  findActiveAssignmentForUserInTenant(userId: string, tenantId: string): Promise<ActiveUserRoleAssignmentRow | null>;

  /**
   * TASK-307 W6.1 — replaces the direct Prisma `findMany` previously used in
   * `AuthController.impersonate` (TASK-295 H-3) to enumerate the tenants the
   * impersonation target user has ENABLED assignments in. Returns unique
   * tenant ids in creation order (oldest first) — matches the previous
   * sortable-via-createdAt behaviour the controller depended on.
   */
  findActiveTenantIdsForUser(userId: string): Promise<string[]>;

  /**
   * TASK-307 W6.1 — replaces the direct Prisma `findMany({include: {Role}})`
   * previously used in `AuthController.getUserRoles` for JWT role / permission
   * claim construction. Returns the Role rows joined to the user's ENABLED
   * assignments, filtering null Roles defensively against stale joins.
   */
  findActiveRolesForUser(userId: string): Promise<AuthRoleSummary[]>;
}
export const IUserRoleAssignmentService = Symbol('IUserRoleAssignmentService');
