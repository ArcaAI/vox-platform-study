/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantSttConfig extends BaseTenantDataModel {
  public fallbackPipelineId: string | null;
  public autoSwitchEnabled: boolean;
  public configJson: JsonValue | null;
  public taskKind: Enums.AiTaskKind;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: TenantSttConfig & BaseTenantDataModel) {
    super(data);
    this.fallbackPipelineId = data.fallbackPipelineId;
    this.autoSwitchEnabled = data.autoSwitchEnabled;
    this.configJson = data.configJson;
    this.taskKind = data.taskKind;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
