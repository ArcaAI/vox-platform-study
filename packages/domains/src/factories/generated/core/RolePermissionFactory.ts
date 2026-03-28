/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { RolePermissionEntity, IRolePermissionEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateRolePermissionProps extends BaseEntityFactoryCreateProps {
  roleId: IRolePermissionEntity['roleId'];
  Role?: IRolePermissionEntity['Role'];
  permissionId: IRolePermissionEntity['permissionId'];
  Permission?: IRolePermissionEntity['Permission'];

  createdAt?: IRolePermissionEntity['createdAt'];
  updatedAt?: IRolePermissionEntity['updatedAt'];
  createdBy?: IRolePermissionEntity['createdBy'];
  updatedBy?: IRolePermissionEntity['updatedBy'];
}

export class RolePermissionFactory {
  static CreateRolePermission(props: CreateRolePermissionProps): RolePermissionEntity {
    const id = generateId();
    const now = new Date();

    return new RolePermissionEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      roleId: props.roleId,
      Role: props.Role ?? null,
      permissionId: props.permissionId,
      Permission: props.Permission ?? null,
    });
  }
}
