/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * TASK-766 OD-1: `Role` gained a real `tenantId` column, so this interface
 * extends `IBaseTenantEntity` instead of the former
 * `Omit<IBaseEntity, 'tenantId'>` — the `Omit` was there precisely because
 * `Role` used to be a global table. SYSTEM-tenant rows are the platform's
 * built-in roles; a customer tenant's rows are its own custom roles. See the
 * comment on `Role.tenantId` in `rbac.prisma`.
 */
export interface IRoleEntity extends IBaseTenantEntity {
  name: string;
  description?: string | null;
  externalName?: string | null;
  externalId?: string | null;
  RolePermissions?: Entities.RolePermissionEntity[] | null;
  UserRoleAssignment?: Entities.UserRoleAssignmentEntity | null;
  userRoleAssignmentId?: string | null;
}

export class RoleEntity extends BaseTenantEntity {
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
    // Mandatory: BaseTenantEntity.validate() is the runtime backstop for the
    // schema-level NOT NULL on tenantId. Overriding without calling it would
    // silently bypass the tenant guard.
    super.validate();
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('Role name is required.');
    }
    if (this._name.length > 255) {
      throw new BusinessException('Role name must not exceed 255 characters.');
    }
    if (this._description && this._description.length > 1000) {
      throw new BusinessException('Role description must not exceed 1000 characters.');
    }
    if (this._externalName && this._externalName.length > 255) {
      throw new BusinessException('Role externalName must not exceed 255 characters.');
    }
    if (this._externalId && this._externalId.length > 255) {
      throw new BusinessException('Role externalId must not exceed 255 characters.');
    }
  }
}
