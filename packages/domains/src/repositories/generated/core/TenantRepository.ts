import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { TenantEntityMapper } from '../../../mappers';
import { TenantEntity } from '../../../entities';
import { Tenant } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class TenantRepository extends Repository<TenantEntity, Tenant> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'tenant', TenantEntityMapper.getInstance(), undefined, ['name', 'key', 'description']);
    }
}