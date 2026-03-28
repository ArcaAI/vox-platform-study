import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { TagEntityMapper } from '../../../mappers';
import { TagEntity } from '../../../entities';
import { Tag } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class TagRepository extends Repository<TagEntity, Tag> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tag', TagEntityMapper.getInstance(), undefined, ['tagKey', 'tagValue', 'description']);
  }
}
