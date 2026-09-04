import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { AsrPipelineVersionEntityMapper } from '../../../mappers';
import { AsrPipelineVersionEntity } from '../../../entities';
import { AsrPipelineVersion } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
/** @deprecated TASK-861 — removed in R4 with `AsrPipeline`; the Agent's rows-are-versions model replaces it. */
export class AsrPipelineVersionRepository extends Repository<AsrPipelineVersionEntity, AsrPipelineVersion> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'asrPipelineVersion', AsrPipelineVersionEntityMapper.getInstance());
  }

  /**
   * All snapshots for a pipeline, newest version first.
   */
  async findByPipeline(asrPipelineId: string): Promise<AsrPipelineVersionEntity[]> {
    return this.findAll({
      filters: { asrPipelineId } as any,
      sort: [{ versionNumber: 'desc' }],
    });
  }

  /**
   * The next monotonically-increasing version number for a
   * pipeline (1 when no snapshots exist yet).
   */
  async getNextVersionNumber(asrPipelineId: string): Promise<number> {
    const latest = await (this as any).db.findFirst({
      where: { asrPipelineId },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });
    return (latest?.versionNumber ?? 0) + 1;
  }
}
