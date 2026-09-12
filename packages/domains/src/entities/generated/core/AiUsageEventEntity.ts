/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';

/**
 * One append-only usage fact: "tenant T consumed Q of unit U on capability C at
 * time X, costing M micros".
 *
 * GRAIN is (request, unit) — a single LLM call produces several of these rows
 * sharing a `requestId`. See `usage-ledger.prisma` for why.
 *
 * POSTURE (differs from the standard clinical models, mirroring
 * `AgentTrajectoryStepEntity`):
 *   - NO soft delete: hard retention (18 months), no `resourceStatus` column;
 *     `softDelete()`/`restore()` throw on this repository.
 *   - NO sys-events on write: per-call metering at request volume would flood
 *     the audit trail with rows carrying no compliance meaning.
 *   - `_version` (OCC) + `_metadata` + audit fields are retained so the row
 *     round-trips through the shared BaseTenantEntity / Repository machinery.
 *
 * PHI: `attributesJson` accepts allow-listed enum values and opaque ids ONLY —
 * never prompt, transcript or note content. The entity cannot enforce an
 * allow-list it does not own (WS-G owns it); what it DOES enforce below are the
 * structural invariants that make a row ratable at all.
 */
export interface IAiUsageEventEntity extends IBaseTenantEntity {
  /** Intent-derived, e.g. `<requestId>::<capability>::<unit>`. UNIQUE platform-wide. */
  idempotencyKey: string;
  /** When the metered work happened — the RATING input (never `recordedAt`). */
  occurredAt: Date;
  /** When the platform observed it. Differs from `occurredAt` on abort/backfill. */
  recordedAt?: Date;

  capability: Enums.AiCapability;
  /** Bounded vocabulary — see the `operation` comment in `usage-ledger.prisma`. */
  operation: string;
  provider: string;
  /**
   * TASK-958 — WHICH provider connection served this call. `null` for a
   * platform-funded call, a self-hosted engine, and every pre-TASK-958 row.
   * Deliberately not a relation: the ledger is append-only evidence and must
   * outlive the connection it names.
   */
  connectionId?: string | null;
  model?: string | null;
  deployment: Enums.AiDeploymentKind;

  unit: Enums.AiUsageUnit;
  /** `Decimal.Value` so callers may pass a number/string; the DB column is DECIMAL(24,6). */
  quantity: Decimal.Value;

  consultationId?: string | null;
  doctorId?: string | null;
  departmentId?: string | null;
  requestId?: string | null;
  sessionId?: string | null;

  unitPriceMicros?: bigint | null;
  priceBookVersion?: string | null;
  costMicros?: bigint | null;
  costBasis?: Enums.AiCostBasis;

  attributesJson?: JsonValue | null;
}

export class AiUsageEventEntity extends BaseTenantEntity {
  private _idempotencyKey: IAiUsageEventEntity['idempotencyKey'];
  private _occurredAt: IAiUsageEventEntity['occurredAt'];
  private _recordedAt?: IAiUsageEventEntity['recordedAt'];
  private _capability: IAiUsageEventEntity['capability'];
  private _operation: IAiUsageEventEntity['operation'];
  private _provider: IAiUsageEventEntity['provider'];
  private _connectionId?: IAiUsageEventEntity['connectionId'];
  private _model?: IAiUsageEventEntity['model'];
  private _deployment: IAiUsageEventEntity['deployment'];
  private _unit: IAiUsageEventEntity['unit'];
  private _quantity: IAiUsageEventEntity['quantity'];
  private _consultationId?: IAiUsageEventEntity['consultationId'];
  private _doctorId?: IAiUsageEventEntity['doctorId'];
  private _departmentId?: IAiUsageEventEntity['departmentId'];
  private _requestId?: IAiUsageEventEntity['requestId'];
  private _sessionId?: IAiUsageEventEntity['sessionId'];
  private _unitPriceMicros?: IAiUsageEventEntity['unitPriceMicros'];
  private _priceBookVersion?: IAiUsageEventEntity['priceBookVersion'];
  private _costMicros?: IAiUsageEventEntity['costMicros'];
  private _costBasis?: IAiUsageEventEntity['costBasis'];
  private _attributesJson?: IAiUsageEventEntity['attributesJson'];

  constructor(init: IAiUsageEventEntity) {
    super(init);
    this._idempotencyKey = init.idempotencyKey;
    this._occurredAt = init.occurredAt;
    this._recordedAt = init.recordedAt;
    this._capability = init.capability;
    this._operation = init.operation;
    this._provider = init.provider;
    this._connectionId = init.connectionId;
    this._model = init.model;
    this._deployment = init.deployment;
    this._unit = init.unit;
    this._quantity = init.quantity;
    this._consultationId = init.consultationId;
    this._doctorId = init.doctorId;
    this._departmentId = init.departmentId;
    this._requestId = init.requestId;
    this._sessionId = init.sessionId;
    this._unitPriceMicros = init.unitPriceMicros;
    this._priceBookVersion = init.priceBookVersion;
    this._costMicros = init.costMicros;
    this._costBasis = init.costBasis;
    this._attributesJson = init.attributesJson;
  }

  get idempotencyKey(): IAiUsageEventEntity['idempotencyKey'] {
    return this._idempotencyKey;
  }

  set idempotencyKey(value: IAiUsageEventEntity['idempotencyKey']) {
    this.setProperty('idempotencyKey', value);
  }

  get occurredAt(): IAiUsageEventEntity['occurredAt'] {
    return this._occurredAt;
  }

