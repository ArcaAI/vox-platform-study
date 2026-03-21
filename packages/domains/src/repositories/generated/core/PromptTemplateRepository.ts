import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { PromptTemplateEntityMapper } from '../../../mappers';
import { PromptTemplateEntity } from '../../../entities';
import { PromptTemplate } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceStatusType } from '../../../enums';

@Injectable()
export class PromptTemplateRepository extends Repository<PromptTemplateEntity, PromptTemplate> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
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
                    resourceStatus: ResourceStatusType.ENABLED
                }
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
                resourceStatus: ResourceStatusType.ENABLED
            },
            sort: [{ name: 'asc' }]
        });
    }

    /**
     * Find all prompt templates by category
     */
    async findByCategory(category: string): Promise<PromptTemplateEntity[]> {
        return this.findAll({
            filters: {
                category,
                resourceStatus: ResourceStatusType.ENABLED
            },
            sort: [{ name: 'asc' }]
        });
    }
}
