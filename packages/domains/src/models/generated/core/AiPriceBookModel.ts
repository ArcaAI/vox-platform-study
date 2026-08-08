/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AiPriceBook extends BaseTenantDataModel {
  public plane: Enums.AiPriceBookPlane;
  public rowKind: Enums.AiPriceRowKind;
  public planTier: Enums.TenantPlan | null;
  public capability: Enums.AiCapability | null;
  public provider: string | null;
  public model: string | null;
  public unit: Enums.AiUsageUnit | null;
  public contextBand: string | null;
  public cacheTtl: string | null;
  public currency: string;
  public unitPriceMicros: bigint;
  public effectiveFrom: Date;
  public effectiveTo: Date | null;
  public bookVersion: string;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: AiPriceBook & BaseTenantDataModel) {
    super(data);
    this.plane = data.plane;
    this.rowKind = data.rowKind;
    this.planTier = data.planTier;
    this.capability = data.capability;
    this.provider = data.provider;
    this.model = data.model;
    this.unit = data.unit;
    this.contextBand = data.contextBand;
    this.cacheTtl = data.cacheTtl;
    this.currency = data.currency;
    this.unitPriceMicros = data.unitPriceMicros;
    this.effectiveFrom = data.effectiveFrom;
    this.effectiveTo = data.effectiveTo;
    this.bookVersion = data.bookVersion;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
