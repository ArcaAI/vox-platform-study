/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { RoleEntity, IRoleEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateRoleProps extends BaseEntityFactoryCreateProps {
  /**
   * TASK-766 OD-1 — REQUIRED, with no default. `Role` is tenant-scoped now, so
   * every caller must state which tenant owns the row: `SYSTEM_TENANT_ID` for a
   * platform/built-in role, the caller's own tenant for a custom one. Defaulting
   * it here would silently mint SYSTEM roles from tenant code paths.
   */
  tenantId: IRoleEntity['tenantId'];
  name: IRoleEntity['name'];
  description?: IRoleEntity['description'];
  externalName?: IRoleEntity['externalName'];
  externalId?: IRoleEntity['externalId'];
  RolePermissions?: IRoleEntity['RolePermissions'];
  UserRoleAssignment?: IRoleEntity['UserRoleAssignment'];
  userRoleAssignmentId?: IRoleEntity['userRoleAssignmentId'];

  createdAt?: IRoleEntity['createdAt'];
  updatedAt?: IRoleEntity['updatedAt'];
  createdBy?: IRoleEntity['createdBy'];
  updatedBy?: IRoleEntity['updatedBy'];
}

export class RoleFactory {
  static CreateRole(props: CreateRoleProps): RoleEntity {
    const id = generateId();
    const now = new Date();

    return new RoleEntity({
      id,
      tenantId: props.tenantId,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      name: props.name,
      description: props.description ?? '',
      externalName: props.externalName ?? '',
      externalId: props.externalId ?? '',
      RolePermissions: props.RolePermissions ?? [],
      UserRoleAssignment: props.UserRoleAssignment ?? null,
      userRoleAssignmentId: props.userRoleAssignmentId ?? '',
    });
  }
}
