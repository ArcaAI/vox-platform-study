import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { UserProfileEntityMapper } from '../../../mappers';
import { UserProfileEntity } from '../../../entities';
import { UserProfile } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class UserProfileRepository extends Repository<UserProfileEntity, UserProfile> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'userProfile', UserProfileEntityMapper.getInstance(), undefined, ['firstName', 'lastName', 'email', 'phone']);
    }
}