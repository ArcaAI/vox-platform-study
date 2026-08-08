/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { TenantUsageMeterEntity, ITenantUsageMeterEntity } from '../../../entities';
import * as Enums from '../../../enums';

export interface CreateTenantUsageMeterProps extends BaseEntityFactoryCreateProps {
  metric: ITenantUsageMeterEntity['metric'];
  periodStart: ITenantUsageMeterEntity['periodStart'];
  periodEnd: ITenantUsageMeterEntity['periodEnd'];
  usedCount?: ITenantUsageMeterEntity['usedCount'];
  reconciledAt?: ITenantUsageMeterEntity['reconciledAt'];
  tenantId: ITenantUsageMeterEntity['tenantId'];

  createdAt?: ITenantUsageMeterEntity['createdAt'];
  updatedAt?: ITenantUsageMeterEntity['updatedAt'];
  createdBy?: ITenantUsageMeterEntity['createdBy'];
  updatedBy?: ITenantUsageMeterEntity['updatedBy'];
}

export class TenantUsageMeterFactory {
  static CreateTenantUsageMeter(props: CreateTenantUsageMeterProps): TenantUsageMeterEntity {
    const id = generateId();
    const now = new Date();

    return new TenantUsageMeterEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      tenantId: props.tenantId,
      metric: props.metric,
      periodStart: props.periodStart,
      periodEnd: props.periodEnd,
      usedCount: props.usedCount ?? 0n,
      reconciledAt: props.reconciledAt ?? null,
    });
  }
}
