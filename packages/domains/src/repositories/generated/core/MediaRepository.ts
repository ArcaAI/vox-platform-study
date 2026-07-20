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

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * TASK-414 — SUM(size) in bytes for the platform consumption roll-up
   * (TASK-386 #18, "storage used"). `tenantId = null` means platform-wide
   * (no tenant filter). Returns the raw nullable sum — the caller owns the
   * null→0 presentation.
   */
  async sumSizeForTenant(tenantId: string | null): Promise<number | null> {
    const result = await (this as any).db.aggregate({
      _sum: { size: true },
      where: tenantId ? { tenantId } : {},
    });
    return result._sum.size;
  }
}
