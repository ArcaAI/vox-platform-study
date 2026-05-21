/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { UserRoleAssignmentEntity, IUserRoleAssignmentEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateUserRoleAssignmentProps extends BaseEntityFactoryCreateProps {
  userId: IUserRoleAssignmentEntity['userId'];
  roleId: IUserRoleAssignmentEntity['roleId'];
  User?: IUserRoleAssignmentEntity['User'];
  Roles?: IUserRoleAssignmentEntity['Roles'];
  tenantId?: IUserRoleAssignmentEntity['tenantId'];
  Tenant?: IUserRoleAssignmentEntity['Tenant'];

  createdAt?: IUserRoleAssignmentEntity['createdAt'];
  updatedAt?: IUserRoleAssignmentEntity['updatedAt'];
  createdBy?: IUserRoleAssignmentEntity['createdBy'];
  updatedBy?: IUserRoleAssignmentEntity['updatedBy'];
}

export class UserRoleAssignmentFactory {
  static CreateUserRoleAssignment(props: CreateUserRoleAssignmentProps): UserRoleAssignmentEntity {
    const id = generateId();
    const now = new Date();

    return new UserRoleAssignmentEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      userId: props.userId,
      roleId: props.roleId,
      User: props.User ?? null,
      Roles: props.Roles ?? [],
      tenantId: props.tenantId ?? null,
      Tenant: props.Tenant ?? null,
    });
  }
}
