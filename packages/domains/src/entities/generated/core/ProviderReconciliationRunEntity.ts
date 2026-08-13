/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

/**
 * One provider-reconciliation attempt.
 *
 * The financial control behind a drift alert: months later, "why did we bill
 * this?" is answered by a row here — the settled window, the ledger's own
 * CLOUD-only total, the vendor's reported total, and the verdict reached under
 * the threshold IN FORCE AT THE TIME.
 *
 * APPEND-ONLY. No soft delete (an audit record that can be withdrawn is not a
 * control) and no unique key on (provider, window) — a re-run is a second
 * attempt and is recorded as one.
 *
 * Rows are SYSTEM-owned: a vendor bills the PLATFORM, not a tenant.
 */
export interface IProviderReconciliationRunEntity extends IBaseTenantEntity {
  provider: string;
  windowStart: Date;
  windowEnd: Date;
  windowLabel: string;
  status: string;
  reason?: string;
  ledgerQuantity?: Decimal.Value;
  providerQuantity?: Decimal.Value;
  providerUnit?: string;
  relativeDrift?: Decimal.Value;
  breachedThreshold?: boolean;
  thresholdPct: number;
  runAt?: Date;
}

export class ProviderReconciliationRunEntity extends BaseTenantEntity {
  private _provider: IProviderReconciliationRunEntity['provider'];
  private _windowStart: IProviderReconciliationRunEntity['windowStart'];
  private _windowEnd: IProviderReconciliationRunEntity['windowEnd'];
  private _windowLabel: IProviderReconciliationRunEntity['windowLabel'];
  private _status: IProviderReconciliationRunEntity['status'];
  private _reason?: IProviderReconciliationRunEntity['reason'];
  private _ledgerQuantity?: IProviderReconciliationRunEntity['ledgerQuantity'];
  private _providerQuantity?: IProviderReconciliationRunEntity['providerQuantity'];
  private _providerUnit?: IProviderReconciliationRunEntity['providerUnit'];
  private _relativeDrift?: IProviderReconciliationRunEntity['relativeDrift'];
  private _breachedThreshold?: IProviderReconciliationRunEntity['breachedThreshold'];
  private _thresholdPct: IProviderReconciliationRunEntity['thresholdPct'];
  private _runAt?: IProviderReconciliationRunEntity['runAt'];

  constructor(init: IProviderReconciliationRunEntity) {
    super(init);
    this._provider = init.provider;
    this._windowStart = init.windowStart;
    this._windowEnd = init.windowEnd;
    this._windowLabel = init.windowLabel;
    this._status = init.status;
    this._reason = init.reason;
    this._ledgerQuantity = init.ledgerQuantity;
    this._providerQuantity = init.providerQuantity;
    this._providerUnit = init.providerUnit;
    this._relativeDrift = init.relativeDrift;
    this._breachedThreshold = init.breachedThreshold;
    this._thresholdPct = init.thresholdPct;
    this._runAt = init.runAt;
  }

  get provider(): IProviderReconciliationRunEntity['provider'] {
    return this._provider;
  }

  set provider(value: IProviderReconciliationRunEntity['provider']) {
    this.setProperty('provider', value);
  }

  get windowStart(): IProviderReconciliationRunEntity['windowStart'] {
    return this._windowStart;
  }

  set windowStart(value: IProviderReconciliationRunEntity['windowStart']) {
    this.setProperty('windowStart', value);
  }

  get windowEnd(): IProviderReconciliationRunEntity['windowEnd'] {
    return this._windowEnd;
  }

  set windowEnd(value: IProviderReconciliationRunEntity['windowEnd']) {
    this.setProperty('windowEnd', value);
  }

  get windowLabel(): IProviderReconciliationRunEntity['windowLabel'] {
    return this._windowLabel;
  }

  set windowLabel(value: IProviderReconciliationRunEntity['windowLabel']) {
    this.setProperty('windowLabel', value);
  }

  get status(): IProviderReconciliationRunEntity['status'] {
    return this._status;
  }

  set status(value: IProviderReconciliationRunEntity['status']) {
    this.setProperty('status', value);
  }

  get reason(): IProviderReconciliationRunEntity['reason'] {
    return this._reason;
  }

  set reason(value: IProviderReconciliationRunEntity['reason']) {
    this.setProperty('reason', value);
  }

  get ledgerQuantity(): IProviderReconciliationRunEntity['ledgerQuantity'] {
    return this._ledgerQuantity;
  }

  set ledgerQuantity(value: IProviderReconciliationRunEntity['ledgerQuantity']) {
    this.setProperty('ledgerQuantity', value);
  }

  get providerQuantity(): IProviderReconciliationRunEntity['providerQuantity'] {
    return this._providerQuantity;
  }

  set providerQuantity(value: IProviderReconciliationRunEntity['providerQuantity']) {
    this.setProperty('providerQuantity', value);
  }

  get providerUnit(): IProviderReconciliationRunEntity['providerUnit'] {
    return this._providerUnit;
  }

  set providerUnit(value: IProviderReconciliationRunEntity['providerUnit']) {
    this.setProperty('providerUnit', value);
  }

  get relativeDrift(): IProviderReconciliationRunEntity['relativeDrift'] {
    return this._relativeDrift;
  }

  set relativeDrift(value: IProviderReconciliationRunEntity['relativeDrift']) {
    this.setProperty('relativeDrift', value);
  }

  get breachedThreshold(): IProviderReconciliationRunEntity['breachedThreshold'] {
    return this._breachedThreshold;
  }

  set breachedThreshold(value: IProviderReconciliationRunEntity['breachedThreshold']) {
    this.setProperty('breachedThreshold', value);
  }

  get thresholdPct(): IProviderReconciliationRunEntity['thresholdPct'] {
    return this._thresholdPct;
  }

  set thresholdPct(value: IProviderReconciliationRunEntity['thresholdPct']) {
    this.setProperty('thresholdPct', value);
  }

  get runAt(): IProviderReconciliationRunEntity['runAt'] {
    return this._runAt;
  }

  set runAt(value: IProviderReconciliationRunEntity['runAt']) {
    this.setProperty('runAt', value);
  }

  /** True when this run produced a comparison at all (vs skipped/failed). */
  get isReconciled(): boolean {
    return this._status === 'reconciled';
  }
}
