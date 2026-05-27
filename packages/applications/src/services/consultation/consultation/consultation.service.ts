import { Injectable, BadRequestException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ConsultationRepository,
  ConsultationFactory,
  DepartmentRepository,
  ResourceType,
  SysEventType,
  UserRoleAssignmentRepository,
} from '@arcaai/domains';
import { IConsultationService } from './IConsultationService';
import { OpenConsultationRequest, ConsultationResponse, PaginatedConsultationResponse } from './dto';
import { ConsultationDtoMapper } from './consultation.dto.mapper';
import { BaseService, assertParentInScope, assertUserBelongsToTenant } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

/**
 * Consultation Service
 *
 * Simplified workflow using natural key (patientId, doctorId, appointmentDate)
 */
@Injectable()
export class ConsultationService extends BaseService implements IConsultationService {
  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly departmentRepository: DepartmentRepository,
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  /**
   * TASK-305 D.2 (audit C-1 / C-2 / C-4) — assert every cross-aggregate
   * reference on a Consultation write lives in the caller's tenant before
   * any factory or repository call runs:
   *
   *   - `doctorId`           — User must hold an ENABLED UserRoleAssignment
   *                            in `tenantId` (defense vs. audit C-1).
   *   - `departmentId`       — Department row must be tenant-scoped to
   *                            `tenantId` (defense vs. audit C-2).
   *   - `parentConsultationId` — Parent Consultation must live in the same
   *                              tenant (defense vs. audit C-4 / B-3).
   *
   * All helpers route failures through `NotFoundException` to avoid leaking
   * the existence of a cross-tenant resource. SUPER_ADMIN is intentionally
   * NOT bypassed — assigning consultations to users / departments / parents
   * outside the tenant would produce a structurally invalid aggregate
   * regardless of caller role (mirrors the D.6 DepartmentService rule).
   */
  private async assertCrossAggregateRefsInTenant(
    tenantId: string,
    refs: {
      doctorId: string;
      departmentId?: string | null;
      parentConsultationId?: string | null;
    },
  ): Promise<void> {
    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, refs.doctorId, tenantId);

    if (refs.departmentId) {
      await assertParentInScope(this.departmentRepository, refs.departmentId, tenantId);
    }

