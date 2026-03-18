import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { PromptVersionEntityMapper } from '../../../mappers';
import { PromptVersionEntity } from '../../../entities';
import { PromptVersion } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class PromptVersionRepository extends Repository<PromptVersionEntity, PromptVersion> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'promptVersion', PromptVersionEntityMapper.getInstance());
    }

    // ============================================
    // Custom Query Methods
    // ============================================

    /**
     * Find all versions for a prompt template
     */
    async findByTemplate(templateId: string): Promise<PromptVersionEntity[]> {
        return this.findAll({
            filters: {
                promptTemplateId: templateId
            },
            sort: [{ versionNumber: 'desc' }]
        });
    }

    /**
     * Find a specific version by template ID and version number
     */
    async findByVersionNumber(templateId: string, versionNumber: number): Promise<PromptVersionEntity | null> {
        try {
            return await this.findFirst({
                filters: {
                    promptTemplateId: templateId,
                    versionNumber,
                }
            });
        } catch {
            return null;
        }
    }

    /**
     * Find the latest version for a prompt template
     */
    async findLatestVersion(templateId: string): Promise<PromptVersionEntity | null> {
        try {
            return await this.findFirst({
                filters: {
                    promptTemplateId: templateId
                },
                sort: [{ versionNumber: 'desc' }]
            });
        } catch {
            return null;
        }
    }
}
