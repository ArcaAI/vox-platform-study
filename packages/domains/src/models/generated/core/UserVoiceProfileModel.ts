/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel } from '../../../common';
import * as Enums from '../../../enums';

export class UserVoiceProfile extends BaseDataModel {
  public userId: string;
  public isActive: boolean;
  public label: string | null;
  public modelId: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: UserVoiceProfile & BaseDataModel) {
    super(data);
    this.userId = data.userId;
    this.isActive = data.isActive;
    this.label = data.label;
    this.modelId = data.modelId;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
