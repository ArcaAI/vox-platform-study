/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

/**
 * One line of an invoice: the plan fee, a capability's overage, or an
 * adjustment carried onto the invoice.
 *
 * A line records the FULL derivation — the usage, the allowance it was measured
 * against, the overage that fell out, and the rate applied — so a tenant
 * disputing a charge can be answered from the invoice alone, with the 18-month
 * raw ledger as the next level of evidence.
 *
 * `amountMicros` is the only non-null money field: every line contributes to the
 * invoice total, and Σ lines == total is guaranteed by rounding half-up at LINE
 * level (never at total level, which is how sums drift by a micro).
 *
 * `description` is a bounded label, never PHI and never free-form tenant input.
 */
export interface IBillingInvoiceLineEntity extends IBaseTenantEntity {
  invoiceId: string;
  kind: Enums.BillingLineKind;

  /** Null on PLAN_FEE / ADJUSTMENT lines, which are not tied to one capability. */
  capability?: Enums.AiCapability | null;
  unit?: Enums.AiUsageUnit | null;

  quantity?: Decimal.Value | null;
  includedAllowance?: Decimal.Value | null;
  overageQuantity?: Decimal.Value | null;

  unitPriceMicros?: bigint | null;
  /** Integer micros. Required — the line's contribution to the total. */
  amountMicros: bigint;

  description?: string | null;
}

export class BillingInvoiceLineEntity extends BaseTenantEntity {
  private _invoiceId: IBillingInvoiceLineEntity['invoiceId'];
  private _kind: IBillingInvoiceLineEntity['kind'];
  private _capability?: IBillingInvoiceLineEntity['capability'];
  private _unit?: IBillingInvoiceLineEntity['unit'];
  private _quantity?: IBillingInvoiceLineEntity['quantity'];
  private _includedAllowance?: IBillingInvoiceLineEntity['includedAllowance'];
  private _overageQuantity?: IBillingInvoiceLineEntity['overageQuantity'];
  private _unitPriceMicros?: IBillingInvoiceLineEntity['unitPriceMicros'];
  private _amountMicros: IBillingInvoiceLineEntity['amountMicros'];
  private _description?: IBillingInvoiceLineEntity['description'];

  constructor(init: IBillingInvoiceLineEntity) {
    super(init);
    this._invoiceId = init.invoiceId;
    this._kind = init.kind;
    this._capability = init.capability;
    this._unit = init.unit;
    this._quantity = init.quantity;
    this._includedAllowance = init.includedAllowance;
    this._overageQuantity = init.overageQuantity;
    this._unitPriceMicros = init.unitPriceMicros;
    this._amountMicros = init.amountMicros;
    this._description = init.description;
  }

  get invoiceId(): IBillingInvoiceLineEntity['invoiceId'] {
    return this._invoiceId;
  }

  set invoiceId(value: IBillingInvoiceLineEntity['invoiceId']) {
    this.setProperty('invoiceId', value);
  }

  get kind(): IBillingInvoiceLineEntity['kind'] {
    return this._kind;
  }

  set kind(value: IBillingInvoiceLineEntity['kind']) {
    this.setProperty('kind', value);
  }

  get capability(): IBillingInvoiceLineEntity['capability'] {
    return this._capability;
  }

  set capability(value: IBillingInvoiceLineEntity['capability']) {
    this.setProperty('capability', value);
  }

  get unit(): IBillingInvoiceLineEntity['unit'] {
    return this._unit;
  }

  set unit(value: IBillingInvoiceLineEntity['unit']) {
    this.setProperty('unit', value);
  }

  get quantity(): IBillingInvoiceLineEntity['quantity'] {
    return this._quantity;
  }

  set quantity(value: IBillingInvoiceLineEntity['quantity']) {
    this.setProperty('quantity', value);
  }

  get includedAllowance(): IBillingInvoiceLineEntity['includedAllowance'] {
    return this._includedAllowance;
  }

  set includedAllowance(value: IBillingInvoiceLineEntity['includedAllowance']) {
    this.setProperty('includedAllowance', value);
  }

  get overageQuantity(): IBillingInvoiceLineEntity['overageQuantity'] {
    return this._overageQuantity;
  }

  set overageQuantity(value: IBillingInvoiceLineEntity['overageQuantity']) {
    this.setProperty('overageQuantity', value);
  }

  get unitPriceMicros(): IBillingInvoiceLineEntity['unitPriceMicros'] {
    return this._unitPriceMicros;
  }

  set unitPriceMicros(value: IBillingInvoiceLineEntity['unitPriceMicros']) {
    this.setProperty('unitPriceMicros', value);
  }

  get amountMicros(): IBillingInvoiceLineEntity['amountMicros'] {
    return this._amountMicros;
  }

  set amountMicros(value: IBillingInvoiceLineEntity['amountMicros']) {
    this.setProperty('amountMicros', value);
  }

  get description(): IBillingInvoiceLineEntity['description'] {
    return this._description;
  }

  set description(value: IBillingInvoiceLineEntity['description']) {
    this.setProperty('description', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._invoiceId || this._invoiceId.trim().length === 0) {
      throw new BusinessException('BillingInvoiceLine invoiceId is required.');
    }
    if (this._kind === undefined || this._kind === null) {
      throw new BusinessException('BillingInvoiceLine kind is required.');
    }
    if (this._amountMicros === undefined || this._amountMicros === null) {
      throw new BusinessException('BillingInvoiceLine amountMicros is required.');
    }
    // Negative amounts belong on ADJUSTMENT lines only — a negative PLAN_FEE or
    // OVERAGE line means the computation inverted a subtraction somewhere, which
    // would silently credit the tenant.
    if (this._amountMicros < 0n && this._kind !== Enums.BillingLineKind.ADJUSTMENT) {
      throw new BusinessException(`BillingInvoiceLine amountMicros cannot be negative on a ${this._kind} line.`);
    }
    for (const [name, value] of [
      ['quantity', this._quantity],
      ['includedAllowance', this._includedAllowance],
      ['overageQuantity', this._overageQuantity],
    ] as const) {
      if (value !== undefined && value !== null && new Decimal(value).isNegative()) {
        throw new BusinessException(`BillingInvoiceLine ${name} cannot be negative.`);
      }
    }
  }
}
