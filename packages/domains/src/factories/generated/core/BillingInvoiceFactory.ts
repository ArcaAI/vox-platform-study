/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { BillingInvoiceEntity, IBillingInvoiceEntity } from '../../../entities';
import { BillingInvoiceStatus } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateBillingInvoiceProps extends BaseEntityFactoryCreateProps {
  tenantId: IBillingInvoiceEntity['tenantId'];
  periodStart: IBillingInvoiceEntity['periodStart'];
  periodEnd: IBillingInvoiceEntity['periodEnd'];

  status?: IBillingInvoiceEntity['status'];
  currency?: IBillingInvoiceEntity['currency'];
  subtotalMicros?: IBillingInvoiceEntity['subtotalMicros'];
  totalMicros?: IBillingInvoiceEntity['totalMicros'];

  createdAt?: IBillingInvoiceEntity['createdAt'];
  updatedAt?: IBillingInvoiceEntity['updatedAt'];
  createdBy?: IBillingInvoiceEntity['createdBy'];
  updatedBy?: IBillingInvoiceEntity['updatedBy'];
}

export class BillingInvoiceFactory {
  /**
   * Build a DRAFT invoice for a period.
   *
   * A new invoice is ALWAYS a draft with zero totals — `finalizedAt`/
   * `finalizedBy` are not factory inputs at all, so the only way to close a
   * period is `entity.finalize()`, which stamps status and both fields together.
   * That removes the "constructed as already finalized" path entirely.
   */
  static CreateBillingInvoice(props: CreateBillingInvoiceProps): BillingInvoiceEntity {
    const id = generateId();
    const now = new Date();

    return new BillingInvoiceEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      periodStart: props.periodStart,
      periodEnd: props.periodEnd,

      status: props.status ?? BillingInvoiceStatus.DRAFT,
      currency: props.currency ?? 'USD',
      subtotalMicros: props.subtotalMicros ?? 0n,
      totalMicros: props.totalMicros ?? 0n,

      finalizedAt: null,
      finalizedBy: null,
    });
  }
}
