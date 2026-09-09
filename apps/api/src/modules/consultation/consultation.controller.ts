import {
  IConsultationService,
  IContextService,
  ISummaryService,
  TimelineService,
  ComprehensiveSummaryRequest,
  OpenConsultationRequest,
  UpdateConsultationRequest,
  ConsultationResponse,
  ConsultationWorkflowResponse,
  SelectableConsultationWorkflowListResponse,
  PaginatedConsultationResponse,
  AddContextRequest,
  AddAudioRecordingRequest,
  AudioRecordingResponse,
  UpdateContextRequest,
  ContextItemResponse,
  ContextItemVersionResponse,
  VersionDiffResponse,
  ComprehensiveSummaryResponse as ComprehensiveSummaryResponseDto,
  GenerateSummaryRequest,
  GeneratePreSummaryRequest,
  UpdateSummaryRequest,
  SummaryApprovalRequest,
  SummaryResponse,
  SummaryProvenanceResponse,
  AggregateNerResponse,
  ConsultationTimelineResponse,
  PaginatedQuery,
  HttpMethod,
  PolicyEngine,
  AppAbility,
  ITagService,
  CreateTagRequest,
  TagResponse,
  TagDtoMapper,
  LiveDocumentationService,
  StartRecordingRequest,
  StopRecordingRequest,
  RecordingStateResponse,
  IHighlightService,
  CreateHighlightRequest,
  HighlightResponse,
  // Lane D — the REST half of the DocumentSection state machine.
  IDocumentSectionService,
  DocumentSectionResponse,
  UpdateDocumentSectionRequest,
  HarnessProgressService,
  HarnessAssuranceService,
  HarnessLiveAssistService,
  // dedicated Redis subscriber for the trajectory SSE relay.
  RedisSubscriberService,
  // Consultation-loop lifecycle signal caller.
  LoopContextSignalService,
  // TASK-932 S2-4 — the `global-kv` cascade (tenant row -> SYSTEM row ->
  // descriptor default) the sharing gate resolves through.
  CONSULTATION_SHARING_ENABLED_KEY,
  TenantSettingsService,
} from '@arcaai/applications';
import {
  Controller,
  Body,
  Param,
  Inject,
  Query,
  Headers,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  Logger,
  Get,
  Sse,
  HttpCode,
  HttpStatus,
  type MessageEvent,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiHeader, ApiParam, ApiProperty, ApiPropertyOptional, ApiQuery, ApiResponse, ApiOperation } from '@nestjs/swagger';
