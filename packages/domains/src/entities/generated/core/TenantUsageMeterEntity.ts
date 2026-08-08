/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

export interface ITenantUsageMeterEntity extends IBaseTenantEntity {
  metric: Enums.UsageMeterMetric;
  periodStart: Date;
  periodEnd: Date;
  /**
   * Monthly consumed total (TASK-615 #5): `bigint` so token/character meters do
   * not overflow Int32 (~2.1B) for a heavy tenant. Maps to the `BigInt`
   * `usedCount` column.
   */
  usedCount: bigint;
  reconciledAt?: Date | null;
}

export class TenantUsageMeterEntity extends BaseTenantEntity {
  private _metric: ITenantUsageMeterEntity['metric'];
  private _periodStart: ITenantUsageMeterEntity['periodStart'];
  private _periodEnd: ITenantUsageMeterEntity['periodEnd'];
  private _usedCount: ITenantUsageMeterEntity['usedCount'];
  private _reconciledAt?: ITenantUsageMeterEntity['reconciledAt'];

  constructor(init: ITenantUsageMeterEntity) {
    super(init);
    this._metric = init.metric;
    this._periodStart = init.periodStart;
    this._periodEnd = init.periodEnd;
    this._usedCount = init.usedCount;
    this._reconciledAt = init.reconciledAt;
  }

  get metric(): ITenantUsageMeterEntity['metric'] {
    return this._metric;
  }

  set metric(value: ITenantUsageMeterEntity['metric']) {
    this.setProperty('metric', value);
  }

  get periodStart(): ITenantUsageMeterEntity['periodStart'] {
    return this._periodStart;
  }

  set periodStart(value: ITenantUsageMeterEntity['periodStart']) {
    this.setProperty('periodStart', value);
  }

  get periodEnd(): ITenantUsageMeterEntity['periodEnd'] {
    return this._periodEnd;
  }

  set periodEnd(value: ITenantUsageMeterEntity['periodEnd']) {
    this.setProperty('periodEnd', value);
  }

  get usedCount(): ITenantUsageMeterEntity['usedCount'] {
    return this._usedCount;
  }

  set usedCount(value: ITenantUsageMeterEntity['usedCount']) {
    this.setProperty('usedCount', value);
  }

  get reconciledAt(): ITenantUsageMeterEntity['reconciledAt'] {
    return this._reconciledAt;
  }

  set reconciledAt(value: ITenantUsageMeterEntity['reconciledAt']) {
    this.setProperty('reconciledAt', value);
  }

  public override validate(): void {
    super.validate();
    if (this._metric === undefined || this._metric === null) {
      throw new BusinessException('TenantUsageMeter metric is required.');
    }
    if (!(this._periodStart instanceof Date) || !(this._periodEnd instanceof Date)) {
      throw new BusinessException('TenantUsageMeter period bounds are required.');
    }
    if (this._periodEnd.getTime() <= this._periodStart.getTime()) {
      throw new BusinessException('TenantUsageMeter periodEnd must be after periodStart.');
    }
    if (typeof this._usedCount !== 'bigint' || this._usedCount < 0n) {
      throw new BusinessException('TenantUsageMeter usedCount must be a non-negative bigint.');
    }
  }
}
