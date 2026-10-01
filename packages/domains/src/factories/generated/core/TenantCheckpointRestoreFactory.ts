/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { TenantCheckpointRestoreEntity, ITenantCheckpointRestoreEntity } from '../../../entities';
import { TenantCheckpointCategory, TenantCheckpointRestoreStatus } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateTenantCheckpointRestoreProps extends BaseEntityFactoryCreateProps {
  checkpointId: ITenantCheckpointRestoreEntity['checkpointId'];
  categories?: ITenantCheckpointRestoreEntity['categories'];
  reason: ITenantCheckpointRestoreEntity['reason'];
  status?: ITenantCheckpointRestoreEntity['status'];
  safetyCheckpointId?: ITenantCheckpointRestoreEntity['safetyCheckpointId'];
  counts?: ITenantCheckpointRestoreEntity['counts'];
  warnings?: ITenantCheckpointRestoreEntity['warnings'];
  requestedBy: ITenantCheckpointRestoreEntity['requestedBy'];
  heartbeatAt?: ITenantCheckpointRestoreEntity['heartbeatAt'];
  lockAcquiredAt?: ITenantCheckpointRestoreEntity['lockAcquiredAt'];
  lockReleasedAt?: ITenantCheckpointRestoreEntity['lockReleasedAt'];
  startedAt?: ITenantCheckpointRestoreEntity['startedAt'];
  finishedAt?: ITenantCheckpointRestoreEntity['finishedAt'];
  failureReason?: ITenantCheckpointRestoreEntity['failureReason'];
  failureDetail?: ITenantCheckpointRestoreEntity['failureDetail'];

  createdAt?: ITenantCheckpointRestoreEntity['createdAt'];
  updatedAt?: ITenantCheckpointRestoreEntity['updatedAt'];
  createdBy?: ITenantCheckpointRestoreEntity['createdBy'];
  updatedBy?: ITenantCheckpointRestoreEntity['updatedBy'];
}

export class TenantCheckpointRestoreFactory {
  static CreateTenantCheckpointRestore(props: CreateTenantCheckpointRestoreProps): TenantCheckpointRestoreEntity {
    const id = generateId();
    const now = new Date();

    return new TenantCheckpointRestoreEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      checkpointId: props.checkpointId,
      categories: props.categories ?? [],
      reason: props.reason,
      status: props.status ?? TenantCheckpointRestoreStatus.PENDING,
      safetyCheckpointId: props.safetyCheckpointId ?? null,
      counts: props.counts ?? null,
      warnings: props.warnings ?? null,
      requestedBy: props.requestedBy,
      heartbeatAt: props.heartbeatAt ?? null,
      lockAcquiredAt: props.lockAcquiredAt ?? null,
      lockReleasedAt: props.lockReleasedAt ?? null,
      startedAt: props.startedAt ?? null,
      finishedAt: props.finishedAt ?? null,
      failureReason: props.failureReason ?? null,
      failureDetail: props.failureDetail ?? null,
    });
  }
}
