import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TenantSttConfigEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { TenantSttConfigEntityMapper } from '../../../mappers';
import { TenantSttConfig } from '../../../models';

@Injectable()
export class TenantSttConfigRepository extends Repository<TenantSttConfigEntity, TenantSttConfig> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantSttConfig', TenantSttConfigEntityMapper.getInstance());
  }

  /**
   * The single config row for a tenant (tenantId is unique), or null when the
   * tenant has no row yet. Passing the SYSTEM tenant id returns the platform
   * default.
   */
  async findByTenantId(tenantId: string): Promise<TenantSttConfigEntity | null> {
    try {
      return await this.findFirst({
        filters: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
      });
    } catch {
      return null;
    }
  }
}
