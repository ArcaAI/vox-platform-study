import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { ContextItemVersionEntityMapper } from '../../../mappers';
import { ContextItemVersionEntity } from '../../../entities';
import { ContextItemVersion } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class ContextItemVersionRepository extends Repository<ContextItemVersionEntity, ContextItemVersion> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'contextItemVersion', ContextItemVersionEntityMapper.getInstance());
    }

    // ============================================
    // Custom Query Methods
    // ============================================

    /**
     * Get version history for a context item (newest first)
     */
    async getVersionHistory(contextItemId: string): Promise<ContextItemVersionEntity[]> {
        return this.findAll({
            filters: { contextItemId },
            sort: [{ versionNumber: 'desc' }]
        });
    }

    /**
     * Get specific version by version number
     */
    async getVersion(contextItemId: string, versionNumber: number): Promise<ContextItemVersionEntity | null> {
        try {
            return await this.findFirst({
                filters: { contextItemId, versionNumber }
            });
        } catch {
            return null;
        }
    }

    /**
     * Get latest version number for a context item
     */
    async getLatestVersionNumber(contextItemId: string): Promise<number> {
        try {
            const latest = await this.findFirst({
                filters: { contextItemId },
                sort: [{ versionNumber: 'desc' }]
            });
            return latest?.versionNumber ?? 0;
        } catch {
            return 0;
        }
    }

    /**
     * Get versions by change reason
     */
    async getVersionsByChangeReason(
        contextItemId: string,
        changeReason: string
    ): Promise<ContextItemVersionEntity[]> {
        return this.findAll({
            filters: { contextItemId, changeReason },
            sort: [{ versionNumber: 'desc' }]
        });
    }

    /**
     * Get versions by user
     */
    async getVersionsByUser(
        contextItemId: string,
        changedBy: string
    ): Promise<ContextItemVersionEntity[]> {
        return this.findAll({
            filters: { contextItemId, changedBy },
            sort: [{ versionNumber: 'desc' }]
        });
    }
}
