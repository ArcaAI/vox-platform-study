/**
 * `IRbacRoleService` is the controller-facing seam that
 * replaces every `databaseService.client.role.*` and
 * `databaseService.client.rolePolicy.*` call inside `RolesController`.
 * The role/role-policy mutations stayed in the
 * controller historically because there was no generated
 * `RolePolicyRepository` and no `PolicyEntity`/`PolicyMapper`. This
 * service intentionally takes the pragmatic path used by `TenantService`
 * et al. — direct `CoreDatabaseService` access at the service layer —
 * rather than generating a whole DDD slab just to satisfy the lint rule
 * (out of scope for a behaviour-preserving refactor).
 *
 * The name is prefixed with `Rbac` to disambiguate from the legacy
 * `services/security/role` skeleton, which is unused by the API gateway
 * (no `@Inject(IRoleService)` consumers) but still occupies the
 * `IRoleService` / `RoleService` / `RoleServiceModule` symbols in the
 * `@arcaai/applications` barrel. Renaming the legacy skeleton was
 * explicitly deferred.
 */

import type { BreakGlassCredentials } from '../breakGlass';

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
  /** Only a super admin may set `true` (service-enforced). */
  isSystemRole?: boolean;
}

/** Clone always produces a new CUSTOM role, any admin may call it. */
export interface CloneRbacRoleRequest {
  name: string;
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
  /**
   * Tenant-scoped member count, present only on the read paths
   * (`findAll`/`findOne` merge the `_count` include; mutations do not).
   */
  _count?: { UserRoleAssignments: number };
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
  /** Clone a role (SYSTEM or CUSTOM) into a new CUSTOM role with copied policies. */
  clone(sourceId: string, request: CloneRbacRoleRequest): Promise<RbacRoleRecord>;
  /** Deleting a role always requires break-glass confirmation. */
  softDelete(id: string, breakGlass?: BreakGlassCredentials): Promise<{ id: string; name: string }>;
  assignPolicy(roleId: string, policyId: string, dto: RbacRolePolicyAssignmentInput): Promise<void>;
  /** Detaching a policy requires break-glass (confirm the POLICY name). */
  removePolicy(roleId: string, policyId: string, breakGlass?: BreakGlassCredentials): Promise<void>;
}

export const IRbacRoleService = Symbol('IRbacRoleService');
