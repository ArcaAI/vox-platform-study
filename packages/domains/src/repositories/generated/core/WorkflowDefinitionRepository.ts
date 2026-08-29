import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
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
  /**
   * What "the tenant's live version of a slug" means, written ONCE.
   *
   * `findPublishedBySlug` (one slug) and `findActivePublishedByTenant` (the whole tenant) are
   * necessarily different queries, but they must select from the same population or the
   * single-slug answer and the list answer diverge — a slug a list route advertises that a
   * by-slug gate then refuses, or the reverse. Both spread this object rather than restating
   * the filter, so adding a condition to one is adding it to both.
   */
  private static readonly PUBLISHED_AND_ACTIVE = {
    status: WorkflowDefinitionStatus.PUBLISHED,
    isActive: true,
    resourceStatus: ResourceStatusType.ENABLED,
  } as const;

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
    return this.findFirstTolerant({ tenantId, slug, ...WorkflowDefinitionRepository.PUBLISHED_AND_ACTIVE });
  }

  /**
   * The tenant's published + ACTIVE workflows, one row per slug (the movable
   * pointer means at most one such row per `(tenantId, slug)`) — backs
   * `GET /api/v1/workflows` (TASK-722's exposure plane list route).
   */
  async findActivePublishedByTenant(tenantId: string): Promise<WorkflowDefinitionEntity[]> {
    return this.findAll({
      filters: { tenantId, ...WorkflowDefinitionRepository.PUBLISHED_AND_ACTIVE },
      sort: [{ slug: 'asc' }],
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
   * `max(versionNumber)` for a `(tenantId, slug)` lineage, `0` when the slug is new — the
   * `WorkflowDefinitionService.create` discipline (mirrors `PromptVersionRepository
   * .findMaxVersionNumber`): mint `max + 1` FROM THE TX CLIENT, never `currentVersionNumber +
   * 1`, so a lagging counter cannot recompute an existing versionNumber and trip the
   * `(tenantId, slug, versionNumber)` unique constraint. Deliberately NOT filtered by
   * `resourceStatus` — a soft-deleted row's versionNumber is still live in the DB unique index.
   */
  async findMaxVersionNumber(tenantId: string, slug: string, tx?: Prisma.TransactionClient | unknown): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors PromptVersionRepository.findMaxVersionNumber; the aggregate client shape isn't exposed through DomainModel typings.
    const model: any = tx ? (tx as Record<string, any>)[this._modelName] : this.db;
    const result = await model.aggregate({
      where: { tenantId, slug },
      _max: { versionNumber: true },
    });
    return result?._max?.versionNumber ?? 0;
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
