import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

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
   * Find model by slug within a tenant.
   *
   * r2605 Finding A — when a transaction/base client is supplied the read is
   * routed through it (the cross-tenant base-client lane in
   * `AiTaskDefaultService`), so the tenant-scope extension never rewrites the
   * explicit tenant filter. Without `tx` behaviour is unchanged.
   */
  async findBySlug(tenantId: string, slug: string, tx?: Prisma.TransactionClient | any): Promise<AiModelEntity | null> {
    const where = {
      tenantId,
      slug,
      resourceStatus: ResourceStatusType.ENABLED,
    };

    if (tx) {
      const model = await (tx as Record<string, any>).aiModel.findFirst({ where });
      return model ? AiModelEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where });
    } catch {
      return null;
    }
  }

  /**
   * Find the catalog row a provider-native model id belongs to (TASK-858).
   *
   * Every TEXT caller resolves a request's `model` to `AiModel.sourceUri` — the id
   * the engine itself answers to — while `AiRuntimeProfile.modelSlug` is keyed by
   * the catalog `slug`. This is the translation between the two. Same routing
   * rule as `findBySlug`: an explicit `tx` bypasses the tenant-scope extension.
   */
  async findByProviderAndSourceUri(
    tenantId: string,
    provider: string,
    sourceUri: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiModelEntity | null> {
    const where = {
      tenantId,
      provider,
      sourceUri,
      resourceStatus: ResourceStatusType.ENABLED,
    };

    if (tx) {
      const model = await (tx as Record<string, any>).aiModel.findFirst({ where });
      return model ? AiModelEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where });
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
   * Find ENABLED models by task type WITHOUT pinning a tenant (r2605 Finding E).
   *
   * `AiModel` is a SYSTEM-shared read model: when NO `tenantId` filter is
   * supplied, the tenant-scope extension widens the read to
   * `tenantId IN [caller, SYSTEM]` (`mergeSharedReadTenantIntoWhere`), so a
   * tenant without cloned rows still sees the SYSTEM catalog. Do NOT pass an
   * explicit `{ in: [...] }` here — the extension's strict-equality guard
   * throws on non-string `tenantId` values. The legacy `findByTaskType`
   * (exact-tenant pin) stays untouched for its existing callers.
   */
  async findByTaskTypeSharedRead(taskType: ModelTaskType, tx?: Prisma.TransactionClient | any): Promise<AiModelEntity[]> {
    const args = {
      where: {
        taskType,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: { name: 'asc' as const },
    };
    const delegate = tx ? (tx as Record<string, any>).aiModel : (this as any).db;
    const models = await delegate.findMany(args);
    return models.map((model: AiModel) => AiModelEntityMapper.getInstance().toDomainEntity(model));
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
