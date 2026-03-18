import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { ConsultationEntityMapper } from '../../../mappers';
import { ConsultationEntity } from '../../../entities';
import { Consultation } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceStatusType } from '../../../enums';

@Injectable()
export class ConsultationRepository extends Repository<ConsultationEntity, Consultation> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'consultation', ConsultationEntityMapper.getInstance());
    }

    // ============================================
    // Custom Query Methods
    // ============================================

    /**
     * Find all consultations for a patient on a specific date
     */
    async findByPatientAndDate(
        tenantId: string,
        patientId: string,
        appointmentDate: Date
    ): Promise<ConsultationEntity[]> {
        return this.findAll({
            filters: {
                tenantId,
                patientId,
                appointmentDate,
                resourceStatus: ResourceStatusType.ENABLED
            },
            sort: [{ createdAt: 'asc' }]
        });
    }

    /**
     * Find the new-visit (first consultation) for patient on date
     */
    async findNewVisit(
        tenantId: string,
        patientId: string,
        appointmentDate: Date
    ): Promise<ConsultationEntity | null> {
        try {
            return await this.findFirst({
                filters: {
                    tenantId,
                    patientId,
                    appointmentDate,
                    parentConsultationId: null,
                    resourceStatus: ResourceStatusType.ENABLED
                }
            });
        } catch {
            return null;
        }
    }

    /**
     * Find consultation by unique constraint
     */
    async findByUniqueKey(
        tenantId: string,
        patientId: string,
        appointmentDate: Date,
        doctorId: string
    ): Promise<ConsultationEntity | null> {
        try {
            return await this.findFirst({
                filters: {
                    tenantId,
                    patientId,
                    appointmentDate,
                    doctorId,
                    resourceStatus: ResourceStatusType.ENABLED
                }
            });
        } catch {
            return null;
        }
    }

    /**
     * Find consultation with all context items
     */
    async findWithContext(consultationId: string): Promise<ConsultationEntity | null> {
        try {
            const model = await (this as any).db.findFirst({
                where: {
                    id: consultationId,
                    resourceStatus: ResourceStatusType.ENABLED
                },
                include: {
                    ContextItems: true
                }
            });
            if (!model) return null;
            return (this as any)._mapper.toDomainEntity(model);
        } catch {
            return null;
        }
    }

    /**
     * Find consultation with Doctor and Department relations
     */
    async findWithRelations(consultationId: string): Promise<ConsultationEntity | null> {
        try {
            const model = await (this as any).db.findFirst({
                where: {
                    id: consultationId,
                    resourceStatus: ResourceStatusType.ENABLED
                },
                include: {
                    Doctor: {
                        include: { UserProfile: true }
                    },
                    Department: true,
                    ContextItems: true
                }
            });
            if (!model) return null;
            return (this as any)._mapper.toDomainEntity(model);
        } catch {
            return null;
        }
    }

    /**
     * Find all consultations by natural key (allows multiple for re-visits)
     */
    async findAllByNaturalKey(
        tenantId: string,
        patientId: string,
        appointmentDate: Date,
        doctorId: string
    ): Promise<ConsultationEntity[]> {
        return this.findAll({
            filters: {
                tenantId,
                patientId,
                appointmentDate,
                doctorId,
                resourceStatus: ResourceStatusType.ENABLED
            },
            sort: [{ createdAt: 'desc' }]
        });
    }

    /**
     * Find consultations by doctor
     */
    async findByDoctor(
        tenantId: string,
        doctorId: string
    ): Promise<ConsultationEntity[]> {
        return this.findAll({
            filters: {
                tenantId,
                doctorId,
                resourceStatus: ResourceStatusType.ENABLED
            },
            sort: [{ createdAt: 'desc' }]
        });
    }

    /**
     * Find consultation chain (parent + all children) for context sharing
     */
    async findConsultationChain(consultationId: string): Promise<ConsultationEntity[]> {
        try {
            const consultation = await this.findById(consultationId);
            if (!consultation) return [];

            // Find the root (new-visit)
            const rootId = consultation.parentConsultationId || consultation.id;

            // Get all consultations in the chain using OR condition
            const models = await (this as any).db.findMany({
                where: {
                    OR: [
                        { id: rootId },
                        { parentConsultationId: rootId }
                    ],
                    resourceStatus: ResourceStatusType.ENABLED
                },
                orderBy: { createdAt: 'asc' }
            });

            return models.map((model: Consultation) => (this as any)._mapper.toDomainEntity(model));
        } catch {
            return [];
        }
    }

    /**
     * Find all re-visits for a parent consultation
     */
    async findRevisits(parentConsultationId: string): Promise<ConsultationEntity[]> {
        return this.findAll({
            filters: {
                parentConsultationId,
                resourceStatus: ResourceStatusType.ENABLED
            },
            sort: [{ createdAt: 'asc' }]
        });
    }

    /**
     * Paginated query with Doctor + Department relations included.
     * Used by listConsultations so the DTO mapper can populate doctor/department info.
     */
    async findPaginatedWithRelations(params: {
        filters: Record<string, unknown>;
        sort?: Record<string, 'asc' | 'desc'>[];
        page?: number;
        limit?: number;
    }): Promise<ConsultationEntity[]> {
        const { filters, sort, page = 1, limit = 10 } = params;

        const where: Record<string, unknown> = {
            ...filters,
            resourceStatus: filters.resourceStatus ?? ResourceStatusType.ENABLED,
        };

        const orderBy = sort?.map(s => {
            const [key, dir] = Object.entries(s)[0];
            return { [key]: dir };
        }) ?? [{ createdAt: 'desc' }];

        try {
            const models = await (this as any).db.findMany({
                where,
                include: {
                    Doctor: { include: { UserProfile: true } },
                    Department: true,
                },
                orderBy,
                skip: (page - 1) * limit,
                take: limit,
            });

            return models.map((model: Consultation) => (this as any)._mapper.toDomainEntity(model));
        } catch {
            return [];
        }
    }

    /**
     * Get distinct patient IDs that a doctor has consultations with.
     */
    async findDistinctPatientIds(tenantId: string, doctorId: string): Promise<string[]> {
        try {
            const results = await (this as any).db.findMany({
                where: {
                    tenantId,
                    doctorId,
                    resourceStatus: ResourceStatusType.ENABLED,
                },
                select: { patientId: true },
                distinct: ['patientId'],
            });
            return results.map((r: { patientId: string }) => r.patientId);
        } catch {
            return [];
        }
    }

    /**
     * Paginated query returning consultations the doctor owns OR that belong
     * to patients the doctor has a relationship with (shared-patient access).
     */
    async findPaginatedWithSharedAccess(params: {
        tenantId: string;
        doctorId: string;
        sharedPatientIds: string[];
        patientIdFilter?: string;
        sort?: Record<string, 'asc' | 'desc'>[];
        page?: number;
        limit?: number;
    }): Promise<ConsultationEntity[]> {
        const { tenantId, doctorId, sharedPatientIds, patientIdFilter, sort, page = 1, limit = 10 } = params;

        const orConditions: Record<string, unknown>[] = [{ doctorId }];
        if (sharedPatientIds.length > 0) {
            orConditions.push({ patientId: { in: sharedPatientIds } });
        }

        const where: Record<string, unknown> = {
            tenantId,
            resourceStatus: ResourceStatusType.ENABLED,
            OR: orConditions,
        };

        if (patientIdFilter) {
            where.patientId = patientIdFilter;
        }

        const orderBy = sort?.map(s => {
            const [key, dir] = Object.entries(s)[0];
            return { [key]: dir };
        }) ?? [{ createdAt: 'desc' }];

        try {
            const models = await (this as any).db.findMany({
                where,
                include: {
                    Doctor: { include: { UserProfile: true } },
                    Department: true,
                },
                orderBy,
                skip: (page - 1) * limit,
                take: limit,
            });
            return models.map((model: Consultation) => (this as any)._mapper.toDomainEntity(model));
        } catch {
            return [];
        }
    }

    /**
     * Count consultations the doctor owns OR that belong to shared patients.
     */
    async countWithSharedAccess(params: {
        tenantId: string;
        doctorId: string;
        sharedPatientIds: string[];
        patientIdFilter?: string;
    }): Promise<number> {
        const { tenantId, doctorId, sharedPatientIds, patientIdFilter } = params;

        const orConditions: Record<string, unknown>[] = [{ doctorId }];
        if (sharedPatientIds.length > 0) {
            orConditions.push({ patientId: { in: sharedPatientIds } });
        }

        const where: Record<string, unknown> = {
            tenantId,
            resourceStatus: ResourceStatusType.ENABLED,
            OR: orConditions,
        };

        if (patientIdFilter) {
            where.patientId = patientIdFilter;
        }

        try {
            return await (this as any).db.count({ where });
        } catch {
            return 0;
        }
    }

    /**
     * Find consultations by date range
     */
    async findByDateRange(
        tenantId: string,
        startDate: Date,
        endDate: Date
    ): Promise<ConsultationEntity[]> {
        const models = await (this as any).db.findMany({
            where: {
                tenantId,
                appointmentDate: {
                    gte: startDate,
                    lte: endDate
                },
                resourceStatus: ResourceStatusType.ENABLED
            },
            orderBy: [
                { appointmentDate: 'asc' },
                { createdAt: 'asc' }
            ]
        });

        return models.map((model: Consultation) => (this as any)._mapper.toDomainEntity(model));
    }
}
