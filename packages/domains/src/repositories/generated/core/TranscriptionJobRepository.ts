import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { TranscriptionJobEntityMapper } from '../../../mappers';
import { TranscriptionJobEntity } from '../../../entities';
import { TranscriptionJob } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TranscriptionJobStatus, TranscriptionJobType } from '../../../enums';

@Injectable()
export class TranscriptionJobRepository extends Repository<TranscriptionJobEntity, TranscriptionJob> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'transcriptionJob', TranscriptionJobEntityMapper.getInstance());
    }

    // ============================================
    // Custom Query Methods
    // ============================================

    /**
     * Find all jobs for a consultation
     */
    async findByConsultation(consultationId: string): Promise<TranscriptionJobEntity[]> {
        return this.findAll({
            filters: {
                consultationId
            },
            sort: [{ createdAt: 'desc' }]
        });
    }

    /**
     * Find pending (queued) jobs for a tenant
     */
    async findPendingJobs(tenantId: string, limit: number = 100): Promise<TranscriptionJobEntity[]> {
        const models = await (this as any).db.findMany({
            where: {
                tenantId,
                status: TranscriptionJobStatus.QUEUED
            },
            orderBy: { queuedAt: 'asc' },
            take: limit
        });

        return models.map((model: TranscriptionJob) => (this as any)._mapper.toDomainEntity(model));
    }

    /**
     * Find jobs by status
     */
    async findJobsByStatus(tenantId: string, status: TranscriptionJobStatus): Promise<TranscriptionJobEntity[]> {
        return this.findAll({
            filters: {
                tenantId,
                status
            },
            sort: [{ createdAt: 'desc' }]
        });
    }

    /**
     * Find job with pipeline relation
     */
    async findWithPipeline(jobId: string): Promise<TranscriptionJobEntity | null> {
        try {
            const model = await (this as any).db.findFirst({
                where: { id: jobId },
                include: {
                    Pipeline: true
                }
            });
            if (!model) return null;
            return (this as any)._mapper.toDomainEntity(model);
        } catch {
            return null;
        }
    }

    /**
     * Find recent jobs for a tenant
     */
    async findRecentJobs(tenantId: string, limit: number = 50): Promise<TranscriptionJobEntity[]> {
        const models = await (this as any).db.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
            take: limit
        });

        return models.map((model: TranscriptionJob) => (this as any)._mapper.toDomainEntity(model));
    }

    /**
     * Find jobs by pipeline
     */
    async findByPipeline(pipelineId: string): Promise<TranscriptionJobEntity[]> {
        return this.findAll({
            filters: { pipelineId },
            sort: [{ createdAt: 'desc' }]
        });
    }

    /**
     * Find jobs by type
     */
    async findByType(tenantId: string, jobType: TranscriptionJobType): Promise<TranscriptionJobEntity[]> {
        return this.findAll({
            filters: {
                tenantId,
                jobType
            },
            sort: [{ createdAt: 'desc' }]
        });
    }

    /**
     * Find processing jobs (for worker health monitoring)
     */
    async findProcessingJobs(tenantId?: string): Promise<TranscriptionJobEntity[]> {
        const where: any = {
            status: TranscriptionJobStatus.PROCESSING
        };
        if (tenantId) {
            where.tenantId = tenantId;
        }

        const models = await (this as any).db.findMany({
            where,
            orderBy: { startedAt: 'asc' }
        });

        return models.map((model: TranscriptionJob) => (this as any)._mapper.toDomainEntity(model));
    }

    /**
     * Find failed jobs that can be retried
     */
    async findRetryableJobs(tenantId: string): Promise<TranscriptionJobEntity[]> {
        const models = await (this as any).db.findMany({
            where: {
                tenantId,
                status: TranscriptionJobStatus.FAILED,
                retryCount: {
                    lt: (this as any).db.fields.maxRetries
                }
            },
            orderBy: { completedAt: 'asc' }
        });

        // Filter in memory since Prisma doesn't support comparing two columns
        return models
            .filter((model: TranscriptionJob) => model.retryCount < model.maxRetries)
            .map((model: TranscriptionJob) => (this as any)._mapper.toDomainEntity(model));
    }

    /**
     * Find jobs by worker ID
     */
    async findByWorker(workerId: string): Promise<TranscriptionJobEntity[]> {
        return this.findAll({
            filters: { workerId },
            sort: [{ startedAt: 'desc' }]
        });
    }

    /**
     * Count jobs by status for a tenant
     */
    async countByStatus(tenantId: string): Promise<Record<TranscriptionJobStatus, number>> {
        const counts: Record<TranscriptionJobStatus, number> = {
            [TranscriptionJobStatus.QUEUED]: 0,
            [TranscriptionJobStatus.PROCESSING]: 0,
            [TranscriptionJobStatus.COMPLETED]: 0,
            [TranscriptionJobStatus.FAILED]: 0,
            [TranscriptionJobStatus.CANCELLED]: 0,
            [TranscriptionJobStatus.DEAD]: 0,
        };

        const results = await (this as any).db.groupBy({
            by: ['status'],
            where: { tenantId },
            _count: { status: true }
        });

        for (const result of results) {
            counts[result.status as TranscriptionJobStatus] = result._count.status;
        }

        return counts;
    }

    /**
     * Find jobs in date range
     */
    async findByDateRange(
        tenantId: string,
        startDate: Date,
        endDate: Date
    ): Promise<TranscriptionJobEntity[]> {
        const models = await (this as any).db.findMany({
            where: {
                tenantId,
                createdAt: {
                    gte: startDate,
                    lte: endDate
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        return models.map((model: TranscriptionJob) => (this as any)._mapper.toDomainEntity(model));
    }

    /**
     * Find completed jobs for a consultation (latest first)
     */
    async findCompletedByConsultation(consultationId: string): Promise<TranscriptionJobEntity[]> {
        return this.findAll({
            filters: {
                consultationId,
                status: TranscriptionJobStatus.COMPLETED
            },
            sort: [{ completedAt: 'desc' }]
        });
    }
}
