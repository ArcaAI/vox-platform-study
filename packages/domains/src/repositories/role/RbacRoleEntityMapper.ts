/**
 * TASK-311 AC-2 — `RbacRoleEntityMapper` projects a Prisma `Role` row
 * (with the `RolePolicies` include) onto the structural
 * `RbacRoleRecord` shape that `RbacRoleService` returns. The
 * `ROLE_POLICIES_INCLUDE` constant is the SINGLE source of truth for
 * the role-policy join shape used by every read site —
 * `findByIdWithPolicies` and `update`/`patch`'s `include` argument.
 *
 * Pinned by `RbacRoleEntityMapper.test.ts` so any future schema/include
 * drift fails fast.
 */
import { ResourceStatusType } from '../../enums';

export const ROLE_POLICIES_INCLUDE = {
  RolePolicies: {
    where: { resourceStatus: ResourceStatusType.ENABLED },
    include: { Policy: { select: { id: true, name: true } } },
    orderBy: { priority: 'asc' as const },
  },
} as const;

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

export interface RoleRowLike {
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
  RolePolicies?: RbacRolePolicyRow[];
}

export function mapRoleRowToRecord(row: RoleRowLike): RbacRoleRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    externalName: row.externalName,
    externalId: row.externalId,
    isSystemRole: row.isSystemRole,
    parentRoleId: row.parentRoleId,
    resourceStatus: row.resourceStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    RolePolicies: row.RolePolicies ?? [],
  };
}
