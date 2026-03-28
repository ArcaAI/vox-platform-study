import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { AiModelEntityMapper } from '../../../mappers';
import { AiModelEntity } from '../../../entities';
import { AiModel } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceStatusType, ModelTaskType, AiModelDownloadStatus, AiModelSource, AiModelFormat } from '../../../enums';

@Injectable()
export class AiModelRepository extends Repository<AiModelEntity, AiModel> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'aiModel', AiModelEntityMapper.getInstance());
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find model by slug within a tenant
   */
  async findBySlug(tenantId: string, slug: string): Promise<AiModelEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          tenantId,
          slug,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch {
      return null;
    }
  }

  /**
   * Find multiple models by slugs
   */
  async findBySlugs(tenantId: string, slugs: string[]): Promise<AiModelEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        tenantId,
        slug: { in: slugs },
        resourceStatus: ResourceStatusType.ENABLED,
      },
    });

    return models.map((model: AiModel) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find models by task type
   */
  async findByTaskType(tenantId: string, taskType: ModelTaskType): Promise<AiModelEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        taskType,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Find all downloaded models
   */
  async findDownloadedModels(tenantId: string): Promise<AiModelEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        downloadStatus: AiModelDownloadStatus.DOWNLOADED,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Find all ASR models
   */
  async findAsrModels(tenantId: string): Promise<AiModelEntity[]> {
    return this.findByTaskType(tenantId, ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION);
  }

  /**
   * Find all VAD models
   */
  async findVadModels(tenantId: string): Promise<AiModelEntity[]> {
    return this.findByTaskType(tenantId, ModelTaskType.VOICE_ACTIVITY_DETECTION);
  }

  /**
   * Find models by source
   */
  async findBySource(tenantId: string, source: AiModelSource): Promise<AiModelEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        source,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Find models by format
   */
  async findByFormat(tenantId: string, format: AiModelFormat): Promise<AiModelEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        format,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Find models currently downloading
   */
  async findDownloadingModels(tenantId: string): Promise<AiModelEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        downloadStatus: AiModelDownloadStatus.DOWNLOADING,
        resourceStatus: ResourceStatusType.ENABLED,
      },
    });
  }

  /**
   * Check if slug is unique within tenant
   */
  async isSlugUnique(tenantId: string, slug: string, excludeId?: string): Promise<boolean> {
    const existing = await this.findBySlug(tenantId, slug);
    if (!existing) return true;
    if (excludeId && existing.id === excludeId) return true;
    return false;
  }

  /**
   * Find all enabled models for a tenant
   */
  async findEnabledModels(tenantId: string): Promise<AiModelEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Find models by tags
   */
  async findByTags(tenantId: string, tags: string[]): Promise<AiModelEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        tenantId,
        resourceStatus: ResourceStatusType.ENABLED,
        tags: {
          hasSome: tags,
        },
      },
      orderBy: { name: 'asc' },
    });

    return models.map((model: AiModel) => (this as any)._mapper.toDomainEntity(model));
  }
}
