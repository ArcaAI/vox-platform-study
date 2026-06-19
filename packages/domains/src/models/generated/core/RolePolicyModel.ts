/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class RolePolicy extends BaseDataModel {
  public priority: number;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public roleId: string;
  public policyId: string;
  @VirtualDbProperty()
  public Role: Models.Role | undefined;
  @VirtualDbProperty()
  public Policy: Models.Policy | undefined;

  constructor(data: RolePolicy & BaseDataModel) {
    super(data);
    this.priority = data.priority;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.roleId = data.roleId;
    this.policyId = data.policyId;
    this.Role = data.Role;
    this.Policy = data.Policy;
  }
}
