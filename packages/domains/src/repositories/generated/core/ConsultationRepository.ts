import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { ConsultationEntityMapper } from '../../../mappers';
import { ConsultationEntity } from '../../../entities';
import { Consultation } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ConsultationStatus, ResourceStatusType } from '../../../enums';

@Injectable()
export class ConsultationRepository extends Repository<ConsultationEntity, Consultation> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'consultation', ConsultationEntityMapper.getInstance());
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find all consultations for a patient on a specific date
   */
  async findByPatientAndDate(tenantId: string, patientId: string, appointmentDate: Date): Promise<ConsultationEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        patientId,
        appointmentDate,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ createdAt: 'asc' }],
    });
  }

  /**
   * Find the new-visit (first consultation) for patient on date
   */
  async findNewVisit(tenantId: string, patientId: string, appointmentDate: Date): Promise<ConsultationEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          tenantId,
          patientId,
          appointmentDate,
          parentConsultationId: null,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch {
      return null;
    }
  }

  /**
   * Find consultation by unique constraint
   */
  async findByUniqueKey(tenantId: string, patientId: string, appointmentDate: Date, doctorId: string): Promise<ConsultationEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          tenantId,
          patientId,
          appointmentDate,
          doctorId,
          resourceStatus: ResourceStatusType.ENABLED,
        },
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
          resourceStatus: ResourceStatusType.ENABLED,
        },
        include: {
          ContextItems: true,
        },
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
          resourceStatus: ResourceStatusType.ENABLED,
        },
        include: {
          Doctor: {
            include: { UserProfile: true },
          },
          Department: true,
          ContextItems: true,
        },
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
  async findAllByNaturalKey(tenantId: string, patientId: string, appointmentDate: Date, doctorId: string): Promise<ConsultationEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        patientId,
        appointmentDate,
        doctorId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  /**
   * Find consultations by doctor
   */
  async findByDoctor(tenantId: string, doctorId: string): Promise<ConsultationEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        doctorId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  /**
   * Find the full consultation chain (structural root + every descendant, multi-hop)
   * for context sharing. Walks the entire `parentConsultationId` tree rather than a
   * single level, and is guarded against cycles. Only ENABLED nodes are returned.
   */
  async findConsultationChain(consultationId: string): Promise<ConsultationEntity[]> {
    try {
      const start: Consultation | null = await (this as any).db.findFirst({ where: { id: consultationId } });
      if (!start) return [];

      // 1. Climb to the structural root via parentConsultationId (cycle-guarded).
      const climbVisited = new Set<string>();
      let root: Consultation = start;
      while (root.parentConsultationId && !climbVisited.has(root.id)) {
        climbVisited.add(root.id);
        const parent: Consultation | null = await (this as any).db.findFirst({
          where: { id: root.parentConsultationId },
        });
        if (!parent) break;
        root = parent;
      }

      // 2. Breadth-first collect every ENABLED descendant across all hops (cycle-guarded).
      const collected = new Map<string, Consultation>();
      const visited = new Set<string>([root.id]);

      const rootModel: Consultation | null = await (this as any).db.findFirst({
        where: { id: root.id, resourceStatus: ResourceStatusType.ENABLED },
      });
      if (rootModel) collected.set(rootModel.id, rootModel);

      let frontier: string[] = [root.id];
      while (frontier.length > 0) {
        const children: Consultation[] = await (this as any).db.findMany({
          where: {
            parentConsultationId: { in: frontier },
            resourceStatus: ResourceStatusType.ENABLED,
          },
        });
        const next: string[] = [];
        for (const child of children) {
          if (!visited.has(child.id)) {
            visited.add(child.id);
            collected.set(child.id, child);
            next.push(child.id);
          }
        }
        frontier = next;
      }

      // 3. Order by createdAt ascending and map to domain entities.
      const models = Array.from(collected.values()).sort(
        (a, b) => new Date(a.createdAt as unknown as string).getTime() - new Date(b.createdAt as unknown as string).getTime(),
      );
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
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ createdAt: 'asc' }],
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

    const orderBy = sort?.map((s) => {
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

    const orderBy = sort?.map((s) => {
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
  async countWithSharedAccess(params: { tenantId: string; doctorId: string; sharedPatientIds: string[]; patientIdFilter?: string }): Promise<number> {
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
   * Consultations awaiting clinician review (the harness gate queue), oldest
   * first so the longest-waiting item leads. Backs
   * `HarnessObservabilityService.gateQueue`; SLA/escalation is computed in the
   * service from the effective policy + the audit trail.
   */
  async findPendingReviewForTenant(tenantId: string): Promise<ConsultationEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        status: ConsultationStatus.PENDING_REVIEW,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ updatedAt: 'asc' }],
    });
  }

  /**
   * TASK-711 — consultations whose gate SLA was exhausted (PENDING_REVIEW →
   * TIMED_OUT, `recordEscalation`'s terminal `GATE_ABANDONED` path), oldest
   * first. A sibling to `findPendingReviewForTenant`: rows that time out must
   * NOT silently drop out of the gate-queue surface — this is the explicit
   * dedicated read state-machine.md/README §3.3 pitfall 5 calls for, rather
   * than widening the PENDING_REVIEW filter to include TIMED_OUT.
   */
  async findTimedOutForTenant(tenantId: string): Promise<ConsultationEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        status: ConsultationStatus.TIMED_OUT,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ updatedAt: 'asc' }],
    });
  }

  /**
   * Minimal projection of consultations created inside
   * [rangeStart, rangeEnd] (inclusive), for the new-vs-
   * revisit range aggregation. Rows are returned raw (`createdAt` +
   * `parentConsultationId` only) — the service zero-fills and buckets them,
   * so no entity mapping happens here. `tenantId` is applied ONLY when
   * truthy: a SUPER_ADMIN with no working tenant reads cross-tenant (TD3).
   */
  async findCreatedInRange(
    rangeStart: Date,
    rangeEnd: Date,
    tenantId?: string | null,
  ): Promise<Array<{ createdAt: Date; parentConsultationId: string | null }>> {
    const where: Record<string, unknown> = { createdAt: { gte: rangeStart, lte: rangeEnd } };
    if (tenantId) where.tenantId = tenantId;

    return await (this as any).db.findMany({
      where,
      select: { createdAt: true, parentConsultationId: true },
    });
  }

  /**
   * Find consultations by date range
   */
  async findByDateRange(tenantId: string, startDate: Date, endDate: Date): Promise<ConsultationEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        tenantId,
        appointmentDate: {
          gte: startDate,
          lte: endDate,
        },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: [{ appointmentDate: 'asc' }, { createdAt: 'asc' }],
    });

    return models.map((model: Consultation) => (this as any)._mapper.toDomainEntity(model));
  }
}
