/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AiUsageRollupDaily extends BaseTenantDataModel {
  public bucketStart: Date;
  public capability: Enums.AiCapability;
  public operation: string;
  public provider: string;
  public model: string;
  public unit: Enums.AiUsageUnit;
  public quantitySum: Decimal;
  public costMicrosSum: bigint;

  constructor(data: AiUsageRollupDaily & BaseTenantDataModel) {
    super(data);
    this.bucketStart = data.bucketStart;
    this.capability = data.capability;
    this.operation = data.operation;
    this.provider = data.provider;
    this.model = data.model;
    this.unit = data.unit;
    this.quantitySum = data.quantitySum;
    this.costMicrosSum = data.costMicrosSum;
  }
}
