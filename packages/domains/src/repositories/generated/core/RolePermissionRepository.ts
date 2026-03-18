import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { RolePermissionEntityMapper } from '../../../mappers';
import { RolePermissionEntity } from '../../../entities';
import { RolePermission } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class RolePermissionRepository extends Repository<RolePermissionEntity, RolePermission> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'rolePermission', RolePermissionEntityMapper.getInstance());
    }
}