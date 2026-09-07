import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BusinessException } from '@arcaai/exceptions';
import {
  ConsultationEntity,
  ConsultationRepository,
  ConsultationFactory,
  ConsultationStatus,
  DepartmentRepository,
  HarnessAuditAction,
  ResourceType,
  SysEventType,
  UserDepartmentRepository,
  UserRepository,
  UserRoleAssignmentRepository,
  WorkflowDefinitionRepository,
} from '@arcaai/domains';
import { IConsultationService } from './IConsultationService';
import {
  OpenConsultationRequest,
  UpdateConsultationRequest,
  ConsultationResponse,
  ConsultationAggregateResponse,
  ConsultationWorkflowResponse,
  PaginatedConsultationResponse,
} from './dto';
import { ConsultationDtoMapper } from './consultation.dto.mapper';
import { BaseService, assertEqualTenants, assertParentInScope, assertUserBelongsToTenant, isSuperAdmin } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { HarnessAuditService } from '../../harness-audit';
import { IConsentGrantService } from '../../consent/IConsentGrantService';
import { IConsultationWorkflowDispatchService } from '../workflow-dispatch/IConsultationWorkflowDispatchService';
import { SelectableConsultationWorkflowListResponse } from '../workflow-dispatch/dto';
import { readGoverningEngineMarker } from '../governing-engine';
import { withWorkflowSelectionMarker } from './workflow-selection';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { CONSULTATION_REQUIRE_PRIMED_BEFORE_RECORDING_KEY } from '../consultation-gates.constants';

/**
 * Consultation Service
 *
 * Simplified workflow using natural key (patientId, doctorId, appointmentDate)
 */
@Injectable()
export class ConsultationService extends BaseService implements IConsultationService {
  private readonly logger = new Logger(ConsultationService.name);

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
    // optional (append-only DI, mirrors `entitlements` above): the
    // WORM audit trail for clinically-significant transitions (prime/close/
    // reopen). Absent ⇒ `appendTransitionAudit` no-ops (best-effort by design
    // for routine transitions — see the method doc).
    @Optional() @Inject(HarnessAuditService) private readonly harnessAuditService?: HarnessAuditService,
    // optional: resolves the `requirePrimedBeforeRecording`
    // kill-switch. Absent ⇒ treated as OFF (the fail-safe default), mirroring
    // `OcrEnrichmentProcessor.ocrEnabled`.
    @Optional() @Inject(TenantSettingsService) private readonly tenantSettings?: TenantSettingsService,
    // optional: dispatches a tenant-authored `consultation`-palette workflow at
    // open. Absent ⇒ no dispatch, and the consultation runs under the default loop (Substrate A),
    // which is exactly the earlier behaviour. Optional so existing test fixtures and any
    // module that does not import ConsultationWorkflowDispatchServiceModule keep constructing.
    @Optional()
    @Inject(IConsultationWorkflowDispatchService)
    private readonly workflowDispatchService?: IConsultationWorkflowDispatchService,
    // owner directive (2026-08-25) — optional + trailing (append-only
    // DI, so existing positional test fixtures keep constructing). Records the
    // consent the doctor gives by opening the consultation. Absent ⇒ no grant
    // is written and the ABAC gate will refuse recording, which is why
    // `getOrCreate` logs loudly rather than silently when it is unwired.
    @Optional() @Inject(IConsentGrantService) private readonly consentGrantService?: IConsentGrantService,
    // optional + trailing (append-only DI, like every dependency above it). READ-ONLY,
    // and used for discovery alone: `getGoverningWorkflow` decorates the durable marker with the
    // definition's human-readable identity. Absent ⇒ the route still answers, with that identity
    // degraded to null — never an error, because "which engine governs" must stay answerable.
    // The SELECTION gate deliberately does NOT use this: authorizing a selection is dispatch
    // policy and lives with the dispatcher, which owns the palette rule.
    @Optional() private readonly workflowDefinitionRepository?: WorkflowDefinitionRepository,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  /**
   * (audit C-1 / C-2 / C-4) — assert every cross-aggregate
   * reference on a Consultation write lives in the caller's tenant before
   * any factory or repository call runs:
   *
   *   - `doctorId` — User must hold an ENABLED UserRoleAssignment
   *                            in `tenantId` (defense vs. audit C-1).
   *   - `departmentId` — Department row must be tenant-scoped to
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
   * point 6 — no-op when the caller made no selection; otherwise delegate to the
   * dispatcher's gate, which raises 404 for an invisible definition and 403 for a visible one
   * that cannot govern a consultation.
   *
   * The unwired branch is a 503 on purpose. Every other absent-dependency path in this service
   * degrades (the audit trail no-ops, the kill-switch reads OFF, the cascade is simply not
   * consulted) because nothing was ASKED for. Here something was: the caller named a workflow,
   * and a deployment that cannot honour it would otherwise return 201 for a consultation
   * governed by the default engine. Refusing is retryable and legible; the silent substitution
   * is neither.
   */
  private async assertWorkflowSelectionAllowed(tenantId: string, workflowDefinitionSlug?: string): Promise<void> {
    if (!workflowDefinitionSlug) return;

    if (!this.workflowDispatchService) {
      this.logger.error({
        message:
          'A workflow was selected but consultation workflow dispatch is NOT WIRED — refusing rather than silently opening under the default engine',
        requestedWorkflowDefinitionSlug: workflowDefinitionSlug,
      });
      throw new ServiceUnavailableException('Workflow selection is not available on this deployment');
    }

    await this.workflowDispatchService.assertSelectableForConsultation(tenantId, workflowDefinitionSlug);
  }

