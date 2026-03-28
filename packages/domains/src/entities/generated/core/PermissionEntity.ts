/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseEntity, IBaseEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IPermissionEntity extends Omit<IBaseEntity, 'tenantId'> {
  name: string;
  description?: string | null;
  permissionAction: Enums.PermissionAction;
  resourceTypeName: string;
  conditions?: JsonValue | null;
  RolePermissions?: Entities.RolePermissionEntity[] | null;
}

export class PermissionEntity extends BaseEntity {
  private _name: IPermissionEntity['name'];
  private _description?: IPermissionEntity['description'];
  private _permissionAction: IPermissionEntity['permissionAction'];
  private _resourceTypeName: IPermissionEntity['resourceTypeName'];
  private _conditions?: IPermissionEntity['conditions'];
  private _RolePermissions?: IPermissionEntity['RolePermissions'];

  constructor(init: IPermissionEntity) {
    super(init);
    this._name = init.name;
    this._description = init.description;
    this._permissionAction = init.permissionAction;
    this._resourceTypeName = init.resourceTypeName;
    this._conditions = init.conditions;
    this._RolePermissions = init.RolePermissions;
  }

  get name(): IPermissionEntity['name'] {
    return this._name;
  }

  set name(value: IPermissionEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IPermissionEntity['description'] {
    return this._description;
  }

  set description(value: IPermissionEntity['description']) {
    this.setProperty('description', value);
  }

  get permissionAction(): IPermissionEntity['permissionAction'] {
    return this._permissionAction;
  }

  set permissionAction(value: IPermissionEntity['permissionAction']) {
    this.setProperty('permissionAction', value);
  }

  get resourceTypeName(): IPermissionEntity['resourceTypeName'] {
    return this._resourceTypeName;
  }

  set resourceTypeName(value: IPermissionEntity['resourceTypeName']) {
    this.setProperty('resourceTypeName', value);
  }

  get conditions(): IPermissionEntity['conditions'] {
    return this._conditions;
  }

  set conditions(value: IPermissionEntity['conditions']) {
    this.setProperty('conditions', value);
  }

  get RolePermissions(): IPermissionEntity['RolePermissions'] {
    return this._RolePermissions;
  }

  set RolePermissions(value: IPermissionEntity['RolePermissions']) {
    this.setProperty('RolePermissions', value);
  }

  public override validate(): void {
    throw new BusinessException('Method not implemented.');
  }
}
