/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { BillingAdjustmentEntity, IBillingAdjustmentEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateBillingAdjustmentProps extends BaseEntityFactoryCreateProps {
  tenantId: IBillingAdjustmentEntity['tenantId'];
  invoiceId: IBillingAdjustmentEntity['invoiceId'];
  reason: IBillingAdjustmentEntity['reason'];
  /** Integer micros; NEGATIVE = credit (the common case). */
  amountMicros: IBillingAdjustmentEntity['amountMicros'];

  createdAt?: IBillingAdjustmentEntity['createdAt'];
  createdBy?: IBillingAdjustmentEntity['createdBy'];
}

export class BillingAdjustmentFactory {
  /**
   * Build one credit/debit memo. Append-only: no sys-event is published here
   * (the application service broadcasts `ResourceCreated` after a successful
   * persist, per the house convention that events follow persistence).
   */
  static CreateBillingAdjustment(props: CreateBillingAdjustmentProps): BillingAdjustmentEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new BillingAdjustmentEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      invoiceId: props.invoiceId,
      reason: props.reason,
      amountMicros: props.amountMicros,
    });
  }
}
