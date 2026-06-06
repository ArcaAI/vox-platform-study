import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { GoldenSetEntityMapper } from '../../../mappers';
import { GoldenSetEntity } from '../../../entities';
import { GoldenSet } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class GoldenSetRepository extends Repository<GoldenSetEntity, GoldenSet> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'goldenSet', GoldenSetEntityMapper.getInstance(), undefined, ['name', 'description']);
  }
}
