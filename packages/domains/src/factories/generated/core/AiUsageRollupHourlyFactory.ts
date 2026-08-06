/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AiUsageRollupHourlyEntity, IAiUsageRollupHourlyEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateAiUsageRollupHourlyProps extends BaseEntityFactoryCreateProps {
  tenantId: IAiUsageRollupHourlyEntity['tenantId'];
  bucketStart: IAiUsageRollupHourlyEntity['bucketStart'];
  capability: IAiUsageRollupHourlyEntity['capability'];
  provider: IAiUsageRollupHourlyEntity['provider'];
  model?: IAiUsageRollupHourlyEntity['model'];
  unit: IAiUsageRollupHourlyEntity['unit'];
  quantitySum: IAiUsageRollupHourlyEntity['quantitySum'];
  costMicrosSum?: IAiUsageRollupHourlyEntity['costMicrosSum'];

  createdAt?: IAiUsageRollupHourlyEntity['createdAt'];
  createdBy?: IAiUsageRollupHourlyEntity['createdBy'];
}

export class AiUsageRollupHourlyFactory {
  /**
   * Build one rollup bucket.
   *
   * `model` defaults to the EMPTY-STRING SENTINEL, never null: the unique
   * dimension tuple that makes rollup maintenance an idempotent upsert would be
   * defeated by a NULL (Postgres treats each NULL as distinct), silently
   * double-counting every model-less capability. Same trap, same fix as
   * `AgentTrajectoryStepFactory`'s `runId`.
   */
  static CreateAiUsageRollupHourly(props: CreateAiUsageRollupHourlyProps): AiUsageRollupHourlyEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new AiUsageRollupHourlyEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      bucketStart: props.bucketStart,
      capability: props.capability,
      provider: props.provider,
      model: props.model ?? '',
      unit: props.unit,
      quantitySum: props.quantitySum,
      costMicrosSum: props.costMicrosSum ?? 0n,
    });
  }
}
