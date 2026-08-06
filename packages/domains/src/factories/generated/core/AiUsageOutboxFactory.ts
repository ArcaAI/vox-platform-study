/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AiUsageOutboxEntity, IAiUsageOutboxEntity } from '../../../entities';
import { AiUsageOutboxStatus } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateAiUsageOutboxProps extends BaseEntityFactoryCreateProps {
  tenantId: IAiUsageOutboxEntity['tenantId'];
  payload: IAiUsageOutboxEntity['payload'];
  status?: IAiUsageOutboxEntity['status'];
  attempts?: IAiUsageOutboxEntity['attempts'];
  availableAt?: IAiUsageOutboxEntity['availableAt'];
  lastError?: IAiUsageOutboxEntity['lastError'];

  createdAt?: IAiUsageOutboxEntity['createdAt'];
  createdBy?: IAiUsageOutboxEntity['createdBy'];
}

export class AiUsageOutboxFactory {
  /**
   * Build one outbox work item. Defaults put the row in the drainer's claim
   * window immediately (`PENDING`, zero attempts, `availableAt = now`) — a row
   * that is written but not picked up is the failure mode this table exists to
   * prevent, so the safe default is "claimable at once".
   */
  static CreateAiUsageOutbox(props: CreateAiUsageOutboxProps): AiUsageOutboxEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new AiUsageOutboxEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      payload: props.payload,
      status: props.status ?? AiUsageOutboxStatus.PENDING,
      attempts: props.attempts ?? 0,
      availableAt: props.availableAt ?? now,
      lastError: props.lastError ?? null,
    });
  }
}
