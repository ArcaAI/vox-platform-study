import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { ConsultationEntityMapper } from '../../../mappers';
import { ConsultationEntity } from '../../../entities';
import { Consultation } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ConsultationProcessing, ConsultationStatus, ResourceStatusType } from '../../../enums';
import { ArgumentInvalidException, DataNotFoundException } from '@arcaai/exceptions';
import { Prisma } from '@arcaai/database';

/** The open key: one non-closed consultation per (tenant, doctor, patient, department). */
export interface ConsultationOpenKey {
  tenantId: string;
  doctorId: string;
  patientId: string;
  departmentId?: string | null;
}

const CLOSED_STATUSES: ConsultationStatus[] = [ConsultationStatus.CLOSED_COMPLETE, ConsultationStatus.CLOSED_INCOMPLETE];

/** Rows one auto-close sweep call reads at most. */
const AUTO_CLOSE_BATCH_LIMIT = 200;

function openKeyFilters(key: ConsultationOpenKey): Record<string, unknown> {
  return {
    tenantId: key.tenantId,
    doctorId: key.doctorId,
    patientId: key.patientId,
    departmentId: key.departmentId ?? null,
  };
}

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
   * The LEGACY open key `(tenantId, patientId, appointmentDate, doctorId)` — the newest match, or
   * `null`. TASK-1020 D-6: sorted newest first (a day may hold several rows for one doctor, and
   * "whichever Postgres returned first" is not an answer), and only a genuine MISS reads as `null`
   * — every other failure propagates, because swallowing an outage here turned it into a silently
   * duplicated consultation.
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
        sort: [{ createdAt: 'desc' }],
      });
    } catch (error) {
      if (error instanceof DataNotFoundException) return null;
      throw error;
    }
  }

  /**
   * TASK-1020 D-2 — every ENABLED consultation of the tenant carrying the caller's encounter id,
   * newest first. Deliberately NOT narrowed by patient or doctor: `open` matches its own
   * `(patient, doctor)` row out of this set, and must also SEE a same-ref row that belongs to
   * another patient in order to refuse it (409 `EXTERNAL_REF_CONFLICT`).
   */
  async findByExternalRef(tenantId: string, externalRef: string): Promise<ConsultationEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        externalRef,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ createdAt: 'desc' }],
    });
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
   * Consultations whose draft waits for the clinician (the harness gate
   * queue): STOPPED with `processing = AWAITING_REVIEW`, oldest first so the
   * longest-waiting item leads. Backs `HarnessObservabilityService.gateQueue`.
   */
  async findPendingReviewForTenant(tenantId: string): Promise<ConsultationEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        status: ConsultationStatus.STOPPED,
        processing: ConsultationProcessing.AWAITING_REVIEW,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ updatedAt: 'asc' }],
    });
  }

  /**
   * The one non-closed consultation of the OPEN KEY `(tenantId, doctorId,
   * patientId, departmentId)` — `departmentId` matched null-safely (an absent
   * department matches only rows with none). The partial unique index
   * `Consultation_openKey_uq` guarantees at most one; newest first is a
   * tie-break for rows written before the index existed. `null` on a miss.
   */
  async findOpenByKey(key: ConsultationOpenKey): Promise<ConsultationEntity | null> {
    return this.findFirstOrNull({
      filters: {
        ...openKeyFilters(key),
        status: { notIn: CLOSED_STATUSES },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  /**
   * The newest CLOSED consultation of the same open key — the parent a new
   * consultation is chained to when no non-closed one exists. `null` on a miss.
   */
  async findLatestClosedByKey(key: ConsultationOpenKey): Promise<ConsultationEntity | null> {
    return this.findFirstOrNull({
      filters: {
        ...openKeyFilters(key),
        status: { in: CLOSED_STATUSES },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  /**
   * Every non-closed consultation whose `lastActivityAt` is older than
   * `cutoff`, oldest first, capped at `limit` (default 200) rows per call.
   * Backs the auto-close sweep, which applies each tenant's own window on
   * top of this (the cutoff is the loosest window it serves).
   *
   * Cross-tenant unless `tenantId` is given: the sweep runs with no CLS tenant
   * context (a platform-wide maintenance tick).
   */
  async findAutoCloseEligible(cutoff: Date, options: { tenantId?: string; limit?: number } = {}): Promise<ConsultationEntity[]> {
    return this.findAll({
      filters: {
        ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        status: { notIn: CLOSED_STATUSES },
        lastActivityAt: { lt: cutoff },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ lastActivityAt: 'asc' }],
      page: 1,
      limit: options.limit ?? AUTO_CLOSE_BATCH_LIMIT,
    });
  }

  /**
   * Consultations sitting in RECORDING with no capture activity since
   * `cutoff` (`lastActivityAt`, which segment ingest and the capture
   * heartbeat advance), oldest first. Backs the stale-recording auto-pause.
   * Deliberately cross-tenant, like {@link findAutoCloseEligible}.
   */
  async findStaleRecording(cutoff: Date): Promise<ConsultationEntity[]> {
    return this.findAll({
      filters: {
        status: ConsultationStatus.RECORDING,
        lastActivityAt: { lt: cutoff },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ lastActivityAt: 'asc' }],
    });
  }

  // ============================================
  // No-version-bump writers
  // ============================================
  //
  // Activity, processing and cursor columns change constantly while a
  // consultation is live. They are written here WITHOUT touching `_version`,
  // so a client's If-Match stays valid across that churn; `updateWithVersion`
  // remains the only OCC path (status transitions, metadata edits).

  /**
   * Move `lastActivityAt` forward to `at` (never backwards).
   * @returns `true` when the row moved.
   */
  async touchActivity(id: string, at: Date = new Date(), tx?: Prisma.TransactionClient | any): Promise<boolean> {
    const result = await this.delegate(tx).updateMany({
      where: { id, lastActivityAt: { lt: at } },
      data: { lastActivityAt: at },
    });
    return result.count > 0;
  }

  /**
   * Set the processing axis. `processingReason` follows the entity rule (kept
   * only on FAILED / AWAITING_REVIEW); `refs` / `prior` are written only when
   * supplied (`null` clears `prior`).
   * @returns `true` when the row was found.
   */
  async setProcessing(
    id: string,
    processing: ConsultationProcessing,
    options: { reason?: string | null; refs?: string[]; prior?: ConsultationProcessing | null } = {},
    tx?: Prisma.TransactionClient | any,
  ): Promise<boolean> {
    const data: Record<string, unknown> = {
      processing,
      processingReason: ConsultationEntity.processingReasonFor(processing, options.reason),
      processingUpdatedAt: new Date(),
    };
    if (options.refs !== undefined) data.processingRefs = options.refs;
    if (options.prior !== undefined) data.processingPrior = options.prior;

    const result = await this.delegate(tx).updateMany({ where: { id }, data });
    return result.count > 0;
  }

  /**
   * Atomically reserve `count` consecutive transcript segment sequence numbers
   * (`segmentSeqHead += count`).
   * @returns the reserved inclusive range.
   */
  async allocateSegmentSeqs(id: string, count: number, tx?: Prisma.TransactionClient | any): Promise<{ first: number; last: number }> {
    if (!Number.isInteger(count) || count < 1) {
      throw new ArgumentInvalidException(`allocateSegmentSeqs: count must be a positive integer (got ${count})`);
    }
    const row = await this.delegate(tx).update({
      where: { id },
      data: { segmentSeqHead: { increment: count } },
      select: { segmentSeqHead: true },
    });
    return { first: row.segmentSeqHead - count + 1, last: row.segmentSeqHead };
  }

  /**
   * Atomically advance the consultation-wide recording timeline by `deltaMs`
   * (`recordingCursorMs += deltaMs`).
   * @returns where the appended span sits on the timeline.
   */
  async advanceRecordingCursor(id: string, deltaMs: number, tx?: Prisma.TransactionClient | any): Promise<{ startMs: number; endMs: number }> {
    if (!Number.isInteger(deltaMs) || deltaMs < 0) {
      throw new ArgumentInvalidException(`advanceRecordingCursor: deltaMs must be a non-negative integer (got ${deltaMs})`);
    }
    const row = await this.delegate(tx).update({
      where: { id },
      data: { recordingCursorMs: { increment: deltaMs } },
      select: { recordingCursorMs: true },
    });
    return { startMs: row.recordingCursorMs - deltaMs, endMs: row.recordingCursorMs };
  }

  private delegate(tx?: Prisma.TransactionClient | any): any {
    return tx ? (tx as Record<string, any>).consultation : (this as any).db;
  }

  private async findFirstOrNull(props: Parameters<ConsultationRepository['findFirst']>[0]): Promise<ConsultationEntity | null> {
    try {
      return await this.findFirst(props);
    } catch (error) {
      if (error instanceof DataNotFoundException) return null;
      throw error;
    }
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
