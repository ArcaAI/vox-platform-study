/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantUsageMeter extends BaseTenantDataModel {
  public metric: Enums.UsageMeterMetric;
  public periodStart: Date;
  public periodEnd: Date;
  public usedCount: number;
  public reconciledAt: Date | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: TenantUsageMeter & BaseTenantDataModel) {
    super(data);
    this.metric = data.metric;
    this.periodStart = data.periodStart;
    this.periodEnd = data.periodEnd;
    this.usedCount = data.usedCount;
    this.reconciledAt = data.reconciledAt;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
