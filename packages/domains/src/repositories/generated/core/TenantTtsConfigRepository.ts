import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TenantTtsConfigEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { TenantTtsConfigEntityMapper } from '../../../mappers';
import { TenantTtsConfig } from '../../../models';

@Injectable()
export class TenantTtsConfigRepository extends Repository<TenantTtsConfigEntity, TenantTtsConfig> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantTtsConfig', TenantTtsConfigEntityMapper.getInstance());
  }

  /**
   * The single config row for a tenant (tenantId is unique), or null when the
   * tenant has no row yet. Passing the SYSTEM tenant id returns the platform
   * default (TenantTtsConfig is a SYSTEM-shared read model — the extension
   * widens the read to [caller, SYSTEM]).
   */
  async findByTenantId(tenantId: string): Promise<TenantTtsConfigEntity | null> {
    try {
      return await this.findFirst({
        filters: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
      });
    } catch {
      return null;
    }
  }
}
