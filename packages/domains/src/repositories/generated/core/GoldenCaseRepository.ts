import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { GoldenCaseEntityMapper } from '../../../mappers';
import { GoldenCaseEntity } from '../../../entities';
import { GoldenCase } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class GoldenCaseRepository extends Repository<GoldenCaseEntity, GoldenCase> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'goldenCase', GoldenCaseEntityMapper.getInstance(), undefined, ['label']);
  }

  /**
   * Get all golden cases for a golden set (newest first).
   */
  async getByGoldenSet(goldenSetId: string): Promise<GoldenCaseEntity[]> {
    return this.findAll({
      filters: { goldenSetId },
      sort: [{ createdAt: 'desc' }],
    });
  }
}
