import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { PermissionEntityMapper } from '../../../mappers';
import { PermissionEntity } from '../../../entities';
import { Permission } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class PermissionRepository extends Repository<PermissionEntity, Permission> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'permission', PermissionEntityMapper.getInstance(), undefined, ['name', 'description']);
  }
}
