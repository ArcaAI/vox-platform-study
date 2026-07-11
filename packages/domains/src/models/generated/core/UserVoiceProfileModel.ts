/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class UserVoiceProfile extends BaseTenantDataModel {
  public userId: string;
  public isActive: boolean;
  public label: string | null;
  public modelId: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public User: Models.User | undefined;

  constructor(data: UserVoiceProfile & BaseTenantDataModel) {
    super(data);
    this.userId = data.userId;
    this.isActive = data.isActive;
    this.label = data.label;
    this.modelId = data.modelId;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.User = data.User;
  }
}
