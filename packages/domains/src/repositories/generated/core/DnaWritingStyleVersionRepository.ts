import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { DnaWritingStyleVersionEntityMapper } from '../../../mappers';
import { DnaWritingStyleVersionEntity } from '../../../entities';
import { DnaWritingStyleVersion } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class DnaWritingStyleVersionRepository extends Repository<DnaWritingStyleVersionEntity, DnaWritingStyleVersion> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'dnaWritingStyleVersion', DnaWritingStyleVersionEntityMapper.getInstance());
    }

    // ============================================
    // Custom Query Methods
    // ============================================

    /**
     * Find all versions for a DNA writing style report
     */
    async findByReport(reportId: string): Promise<DnaWritingStyleVersionEntity[]> {
        return this.findAll({
            filters: {
                dnaReportId: reportId
            },
            sort: [{ versionNumber: 'desc' }]
        });
    }

    /**
     * Find the latest version for a DNA writing style report
     */
    async findLatestVersion(reportId: string): Promise<DnaWritingStyleVersionEntity | null> {
        try {
            return await this.findFirst({
                filters: {
                    dnaReportId: reportId
                },
                sort: [{ versionNumber: 'desc' }]
            });
        } catch {
            return null;
        }
    }
}
