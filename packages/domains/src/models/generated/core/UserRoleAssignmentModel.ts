/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class UserRoleAssignment extends BaseTenantDataModel {
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public userId: string;
  public roleId: string;
  @VirtualDbProperty()
  public User: Models.User | undefined;
  @VirtualDbProperty()
  public Roles: Models.Role[] | undefined;

  constructor(data: UserRoleAssignment & BaseTenantDataModel) {
    super(data);
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.userId = data.userId;
    this.roleId = data.roleId;
    this.User = data.User;
    this.Roles = data.Roles;
  }
}
