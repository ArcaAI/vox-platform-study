/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

/**
 * One tenant's invoice for one billing period.
 *
 * The ONE optimistically-concurrency-controlled model of TASK-615: draft edits
 * and the FINALIZE transition run through `_version` → strong ETag → `If-Match`
 * → `repository.updateWithVersion`, so two concurrent finalizes cannot both win
 * on a money document. Its mapper therefore keeps the
 * `FIELDS_NOT_WRITABLE = ['version']` strip.
 *
 * IMMUTABILITY is the invariant this entity exists to protect: once
 * `finalizedAt` is set, nothing about the invoice may change. Corrections are
 * `BillingAdjustment` credit memos (D13). `finalize()` and `void()` below are
 * the only sanctioned state transitions; the structural guard here backs up the
 * service-layer checks so no code path can quietly reopen a closed period.
 *
 * Money is integer micros (BigInt) — never a float.
 */
export interface IBillingInvoiceEntity extends IBaseTenantEntity {
  /** Half-open [periodStart, periodEnd), UTC calendar month. */
  periodStart: Date;
  periodEnd: Date;

  status?: Enums.BillingInvoiceStatus;
  currency?: string;

  /** Plan fee + overage, before adjustments. Integer micros. */
  subtotalMicros?: bigint;
  /** Subtotal + Σ adjustments (credits are negative). Integer micros. */
  totalMicros?: bigint;

  finalizedAt?: Date | null;
  finalizedBy?: string | null;
}

export class BillingInvoiceEntity extends BaseTenantEntity {
  private _periodStart: IBillingInvoiceEntity['periodStart'];
  private _periodEnd: IBillingInvoiceEntity['periodEnd'];
  private _status?: IBillingInvoiceEntity['status'];
  private _currency?: IBillingInvoiceEntity['currency'];
  private _subtotalMicros?: IBillingInvoiceEntity['subtotalMicros'];
  private _totalMicros?: IBillingInvoiceEntity['totalMicros'];
  private _finalizedAt?: IBillingInvoiceEntity['finalizedAt'];
  private _finalizedBy?: IBillingInvoiceEntity['finalizedBy'];

  constructor(init: IBillingInvoiceEntity) {
    super(init);
    this._periodStart = init.periodStart;
    this._periodEnd = init.periodEnd;
    this._status = init.status;
    this._currency = init.currency;
    this._subtotalMicros = init.subtotalMicros;
    this._totalMicros = init.totalMicros;
    this._finalizedAt = init.finalizedAt;
    this._finalizedBy = init.finalizedBy;
  }

  get periodStart(): IBillingInvoiceEntity['periodStart'] {
    return this._periodStart;
  }

  set periodStart(value: IBillingInvoiceEntity['periodStart']) {
    this.setProperty('periodStart', value);
  }

  get periodEnd(): IBillingInvoiceEntity['periodEnd'] {
    return this._periodEnd;
  }

  set periodEnd(value: IBillingInvoiceEntity['periodEnd']) {
    this.setProperty('periodEnd', value);
  }

  get status(): IBillingInvoiceEntity['status'] {
    return this._status;
  }

  set status(value: IBillingInvoiceEntity['status']) {
    this.setProperty('status', value);
  }

  get currency(): IBillingInvoiceEntity['currency'] {
    return this._currency;
  }

  set currency(value: IBillingInvoiceEntity['currency']) {
    this.setProperty('currency', value);
  }

  get subtotalMicros(): IBillingInvoiceEntity['subtotalMicros'] {
    return this._subtotalMicros;
  }

  set subtotalMicros(value: IBillingInvoiceEntity['subtotalMicros']) {
    this.setProperty('subtotalMicros', value);
  }

  get totalMicros(): IBillingInvoiceEntity['totalMicros'] {
    return this._totalMicros;
  }

  set totalMicros(value: IBillingInvoiceEntity['totalMicros']) {
    this.setProperty('totalMicros', value);
  }

  get finalizedAt(): IBillingInvoiceEntity['finalizedAt'] {
    return this._finalizedAt;
  }

  set finalizedAt(value: IBillingInvoiceEntity['finalizedAt']) {
    this.setProperty('finalizedAt', value);
  }

  get finalizedBy(): IBillingInvoiceEntity['finalizedBy'] {
    return this._finalizedBy;
  }

  set finalizedBy(value: IBillingInvoiceEntity['finalizedBy']) {
    this.setProperty('finalizedBy', value);
  }

  /** True once the period is closed — the guard every write path must consult. */
  public get isFinalized(): boolean {
    return this._status === Enums.BillingInvoiceStatus.FINALIZED;
  }

  /**
   * Close the period. Stamps status + `finalizedAt`/`finalizedBy` in one
   * change-tracked transition so the OCC write carries all three or none.
   * Idempotency is NOT offered on purpose: a second finalize means the caller
   * lost a race it thought it won, and should be told.
   */
  public finalize(finalizedBy: string, finalizedAt: Date = new Date()): void {
    if (this.isFinalized) {
      throw new BusinessException('BillingInvoice is already finalized — corrections to a closed period are credit memos (BillingAdjustment).');
    }
    if (this._status === Enums.BillingInvoiceStatus.VOID) {
      throw new BusinessException('BillingInvoice is void and cannot be finalized.');
    }
    this.setProperty('status', Enums.BillingInvoiceStatus.FINALIZED);
    this.setProperty('finalizedAt', finalizedAt);
    this.setProperty('finalizedBy', finalizedBy);
  }

  /**
   * Cancel an invoice issued in error. The row is KEPT (voided, not deleted) so
   * the evidence trail survives.
   */
  public voidInvoice(): void {
    if (this._status === Enums.BillingInvoiceStatus.VOID) {
      throw new BusinessException('BillingInvoice is already void.');
    }
    this.setProperty('status', Enums.BillingInvoiceStatus.VOID);
  }

  public override validate(): void {
    super.validate();
    if (!this._periodStart || !this._periodEnd) {
      throw new BusinessException('BillingInvoice periodStart and periodEnd are required.');
    }
    if (this._periodEnd.getTime() <= this._periodStart.getTime()) {
      throw new BusinessException('BillingInvoice periodEnd must be after periodStart.');
    }
    // A FINALIZED invoice without a finalize stamp (or the reverse) means a
    // caller wrote `status` directly instead of going through `finalize()`.
    if (this.isFinalized && !this._finalizedAt) {
      throw new BusinessException('BillingInvoice cannot be FINALIZED without finalizedAt — use finalize().');
    }
    if (!this.isFinalized && this._finalizedAt) {
      throw new BusinessException('BillingInvoice carries finalizedAt but is not FINALIZED.');
    }
  }
}
