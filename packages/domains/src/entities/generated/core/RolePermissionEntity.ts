/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseEntity, IBaseEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IRolePermissionEntity extends Omit<IBaseEntity, 'tenantId'> {
  roleId: string;
  Role: Entities.RoleEntity | null;
  permissionId: string;
  Permission: Entities.PermissionEntity | null;
}

export class RolePermissionEntity extends BaseEntity {
  private _roleId: IRolePermissionEntity['roleId'];
  private _Role: IRolePermissionEntity['Role'];
  private _permissionId: IRolePermissionEntity['permissionId'];
  private _Permission: IRolePermissionEntity['Permission'];

  constructor(init: IRolePermissionEntity) {
    super(init);
    this._roleId = init.roleId;
    this._Role = init.Role;
    this._permissionId = init.permissionId;
    this._Permission = init.Permission;
  }

  get roleId(): IRolePermissionEntity['roleId'] {
    return this._roleId;
  }

  set roleId(value: IRolePermissionEntity['roleId']) {
    this.setProperty('roleId', value);
  }

  get Role(): IRolePermissionEntity['Role'] {
    return this._Role;
  }

  set Role(value: IRolePermissionEntity['Role']) {
    this.setProperty('Role', value);
  }

  get permissionId(): IRolePermissionEntity['permissionId'] {
    return this._permissionId;
  }

  set permissionId(value: IRolePermissionEntity['permissionId']) {
    this.setProperty('permissionId', value);
  }

  get Permission(): IRolePermissionEntity['Permission'] {
    return this._Permission;
  }

  set Permission(value: IRolePermissionEntity['Permission']) {
    this.setProperty('Permission', value);
  }

  public override validate(): void {
    throw new BusinessException('Method not implemented.');
  }
}
