import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { UserMediaEntityMapper } from '../../../mappers';
import { UserMediaEntity } from '../../../entities';
import { UserMedia } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class UserMediaRepository extends Repository<UserMediaEntity, UserMedia> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'userMedia', UserMediaEntityMapper.getInstance());
  }
}
