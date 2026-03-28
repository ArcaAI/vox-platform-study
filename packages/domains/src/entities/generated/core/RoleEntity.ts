/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseEntity, IBaseEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IRoleEntity extends Omit<IBaseEntity, 'tenantId'> {
  name: string;
  description?: string | null;
  externalName?: string | null;
  externalId?: string | null;
  RolePermissions?: Entities.RolePermissionEntity[] | null;
  UserRoleAssignment?: Entities.UserRoleAssignmentEntity | null;
  userRoleAssignmentId?: string | null;
}

export class RoleEntity extends BaseEntity {
  private _name: IRoleEntity['name'];
  private _description?: IRoleEntity['description'];
  private _externalName?: IRoleEntity['externalName'];
  private _externalId?: IRoleEntity['externalId'];
  private _RolePermissions?: IRoleEntity['RolePermissions'];
  private _UserRoleAssignment?: IRoleEntity['UserRoleAssignment'];
  private _userRoleAssignmentId?: IRoleEntity['userRoleAssignmentId'];

  constructor(init: IRoleEntity) {
    super(init);
    this._name = init.name;
    this._description = init.description;
    this._externalName = init.externalName;
    this._externalId = init.externalId;
    this._RolePermissions = init.RolePermissions;
    this._UserRoleAssignment = init.UserRoleAssignment;
    this._userRoleAssignmentId = init.userRoleAssignmentId;
  }

  get name(): IRoleEntity['name'] {
    return this._name;
  }

  set name(value: IRoleEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IRoleEntity['description'] {
    return this._description;
  }

  set description(value: IRoleEntity['description']) {
    this.setProperty('description', value);
  }

  get externalName(): IRoleEntity['externalName'] {
    return this._externalName;
  }

  set externalName(value: IRoleEntity['externalName']) {
    this.setProperty('externalName', value);
  }

  get externalId(): IRoleEntity['externalId'] {
    return this._externalId;
  }

  set externalId(value: IRoleEntity['externalId']) {
    this.setProperty('externalId', value);
  }

  get RolePermissions(): IRoleEntity['RolePermissions'] {
    return this._RolePermissions;
  }

  set RolePermissions(value: IRoleEntity['RolePermissions']) {
    this.setProperty('RolePermissions', value);
  }

  get UserRoleAssignment(): IRoleEntity['UserRoleAssignment'] {
    return this._UserRoleAssignment;
  }

  set UserRoleAssignment(value: IRoleEntity['UserRoleAssignment']) {
    this.setProperty('UserRoleAssignment', value);
  }

  get userRoleAssignmentId(): IRoleEntity['userRoleAssignmentId'] {
    return this._userRoleAssignmentId;
  }

  set userRoleAssignmentId(value: IRoleEntity['userRoleAssignmentId']) {
    this.setProperty('userRoleAssignmentId', value);
  }

  public override validate(): void {
    throw new BusinessException('Method not implemented.');
  }
}
