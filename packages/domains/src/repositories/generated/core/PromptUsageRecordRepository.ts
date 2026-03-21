import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { PromptUsageRecordEntityMapper } from '../../../mappers';
import { PromptUsageRecordEntity } from '../../../entities';
import { PromptUsageRecord } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class PromptUsageRecordRepository extends Repository<PromptUsageRecordEntity, PromptUsageRecord> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'promptUsageRecord', PromptUsageRecordEntityMapper.getInstance());
    }

    // ============================================
    // Custom Query Methods
    // ============================================

    /**
     * Find all usage records for a prompt template
     */
    async findByTemplate(templateId: string): Promise<PromptUsageRecordEntity[]> {
        return this.findAll({
            filters: {
                promptTemplateId: templateId
            },
            sort: [{ createdAt: 'desc' }]
        });
    }

    /**
     * Find all usage records for a department
     */
    async findByDepartment(departmentId: string): Promise<PromptUsageRecordEntity[]> {
        return this.findAll({
            filters: {
                departmentId
            },
            sort: [{ createdAt: 'desc' }]
        });
    }
}
