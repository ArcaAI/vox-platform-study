/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AiUsageEventEntity, IAiUsageEventEntity } from '../../../entities';
import { AiCostBasis } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateAiUsageEventProps extends BaseEntityFactoryCreateProps {
  tenantId: IAiUsageEventEntity['tenantId'];
  idempotencyKey: IAiUsageEventEntity['idempotencyKey'];
  occurredAt: IAiUsageEventEntity['occurredAt'];
  recordedAt?: IAiUsageEventEntity['recordedAt'];

  capability: IAiUsageEventEntity['capability'];
  operation: IAiUsageEventEntity['operation'];
  provider: IAiUsageEventEntity['provider'];
  /** TASK-958 — the connection that served, when one did. */
  connectionId?: IAiUsageEventEntity['connectionId'];
  model?: IAiUsageEventEntity['model'];
  deployment: IAiUsageEventEntity['deployment'];

  unit: IAiUsageEventEntity['unit'];
  quantity: IAiUsageEventEntity['quantity'];

  consultationId?: IAiUsageEventEntity['consultationId'];
  doctorId?: IAiUsageEventEntity['doctorId'];
  departmentId?: IAiUsageEventEntity['departmentId'];
  requestId?: IAiUsageEventEntity['requestId'];
  sessionId?: IAiUsageEventEntity['sessionId'];

  unitPriceMicros?: IAiUsageEventEntity['unitPriceMicros'];
  priceBookVersion?: IAiUsageEventEntity['priceBookVersion'];
  costMicros?: IAiUsageEventEntity['costMicros'];
  costBasis?: IAiUsageEventEntity['costBasis'];

  attributesJson?: IAiUsageEventEntity['attributesJson'];

  createdAt?: IAiUsageEventEntity['createdAt'];
  createdBy?: IAiUsageEventEntity['createdBy'];
}

export class AiUsageEventFactory {
  /**
   * Build one append-only usage fact. `id` is a time-sortable UUIDv7 and
   * `_version`/timestamps follow the house convention.
   *
   * `recordedAt` defaults to NOW while `occurredAt` is always supplied by the
   * caller — the two are deliberately not interchangeable: `occurredAt` selects
   * the price row that applies, so defaulting it would silently price a
   * backfilled event at today's rate.
   *
   * `costBasis` defaults to INTERNAL (a platform-funded call). BYOK emitters
   * must pass `BYOK_NOTIONAL` explicitly so a forgotten flag over-reports
   * platform spend rather than under-reporting it.
   *
   * Ops telemetry: no sys-event is published on create (see the entity header).
   */
  static CreateAiUsageEvent(props: CreateAiUsageEventProps): AiUsageEventEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new AiUsageEventEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      idempotencyKey: props.idempotencyKey,
      occurredAt: props.occurredAt,
      recordedAt: props.recordedAt ?? now,

      capability: props.capability,
      operation: props.operation,
      provider: props.provider,
      connectionId: props.connectionId ?? null,
      model: props.model ?? null,
      deployment: props.deployment,

      unit: props.unit,
      quantity: props.quantity,

      consultationId: props.consultationId ?? null,
      doctorId: props.doctorId ?? null,
      departmentId: props.departmentId ?? null,
      requestId: props.requestId ?? null,
      sessionId: props.sessionId ?? null,

      unitPriceMicros: props.unitPriceMicros ?? null,
      priceBookVersion: props.priceBookVersion ?? null,
      costMicros: props.costMicros ?? null,
      costBasis: props.costBasis ?? AiCostBasis.INTERNAL,

      attributesJson: props.attributesJson ?? null,
    });
  }
}
