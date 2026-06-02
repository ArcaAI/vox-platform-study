import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { UserDepartmentEntityMapper } from '../../../mappers';
import { UserDepartmentEntity } from '../../../entities';
import { UserDepartment } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class UserDepartmentRepository extends Repository<UserDepartmentEntity, UserDepartment> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'userDepartment', UserDepartmentEntityMapper.getInstance());
  }
}