    if (refs.parentConsultationId) {
      await assertParentInScope(this.consultationRepository, refs.parentConsultationId, tenantId);
    }
  }

  /**
   * Get or create consultation for (patientId, doctorId, appointmentDate)
   *
   * - If consultation exists: returns existing
   * - If not: creates new consultation
   */
  async getOrCreate(request: OpenConsultationRequest, doctorId: string): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    await this.assertCrossAggregateRefsInTenant(tenantId, {
      doctorId,
      departmentId: request.departmentId,
      parentConsultationId: request.parentConsultationId,
    });

    // Use today's date if not provided
    const appointmentDate = request.appointmentDate ? new Date(request.appointmentDate) : new Date(new Date().toISOString().split('T')[0]); // Today, no time

    // Try to find existing consultation (first one if multiple exist)
    const existing = await this.consultationRepository.findByUniqueKey(tenantId, request.patientId, appointmentDate, doctorId);

    if (existing) {
      this.broadcastSysEvent(SysEventType.ResourceViewed, {
        resourceId: existing.id,
        data: { action: 'getOrCreate', found: true },
      });
      const withRelations = await this.consultationRepository.findWithRelations(existing.id);
      return ConsultationDtoMapper.toResponse(withRelations ?? existing, false);
    }

    // Create new consultation
    const consultation = ConsultationFactory.CreateNewVisit({
      tenantId,
      patientId: request.patientId,
      appointmentDate,
      doctorId,
      departmentId: request.departmentId,
      metadata: request.metadata as Parameters<typeof ConsultationFactory.CreateNewVisit>[0]['metadata'],
      createdBy: userId ?? undefined,
    });

    // If parentConsultationId provided, set it (for re-visits/referrals)
    if (request.parentConsultationId) {
      consultation.parentConsultationId = request.parentConsultationId;
    }

    const saved = await this.consultationRepository.create(consultation);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { action: 'getOrCreate', created: true },
    });

    const savedWithRelations = await this.consultationRepository.findWithRelations(saved.id);
    return ConsultationDtoMapper.toResponse(savedWithRelations ?? saved, true);
  }

  /**
   * Create a re-visit/follow-up consultation
   */
  async createRevisit(request: OpenConsultationRequest, doctorId: string, parentConsultationId: string): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // TASK-305 D.2 — verify all cross-aggregate refs (parent, department,
    // doctor) live in the caller's tenant before any factory call. The
    // helper throws NotFoundException on miss / cross-tenant to keep this
    // behaviour indistinguishable from "resource does not exist".
    await this.assertCrossAggregateRefsInTenant(tenantId, {
      doctorId,
      departmentId: request.departmentId,
      parentConsultationId,
    });

    const appointmentDate = request.appointmentDate ? new Date(request.appointmentDate) : new Date(new Date().toISOString().split('T')[0]);

    const consultation = ConsultationFactory.CreateRevisit({
      tenantId,
      patientId: request.patientId,
      appointmentDate,
      doctorId,
      departmentId: request.departmentId,
      parentConsultationId,
      metadata: request.metadata as Parameters<typeof ConsultationFactory.CreateRevisit>[0]['metadata'],
      createdBy: userId ?? undefined,
    });

    const saved = await this.consultationRepository.create(consultation);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { action: 'createRevisit', parentId: parentConsultationId },
    });

    return ConsultationDtoMapper.toResponse(saved, true);
  }

  /**
   * Get consultation by ID with context
   */
  async getById(id: string): Promise<ConsultationResponse | null> {
    const consultation = await this.consultationRepository.findWithContext(id);
    if (!consultation) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: consultation.id,
      data: { id: consultation.id },
    });

    return ConsultationDtoMapper.toResponseWithContext(consultation);
  }

  /**
   * Get consultation by ID with all relations (Doctor, Department, Context)
   */
  async getByIdWithRelations(id: string): Promise<ConsultationResponse | null> {
    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: consultation.id,
      data: { id: consultation.id, withRelations: true },
    });

    return ConsultationDtoMapper.toResponseWithContext(consultation);
  }

  /**
   * Get all consultations for a patient (across all dates and doctors)
   */
  async getPatientHistory(patientId: string): Promise<ConsultationResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultations = await this.consultationRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId, patientId } as any,
      sort: [{ appointmentDate: 'desc' }],
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { patientId, historyCount: consultations.length },
    });

    return consultations.map((c) => ConsultationDtoMapper.toResponse(c));
  }

  /**
   * Get all consultations for a patient on a specific date (all doctors)
   */
  async getByPatientAndDate(patientId: string, date: string): Promise<ConsultationResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultations = await this.consultationRepository.findByPatientAndDate(tenantId, patientId, new Date(date));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { patientId, date, count: consultations.length },
    });

    return consultations.map((c) => ConsultationDtoMapper.toResponse(c));
  }

  /**
   * Get consultation chain (parent + all children)
   */
  async getConsultationChain(consultationId: string): Promise<ConsultationResponse[]> {
    const consultations = await this.consultationRepository.findConsultationChain(consultationId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { consultationId, chainCount: consultations.length },
    });

    return consultations.map((c) => ConsultationDtoMapper.toResponse(c));
  }

  /**
   * Get paginated consultation history for a patient.
   *
   * Uses the repository's findAll with skip/take for efficient DB-level pagination.
   */
  async getPatientHistoryPaginated(patientId: string, page: number, limit: number): Promise<PaginatedConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const [consultations, count] = await Promise.all([
      this.consultationRepository.findPaginatedWithRelations({
        filters: { tenantId, patientId },
        sort: [{ appointmentDate: 'desc' }],
        page,
        limit,
      }),
      this.consultationRepository.count({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filters: { tenantId, patientId } as any,
      }),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { patientId, page, limit, count },
    });

    return {
      data: consultations.map((c) => ConsultationDtoMapper.toResponse(c)),
      count,
      page,
      limit,
    };
  }

  /**
   * Get paginated consultations for a patient on a specific date.
   *
   * Since same-day consultations are typically a small set, this still
   * fetches all and paginates in memory. For extremely large result sets,
   * a dedicated repository method with skip/take would be preferred.
   */
  async getByPatientAndDatePaginated(patientId: string, date: string, page: number, limit: number): Promise<PaginatedConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const allConsultations = await this.consultationRepository.findByPatientAndDate(tenantId, patientId, new Date(date));

    const count = allConsultations.length;
    const skip = (page - 1) * limit;
    const pageData = allConsultations.slice(skip, skip + limit);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { patientId, date, page, limit, count },
    });

    return {
      data: pageData.map((c) => ConsultationDtoMapper.toResponse(c)),
      count,
      page,
      limit,
    };
  }

  /**
   * List consultations the doctor owns plus consultations from other
   * doctors for patients the doctor has a relationship with (shared-patient
   * access for continuity of care).
   */
  async listConsultations(params: { page: number; pageSize: number; doctorId?: string; patientId?: string }): Promise<PaginatedConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const { page, pageSize, doctorId, patientId } = params;

    if (doctorId) {
      const sharedPatientIds = await this.consultationRepository.findDistinctPatientIds(tenantId, doctorId);

      const [consultations, count] = await Promise.all([
        this.consultationRepository.findPaginatedWithSharedAccess({
          tenantId,
          doctorId,
          sharedPatientIds,
          patientIdFilter: patientId,
          sort: [{ appointmentDate: 'desc' }],
          page,
          limit: pageSize,
        }),
        this.consultationRepository.countWithSharedAccess({
          tenantId,
          doctorId,
          sharedPatientIds,
          patientIdFilter: patientId,
        }),
      ]);

      this.broadcastSysEvent(SysEventType.ResourceViewed, {
        data: { page, pageSize, doctorId, patientId, count },
      });

      return {
        data: consultations.map((c) => ConsultationDtoMapper.toResponse(c)),
        count,
        page,
        limit: pageSize,
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filters: any = { tenantId };
    if (patientId) filters.patientId = patientId;

    const [consultations, count] = await Promise.all([
      this.consultationRepository.findPaginatedWithRelations({
        filters,
        sort: [{ appointmentDate: 'desc' }],
        page,
        limit: pageSize,
      }),
      this.consultationRepository.count({ filters }),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { page, pageSize, doctorId, patientId, count },
    });

    return {
      data: consultations.map((c) => ConsultationDtoMapper.toResponse(c)),
      count,
      page,
      limit: pageSize,
    };
  }

  async doctorHasPatientRelationship(doctorId: string, patientId: string, tenantId: string): Promise<boolean> {
    const count = await this.consultationRepository.count({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId, doctorId, patientId } as any,
    });
    return count > 0;
  }
}
