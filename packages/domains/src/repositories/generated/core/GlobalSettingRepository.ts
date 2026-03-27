import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { GlobalSettingEntityMapper } from '../../../mappers';
import { GlobalSettingEntity } from '../../../entities';
import { GlobalSetting } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class GlobalSettingRepository extends Repository<GlobalSettingEntity, GlobalSetting> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'globalSetting', GlobalSettingEntityMapper.getInstance(), undefined, ['name', 'key', 'description', 'namespace']);
  }
}
