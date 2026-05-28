/**
 * TASK-311 AC-2 — `RolePolicyFactory` centralises the Prisma input
 * shape for the `RolePolicy` join-table mutations that
 * `RbacRoleService.assignPolicy` performs. Same simplification
 * rationale as the other two factories (see README §4.3 D-2).
 */
import { ResourceStatusType } from '../../enums';

export interface RolePolicyCreateProps {
  roleId: string;
  policyId: string;
  priority: number;
  createdBy?: string;
}

export interface RolePolicyReEnableProps {
  priority: number;
  updatedBy?: string;
}

export interface RolePolicyCreateInputShape {
  roleId: string;
  policyId: string;
  priority: number;
  resourceStatus: ResourceStatusType;
  createdBy?: string;
}

export interface RolePolicyReEnableInputShape {
  priority: number;
  resourceStatus: ResourceStatusType;
  updatedBy?: string;
}

export const RolePolicyFactory = {
  buildCreateInput(props: RolePolicyCreateProps): RolePolicyCreateInputShape {
    return {
      roleId: props.roleId,
      policyId: props.policyId,
      priority: props.priority,
      resourceStatus: ResourceStatusType.ENABLED,
      createdBy: props.createdBy,
    };
  },

  buildReEnableInput(props: RolePolicyReEnableProps): RolePolicyReEnableInputShape {
    return {
      priority: props.priority,
      resourceStatus: ResourceStatusType.ENABLED,
      updatedBy: props.updatedBy,
    };
  },
} as const;
