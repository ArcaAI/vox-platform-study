/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class BillingInvoiceLine extends BaseTenantDataModel {
  public invoiceId: string;
  public kind: Enums.BillingLineKind;
  public capability: Enums.AiCapability | null;
  public unit: Enums.AiUsageUnit | null;
  public quantity: Decimal | null;
  public includedAllowance: Decimal | null;
  public overageQuantity: Decimal | null;
  public unitPriceMicros: bigint | null;
  public amountMicros: bigint;
  public description: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public BillingInvoice: Models.BillingInvoice | undefined;

  constructor(data: BillingInvoiceLine & BaseTenantDataModel) {
    super(data);
    this.invoiceId = data.invoiceId;
    this.kind = data.kind;
    this.capability = data.capability;
    this.unit = data.unit;
    this.quantity = data.quantity;
    this.includedAllowance = data.includedAllowance;
    this.overageQuantity = data.overageQuantity;
    this.unitPriceMicros = data.unitPriceMicros;
    this.amountMicros = data.amountMicros;
    this.description = data.description;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.BillingInvoice = data.BillingInvoice;
  }
}
