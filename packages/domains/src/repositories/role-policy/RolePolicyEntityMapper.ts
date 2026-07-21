/**
 * `RolePolicyEntityMapper` provides a strict
 * projection from a Prisma `RolePolicy` row to a stable record shape.
 *
 * Today `RbacRoleService.assignPolicy/removePolicy` does not return
 * the join row to its caller — both methods return `Promise<void>`.
 * The mapper still lives here, exercised by unit tests, so the
 * projection contract is pinned for any future consumer (e.g. a
 * "list policies on this role" endpoint).
 */

export interface RolePolicyRecord {
  id: string;
  roleId: string;
  policyId: string;
  priority: number;
  resourceStatus: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RolePolicyRowLike {
  id: string;
  roleId: string;
  policyId: string;
  priority: number;
  resourceStatus: string;
  createdAt: Date;
  updatedAt: Date;
}

export function mapRolePolicyRowToRecord(row: RolePolicyRowLike): RolePolicyRecord {
  return {
    id: row.id,
    roleId: row.roleId,
    policyId: row.policyId,
    priority: row.priority,
    resourceStatus: row.resourceStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
