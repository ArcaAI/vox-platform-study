/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { BillingInvoiceLineEntity, IBillingInvoiceLineEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateBillingInvoiceLineProps extends BaseEntityFactoryCreateProps {
  tenantId: IBillingInvoiceLineEntity['tenantId'];
  invoiceId: IBillingInvoiceLineEntity['invoiceId'];
  kind: IBillingInvoiceLineEntity['kind'];

  capability?: IBillingInvoiceLineEntity['capability'];
  unit?: IBillingInvoiceLineEntity['unit'];

  quantity?: IBillingInvoiceLineEntity['quantity'];
  includedAllowance?: IBillingInvoiceLineEntity['includedAllowance'];
  overageQuantity?: IBillingInvoiceLineEntity['overageQuantity'];

  unitPriceMicros?: IBillingInvoiceLineEntity['unitPriceMicros'];
  amountMicros: IBillingInvoiceLineEntity['amountMicros'];

  description?: IBillingInvoiceLineEntity['description'];

  createdAt?: IBillingInvoiceLineEntity['createdAt'];
  updatedAt?: IBillingInvoiceLineEntity['updatedAt'];
  createdBy?: IBillingInvoiceLineEntity['createdBy'];
  updatedBy?: IBillingInvoiceLineEntity['updatedBy'];
}

export class BillingInvoiceLineFactory {
  /**
   * Build one invoice line. `amountMicros` is required and every derivation
   * field is optional, because their presence depends on `kind`: a PLAN_FEE line
   * has an amount and nothing else, while an OVERAGE line carries the full
   * quantity → allowance → overage → rate → amount chain.
   */
  static CreateBillingInvoiceLine(props: CreateBillingInvoiceLineProps): BillingInvoiceLineEntity {
    const id = generateId();
    const now = new Date();

    return new BillingInvoiceLineEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      invoiceId: props.invoiceId,
      kind: props.kind,

      capability: props.capability ?? null,
      unit: props.unit ?? null,

      quantity: props.quantity ?? null,
      includedAllowance: props.includedAllowance ?? null,
      overageQuantity: props.overageQuantity ?? null,

      unitPriceMicros: props.unitPriceMicros ?? null,
      amountMicros: props.amountMicros,

      description: props.description ?? null,
    });
  }
}
