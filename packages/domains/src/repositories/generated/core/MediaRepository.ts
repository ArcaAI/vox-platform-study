import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { MediaEntityMapper } from '../../../mappers';
import { MediaEntity } from '../../../entities';
import { Media } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class MediaRepository extends Repository<MediaEntity, Media> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'media', MediaEntityMapper.getInstance(), undefined, ['name', 'mimeType', 'extension']);
  }
}
