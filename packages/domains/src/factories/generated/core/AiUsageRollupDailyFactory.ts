/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AiUsageRollupDailyEntity, IAiUsageRollupDailyEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateAiUsageRollupDailyProps extends BaseEntityFactoryCreateProps {
  tenantId: IAiUsageRollupDailyEntity['tenantId'];
  bucketStart: IAiUsageRollupDailyEntity['bucketStart'];
  capability: IAiUsageRollupDailyEntity['capability'];
  operation?: IAiUsageRollupDailyEntity['operation'];
  provider: IAiUsageRollupDailyEntity['provider'];
  model?: IAiUsageRollupDailyEntity['model'];
  unit: IAiUsageRollupDailyEntity['unit'];
  quantitySum: IAiUsageRollupDailyEntity['quantitySum'];
  costMicrosSum?: IAiUsageRollupDailyEntity['costMicrosSum'];

  createdAt?: IAiUsageRollupDailyEntity['createdAt'];
  createdBy?: IAiUsageRollupDailyEntity['createdBy'];
}

export class AiUsageRollupDailyFactory {
  /**
   * Build one rollup bucket.
   *
   * `model` defaults to the EMPTY-STRING SENTINEL, never null: the unique
   * dimension tuple that makes rollup maintenance an idempotent upsert would be
   * defeated by a NULL (Postgres treats each NULL as distinct), silently
   * double-counting every model-less capability. Same trap, same fix as
   * `AgentTrajectoryStepFactory`'s `runId`.
   */
  static CreateAiUsageRollupDaily(props: CreateAiUsageRollupDailyProps): AiUsageRollupDailyEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new AiUsageRollupDailyEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      bucketStart: props.bucketStart,
      capability: props.capability,
      operation: props.operation ?? '',
      provider: props.provider,
      model: props.model ?? '',
      unit: props.unit,
      quantitySum: props.quantitySum,
      costMicrosSum: props.costMicrosSum ?? 0n,
    });
  }
}
