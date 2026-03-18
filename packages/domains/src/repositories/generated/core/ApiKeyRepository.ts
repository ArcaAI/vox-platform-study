import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { ApiKeyEntityMapper } from '../../../mappers';
import { ApiKeyEntity } from '../../../entities';
import { ApiKey } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class ApiKeyRepository extends Repository<ApiKeyEntity, ApiKey> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'apiKey', ApiKeyEntityMapper.getInstance(), undefined, ['keyName', 'description', 'environment']);
    }
}