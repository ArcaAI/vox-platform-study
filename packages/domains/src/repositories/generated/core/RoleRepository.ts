import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { RoleEntityMapper } from '../../../mappers';
import { RoleEntity } from '../../../entities';
import { Role } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class RoleRepository extends Repository<RoleEntity, Role> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'role', RoleEntityMapper.getInstance(), undefined, ['name', 'description']);
    }
}