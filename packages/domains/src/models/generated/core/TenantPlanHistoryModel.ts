/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantPlanHistory extends BaseTenantDataModel {
  public plan: Enums.TenantPlan;
  public effectiveFrom: Date;
  public effectiveTo: Date | null;
  public previousPlan: Enums.TenantPlan | null;
  public changeReason: string | null;

  constructor(data: TenantPlanHistory & BaseTenantDataModel) {
    super(data);
    this.plan = data.plan;
    this.effectiveFrom = data.effectiveFrom;
    this.effectiveTo = data.effectiveTo;
    this.previousPlan = data.previousPlan;
    this.changeReason = data.changeReason;
  }
}
