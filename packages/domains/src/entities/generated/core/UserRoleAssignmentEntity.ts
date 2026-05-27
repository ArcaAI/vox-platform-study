/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IUserRoleAssignmentEntity extends IBaseTenantEntity {
  userId: string;
  roleId: string;
  User: Entities.UserEntity | null;
  Roles?: Entities.RoleEntity[] | null;
}

export class UserRoleAssignmentEntity extends BaseTenantEntity {
  private _userId: IUserRoleAssignmentEntity['userId'];
  private _roleId: IUserRoleAssignmentEntity['roleId'];
  private _User: IUserRoleAssignmentEntity['User'];
  private _Roles?: IUserRoleAssignmentEntity['Roles'];

  constructor(init: IUserRoleAssignmentEntity) {
    super(init);
    this._userId = init.userId;
    this._roleId = init.roleId;
    this._User = init.User;
    this._Roles = init.Roles;
  }

  get userId(): IUserRoleAssignmentEntity['userId'] {
    return this._userId;
  }

  set userId(value: IUserRoleAssignmentEntity['userId']) {
    this.setProperty('userId', value);
  }

  get roleId(): IUserRoleAssignmentEntity['roleId'] {
    return this._roleId;
  }

  set roleId(value: IUserRoleAssignmentEntity['roleId']) {
    this.setProperty('roleId', value);
  }

  get User(): IUserRoleAssignmentEntity['User'] {
    return this._User;
  }

  set User(value: IUserRoleAssignmentEntity['User']) {
    this.setProperty('User', value);
  }

  get Roles(): IUserRoleAssignmentEntity['Roles'] {
    return this._Roles;
  }

  set Roles(value: IUserRoleAssignmentEntity['Roles']) {
    this.setProperty('Roles', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._userId || this._userId.trim().length === 0) {
      throw new BusinessException('UserRoleAssignment userId is required.');
    }
    if (!this._roleId || this._roleId.trim().length === 0) {
      throw new BusinessException('UserRoleAssignment roleId is required.');
    }
  }
}