import { Observable } from 'rxjs';
// `@RequiresIfMatch()` + `@ExpectedVersion()` gate the OCC-enforced note-content
// PATCH/POST routes on this controller.
import { ApiEndpoint, Authorize, RequiredScopes, RequiredSvcScopes, RequiresIfMatch, ExpectedVersion, RequiresConsent } from '../../decorators';
import { TenantOwnedResource } from '../../common';
import { StreamScope } from '../auth';
import { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '@arcaai/applications';
import { ChainSummaryService, sseFromRedisChannel } from '@arcaai/applications';
import { IConsultationJobService } from '@arcaai/applications';
import { INoteGenerationService, GenerationTrigger } from '@arcaai/applications';
import { ConsentPurpose, ResourceType } from '@arcaai/domains';

class AsyncJobResponseDto {
  @ApiProperty({ description: 'Async job ID' })
  jobId: string;

  @ApiProperty({ description: 'Job status', enum: ['pending', 'processing', 'completed', 'failed'] })
  status: 'pending' | 'processing' | 'completed' | 'failed';

  @ApiProperty({ description: 'Associated consultation ID' })
  consultationId: string;

  @ApiProperty({ description: 'Job creation timestamp' })
  createdAt: string;

  @ApiPropertyOptional({ description: 'Job progress percentage (0-100)' })
  progress?: number;

  @ApiPropertyOptional({ description: 'Job result (partial summary)' })
  result?: Partial<SummaryResponse>;

  @ApiPropertyOptional({ description: 'Error message if job failed' })
  errorMessage?: string;

  constructor(data: {
    jobId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    consultationId: string;
    createdAt: string;
    progress?: number;
    result?: Partial<SummaryResponse>;
    errorMessage?: string;
  }) {
    this.jobId = data.jobId;
    this.status = data.status;
    this.consultationId = data.consultationId;
    this.createdAt = data.createdAt;
    this.progress = data.progress;
    this.result = data.result;
    this.errorMessage = data.errorMessage;
  }
}

class SummaryApprovalResponseDto {
  @ApiProperty({ description: 'Context item ID of the approved summary' })
  contextItemId: string;

  @ApiProperty({ description: 'Approval status' })
  approvalStatus: string;

  @ApiProperty({ description: 'User ID who approved' })
  approvedBy: string;

  @ApiProperty({ description: 'Approval timestamp' })
  approvedAt: string;

  constructor(data: { contextItemId: string; approvalStatus: string; approvedBy: string; approvedAt: string }) {
    this.contextItemId = data.contextItemId;
    this.approvalStatus = data.approvalStatus;
    this.approvedBy = data.approvedBy;
    this.approvedAt = data.approvedAt;
  }
}

class OkResponseDto {
  @ApiProperty({ description: 'Success indicator', example: true })
  ok: true;

  constructor() {
    this.ok = true;
  }
}

@ApiBearerAuth()
@ApiTags('consultations')
@Controller('consultations')
@Authorize()
// CLASS-level default for the ~42 consultation routes that carried
// no API-key declaration (context items, transcriptions, highlights, recording
// control, streams, entity extraction). The 11 summarization/session routes
// that already carry their own finer method-level @RequiredScopes are
// UNAFFECTED — Reflector.getAllAndOverride takes the method's value first, so
// this only fills the gaps.
@RequiredScopes('consultation:session:write')
export class ConsultationController {
  private readonly logger = new Logger(ConsultationController.name);

  constructor(
    @Inject(IConsultationService)
    private readonly consultationService: IConsultationService,
    @Inject(IContextService)
    private readonly contextService: IContextService,
    @Inject(ISummaryService)
    private readonly summaryService: ISummaryService,
    private readonly chainSummaryService: ChainSummaryService,
    @Inject(IConsultationJobService)
    private readonly consultationJobService: IConsultationJobService,
    // the single seam every note-generation entry point routes
    // through. `generateSummaryAsync` calls it directly now that
    // the legacy `SummaryProcessor`/`createSummaryJob` dispatch it used to
    // rely on has been deleted.
    @Inject(INoteGenerationService)
    private readonly noteGenerationService: INoteGenerationService,
    private readonly timelineService: TimelineService,
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly policyEngine: PolicyEngine,
    // TASK-932 S2-4 — replaces the raw `GlobalSettingRepository` this controller
    // used to read the sharing flag from directly (a rule-05 violation: a
    // controller holds no business logic and no data access). Same position, so
    // the positional test fixtures below keep their arity.
    private readonly tenantSettings: TenantSettingsService,
    @Inject(ITagService)
    private readonly tagService: ITagService,
    // Clinical Workflow Playground (WS1/WS2) — per-consultation realtime watcher.
    private readonly liveDocumentationService: LiveDocumentationService,
    @Inject(IHighlightService)
    private readonly highlightService: IHighlightService,
    private readonly harnessProgressService: HarnessProgressService,
    private readonly harnessAssuranceService: HarnessAssuranceService,
    // relays `consultation:live-assist:{id}` (interpreter
    // suggestions + correction proposals) to the clinician surface.
    private readonly harnessLiveAssistService: HarnessLiveAssistService,
    // dedicated Redis subscriber for the trajectory SSE relay.
    private readonly redisSubscriber: RedisSubscriberService,
    // Best-effort consultation-loop lifecycle signals
    // (`signalConsultationEnding`/`signalLoopCancel`); gated inside that service
    // by the tenant's `agenticLoop` subscription entitlement composed with the
    // `harness.loop.emergencyStop` platform veto, and never lets a
    // harness failure surface here.
    private readonly loopContextSignalService: LoopContextSignalService,
    // Lane D — the CLINICIAN writer for `DocumentSection`, counterpart to the
    // flush writer inside `liveDocumentationService`. Appended LAST so the
    // positional test fixtures below keep their arity (this file's own warning:
    // "the count is the contract").
    @Inject(IDocumentSectionService)
    private readonly documentSectionService: IDocumentSectionService,
  ) {}

  /** heartbeat cadence keeping idle trajectory streams alive through proxies. */
  private static readonly TRAJECTORY_HEARTBEAT_MS = 15000;

  private getDoctorId(): string {
    const user = this.cls.get('user');
    if (!user?.id) {
      throw new UnauthorizedException('User context not available');
    }
    return user.id;
  }

  /**
   * TASK-933 — the MACHINE principal, when the caller is one.
   *
   * `UnifiedAuthGuard` puts a service account on its OWN CLS key and never on `user`, precisely
   * so that no `requestUser?.id` read records a machine's action against a person. Every helper
   * below therefore has to ASK rather than infer: a null `user` means "not a human", not
   * "unauthenticated".
   */
  private getServiceAccountId(): string | undefined {
    const principal = this.cls.get('serviceAccount') as { id?: string } | undefined;
    return typeof principal?.id === 'string' ? principal.id : undefined;
  }

  /**
   * TASK-933 §3.2 — WHO this consultation is for.
   *
   * `Consultation.doctorId` names a person, always. A human caller is that person. A service
   * account is not a person at all, so it NAMES the clinician it acts for and the service
   * validates that name (tenant membership + the named user's own `create:Consultation`).
   *
   * The two 400s are deliberate and are opposite refusals of the same field:
   *
   *   · `CLINICIAN_REQUIRED` — a machine that named nobody. Defaulting to the account itself
   *     would write a machine id into `doctorId`, which every downstream consumer (DNA style,
   *     the redaction gate, the doctor's report, the prompt tier, the audit trail) reads as a
   *     clinician. There is no safe default, so there is no default.
   *   · `CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER` — a human that named someone. Their clinician
   *     IS their authenticated identity; honouring a body field here would be impersonation
   *     with no gate, and silently ignoring it would be worse (the caller would believe it took
   *     effect). 400 says so out loud.
   */
  private resolveActingClinicianId(request: OpenConsultationRequest): string {
    const serviceAccountId = this.getServiceAccountId();

    if (serviceAccountId) {
      if (!request.clinicianUserId) {
        throw new BadRequestException({
          message:
            'A service account has no clinician of its own. Name the clinician this consultation belongs to with `clinicianUserId`; a service account is never recorded as the doctor.',
          code: 'CLINICIAN_REQUIRED',
        });
      }
      return request.clinicianUserId;
    }

    if (request.clinicianUserId) {
      throw new BadRequestException({
        message:
          '`clinicianUserId` is honoured only for a service-account caller. Your consultation is opened for the authenticated user; remove the field.',
        code: 'CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER',
      });
    }

    return this.getDoctorId();
  }

  private getUserAbility(): AppAbility | undefined {
    return this.cls.get('userAbility') as AppAbility | undefined;
  }

  /**
   * Is cross-doctor consultation sharing available to the REQUEST's tenant?
   *
   * TASK-932 S2-4 — resolved through the settings-registry cascade
   * (`tenant row -> SYSTEM row -> descriptor default`), not by a
   * `GlobalSettingRepository.findAll` issued from a controller. Three things
   * change, and the third is the one to read carefully:
   *
   *  1. NO DATA ACCESS HERE. Rule 05: a controller holds no business logic and
   *     no Prisma/repository access. `TenantSettingsService.resolve` is
   *     SYNCHRONOUS — it reads the AppSettings in-memory cache — so this is
   *     also strictly less work per request than the query it replaces.
   *  2. THE VALUE CASCADES. A platform admin can now withdraw sharing from one
   *     tenant, or platform-wide, from the Feature availability matrix; before,
   *     only a row physically present in that tenant could say anything, and
   *     the flag was un-writable through any governed lane.
   *  3. ABSENCE AND FAILURE ARE NO LONGER THE SAME ANSWER.
   *       - ABSENCE (no tenant row, no SYSTEM row) resolves the DESCRIPTOR
   *         default, which is `true`. Every seeded tenant carries an explicit
   *         `'true'` row today and OD-1 removes those clones so tenants inherit
   *         that default — the sweep is behaviour-preserving precisely because
   *         the default matches what the rows said. This IS a change for a
   *         tenant that never had a row (runtime-created tenants: previously
   *         closed, now open); it is the owner's decision, recorded as OD-1.
   *       - FAILURE (the resolver raised: cache not initialised, unknown key
   *         after a bad rename) is NOT a value and stays fail-CLOSED. An
   *         unreachable control plane must never be reported as "the default"
   *         on a path that grants read access to a clinical record.
   *
   * Still tenant-scoped and still strict: no tenant in context is closed, and
   * only the boolean `true` opens the fallback.
   */
  private isSharingEnabled(): boolean {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) return false;
    try {
      return this.tenantSettings.resolve<boolean>(CONSULTATION_SHARING_ENABLED_KEY, tenantId).value === true;
    } catch (err) {
      this.logger.warn({
        message: 'isSharingEnabled resolution failed; defaulting to CLOSED',
        tenantId,
        error: (err as Error)?.message,
      });
      return false;
    }
  }

  /**
   * Two-layer READ access check:
   *
   * Layer 1 — CASL PolicyEngine (database-driven):
   *   The `@Authorize()` decorator already ran the guard and built the
   *   user's ability. If the static CASL rules grant `read Consultation`
   *   with matching conditions (e.g., owner via `doctorId: ${user.id}`),
   *   access is allowed immediately.
   *
   * Layer 2 — Dynamic shared-patient fallback:
   *   If the caller is NOT the owner, check whether they have any
   *   consultation with the same patient in the same tenant AND the
   *   `enable-consultation-sharing` feature gate is on for that tenant
   *   (TASK-932 S2-4: resolved through the settings cascade). This is a
   *   runtime lookup that cannot be expressed as a static CASL condition.
   */
  private async verifyConsultationAccess(consultationId: string): Promise<{ doctorId: string; patientId: string }> {
    const consultation = await this.consultationService.getById(consultationId);
    if (!consultation) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }

    // TASK-933 §3.3 — Layer 0: the MACHINE branch. Tenant + scope, and nothing else.
    //
    // A service account's authority is exactly its `svc:*` scopes, which the guard has already
    // required to reach this handler, plus the tenant it bound at token EXCHANGE. What it is
    // NOT is a doctor: there is no `doctorId` equality to evaluate, no CASL `userAbility` to
    // consult (that CLS key is only ever written for a human, and reading it here would widen a
    // machine to whatever the last human in this process held), and no shared-patient
    // relationship to look up.
    //
    // The TENANT boundary is already closed twice over by the time we get here, which is why
    // there is nothing left to assert: `ConsultationService.getById` runs `assertEqualTenants`
    // against the CLS tenant, and `Consultation` is in `TENANT_SCOPED_MODELS` so the extended
    // Prisma client scopes the read in the first place. Both answer 404, never 403.
    if (this.getServiceAccountId()) {
      return consultation;
    }

    const doctorId = this.getDoctorId();

    // Layer 1: owner check (matches CASL `consultation-own-manage` policy)
    if (consultation.doctorId === doctorId) {
      return consultation;
    }

    // Layer 1b: CASL ability check for non-owner read (e.g., tenant-admin, dept-head)
    const ability = this.getUserAbility();
    if (ability) {
      const canRead = this.policyEngine.can(ability, 'read', 'Consultation', {
        tenantId: this.cls.get('tenantId'),
        doctorId: consultation.doctorId,
      } as Record<string, unknown>);
      if (canRead) return consultation;
    }

    // Layer 2: dynamic shared-patient check (configurable per tenant).
    // Not awaited: the cascade read is synchronous (see `isSharingEnabled`).
    const sharingEnabled = this.isSharingEnabled();
    if (!sharingEnabled) {
      throw new ForbiddenException('You do not have access to this consultation');
    }

    const tenantId = this.cls.get('tenantId') ?? '';
    const hasSharedPatient = await this.consultationService.doctorHasPatientRelationship(doctorId, consultation.patientId, tenantId);
    if (!hasSharedPatient) {
      throw new ForbiddenException('You do not have access to this consultation');
    }

    this.logger.debug({
      message: 'Shared-patient read access granted',
      doctorId,
      consultationId,
      patientId: consultation.patientId,
    });

    return consultation;
  }

  /**
   * Two-layer WRITE access check:
   *
   * Layer 1 — Ownership: only the assigned doctor can mutate.
   * Layer 1b — CASL: admin/dept-head with `manage Consultation` bypasses.
   *
   * Shared-patient doctors NEVER get write access.
   */
  private async verifyConsultationOwnership(consultationId: string): Promise<{ doctorId: string; patientId: string }> {
    const consultation = await this.consultationService.getById(consultationId);
    if (!consultation) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }

    // TASK-933 §3.3 — the MACHINE branch, same shape and same reasoning as the read check
    // above: the account was granted `svc:consultation:session:write` on purpose, the tenant
    // boundary is closed before this line, and the ROW supplies the clinician.
    if (this.getServiceAccountId()) {
      return consultation;
    }

    const doctorId = this.getDoctorId();
    if (consultation.doctorId === doctorId) {
      return consultation;
    }

    // Allow admin/dept-head with broad `manage` permission
    const ability = this.getUserAbility();
    if (ability) {
      const canManage = this.policyEngine.can(ability, 'manage', 'Consultation', {
        tenantId: this.cls.get('tenantId'),
        doctorId: consultation.doctorId,
      } as Record<string, unknown>);
      if (canManage) return consultation;
    }

    throw new ForbiddenException('Only the assigned doctor can modify this consultation');
  }

  /**
   * Verify the caller has a relationship with a patient (at least one
   * consultation with them) before allowing access to patient-level data.
   */
  private async verifyPatientAccess(patientId: string): Promise<void> {
    const doctorId = this.getDoctorId();
    const tenantId = this.cls.get('tenantId') ?? '';
    const hasRelationship = await this.consultationService.doctorHasPatientRelationship(doctorId, patientId, tenantId);
    if (!hasRelationship) {
      throw new ForbiddenException('You do not have access to this patient');
    }
  }

  // ─── Consultation CRUD ───────────────────────────────────────────

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    method: HttpMethod.POST,
    path: 'open',
  })
  // TASK-933 §3.2 — the realtime consultation plane, opened to the machine class. The account's
  // authority is exactly this scope plus the ability it implies (`create:Consultation`); the
  // CLINICIAN it acts for is named on the body and validated in the service.
  @Authorize(['create', 'Consultation'])
  @RequiredSvcScopes('svc:consultation:session:write')
  @ApiResponse({
    status: 400,
    description:
      'Bad request. `CLINICIAN_REQUIRED` — a service-account caller named no `clinicianUserId`; `CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER` — a human caller supplied one.',
  })
  @ApiResponse({ status: 404, description: 'The named clinician is not a user of this tenant, or may not own a consultation.' })
  async open(@Body() request: OpenConsultationRequest): Promise<ConsultationResponse> {
    return this.consultationService.getOrCreate(request, this.resolveActingClinicianId(request));
  }

  /**
   * the SELECTABLE-set half of workflow selection.
   *
   * `open` accepts `workflowDefinitionSlug` and authorizes it, but until now nothing returned
   * the set of slugs that would pass that gate, so the contract was "guess a slug, get a
   * 404/403". `GET /workflows` is not that route: it is the exposure plane, gated
   * `CanList('WorkflowDefinition')` + scope `workflow:definition:read` which no clinician-facing
   * integration need hold — and it structurally EXCLUDES the consultation palette
   * (`EXPOSURE_ALLOWED_PALETTES` is `{summarization}`), so it lists none of these.
   *
   * The advertised set and the authorized set are one predicate with two consumers
   * (`consultation-selection-policy.ts`), so this route can never advertise a slug the gate
   * refuses, nor hide one it allows.
   *
   * DECLARATION ORDER IS LOAD-BEARING: this must stay above `getById`'s `:id` route, or Express
   * matches `/consultations/workflows` as a consultation id and answers 404. Do not move it
   * below.
   *
   * AUTH-NOTE: `create:Consultation` on a GET is deliberate and is the whole authorization
   * decision. This route is not a `WorkflowDefinition` read surface — it answers "what may I
   * pass to `open`", so it is gated by the ability `open` itself requires, and by nothing else.
   * Consequences, each of them intended:
   *   * a clinician who can open a consultation can see their options, WITHOUT holding any
   *     `WorkflowDefinition` ability — which is the point; requiring one would leave the gap
   *     this route exists to close;
   *   * the class-level bare `@Authorize()` is deliberately OVERRIDDEN. Inheriting it would let
   *     any authenticated tenant user enumerate the tenant's authored workflows, which is
   *     configuration disclosure with no matching capability. Unlike its sibling
   *     `:id/workflow`, a tenant-wide list has no per-row `verifyConsultationAccess` to lean on,
   *     so the ability IS the boundary;
   *   * `consultation:session:write` — the scope `open` carries — for the same reason, and not
   *     `…:read`: a key scoped only to read cannot open a consultation, so the set would be
   *     useless to it, while a key that CAN open would be unable to discover. The reachable set
   *     is exactly the set that can act on the answer;
   *   * no `@RequiredSvcScopes`, so service accounts are refused (deny-by-default). AMENDED
   *     BY TASK-933: `open` itself IS now reachable by a machine, so this clause no longer
   *     mirrors it — and that asymmetry is the decision, not an oversight. A broker names the
   *     clinician, the patient and the DEPARTMENT, and the department's own assignment picks
   *     the workflow (§1.1); it has no business enumerating the tenant's authored workflows to
   *     override that pick. If a machine ever needs the selectable set, opening this route is
   *     a one-line decision to take on purpose.
   * Cross-tenant does not arise: `tenantId` comes from CLS, never from the request, so there is
   * no foreign identifier to answer 404 for. A privilege failure inside the caller's own tenant
   * is a 403.
   */
  @Get('workflows')
  @Authorize(['create', 'Consultation'])
  @RequiredScopes('consultation:session:write')
  @ApiOperation({
    summary: 'The workflows this caller may select when opening a consultation.',
    description:
      "The set of `workflowDefinitionSlug` values `POST /consultations/open` will accept for the caller's tenant — the same predicate that route authorizes with, so a slug listed here is never refused and a slug omitted here is never accepted. Tenant-scoped from the session, so it takes no tenant or department parameter. An empty `data` array means the tenant has published no consultation-palette workflow, which is the normal case: the platform default engine governs. `isTenantDefault` marks the TENANT-tier assignment; a department override can still win at open.",
  })
  @ApiResponse({ status: 200, type: SelectableConsultationWorkflowListResponse })
  @ApiResponse({ status: 403, description: 'The caller may not open consultations, and so may not choose a workflow for one.' })
  @ApiResponse({ status: 503, description: 'This deployment cannot dispatch selected workflows, so it cannot say which are selectable.' })
  async listSelectableWorkflows(): Promise<SelectableConsultationWorkflowListResponse> {
    return this.consultationService.listSelectableWorkflows();
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  @RequiredScopes('consultation:session:read')
  @RequiredSvcScopes('svc:consultation:session:read')
  async getById(@Param('id') id: string): Promise<ConsultationResponse> {
    await this.verifyConsultationAccess(id);
    const result = await this.consultationService.getByIdWithRelations(id);
    if (!result) throw new NotFoundException(`Consultation ${id} not found`);
    return result;
  }

  /**
   * the discovery half of workflow selection.
   *
   * The governing-engine decision was already durable (written to
   * `Consultation.metadata` at open, read by `LoopContextSignalService` before every
   * loop signal) but nothing returned it, so a client that selected a workflow had no
   * way to learn whether the selection took effect — dispatch degrades to the default
   * engine on a harness outage, by design and silently.
   *
   * Same access posture as `getById`: `verifyConsultationAccess` first, so an unknown
   * or cross-tenant id is a 404 rather than a disclosure.
   */
  @Get(':id/workflow')
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @RequiredScopes('consultation:session:read')
  @ApiOperation({
    summary: 'Which engine governs this consultation, and the identity of the tenant-authored workflow when one does.',
    description:
      '`governed: false` means the platform default consultation loop governs — the outcome for every consultation with no workflow assignment and no selection at open, and also the fallback when dispatch of a selected workflow could not proceed. `inputSchema` is always null: no per-definition input schema is declared anywhere in the substrate yet, and the field is present so declaring one later is additive rather than a new field to discover.',
  })
  @ApiResponse({ status: 200, type: ConsultationWorkflowResponse })
  @ApiResponse({ status: 403, description: 'The caller may not read this consultation.' })
  @ApiResponse({ status: 404, description: 'Unknown or cross-tenant consultation id.' })
  async getGoverningWorkflow(@Param('id') id: string): Promise<ConsultationWorkflowResponse> {
    await this.verifyConsultationAccess(id);
    return this.consultationService.getGoverningWorkflow(id);
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    multi: true,
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'patientId', required: false, type: String })
  async list(@Query() query: PaginatedQuery & { patientId?: string }): Promise<PaginatedConsultationResponse> {
    return this.consultationService.listConsultations({
      page: Number(query.page) || 1,
      pageSize: Number(query.limit) || 10,
      doctorId: this.getDoctorId(),
      patientId: query.patientId,
    });
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    multi: true,
    path: 'patient/:patientId/history',
    by: ['patientId'],
  })
  @ApiParam({ name: 'patientId', description: 'Patient ID' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  // Consent & ABAC. Prior-history retrieval is one of the four
  // gated stages named in flow.
  @RequiresConsent(ConsentPurpose.HISTORY_RETRIEVAL)
  async getPatientHistory(@Param('patientId') patientId: string, @Query() query: PaginatedQuery): Promise<PaginatedConsultationResponse> {
    await this.verifyPatientAccess(patientId);
    return this.consultationService.getPatientHistoryPaginated(patientId, Number(query.page) || 1, Number(query.limit) || 10);
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    multi: true,
    path: 'patient/:patientId/date/:date',
    by: ['patientId', 'date'],
  })
  @ApiParam({ name: 'patientId', description: 'Patient ID' })
  @ApiParam({ name: 'date', description: 'Appointment date (YYYY-MM-DD)' })
  // Consent & ABAC. Same purpose as getPatientHistory — a
  // date-scoped view of the same prior-history retrieval stage.
  @RequiresConsent(ConsentPurpose.HISTORY_RETRIEVAL)
  async getByPatientAndDate(@Param('patientId') patientId: string, @Param('date') date: string): Promise<ConsultationResponse[]> {
    await this.verifyPatientAccess(patientId);
    return this.consultationService.getByPatientAndDate(patientId, date);
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    multi: true,
    path: ':id/chain',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  // Consent & ABAC. The chain is a cross-visit history view — the
  // same prior-history retrieval stage as getPatientHistory, gated on the
  // SAME purpose even though this route resolves patientId via the loaded
  // consultation (:id) rather than a :patientId param.
  @RequiresConsent(ConsentPurpose.HISTORY_RETRIEVAL)
  async getChain(@Param('id') id: string): Promise<ConsultationResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.consultationService.getConsultationChain(id);
  }

  // ─── Lifecycle ────────────────────────────────────────

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update the safely-mutable fields of a consultation',
    description:
      'Optimistic concurrency is ENFORCED: the `If-Match` header (RFC 7232) is REQUIRED and the server runs a ' +
      "Compare-And-Set against the row's `_version`. This closes the last unprotected write on the Consultation " +
      'aggregate — `prime`/`close`/`reopen` and the context/summary sub-resource writes already required it, so a ' +
      'second open tab could previously clobber an edit here silently. Drift is `412 Precondition Failed`; a ' +
      'missing header is `428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the consultation version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateConsultationRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<ConsultationResponse> {
    await this.verifyConsultationOwnership(id);
    return this.consultationService.updateConsultation(id, request, expectedFromHeader);
  }

  // session state machine. `prime`/`close`/`reopen` are the API
  // surface of the legality matrix (; each carries
  // `@RequiresIfMatch()` + `@ExpectedVersion()` (/05-nestjs-api.md
  // Concurrency) so a stale client CAS-fails (412) rather than
  // silently clobbering a concurrent transition, and an illegal transition
  // surfaces as 409 (`ConsultationService.applyTransition` maps the domain
  // `BusinessException` — verified by the parity unit test alongside this
  // controller: `@ApiEndpoint()` composes cleanly with both decorators, the
  // same way `startRecording` already composes it with `@RequiresConsent`).

  // TASK-869 — the published contract says 200 and Nest's POST default is 201.
  // Without this the runtime and `openapi.json` disagreed, and every spec that
  // touched these routes had quietly widened to `[200, 201]` to cope. A
  // generated client (vox-node is generated FROM that document) expects 200.
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    method: HttpMethod.POST,
    path: ':id/prime',
    by: ['id'],
  })
  @RequiresIfMatch()
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  @ApiResponse({ status: 409, description: "Illegal state transition for the consultation's current status." })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  // Consent & ABAC. `prime` is the session state machine's first
  // checkpoint — the same AI_DOCUMENTATION purpose `recording/start` already
  // gates (that decorator is left in place; a follow-up ticket removes it
  // once `prime` is the sole consent checkpoint, per the kill-switch's own
  // rollout note below).
  @RequiresConsent(ConsentPurpose.AI_DOCUMENTATION)
  async prime(@Param('id') id: string, @ExpectedVersion() expectedVersion: number | undefined): Promise<ConsultationResponse> {
    await this.verifyConsultationOwnership(id);
    return this.consultationService.primeConsultation(id, expectedVersion);
  }

  // TASK-869 — the published contract says 200 and Nest's POST default is 201.
  // Without this the runtime and `openapi.json` disagreed, and every spec that
  // touched these routes had quietly widened to `[200, 201]` to cope. A
  // generated client (vox-node is generated FROM that document) expects 200.
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    method: HttpMethod.POST,
    path: ':id/close',
    by: ['id'],
  })
  @RequiresIfMatch()
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  @ApiResponse({ status: 409, description: 'Illegal state transition — the consultation is not SIGNED or TIMED_OUT.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async close(@Param('id') id: string, @ExpectedVersion() expectedVersion: number | undefined): Promise<ConsultationResponse> {
    await this.verifyConsultationOwnership(id);
    return this.consultationService.closeConsultation(id, expectedVersion);
  }

  // TASK-869 — the published contract says 200 and Nest's POST default is 201.
  // Without this the runtime and `openapi.json` disagreed, and every spec that
  // touched these routes had quietly widened to `[200, 201]` to cope. A
  // generated client (vox-node is generated FROM that document) expects 200.
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    method: HttpMethod.POST,
    path: ':id/reopen',
    by: ['id'],
  })
  @RequiresIfMatch()
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  @ApiResponse({ status: 409, description: "Illegal state transition for the consultation's current status." })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async reopen(@Param('id') id: string, @ExpectedVersion() expectedVersion: number | undefined): Promise<ConsultationResponse> {
    await this.verifyConsultationOwnership(id);
    return this.consultationService.reopenConsultation(id, expectedVersion);
  }

  // ─── Recording lifecycle + live summary (Clinical Workflow Playground) ───
  //
  // WS2 — recording/start flips Consultation.status → RECORDING and starts the
  // per-consultation LiveDocumentationService session; recording/stop tears the
  // session down (optionally persisting a PRE_SUMMARY snapshot) and reverts the
  // status to OPEN (the harness later promotes it to PENDING_REVIEW).
  // WS1 — live-summary/stream relays the Redis pub/sub channel
  // `consultation:live-summary:{id}` to the client over SSE, mirroring the
  // consultation job-updates stream (auth via @TenantOwnedResource pre-stream
  // guard + @StreamScope ticket).

  // TASK-869 — the published contract says 200 and Nest's POST default is 201.
  // Without this the runtime and `openapi.json` disagreed, and every spec that
  // touched these routes had quietly widened to `[200, 201]` to cope. A
  // generated client (vox-node is generated FROM that document) expects 200.
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    returnedModel: RecordingStateResponse,
    method: HttpMethod.POST,
    path: ':id/recording/start',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  // Consent & ABAC. Capture start is one of the four gated
  // stages named in flow.
  @RequiresConsent(ConsentPurpose.AI_DOCUMENTATION)
  @RequiredSvcScopes('svc:consultation:session:write')
  async startRecording(@Param('id') id: string, @Body() request: StartRecordingRequest): Promise<RecordingStateResponse> {
    // TASK-933 — the live session belongs to the CLINICIAN, which the row records. For a human
    // caller that is the caller; for a machine there is no caller-as-person at all, and writing
    // the service-account id here would put a machine into the clinician's live-documentation
    // session (and, through it, into the DNA-style and prompt resolution that reads it).
    const owned = await this.verifyConsultationOwnership(id);
    const consultation = await this.consultationService.startRecording(id);
    this.liveDocumentationService.start({
      consultationId: id,
      tenantId: this.cls.get('tenantId') ?? '',
      userId: owned.doctorId,
      sessionId: request?.sessionId,
    });
    return {
      consultationId: id,
      status: consultation.status ?? 'RECORDING',
      recording: true,
      sessionId: request?.sessionId,
      sseUrl: `/consultations/${id}/live-summary/stream`,
      updatedAt: new Date().toISOString(),
    };
  }

  // TASK-869 — the published contract says 200 and Nest's POST default is 201.
  // Without this the runtime and `openapi.json` disagreed, and every spec that
  // touched these routes had quietly widened to `[200, 201]` to cope. A
  // generated client (vox-node is generated FROM that document) expects 200.
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    returnedModel: RecordingStateResponse,
    method: HttpMethod.POST,
    path: ':id/recording/stop',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  @RequiredSvcScopes('svc:consultation:session:write')
  async stopRecording(@Param('id') id: string, @Body() request: StopRecordingRequest): Promise<RecordingStateResponse> {
    await this.verifyConsultationOwnership(id);
    await this.liveDocumentationService.stop(id, { persistSnapshot: request?.persistSnapshot });
    const consultation = await this.consultationService.stopRecording(id);
    // Tell the consultation loop the recording stopped so it can
    // drain, run its ending actions, and finalize. Best-effort (a no-op when the
    // tenant is not entitled to the loop or the platform emergency stop is
    // engaged, and it swallows a failed harness call) — never lets a
    // loop-signal hiccup break the recording-stop response.
    await this.loopContextSignalService.signalConsultationEnding(id, {
      reason: 'recording_stopped',
      persistSnapshot: request?.persistSnapshot ?? true,
      // forward accepted corrections so `feedback.capture` has
      // something to promote over the raw transcript when the endpoint sequence runs.
      // Omitted (not an empty array) when the clinician accepted nothing this session.
      ...(request?.acceptedProposals?.length ? { acceptedProposals: request.acceptedProposals } : {}),
    });
    return {
      consultationId: id,
      status: consultation.status ?? 'OPEN',
      recording: false,
      sseUrl: `/consultations/${id}/live-summary/stream`,
      updatedAt: new Date().toISOString(),
    };
  }

  @Get(':id/live-summary/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })
  @StreamScope({ namespace: 'consultation_live_summary', param: 'id' })
  // TASK-933 — the four live planes REUSE the session write scope rather than minting a
  // read-only stream scope: every `svc:` scope is derived from a real API-key scope, so a new
  // one would widen the API-key surface too, and no read-only stream consumer exists. A machine
  // presents its own `X-Service-Account-Token` header here; the single-use `?ticket=` lane is a
  // JWT-side convenience it never needs.
  @RequiredSvcScopes('svc:consultation:session:write')
  @ApiOperation({
    summary: 'Stream the running live summary for an in-progress consultation via SSE',
    description:
      'Server-Sent Events stream relaying the Redis channel `consultation:live-summary:{id}`. Each event is a LiveSummaryEventDto JSON. Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `consultation_live_summary:<id>`. The terminal event carries `closed: true` when recording stops.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  streamLiveSummary(@Param('id') id: string): Observable<MessageEvent> {
    return this.liveDocumentationService.subscribeToLiveSummary(id);
  }

  // relays `consultation:live-assist:{id}` (published by the
  // internal POST /internal/harness/consultations/:id/live-assist route) so the
  // clinician surface can show interpreter suggestions and PROPOSED corrections
  // live.
  //
  // This plane is DECLARED PHI-CARRYING — a correction proposal quotes the span
  // it would replace, verbatim — so it gets the full sibling treatment of
  // `live-summary`: @TenantOwnedResource 404s a cross-tenant probe BEFORE the
  // stream opens, and it carries its OWN @StreamScope namespace so a
  // live-summary ticket can never be replayed to read correction proposals.
  //
  // Proposal-first by contract: nothing on this feed has been written to any
  // note. `corrections.applied` is the assertion, and the clinician decides.
  @Get(':id/live-assist/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })
  @StreamScope({ namespace: 'consultation_live_assist', param: 'id' })
  @RequiredSvcScopes('svc:consultation:session:write')
  @ApiOperation({
    summary: 'Stream interpreter suggestions and proposed corrections for a consultation via SSE',
    description:
      'Server-Sent Events stream relaying the Redis channel `consultation:live-assist:{id}`. Each event is a LiveAssistEventDto JSON carrying the current `suggestions` and `corrections` branches. CARRIES PHI: a correction proposal quotes the original span verbatim. Nothing on this feed has been applied to the note — `corrections.applied` is false and the clinician decides. Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `consultation_live_assist:<id>`. The feed has no terminal event; the client closes it.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({
    status: 404,
    description: 'Consultation not found — also the answer for a cross-tenant id (404-over-403), resolved BEFORE the stream opens',
  })
  streamLiveAssist(@Param('id') id: string): Observable<MessageEvent> {
    return this.harnessLiveAssistService.subscribeToAssist(id);
  }

  // Relays `consultation:harness-progress:{id}` (published by the internal
  // POST /internal/harness/consultations/:id/progress route) so the review
  // panel can show the live stage checklist while the draft generates.
  @Get(':id/harness-progress/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })
  @StreamScope({ namespace: 'consultation_harness_progress', param: 'id' })
  @RequiredSvcScopes('svc:consultation:session:write')
  @ApiOperation({
    summary: 'Stream live harness draft-generation progress for a consultation via SSE',
    description:
      'Server-Sent Events stream relaying the Redis channel `consultation:harness-progress:{id}`. Each event is a HarnessProgressEventDto JSON carrying the full accumulated stage list (no PHI). Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `consultation_harness_progress:<id>`. The terminal event carries `closed: true` when the draft is persisted.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  streamHarnessProgress(@Param('id') id: string): Observable<MessageEvent> {
    return this.harnessProgressService.subscribeToProgress(id);
  }

  // Relays `consultation:harness-assurance:{id}` (published per-claim by the
  // internal POST .../assurance-event route and closed by .../assurance) so
  // the review panel can stream each verdict live, enable sign-off when
  // assurance lands, and surface a safety flag / amendment alert. Its OWN
  // @StreamScope namespace: a progress ticket must not read verdicts.
  @Get(':id/harness-assurance/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })
  @StreamScope({ namespace: 'consultation_harness_assurance', param: 'id' })
  @ApiOperation({
    summary: 'Stream live harness assurance (per-claim verdicts) for a consultation via SSE',
    description:
      'Server-Sent Events stream relaying the Redis channel `consultation:harness-assurance:{id}`. Each event is a HarnessAssuranceEventDto JSON carrying the full accumulated claim-verdict list (no PHI — ids, sensor keys, verdict labels only). Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `consultation_harness_assurance:<id>`. The terminal `assurance_complete` event carries `closed: true` plus the aggregate gateDecision, safetyFlag, and postSignAlert.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  streamHarnessAssurance(@Param('id') id: string): Observable<MessageEvent> {
    return this.harnessAssuranceService.subscribeToAssurance(id);
  }

  // relays `consultation:trajectory:{id}` (each step is
  // republished there by AgentTrajectoryService.recordSteps) so an admin/review
  // surface can watch the ordered agentic session live. Ticket-scoped SSE,
  // mirroring the live-summary / harness-progress streams (@TenantOwnedResource
  // pre-stream 404 guard + @StreamScope one-shot ticket). Append-only feed: no
  // snapshot late-join (the admin read API serves history) and no terminal
  // `closed` event — the client closes when it navigates away.
  @Get(':id/trajectory/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })
  @StreamScope({ namespace: 'consultation_trajectory', param: 'id' })
  @ApiOperation({
    summary: 'Stream the ordered agentic-session trajectory for a consultation via SSE',
    description:
      'Server-Sent Events stream relaying the Redis channel `consultation:trajectory:{id}`. Each event is an AgentTrajectoryStepResponse JSON (stats-first; `payloadRef` is never included). Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `consultation_trajectory:<id>`.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  streamTrajectory(@Param('id') id: string): Observable<MessageEvent> {
    return sseFromRedisChannel(this.redisSubscriber, this.logger, {
      channel: `consultation:trajectory:${id}`,
      heartbeatMs: ConsultationController.TRAJECTORY_HEARTBEAT_MS,
      setupErrorPayload: JSON.stringify({ error: 'Failed to subscribe to trajectory', consultationId: id }),
      logContext: { consultationId: id },
    });
  }

  // relays `consultation:loop:{id}` (each event is published there by
  // ConsultationLoopEventService.publishEvent, POSTed by the future
  // ConsultationLoopWorkflow via `POST /internal/harness/consultations/:id/loop-event`).
  // Ticket-scoped SSE, mirroring the trajectory stream precisely
  // (@TenantOwnedResource pre-stream 404 guard + @StreamScope one-shot
  // ticket, same merged heartbeat). Append-only feed: no snapshot late-join
  // and no terminal `closed` event — the client closes when it navigates away.
  @Get(':id/loop/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })
  @StreamScope({ namespace: 'consultation_loop', param: 'id' })
  @RequiredSvcScopes('svc:consultation:session:write')
  @ApiOperation({
    summary: 'Stream consultation-loop workflow events for a consultation via SSE',
    description:
      'Server-Sent Events stream relaying the Redis channel `consultation:loop:{id}`. Each event is a LoopEventDto JSON. Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `consultation_loop:<id>`.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  streamLoop(@Param('id') id: string): Observable<MessageEvent> {
    return sseFromRedisChannel(this.redisSubscriber, this.logger, {
      channel: `consultation:loop:${id}`,
      heartbeatMs: ConsultationController.TRAJECTORY_HEARTBEAT_MS,
      setupErrorPayload: JSON.stringify({ error: 'Failed to subscribe to loop events', consultationId: id }),
      logContext: { consultationId: id },
    });
  }

  // ─── Timeline ────────────────────────────────────────────────────

  @ApiEndpoint({
    returnedModel: ConsultationTimelineResponse,
    path: ':id/timeline',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiQuery({ name: 'scope', required: false, enum: ['single', 'chain'] })
  async getTimeline(@Param('id') id: string, @Query('scope') scope?: 'single' | 'chain'): Promise<ConsultationTimelineResponse> {
    await this.verifyConsultationAccess(id);
    return this.timelineService.getTimeline(id, scope ?? 'chain');
  }

  // ─── Context Items ───────────────────────────────────────────────

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    method: HttpMethod.POST,
    path: ':id/context',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiHeader({
    name: 'X-Context-Schema-Version',
    required: false,
    description:
      'the tenant-declared context-schema version the CALLER built against (a `ConsultationContextSchemaVersion` id, ' +
      'e.g. from the discovery bundle `contextSchemaVersionId` read at session open). When `request.kindKey` is present, the ' +
      "payload validates against THIS version rather than the tenant's current pin — a client on an older schema version is " +
      'never silently upgraded (or broken) by a publish that lands mid-consultation. Ignored when `kindKey` is absent.',
  })
  @RequiredSvcScopes('svc:consultation:session:write')
  async addContext(
    @Param('id') id: string,
    @Body() request: AddContextRequest,
    @Headers('x-context-schema-version') contextSchemaVersionId?: string,
  ): Promise<ContextItemResponse> {
    await this.verifyConsultationOwnership(id);
    return this.contextService.addContext(id, request, contextSchemaVersionId);
  }

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    multi: true,
    path: ':id/context',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getContextItems(@Param('id') id: string): Promise<ContextItemResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getContextItems(id);
  }

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    multi: true,
    path: ':id/context/shared',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getSharedContext(@Param('id') id: string): Promise<ContextItemResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getSharedContext(id);
  }

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    multi: true,
    path: ':id/context/transcriptions',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getTranscriptions(@Param('id') id: string): Promise<ContextItemResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getTranscriptions(id);
  }

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    multi: true,
    path: ':id/context/case-notes',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getCaseNotes(@Param('id') id: string): Promise<ContextItemResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getContextItems(id, { type: 'CASE_NOTE' });
  }

  // ─── Audio Recordings (dual-capture) ────────────

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    method: HttpMethod.POST,
    path: ':id/recordings',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async addRecording(@Param('id') id: string, @Body() request: AddAudioRecordingRequest): Promise<ContextItemResponse> {
    await this.verifyConsultationOwnership(id);
    return this.contextService.addAudioRecording(id, request);
  }

  @ApiEndpoint({
    returnedModel: AudioRecordingResponse,
    multi: true,
    path: ':id/recordings',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getRecordings(@Param('id') id: string): Promise<AudioRecordingResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getAudioRecordings(id);
  }

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    method: HttpMethod.PATCH,
    path: ':id/context/:contextId',
    by: ['id', 'contextId'],
  })
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update context item content under optimistic concurrency',
    description:
      'Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED, and the server runs a ' +
      "Compare-And-Set against the row's `_version`. When the header is present, its value overrides the " +
      'body-field `expectedVersion`. On version drift the response is `412 Precondition Failed`; missing header is ' +
      '`428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextId', description: 'Context Item ID' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async updateContext(
    @Param('id') id: string,
    @Param('contextId') contextId: string,
    @Body() request: UpdateContextRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<ContextItemResponse> {
    await this.verifyConsultationOwnership(id);
    // Header takes precedence over body when both are present (house
    // precedence, `department.controller.ts#update`).
    const effectiveRequest: UpdateContextRequest = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.contextService.updateContext(contextId, effectiveRequest);
  }

  // Soft-delete a context item (note / case-note / work-note / attachment).
  // Ownership-guarded like the other write routes; the service performs the
  // tenant-scoped soft-delete + ResourceDeleted broadcast.
  @ApiEndpoint({
    returnedModel: OkResponseDto,
    method: HttpMethod.DELETE,
    path: ':id/context/:contextId',
    by: ['id', 'contextId'],
    additionalData: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
        },
      },
    },
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextId', description: 'Context Item ID' })
  async deleteContext(@Param('id') id: string, @Param('contextId') contextId: string): Promise<OkResponseDto> {
    await this.verifyConsultationOwnership(id);
    await this.contextService.deleteContext(contextId);
    return new OkResponseDto();
  }

  // ─── Document Sections ───────────────────
  // The REST surface for `DocumentSection` — a clinical document
  // stored one section per row so that a flush writing `assessment` and a
  // clinician editing `plan` never contend.
  //
  // left the editing route to " or the console lane",
  // never took it, and declined it ("no section-level mutation
  // endpoint exists yet"), so until now `DocumentSectionStore.applyClinicianEdit`
  // had no caller outside its own tests and a clinician could not persist an edit
  // at all. These three routes are that caller.
  //
  // The GETs are not convenience: `_version` is the section's compare-and-set
  // token, it is NOT the `revision` the SSE `section.patch` carries, and the live
  // stream never publishes it. Without a read that emits the `ETag`, a client has
  // no way to obtain the `If-Match` the PATCH requires — the write route would be
  // unusable on its own.

  @ApiEndpoint({
    returnedModel: DocumentSectionResponse,
    multi: true,
    path: ':id/documents/:documentKey/sections',
    by: ['id', 'documentKey'],
  })
  @ApiOperation({
    summary: 'List the persisted sections of one clinical document',
    description:
      'Returns every section of `documentKey` for this consultation in render order (`idx` ascending), with decrypted content. ' +
      'This is the DURABLE view: the `section.patch` SSE lane only emits while a flush is running, so a client that reloads ' +
      'mid-encounter reads its state here. Each item carries `version` — the value that section requires as its `If-Match`.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'documentKey', description: "The tenant's `DocumentTemplate.slug` (e.g. `soap_note`, `discharge_summary`)" })
  @ApiResponse({ status: 404, description: 'Consultation not found, or not visible to this caller.' })
  async listDocumentSections(@Param('id') id: string, @Param('documentKey') documentKey: string): Promise<DocumentSectionResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.documentSectionService.listSections(id, documentKey);
  }

  @ApiEndpoint({
    returnedModel: DocumentSectionResponse,
    path: ':id/documents/:documentKey/sections/:sectionKey',
    by: ['id', 'documentKey', 'sectionKey'],
  })
  @ApiOperation({
    summary: 'Read one section of a clinical document',
    description:
      'Returns the section with its content decrypted. The response carries `version`, which the `ETagInterceptor` also emits as a strong ' +
      '`ETag` — that validator is what the PATCH below requires as `If-Match`. Note `version` and `revision` are different numbers doing ' +
      'different jobs: `revision` orders the SSE stream, `version` is the concurrency precondition.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'documentKey', description: "The tenant's `DocumentTemplate.slug`" })
  @ApiParam({ name: 'sectionKey', description: "The compiled template's section key (e.g. `assessment`)" })
  @ApiResponse({ status: 404, description: 'No such section for this consultation, or it is not visible to this caller.' })
  async getDocumentSection(
    @Param('id') id: string,
    @Param('documentKey') documentKey: string,
    @Param('sectionKey') sectionKey: string,
  ): Promise<DocumentSectionResponse> {
    await this.verifyConsultationAccess(id);
    return this.documentSectionService.getSection(id, documentKey, sectionKey);
  }

  @ApiEndpoint({
    returnedModel: DocumentSectionResponse,
    method: HttpMethod.PATCH,
    path: ':id/documents/:documentKey/sections/:sectionKey',
    by: ['id', 'documentKey', 'sectionKey'],
  })
  @RequiresIfMatch()
  // AUTH-NOTE: the class-level `@Authorize()` UNDERSTATES this route. The real gate
  // is imperative — `verifyConsultationOwnership`, the same helper `updateContext`
  // uses: only the assigned doctor (or an admin holding `manage Consultation`) may
  // write. A shared-patient colleague passes the READ gate the two GETs above use
  // and must still fail here, because editing a colleague's note is not a read.
  // That distinction cannot be expressed declaratively — there is no "owner"
  // subject — so it lives in the helper and is pinned by
  // `consultation.controller.document-sections.test.ts`.
  @ApiOperation({
    summary: 'Persist a clinician edit to one document section',
    description:
      'Writes the clinician-authored body of one section and transitions it to `confirmed`, after which a flush may append but will never ' +
      'overwrite it. Optimistic concurrency is enforced per SECTION: `If-Match` (RFC 7232) is REQUIRED and is compare-and-set against that ' +
      "row's `_version`, so an edit composed against a stale render LOSES to a flush that landed in between. When the header is present it " +
      'OVERRIDES the body `expectedVersion`. A section the endpoint stage has finalized is `locked` and returns 409 — that is a state ' +
      'conflict, not a stale precondition, so re-reading and retrying cannot help. Unlike a flush, a clinician emptying a section needs no ' +
      'transcript contradiction.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the section `version` the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'documentKey', description: "The tenant's `DocumentTemplate.slug`" })
  @ApiParam({ name: 'sectionKey', description: "The compiled template's section key" })
  @ApiResponse({ status: 404, description: 'No such section for this consultation, or it is not visible to this caller.' })
  @ApiResponse({ status: 409, description: 'The section is LOCKED — the encounter was finalized and no version of it is writable.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch the section and re-apply against the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async updateDocumentSection(
    @Param('id') id: string,
    @Param('documentKey') documentKey: string,
    @Param('sectionKey') sectionKey: string,
    @Body() request: UpdateDocumentSectionRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<DocumentSectionResponse> {
    await this.verifyConsultationOwnership(id);
    // Header wins over body (house precedence, `department.controller.ts#update`).
    // `@RequiresIfMatch()` guarantees the header is present, so this is the
    // operand in practice; the body field remains for non-browser callers.
    const effectiveRequest: UpdateDocumentSectionRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.documentSectionService.updateSectionContent(id, documentKey, sectionKey, effectiveRequest);
  }

  // ─── Manual Highlights ───────────────────
  // Doctor-authored highlights anchored to a persisted surface (transcript /
  // case note / work note / summary) via W3C dual selectors. A SEPARATE
  // aggregate from NamedEntity so manual marks never pollute the AI NER
  // aggregation. Writes are ownership-guarded; reads use the broader access
  // guard, mirroring the Context Item routes above.

  @ApiEndpoint({
    returnedModel: HighlightResponse,
    method: HttpMethod.POST,
    path: ':id/highlights',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async createHighlight(@Param('id') id: string, @Body() request: CreateHighlightRequest): Promise<HighlightResponse> {
    await this.verifyConsultationOwnership(id);
    return this.highlightService.createHighlight(id, request);
  }

  @ApiEndpoint({
    returnedModel: HighlightResponse,
    multi: true,
    path: ':id/highlights',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getHighlights(@Param('id') id: string): Promise<HighlightResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.highlightService.getHighlights(id);
  }

  @ApiEndpoint({
    returnedModel: OkResponseDto,
    method: HttpMethod.DELETE,
    path: ':id/highlights/:highlightId',
    by: ['id', 'highlightId'],
    additionalData: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
        },
      },
    },
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'highlightId', description: 'Highlight ID' })
  async deleteHighlight(@Param('id') id: string, @Param('highlightId') highlightId: string): Promise<OkResponseDto> {
    await this.verifyConsultationOwnership(id);
    await this.highlightService.deleteHighlight(id, highlightId);
    return new OkResponseDto();
  }

  @ApiEndpoint({
    returnedModel: ContextItemVersionResponse,
    multi: true,
    path: ':id/context/:contextId/versions',
    by: ['id', 'contextId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextId', description: 'Context Item ID' })
  async getContextVersions(@Param('id') id: string, @Param('contextId') contextId: string): Promise<ContextItemVersionResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getVersionHistory(contextId);
  }

  @ApiEndpoint({
    returnedModel: ContextItemVersionResponse,
    path: ':id/context/:contextId/versions/:versionNumber',
    by: ['id', 'contextId', 'versionNumber'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextId', description: 'Context Item ID' })
  @ApiParam({ name: 'versionNumber', description: 'Version number', type: Number })
  async getContextVersion(
    @Param('id') id: string,
    @Param('contextId') contextId: string,
    @Param('versionNumber') versionNumber: string,
  ): Promise<ContextItemVersionResponse | null> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getVersion(contextId, Number(versionNumber));
  }

  // ─── Summary ─────────────────────────────────────────────────────

  @ApiEndpoint({
    returnedModel: SummaryResponse,
    method: HttpMethod.POST,
    path: ':id/summary',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @RequiredScopes('consultation:report:write')
  async generateSummary(@Param('id') id: string, @Body() request: GenerateSummaryRequest): Promise<SummaryResponse> {
    await this.verifyConsultationOwnership(id);
    return this.summaryService.generateSummary(id, request);
  }

  @ApiEndpoint({
    returnedModel: SummaryResponse,
    multi: true,
    path: ':id/summary',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @RequiredScopes('consultation:report:read')
  async getSummaries(@Param('id') id: string): Promise<SummaryResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.summaryService.getSummaries(id);
  }

  @ApiEndpoint({
    returnedModel: SummaryResponse,
    method: HttpMethod.POST,
    path: ':id/summary/pre-summary',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @RequiredScopes('consultation:report:write')
  // TASK-933 — `svc:consultation:report:write` already existed (the standalone summarization
  // family) and was seeded; it simply had no consultation route declaring it.
  @RequiredSvcScopes('svc:consultation:report:write')
  async generatePreSummary(@Param('id') id: string, @Body() request: GeneratePreSummaryRequest): Promise<SummaryResponse> {
    await this.verifyConsultationOwnership(id);
    return this.summaryService.generatePreSummary(id, request);
  }

  @ApiEndpoint({
    returnedModel: SummaryResponse,
    path: ':id/summary/latest',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found (or cross-tenant), or no summary has been generated yet.' })
  @RequiredScopes('consultation:report:read')
  @RequiredSvcScopes('svc:consultation:report:read')
  async getLatestSummary(@Param('id') id: string): Promise<SummaryResponse> {
    await this.verifyConsultationAccess(id);
    const summary = await this.summaryService.getLatestSummary(id);
    if (!summary) throw new NotFoundException(`No summary has been generated yet for consultation ${id}`);
    return summary;
  }

  @ApiEndpoint({
    returnedModel: SummaryResponse,
    path: ':id/summary/pre-summary/latest',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found (or cross-tenant), or no pre-summary has been generated yet.' })
  @RequiredScopes('consultation:report:read')
  @RequiredSvcScopes('svc:consultation:report:read')
  async getLatestPreSummary(@Param('id') id: string): Promise<SummaryResponse> {
    await this.verifyConsultationAccess(id);
    const preSummary = await this.summaryService.getLatestPreSummary(id);
    if (!preSummary) throw new NotFoundException(`No pre-summary has been generated yet for consultation ${id}`);
    return preSummary;
  }

  @ApiEndpoint({
    returnedModel: SummaryResponse,
    method: HttpMethod.PATCH,
    path: ':id/summary/:summaryId',
    by: ['id', 'summaryId'],
  })
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update summary content under optimistic concurrency',
    description:
      'Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED, and the server runs a ' +
      "Compare-And-Set against the row's `_version`. When the header is present, its value overrides the " +
      'body-field `expectedVersion`. On version drift the response is `412 Precondition Failed`; missing header is ' +
      '`428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'summaryId', description: 'Summary Context Item ID' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  @RequiredScopes('consultation:report:write')
  async updateSummary(
    @Param('id') id: string,
    @Param('summaryId') summaryId: string,
    @Body() request: UpdateSummaryRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<SummaryResponse> {
    await this.verifyConsultationOwnership(id);
    // Header takes precedence over body when both are present (house
    // precedence, `department.controller.ts#update`).
    const effectiveRequest: UpdateSummaryRequest = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.summaryService.updateSummary(summaryId, effectiveRequest);
  }

  @ApiEndpoint({
    returnedModel: ContextItemVersionResponse,
    multi: true,
    path: ':id/summary/:contextItemId/versions',
    by: ['id', 'contextItemId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  async getSummaryVersions(@Param('id') id: string, @Param('contextItemId') contextItemId: string): Promise<ContextItemVersionResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getVersionHistory(contextItemId);
  }

  // Read-only harness provenance (citationsMap + sensor scores + modelName)
  // for a generated summary. Normal clinician auth (inherits the class-level
  // @Authorize() + verifyConsultationAccess read gate); NOT the
  // service-to-service HarnessServiceTokenGuard.
  @ApiEndpoint({
    returnedModel: SummaryProvenanceResponse,
    path: ':id/summary/:contextItemId/provenance',
    by: ['id', 'contextItemId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  async getSummaryProvenance(@Param('id') id: string, @Param('contextItemId') contextItemId: string): Promise<SummaryProvenanceResponse> {
    await this.verifyConsultationAccess(id);
    return this.summaryService.getSummaryProvenance(contextItemId);
  }

  // Diffs two summary versions; the UI version-diff-panel renders the result.
  @ApiEndpoint({
    returnedModel: VersionDiffResponse,
    path: ':id/summary/:contextItemId/diff',
    by: ['id', 'contextItemId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  @ApiQuery({ name: 'from', description: 'Earlier version number', type: Number })
  @ApiQuery({ name: 'to', description: 'Later version number', type: Number })
  async diffSummaryVersions(
    @Param('id') id: string,
    @Param('contextItemId') contextItemId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<VersionDiffResponse> {
    await this.verifyConsultationAccess(id);
    return this.contextService.diffVersions(contextItemId, Number(from), Number(to));
  }

  // ─── Summary Tags ─────────────────────────────────────

  @ApiEndpoint({
    returnedModel: TagResponse,
    multi: true,
    path: ':id/summary/:contextItemId/tags',
    by: ['id', 'contextItemId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  async getSummaryTags(@Param('id') id: string, @Param('contextItemId') contextItemId: string): Promise<TagResponse[]> {
    await this.verifyConsultationAccess(id);
    const tags = await this.tagService.fetchByResource(ResourceType.ContextItem, contextItemId);
    return tags.map((tag) => TagDtoMapper.ToResponse(tag));
  }

  @ApiEndpoint({
    returnedModel: TagResponse,
    method: HttpMethod.POST,
    path: ':id/summary/:contextItemId/tags',
    by: ['id', 'contextItemId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  async tagSummary(@Param('id') id: string, @Param('contextItemId') contextItemId: string, @Body() body: CreateTagRequest): Promise<TagResponse> {
    await this.verifyConsultationOwnership(id);
    // Server controls the polymorphic target + tenant; client-supplied values are ignored.
    const created = await this.tagService.create({
      ...body,
      resourceTypeName: ResourceType.ContextItem,
      resourceId: contextItemId,
      tenantId: this.cls.get('tenantId') ?? undefined,
    });
    return TagDtoMapper.ToResponse(created);
  }

  @ApiEndpoint({
    returnedModel: OkResponseDto,
    method: HttpMethod.DELETE,
    path: ':id/summary/:contextItemId/tags/:tagId',
    by: ['id', 'contextItemId', 'tagId'],
    additionalData: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
        },
      },
    },
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  @ApiParam({ name: 'tagId', description: 'Tag ID' })
  async deleteSummaryTag(
    @Param('id') id: string,
    @Param('contextItemId') contextItemId: string,
    @Param('tagId') tagId: string,
  ): Promise<OkResponseDto> {
    await this.verifyConsultationOwnership(id);
    // Ensure the tag actually belongs to this summary before deleting (tenant-scoped fetch).
    const tag = await this.tagService.fetchById(tagId);
    if (tag.resourceId !== contextItemId) {
      throw new NotFoundException('Tag not found for this summary');
    }
    await this.tagService.deleteById(tagId);
    return new OkResponseDto();
  }

  @ApiEndpoint({
    returnedModel: OkResponseDto,
    method: HttpMethod.POST,
    path: ':id/summary/:contextItemId/extract-entities',
    by: ['id', 'contextItemId'],
    additionalData: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
        },
      },
    },
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  async extractEntities(@Param('id') id: string, @Param('contextItemId') contextItemId: string): Promise<OkResponseDto> {
    await this.verifyConsultationOwnership(id);
    await this.summaryService.extractEntities(contextItemId);
    return new OkResponseDto();
  }

  @ApiEndpoint({
    returnedModel: AsyncJobResponseDto,
    method: HttpMethod.POST,
    path: ':id/summary/async',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @RequiredScopes('consultation:report:write')
  async generateSummaryAsync(@Param('id') consultationId: string, @Body() request: GenerateSummaryRequest): Promise<AsyncJobResponseDto> {
    await this.verifyConsultationOwnership(consultationId);
    const tenantId = this.cls.get('tenantId') ?? 'unknown';
    const userId = this.getDoctorId();

    // this route used to enqueue onto the legacy `GenerateSummary`
    // BullMQ queue (`ConsultationJobService.createSummaryJob`), which decided
    // harness-vs-legacy only later, inside `SummaryProcessor.process()`. That
    // processor (the seam-decision site for THIS trigger) was deleted along
    // with the rest of the signable generator path, so the controller is now
    // the only remaining caller who can make the decision — it calls the
    // seam directly (the same pattern the auto-pipeline handler already
    // uses for `TRANSCRIPTION_CREATED`). Per-request `dnaStyleId`/`template`/
    // `contextItemIds` overrides are NOT forwarded — the harness workflow
    // resolves its own prompt/DNA config, exactly as the auto-pipeline
    // trigger already does; this route deliberately gained no new capability
    // versus TRANSCRIPTION_CREATED's harness path.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const contextItemId = (request as any)?.contextItemIds?.[0];
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const decision = await this.noteGenerationService.generate(GenerationTrigger.SUMMARY_REGENERATE, {
      consultationId,
      tenantId,
      userId,
      contextItemId,
    });

    if (decision.generator !== 'harness') {
      // Unreachable on the seam's own contract since TASK-882 (no
      // `harnessEnabled` toggle routes a supported trigger elsewhere) — the
      // legacy generator that used to run here no longer exists. Per `design.md` handling this is a VISIBLE
      // queued failure, never a silent no-op and never a resurrection of the
      // legacy generator.
      this.logger.error({
        message: 'generateSummaryAsync: seam resolved to the legacy generator, which no longer exists',
        consultationId,
        reason: decision.reason,
      });
      throw new ServiceUnavailableException(`Note generation is temporarily unavailable for this consultation (seam reason: ${decision.reason})`);
    }

    // Publish the job-status record for the harness's own correlation id.
    // The seam dispatches straight to apps/harness without touching BullMQ, so
    // nothing else writes it — and without it the jobId returned below is
    // unresolvable: `GET /consultations/jobs/:jobId` (plus `/cancel` and
    // `/stream`) 404s inside `TenantOwnedResourceInterceptor`, which reads
    // `getJobStatus` for its tenancy check. The legacy queue path deleted in
    // used to create this record.
    await this.consultationJobService.registerHarnessNoteJob(decision.harnessJobId, consultationId, tenantId, userId);

    return new AsyncJobResponseDto({
      jobId: decision.harnessJobId,
      status: 'pending',
      consultationId,
      createdAt: new Date().toISOString(),
    });
  }

  @ApiEndpoint({
    returnedModel: AsyncJobResponseDto,
    method: HttpMethod.POST,
    path: ':id/summary/pre-summary/async',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @RequiredScopes('consultation:report:write')
  @RequiredSvcScopes('svc:consultation:report:write')
  async generatePreSummaryAsync(@Param('id') consultationId: string, @Body() request: GeneratePreSummaryRequest): Promise<AsyncJobResponseDto> {
    const owned = await this.verifyConsultationOwnership(consultationId);
    const tenantId = this.cls.get('tenantId') ?? 'unknown';
    // TASK-933 — the job's owner is the CLINICIAN from the row, so a machine-initiated
    // pre-summary is still the doctor's job (and `scope: 'creator'` on the job reads still
    // resolves to a person). Never the service-account id.
    const userId = owned.doctorId;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const job = await this.consultationJobService.createPreSummaryJob(
      consultationId,
      tenantId,
      userId,
      {
        dnaStyleId: (request as any)?.dnaStyleId,
        caseNoteIds: (request as any)?.caseNoteIds,
        options: (request as any)?.options,
      },
      undefined,
      // Forward the SDK-supplied idempotency key.
      (request as any)?.idempotencyKey,
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return new AsyncJobResponseDto({
      jobId: job.jobId,
      status: 'pending',
      consultationId,
      createdAt: new Date().toISOString(),
    });
  }

  @ApiEndpoint({
    returnedModel: ComprehensiveSummaryResponseDto,
    method: HttpMethod.POST,
    path: ':id/summary/comprehensive',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async generateComprehensiveSummary(
    @Param('id') consultationId: string,
    @Body() request: ComprehensiveSummaryRequest,
  ): Promise<{
    id: string;
    content: string;
    consultationIds: string[];
    createdAt: string;
    modelName?: string;
    processingTimeMs?: number;
    dnaStyleId?: string;
  }> {
    await this.verifyConsultationOwnership(consultationId);
    const result = await this.chainSummaryService.generateComprehensiveSummary(consultationId, request);

    return {
      id: result.id,
      content: result.content,
      consultationIds: result.sourceConsultationIds,
      createdAt: result.createdAt,
      modelName: result.structuredData?.modelName,
      processingTimeMs: result.structuredData?.processingTimeMs,
      dnaStyleId: request.dnaStyleId,
    };
  }

  @ApiEndpoint({
    returnedModel: ComprehensiveSummaryResponseDto,
    method: HttpMethod.POST,
    path: ':id/summary/comprehensive/async',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async generateComprehensiveSummaryAsync(
    @Param('id') consultationId: string,
    @Body() request: ComprehensiveSummaryRequest,
  ): Promise<AsyncJobResponseDto> {
    await this.verifyConsultationOwnership(consultationId);
    const tenantId = this.cls.get('tenantId') ?? 'unknown';
    const userId = this.getDoctorId();
    const job = await this.consultationJobService.createComprehensiveSummaryJob(
      consultationId,
      tenantId,
      userId,
      {
        dnaStyleId: request.dnaStyleId,
        template: request.template,
        includeNER: request.includeNER,
        includeLabResults: request.includeLabResults,
        options: request.options,
      },
      undefined,
      // Forward the SDK-supplied idempotency key.
      request.idempotencyKey,
    );
    return new AsyncJobResponseDto({
      jobId: job.jobId,
      status: 'pending',
      consultationId,
      createdAt: new Date().toISOString(),
    });
  }

  // TASK-869 — same 201-vs-200 drift as the state-transition routes: the
  // published contract documents 200 and Nest's POST default is 201.
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    returnedModel: SummaryApprovalResponseDto,
    method: HttpMethod.POST,
    path: ':id/summary/:contextItemId/approve',
    by: ['id', 'contextItemId'],
  })
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Approve and lock a summary under optimistic concurrency',
    description:
      'Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED, and the server runs a ' +
      "Compare-And-Set against the summary row's `_version`. When the header is present, its value overrides the " +
      'body-field `expectedVersion`. On version drift the response is `412 Precondition Failed`; missing header is ' +
      '`428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async approveSummary(
    @Param('id') id: string,
    @Param('contextItemId') contextItemId: string,
    // Optional one-click safety-flag override; `expectedVersion` is
    // REQUIRED (folded from the `If-Match` header below when present).
    @Body() body: SummaryApprovalRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<SummaryApprovalResponseDto> {
    await this.verifyConsultationOwnership(id);
    // Header takes precedence over body when both are present (house
    // precedence, `department.controller.ts#update`).
    const expectedVersion = expectedFromHeader !== undefined ? expectedFromHeader : body?.expectedVersion;
    const result = await this.summaryService.approveSummary(contextItemId, {
      overrideSafetyFlag: body?.overrideSafetyFlag,
      expectedVersion,
    });
    return new SummaryApprovalResponseDto(result);
  }

  // ─── Named Entities ──────────────────────────────────────────────

  @ApiEndpoint({
    returnedModel: AggregateNerResponse,
    path: ':id/named-entities',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiQuery({ name: 'scope', required: false, enum: ['single', 'chain'] })
  async getNamedEntities(@Param('id') id: string, @Query('scope') scope?: 'single' | 'chain'): Promise<AggregateNerResponse> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getAggregateNamedEntities(id, scope ?? 'single');
  }
}
