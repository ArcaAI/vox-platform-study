/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import * as Enums from '../../../enums';
import * as Models from './';

export class UserDepartment extends BaseTenantDataModel {
  public isPrimary: boolean;
  public userId: string;
  public departmentId: string;

  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: UserDepartment & BaseTenantDataModel) {
    super(data);
    this.isPrimary = data.isPrimary;
    this.userId = data.userId;
    this.departmentId = data.departmentId;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
