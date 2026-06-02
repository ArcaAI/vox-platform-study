import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { AsrPipelineEntityMapper } from '../../../mappers';
import { AsrPipelineEntity } from '../../../entities';
import { AsrPipeline } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceStatusType } from '../../../enums';

@Injectable()
export class AsrPipelineRepository extends Repository<AsrPipelineEntity, AsrPipeline> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'asrPipeline', AsrPipelineEntityMapper.getInstance());
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find pipeline by slug within a tenant
   */
  async findBySlug(tenantId: string, slug: string): Promise<AsrPipelineEntity | null> {
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
   * Find all enabled pipelines for a tenant
   */
  async findEnabledPipelines(tenantId: string): Promise<AsrPipelineEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Find pipeline with associated transcription jobs
   */
  async findWithJobs(pipelineId: string): Promise<AsrPipelineEntity | null> {
    try {
      const model = await (this as any).db.findFirst({
        where: {
          id: pipelineId,
          resourceStatus: ResourceStatusType.ENABLED,
        },
        include: {
          TranscriptionJobs: {
            take: 100,
            orderBy: { createdAt: 'desc' },
          },
        },
      });
      if (!model) return null;
      return (this as any)._mapper.toDomainEntity(model);
    } catch {
      return null;
    }
  }

  /**
   * Find pipelines by tags
   */
  async findByTags(tenantId: string, tags: string[]): Promise<AsrPipelineEntity[]> {
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

    return models.map((model: AsrPipeline) => (this as any)._mapper.toDomainEntity(model));
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
   * Find all pipelines (including disabled) for admin
   */
  async findAllForAdmin(tenantId: string): Promise<AsrPipelineEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        tenantId,
        resourceStatus: {
          in: [ResourceStatusType.ENABLED, ResourceStatusType.DISABLED],
        },
      },
      orderBy: { name: 'asc' },
    });

    return models.map((model: AsrPipeline) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * TASK-328 A6 — The tenant's current default pipeline, if any.
   */
  async findDefault(tenantId: string): Promise<AsrPipelineEntity | null> {
    try {
      return await this.findFirst({ filters: { tenantId, isDefault: true } as any });
    } catch {
      return null;
    }
  }

  /**
   * TASK-328 A6 — Atomically mark `pipelineId` as the tenant default and
   * unset any previous default, scoped to `tenantId`. Runs inside a single
   * Prisma transaction so the "exactly one default" invariant can never be
   * observed half-applied (two defaults, or zero) under concurrency.
   *
   * `isDefault` is NOT version-guarded (it is a tenant-scoped flag flip, not
   * a content edit), so this deliberately bypasses the OCC `_version` CAS.
   */
  async setDefaultForTenant(tenantId: string, pipelineId: string, updatedBy?: string): Promise<void> {
    await this.unitOfWorkService.runInTransaction(async (tx) => {
      await (tx as any).asrPipeline.updateMany({
        where: { tenantId, isDefault: true, id: { not: pipelineId } },
        data: { isDefault: false, updatedBy: updatedBy ?? null },
      });
      await (tx as any).asrPipeline.update({
        where: { id: pipelineId },
        data: { isDefault: true, updatedBy: updatedBy ?? null },
      });
    });
  }
}
