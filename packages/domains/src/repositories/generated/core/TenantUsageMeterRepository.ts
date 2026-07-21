import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { TenantUsageMeterEntityMapper } from '../../../mappers';
import { TenantUsageMeterEntity } from '../../../entities';
import { TenantUsageMeter } from '../../../models';
import { UsageMeterMetric } from '../../../enums';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class TenantUsageMeterRepository extends Repository<TenantUsageMeterEntity, TenantUsageMeter> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantUsageMeter', TenantUsageMeterEntityMapper.getInstance());
  }

  /**
   * Resolve the meter row for one (tenant, metric, window).
   * The `@@unique([tenantId, metric, periodStart])` guarantees at most one
   * row. Returns `null` when the window has not been opened yet, so the
   * metering service can branch into "create" on first increment.
   */
  async findWindow(
    tenantId: string,
    metric: UsageMeterMetric,
    periodStart: Date,
  ): Promise<TenantUsageMeterEntity | null> {
    try {
      return await this.findFirst({ filters: { tenantId, metric, periodStart } });
    } catch {
      return null;
    }
  }
}
