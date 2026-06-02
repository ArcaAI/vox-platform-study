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
}
