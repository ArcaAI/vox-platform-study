/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class BillingAdjustment extends BaseTenantDataModel {
  public invoiceId: string;
  public reason: string;
  public amountMicros: bigint;
  @VirtualDbProperty()
  public BillingInvoice: Models.BillingInvoice | undefined;

  constructor(data: BillingAdjustment & BaseTenantDataModel) {
    super(data);
    this.invoiceId = data.invoiceId;
    this.reason = data.reason;
    this.amountMicros = data.amountMicros;
    this.BillingInvoice = data.BillingInvoice;
  }
}
