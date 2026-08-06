/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

/**
 * One hourly pre-aggregate bucket of the usage ledger.
 *
 * Consumption screens, quota checks and invoice computation read ROLLUPS, never
 * raw events — invoicing a busy tenant off tens of millions of ledger rows is
 * not a query anyone should write.
 *
 * The dimension tuple (tenant × bucketStart × capability × provider × model ×
 * unit) is UNIQUE in the schema, which is what makes maintenance an idempotent
 * upsert under drainer retry. `model` is NON-NULL with an EMPTY-STRING SENTINEL
 * for capabilities that select no model: Postgres treats each NULL as DISTINCT,
 * so a nullable column here would let two upserts for the same model-less
 * dimension BOTH insert and silently double-count. Same trap, same fix as
 * `AgentTrajectoryStep.runId`.
 *
 * Append-only: no soft delete, no sys-events (see `usage-ledger.prisma`).
 */
export interface IAiUsageRollupHourlyEntity extends IBaseTenantEntity {
  /** Truncated to the hour, UTC. */
  bucketStart: Date;
  capability: Enums.AiCapability;
  provider: string;
  /** "" sentinel when the capability selects no model — never null. */
  model?: string;
  unit: Enums.AiUsageUnit;

  quantitySum: Decimal.Value;
  /** INTERNAL cost only — BYOK_NOTIONAL rows are excluded (D14). */
  costMicrosSum?: bigint;
}

export class AiUsageRollupHourlyEntity extends BaseTenantEntity {
  private _bucketStart: IAiUsageRollupHourlyEntity['bucketStart'];
  private _capability: IAiUsageRollupHourlyEntity['capability'];
  private _provider: IAiUsageRollupHourlyEntity['provider'];
  private _model?: IAiUsageRollupHourlyEntity['model'];
  private _unit: IAiUsageRollupHourlyEntity['unit'];
  private _quantitySum: IAiUsageRollupHourlyEntity['quantitySum'];
  private _costMicrosSum?: IAiUsageRollupHourlyEntity['costMicrosSum'];

  constructor(init: IAiUsageRollupHourlyEntity) {
    super(init);
    this._bucketStart = init.bucketStart;
    this._capability = init.capability;
    this._provider = init.provider;
    this._model = init.model;
    this._unit = init.unit;
    this._quantitySum = init.quantitySum;
    this._costMicrosSum = init.costMicrosSum;
  }

  get bucketStart(): IAiUsageRollupHourlyEntity['bucketStart'] {
    return this._bucketStart;
  }

  set bucketStart(value: IAiUsageRollupHourlyEntity['bucketStart']) {
    this.setProperty('bucketStart', value);
  }

  get capability(): IAiUsageRollupHourlyEntity['capability'] {
    return this._capability;
  }

  set capability(value: IAiUsageRollupHourlyEntity['capability']) {
    this.setProperty('capability', value);
  }

  get provider(): IAiUsageRollupHourlyEntity['provider'] {
    return this._provider;
  }

  set provider(value: IAiUsageRollupHourlyEntity['provider']) {
    this.setProperty('provider', value);
  }

  get model(): IAiUsageRollupHourlyEntity['model'] {
    return this._model;
  }

  set model(value: IAiUsageRollupHourlyEntity['model']) {
    this.setProperty('model', value);
  }

  get unit(): IAiUsageRollupHourlyEntity['unit'] {
    return this._unit;
  }

  set unit(value: IAiUsageRollupHourlyEntity['unit']) {
    this.setProperty('unit', value);
  }

  get quantitySum(): IAiUsageRollupHourlyEntity['quantitySum'] {
    return this._quantitySum;
  }

  set quantitySum(value: IAiUsageRollupHourlyEntity['quantitySum']) {
    this.setProperty('quantitySum', value);
  }

  get costMicrosSum(): IAiUsageRollupHourlyEntity['costMicrosSum'] {
    return this._costMicrosSum;
  }

  set costMicrosSum(value: IAiUsageRollupHourlyEntity['costMicrosSum']) {
    this.setProperty('costMicrosSum', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._bucketStart) {
      throw new BusinessException('AiUsageRollupHourly bucketStart is required.');
    }
    if (this._capability === undefined || this._capability === null) {
      throw new BusinessException('AiUsageRollupHourly capability is required.');
    }
    if (this._provider === undefined || this._provider === null) {
      throw new BusinessException('AiUsageRollupHourly provider is required.');
    }
    if (this._unit === undefined || this._unit === null) {
      throw new BusinessException('AiUsageRollupHourly unit is required.');
    }
    // NULL would defeat the unique dimension tuple (see the header); "" is the
    // sentinel and is legitimate.
    if (this._model === null) {
      throw new BusinessException('AiUsageRollupHourly model cannot be null — use the "" sentinel when the capability selects no model.');
    }
    if (this._quantitySum === undefined || this._quantitySum === null) {
      throw new BusinessException('AiUsageRollupHourly quantitySum is required.');
    }
    if (new Decimal(this._quantitySum).isNegative()) {
      throw new BusinessException('AiUsageRollupHourly quantitySum cannot be negative.');
    }
  }
}
