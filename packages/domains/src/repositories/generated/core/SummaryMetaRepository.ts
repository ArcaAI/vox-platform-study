import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { SummaryMetaEntityMapper } from '../../../mappers';
import { SummaryMetaEntity } from '../../../entities';
import { SummaryMeta } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class SummaryMetaRepository extends Repository<SummaryMetaEntity, SummaryMeta> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'summaryMeta', SummaryMetaEntityMapper.getInstance());
    }

    // ============================================
    // Custom Query Methods
    // ============================================

    /**
     * Find summary metadata by context item ID (1:1 relationship)
     */
    async findByContextItem(contextItemId: string): Promise<SummaryMetaEntity | null> {
        try {
            const model = await (this as any).db.findFirst({
                where: { contextItemId }
            });
            if (!model) return null;
            return (this as any)._mapper.toDomainEntity(model);
        } catch {
            return null;
        }
    }

    /**
     * Find summary metadata by AI model ID
     */
    async findByAiModel(aiModelId: string, limit: number = 100): Promise<SummaryMetaEntity[]> {
        const models = await (this as any).db.findMany({
            where: { aiModelId },
            orderBy: { createdAt: 'desc' },
            take: limit
        });

        return models.map((model: SummaryMeta) => (this as any)._mapper.toDomainEntity(model));
    }

    /**
     * Find summary metadata by tenant
     */
    async findByTenant(tenantId: string, limit: number = 100): Promise<SummaryMetaEntity[]> {
        const models = await (this as any).db.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
            take: limit
        });

        return models.map((model: SummaryMeta) => (this as any)._mapper.toDomainEntity(model));
    }

    /**
     * Get average processing time for an AI model
     */
    async getAverageProcessingTime(aiModelId: string): Promise<number | null> {
        const result = await (this as any).db.aggregate({
            where: { aiModelId },
            _avg: { processingTimeMs: true }
        });
        return result._avg.processingTimeMs;
    }

    /**
     * Get total token usage for an AI model
     */
    async getTotalTokenUsage(aiModelId: string): Promise<{ inputTokens: number; outputTokens: number }> {
        const result = await (this as any).db.aggregate({
            where: { aiModelId },
            _sum: {
                inputTokens: true,
                outputTokens: true
            }
        });
        return {
            inputTokens: result._sum.inputTokens ?? 0,
            outputTokens: result._sum.outputTokens ?? 0
        };
    }

    /**
     * Find summaries that used specific case notes
     */
    async findByCaseNoteId(caseNoteId: string): Promise<SummaryMetaEntity[]> {
        const models = await (this as any).db.findMany({
            where: {
                caseNoteIds: {
                    has: caseNoteId
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        return models.map((model: SummaryMeta) => (this as any)._mapper.toDomainEntity(model));
    }

    /**
     * Find summaries generated within a date range
     */
    async findByDateRange(startDate: Date, endDate: Date): Promise<SummaryMetaEntity[]> {
        const models = await (this as any).db.findMany({
            where: {
                generatedAt: {
                    gte: startDate,
                    lte: endDate
                }
            },
            orderBy: { generatedAt: 'desc' }
        });

        return models.map((model: SummaryMeta) => (this as any)._mapper.toDomainEntity(model));
    }
}
