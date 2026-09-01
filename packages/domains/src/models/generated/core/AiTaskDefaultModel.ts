/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AiTaskDefault extends BaseTenantDataModel {
  public taskKey: string;
  public modelSlug: string;
  public configJson: JsonValue | null;
  public taskKind: Enums.AiTaskKind | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: AiTaskDefault & BaseTenantDataModel) {
    super(data);
    this.taskKey = data.taskKey;
    this.modelSlug = data.modelSlug;
    this.configJson = data.configJson;
    this.taskKind = data.taskKind;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
