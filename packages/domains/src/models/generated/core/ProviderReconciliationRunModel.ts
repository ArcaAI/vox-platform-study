/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ProviderReconciliationRun extends BaseTenantDataModel {
  public provider: string;
  public windowStart: Date;
  public windowEnd: Date;
  public windowLabel: string;
  public status: string;
  public reason: string | null;
  public ledgerQuantity: Decimal | null;
  public providerQuantity: Decimal | null;
  public providerUnit: string | null;
  public relativeDrift: Decimal | null;
  public breachedThreshold: boolean;
  public thresholdPct: number;
  public runAt: Date;

  constructor(data: ProviderReconciliationRun & BaseTenantDataModel) {
    super(data);
    this.provider = data.provider;
    this.windowStart = data.windowStart;
    this.windowEnd = data.windowEnd;
    this.windowLabel = data.windowLabel;
    this.status = data.status;
    this.reason = data.reason;
    this.ledgerQuantity = data.ledgerQuantity;
    this.providerQuantity = data.providerQuantity;
    this.providerUnit = data.providerUnit;
    this.relativeDrift = data.relativeDrift;
    this.breachedThreshold = data.breachedThreshold;
    this.thresholdPct = data.thresholdPct;
    this.runAt = data.runAt;
  }
}