  /**
   * the workflows this caller may name at open.
   *
   * Selection shipped without a way to learn what is selectable, so the contract was "guess a
   * slug, get a 404/403". The answer comes from the DISPATCHER, which owns the gate: the list
   * and the gate are one predicate with two consumers
   * (`workflow-dispatch/consultation-selection-policy.ts`), so a slug this route advertises can
   * never be one the gate refuses.
   *
   * This service adds only the two request-shaped facts the dispatcher has no business knowing:
   *
   *   * the tenant is the CLS-resolved one, never a request field — so there is no cross-tenant
   *     identifier on this surface and no 404-over-403 case to get wrong;
   *   * an UNWIRED dispatcher is a 503, exactly as it is for the selection gate. Answering
   *     `{ data: [] }` would be a claim about what the tenant has authored, when the truth is
   *     that this deployment cannot tell — and a caller that believed it would stop selecting
   *     rather than retry.
   *
   * No `ResourceViewed` sys-event: this reads workflow definitions, and this service's audit
   * resource type is `Consultation`. Mis-typing the event to obtain coverage would be worse
   * than the absence — the same call this route's sibling `getGoverningWorkflow` makes.
   */
  async listSelectableWorkflows(): Promise<SelectableConsultationWorkflowListResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    if (!this.workflowDispatchService) {
      this.logger.error({
        message: 'Selectable workflows were requested but consultation workflow dispatch is NOT WIRED — refusing rather than reporting an empty set',
      });
      throw new ServiceUnavailableException('Workflow selection is not available on this deployment');
    }

