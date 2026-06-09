import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { HighlightEntityMapper } from '../../../mappers';
import { HighlightEntity } from '../../../entities';
import { Highlight } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class HighlightRepository extends Repository<HighlightEntity, Highlight> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'highlight', HighlightEntityMapper.getInstance());
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * TASK-344 Workstream B — list all (non-deleted) manual highlights for a
   * consultation. Soft-deleted rows are excluded automatically by the
   * Prisma soft-delete extension. Ordered by anchor offset then creation
   * for stable rendering order on the persisted surface.
   */
  async findByConsultation(consultationId: string): Promise<HighlightEntity[]> {
    const models = await (this as any).db.findMany({
      where: { consultationId },
      orderBy: [{ startOffset: 'asc' }, { createdAt: 'asc' }],
    });

    return models.map((model: Highlight) => (this as any)._mapper.toDomainEntity(model));
  }
}
