import { Injectable, BadRequestException, NotFoundException, Inject, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ConsultationRepository,
  ConsultationFactory,
  ConsultationStatus,
  DepartmentRepository,
  ResourceType,
  SysEventType,
  UserDepartmentRepository,
  UserRepository,
  UserRoleAssignmentRepository,
} from '@arcaai/domains';
import { IConsultationService } from './IConsultationService';
import {
  OpenConsultationRequest,
  UpdateConsultationRequest,
  ConsultationResponse,
  ConsultationAggregateResponse,
  PaginatedConsultationResponse,
  CONSULTATION_STATUS,
  ConsultationLifecycleStatus,
} from './dto';
import { ConsultationDtoMapper } from './consultation.dto.mapper';
import { BaseService, assertEqualTenants, assertParentInScope, assertUserBelongsToTenant, isSuperAdmin } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';

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
    // Membership is role + department; the guard needs the
    // department join table and the User table (service-account exemption).
    private readonly userDepartmentRepository: UserDepartmentRepository,
    private readonly userRepository: UserRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional (append-only DI); enforces the plan
    // `monthlyConsultations` meter when STARTING a new consultation
    // (kill-switch-gated, → 429 when over the rolling-monthly cap).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  /**
   * (audit C-1 / C-2 / C-4) — assert every cross-aggregate
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
    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, this.userDepartmentRepository, this.userRepository, refs.doctorId, tenantId);

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

    // A genuinely NEW consultation consumes a monthly
    // meter unit. Only the create branch is metered (returning an existing
    // consultation does not). Kill-switch-gated; → 429 when over the cap.
    await this.entitlements?.assertMeterQuota(tenantId, 'monthlyConsultations');

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

    // Verify all cross-aggregate refs (parent, department,
    // doctor) live in the caller's tenant before any factory call. The
    // helper throws NotFoundException on miss / cross-tenant to keep this
    // behaviour indistinguishable from "resource does not exist".
    await this.assertCrossAggregateRefsInTenant(tenantId, {
      doctorId,
      departmentId: request.departmentId,
      parentConsultationId,
    });

    const appointmentDate = request.appointmentDate ? new Date(request.appointmentDate) : new Date(new Date().toISOString().split('T')[0]);

    // A re-visit is also a new consultation for meter
    // purposes. Kill-switch-gated; → 429 when over the rolling-monthly cap.
    await this.entitlements?.assertMeterQuota(tenantId, 'monthlyConsultations');

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
   * Defense-in-depth: the Prisma
   * `tenantScope` extension already filters foreign-tenant rows on
   * `findWithContext`, but an explicit service-layer assert provides a
   * second line so the method still refuses to leak data if the
   * extension is ever bypassed (raw query, platform-admin path, stale
   * CLS in a background job). `assertEqualTenants` throws a generic
   * `NotFoundException('Resource not found')` on mismatch — no model /
   * id echo — and `BadRequestException` when CLS has no tenant.
   *
   * The missing-CLS check is hoisted to the
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
   * Defense-in-depth: same posture as
   * `getById`. The Prisma `tenantScope` extension filters foreign-tenant
   * rows on `findWithRelations`, but the service-layer assert provides
   * an explicit second line on PHI relations so an extension bypass or
   * stale-CLS background call still fails closed with a generic
   * `NotFoundException('Resource not found')`.
   *
   * The missing-CLS check is hoisted to the
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
   * Defense-in-depth: unlike the two
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
   * Admin/tenant-wide listing.
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
    status?: ConsultationStatus;
  }): Promise<PaginatedConsultationResponse> {
    const tenantId = this.tenantId;
    // (TD3 / DEF-1) — a SUPER_ADMIN with NO tenant scope reads
    // cross-tenant: the Prisma `tenantScope` extension passes through when CLS
    // has no tenant AND the caller is super-admin, so we OMIT the `tenantId`
    // filter and the platform dashboard sees every tenant's consultations
    // (was: a hard 400). A non-super caller still requires a tenant context,
    // and a super-admin pinned to a working tenant (CLS tenantId set) stays
    // scoped to that tenant.
    if (!tenantId && !isSuperAdmin(this.requestUser)) {
      throw new BadRequestException('Tenant ID is required');
    }

    const { page, pageSize, patientId, doctorId, departmentId, status } = params;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filters: any = {};
    if (tenantId) filters.tenantId = tenantId;
    if (patientId) filters.patientId = patientId;
    if (doctorId) filters.doctorId = doctorId;
    if (departmentId) filters.departmentId = departmentId;
    // Optional lifecycle-status filter (indexed by [tenantId, status]);
    // the admin live console uses ?status=RECORDING to find in-progress recordings.
    if (status) filters.status = status;

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
      data: { scope: tenantId ? 'tenant' : 'all', page, pageSize, patientId, doctorId, departmentId, status, count },
    });

    return {
      data: consultations.map((c) => ConsultationDtoMapper.toResponse(c)),
      count,
      page,
      limit: pageSize,
    };
  }

  /**
   * Server-side, zero-filled date-range aggregation of
   * new vs. revisit consultation counts. Replaces the FE's client-side
   * single-page bucketing (`apps/admin/src/features/tenant-dashboard/chart.ts`)
   * which under-counts long ranges.
   *
   *   - new vs. revisit: `parentConsultationId IS NULL` ⇒ new visit, else revisit.
   *   - granularity: caller may force `day`/`month`; otherwise a span > 70 days
   *     rolls up to months (mirrors the FE `granularityFor` heuristic).
   *   - bucket key/label match the FE format (`yyyy-MM-dd`/`MMM d` for days,
   *     `yyyy-MM`/`MMM` for months) so the chart renders unchanged; boundaries
   *     are UTC (server-TZ-stable) rather than the FE's local-time `startOfDay`.
   *   - scope: SUPER_ADMIN with no working tenant aggregates cross-tenant
   *     (TD3); everyone else is pinned to their CLS tenant.
   */
  async aggregateConsultationsForTenant(params: {
    from: string | Date;
    to: string | Date;
    granularity?: 'day' | 'month';
  }): Promise<ConsultationAggregateResponse> {
    const tenantId = this.tenantId;
    if (!tenantId && !isSuperAdmin(this.requestUser)) {
      throw new BadRequestException('Tenant ID is required');
    }

    const fromDate = new Date(params.from);
    const toDate = new Date(params.to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException('Invalid from/to date');
    }
    if (fromDate.getTime() > toDate.getTime()) {
      throw new BadRequestException('`from` must be on or before `to`');
    }

    const spanDays = Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000);
    const granularity: 'day' | 'month' = params.granularity ?? (spanDays > 70 ? 'month' : 'day');

    const buckets = buildAggregateBuckets(fromDate, toDate, granularity);
    const counts = buckets.map(() => ({ newVisits: 0, revisits: 0 }));

    const rangeStart = buckets[0]?.start ?? startOfUtcDay(fromDate);
    const rangeEnd = buckets[buckets.length - 1]?.end ?? endOfUtcDay(toDate);

    // Routed through ConsultationRepository; the
    // repository applies the same createdAt range + optional-tenant filter.
    const rows = await this.consultationRepository.findCreatedInRange(rangeStart, rangeEnd, tenantId);

    for (const row of rows) {
      const ts = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as unknown as string);
      if (Number.isNaN(ts.getTime())) continue;
      const idx = buckets.findIndex((b) => ts >= b.start && ts <= b.end);
      if (idx === -1) continue;
      if (row.parentConsultationId) counts[idx].revisits += 1;
      else counts[idx].newVisits += 1;
    }

    const resultBuckets = buckets.map((b, i) => ({
      key: b.key,
      label: b.label,
      start: b.start.toISOString(),
      end: b.end.toISOString(),
      newVisits: counts[i].newVisits,
      revisits: counts[i].revisits,
      total: counts[i].newVisits + counts[i].revisits,
    }));

    const totals = resultBuckets.reduce(
      (acc, b) => ({ total: acc.total + b.total, newVisits: acc.newVisits + b.newVisits, revisits: acc.revisits + b.revisits }),
      { total: 0, newVisits: 0, revisits: 0 },
    );

    return { buckets: resultBuckets, totals, granularity, refreshedAt: new Date().toISOString() };
  }

  async doctorHasPatientRelationship(doctorId: string, patientId: string, tenantId: string): Promise<boolean> {
    const count = await this.consultationRepository.count({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId, doctorId, patientId } as any,
    });
    return count > 0;
  }

  // ============================================
  // Lifecycle (close / reopen / update)
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

    // TASK-701 — `metadata.status` is a reserved key: the DTO mapper's
    // lifecycle-status precedence trusts it, so a caller-supplied `metadata`
    // object must never be allowed to set it (e.g. forging `SIGNED`).
    // Callers who genuinely want to change lifecycle state must use the
    // dedicated, validated `status` field above.
    if (request.metadata !== undefined && 'status' in request.metadata) {
      throw new BadRequestException(
        "metadata.status is reserved for internal lifecycle tracking; use the top-level 'status' field to change lifecycle state.",
      );
    }

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

  // ============================================
  // Recording lifecycle
  //
  // Unlike close/reopen (which use the legacy `metadata.status` JSON), the
  // recording lifecycle writes the typed `status` COLUMN — the same column
  // the harness attestation gate writes (RECORDING → PENDING_REVIEW →
  // SIGNED). The DTO mapper treats a non-OPEN column value as canonical, so
  // `ConsultationResponse.status` reflects RECORDING immediately.
  // The LiveDocumentationService session is started/stopped by the controller
  // around these status transitions.
  // ============================================

  /**
   * Flip the consultation's `status` column to RECORDING.
   */
  async startRecording(id: string): Promise<ConsultationResponse> {
    return this.setRecordingStatus(id, ConsultationStatus.RECORDING, 'startRecording');
  }

  /**
   * Revert the consultation's `status` column to OPEN when recording stops.
   * The harness later promotes a recorded consult to PENDING_REVIEW.
   */
  async stopRecording(id: string): Promise<ConsultationResponse> {
    return this.setRecordingStatus(id, ConsultationStatus.OPEN, 'stopRecording');
  }

  /**
   * Shared recording-status writer: tenant-asserted load, write the typed
   * `status` column, persist, and broadcast `ResourceUpdated`.
   */
  private async setRecordingStatus(
    id: string,
    target: ConsultationStatus,
    action: 'startRecording' | 'stopRecording',
  ): Promise<ConsultationResponse> {
    if (!this.tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId: this.tenantId });

    consultation.status = target;
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
}

