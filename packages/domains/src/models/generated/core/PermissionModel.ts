/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Permission extends BaseDataModel {
  public name: string;
  public description: string | null;
  public permissionAction: Enums.PermissionAction;
  public resourceTypeName: string;
  public conditions: JsonValue | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public RolePermissions: Models.RolePermission[] | undefined;

  constructor(data: Permission & BaseDataModel) {
    super(data);
    this.name = data.name;
    this.description = data.description;
    this.permissionAction = data.permissionAction;
    this.resourceTypeName = data.resourceTypeName;
    this.conditions = data.conditions;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.RolePermissions = data.RolePermissions;
  }
}
