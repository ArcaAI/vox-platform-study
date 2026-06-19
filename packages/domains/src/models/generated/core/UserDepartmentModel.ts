/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class UserDepartment extends BaseTenantDataModel {
  public isPrimary: boolean;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public userId: string;
  public departmentId: string;
  @VirtualDbProperty()
  public User: Models.User | undefined;
  @VirtualDbProperty()
  public Department: Models.Department | undefined;

  constructor(data: UserDepartment & BaseTenantDataModel) {
    super(data);
    this.isPrimary = data.isPrimary;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.userId = data.userId;
    this.departmentId = data.departmentId;
    this.User = data.User;
    this.Department = data.Department;
  }
}
