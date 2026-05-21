import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { UserEntity } from '../../../entities';
import { UserEntityMapper } from '../../../mappers';
import { User } from '../../../models';
import { ResourceStatusType } from '../../../enums';

const USER_INCLUDES = {
  UserProfile: true,
  UserRoleAssignments: {
    where: { resourceStatus: { not: ResourceStatusType.DELETED } },
    include: { Role: true },
  },
} as const;

@Injectable()
export class UserRepository extends Repository<UserEntity, User> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'user', UserEntityMapper.getInstance(), USER_INCLUDES, ['username', 'externalId']);
  }
}
