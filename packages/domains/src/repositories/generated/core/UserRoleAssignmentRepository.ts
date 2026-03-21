import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { UserRoleAssignmentEntityMapper } from '../../../mappers';
import { UserRoleAssignmentEntity } from '../../../entities';
import { UserRoleAssignment } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class UserRoleAssignmentRepository extends Repository<UserRoleAssignmentEntity, UserRoleAssignment> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'userRoleAssignment', UserRoleAssignmentEntityMapper.getInstance());
    }
}