import { Injectable } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { WorkflowDefinitionEntity } from '../../../entities';
import { ResourceStatusType, WorkflowDefinitionStatus } from '../../../enums';
import { WorkflowDefinitionEntityMapper } from '../../../mappers';
import { WorkflowDefinition } from '../../../models';

/**
 * `WorkflowDefinition` — a single table whose rows ARE versions (see the
 * Prisma model's file header). Ordinary tenant-scoped, soft-deletable model
 * (in `TENANT_SCOPED_MODELS`, not in `MODELS_WITHOUT_SOFT_DELETE`).
 */
@Injectable()
export class WorkflowDefinitionRepository extends Repository<WorkflowDefinitionEntity, WorkflowDefinition> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'workflowDefinition', WorkflowDefinitionEntityMapper.getInstance());
  }

  /**
   * The row the exposure gateway (TASK-722) invokes: the tenant's ACTIVE
   * PUBLISHED version of `slug`. Returns `null` — never throws — for a
   * foreign tenant's slug, an unpublished/inactive slug, or a slug that does
   * not exist at all, so the caller maps every one of those to a 404
   * (404-over-403; rule 04 §NEVER). Uses `findFirstTolerant` because the base
   * `findFirst` THROWS `DataNotFoundException` on a miss — a genuine miss
   * here is the expected common case, not an error.
   */
  async findPublishedBySlug(tenantId: string, slug: string): Promise<WorkflowDefinitionEntity | null> {
    return this.findFirstTolerant({
      tenantId,
      slug,
      status: WorkflowDefinitionStatus.PUBLISHED,
      isActive: true,
      resourceStatus: ResourceStatusType.ENABLED,
    });
  }

  /**
   * Every version row for a `(tenantId, slug)` lineage, most recent first —
   * used to compute the next `versionNumber` and to resolve
   * `parentVersionId` branches (TASK-719).
   */
  async findAllVersionsBySlug(tenantId: string, slug: string): Promise<WorkflowDefinitionEntity[]> {
    return this.findAll({
      filters: { tenantId, slug, resourceStatus: ResourceStatusType.ENABLED },
      sort: [{ versionNumber: 'desc' }],
    });
  }

  /**
   * `findFirst` throws `DataNotFoundException` on a miss. Only a genuine miss
   * maps to null — anything else (most importantly the tenant-scope
   * extension's cross-tenant throw) must SURFACE. Same treatment as
   * `ConsultationContextSchemaRepository.findFirstTolerant`.
   */
  private async findFirstTolerant(filters: Record<string, unknown>): Promise<WorkflowDefinitionEntity | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters<WorkflowDefinition> would require importing the Prisma-generated model type here.
      const result = await this.findFirst({ filters: filters as any });
      return result ?? null;
    } catch (err) {
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }
}