    return this.workflowDispatchService.listSelectableForConsultation(tenantId);
  }

  /**
   * WHICH engine governs a consultation (see `ConsultationWorkflowResponse`).
   *
   * Reads the durable marker `ConsultationWorkflowDispatchService` wrote at open, through the
   * SAME well-formedness rule `LoopContextSignalService` gates on, so discovery can never
   * disagree with the engine that is actually writing the document.
   *
   * Decoration with the definition's identity is best-effort: a slug that has since been
   * unpublished still answers, with `name`/`activeVersionNumber` null. "Which engine governs" is
   * exactly the question a client asks when something looks wrong, so it must not itself fail
   * when something is wrong.
   */
  async getGoverningWorkflow(consultationId: string): Promise<ConsultationWorkflowResponse> {
    const consultation = await this.consultationRepository.findById(consultationId);
    if (!consultation) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }

    const marker = readGoverningEngineMarker(consultation.metadata);

    const base: ConsultationWorkflowResponse = {
      consultationId,
      governed: marker !== null,
      workflowDefinitionSlug: marker?.workflowDefinitionSlug || null,
      workflowRunId: marker?.workflowRunId ?? null,
      decidedAt: marker?.decidedAt ?? null,
      name: null,
      description: null,
      paletteKey: null,
      activeVersionNumber: null,
      // No per-definition input schema is declared anywhere in the substrate. See the DTO.
      inputSchema: null,
    };

    if (!base.workflowDefinitionSlug || !this.workflowDefinitionRepository) return base;

    const definition = await this.workflowDefinitionRepository.findPublishedBySlug(consultation.tenantId, base.workflowDefinitionSlug);
    if (!definition) return base;

    return {
      ...base,
      name: definition.name,
      description: definition.description ?? null,
      paletteKey: definition.paletteKey,
      activeVersionNumber: definition.versionNumber,
    };
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

    // point 6 — authorize the caller's workflow SELECTION here, before the
    // get-or-create branch and before any write.
    //
    // Order is the security property, twice over:
    //
    //   * BEFORE the write, because `dispatchForConsultation` is best-effort by contract and
    //     swallows its own failures. A gate placed inside it would turn a refused request into a
    //     201 whose consultation is quietly governed by something else.
    //   * BEFORE the existing-consultation lookup, because the answer to "may I select this
    //     workflow?" must not depend on whether a consultation for (patient, doctor, date)
    //     happens to already exist. Otherwise the status code itself reports that.
    await this.assertWorkflowSelectionAllowed(tenantId, request.workflowDefinitionSlug);

    // Use today's date if not provided
    const appointmentDate = request.appointmentDate ? new Date(request.appointmentDate) : new Date(new Date().toISOString().split('T')[0]); // Today, no time

    // Try to find existing consultation (first one if multiple exist)
    const existing = await this.consultationRepository.findByUniqueKey(tenantId, request.patientId, appointmentDate, doctorId);

    if (existing) {
      // The selection was authorized above, but consultation-open dispatch fires on CREATE only,
      // so there is no dispatch left to steer. Say so rather than let the caller believe their
      // pick took effect — `GET /consultations/:id/workflow` reports what actually governs.
      if (request.workflowDefinitionSlug) {
        this.logger.log({
          message: 'Workflow selection ignored — this consultation is already open and its governing engine was decided at its own open',
          consultationId: existing.id,
          requestedWorkflowDefinitionSlug: request.workflowDefinitionSlug,
        });
      }

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
    // lane A — record the AUTHORIZED selection on the row itself, here, before dispatch
    // is even attempted.
    //
    // The only existing record of a caller's pick is `metadata.governingEngine`, and that marker
    // requires a non-empty `workflowRunId` — so it exists ONLY when the durable dispatch actually
    // started a Temporal run. Every other outcome (harness unreachable, no claim-check storage,
    // dispatcher not wired, definition without a compiled config) returns `dispatched: false` and
    // leaves nothing behind, and those are precisely the deployments where the REALTIME lane still
    // runs. Without this write, the realtime resolver has nothing to honour and the clinician
    // silently gets the tenant default's live nodes.
    //
    // Two keys, two claims: `workflowSelection` says what was ASKED FOR, `governingEngine` says
    // what TOOK OWNERSHIP. Neither is inferred from the other. Caller metadata is merged, not
    // replaced — see `workflow-selection.ts` for why the key is not stripped from caller input.
    const metadata = request.workflowDefinitionSlug
      ? withWorkflowSelectionMarker(request.metadata, request.workflowDefinitionSlug)
      : request.metadata;

    const consultation = ConsultationFactory.CreateNewVisit({
      tenantId,
      patientId: request.patientId,
      appointmentDate,
      doctorId,
      departmentId: request.departmentId,
      metadata: metadata as Parameters<typeof ConsultationFactory.CreateNewVisit>[0]['metadata'],
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

    // ─── Consent ( owner directive, 2026-08-25) ───
    //
    // A doctor opening a consultation IS the consent event: the clinician is
    // with the patient and attests, by that act, that the patient consented to
    // every purpose. Grants are written here — inside the doctor's own request
    // context, so `grantedBy` is the doctor and each row lands on the WORM
    // ledger — because `POST /admin/consent-grants` requires
    // `manage:ConsentGrant`, a TENANT-ADMIN ability no clinician holds. Before
    // this, a doctor could open a consultation they were then forbidden to
    // record and forbidden to fix (403 `Missing permissions: manage:ConsentGrant`).
    //
    // FAIL-CLOSED, unlike the best-effort workflow dispatch below. Once opening
    // a consultation MEANS consent was recorded, a consultation whose consent
    // did not persist is not "opened with a degraded feature" — it is a
    // consultation the clinician cannot record and cannot repair. Failing here
    // surfaces that immediately and retryably, instead of as a mystifying 403
    // at the moment they press Record.
    if (!this.consentGrantService) {
      this.logger.warn({
        message: 'Consent grant service is NOT WIRED — recording this consultation will be refused by PatientConsentGuard',
        consultationId: saved.id,
      });
    } else {
      await this.consentGrantService.ensureConsultationConsent(saved.patientId);
    }

    // the ONE place `WorkflowRun.trigger = 'consultation open'` is stamped.
    // Fires only on CREATE: `getOrCreate`'s existing-consultation branch returns earlier, so a
    // re-opened consultation is never dispatched twice. Best-effort by contract — the dispatch
    // service swallows its own failures and returns `dispatched: false`, because a harness
    // outage must never stop a clinician opening a consultation.
    // day-1: which engine governs a consultation must be OBSERVABLE. Every outcome
    // including "the dispatcher is not wired" and "no tenant workflow is assigned" — is logged.
    // Both of those were previously SILENT, so a consultation that quietly fell through to the
    // default engine was indistinguishable from one the dispatcher had never been asked about.
    if (!this.workflowDispatchService) {
      this.logger.warn({
        message: 'Consultation workflow dispatch is NOT WIRED — the default loop governs by omission, not by decision',
        consultationId: saved.id,
      });
    } else {
      const dispatch = await this.workflowDispatchService.dispatchForConsultation({
        consultationId: saved.id,
        tenantId,
        departmentId: saved.departmentId,
        userId: userId ?? doctorId,
        externalPatientId: saved.patientId,
        // Already authorized above; the dispatcher re-verifies rather than trusts.
        workflowDefinitionSlug: request.workflowDefinitionSlug,
        // TASK-891 — threaded in, not re-read by the dispatcher: it derives the reserved
        // `visit-type:<key>` selector tag (OD-2/OD-3) from this, and dispatch is best-effort by
        // contract, so a DB read inside it would change its failure profile. `saved` already
        // carries this fact (set a few lines above), so no extra read is needed here either.
        parentConsultationId: saved.parentConsultationId ?? null,
      });
      this.logger.log({
        message: dispatch.dispatched
          ? 'Consultation governed by a tenant-authored workflow'
          : 'Consultation governed by the default loop (no tenant workflow resolved)',
        consultationId: saved.id,
        departmentId: saved.departmentId ?? null,
        dispatched: dispatch.dispatched,
        source: dispatch.source,
        workflowDefinitionSlug: dispatch.workflowDefinitionSlug,
        runId: dispatch.runId,
        skippedReason: dispatch.skippedReason,
      });
    }

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

    // a re-visit does not dispatch a consultation workflow at all (only `getOrCreate`
    // stamps `trigger: 'consultation open'`), so a selector here has nothing to steer. Logged
    // rather than silently dropped; the DTO field documents that `open` is the only route that
    // honours it.
    if (request.workflowDefinitionSlug) {
      this.logger.log({
        message: 'Workflow selection ignored — a re-visit dispatches no consultation workflow',
        parentConsultationId,
        requestedWorkflowDefinitionSlug: request.workflowDefinitionSlug,
      });
    }

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
  // session state machine
  //
  // `Consultation.status` is now the ONLY lifecycle tracker (the legacy
  // `metadata.status` JSON key is deleted — see the removed `readStatus`/
  // `transitionStatus` this replaces). Every write goes through
  // `ConsultationEntity.transitionTo`, the single guarded path that
  // consults the legality matrix

  // `transitionTo` itself handles the idempotent self-transition
  // no-op; the two terminal-close methods add one further no-op check
  // (already-terminal → already-terminal is not a self-pair in the
  // matrix's sense, since CLOSED_COMPLETE and CLOSED_INCOMPLETE are two
  // distinct targets — see `closeConsultation`).
  // ============================================

  /**
   * Illegal `transitionTo` calls throw a bare domain `BusinessException`
   * (packages/domains has no HTTP awareness). Surfaced to callers as
   * `409 Conflict` — the RFC-correct code for "this write conflicts with
   * the resource's current state" — via the generic
   * `ExceptionInterceptor` `BaseException` branch, which today maps to
   * `500` for the whole `BusinessException` family (most of which is
   * ordinary entity-validation, not a conflict). Catching it HERE, at the
   * one call site this ticket controls, avoids reclassifying every other
   * `BusinessException` use in the codebase.
   */
  private applyTransition(entity: ConsultationEntity, next: ConsultationStatus, actor: string, reason: string): boolean {
    try {
      return entity.transitionTo(next, actor, reason);
    } catch (err) {
      if (err instanceof BusinessException) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  /**
   * Best-effort WORM append for a ROUTINE transition ( pitfall
   * 6): a failure here is logged but never rolls back the (already
   * persisted) status write — only the `SIGNED` write itself
   * (`summary.service.ts#approveSummary`) stays fail-closed.
   */
  private async appendTransitionAudit(input: { tenantId: string; consultationId: string; action: HarnessAuditAction; actor: string }): Promise<void> {
    if (!this.harnessAuditService) return;
    try {
      await this.harnessAuditService.append({
        tenantId: input.tenantId,
        consultationId: input.consultationId,
        action: input.action,
        modelName: 'session-lifecycle',
        modelVersion: 'v1',
        sensorScores: {},
        citations: [],
        clinicianId: input.actor === 'system' ? null : input.actor,
        createdBy: input.actor === 'system' ? null : input.actor,
      });
    } catch (error) {
      this.logger.warn({
        message: 'WORM append failed for a routine session transition (non-fatal, status write not rolled back)',
        consultationId: input.consultationId,
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * `OPEN → PRIMED` — the first checkpoint of the session state machine.
   * Idempotent (no-op if already `PRIMED`, per `transitionTo`).
   *
   * Consent is NOT asserted here: `POST :id/prime`
   * (apps/api) carries `@RequiresConsent`, the single choke point
   * that already runs before this method is reached — duplicating the
   * check here would be a second source of truth for the same decision.
   */
  async primeConsultation(id: string, expectedVersion?: number): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });

    const actor = this.requestUserId ?? 'system';
    const applied = this.applyTransition(consultation, ConsultationStatus.PRIMED, actor, 'primeConsultation');
    if (!applied) {
      return ConsultationDtoMapper.toResponseWithContext(consultation);
    }

    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }
    // The client-supplied `If-Match`/`@ExpectedVersion()` CAS predicate, when
    // present (the `@RequiresIfMatch()`-gated route always supplies one) —
    // otherwise the freshly-read row version (defense-in-depth against a
    // concurrent write landing between our read and write).
    const updated = await this.consultationRepository.updateWithVersion(id, consultation, expectedVersion ?? consultation.version);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'primeConsultation', status: ConsultationStatus.PRIMED },
    });
    await this.appendTransitionAudit({ tenantId, consultationId: id, action: HarnessAuditAction.SESSION_PRIMED, actor });

    // Map the FRESHLY-PERSISTED entity, not the stale pre-write one: updateWithVersion
    // bumps _version, so returning `consultation` handed the caller version N while the
    // row was already at N+1 — any client chaining If-Match from this response got an
    // immediate 412. Mirrors the house pattern in department.service.ts:318.
    return ConsultationDtoMapper.toResponseWithContext(updated);
  }

  /**
   * Close a consultation. The target terminal is DERIVED from the current
   * status, per :
   *   - `SIGNED → CLOSED_COMPLETE` (a human gave clinical feedback)
   *   - `TIMED_OUT → CLOSED_INCOMPLETE` (manual close before the sweep fires)
   * Any other predecessor is illegal (→ 409) — "how do I close an unsigned,
   * still-active consultation?" is answered by the matrix itself: you
   * cannot, until it either signs or times out. Idempotent: already
   * `CLOSED_COMPLETE`/`CLOSED_INCOMPLETE` (or the superseded, dead
   * `CLOSED`) short-circuits with no write.
   */
  async closeConsultation(id: string, expectedVersion?: number): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });

    if (
      consultation.status === ConsultationStatus.CLOSED_COMPLETE ||
      consultation.status === ConsultationStatus.CLOSED_INCOMPLETE ||
      consultation.status === ConsultationStatus.CLOSED
    ) {
      return ConsultationDtoMapper.toResponseWithContext(consultation);
    }

    const actor = this.requestUserId ?? 'system';
    const target = consultation.status === ConsultationStatus.SIGNED ? ConsultationStatus.CLOSED_COMPLETE : ConsultationStatus.CLOSED_INCOMPLETE;
    const worm =
      target === ConsultationStatus.CLOSED_COMPLETE ? HarnessAuditAction.SESSION_CLOSED_COMPLETE : HarnessAuditAction.SESSION_CLOSED_INCOMPLETE;

    // Always applies (from !== target — the terminal-idempotency check above
    // already ruled out every self-pair), so no `applied` guard is needed.
    this.applyTransition(consultation, target, actor, 'closeConsultation');

    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }
    const updated = await this.consultationRepository.updateWithVersion(id, consultation, expectedVersion ?? consultation.version);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'closeConsultation', status: target },
    });
    await this.appendTransitionAudit({ tenantId, consultationId: id, action: worm, actor });

    // Map the FRESHLY-PERSISTED entity, not the stale pre-write one: updateWithVersion
    // bumps _version, so returning `consultation` handed the caller version N while the
    // row was already at N+1 — any client chaining If-Match from this response got an
    // immediate 412. Mirrors the house pattern in department.service.ts:318.
    return ConsultationDtoMapper.toResponseWithContext(updated);
  }

  /**
   * Reopen a consultation → `REOPENED`. Legal from `TIMED_OUT`, `SIGNED`,
   * `CLOSED_COMPLETE`, or `CLOSED_INCOMPLETE` (; any
   * other predecessor is illegal (→ 409). Idempotent: already `REOPENED`
   * is a self-transition, handled by `transitionTo` itself.
   *
   * Authority unchanged ( Q2, preserved identically for both
   * terminal-closed variants): `verifyConsultationOwnership` at the
   * controller admits the assigned doctor OR any caller holding
   * `manage:Consultation` — this ticket changes *legality*, not *who may act*.
   */
  async reopenConsultation(id: string, expectedVersion?: number): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });

    const actor = this.requestUserId ?? 'system';
    const applied = this.applyTransition(consultation, ConsultationStatus.REOPENED, actor, 'reopenConsultation');
    if (!applied) {
      return ConsultationDtoMapper.toResponseWithContext(consultation);
    }

    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }
    const updated = await this.consultationRepository.updateWithVersion(id, consultation, expectedVersion ?? consultation.version);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'reopenConsultation', status: ConsultationStatus.REOPENED },
    });
    await this.appendTransitionAudit({ tenantId, consultationId: id, action: HarnessAuditAction.SESSION_REOPENED, actor });

    // Map the FRESHLY-PERSISTED entity, not the stale pre-write one: updateWithVersion
    // bumps _version, so returning `consultation` handed the caller version N while the
    // row was already at N+1 — any client chaining If-Match from this response got an
    // immediate 412. Mirrors the house pattern in department.service.ts:318.
    return ConsultationDtoMapper.toResponseWithContext(updated);
  }

  /**
   * Update safely-mutable fields of an existing consultation.
   *
   * Allowed: `appointmentDate`, `departmentId` (tenant-checked, audit C-2),
   * `metadata` (shallow-merged). Identity / ownership fields (`patientId`,
   * `doctorId`, `tenantId`), the structural `parentConsultationId` link, and
   * the typed `status` COLUMN — routed exclusively through
   * `transitionTo` via the dedicated prime/close/reopen/recording routes)
   * are NOT mutable here.
   */
  async updateConsultation(id: string, request: UpdateConsultationRequest, expectedVersion?: number): Promise<ConsultationResponse> {
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

    if (request.metadata !== undefined) {
      const currentMeta = (consultation.metadata as Record<string, unknown> | null) ?? {};
      consultation.metadata = { ...currentMeta, ...request.metadata } as Parameters<typeof ConsultationFactory.CreateNewVisit>[0]['metadata'];
    }

    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }

    // `PATCH /consultations/:id` carries `@RequiresIfMatch()`, so the CAS is the
    // enforcement point for the precondition — the same shape the lifecycle
    // transitions (prime/close/reopen) on this aggregate already use. The
    // `?? consultation.version` fall-through keeps the documented
    // service-to-service path (no header) working unchanged.
    const updated = await this.consultationRepository.updateWithVersion(id, consultation, expectedVersion ?? consultation.version);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'updateConsultation', fields: Object.keys(request ?? {}) },
    });

    // Map the FRESHLY-PERSISTED entity, not the stale pre-write one: the CAS
    // bumps `_version`, so returning `consultation` handed the caller version N
    // while the row was already at N+1 — and any client chaining `If-Match`
    // from this response would get an immediate 412. Same fix as
    // `reopenConsultation` above.
    return ConsultationDtoMapper.toResponseWithContext(updated);
  }

  // ============================================
  // Recording lifecycle
  //
  // `startRecording`/`stopRecording` route through the same
  // `transitionTo` legality matrix as every other lifecycle write.
  // `PRIMED → RECORDING` carries the ONE flagged precondition in the whole
  // matrix (`consultation.state.requirePrimedBeforeRecording`, default
  // OFF — Task 9 / R1): OFF logs the would-be violation and lets
  // a legacy caller through unchanged; ON enforces via the matrix itself
  // (illegal → 409). `stopRecording` now transitions to `DRAINING`, not
  // `OPEN` — the previous behaviour erased the fact that capture ever
  // happened ( A-13-adjacent finding). The
  // LiveDocumentationService session is started/stopped by the controller
  // around these calls.
  // ============================================

  /**
   * Flip the consultation's `status` column `PRIMED → RECORDING`.
   */
  async startRecording(id: string): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });

    const actor = this.requestUserId ?? 'system';
    const requirePrimed = this.tenantSettings?.resolvePlatform<boolean>(CONSULTATION_REQUIRE_PRIMED_BEFORE_RECORDING_KEY).value === true;

    if (!requirePrimed && !consultation.canTransitionTo(ConsultationStatus.RECORDING)) {
      // grep-gate NOTE — Kill-switch OFF: this is the ONE matrix
      // edge this ticket lets bypass (every other transition is enforced
      // unconditionally from day one — Task 9 step 4). Log the
      // would-be violation and write RECORDING directly (via the deprecated
      // setter, NOT
      // `transitionTo` — the matrix genuinely does not permit this pair,
      // so going through `transitionTo` would throw regardless of the
      // flag) so a legacy caller with no prior `prime` call keeps working
      // unchanged.
      this.logger.warn({
        message: 'recording/start reached without PRIMED — kill-switch OFF, proceeding (would 409 if ON)',
        consultationId: id,
        currentStatus: consultation.status,
      });
      consultation.status = ConsultationStatus.RECORDING;
    } else {
      this.applyTransition(consultation, ConsultationStatus.RECORDING, actor, 'startRecording');
    }

    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }
    const expectedVersion = consultation.version;
    const updated = await this.consultationRepository.updateWithVersion(id, consultation, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'startRecording', status: ConsultationStatus.RECORDING },
    });

    // Map the FRESHLY-PERSISTED entity, not the stale pre-write one: updateWithVersion
    // bumps _version, so returning `consultation` handed the caller version N while the
    // row was already at N+1 — any client chaining If-Match from this response got an
    // immediate 412. Mirrors the house pattern in department.service.ts:318.
    return ConsultationDtoMapper.toResponseWithContext(updated);
  }

  /**
   * Flip the consultation's `status` column `RECORDING → DRAINING` when
   * capture stops (manual stop, or forcing this same edge on
   * mid-capture consent revocation). The harness later promotes a drained
   * consult to `DRAFT_PENDING_SENSORS`/`PENDING_REVIEW` (`persistDraft`).
   */
  async stopRecording(id: string): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });

    const actor = this.requestUserId ?? 'system';
    this.applyTransition(consultation, ConsultationStatus.DRAINING, actor, 'stopRecording');

    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }
    const expectedVersion = consultation.version;
    const updated = await this.consultationRepository.updateWithVersion(id, consultation, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'stopRecording', status: ConsultationStatus.DRAINING },
    });

    // Map the FRESHLY-PERSISTED entity, not the stale pre-write one: updateWithVersion
    // bumps _version, so returning `consultation` handed the caller version N while the
    // row was already at N+1 — any client chaining If-Match from this response got an
    // immediate 412. Mirrors the house pattern in department.service.ts:318.
    return ConsultationDtoMapper.toResponseWithContext(updated);
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
