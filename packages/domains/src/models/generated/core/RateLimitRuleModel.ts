/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class RateLimitRule extends BaseTenantDataModel {
  public routeMatch: string;
  public matchKind: Enums.RateLimitMatchKind;
  public limitValue: number;
  public windowMs: number;
  public active: boolean;
  public description: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: RateLimitRule & BaseTenantDataModel) {
    super(data);
    this.routeMatch = data.routeMatch;
    this.matchKind = data.matchKind;
    this.limitValue = data.limitValue;
    this.windowMs = data.windowMs;
    this.active = data.active;
    this.description = data.description;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
