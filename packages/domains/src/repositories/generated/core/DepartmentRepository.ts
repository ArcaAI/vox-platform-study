import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { DepartmentEntityMapper } from '../../../mappers';
import { DepartmentEntity } from '../../../entities';
import { Department } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceStatusType } from '../../../enums';

@Injectable()
export class DepartmentRepository extends Repository<DepartmentEntity, Department> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'department', DepartmentEntityMapper.getInstance());
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find department by code within a tenant
   */
  async findByCode(tenantId: string, code: string): Promise<DepartmentEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          tenantId,
          code,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch {
      return null;
    }
  }

  /**
   * Find all root departments (no parent)
   */
  async findRootDepartments(tenantId: string): Promise<DepartmentEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        parentDepartmentId: null,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Find children of a department
   */
  async findChildren(parentDepartmentId: string): Promise<DepartmentEntity[]> {
    return this.findAll({
      filters: {
        parentDepartmentId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Find all departments for a tenant
   *
   * Sorted `name asc, id asc`: a name-only sort leaves rows
   * with the same name ordered non-deterministically by Postgres. ArcaAI
   * carries two rows named "General Medicine" — without the `id` tiebreak,
   * `matchTenantDepartment`'s "first hit wins" could resolve either row on
   * any given query, and the two rows carry completely different prompt
   * configuration. `id` (UUIDv7) is unique, so the secondary key always
   * yields a total order.
   */
  async findAllByTenant(tenantId: string, options?: { includeDisabled?: boolean }): Promise<DepartmentEntity[]> {
    const filters: Record<string, unknown> = { tenantId };
    if (!options?.includeDisabled) {
      filters.resourceStatus = ResourceStatusType.ENABLED;
    }
    return this.findAll({
      filters,
      sort: [{ name: 'asc' }, { id: 'asc' }],
    });
  }
}
