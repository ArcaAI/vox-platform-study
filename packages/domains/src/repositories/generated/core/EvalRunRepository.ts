import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { EvalRunEntityMapper } from '../../../mappers';
import { EvalRunEntity } from '../../../entities';
import { EvalRun } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class EvalRunRepository extends Repository<EvalRunEntity, EvalRun> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'evalRun', EvalRunEntityMapper.getInstance(), undefined, ['modelName', 'notes']);
  }

  /**
   * Get eval runs for a golden set (newest first).
   */
  async getByGoldenSet(goldenSetId: string): Promise<EvalRunEntity[]> {
    return this.findAll({
      filters: { goldenSetId },
      sort: [{ createdAt: 'desc' }],
    });
  }
}