  set occurredAt(value: IAiUsageEventEntity['occurredAt']) {
    this.setProperty('occurredAt', value);
  }

  get recordedAt(): IAiUsageEventEntity['recordedAt'] {
    return this._recordedAt;
  }

  set recordedAt(value: IAiUsageEventEntity['recordedAt']) {
    this.setProperty('recordedAt', value);
  }

  get capability(): IAiUsageEventEntity['capability'] {
    return this._capability;
  }

  set capability(value: IAiUsageEventEntity['capability']) {
    this.setProperty('capability', value);
  }

  get operation(): IAiUsageEventEntity['operation'] {
    return this._operation;
  }

  set operation(value: IAiUsageEventEntity['operation']) {
    this.setProperty('operation', value);
  }

  get provider(): IAiUsageEventEntity['provider'] {
    return this._provider;
  }

  set provider(value: IAiUsageEventEntity['provider']) {
    this.setProperty('provider', value);
  }

  get connectionId(): IAiUsageEventEntity['connectionId'] {
    return this._connectionId;
  }

  set connectionId(value: IAiUsageEventEntity['connectionId']) {
    this.setProperty('connectionId', value);
  }

  get model(): IAiUsageEventEntity['model'] {
    return this._model;
  }

  set model(value: IAiUsageEventEntity['model']) {
    this.setProperty('model', value);
  }

  get deployment(): IAiUsageEventEntity['deployment'] {
    return this._deployment;
  }

  set deployment(value: IAiUsageEventEntity['deployment']) {
    this.setProperty('deployment', value);
  }

  get unit(): IAiUsageEventEntity['unit'] {
    return this._unit;
  }

  set unit(value: IAiUsageEventEntity['unit']) {
    this.setProperty('unit', value);
  }

  get quantity(): IAiUsageEventEntity['quantity'] {
    return this._quantity;
  }

  set quantity(value: IAiUsageEventEntity['quantity']) {
    this.setProperty('quantity', value);
  }

  get consultationId(): IAiUsageEventEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IAiUsageEventEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get doctorId(): IAiUsageEventEntity['doctorId'] {
    return this._doctorId;
  }

  set doctorId(value: IAiUsageEventEntity['doctorId']) {
    this.setProperty('doctorId', value);
  }

  get departmentId(): IAiUsageEventEntity['departmentId'] {
    return this._departmentId;
  }

  set departmentId(value: IAiUsageEventEntity['departmentId']) {
    this.setProperty('departmentId', value);
  }

  get requestId(): IAiUsageEventEntity['requestId'] {
    return this._requestId;
  }

  set requestId(value: IAiUsageEventEntity['requestId']) {
    this.setProperty('requestId', value);
  }

  get sessionId(): IAiUsageEventEntity['sessionId'] {
    return this._sessionId;
  }

  set sessionId(value: IAiUsageEventEntity['sessionId']) {
    this.setProperty('sessionId', value);
  }

  get unitPriceMicros(): IAiUsageEventEntity['unitPriceMicros'] {
    return this._unitPriceMicros;
  }

  set unitPriceMicros(value: IAiUsageEventEntity['unitPriceMicros']) {
    this.setProperty('unitPriceMicros', value);
  }

  get priceBookVersion(): IAiUsageEventEntity['priceBookVersion'] {
    return this._priceBookVersion;
  }

  set priceBookVersion(value: IAiUsageEventEntity['priceBookVersion']) {
    this.setProperty('priceBookVersion', value);
  }

  get costMicros(): IAiUsageEventEntity['costMicros'] {
    return this._costMicros;
  }

  set costMicros(value: IAiUsageEventEntity['costMicros']) {
    this.setProperty('costMicros', value);
  }

  get costBasis(): IAiUsageEventEntity['costBasis'] {
    return this._costBasis;
  }

  set costBasis(value: IAiUsageEventEntity['costBasis']) {
    this.setProperty('costBasis', value);
  }

  get attributesJson(): IAiUsageEventEntity['attributesJson'] {
    return this._attributesJson;
  }

  set attributesJson(value: IAiUsageEventEntity['attributesJson']) {
    this.setProperty('attributesJson', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._idempotencyKey || this._idempotencyKey.trim().length === 0) {
      throw new BusinessException('AiUsageEvent idempotencyKey is required — it is the anti-double-billing guard.');
    }
    if (!this._occurredAt) {
      throw new BusinessException('AiUsageEvent occurredAt is required — it selects the price row that applies.');
    }
    if (!this._operation || this._operation.trim().length === 0) {
      throw new BusinessException('AiUsageEvent operation is required.');
    }
    if (!this._provider || this._provider.trim().length === 0) {
      throw new BusinessException('AiUsageEvent provider is required.');
    }
    if (this._capability === undefined || this._capability === null) {
      throw new BusinessException('AiUsageEvent capability is required.');
    }
    if (this._deployment === undefined || this._deployment === null) {
      throw new BusinessException('AiUsageEvent deployment is required.');
    }
    if (this._unit === undefined || this._unit === null) {
      throw new BusinessException('AiUsageEvent unit is required.');
    }
    if (this._quantity === undefined || this._quantity === null) {
      throw new BusinessException('AiUsageEvent quantity is required.');
    }
    // A negative quantity is never a real measurement — it is a normalizer bug
    // (a cumulative-usage delta computed the wrong way round is the classic
    // one). Rejecting it here stops a bug from becoming a credit on an invoice.
    if (new Decimal(this._quantity).isNegative()) {
      throw new BusinessException('AiUsageEvent quantity cannot be negative.');
    }
  }
}
