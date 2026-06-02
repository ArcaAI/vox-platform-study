import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { TenantFrontendConfigEntityMapper } from '../../../mappers';
import { TenantFrontendConfigEntity } from '../../../entities';
import { TenantFrontendConfig } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class TenantFrontendConfigRepository extends Repository<TenantFrontendConfigEntity, TenantFrontendConfig> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantFrontendConfig', TenantFrontendConfigEntityMapper.getInstance());
  }

  /**
   * TASK-328 A6 — Resolve the single frontend-pipeline config row for a
   * tenant (`tenantId` is `@unique` on the model). Returns `null` rather
   * than throwing when the tenant has no config yet, so the application
   * service can branch into "create" on first save.
   */
  async findByTenant(tenantId: string): Promise<TenantFrontendConfigEntity | null> {
    try {
      return await this.findFirst({ filters: { tenantId } });
    } catch {
      return null;
    }
  }
}
