import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { EvalScoreEntityMapper } from '../../../mappers';
import { EvalScoreEntity } from '../../../entities';
import { EvalScore } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class EvalScoreRepository extends Repository<EvalScoreEntity, EvalScore> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'evalScore', EvalScoreEntityMapper.getInstance(), undefined, ['metric', 'rationale']);
  }

  /**
   * Get all scores recorded for an eval run.
   */
  async getByEvalRun(evalRunId: string): Promise<EvalScoreEntity[]> {
    return this.findAll({
      filters: { evalRunId },
      sort: [{ createdAt: 'asc' }],
    });
  }
}
