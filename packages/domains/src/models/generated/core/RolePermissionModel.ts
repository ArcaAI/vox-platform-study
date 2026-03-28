/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class RolePermission extends BaseDataModel {
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public roleId: string;
  public permissionId: string;
  @VirtualDbProperty()
  public Role: Models.Role | undefined;
  @VirtualDbProperty()
  public Permission: Models.Permission | undefined;

  constructor(data: RolePermission & BaseDataModel) {
    super(data);
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.roleId = data.roleId;
    this.permissionId = data.permissionId;
    this.Role = data.Role;
    this.Permission = data.Permission;
  }
}
