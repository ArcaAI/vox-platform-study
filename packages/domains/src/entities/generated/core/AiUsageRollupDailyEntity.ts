/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

/**
 * One daily pre-aggregate bucket of the usage ledger.
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
export interface IAiUsageRollupDailyEntity extends IBaseTenantEntity {
  /** Truncated to the day, UTC. */
  bucketStart: Date;
  capability: Enums.AiCapability;
  /**
   * The ledger event's operation (generate · guardrail.validate · harness.step ·
   * tts.synthesize · …). Part of the unique dimension tuple, so it carries the
   * same "" SENTINEL contract as `model` — never null. Without this dimension
   * the LLM_TOKENS meter summed guardrail + harness tokens that must never be
   * quota-blocked (D16).
   */
  operation?: string;
  provider: string;
  /** Who FUNDED the call (TASK-638): SELF_HOSTED | CLOUD | BYOK. */
  deployment?: Enums.AiDeploymentKind;
  /** "" sentinel when the capability selects no model — never null. */
  model?: string;
  unit: Enums.AiUsageUnit;

  quantitySum: Decimal.Value;
  /** INTERNAL cost only — BYOK_NOTIONAL rows are excluded (D14). */
  costMicrosSum?: bigint;
}

export class AiUsageRollupDailyEntity extends BaseTenantEntity {
  private _bucketStart: IAiUsageRollupDailyEntity['bucketStart'];
  private _capability: IAiUsageRollupDailyEntity['capability'];
  private _operation?: IAiUsageRollupDailyEntity['operation'];
  private _provider: IAiUsageRollupDailyEntity['provider'];
  private _deployment?: IAiUsageRollupDailyEntity['deployment'];
  private _model?: IAiUsageRollupDailyEntity['model'];
  private _unit: IAiUsageRollupDailyEntity['unit'];
  private _quantitySum: IAiUsageRollupDailyEntity['quantitySum'];
  private _costMicrosSum?: IAiUsageRollupDailyEntity['costMicrosSum'];

  constructor(init: IAiUsageRollupDailyEntity) {
    super(init);
    this._bucketStart = init.bucketStart;
    this._capability = init.capability;
    this._operation = init.operation;
    this._provider = init.provider;
    this._deployment = init.deployment;
    this._model = init.model;
    this._unit = init.unit;
    this._quantitySum = init.quantitySum;
    this._costMicrosSum = init.costMicrosSum;
  }

  get bucketStart(): IAiUsageRollupDailyEntity['bucketStart'] {
    return this._bucketStart;
  }

  set bucketStart(value: IAiUsageRollupDailyEntity['bucketStart']) {
    this.setProperty('bucketStart', value);
  }

  get capability(): IAiUsageRollupDailyEntity['capability'] {
    return this._capability;
  }

  set capability(value: IAiUsageRollupDailyEntity['capability']) {
    this.setProperty('capability', value);
  }

  get deployment(): IAiUsageRollupDailyEntity['deployment'] {
    return this._deployment;
  }

  set deployment(value: IAiUsageRollupDailyEntity['deployment']) {
    this.setProperty('deployment', value);
  }

  get operation(): IAiUsageRollupDailyEntity['operation'] {
    return this._operation;
  }

  set operation(value: IAiUsageRollupDailyEntity['operation']) {
    this.setProperty('operation', value);
  }

  get provider(): IAiUsageRollupDailyEntity['provider'] {
    return this._provider;
  }

  set provider(value: IAiUsageRollupDailyEntity['provider']) {
    this.setProperty('provider', value);
  }

  get model(): IAiUsageRollupDailyEntity['model'] {
    return this._model;
  }

  set model(value: IAiUsageRollupDailyEntity['model']) {
    this.setProperty('model', value);
  }

  get unit(): IAiUsageRollupDailyEntity['unit'] {
    return this._unit;
  }

  set unit(value: IAiUsageRollupDailyEntity['unit']) {
    this.setProperty('unit', value);
  }

  get quantitySum(): IAiUsageRollupDailyEntity['quantitySum'] {
    return this._quantitySum;
  }

  set quantitySum(value: IAiUsageRollupDailyEntity['quantitySum']) {
    this.setProperty('quantitySum', value);
  }

  get costMicrosSum(): IAiUsageRollupDailyEntity['costMicrosSum'] {
    return this._costMicrosSum;
  }

  set costMicrosSum(value: IAiUsageRollupDailyEntity['costMicrosSum']) {
    this.setProperty('costMicrosSum', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._bucketStart) {
      throw new BusinessException('AiUsageRollupDaily bucketStart is required.');
    }
    if (this._capability === undefined || this._capability === null) {
      throw new BusinessException('AiUsageRollupDaily capability is required.');
    }
    if (this._provider === undefined || this._provider === null) {
      throw new BusinessException('AiUsageRollupDaily provider is required.');
    }
    if (this._unit === undefined || this._unit === null) {
      throw new BusinessException('AiUsageRollupDaily unit is required.');
    }
    // NULL would defeat the unique dimension tuple (see the header); "" is the
    // sentinel and is legitimate.
    if (this._model === null) {
      throw new BusinessException('AiUsageRollupDaily model cannot be null — use the "" sentinel when the capability selects no model.');
    }
    // Same NULL-distinctness trap as `model`: `operation` is part of the unique
    // dimension tuple, so "" is the sentinel and null is never legitimate.
    if (this._operation === null) {
      throw new BusinessException('AiUsageRollupDaily operation cannot be null — use the "" sentinel when the event carries no operation.');
    }
    if (this._quantitySum === undefined || this._quantitySum === null) {
      throw new BusinessException('AiUsageRollupDaily quantitySum is required.');
    }
    if (new Decimal(this._quantitySum).isNegative()) {
      throw new BusinessException('AiUsageRollupDaily quantitySum cannot be negative.');
    }
  }
}
