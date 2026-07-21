import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { PromptTemplateEntityMapper } from '../../../mappers';
import { PromptTemplateEntity } from '../../../entities';
import { PromptTemplate } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { PromptTemplateCategory, PromptTemplateScope, ResourceStatusType } from '../../../enums';

@Injectable()
export class PromptTemplateRepository extends Repository<PromptTemplateEntity, PromptTemplate> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'promptTemplate', PromptTemplateEntityMapper.getInstance(), undefined, ['name', 'description']);
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find prompt template by name within a tenant
   */
  async findByName(tenantId: string, name: string): Promise<PromptTemplateEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          tenantId,
          name,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch {
      return null;
    }
  }

  /**
   * Find all prompt templates for a department
   */
  async findByDepartment(departmentId: string): Promise<PromptTemplateEntity[]> {
    return this.findAll({
      filters: {
        departmentId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Find all prompt templates by category
   */
  async findByCategory(category: string): Promise<PromptTemplateEntity[]> {
    return this.findAll({
      filters: {
        category: category as PromptTemplateCategory,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Find all USER_PERSONAL templates owned by a given user inside a department, within a tenant.
   * Used by PromptManagementService.listMyPersonalForDepartment.
   */
  async findMyPersonalForDepartment(
    tenantId: string,
    ownerUserId: string,
    departmentId: string,
  ): Promise<PromptTemplateEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        ownerUserId,
        departmentId,
        scope: PromptTemplateScope.USER_PERSONAL,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ name: 'asc' }],
    });
  }

  /**
   * Repository-level pagination for the admin list.
   *
   * Returns both the page slice and the total matching count in one call so
   * the controller no longer materializes the full tenant result set just to
   * slice it in memory. Mirrors the `ConsultationRepository.findPaginated*`
   * precedent (`db.findMany` + `db.count` against the same extended client, so
   * soft-delete semantics match the query-builder list path).
   */
  async findPaginated(
    where: Record<string, unknown>,
    page: number,
    limit: number,
  ): Promise<{ data: PromptTemplateEntity[]; count: number }> {
    const db = (this as any).db;
    const [models, count] = await Promise.all([
      db.findMany({
        where,
        orderBy: [{ name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.count({ where }),
    ]);

    return {
      data: models.map((model: PromptTemplate) => (this as any)._mapper.toDomainEntity(model)),
      count,
    };
  }
}
