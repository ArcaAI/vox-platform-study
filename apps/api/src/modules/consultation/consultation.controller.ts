import {
  IConsultationService,
  IContextService,
  ISummaryService,
  TimelineService,
  ComprehensiveSummaryRequest,
  OpenConsultationRequest,
  UpdateConsultationRequest,
  ConsultationResponse,
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
  HarnessProgressService,
  HarnessAssuranceService,
  // dedicated Redis subscriber for the trajectory SSE relay.
  RedisSubscriberService,
  // Consultation-loop lifecycle signal caller.
  LoopContextSignalService,
} from '@arcaai/applications';
import {
  Controller,
  Body,
  Param,
  Inject,
  Query,
  Headers,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  Logger,
  Get,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiHeader, ApiParam, ApiProperty, ApiPropertyOptional, ApiQuery, ApiResponse, ApiOperation } from '@nestjs/swagger';
import { Observable, interval, map, merge, type Subscription } from 'rxjs';
// `@RequiresIfMatch()` + `@ExpectedVersion()` gate the OCC-enforced note-content
// PATCH/POST routes on this controller (TASK-709).
import { ApiEndpoint, Authorize, RequiredScopes, RequiresIfMatch, ExpectedVersion, RequiresConsent } from '../../decorators';
import { TenantOwnedResource } from '../../common';
import { StreamScope } from '../auth';
import { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '@arcaai/applications';
import { ChainSummaryService } from '@arcaai/applications';
import { IConsultationJobService } from '@arcaai/applications';
import { INoteGenerationService, GenerationTrigger } from '@arcaai/applications';
import { ConsentPurpose, GlobalSettingRepository, ResourceType } from '@arcaai/domains';

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
// TASK-742: CLASS-level default for the ~42 consultation routes that carried
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
    // TASK-732 — the single seam every note-generation entry point routes
    // through (TASK-704). `generateSummaryAsync` calls it directly now that
    // the legacy `SummaryProcessor`/`createSummaryJob` dispatch it used to
    // rely on has been deleted.
    @Inject(INoteGenerationService)
    private readonly noteGenerationService: INoteGenerationService,
    private readonly timelineService: TimelineService,
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly policyEngine: PolicyEngine,
    private readonly globalSettingRepository: GlobalSettingRepository,
    @Inject(ITagService)
    private readonly tagService: ITagService,
    // Clinical Workflow Playground (WS1/WS2) — per-consultation realtime watcher.
    private readonly liveDocumentationService: LiveDocumentationService,
    @Inject(IHighlightService)
    private readonly highlightService: IHighlightService,
    private readonly harnessProgressService: HarnessProgressService,
    private readonly harnessAssuranceService: HarnessAssuranceService,
    // dedicated Redis subscriber for the trajectory SSE relay.
    private readonly redisSubscriber: RedisSubscriberService,
    // Best-effort consultation-loop lifecycle signals
    // (`signalConsultationEnding`/`signalLoopCancel`); gated inside that service
    // by the tenant's `agenticLoop` subscription entitlement composed with the
    // `harness.loop.emergencyStop` platform veto (TASK-705), and never lets a
    // harness failure surface here.
    private readonly loopContextSignalService: LoopContextSignalService,
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

  private getUserAbility(): AppAbility | undefined {
    return this.cls.get('userAbility') as AppAbility | undefined;
  }

  /**
   * Check if consultation sharing is enabled for the current tenant.
   * Reads the `enable-consultation-sharing` feature flag from GlobalSetting.
   *
   * Default-CLOSED. The flag must be EXPLICITLY set to the string `'true'`
   * to enable shared-patient reads.
   *   - missing row    -> false
   *   - any other value -> false
   *   - DB error       -> false (fail-closed, log for ops)
   */
  private async isSharingEnabled(): Promise<boolean> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) return false;
    try {
      const settings = await this.globalSettingRepository.findAll({
        where: {
          tenantId,
          key: 'enable-consultation-sharing',
        },
      });
      return settings[0]?.value === 'true';
    } catch (err) {
      this.logger.warn({
        message: 'isSharingEnabled lookup failed; defaulting to CLOSED',
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
   *   `enable-consultation-sharing` feature flag is on. This is a
   *   runtime DB lookup that cannot be expressed as a static CASL
   *   condition.
   */
  private async verifyConsultationAccess(consultationId: string): Promise<void> {
    const consultation = await this.consultationService.getById(consultationId);
    if (!consultation) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }

    const doctorId = this.getDoctorId();

    // Layer 1: owner check (matches CASL `consultation-own-manage` policy)
    if (consultation.doctorId === doctorId) {
      return;
    }

    // Layer 1b: CASL ability check for non-owner read (e.g., tenant-admin, dept-head)
    const ability = this.getUserAbility();
    if (ability) {
      const canRead = this.policyEngine.can(ability, 'read', 'Consultation', {
        tenantId: this.cls.get('tenantId'),
        doctorId: consultation.doctorId,
      } as Record<string, unknown>);
      if (canRead) return;
    }

    // Layer 2: dynamic shared-patient check (configurable per tenant)
    const sharingEnabled = await this.isSharingEnabled();
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
  }

  /**
   * Two-layer WRITE access check:
   *
   * Layer 1 — Ownership: only the assigned doctor can mutate.
   * Layer 1b — CASL: admin/dept-head with `manage Consultation` bypasses.
   *
   * Shared-patient doctors NEVER get write access.
   */
  private async verifyConsultationOwnership(consultationId: string): Promise<void> {
    const consultation = await this.consultationService.getById(consultationId);
    if (!consultation) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }

    const doctorId = this.getDoctorId();
    if (consultation.doctorId === doctorId) {
      return;
    }

    // Allow admin/dept-head with broad `manage` permission
    const ability = this.getUserAbility();
    if (ability) {
      const canManage = this.policyEngine.can(ability, 'manage', 'Consultation', {
        tenantId: this.cls.get('tenantId'),
        doctorId: consultation.doctorId,
      } as Record<string, unknown>);
      if (canManage) return;
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
  @Authorize(['create', 'Consultation'])
  @ApiResponse({ status: 400, description: 'Bad request' })
  async open(@Body() request: OpenConsultationRequest): Promise<ConsultationResponse> {
    return this.consultationService.getOrCreate(request, this.getDoctorId());
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  @RequiredScopes('consultation:session:read')
  async getById(@Param('id') id: string): Promise<ConsultationResponse> {
    await this.verifyConsultationAccess(id);
    const result = await this.consultationService.getByIdWithRelations(id);
    if (!result) throw new NotFoundException(`Consultation ${id} not found`);
    return result;
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
  // Consent & ABAC (TASK-712). Prior-history retrieval is one of the four
  // gated stages named in design.md §Data flow.
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
  // Consent & ABAC (TASK-712). Same purpose as getPatientHistory — a
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
  // Consent & ABAC (TASK-712). The chain is a cross-visit history view — the
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
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  async update(@Param('id') id: string, @Body() request: UpdateConsultationRequest): Promise<ConsultationResponse> {
    await this.verifyConsultationOwnership(id);
    return this.consultationService.updateConsultation(id, request);
  }

  // TASK-711 — session state machine. `prime`/`close`/`reopen` are the API
  // surface of the legality matrix (state-machine.md §2); each carries
  // `@RequiresIfMatch()` + `@ExpectedVersion()` (TASK-709/05-nestjs-api.md
  // §Optimistic Concurrency) so a stale client CAS-fails (412) rather than
  // silently clobbering a concurrent transition, and an illegal transition
  // surfaces as 409 (`ConsultationService.applyTransition` maps the domain
  // `BusinessException` — verified by the parity unit test alongside this
  // controller: `@ApiEndpoint()` composes cleanly with both decorators, the
  // same way `startRecording` already composes it with `@RequiresConsent`).

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
  // Consent & ABAC (TASK-712). `prime` is the session state machine's first
  // checkpoint — the same AI_DOCUMENTATION purpose `recording/start` already
  // gates (that decorator is left in place; a follow-up ticket removes it
  // once `prime` is the sole consent checkpoint, per the kill-switch's own
  // rollout note below).
  @RequiresConsent(ConsentPurpose.AI_DOCUMENTATION)
  async prime(@Param('id') id: string, @ExpectedVersion() expectedVersion: number | undefined): Promise<ConsultationResponse> {
    await this.verifyConsultationOwnership(id);
    return this.consultationService.primeConsultation(id, expectedVersion);
  }

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

  @ApiEndpoint({
    returnedModel: RecordingStateResponse,
    method: HttpMethod.POST,
    path: ':id/recording/start',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  // Consent & ABAC (TASK-712). Capture start is one of the four gated
  // stages named in design.md §Data flow.
  @RequiresConsent(ConsentPurpose.AI_DOCUMENTATION)
  async startRecording(@Param('id') id: string, @Body() request: StartRecordingRequest): Promise<RecordingStateResponse> {
    await this.verifyConsultationOwnership(id);
    const consultation = await this.consultationService.startRecording(id);
    this.liveDocumentationService.start({
      consultationId: id,
      tenantId: this.cls.get('tenantId') ?? '',
      userId: this.getDoctorId(),
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

  @ApiEndpoint({
    returnedModel: RecordingStateResponse,
    method: HttpMethod.POST,
    path: ':id/recording/stop',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
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
  @ApiOperation({
    summary: 'Stream the running live summary for an in-progress consultation via SSE',
    description:
      'Server-Sent Events stream relaying the Redis channel `consultation:live-summary:{id}`. Each event is a LiveSummaryEventDto JSON. Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `consultation_live_summary:<id>`. The terminal event carries `closed: true` when recording stops.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  streamLiveSummary(@Param('id') id: string): Observable<MessageEvent> {
    return this.liveDocumentationService.subscribeToLiveSummary(id);
  }

  // Relays `consultation:harness-progress:{id}` (published by the internal
  // POST /internal/harness/consultations/:id/progress route) so the review
  // panel can show the live stage checklist while the draft generates.
  @Get(':id/harness-progress/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })
  @StreamScope({ namespace: 'consultation_harness_progress', param: 'id' })
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
    const channel = `consultation:trajectory:${id}`;

    return new Observable<MessageEvent>((subscriber) => {
      let inner: Subscription | null = null;

      (async () => {
        const messages$ = await this.redisSubscriber.subscribeToChannel(channel);
        const relay$ = messages$.pipe(map((raw: string): MessageEvent => ({ data: raw }) as MessageEvent));
        const heartbeat$ = interval(ConsultationController.TRAJECTORY_HEARTBEAT_MS).pipe(
          map((): MessageEvent => ({ data: JSON.stringify({ type: 'heartbeat', ts: new Date().toISOString() }) }) as MessageEvent),
        );

        inner = merge(relay$, heartbeat$).subscribe({
          next: (event) => subscriber.next(event),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      })().catch((error) => {
        this.logger.error({
          message: 'Failed to initialise trajectory SSE subscription',
          consultationId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        subscriber.next({ data: JSON.stringify({ error: 'Failed to subscribe to trajectory', consultationId: id }) } as MessageEvent);
        subscriber.complete();
      });

      // Releasing the inner subscription drives the refcounted channel cleanup
      // (last viewer out tears the Redis subscription down).
      return () => inner?.unsubscribe();
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
  @ApiOperation({
    summary: 'Stream consultation-loop workflow events for a consultation via SSE',
    description:
      'Server-Sent Events stream relaying the Redis channel `consultation:loop:{id}`. Each event is a LoopEventDto JSON. Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `consultation_loop:<id>`.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  streamLoop(@Param('id') id: string): Observable<MessageEvent> {
    const channel = `consultation:loop:${id}`;

    return new Observable<MessageEvent>((subscriber) => {
      let inner: Subscription | null = null;

      (async () => {
        const messages$ = await this.redisSubscriber.subscribeToChannel(channel);
        const relay$ = messages$.pipe(map((raw: string): MessageEvent => ({ data: raw }) as MessageEvent));
        const heartbeat$ = interval(ConsultationController.TRAJECTORY_HEARTBEAT_MS).pipe(
          map((): MessageEvent => ({ data: JSON.stringify({ type: 'heartbeat', ts: new Date().toISOString() }) }) as MessageEvent),
        );

        inner = merge(relay$, heartbeat$).subscribe({
          next: (event) => subscriber.next(event),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      })().catch((error) => {
        this.logger.error({
          message: 'Failed to initialise loop SSE subscription',
          consultationId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        subscriber.next({ data: JSON.stringify({ error: 'Failed to subscribe to loop events', consultationId: id }) } as MessageEvent);
        subscriber.complete();
      });

      // Releasing the inner subscription drives the refcounted channel cleanup
      // (last viewer out tears the Redis subscription down).
      return () => inner?.unsubscribe();
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
      'TASK-661 — the tenant-declared context-schema version the CALLER built against (a `ConsultationContextSchemaVersion` id, ' +
      'e.g. from the discovery bundle `contextSchemaVersionId` read at session open). When `request.kindKey` is present, the ' +
      "payload validates against THIS version rather than the tenant's current pin — a client on an older schema version is " +
      'never silently upgraded (or broken) by a publish that lands mid-consultation. Ignored when `kindKey` is absent.',
  })
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
  @RequiredScopes('consultation:report:read')
  async getLatestSummary(@Param('id') id: string): Promise<SummaryResponse | null> {
    await this.verifyConsultationAccess(id);
    return this.summaryService.getLatestSummary(id);
  }

  @ApiEndpoint({
    returnedModel: SummaryResponse,
    path: ':id/summary/pre-summary/latest',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @RequiredScopes('consultation:report:read')
  async getLatestPreSummary(@Param('id') id: string): Promise<SummaryResponse | null> {
    await this.verifyConsultationAccess(id);
    return this.summaryService.getLatestPreSummary(id);
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

    // TASK-732 — this route used to enqueue onto the legacy `GenerateSummary`
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
      // Reachable only if `harnessEnabled` resolves false for this
      // consultation (stale per-consultation override, or a not-yet-
      // migrated tenant) — the legacy generator that used to run here no
      // longer exists. Per `design.md` §Error handling this is a VISIBLE
      // queued failure, never a silent no-op and never a resurrection of the
      // legacy generator.
      this.logger.error({
        message: 'generateSummaryAsync: seam resolved to the legacy generator, which no longer exists',
        consultationId,
        reason: decision.reason,
      });
      throw new ServiceUnavailableException(`Note generation is temporarily unavailable for this consultation (seam reason: ${decision.reason})`);
    }

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
  async generatePreSummaryAsync(@Param('id') consultationId: string, @Body() request: GeneratePreSummaryRequest): Promise<AsyncJobResponseDto> {
    await this.verifyConsultationOwnership(consultationId);
    const tenantId = this.cls.get('tenantId') ?? 'unknown';
    const userId = this.getDoctorId();
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
