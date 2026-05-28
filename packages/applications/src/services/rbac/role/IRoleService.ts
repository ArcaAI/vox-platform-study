/**
 * TASK-307 W6.3 — `IRbacRoleService` is the controller-facing seam that
 * replaces every `databaseService.client.role.*` and
 * `databaseService.client.rolePolicy.*` call inside `RolesController`
 * (audit C-10 / F-1 / H-9). The role/role-policy mutations stayed in the
 * controller historically because there was no generated
 * `RolePolicyRepository` and no `PolicyEntity`/`PolicyMapper`. This
 * service intentionally takes the pragmatic path used by `TenantService`
 * et al. — direct `CoreDatabaseService` access at the service layer —
 * rather than generating a whole DDD slab just to satisfy the lint rule
 * in W6.4 (out of scope for a behaviour-preserving refactor; see
 * README.md §3 W6 / §7 risks).
 *
 * The name is prefixed with `Rbac` to disambiguate from the legacy
 * `services/security/role` skeleton, which is unused by the API gateway
 * (no `@Inject(IRoleService)` consumers) but still occupies the
 * `IRoleService` / `RoleService` / `RoleServiceModule` symbols in the
 * `@arcaai/applications` barrel. Renaming the legacy skeleton was
 * explicitly out of W6 scope.
 */

export interface RbacRoleListQuery {
  page: number;
  pageSize: number;
  search?: string;
}

export interface RbacRolePolicyAssignmentInput {
  /** Lower values fire first. Optional — defaults to `0` for new rows or
   *  preserves the existing priority when re-enabling a soft-deleted
   *  assignment. */
  priority?: number;
}

export interface CreateRbacRoleRequest {
  name: string;
  description?: string;
  externalName?: string;
  externalId?: string;
  parentRoleId?: string;
}

export interface UpdateRbacRoleRequest {
  name?: string;
  description?: string;
  externalName?: string;
  externalId?: string;
  parentRoleId?: string;
  /** Currently only `ENABLED` / `DISABLED` are accepted in PATCH bodies. */
  resourceStatus?: string;
}

export interface RbacRolePolicyRow {
  Policy: { id: string; name: string } | null;
  priority: number;
}

export interface RbacRoleRecord {
  id: string;
  name: string;
  description: string | null;
  externalName: string | null;
  externalId: string | null;
  isSystemRole: boolean;
  parentRoleId: string | null;
  resourceStatus: string;
  createdAt: Date;
  updatedAt: Date;
  RolePolicies: RbacRolePolicyRow[];
}

export interface RbacRoleListResult {
  data: RbacRoleRecord[];
  total: number;
}

export interface IRbacRoleService {
  findAll(query: RbacRoleListQuery): Promise<RbacRoleListResult>;
  findOne(id: string): Promise<RbacRoleRecord | null>;
  create(request: CreateRbacRoleRequest): Promise<RbacRoleRecord>;
  update(id: string, request: UpdateRbacRoleRequest): Promise<RbacRoleRecord>;
  patch(id: string, request: UpdateRbacRoleRequest): Promise<RbacRoleRecord>;
  softDelete(id: string): Promise<{ id: string; name: string }>;
  assignPolicy(roleId: string, policyId: string, dto: RbacRolePolicyAssignmentInput): Promise<void>;
  removePolicy(roleId: string, policyId: string): Promise<void>;
}

export const IRbacRoleService = Symbol('IRbacRoleService');
