import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
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
import {
  OpenConsultationRequest,
  UpdateConsultationRequest,
  ConsultationResponse,
  PaginatedConsultationResponse,
  CONSULTATION_STATUS,
  ConsultationLifecycleStatus,
} from './dto';
import { ConsultationDtoMapper } from './consultation.dto.mapper';
import { BaseService, assertEqualTenants, assertParentInScope, assertUserBelongsToTenant } from '../../../common';
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
   *
   * TASK-306 P2.1 (audit C-1 / AC-8) — defense-in-depth: the Prisma
   * `tenantScope` extension already filters foreign-tenant rows on
   * `findWithContext`, but an explicit service-layer assert provides a
   * second line so the method still refuses to leak data if the
   * extension is ever bypassed (raw query, platform-admin path, stale
   * CLS in a background job). `assertEqualTenants` throws a generic
   * `NotFoundException('Resource not found')` on mismatch — no model /
   * id echo — and `BadRequestException` when CLS has no tenant.
   *
   * TASK-306 W5.7.7 (306-F5) — the missing-CLS check is hoisted to the
   * top of the method so unprovisioned background calls fail closed
   * BEFORE the repo round-trip, matching the `getConsultationChain`
   * convention.
   */
  async getById(id: string): Promise<ConsultationResponse | null> {
    if (!this.tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithContext(id);
    if (!consultation) return null;

    assertEqualTenants(consultation, { tenantId: this.tenantId });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: consultation.id,
      data: { id: consultation.id },
    });

    return ConsultationDtoMapper.toResponseWithContext(consultation);
  }

  /**
   * Get consultation by ID with all relations (Doctor, Department, Context)
   *
   * TASK-306 P2.1 (audit C-1 / AC-8) — defense-in-depth: same posture as
   * `getById`. The Prisma `tenantScope` extension filters foreign-tenant
   * rows on `findWithRelations`, but the service-layer assert provides
   * an explicit second line on PHI relations so an extension bypass or
   * stale-CLS background call still fails closed with a generic
   * `NotFoundException('Resource not found')`.
   *
   * TASK-306 W5.7.7 (306-F5) — the missing-CLS check is hoisted to the
   * top of the method (same posture as `getById`); the relations join
   * is more expensive than a single-row read, so the saved round-trip
   * is even more useful here.
   */
  async getByIdWithRelations(id: string): Promise<ConsultationResponse | null> {
    if (!this.tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) return null;

    assertEqualTenants(consultation, { tenantId: this.tenantId });

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
   *
   * TASK-306 P2.1 (audit C-1 / AC-8) — defense-in-depth: unlike the two
   * single-id reads, the chain query joins by `parentConsultationId` and
   * can in principle return rows from multiple tenants if the FK was
   * ever poisoned cross-tenant (or the Prisma extension is bypassed).
   *
   * The service therefore:
   *   1. Fails closed when CLS has no tenant (no background reads).
   *   2. Filters the returned chain to the caller's tenant BEFORE
   *      mapping to DTO so foreign-tenant rows are never serialised.
   *   3. Throws `NotFoundException` when the repo did return rows but
   *      NONE belong to the caller — returning `[]` in that case would
   *      leak existence by absence (caller learns the chain root is
   *      visible to *someone*, just not them).
   */
  async getConsultationChain(consultationId: string): Promise<ConsultationResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultations = await this.consultationRepository.findConsultationChain(consultationId);

    const inTenant = consultations.filter((c) => c.tenantId === tenantId);

    if (consultations.length > 0 && inTenant.length === 0) {
      throw new NotFoundException('Resource not found');
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { consultationId, chainCount: inTenant.length },
    });

    return inTenant.map((c) => ConsultationDtoMapper.toResponse(c));
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

  /**
   * TASK-319 F1 — admin/tenant-wide listing.
   *
   * Lists EVERY consultation in the caller's tenant (no owner/shared-patient
   * scoping). Reached only from the admin surface (`/admin/consultations`,
   * gated by `@CanManage('Consultation')`). Tenant isolation is still enforced
   * by the `tenantScopeFilter` Prisma extension, so the explicit `tenantId`
   * filter here is defense-in-depth.
   */
  async listConsultationsForTenant(params: {
    page: number;
    pageSize: number;
    patientId?: string;
    doctorId?: string;
    departmentId?: string;
  }): Promise<PaginatedConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const { page, pageSize, patientId, doctorId, departmentId } = params;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filters: any = { tenantId };
    if (patientId) filters.patientId = patientId;
    if (doctorId) filters.doctorId = doctorId;
    if (departmentId) filters.departmentId = departmentId;

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
      data: { scope: 'tenant', page, pageSize, patientId, doctorId, departmentId, count },
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

  // ============================================
  // TASK-322 — Lifecycle (close / reopen / update)
  //
  // The Consultation model has no dedicated open/closed column, so the
  // lifecycle status lives in `metadata.status` (OPEN | CLOSED; absent ⇒
  // OPEN) and is surfaced via `ConsultationResponse.status`. close/reopen
  // are idempotent — when the consultation is already in the target state
  // they short-circuit with NO write and NO SysEvent (avoids version churn
  // and audit noise on UI double-clicks / retries).
  // ============================================

  /**
   * Read the current lifecycle status from an entity's metadata.
   * Absent / unrecognised ⇒ treated as OPEN.
   */
  private readStatus(metadata: Record<string, unknown> | null | undefined): ConsultationLifecycleStatus {
    return (metadata?.status as ConsultationLifecycleStatus | undefined) ?? CONSULTATION_STATUS.OPEN;
  }

  /**
   * Shared close/reopen path. Loads the consultation (tenant-asserted as
   * defense-in-depth on top of the Prisma tenantScope extension), and if a
   * transition is needed, writes the new `metadata.status` (+ audit
   * timestamp) and broadcasts `ResourceUpdated`.
   */
  private async transitionStatus(
    id: string,
    target: ConsultationLifecycleStatus,
    action: 'closeConsultation' | 'reopenConsultation',
  ): Promise<ConsultationResponse> {
    if (!this.tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId: this.tenantId });

    const currentMeta = (consultation.metadata as Record<string, unknown> | null) ?? {};
    const currentStatus = this.readStatus(currentMeta);

    // Idempotent: already in the target state → return current state untouched.
    if (currentStatus === target) {
      return ConsultationDtoMapper.toResponseWithContext(consultation);
    }

    const timestampKey = target === CONSULTATION_STATUS.CLOSED ? 'closedAt' : 'reopenedAt';
    consultation.metadata = {
      ...currentMeta,
      status: target,
      [timestampKey]: new Date().toISOString(),
    } as Parameters<typeof ConsultationFactory.CreateNewVisit>[0]['metadata'];
    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }

    await this.consultationRepository.update(id, consultation);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action, status: target },
    });

    return ConsultationDtoMapper.toResponseWithContext(consultation);
  }

  /**
   * Close a consultation (transition lifecycle status to CLOSED). Idempotent.
   */
  async closeConsultation(id: string): Promise<ConsultationResponse> {
    return this.transitionStatus(id, CONSULTATION_STATUS.CLOSED, 'closeConsultation');
  }

  /**
   * Reopen a consultation (transition lifecycle status back to OPEN). Idempotent.
   */
  async reopenConsultation(id: string): Promise<ConsultationResponse> {
    return this.transitionStatus(id, CONSULTATION_STATUS.OPEN, 'reopenConsultation');
  }

  /**
   * Update safely-mutable fields of an existing consultation.
   *
   * Allowed: `appointmentDate`, `departmentId` (tenant-checked, audit C-2),
   * `metadata` (shallow-merged so other keys / lifecycle status are preserved),
   * and `status` (written into metadata.status). Identity / ownership fields
   * (`patientId`, `doctorId`, `tenantId`) and `parentConsultationId` are NOT
   * mutable here.
   */
  async updateConsultation(id: string, request: UpdateConsultationRequest): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });

    // Audit C-2 — a re-assigned department must live in the caller's tenant.
    // `assertParentInScope` throws NotFoundException on miss / cross-tenant.
    if (request.departmentId) {
      await assertParentInScope(this.departmentRepository, request.departmentId, tenantId);
    }

    if (request.appointmentDate !== undefined) {
      consultation.appointmentDate = new Date(request.appointmentDate);
    }
    if (request.departmentId !== undefined) {
      consultation.departmentId = request.departmentId;
    }

    const currentMeta = (consultation.metadata as Record<string, unknown> | null) ?? {};
    let nextMeta: Record<string, unknown> = { ...currentMeta };
    if (request.metadata !== undefined) {
      nextMeta = { ...nextMeta, ...request.metadata };
    }
    if (request.status !== undefined) {
      nextMeta.status = request.status;
    }
    consultation.metadata = nextMeta as Parameters<typeof ConsultationFactory.CreateNewVisit>[0]['metadata'];

    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }

    await this.consultationRepository.update(id, consultation);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'updateConsultation', fields: Object.keys(request ?? {}) },
    });

    return ConsultationDtoMapper.toResponseWithContext(consultation);
  }
}
