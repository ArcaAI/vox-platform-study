import { Injectable } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { WorkflowAssignmentEntity } from '../../../entities';
import { PipelinePolicyScope, ResourceStatusType } from '../../../enums';
import { WorkflowAssignmentEntityMapper } from '../../../mappers';
import { WorkflowAssignment } from '../../../models';

/**
 * `WorkflowAssignment` — WHICH workflow definition governs a scope for a
 * palette. Ordinary tenant-scoped, soft-deletable model (in
 * `TENANT_SCOPED_MODELS`, not in `MODELS_WITHOUT_SOFT_DELETE`).
 */
@Injectable()
export class WorkflowAssignmentRepository extends Repository<WorkflowAssignmentEntity, WorkflowAssignment> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'workflowAssignment', WorkflowAssignmentEntityMapper.getInstance());
  }

  /**
   * The UNQUALIFIED assignment row for one cascade tier, or `null` when that
   * tier has no opinion (the COMMON case — an unset tier inherits). `null` is
   * never thrown for a miss — the base `findFirst` does, hence the tolerant
   * wrapper below.
   *
   * TASK-891 — `selectorKey: ''` is part of the filter since a tier may now
   * hold several rows (mirrors `AgentAssignmentRepository.findForScope`):
   * without it this read would return whichever TAG-QUALIFIED row the
   * database happened to order first — silently serving a visit-type-scoped
   * workflow to a request that named no visit type. A caller that wants the
   * whole tier asks `findAllForScope`.
   */
  async findForScope(
    tenantId: string,
    scope: PipelinePolicyScope,
    scopeId: string | null,
    paletteKey: string,
  ): Promise<WorkflowAssignmentEntity | null> {
    return this.findFirstTolerant({
      tenantId,
      scope,
      scopeId,
      paletteKey,
      selectorKey: '',
      resourceStatus: ResourceStatusType.ENABLED,
    });
  }

  /** One tier's rows — the unqualified one plus every tag-qualified variant (TASK-891). */
  async findAllForScope(tenantId: string, scope: PipelinePolicyScope, scopeId: string | null, paletteKey: string): Promise<WorkflowAssignmentEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw delegate shape isn't exposed through DomainModel typings.
    const rows: WorkflowAssignment[] | null = await (this.db as any).findMany({
      where: { tenantId, scope, scopeId, paletteKey, resourceStatus: ResourceStatusType.ENABLED },
      orderBy: [{ selectorKey: 'desc' }],
    });
    const mapper = WorkflowAssignmentEntityMapper.getInstance();
    return (rows ?? []).filter((row) => row.tenantId === tenantId).map((row) => mapper.toDomainEntity(row));
  }

  /**
   * ONE tier row addressed by its full uniqueness key, selector included — what
   * an upsert needs so a tag-qualified write never overwrites the unqualified
   * row of the same tier.
   */
  async findForScopeSelector(
    tenantId: string,
    scope: PipelinePolicyScope,
    scopeId: string | null,
    paletteKey: string,
    selectorKey: string,
  ): Promise<WorkflowAssignmentEntity | null> {
    return this.findFirstTolerant({ tenantId, scope, scopeId, paletteKey, selectorKey, resourceStatus: ResourceStatusType.ENABLED });
  }

  /** Every live assignment a tenant holds for one palette (the matrix read). */
  async findAllForPalette(tenantId: string, paletteKey: string): Promise<WorkflowAssignmentEntity[]> {
    return this.findAll({
      filters: { tenantId, paletteKey, resourceStatus: ResourceStatusType.ENABLED },
      sort: [{ scope: 'asc' }, { scopeId: 'asc' }, { selectorKey: 'asc' }],
    });
  }

  /**
   * TASK-965 (OD-965-3) — every live assignment a tenant holds, ACROSS palettes: what the
   * lineage register's "Serves" column reads. {@link findAllForPalette} above cannot serve it —
   * a page of lineages may span palettes, and asking per palette would be one query per row.
   * The AGENT half's `AgentAssignmentRepository.findAllVisible`, minus its SYSTEM widening
   * (a workflow assignment has no SYSTEM tier to widen to).
   */
  async findAllForTenant(tenantId: string): Promise<WorkflowAssignmentEntity[]> {
    return this.findAll({
      filters: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
      sort: [{ paletteKey: 'asc' }, { scope: 'asc' }, { scopeId: 'asc' }, { selectorKey: 'asc' }],
    });
  }

  /**
   * `findFirst` throws `DataNotFoundException` on a miss. Only a genuine miss
   * maps to null — anything else (most importantly the tenant-scope
   * extension's cross-tenant throw) must SURFACE. Same treatment as
   * `WorkflowDefinitionRepository.findFirstTolerant`.
   */
  private async findFirstTolerant(filters: Record<string, unknown>): Promise<WorkflowAssignmentEntity | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters<WorkflowAssignment> would require importing the Prisma-generated model type here.
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
