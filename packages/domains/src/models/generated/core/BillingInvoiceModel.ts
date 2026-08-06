/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class BillingInvoice extends BaseTenantDataModel {
  public periodStart: Date;
  public periodEnd: Date;
  public status: Enums.BillingInvoiceStatus;
  public currency: string;
  public subtotalMicros: bigint;
  public totalMicros: bigint;
  public finalizedAt: Date | null;
  public finalizedBy: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public Lines: Models.BillingInvoiceLine[] | undefined;
  @VirtualDbProperty()
  public Adjustments: Models.BillingAdjustment[] | undefined;

  constructor(data: BillingInvoice & BaseTenantDataModel) {
    super(data);
    this.periodStart = data.periodStart;
    this.periodEnd = data.periodEnd;
    this.status = data.status;
    this.currency = data.currency;
    this.subtotalMicros = data.subtotalMicros;
    this.totalMicros = data.totalMicros;
    this.finalizedAt = data.finalizedAt;
    this.finalizedBy = data.finalizedBy;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.Lines = data.Lines;
    this.Adjustments = data.Adjustments;
  }
}
