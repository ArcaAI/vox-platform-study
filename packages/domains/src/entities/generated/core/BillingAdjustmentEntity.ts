/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

/**
 * A credit (or debit) memo against an invoice — the ONLY way to correct a
 * FINALIZED period (D13).
 *
 * APPEND-ONLY: no `resourceStatus` column, listed in MODELS_WITHOUT_SOFT_DELETE,
 * so `softDelete()`/`restore()` throw. Retracting an adjustment by deleting it
 * would rewrite a closed period; the correction path is another adjustment.
 * Unlike its append-only siblings in the metering plane this model DOES emit
 * sys-events (`ResourceType.BillingAdjustment`) — issuing a credit is a
 * financial control point and belongs in the audit trail.
 *
 * SIGN CONVENTION: `amountMicros` is NEGATIVE for a credit (the common case) and
 * positive for a debit, so `BillingInvoice.totalMicros` just adds them and the
 * arithmetic has no special cases.
 *
 * `reason` is a bounded reason CODE, not prose — it keeps the plane PHI-free and
 * the reasons aggregatable ("how much did we credit for metering corrections
 * last quarter?").
 */
export interface IBillingAdjustmentEntity extends IBaseTenantEntity {
  invoiceId: string;
  /** Bounded code, e.g. `goodwill_credit`, `metering_correction`, `sla_credit`. */
  reason: string;
  /** Integer micros; negative = credit. */
  amountMicros: bigint;
}

export class BillingAdjustmentEntity extends BaseTenantEntity {
  private _invoiceId: IBillingAdjustmentEntity['invoiceId'];
  private _reason: IBillingAdjustmentEntity['reason'];
  private _amountMicros: IBillingAdjustmentEntity['amountMicros'];

  constructor(init: IBillingAdjustmentEntity) {
    super(init);
    this._invoiceId = init.invoiceId;
    this._reason = init.reason;
    this._amountMicros = init.amountMicros;
  }

  get invoiceId(): IBillingAdjustmentEntity['invoiceId'] {
    return this._invoiceId;
  }

  set invoiceId(value: IBillingAdjustmentEntity['invoiceId']) {
    this.setProperty('invoiceId', value);
  }

  get reason(): IBillingAdjustmentEntity['reason'] {
    return this._reason;
  }

  set reason(value: IBillingAdjustmentEntity['reason']) {
    this.setProperty('reason', value);
  }

  get amountMicros(): IBillingAdjustmentEntity['amountMicros'] {
    return this._amountMicros;
  }

  set amountMicros(value: IBillingAdjustmentEntity['amountMicros']) {
    this.setProperty('amountMicros', value);
  }

  /** True for the common case — a credit reduces what the tenant owes. */
  public get isCredit(): boolean {
    return this._amountMicros < 0n;
  }

  public override validate(): void {
    super.validate();
    if (!this._invoiceId || this._invoiceId.trim().length === 0) {
      throw new BusinessException('BillingAdjustment invoiceId is required.');
    }
    if (!this._reason || this._reason.trim().length === 0) {
      throw new BusinessException('BillingAdjustment reason is required.');
    }
    if (this._amountMicros === undefined || this._amountMicros === null) {
      throw new BusinessException('BillingAdjustment amountMicros is required.');
    }
    // A zero adjustment changes nothing and is always a caller bug — most often
    // a rounding computation that collapsed to nothing and should not have been
    // written at all.
    if (this._amountMicros === 0n) {
      throw new BusinessException('BillingAdjustment amountMicros cannot be zero.');
    }
  }
}