// ---------------------------------------------------------------------------
// UTC date-bucket helpers for aggregateConsultationsForTenant.
//
// Plain Date math (no date-fns dependency in @arcaai/applications) on UTC
// boundaries so the result is independent of the server timezone. Key/label
// formats mirror the FE `tenant-dashboard/chart.ts` so the chart renders the
// same axis: `yyyy-MM-dd`/`MMM d` for days, `yyyy-MM`/`MMM` for months.
// ---------------------------------------------------------------------------

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function endOfUtcMonth(d: Date): Date {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

interface AggregateBucket {
  key: string;
  label: string;
  start: Date;
  end: Date;
}

function buildAggregateBuckets(from: Date, to: Date, granularity: 'day' | 'month'): AggregateBucket[] {
  const buckets: AggregateBucket[] = [];

  if (granularity === 'month') {
    let cursor = startOfUtcMonth(from);
    const last = startOfUtcMonth(to);
    while (cursor.getTime() <= last.getTime()) {
      const y = cursor.getUTCFullYear();
      const m = cursor.getUTCMonth();
      buckets.push({
        key: `${y}-${pad2(m + 1)}`,
        label: MONTH_ABBR[m],
        start: startOfUtcMonth(cursor),
        end: endOfUtcMonth(cursor),
      });
      cursor = new Date(Date.UTC(y, m + 1, 1));
    }
    return buckets;
  }

  let cursor = startOfUtcDay(from);
  const last = startOfUtcDay(to);
  while (cursor.getTime() <= last.getTime()) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const day = cursor.getUTCDate();
    buckets.push({
      key: `${y}-${pad2(m + 1)}-${pad2(day)}`,
      label: `${MONTH_ABBR[m]} ${day}`,
      start: startOfUtcDay(cursor),
      end: endOfUtcDay(cursor),
    });
    cursor = new Date(Date.UTC(y, m, day + 1));
  }
  return buckets;
}
