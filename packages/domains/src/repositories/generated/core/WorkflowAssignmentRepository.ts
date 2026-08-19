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
 * palette (TASK-733). Ordinary tenant-scoped, soft-deletable model (in
 * `TENANT_SCOPED_MODELS`, not in `MODELS_WITHOUT_SOFT_DELETE`).
 */
@Injectable()
export class WorkflowAssignmentRepository extends Repository<WorkflowAssignmentEntity, WorkflowAssignment> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'workflowAssignment', WorkflowAssignmentEntityMapper.getInstance());
  }

  /**
   * The single assignment row for one cascade tier, or `null` when that tier
   * has no opinion. `null` is the COMMON case (an unset tier inherits), so this
   * never throws — the base `findFirst` does, hence the tolerant wrapper below.
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
      resourceStatus: ResourceStatusType.ENABLED,
    });
  }

  /** Every live assignment a tenant holds for one palette (the matrix read). */
  async findAllForPalette(tenantId: string, paletteKey: string): Promise<WorkflowAssignmentEntity[]> {
    return this.findAll({
      filters: { tenantId, paletteKey, resourceStatus: ResourceStatusType.ENABLED },
      sort: [{ scope: 'asc' }, { scopeId: 'asc' }],
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
