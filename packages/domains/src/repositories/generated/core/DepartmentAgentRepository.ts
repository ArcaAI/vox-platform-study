import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { DepartmentAgentEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { DepartmentAgentEntityMapper } from '../../../mappers';
import { DepartmentAgent } from '../../../models';

/**
 * First-class department-agent repository (TASK-546).
 *
 * A STANDARD tenant-scoped model — one row binds a department to a prompt
 * template at a pinned/tracked version. The `(tenantId, departmentId, slug)`
 * unique index enforces slug uniqueness within a department. NOT SYSTEM-shared:
 * a tenant's agents are never visible cross-tenant.
 */
@Injectable()
export class DepartmentAgentRepository extends Repository<DepartmentAgentEntity, DepartmentAgent> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'departmentAgent', DepartmentAgentEntityMapper.getInstance());
  }

  /**
   * Find an ENABLED agent by its slug within a (tenant, department), or null.
   */
  async findBySlug(tenantId: string, departmentId: string, slug: string): Promise<DepartmentAgentEntity | null> {
    try {
      return await this.findFirst({
        filters: { tenantId, departmentId, slug, resourceStatus: ResourceStatusType.ENABLED },
      });
    } catch {
      return null;
    }
  }

  /**
   * Slug uniqueness within a (tenant, department), optionally excluding a row.
   */
  async isSlugUnique(tenantId: string, departmentId: string, slug: string, excludeId?: string): Promise<boolean> {
    const existing = await this.findBySlug(tenantId, departmentId, slug);
    if (!existing) return true;
    if (excludeId && existing.id === excludeId) return true;
    return false;
  }

  /**
   * All ENABLED agents for a department, name-ordered.
   */
  async findAllByDepartment(tenantId: string, departmentId: string): Promise<DepartmentAgentEntity[]> {
    return this.findAll({
      filters: { tenantId, departmentId, resourceStatus: ResourceStatusType.ENABLED },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * The department's current default agent (ENABLED), if any. The
   * `(tenantId, departmentId)` scope enforces the movable-pointer resolution
   * source — resolution reads THIS row's binding.
   */
  async findDefaultForDepartment(tenantId: string, departmentId: string): Promise<DepartmentAgentEntity | null> {
    try {
      return await this.findFirst({
        filters: { tenantId, departmentId, isDefault: true, resourceStatus: ResourceStatusType.ENABLED } as never,
      });
    } catch {
      return null;
    }
  }

  /**
   * Atomically mark `agentId` as the department default and unset any previous
   * default, scoped to `(tenantId, departmentId)`. Runs inside a single Prisma
   * transaction so the "exactly one default per department" invariant can never
   * be observed half-applied (two defaults, or zero) under concurrency.
   *
   * `isDefault` is NOT version-guarded (it is a scoped flag flip, not a content
   * edit), so this deliberately bypasses the OCC `_version` CAS — mirrors
   * `AsrPipelineRepository.setDefaultForTenant`.
   */
  async setDefaultForDepartment(tenantId: string, departmentId: string, agentId: string, updatedBy?: string): Promise<void> {
    await this.unitOfWorkService.runInTransaction(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).departmentAgent.updateMany({
        where: { tenantId, departmentId, isDefault: true, id: { not: agentId } },
        data: { isDefault: false, updatedBy: updatedBy ?? null },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).departmentAgent.update({
        where: { id: agentId },
        data: { isDefault: true, updatedBy: updatedBy ?? null },
      });
    });
  }
}
