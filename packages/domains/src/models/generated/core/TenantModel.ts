/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Tenant extends BaseDataModel {
  public name: string;
  public key: string;
  public description: string | null;
  public plan: Enums.TenantPlan | null;
  public trialEndsAt: Date | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];

  constructor(data: Tenant & BaseDataModel) {
    super(data);
    this.name = data.name;
    this.key = data.key;
    this.description = data.description;
    this.plan = data.plan;
    this.trialEndsAt = data.trialEndsAt;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags;
  }
}
