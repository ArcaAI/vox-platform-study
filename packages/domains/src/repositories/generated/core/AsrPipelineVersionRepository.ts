import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { AsrPipelineVersionEntityMapper } from '../../../mappers';
import { AsrPipelineVersionEntity } from '../../../entities';
import { AsrPipelineVersion } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class AsrPipelineVersionRepository extends Repository<AsrPipelineVersionEntity, AsrPipelineVersion> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'asrPipelineVersion', AsrPipelineVersionEntityMapper.getInstance());
  }
}
