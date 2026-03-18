import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { UserEntityMapper } from '../../../mappers';
import { UserEntity } from '../../../entities';
import { User } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class UserRepository extends Repository<UserEntity, User> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'user', UserEntityMapper.getInstance(), undefined, ['username', 'externalId']);
    }
}